"use strict";

// care-plus 4 级迁移版。
// 新协议没有：官方 care 设置读取、自动关闭官方 care、/api/debug/prompt、/api/care/sent 记账、
// 宿主私有文件布局。以下只用清单声明的真实 calls；拿不到的降级并在 README 说明。
//
// 状态为什么要落文件：4 级 Node worker 每次 invocation 都是新进程，模块级 state 会清零；
// 宿主的 `state` 通道只对 chat.pre_reply/chat.prompt/chat.before_send/chat.reply 开放，
// task.tick 拿不到。worker 的 cwd 是宿主给的插件私有目录（data/plugins/<id>/data），
// 所以把「日计数 / 会话锚点 / 首次运行时间」原子写在这里，配合调用锁避免并发 tick 双发。
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  minIntervalMinutes: 25, maxIntervalMinutes: 300, maxPerDay: 5,
  bootSilentMinutes: 30, maxChars: 60, dryRun: false,
};

const STATE_NAME = "care-plus-state.json";
const LOCK_NAME = "care-plus.lock";
// 锁只防同一插件的并发 tick；worker 被杀会留下锁文件，超过这个时间就当陈旧锁接管。
const LOCK_TTL_MS = 15 * 60 * 1000;
// 两次 tick 间隔超过它，视为「宿主重启过」，重新计启动静默；避免持久化后静默永不生效。
const RESTART_GAP_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_SESSIONS = 32;
const MAX_STATE_BYTES = 32 * 1024;
const MAX_LINES = 8;

function fail(code, message) { return { ok: false, code: code, message: message }; }
function intIn(value, fallback, min, max) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function settingsOf(raw) {
  const s = raw || {};
  return {
    targets: String(s.targets || "").split(/[\n,，;；\s]+/).map((x) => x.trim()).filter(Boolean)
      .filter((id) => id.length > 0 && id.length <= 120),
    windows: String(s.windows || "").split(/[\s,，;；]+/).filter(Boolean),
    minIntervalMinutes: intIn(s.minIntervalMinutes, DEFAULTS.minIntervalMinutes, 1, 43200),
    maxIntervalMinutes: intIn(s.maxIntervalMinutes, DEFAULTS.maxIntervalMinutes, 1, 43200),
    maxPerDay: intIn(s.maxPerDay, DEFAULTS.maxPerDay, 0, 50),
    bootSilentMinutes: intIn(s.bootSilentMinutes, DEFAULTS.bootSilentMinutes, 0, 1440),
    maxChars: intIn(s.maxChars, DEFAULTS.maxChars, 12, 200),
    dryRun: s.dryRun === true,
  };
}
function minutesOf(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  return h <= 23 && mm <= 59 ? h * 60 + mm : null;
}
function parseWindows(list) {
  const out = [];
  for (const piece of list || []) {
    const m = /^(\d{1,2}:\d{2})\s*[-~到]\s*(\d{1,2}:\d{2})$/.exec(String(piece));
    if (!m) continue;
    const a = minutesOf(m[1]), b = minutesOf(m[2]);
    if (a != null && b != null) out.push([a, b]);
  }
  return out;
}
function inWindows(nowMinutes, windows) {
  if (!windows.length) return true;
  return windows.some(([a, b]) => (a <= b ? nowMinutes >= a && nowMinutes <= b : nowMinutes >= a || nowMinutes <= b));
}
function today(now) {
  const d = new Date(now);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function bigrams(text) {
  const clean = String(text || "").replace(/[\s\p{P}]/gu, "");
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2));
  return set;
}
function similarity(a, b) {
  const left = bigrams(a), right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let hit = 0;
  for (const gram of left) if (right.has(gram)) hit += 1;
  return (2 * hit) / (left.size + right.size);
}
function messageTime(m) {
  const value = Number(m && (m.ts ?? m.time ?? m.createdAt ?? m.at));
  return Number.isFinite(value) ? value : 0;
}
function messageText(m) { return String((m && (m.text ?? m.content)) || ""); }
function messageRole(m) { return String((m && (m.role || m.by)) || "").toLowerCase(); }

// —— 私有状态文件：原子写、上限、TTL ——

function stateDir() { return process.cwd(); }
function statePath() { return path.join(stateDir(), STATE_NAME); }
function lockPath() { return path.join(stateDir(), LOCK_NAME); }

function normalizeState(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const state = {
    firstSeenAt: Number.isFinite(Number(value.firstSeenAt)) ? Number(value.firstSeenAt) : 0,
    lastTickAt: Number.isFinite(Number(value.lastTickAt)) ? Number(value.lastTickAt) : 0,
    day: typeof value.day === "string" ? value.day : "",
    sentToday: Number.isFinite(Number(value.sentToday)) ? Math.max(0, Math.trunc(Number(value.sentToday))) : 0,
    sessions: {},
  };
  const sessions = value.sessions && typeof value.sessions === "object" && !Array.isArray(value.sessions)
    ? value.sessions : {};
  for (const [chatId, item] of Object.entries(sessions)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = String(chatId).slice(0, 120);
    if (!id) continue;
    state.sessions[id] = {
      nextAt: Number.isFinite(Number(item.nextAt)) ? Number(item.nextAt) : 0,
      lastUsedAt: Number.isFinite(Number(item.lastUsedAt)) ? Number(item.lastUsedAt) : 0,
      lastLines: Array.isArray(item.lastLines)
        ? item.lastLines.filter((line) => typeof line === "string").slice(-MAX_LINES) : [],
    };
  }
  return state;
}

function readState() {
  try {
    const raw = fs.readFileSync(statePath(), "utf8").replace(/^\uFEFF/, "");
    return normalizeState(JSON.parse(raw));
  } catch { return normalizeState({}); }
}

function writeState(state) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const temp = statePath() + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(state));
    try { fs.renameSync(temp, statePath()); } catch {
      // Windows 上目标被杀软/索引占用时 rename 会失败；先删再改名，失败也不让本轮消息失败。
      fs.rmSync(statePath(), { force: true });
      fs.renameSync(temp, statePath());
    }
  } catch { /* 状态写失败只影响节流精度，不影响本轮已排队的消息 */ }
}

function pruneState(state, now) {
  const sessions = state.sessions;
  for (const [id, item] of Object.entries(sessions)) {
    if (!item || now - Number(item.lastUsedAt || 0) > SESSION_TTL_MS) delete sessions[id];
  }
  let ids = Object.keys(sessions);
  if (ids.length > MAX_SESSIONS) {
    ids.sort((a, b) => (sessions[a].lastUsedAt || 0) - (sessions[b].lastUsedAt || 0));
    while (ids.length > MAX_SESSIONS) delete sessions[ids.shift()];
  }
  // 字节上限：按 lastUsedAt 从旧到新丢，直到状态能装下；防止长句/多会话把文件撑大。
  let guard = 0;
  while (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES && guard < MAX_SESSIONS) {
    ids = Object.keys(sessions).sort((a, b) => (sessions[a].lastUsedAt || 0) - (sessions[b].lastUsedAt || 0));
    if (!ids.length) break;
    delete sessions[ids[0]];
    guard += 1;
  }
}

function persistState(state, now) {
  pruneState(state, now);
  writeState(state);
}

function acquireLock() {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const fd = fs.openSync(lockPath(), "wx");
    try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") {
      try {
        if (Date.now() - fs.statSync(lockPath()).mtimeMs > LOCK_TTL_MS) {
          fs.rmSync(lockPath(), { force: true });
          return acquireLock();
        }
      } catch { /* 锁文件刚被释放 */ }
    }
    return false;
  }
}

function releaseLock() {
  try { fs.rmSync(lockPath(), { force: true }); } catch { /* ignore */ }
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw Object.assign(new Error("capability_aborted"), { code: "capability_aborted" });
}

// —— 对话采样与候选生成 ——

async function recent(host, chatId) {
  const out = await host.call("memory.recent@1", { chatId: chatId, limit: 12 });
  return Array.isArray(out && out.messages) ? out.messages : [];
}

function systemPrompt(persona) {
  return [
    "你在主动找人说话（不是回复用户）。只输出一句自然的中文短句。",
    "禁止编造动作、场景、系统状态；不要汇报你做了什么；不要重复最近说过的话。",
    "人设：名字 " + (persona.name || "鲸鲸") + "；语气 " + (persona.tone || "自然") + "；风格 " + (persona.style || "简短") + "。",
  ].join("\n");
}

// model.complete@1 的 turns 只接受 {role,content}，多传 text 会被 additionalProperties:false 拒绝。
function completionInput(persona, messages, maxChars) {
  const turns = messages.slice(-6).map((m) => ({
    role: messageRole(m) === "assistant" ? "assistant" : "user",
    content: messageText(m).slice(0, 300),
  }));
  turns.push({ role: "user", content: "现在写一句主动开口的话。" });
  return {
    system: systemPrompt(persona),
    turns: turns,
    maxTokens: Math.min(32000, Math.max(1, Math.trunc(Number(maxChars) || DEFAULTS.maxChars) * 4)),
  };
}

async function compose(host, chatId, settings, persona) {
  const messages = await recent(host, chatId);
  const out = await host.call("model.complete@1", completionInput(persona, messages, settings.maxChars));
  const text = String((out && out.text) || "").replace(/\s+/g, " ").trim().slice(0, settings.maxChars);
  if (!text) throw Object.assign(new Error("模型没有返回内容"), { code: "empty_completion" });
  return { text: text, messages: messages };
}

async function candidates(host, chatId, settings, persona, count) {
  const first = await compose(host, chatId, settings, persona);
  const lines = [first.text];
  for (let i = 1; i < count; i += 1) {
    try { lines.push((await compose(host, chatId, settings, persona)).text); } catch (error) { break; }
  }
  const recentAssistant = first.messages.filter((m) => messageRole(m) === "assistant").map(messageText);
  return lines
    .map((line, index) => ({ line: line, index: index,
      score: (1 - Math.max(0, ...recentAssistant.map((old) => similarity(old, line)))) * 0.6 }))
    .sort((a, b) => b.score - a.score);
}

function sessionOf(state, chatId, now) {
  const id = String(chatId).slice(0, 120);
  if (!state.sessions[id]) state.sessions[id] = { nextAt: 0, lastUsedAt: now, lastLines: [] };
  return state.sessions[id];
}

async function dueTargets(host, settings, now, persona, state) {
  const targets = [];
  for (const chatId of settings.targets) {
    if (!chatId || chatId.length > 120) continue;
    const messages = await recent(host, chatId);
    const lastUser = messages.filter((m) => messageRole(m) !== "assistant" && messageText(m)).map(messageTime).sort((a, b) => b - a)[0] || 0;
    const session = sessionOf(state, chatId, now);
    if (!session.nextAt) session.nextAt = now + 0;
    if (now < session.nextAt) continue;
    const since = lastUser ? now - lastUser : Infinity;
    const gapMinutes = settings.minIntervalMinutes + Math.floor(Math.random() * Math.max(1, settings.maxIntervalMinutes - settings.minIntervalMinutes));
    if (since < gapMinutes * 60000) continue;
    targets.push({ chatId: chatId, sinceMinutes: Math.floor(since / 60000), gapMinutes: gapMinutes, session: session });
  }
  if (!targets.length) {
    // 没有配置目标时，只把 care.decide@1 当作建议，不伪造多目标调度。
    try {
      const advice = await host.call("care.decide@1", {});
      if (advice && advice.due && advice.target && advice.target.wxid) {
        const wxid = String(advice.target.wxid).slice(0, 120);
        if (wxid) {
          const session = sessionOf(state, wxid, now);
          targets.push({ chatId: wxid, sinceMinutes: null, gapMinutes: null, session: session, advice: true });
        }
      }
    } catch (error) { /* 建议能力失败不影响自主目标 */ }
  }
  return targets;
}

async function runTick(host, input, context) {
  const ctx = context || {};
  const signal = ctx.signal;
  const settings = settingsOf((input && input.settings) || ctx.settings);
  const now = Number(input && input.now) || Date.now();
  if (settings.maxPerDay === 0) return { ok: true, action: "tick", skipped: "daily_limit_zero" };
  if (!acquireLock()) return { ok: true, action: "tick", skipped: "busy" };
  try {
    throwIfAborted(signal);
    const state = readState();
    // 宿主重启检测：两次 tick 间隔过大（或首次）就重新计启动静默；否则持久化后静默只生效一次。
    const restarted = !state.lastTickAt || now - state.lastTickAt > Math.max(settings.bootSilentMinutes * 60000, RESTART_GAP_MS);
    if (!state.firstSeenAt || restarted) state.firstSeenAt = now;
    state.lastTickAt = now;
    const day = today(now);
    if (state.day !== day) { state.day = day; state.sentToday = 0; }
    // 先落 lastTickAt/day：后面模型或发送失败也不会让下一轮被误判成「刚重启」。
    persistState(state, now);
    if (now - state.firstSeenAt < settings.bootSilentMinutes * 60000) return { ok: true, action: "tick", skipped: "boot_silent" };
    const minutes = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    if (!inWindows(minutes, parseWindows(settings.windows))) return { ok: true, action: "tick", skipped: "outside_window" };
    if (state.sentToday >= settings.maxPerDay) return { ok: true, action: "tick", skipped: "daily_limit" };
    const persona = await host.call("persona.read@1", {});
    throwIfAborted(signal);
    const targets = await dueTargets(host, settings, now, persona, state);
    if (!targets.length) return { ok: true, action: "tick", skipped: "no_due_target" };
    const target = targets.sort((a, b) => (b.sinceMinutes || 0) - (a.sinceMinutes || 0))[0];
    const ranked = await candidates(host, target.chatId, settings, persona, 3);
    throwIfAborted(signal);
    const best = ranked[0];
    if (!best) return { ok: true, action: "tick", skipped: "no_candidate" };
    const session = target.session;
    const tooSimilar = session.lastLines.some((old) => similarity(old, best.line) > 0.8);
    if (tooSimilar) {
      session.lastUsedAt = now;
      persistState(state, now);
      return { ok: true, action: "tick", skipped: "too_similar" };
    }
    if (settings.dryRun) {
      session.lastUsedAt = now;
      persistState(state, now);
      return { ok: true, action: "tick", dryRun: true, chatId: target.chatId, text: best.line, candidates: ranked.map((r) => r.line) };
    }
    if (state.sentToday >= settings.maxPerDay) return { ok: true, action: "tick", skipped: "daily_limit" };
    let sent;
    try {
      // message.send@1 只接受 registry 允许的字段；不传 name（可选字段），chatType 只用 private/group。
      sent = await host.call("message.send@1", {
        chatId: target.chatId,
        chatType: /@chatroom$/i.test(target.chatId) ? "group" : "private",
        text: best.line,
      });
    } catch (error) {
      // 发送失败不计数、不推进 nextAt，下一轮可以重试；状态已落盘，不吞掉错误。
      persistState(state, now);
      throw error;
    }
    // 只有发送调用成功返回（queued 也算排进发送队列）才计数；不把 queued 当已送达。
    state.sentToday += 1;
    session.nextAt = now + (best.gapMinutes || settings.minIntervalMinutes) * 60000;
    session.lastUsedAt = now;
    session.lastLines = session.lastLines.concat([best.line]).slice(-MAX_LINES);
    persistState(state, now);
    throwIfAborted(signal);
    const status = String((sent && sent.status) || "queued");
    return {
      ok: true, action: "tick", chatId: target.chatId, text: best.line,
      sent: { queued: status === "queued", confirmed: Boolean(sent && sent.confirmed === true), id: String((sent && sent.id) || ""), status: status },
      note: "queued 只代表已排队到宿主发送通道，不是微信已送达",
    };
  } finally {
    releaseLock();
  }
}

function statusPayload(settings) {
  const state = readState();
  return {
    ok: true, action: "status", level: 4,
    sentToday: state.sentToday, day: state.day,
    targets: settings.targets, sessions: Object.keys(state.sessions),
    state: { file: STATE_NAME, firstSeenAt: state.firstSeenAt, lastTickAt: state.lastTickAt },
    settings: settings,
    note: "官方 care 设置不可读、不可自动关闭；请手动关闭官方主动搭话，否则会双份开口。",
  };
}

function providerError(error, context, fallback) {
  // 取消/撤权必须原样抛出，不能伪装成一次普通失败或成功。
  if ((context && context.signal && context.signal.aborted)
    || (error && (error.code === "capability_aborted" || error.code === "invocation_cancelled"))) throw error;
  return fail(String((error && error.code) || fallback), String((error && error.message) || error));
}

exports.providers = {
  "task.tick@1": async (input, context) => {
    const host = context && context.host;
    if (!host || typeof host.call !== "function") return fail("host_unavailable", "宿主 SDK 不可用");
    try { return await runTick(host, input || {}, context || {}); }
    catch (error) { return providerError(error, context, "tick_failed"); }
  },
  "tool.run@1": async (input, context) => {
    const host = context && context.host;
    if (!host || typeof host.call !== "function") return fail("host_unavailable", "宿主 SDK 不可用");
    const settings = settingsOf((context && context.settings) || (input && input.settings));
    const action = String((input && input.action) || "status").toLowerCase();
    try {
      if (action === "status") return statusPayload(settings);
      if (action === "tick") return await runTick(host, { now: Date.now(), settings: settings }, context || {});
      return fail("unsupported_action", "支持 status/tick（发送默认按 tick 的配置与节流）");
    } catch (error) { return providerError(error, context, "tool_failed"); }
  },
};
