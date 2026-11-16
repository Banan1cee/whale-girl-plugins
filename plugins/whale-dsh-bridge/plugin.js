'use strict';
/**
 * 鲸鲸 ↔ DSH 桥接（Api 4 / JavaScript 插件）
 *
 * WHY API 4: the old Wasm plugin could not open a socket, so the bridge had to be
 * reached indirectly by rewriting the system prompt and letting Whale's own model
 * react to it — two models, two bills, and no real context. A JavaScript plugin
 * runs with `system.full`, which includes the network. So this plugin simply calls
 * the local bridge and returns the answer.
 *
 * WHAT IT DOES NOT DO: it never decides whether to reply. Reacting, @-mentions,
 * blacklists and draft protection all run before `chat.generate`. This plugin only
 * answers "what should be said", and if anything goes wrong it returns {} so Whale
 * falls back to her own model instead of going silent.
 *
 * SECURITY: system.full means this code could do anything on the machine. It does
 * not. It reads one config file, POSTs to 127.0.0.1, and returns text. No file
 * writes outside its own data dir, no shell, no other host.
 */
const whale = require('whale');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  url: 'http://127.0.0.1:57321',
  token: '',
  timeoutMs: 40000,
  // 关掉就完全不接 DSH，全部交回鲸鲸自己的模型。
  enabled: true,
});

/**
 * Where the bridge writes our config.
 *
 * WHY NOT whale.paths ONLY: the worker spawns with `cwd` set to this plugin's data
 * directory, and `whale.paths` is not guaranteed to be populated. Reading
 * `whale.paths.pluginData` alone threw, the catch silently fell back to the
 * defaults (empty token), and every call quietly returned {} — the plugin looked
 * installed and did nothing. cwd is the one path the host always sets.
 */
function dataDir() {
  try {
    const fromSdk = whale.paths && whale.paths.pluginData;
    if (typeof fromSdk === 'string' && fromSdk) return fromSdk;
  } catch { /* SDK shape varies; fall through */ }
  return process.cwd();
}

function configPath() {
  return path.join(dataDir(), 'config.json');
}

/** Records why a call bailed out, so "it silently does nothing" is diagnosable. */
function noteFailure(reason) {
  try {
    fs.writeFileSync(path.join(dataDir(), 'last-error.json'),
      JSON.stringify({ at: new Date().toISOString(), reason }, null, 2), 'utf8');
  } catch { /* diagnostics must never break a turn */ }
}

/** First run writes a stub so the user has something concrete to edit. */
function loadConfig() {
  const file = configPath();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch (error) {
    noteFailure('读配置失败：' + String(error && error.message || error) + ' @ ' + file);
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
    } catch { /* data dir may not exist yet on very first call */ }
    return { ...DEFAULTS };
  }
}

/**
 * The envelope only carries identity now — it used to exist so the model could be
 * coaxed into routing. Same wire format keeps the bridge side unchanged.
 */
const OPEN = '[[WHALE-BRIDGE v1]]';
const CLOSE = '[[/WHALE-BRIDGE]]';
const ID_SAFE = /[^\w.:@-]/gu;

function clean(value, max = 200) {
  return String(value ?? '').replace(ID_SAFE, '').slice(0, max);
}

/**
 * The bridge rejects two different messages that share one id (`MESSAGE_ID_CONFLICT`,
 * 409) and the plugin then returns {} — the host quietly answers with her own model,
 * so it looks like "no plugin" rather than an error.
 *
 * Deriving the id from text LENGTH collides constantly ("在吗" vs "你好"). Use a
 * digest of the text plus the turn timestamp instead.
 */
function messageIdFor(message, ctx) {
  const text = String(message.text ?? '');
  let digest = 0;
  for (let i = 0; i < text.length; i += 1) digest = (digest * 31 + text.charCodeAt(i)) >>> 0;
  const stamp = Number(ctx && ctx.now) || Date.now();
  return clean('m' + stamp.toString(36) + '-' + digest.toString(36), 60) || 'unknown';
}

/**
 * The bridge parses the envelope body as JSON with a fixed key set, and rejects
 * anything else with `bad_envelope`. Sending `k=v;` pairs here looked harmless
 * and failed on the first real call — keep this in lockstep with
 * src/envelope.mjs encodeEnvelope.
 */
function envelope(message, ctx) {
  const meta = {
    accountId: 'whale',
    platform: clean(message.platform || 'wechat') || 'wechat',
    chatType: clean(message.chatType || 'private') || 'private',
    chatId: clean(message.chatId) || 'unknown',
    senderId: clean(message.senderId) || 'unknown',
    messageId: messageIdFor(message, ctx),
  };
  return OPEN + JSON.stringify(meta) + CLOSE;
}

/** Turn Whale's history array into plain turns for the bridge. */
function historyTurns(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .slice(-12)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.text).slice(0, 2000),
    }));
}

function readSse(content) {
  let text = '';
  for (const block of content.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const piece = json?.choices?.[0]?.delta?.content;
        if (typeof piece === 'string') text += piece;
      } catch { /* skip malformed frame */ }
    }
  }
  return text;
}

function readJson(content) {
  try {
    const json = JSON.parse(content);
    return json?.choices?.[0]?.message?.content ?? '';
  } catch { return ''; }
}

async function askBridge(cfg, ctx, personaText) {
  const message = ctx.message || {};
  // The bridge strips the envelope and hands the REST of this string to DSH as its
  // system prompt (src/envelope.mjs stripEnvelope → src/proxy.mjs systemHint). So
  // appending her persona here is exactly how "follow Whale-Girl's persona" works:
  // no read access to her files, no second source of truth.
  const head = envelope(message, ctx) + (personaText ? '\n\n' + personaText : '');
  const messages = [{ role: 'system', content: head }];
  const past = historyTurns(ctx.history);
  const current = String(message.text ?? '');
  // History without the current line: the bridge appends it as the last turn.
  for (const turn of past) messages.push(turn);
  messages.push({ role: 'user', content: current });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs));
  try {
    const response = await fetch(cfg.url.replace(/\/+$/, '') + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + cfg.token,
      },
      body: JSON.stringify({ model: 'dsh', stream: true, messages }),
      signal: controller.signal,
    });
    if (!response.ok) return { error: 'http_' + response.status };
    const body = await response.text();
    const text = (body.includes('data:') ? readSse(body) : readJson(body)).trim();
    if (!text) return { error: 'empty' };
    return { text };
  } catch (error) {
    return { error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

exports.hooks = {
  /**
   * The ONLY hook that can see Whale's assembled prompt. `chat.generate` gets no
   * `system` at all, so without this the bridge has nothing to give DSH as a
   * persona. We stash it in plugin state (persisted per conversation key by the
   * host) and hand it over on the next generate call.
   *
   * Returns state only — never `system` — so her own prompt is left untouched.
   */
  'chat.prompt': (ctx) => {
    const system = typeof ctx?.system === 'string' ? ctx.system : '';
    if (!system.trim()) return {};
    // Host caps state at 64 KB; leave room for the rest of the object.
    const trimmed = system.length > 24000 ? system.slice(system.length - 24000) : system;
    return { state: Object.assign({}, ctx.state || {}, { persona: trimmed, personaAt: ctx.now || Date.now() }) };
  },

  // Answering happens here: returning {text} replaces Whale's own generation for
  // this turn. Returning {} hands the turn back to her untouched.
  'chat.generate': async (ctx) => {
    const cfg = loadConfig();
    if (!cfg.enabled) { noteFailure('插件开关关闭'); return {}; }
    if (!cfg.token) { noteFailure('没有令牌：' + configPath()); return {}; }
    // Only the "follow Whale-Girl" mode forwards her prompt; the other modes are
    // resolved on the bridge side (custom text, or nothing at all).
    const wantsWhale = String(cfg.personaSource || '') === 'whale';
    const persona = wantsWhale && ctx?.state?.persona ? String(ctx.state.persona) : '';
    const result = await askBridge(cfg, ctx || {}, persona);
    if (!result.text) { noteFailure('桥接未返回文本：' + (result.error || 'empty')); return {}; }
    return { text: result.text };
  },
};

// Api 4 requires this to exist for tool.run; harmless for a message plugin.
exports.run = async () => ({
  ok: true,
  enabled: loadConfig().enabled,
  detail: '这是消息插件，没有可手动运行的工具。配置见插件设置页。',
});
