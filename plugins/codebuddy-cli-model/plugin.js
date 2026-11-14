'use strict';
/**
 * CodeBuddy CLI 直连 · 鲸鲸 4.1.2 / Api 4 消息插件
 *
 * 发布版隐私与安全约定：
 *  - 本文件不含任何 API Key、账号、主机名或绝对路径；全部来自插件卡片「设置」。
 *  - 不写日志、不落盘聊天内容、不主动发消息、不修改鲸鲸配置。
 *  - 默认只把「本轮用户消息」交给本机 CLI；聊天历史默认关闭（可在设置中显式开启）。
 *  - CLI 以 `-p` 无头模式运行，禁用工具（`--tools ""`）、不持久化会话。
 *  - 错误只暴露类别码，绝不回显 stderr、Key、路径或命令原文。
 *
 * 宿主契约（鲸鲸 4.1.2 源码实读）：
 *  - `chat.prompt` 的 input 含 `system`；`chat.generate` 的 input 不含 system、也不含 canned 标记。
 *    因此这里在 chat.prompt 把人设存进按会话隔离的 state，再在 chat.generate 取出来传给 CLI。
 *  - state 是「整体覆盖」写入的，所以任何返回 state 的地方都必须合并 input.state。
 *  - chat.generate 只要返回 text，宿主就把它当作本轮回复并跳过默认模型调用。
 *    宿主的规则话术（提醒确认等）同样会被接管，可用设置 skipPatterns 跳过。
 *
 * 换模型（不用手敲完整 ID）：
 *  - 微信里发「模型」→ 插件回一份带编号的菜单 → 回一个数字即可切换；
 *  - 发「当前模型」查询、发「恢复默认模型」还原；选择写入宿主官方
 *    whale.paths.pluginData 目录（全局生效、升级保留、不含任何个人信息）；
 *  - 高级：卡片设置 model 直接填编号、别名或完整 ID（优先级最高）。
 *
 * v1.2.0：清单不再声明 tool.run，卡片「设置」页因此只保留一个配置框，
 *  没有「手动运行 / 运行一次」区域（启动器按 Hooks.Contains("tool.run") 渲染）。
 *  缺 Key 时会在微信里给出可直接复制的配置模板与「最省事改法」。
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_MODEL = 'deepseek-v4.1-flash';
/** 设置框里预填的模板；插件识别其中的占位文字，绝不会拿它去调 CLI。 */
const CONFIG_TEMPLATE = '{"apiKey":"在这里粘贴你的 CodeBuddy API Key"}';
const KEY_ALIASES = ['apiKey', 'apikey', 'key', 'api_key', 'token', 'codebuddyApiKey', 'CODEBUDDY_API_KEY'];
const PLACEHOLDER = /在这里粘贴|粘贴你的|你的\s*API\s*Key|你的Key|<[^>]*>|YOUR[_-]?API[_-]?KEY|placeholder|示例|xxx/i;
const MAX_TEXT = 16000;          // 宿主对 chat.generate 返回 text 的上限
const MAX_SYSTEM_BYTES = 12000;  // Windows 命令行长度限制，人设需裁剪
const MAX_STATE_BYTES = 60000;   // 宿主 state 上限 64 KiB，留出余量
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
// 中文形式一律中和；all 保留「后不接字母/数字/点」的边界，避免误伤 @allow。
const MENTION_ALL = /[@＠][\s\u200B-\u200D\u2060\uFEFF]*(?:(?:所有人|全体成员)|all(?![\p{L}\p{N}.]))/giu;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function str(value, fallback) {
  if (value === undefined || value === null) return fallback === undefined ? '' : fallback;
  return String(value);
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', '开'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', '关'].includes(s)) return false;
  return fallback;
}

function int(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 取 API Key。兼容几种常见的手填别名，也允许把 Key 放在自定义键名下；
 * 占位/示例文字一律视为「没配置」，绝不传给 CLI（避免把模板当成真 Key 去鉴权）。
 * 只返回 Key 本身，不回显、不记日志。
 */
function readKey(settings) {
  const box = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  for (const name of KEY_ALIASES) {
    const value = str(box[name]).trim();
    if (value && !PLACEHOLDER.test(value)) return value;
  }
  for (const value of Object.values(box)) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (/^ck_[A-Za-z0-9._-]{20,}$/i.test(text) && !PLACEHOLDER.test(text)) return text;
  }
  return '';
}

/** 设置框里是否还留着示例文字（用于给出更精确的提示）。 */
function hasPlaceholderKey(settings) {
  const box = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  for (const name of KEY_ALIASES) {
    const value = str(box[name]).trim();
    if (value && PLACEHOLDER.test(value)) return true;
  }
  return false;
}

/** 按 UTF-8 字节裁剪，避免中文被截成半个字符、也避免触发宿主 state_limit。 */
function clipBytes(text, maxBytes) {
  const s = String(text || '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/** 宿主会拒绝含控制字符 / @所有人 / 超长的 text，这里先自行规范化。 */
function sanitize(text) {
  let out = String(text || '').replace(UNSAFE, '').replace(MENTION_ALL, '@大家');
  out = out.trim();
  if (out.length > MAX_TEXT) out = out.slice(0, MAX_TEXT);
  return out;
}

/** 与已验证的桥接 extractResult 同款：只取 type=result 的 result 字段。 */
function extractResult(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        const item = parsed[i];
        if (item && item.type === 'result' && typeof item.result === 'string') return item.result.trim();
      }
      return '';
    }
    if (parsed && typeof parsed.result === 'string') return parsed.result.trim();
    return '';
  } catch (_) { /* 继续按 NDJSON / 纯文本处理 */ }
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && parsed.type === 'result' && typeof parsed.result === 'string') return parsed.result.trim();
    } catch (_) { /* not json */ }
  }
  return /^[\[{]/.test(text) ? '' : text;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------------ */
/* 设置 / CLI 入口 / 环境                                              */
/* ------------------------------------------------------------------ */

/**
 * 优先用卡片里填的路径；否则按常见全局安装位置探测。
 * 刻意不调用 npm / cmd（Windows 上 .cmd 无法被 execFile 直接 spawn，且部分
 * 安全策略会拦截 shell 子进程）。全部路径在运行时由 os.homedir() 推导，
 * 源码里不含任何账号名或绝对盘符。
 */
function resolveEntry(settings) {
  const configured = str(settings.cliEntry).trim().replace(/^["']|["']$/g, '');
  if (configured) return configured;
  const rel = path.join('@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
  const home = os.homedir();
  const candidates = [];
  if (home) {
    candidates.push(path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', rel));
    candidates.push(path.join(home, '.npm-global', 'lib', 'node_modules', rel));
    candidates.push(path.join(home, '.local', 'lib', 'node_modules', rel));
    candidates.push(path.join(home, '.node_modules', rel));
  }
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', rel));
  candidates.push(path.join('/usr/local/lib/node_modules', rel));
  candidates.push(path.join('/usr/lib/node_modules', rel));
  const prefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  if (prefix) {
    candidates.push(path.join(prefix, 'lib', 'node_modules', rel));
    candidates.push(path.join(prefix, 'node_modules', rel));
  }
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) { /* ignore */ }
  }
  return '';
}

/**
 * worker 的 env 被宿主裁剪过（只有 SystemRoot/PATH/TEMP/TMP/LANG），
 * 所以 Key 必须在这里从卡片设置显式注入；同时清掉可能继承来的其它 Key 与代理变量。
 */
function cliEnv(settings, key) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(CODEBUDDY_|WORKBUDDY_)/i.test(name)) continue;
    if (/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(name)) continue;
    env[name] = value;
  }
  env.CODEBUDDY_API_KEY = key;
  const internet = str(settings.internetEnvironment).trim();
  if (internet) env.CODEBUDDY_INTERNET_ENVIRONMENT = internet;
  env.CODEBUDDY_SKIP_GIT_BASH_CHECK = '1';
  env.CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS = '1';
  const home = os.homedir();
  if (home) {
    if (process.platform === 'win32' && !env.USERPROFILE) env.USERPROFILE = home;
    if (!env.HOME) env.HOME = home;
  }
  return env;
}

function workingDir(settings) {
  const configured = str(settings.cwd).trim().replace(/^["']|["']$/g, '');
  return configured || os.homedir() || os.tmpdir();
}

/* ------------------------------------------------------------------ */
/* 模型目录与「选择式」切换                                            */
/* ------------------------------------------------------------------ */

/**
 * 目录来自本机 `codebuddy --help` 里 --model 的实读结果（CLI 2.184.0，22 个）。
 * 数组顺序 = 菜单编号，发布后保持稳定；前 10 个是常用推荐。
 * 目录外的 ID 会原样透传给 CLI，方便以后 CLI 新增模型时无需升级插件。
 */
const MODEL_CATALOG = [
  { id: 'deepseek-v4.1-flash', label: '快速 · 默认' },
  { id: 'glm-5.3-flash', label: '快速 · 上一版默认' },
  { id: 'glm-5.3-flashx', label: '快速 · 增强' },
  { id: 'minimax-m3.1-flash', label: '快速' },
  { id: 'kimi-k3.1-pro-highspeed', label: '快速 · 长文' },
  { id: 'glm-5.3', label: '均衡' },
  { id: 'glm-5.2', label: '均衡' },
  { id: 'hy4free', label: '均衡 · 免费档' },
  { id: 'deepseek-v4-pro', label: '更强' },
  { id: 'kimi-k3.1-pro', label: '更强' },
  { id: 'kimi-k3-2', label: '更强' },
  { id: 'mimo-v2.6-pro', label: '更强' },
  { id: 'step-5-preview', label: '更强 · 预览' },
  { id: 'minimax-m3-pay', label: '更强 · 付费' },
  { id: 'hy4std', label: '标准' },
  { id: 'hy3', label: '标准' },
  { id: 'hy3-x', label: '标准 · 增强' },
  { id: 'space-bunny', label: '轻量' },
  { id: 'kimi-k2.8-preview', label: '预览' },
  { id: 'fast-model', label: 'CLI 自动档 · 快（可能漂移）' },
  { id: 'balanced-model', label: 'CLI 自动档 · 均衡（可能漂移）' },
  { id: 'deep-model', label: 'CLI 自动档 · 深度（可能漂移）' },
];

/** 手敲时可用更短的别名；编号也走同一套解析。 */
const MODEL_ALIASES = Object.freeze({
  ds: DEFAULT_MODEL, 'ds-flash': DEFAULT_MODEL, deepseek: DEFAULT_MODEL,
  default: DEFAULT_MODEL, 默认: DEFAULT_MODEL,
  glm: 'glm-5.3-flash', 'glm-flash': 'glm-5.3-flash',
  'ds-pro': 'deepseek-v4-pro', 'deepseek-pro': 'deepseek-v4-pro',
  fast: 'fast-model', balanced: 'balanced-model', deep: 'deep-model',
});

const MENU_POPULAR = 10;
const MENU_TTL_MS = 10 * 60 * 1000;   // 回数字只在出菜单后 10 分钟内有效，避免误伤
const CHOICE_FILE = 'model-choice.json';
const SOURCE_LABEL = {
  settings: '卡片设置', saved: '菜单选择（本机保存）',
  session: '本次会话选择', default: '内置默认',
};
const MENU_WORDS = new Set(['模型', '模型列表', '模型菜单', '切换模型', '选模型', '换模型', 'model', 'models']);
const MENU_ALL_WORDS = new Set(['模型全部', '全部模型', '模型列表全部', '所有模型', 'modelall', 'model-list-all']);
const CURRENT_WORDS = new Set(['当前模型', '模型状态', '现在用的模型', '现在是什么模型', 'model?', 'currentmodel']);
const RESET_WORDS = new Set(['恢复默认模型', '重置模型', '还原默认模型', '默认模型', 'resetmodel', 'modelreset']);

function mergeState(input, patch) {
  return Object.assign({}, input.state || {}, patch);
}

/** 编号 / 别名 / 大小写都容错；未知 ID 原样透传（CLI 未来新增模型不受限）。 */
function normalizeModel(value) {
  const raw = str(value).trim().replace(/^["']|["']$/g, '');
  if (!raw) return DEFAULT_MODEL;
  if (/^\d{1,2}$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= MODEL_CATALOG.length) return MODEL_CATALOG[n - 1].id;
  }
  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, lower)) return MODEL_ALIASES[lower];
  const hit = MODEL_CATALOG.find(item => item.id.toLowerCase() === lower);
  return hit ? hit.id : raw;
}

/** worker 会把 whale SDK 直接注入 hook 入参；离线测试可传入同形状的 mock。 */
function pluginDataDir(input) {
  const sdk = input.whale || input.host;
  const dir = sdk && sdk.paths ? sdk.paths.pluginData : '';
  return typeof dir === 'string' && dir ? dir : '';
}

function choicePath(input) {
  const dir = pluginDataDir(input);
  return dir ? path.join(dir, CHOICE_FILE) : '';
}

function readChoice(input) {
  const file = choicePath(input);
  if (!file) return '';
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved && typeof saved.model === 'string' ? normalizeModel(saved.model) : '';
  } catch (_) { return ''; }
}

/** 只写模型 ID，不写任何 Key、聊天内容或个人信息。 */
function saveChoice(input, model) {
  const file = choicePath(input);
  if (!file) return false;
  const body = JSON.stringify({ model }) + '\n';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, body, 'utf8');
    try { fs.renameSync(tmp, file); }
    catch (_) {
      fs.writeFileSync(file, body, 'utf8');
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
    return true;
  } catch (_) { return false; }
}

function clearChoice(input) {
  const file = choicePath(input);
  if (!file) return false;
  try { fs.unlinkSync(file); return true; } catch (_) { return false; }
}

/** 优先级：卡片设置 model > 本机已保存的选择 > 会话内选择 > 内置默认。 */
function resolveModel(input) {
  const configured = str((input.settings || {}).model).trim();
  if (configured) return { model: normalizeModel(configured), source: 'settings' };
  const saved = readChoice(input);
  if (saved) return { model: saved, source: 'saved' };
  const inState = str(input.state && input.state.modelChoice).trim();
  if (inState) return { model: normalizeModel(inState), source: 'session' };
  return { model: DEFAULT_MODEL, source: 'default' };
}

function menuText(info, all) {
  const count = all ? MODEL_CATALOG.length : MENU_POPULAR;
  const lines = ['【选模型】回复编号即可切换。当前：' + info.model];
  for (let i = 0; i < count; i++) {
    const item = MODEL_CATALOG[i];
    lines.push((item.id === info.model ? '★' : '·') + (i + 1) + ' ' + item.id + '  ' + item.label);
  }
  if (!all) lines.push('还有 ' + (MODEL_CATALOG.length - count) + ' 个：发「模型 全部」看完整清单。');
  lines.push('发「当前模型」查询；发「恢复默认模型」还原成 ' + DEFAULT_MODEL + '。');
  if (info.source === 'settings')
    lines.push('注意：卡片设置 model 已填值且优先级最高，要改用菜单请把该设置留空。');
  return lines.join('\n');
}

function currentText(info) {
  return '当前模型：' + info.model + '（来源：' + (SOURCE_LABEL[info.source] || info.source) + '）\n'
    + '默认值：' + DEFAULT_MODEL + '。发「模型」看编号菜单，回一个数字即可切换。';
}

function parseChoiceNumber(plain) {
  const m = /^(?:选|选择|第|#)?(\d{1,2})(?:个|号|项)?$/.exec(plain);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= MODEL_CATALOG.length ? n : null;
}

/** 返回要直接交给宿主的 {text,state}，或 null 表示这不是模型命令。 */
function handleModelCommand(input) {
  const raw = str(input.message && input.message.text).trim();
  if (!raw) return null;
  const plain = raw.replace(/[\s，。！？!?、,.：:~～]/g, '').toLowerCase();

  if (MENU_WORDS.has(plain) || MENU_ALL_WORDS.has(plain)) {
    return {
      text: sanitize(menuText(resolveModel(input), MENU_ALL_WORDS.has(plain))),
      state: mergeState(input, { menuAt: Date.now() }),
    };
  }
  if (CURRENT_WORDS.has(plain)) return { text: sanitize(currentText(resolveModel(input))) };
  if (RESET_WORDS.has(plain)) {
    clearChoice(input);
    const state = mergeState(input, { modelChoice: '', menuAt: 0 });
    const info = resolveModel(Object.assign({}, input, { state }));
    return { text: sanitize('已还原。' + currentText(info)), state };
  }

  const n = parseChoiceNumber(plain);
  if (n === null) return null;
  const previous = input.state || {};
  // 没有先要过菜单、或菜单已过期：把这条当成普通聊天，绝不误切换。
  if (!previous.menuAt || Date.now() - previous.menuAt > MENU_TTL_MS) return null;
  const id = MODEL_CATALOG[n - 1].id;
  const saved = saveChoice(input, id);
  const state = mergeState(input, { modelChoice: id, menuAt: 0 });
  return {
    text: sanitize('已切换到 ' + (n) + ' ' + id + '。' + (saved ? '选择已保存在本机，之后一直生效。' : '本次会话生效。')
      + '\n发「当前模型」可确认。'),
    state,
  };
}

/* ------------------------------------------------------------------ */
/* 输入构造与失败处理                                                  */
/* ------------------------------------------------------------------ */

function shouldSkip(text, settings) {
  const raw = str(settings.skipPatterns);
  if (!raw.trim()) return false;
  return raw.split(/[\n,，]/).map(s => s.trim()).filter(Boolean).some(p => text.includes(p));
}

function buildPrompt(input, settings) {
  const user = str(input.message && input.message.text).trim();
  const turns = int(settings.historyTurns, 0, 0, 12);
  if (!turns || !Array.isArray(input.history)) return user;
  const lines = input.history.slice(-turns)
    .map(m => (m && m.role === 'assistant' ? '鲸鲸' : '对方') + '：' + str(m && m.text))
    .filter(line => line.length > 3);
  return lines.length ? lines.join('\n') + '\n对方：' + user : user;
}

const FRIENDLY = {
  no_api_key: [
    '【CodeBuddy 直连 · 还没配置】卡片「设置」最上面那个大框请填这一行（把中间换成你自己的 Key）：',
    CONFIG_TEMPLATE,
    '最省事：如果框里已经是 {ck_…}，只要在 { 后面加 "apiKey":"、在 } 前面加 "，再点「保存设置」。',
    '只粘一串裸 Key 不生效：宿主要求配置是 JSON 对象。这一条先由原来的模型回复。',
  ].join('\n'),
  no_api_key_placeholder: [
    '【CodeBuddy 直连 · 还没配置】设置框里还是示例文字，请把「在这里粘贴…」换成你自己的 Key：',
    CONFIG_TEMPLATE,
    '改完点「保存设置」。这一条先由原来的模型回复。',
  ].join('\n'),
  cli_not_found: '没找到 CodeBuddy CLI 入口：请在本插件卡片的「设置」里填写 cliEntry（npm root -g 目录下的 @tencent-ai/codebuddy-code/bin/codebuddy）。这一条先由原来的模型回复。',
  auth_failed: 'CodeBuddy CLI 鉴权失败：请检查卡片「设置」里的 API Key 是否填了完整值（不是示例文字）。这一条先由原来的模型回复。',
  timeout: 'CodeBuddy CLI 这次超时了，这一条先由原来的模型回复。可在卡片「设置」里调大 timeoutMs。',
  cli_error: 'CodeBuddy CLI 这次调用失败，这一条先由原来的模型回复。',
  empty_result: 'CodeBuddy CLI 没有返回可用内容，这一条先由原来的模型回复。',
};

/**
 * 失败时默认「每个会话提示一次，之后静默回退」，避免刷屏，也避免把
 * stderr / Key / 路径回显到微信。onError=fallback 可彻底静默。
 */
function fail(input, code) {
  const settings = input.settings || {};
  const mode = str(settings.onError, 'notify-once').trim();
  const state = Object.assign({}, input.state || {});
  if (mode === 'fallback' || state.notified) return {};
  state.notified = true;
  let text = FRIENDLY[code] || FRIENDLY.cli_error;
  if (code === 'no_api_key' && hasPlaceholderKey(settings)) text = FRIENDLY.no_api_key_placeholder;
  if (bool(settings.debug, false)) text += '（错误码：' + code + '）';
  return { text: sanitize(text), state };
}

/* ------------------------------------------------------------------ */
/* CLI 调用                                                            */
/* ------------------------------------------------------------------ */

function runCli(options) {
  return freePort().then(port => new Promise(resolve => {
    const args = [
      options.entry, '-p', options.prompt,
      '--output-format', 'json',
      '--no-session-persistence',
      '--tools', '',
      '--max-turns', '1',
      '--port', String(port),
      '--model', options.model,
    ];
    if (options.system) args.push('--system-prompt', options.system);

    let child;
    try {
      child = spawn(process.execPath, args, {
        env: cliEnv(options.settings, options.key),
        cwd: options.cwd,
        windowsHide: true,
        shell: false,               // 用户输入走 argv，绝不经过 shell
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_) {
      return resolve({ ok: false, code: 'cli_error' });
    }

    let stdout = '', stderr = '', settled = false, timedOut = false;
    let timer = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) { /* already gone */ }
      finish({ ok: false, code: 'timeout' });
    }, options.timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', () => finish({ ok: false, code: 'cli_error' }));
    child.on('close', code => {
      if (timedOut) return finish({ ok: false, code: 'timeout' });
      const combined = stdout + '\n' + stderr;
      if (/Authentication required|Unauthorized|invalid api key|401/i.test(combined))
        return finish({ ok: false, code: 'auth_failed' });
      if (code !== 0) return finish({ ok: false, code: 'cli_error' });
      const text = sanitize(extractResult(stdout));
      if (!text) return finish({ ok: false, code: 'empty_result' });
      finish({ ok: true, text });
    });
  })).catch(() => ({ ok: false, code: 'cli_error' }));
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

exports.hooks = {
  /** chat.generate 拿不到 system，借 chat.prompt 把它存进同一会话的 state。 */
  'chat.prompt': (input) => {
    const settings = input.settings || {};
    if (!bool(settings.useHostSystem, true)) return {};
    const system = str(input.system);
    if (!system) return {};
    const state = Object.assign({}, input.state || {});
    state.system = clipBytes(system.replace(UNSAFE, ''), MAX_STATE_BYTES);
    return { state };
  },

  'chat.generate': async (input) => {
    const settings = input.settings || {};
    const user = str(input.message && input.message.text).trim();
    if (!user) return {};                       // 空消息交回宿主
    if (shouldSkip(user, settings)) return {};  // 用户自定义的保护词

    // 模型菜单 / 选择 / 查询 / 还原：不需要 Key、也不调用 CLI。
    const command = handleModelCommand(input);
    if (command) return command;

    const key = readKey(settings);
    if (!key) return fail(input, 'no_api_key');

    const entry = resolveEntry(settings);
    if (!entry) return fail(input, 'cli_not_found');

    const model = resolveModel(input).model;
    const timeoutMs = int(settings.timeoutMs, 110000, 1000, 115000);
    const result = await runCli({
      entry, key, settings, model, timeoutMs,
      prompt: buildPrompt(input, settings),
      system: bool(settings.useHostSystem, true)
        ? clipBytes(str(input.state && input.state.system).replace(UNSAFE, ''), MAX_SYSTEM_BYTES)
        : '',
      cwd: workingDir(settings),
    });

    // 成功时不返回 state，保留 chat.prompt 存下的人设给下一轮用。
    if (!result.ok) return fail(input, result.code);
    return { text: result.text };
  },
};

/**
 * v1.2.0 起清单不再声明 tool.run：卡片「设置」页因此不会有「手动运行 / 运行一次」
 * 输入框与结果框（启动器 PluginMarketPage.xaml.cs 按 Hooks.Contains("tool.run") 渲染）。
 * 换模型统一在微信里完成：发「模型」出编号菜单，回数字即可。
 */

/** 供离线测试 / 二次开发读取目录与解析规则，不影响宿主调度。 */
exports.modelCatalog = MODEL_CATALOG;
exports.normalizeModel = normalizeModel;
exports.defaultModel = DEFAULT_MODEL;
exports.configTemplate = CONFIG_TEMPLATE;
exports.readKey = readKey;
