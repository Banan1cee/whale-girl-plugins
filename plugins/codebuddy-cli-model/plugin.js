'use strict';
/**
 * CodeBuddy CLI 直连 · whale-plugin/1（4 级 Node）—— 迁移稿（待写入市场仓库）
 *
 * 旧 Api 4 的 hooks['chat.prompt'] + hooks['chat.generate'] → providers['chat.generate@1']。
 * 旧实现靠 chat.prompt 把宿主 system 存进会话 state；新协议 chat.generate 直接带 system，
 * 因此删除 chat.prompt，也不再有 state：菜单时间、失败提示改存插件数据目录（process.cwd()）。
 * 旧「返回 {} 交还宿主」在新 replace 模式没有对应语义，改为 host.call('model.complete@1')
 * 用原模型补一条（需要模型调用授权）。
 *
 * 隐私/安全约定保持不变：源码不含 Key/账号/路径；不写日志；不回显 stderr/Key；
 * CLI 以 argv 传参、shell:false、禁用工具、不持久化会话。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OUTPUT_LIMIT = 1024 * 1024;
const PORT_MIN = 20000;
const PORT_SPAN = 40000;

const DEFAULT_MODEL = 'deepseek-v4.1-flash';
const KEY_ALIASES = ['apiKey', 'apikey', 'key', 'api_key', 'token', 'codebuddyApiKey', 'CODEBUDDY_API_KEY'];
const PLACEHOLDER = /在这里粘贴|粘贴你的|你的\s*API\s*Key|你的Key|<[^>]*>|YOUR[_-]?API[_-]?KEY|placeholder|示例|xxx/i;
const MAX_TEXT = 16000;
const MAX_SYSTEM_BYTES = 12000;
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const MENTION_ALL = /[@＠][\s\u200B-\u200D\u2060\uFEFF]*(?:(?:所有人|全体成员)|all(?![\p{L}\p{N}.]))/giu;
const CHOICE_FILE = 'model-choice.json';
const STATE_FILE = 'state.json';
const MENU_TTL_MS = 10 * 60 * 1000;

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

function dataDir() { return process.cwd(); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(file, value) {
  const body = JSON.stringify(value) + '\n';
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, body, 'utf8');
    try { fs.renameSync(tmp, file); } catch (_) {
      fs.writeFileSync(file, body, 'utf8');
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* 状态写失败不阻塞回复 */ }
}

/* ------------------------------------------------------------------ */
/* 设置 / Key                                                          */
/* ------------------------------------------------------------------ */

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

function hasPlaceholderKey(settings) {
  const box = settings && typeof settings === 'object' ? settings : {};
  for (const name of KEY_ALIASES) {
    const value = str(box[name]).trim();
    if (value && PLACEHOLDER.test(value)) return true;
  }
  return false;
}

function clipBytes(text, maxBytes) {
  const s = String(text || '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo);
}

function sanitize(text) {
  let out = String(text || '').replace(UNSAFE, '').replace(MENTION_ALL, '@大家');
  out = out.trim();
  if (out.length > MAX_TEXT) out = out.slice(0, MAX_TEXT);
  return out;
}

/* ------------------------------------------------------------------ */
/* CLI 入口 / 环境                                                     */
/* ------------------------------------------------------------------ */

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
/* 模型目录 / 选择                                                     */
/* ------------------------------------------------------------------ */

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

const MODEL_ALIASES = Object.freeze({
  ds: DEFAULT_MODEL, 'ds-flash': DEFAULT_MODEL, deepseek: DEFAULT_MODEL,
  default: DEFAULT_MODEL, 默认: DEFAULT_MODEL,
  glm: 'glm-5.3-flash', 'glm-flash': 'glm-5.3-flash',
  'ds-pro': 'deepseek-v4-pro', 'deepseek-pro': 'deepseek-v4-pro',
  fast: 'fast-model', balanced: 'balanced-model', deep: 'deep-model',
});

const MENU_POPULAR = 10;
const SOURCE_LABEL = { settings: '卡片设置', saved: '菜单选择（本机保存）', default: '内置默认' };
const MENU_WORDS = new Set(['模型', '模型列表', '模型菜单', '切换模型', '选模型', '换模型', 'model', 'models']);
const MENU_ALL_WORDS = new Set(['模型全部', '全部模型', '模型列表全部', '所有模型', 'modelall', 'model-list-all']);
const CURRENT_WORDS = new Set(['当前模型', '模型状态', '现在用的模型', '现在是什么模型', 'model?', 'currentmodel']);
const RESET_WORDS = new Set(['恢复默认模型', '重置模型', '还原默认模型', '默认模型', 'resetmodel', 'modelreset']);

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

function choicePath() { return path.join(dataDir(), CHOICE_FILE); }

function readChoice() {
  const saved = readJson(choicePath(), null);
  return saved && typeof saved.model === 'string' ? normalizeModel(saved.model) : '';
}

function saveChoice(model) {
  writeJson(choicePath(), { model });
  return true;
}

function clearChoice() {
  try { fs.unlinkSync(choicePath()); return true; } catch (_) { return false; }
}

function resolveModel(settings) {
  const configured = str(settings.model).trim();
  if (configured) return { model: normalizeModel(configured), source: 'settings' };
  const saved = readChoice();
  if (saved) return { model: saved, source: 'saved' };
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
  if (info.source === 'settings') lines.push('注意：卡片设置 model 已填值且优先级最高，要改用菜单请把该设置留空。');
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

/* 菜单 TTL 以前在宿主 state；现在按会话存插件数据目录的 state.json。 */
function menuKeyOf(input) {
  const m = (input && input.message) || {};
  return String(m.chatId || '') + '|' + String(m.senderId || '');
}

function readState() {
  const parsed = readJson(path.join(dataDir(), STATE_FILE), {});
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function writeState(state) { writeJson(path.join(dataDir(), STATE_FILE), state); }

function getMenuAt(input) {
  const box = readState()[menuKeyOf(input)];
  return box && Number.isFinite(Number(box.menuAt)) ? Number(box.menuAt) : 0;
}

function setMenuAt(input, value) {
  const state = readState();
  state[menuKeyOf(input)] = { menuAt: value };
  writeState(state);
}

function getNotified(input) {
  const box = readState()[menuKeyOf(input)];
  return Boolean(box && box.notified);
}

function setNotified(input) {
  const state = readState();
  state[menuKeyOf(input)] = Object.assign({}, state[menuKeyOf(input)], { notified: true });
  writeState(state);
}

function handleModelCommand(input, settings) {
  const raw = str(input.message && input.message.text).trim();
  if (!raw) return null;
  const plain = raw.replace(/[\s，。！？!?、,.：:~～]/g, '').toLowerCase();

  if (MENU_WORDS.has(plain) || MENU_ALL_WORDS.has(plain)) {
    setMenuAt(input, Date.now());
    return { text: sanitize(menuText(resolveModel(settings), MENU_ALL_WORDS.has(plain))) };
  }
  if (CURRENT_WORDS.has(plain)) return { text: sanitize(currentText(resolveModel(settings))) };
  if (RESET_WORDS.has(plain)) {
    clearChoice();
    setMenuAt(input, 0);
    return { text: sanitize('已还原。' + currentText(resolveModel(settings))) };
  }

  const n = parseChoiceNumber(plain);
  if (n === null) return null;
  // 没先要过菜单、或菜单已过期：当成普通聊天，绝不误切换。
  if (!getMenuAt(input) || Date.now() - getMenuAt(input) > MENU_TTL_MS) return null;
  const id = MODEL_CATALOG[n - 1].id;
  saveChoice(id);
  setMenuAt(input, 0);
  return { text: sanitize('已切换到 ' + n + ' ' + id + '。选择已保存在本机，之后一直生效。\n发「当前模型」可确认。') };
}

/* ------------------------------------------------------------------ */
/* 输入构造 / 失败处理                                                 */
/* ------------------------------------------------------------------ */

function shouldSkip(text, settings) {
  const raw = str(settings.skipPatterns);
  if (!raw.trim()) return false;
  return raw.split(/[\n,，]/).map(s => s.trim()).filter(Boolean).some(p => text.includes(p));
}

/** 新协议 input.turns 是 {role,content}；旧 input.history 是 {role,text}。 */
function buildPrompt(input, settings) {
  const user = str(input.message && input.message.text).trim();
  const turns = int(settings.historyTurns, 0, 0, 12);
  const history = Array.isArray(input.turns) ? input.turns : [];
  if (!turns || !history.length) return user;
  const lines = history.slice(-turns)
    .map(m => (m && m.role === 'assistant' ? '鲸鲸' : '对方') + '：' + str(m && m.content))
    .filter(line => line.length > 3);
  return lines.length ? lines.join('\n') + '\n对方：' + user : user;
}

const FRIENDLY = {
  no_api_key: '【CodeBuddy 直连 · 还没配置】请在卡片「设置」里填 apiKey（填完整值，不是示例文字）。这一条先由原来的模型回复。',
  no_api_key_placeholder: '【CodeBuddy 直连 · 还没配置】设置里的 apiKey 还是示例文字，请换成你自己的 Key。这一条先由原来的模型回复。',
  cli_not_found: '没找到 CodeBuddy CLI 入口：请在本插件卡片的「设置」里填写 cliEntry（npm root -g 目录下的 @tencent-ai/codebuddy-code/bin/codebuddy）。这一条先由原来的模型回复。',
  auth_failed: 'CodeBuddy CLI 鉴权失败：请检查卡片「设置」里的 API Key 是否填了完整值（不是示例文字）。这一条先由原来的模型回复。',
  timeout: 'CodeBuddy CLI 这次超时了，这一条先由原来的模型回复。可在卡片「设置」里调大 timeoutMs。',
  cli_error: 'CodeBuddy CLI 这次调用失败，这一条先由原来的模型回复。',
  empty_result: 'CodeBuddy CLI 没有返回可用内容，这一条先由原来的模型回复。',
  output_limit: 'CodeBuddy CLI 输出超过 1 MiB，已中止本次调用，这一条先由原来的模型回复。',
};

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function randomCliPort() {
  // 插件不得监听端口：这里只给 CLI 一个随机高位端口提示，不 bind、不探测；
  // 端口冲突概率约 1/40000，CLI 报错时上层会换端口重试一次。
  return PORT_MIN + Math.floor(Math.random() * PORT_SPAN);
}

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

function runCli(options) {
  return new Promise(resolve => {
    const args = [
      options.entry, '-p', options.prompt,
      '--output-format', 'json', '--no-session-persistence',
      '--tools', '', '--max-turns', '1', '--port', String(randomCliPort()), '--model', options.model,
    ];
    if (options.system) args.push('--system-prompt', options.system);
    let child;
    try {
      child = spawn(process.execPath, args, {
        env: cliEnv(options.settings, options.key),
        cwd: options.cwd, windowsHide: true, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_) { return resolve({ ok: false, code: 'cli_error' }); }

    let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, overflow = false;
    let settled = false, timedOut = false, timer = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.signal && onAbort) options.signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => { try { child.kill(); } catch (_) { /* gone */ } finish({ ok: false, code: 'cancelled' }); };
    if (options.signal) {
      if (options.signal.aborted) { try { child.kill(); } catch (_) { } return resolve({ ok: false, code: 'cancelled' }); }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) { /* gone */ }
      finish({ ok: false, code: 'timeout' });
    }, options.timeoutMs);

    const append = (chunk, out) => {
      if (overflow) return;
      const piece = chunk.toString('utf8');
      const bytes = Buffer.byteLength(piece);
      if ((out ? stdoutBytes : stderrBytes) + bytes > OUTPUT_LIMIT) {
        overflow = true;
        try { child.kill(); } catch (_) { /* gone */ }
        finish({ ok: false, code: 'output_limit' });
        return;
      }
      if (out) { stdout += piece; stdoutBytes += bytes; }
      else { stderr += piece; stderrBytes += bytes; }
    };
    child.stdout.on('data', chunk => append(chunk, true));
    child.stderr.on('data', chunk => append(chunk, false));
    child.on('error', () => finish({ ok: false, code: 'cli_error' }));
    child.on('close', code => {
      if (overflow) return finish({ ok: false, code: 'output_limit' });
      if (timedOut) return finish({ ok: false, code: 'timeout' });
      const combined = stdout + '\n' + stderr;
      if (/Authentication required|Unauthorized|invalid api key|401/i.test(combined)) return finish({ ok: false, code: 'auth_failed' });
      if (code !== 0) return finish({ ok: false, code: 'cli_error' });
      const text = sanitize(extractResult(stdout));
      if (!text) return finish({ ok: false, code: 'empty_result' });
      finish({ ok: true, text });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 非接管路径：用原模型回复（替代旧「返回 {} 交还宿主」）              */
/* ------------------------------------------------------------------ */

async function hostReply(input, ctx) {
  const result = await ctx.host.call('model.complete@1', {
    system: str(input.system), turns: Array.isArray(input.turns) ? input.turns : [],
  });
  return { text: sanitize(str(result && result.text)) };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

exports.providers = {
  'chat.generate@1': async (input, ctx) => {
    const settings = (ctx && ctx.settings) || {};
    const user = str(input.message && input.message.text).trim();
    if (!user) return hostReply(input, ctx);
    if (shouldSkip(user, settings)) return hostReply(input, ctx);

    const command = handleModelCommand(input, settings);
    if (command) return command;

    const key = readKey(settings);
    if (!key) {
      if (str(settings.onError, 'notify-once').trim() === 'fallback' || getNotified(input)) return hostReply(input, ctx);
      setNotified(input);
      return { text: FRIENDLY[hasPlaceholderKey(settings) ? 'no_api_key_placeholder' : 'no_api_key'] };
    }

    const entry = resolveEntry(settings);
    if (!entry) {
      if (str(settings.onError, 'notify-once').trim() === 'fallback' || getNotified(input)) return hostReply(input, ctx);
      setNotified(input);
      return { text: FRIENDLY.cli_not_found };
    }

    const model = resolveModel(settings).model;
    const timeoutMs = int(settings.timeoutMs, 110000, 1000, 115000);
    let result = await runCli({
      entry, key, settings, model, timeoutMs,
      prompt: buildPrompt(input, settings),
      system: bool(settings.useHostSystem, true) ? clipBytes(str(input.system).replace(UNSAFE, ''), MAX_SYSTEM_BYTES) : '',
      cwd: workingDir(settings),
      signal: ctx && ctx.signal,
    });
    // 端口是随机提示、不 bind；若 CLI 因端口占用返回 cli_error，换一个端口再试一次。
    if (!result.ok && result.code === 'cli_error' && !(ctx && ctx.signal && ctx.signal.aborted)) {
      result = await runCli({
        entry, key, settings, model, timeoutMs,
        prompt: buildPrompt(input, settings),
        system: bool(settings.useHostSystem, true) ? clipBytes(str(input.system).replace(UNSAFE, ''), MAX_SYSTEM_BYTES) : '',
        cwd: workingDir(settings),
        signal: ctx && ctx.signal,
      });
    }

    if (result.ok) return { text: result.text };
    const mode = str(settings.onError, 'notify-once').trim();
    if (mode === 'fallback' || getNotified(input) || result.code === 'cancelled') return hostReply(input, ctx);
    setNotified(input);
    let text = FRIENDLY[result.code] || FRIENDLY.cli_error;
    if (bool(settings.debug, false)) text += '（错误码：' + result.code + '）';
    return { text: sanitize(text) };
  },
};
