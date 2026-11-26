'use strict';
/**
 * 鲸鲸 ↔ DSH 桥接 · whale-plugin/1（4 级 Node）—— 迁移稿（待写入市场仓库）
 *
 * 旧 Api 4 的 hooks['chat.prompt'] + hooks['chat.generate'] → providers['chat.generate@1']。
 * 旧 chat.prompt 只用来把宿主 system 缓存进 state；新 chat.generate 直接带 system，
 * 所以删除 chat.prompt 与 state。配置优先读卡片 settings；为了不丢老用户的
 * config.json，首次读不到 settings 值时只读兼容旧文件（不写回、双源优先级见 README）。
 *
 * 失败一律用 host.call('model.complete@1') 交回原模型（旧实现返回 {} 让宿主回退，
 * 新 replace 模式没有该语义）。网络只访问用户配置的 DSH 地址（默认 127.0.0.1）。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  url: 'http://127.0.0.1:57321',
  token: '',
  timeoutMs: 40000,
  enabled: true,
  personaSource: 'whale',
});

const OPEN = '[[WHALE-BRIDGE v1]]';
const CLOSE = '[[/WHALE-BRIDGE]]';
const ID_SAFE = /[^\w.:@-]/gu;

function dataDir() { return process.cwd(); }

function noteFailure(reason) {
  try {
    fs.writeFileSync(path.join(dataDir(), 'last-error.json'),
      JSON.stringify({ at: new Date().toISOString(), reason }, null, 2), 'utf8');
  } catch { /* 诊断不阻塞回复 */ }
}

/** 旧配置在插件数据目录的 config.json；只读兼容，不写回，不再作为主配置。 */
function legacyConfig() {
  const file = path.join(dataDir(), 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function booleanSetting(value, fallback) {
  // 旧 config.json 里可能是字符串 "false"；Boolean("false") 会误判为开，必须显式解析。
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  return fallback;
}

function resolveConfig(settings) {
  const box = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const legacy = legacyConfig();
  const pick = (name) => {
    if (box[name] !== undefined && box[name] !== null && box[name] !== '') return box[name];
    return legacy[name];
  };
  const enabledRaw = pick('enabled');
  return {
    url: String(pick('url') || DEFAULTS.url),
    token: String(pick('token') || ''),
    timeoutMs: Number.isFinite(Number(pick('timeoutMs'))) ? Number(pick('timeoutMs')) : DEFAULTS.timeoutMs,
    enabled: booleanSetting(enabledRaw, DEFAULTS.enabled),
    personaSource: String(pick('personaSource') || DEFAULTS.personaSource),
  };
}

function clean(value, max = 200) {
  return String(value ?? '').replace(ID_SAFE, '').slice(0, max);
}

function messageIdFor(message) {
  const text = String(message.text ?? '');
  let digest = 0;
  for (let i = 0; i < text.length; i += 1) digest = (digest * 31 + text.charCodeAt(i)) >>> 0;
  const stamp = Date.now();
  return clean('m' + stamp.toString(36) + '-' + digest.toString(36), 60) || 'unknown';
}

function envelope(message) {
  const meta = {
    accountId: 'whale',
    platform: clean(message.platform || 'wechat') || 'wechat',
    chatType: clean(message.chatType || 'private') || 'private',
    chatId: clean(message.chatId) || 'unknown',
    senderId: clean(message.senderId) || 'unknown',
    messageId: messageIdFor(message),
  };
  return OPEN + JSON.stringify(meta) + CLOSE;
}

/** 新协议 input.turns 是 {role,content}（旧输入是 ctx.history {role,text}）。 */
function historyTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) }));
}

function readSse(content) {
  let text = '';
  for (const block of content.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const piece = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof piece === 'string') text += piece;
      } catch { /* skip malformed frame */ }
    }
  }
  return text;
}

function readJson(content) {
  try { return JSON.parse(content)?.choices?.[0]?.message?.content ?? ''; } catch { return ''; }
}

async function askBridge(cfg, input, personaText, signal) {
  const message = input.message || {};
  // 桥接会把 envelope 之后的内容当 DSH 的 system prompt（见 DSH 侧 envelope/proxy），
  // 所以人设直接拼在这里就等于「沿用鲸鲸人设」，不读鲸鲸任何文件。
  const head = envelope(message) + (personaText ? '\n\n' + personaText : '');
  const messages = [{ role: 'system', content: head }];
  for (const turn of historyTurns(input.turns)) messages.push(turn);
  messages.push({ role: 'user', content: String(message.text ?? '') });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs));
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); return { error: 'cancelled' }; }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(cfg.url.replace(/\/+$/, '') + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.token },
      body: JSON.stringify({ model: 'dsh', stream: true, messages }),
      signal: controller.signal,
    });
    if (!response.ok) return { error: 'http_' + response.status };
    const body = await response.text();
    const text = (body.includes('data:') ? readSse(body) : readJson(body)).trim();
    if (!text) return { error: 'empty' };
    return { text };
  } catch (error) {
    return { error: error?.name === 'AbortError' ? (signal && signal.aborted ? 'cancelled' : 'timeout') : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 旧实现返回 {} 让宿主回退；新 replace 模式改为显式用原模型补一条。 */
async function hostReply(input, ctx) {
  const result = await ctx.host.call('model.complete@1', {
    system: String(input.system || ''), turns: Array.isArray(input.turns) ? input.turns : [],
  });
  return { text: String(result && result.text ? result.text : '').trim() };
}

exports.providers = {
  'chat.generate@1': async (input, ctx) => {
    const cfg = resolveConfig(ctx && ctx.settings);
    if (!cfg.enabled) { noteFailure('插件开关关闭'); return hostReply(input, ctx); }
    if (!cfg.token) { noteFailure('没有令牌（cards settings.token）'); return hostReply(input, ctx); }
    // whale 模式把宿主 system 当人设发给 DSH；custom 模式由 DSH 侧决定（不在这里拼）。
    const persona = String(cfg.personaSource) === 'whale' ? String(input.system || '') : '';
    const result = await askBridge(cfg, input, persona, ctx && ctx.signal);
    if (result.error === 'cancelled') return { text: '' };
    if (!result.text) { noteFailure('桥接未返回文本：' + (result.error || 'empty')); return hostReply(input, ctx); }
    return { text: result.text };
  },
};
