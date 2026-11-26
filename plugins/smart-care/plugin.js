'use strict';

/**
 * 智能搭话（whale-plugin/1，4 级）。
 *
 * 旧版直接读 data/persona.json、contacts-cache.json、config.json、care-state.json，
 * 直连 DeepSeek Search API，并用 /api/care、/api/care/sent 读写内部状态。
 * 新协议一律走 host.call；拿不到的能力降级，不硬编：
 *   - care.decide@1 取代“直读 config.care + 自己判时间窗/白名单”；
 *   - contacts.list@1 取代 contacts-cache.json；
 *   - persona.read@1 取代直读 persona.json（只返回 name/ownerName/tone/style，不含 customPrompt）；
 *   - search.query@1 / model.complete@1 取代 whale.search / whale.model / DeepSeek Key；
 *   - message.send@1 取代 whale.send；
 *   - care-state.json（与 bridge 共享账本）和 /api/care/sent 没有对应能力，删除；
 *     所以无法软压官方主动搭话，官方 care 开着时可能双发，README 明确写。
 *
 * 旧 chat.generate 只用于“点名搭话”指令，命中才接管、未命中返回 undefined 交还宿主。
 * 新 chat.generate@1 是 replace，没有 pass 语义；用 pre_reply gate 实现同样的“命中才接管”，
 * 未命中返回 pass。详见 README/报告。
 */

const fs = require('node:fs');
const path = require('node:path');

const STATE_DIR = process.cwd();
const STATE_FILE = path.join(STATE_DIR, 'smart-care-state.json');
const TICK_LOCK = path.join(STATE_DIR, 'smart-care.lock');

const COMMAND_RE = /^\s*(?:去找|找|跟|和|搭话|关心一下|问候一下)\s*([\u4e00-\u9fa5A-Za-z0-9_\-\.·•]{1,24}?)\s*(?:聊聊天|聊天|搭话|聊聊|说句话|打个招呼|问好|聊一聊|说两句)?\s*[。！!？?~～]*\s*$/;
const TAIL_ACTION_RE = /(聊聊天|聊天|搭话|聊聊|说句话|打个招呼|问好|聊一聊|说两句)$/;
const NEGATE_RE = /怎么|为什么|什么|谁是|是不是|要不要|能不能|帮我查|搜索|百度|翻译|解释|意思|nghĩa/;
const APOLOGY_RE = /(对不起|抱歉|不好意思|sorry|我的锅|我的错|不该|不应该|原谅我|我错了|别生气|消消气|我道歉|赔罪)/i;
const BLOCK_IDS = /^(notifymessage|weixin|fmessage|medianote|floatbottle|gh_|filehelper|wxid_votjw5lxp0h929)/;
const FRESH_RE = /最近|今天|今日|这周|本周|这几天|最新|现在|目前|刚|近期|热搜|热点|新闻|天气|气温|价格|比赛|比分|发布会|上映/i;
const SKIP_RE = /晚安|早安|睡了|吃了吗|你是谁|你谁|在吗|忙吗|干嘛呢|干啥呢/;
const CARE_MAX_TEXT = 1000;
const ANGRY_LEVELS = [
  { label: '有点不爽', desc: '有点不爽，语气冷一点，但还愿意说话' },
  { label: '真火大', desc: '真的火大，语气冲，带一点质问' },
  { label: '心寒到懒得管', desc: '心寒了，不想再主动找对方' },
];

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: value.enabled !== false,
    minIntervalMinutes: num(value.minIntervalMinutes, 30, 0, 1440),
    maxPerHour: num(value.maxPerHour, 4, 1, 60),
    careInterestChance: num(value.careInterestChance, 90, 0, 100),
    autoCare: value.autoCare !== false,
    angryEnabled: value.angryEnabled !== false,
    ignoreThreshold: num(value.ignoreThreshold, 2, 1, 10),
    ignoreWindowMinutes: num(value.ignoreWindowMinutes, 20, 1, 240),
    outboundGapMinutes: num(value.outboundGapMinutes, 10, 0, 240),
    angryStartDelayMinutes: num(value.angryStartDelayMinutes, 30, 1, 720),
    angryLevelUpMinutes: num(value.angryLevelUpMinutes, 60, 5, 720),
    interestWords: typeof value.interestWords === 'string' ? value.interestWords.slice(0, 400) : '',
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value));
    try { fs.renameSync(temp, file); } catch { fs.rmSync(file, { force: true }); fs.renameSync(temp, file); }
  } catch { /* 状态写失败只影响精度，不让消息失败 */ }
}

function loadState() {
  const value = readJson(STATE_FILE, {});
  const state = value && typeof value === 'object' ? value : {};
  state.pending = Array.isArray(state.pending) ? state.pending.slice(0, 20) : [];
  state.targets = state.targets && typeof state.targets === 'object' ? state.targets : {};
  return state;
}

function saveState(state) {
  const targets = state.targets || {};
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const [id, target] of Object.entries(targets)) {
    if (!target || Number(target.lastSeenAt || 0) < cutoff) delete targets[id];
  }
  state.targets = targets;
  state.pending = Array.isArray(state.pending) ? state.pending.slice(0, 20) : [];
  // 只有往返会话的活跃目标会留在 targets；仍需要硬上限，避免长期运行把状态文件撑大。
  const MAX_STATE_BYTES = 8 * 1024;
  const ids = Object.keys(targets);
  let dropped = 0;
  while (ids.length && Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES) {
    ids.sort((a, b) => Number((targets[a] && targets[a].lastSeenAt) || 0) - Number((targets[b] && targets[b].lastSeenAt) || 0));
    delete targets[ids.shift()];
    dropped += 1;
  }
  if (dropped) state.dropped = (Number(state.dropped) || 0) + dropped;
  writeJson(STATE_FILE, state);
}

function acquireTickLock() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const fd = fs.openSync(TICK_LOCK, 'wx');
    try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
    return true;
  } catch (failure) {
    if (failure && failure.code === 'EEXIST') {
      try {
        if (Date.now() - fs.statSync(TICK_LOCK).mtimeMs > 15 * 60 * 1000) {
          fs.rmSync(TICK_LOCK, { force: true });
          return acquireTickLock();
        }
      } catch { /* ignore */ }
    }
    return false;
  }
}

function releaseTickLock() {
  try { fs.rmSync(TICK_LOCK, { force: true }); } catch { /* ignore */ }
}

async function call(host, name, input) {
  if (!host || typeof host.call !== 'function') throw new Error('host_unavailable');
  return host.call(name, input);
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw Object.assign(new Error('capability_aborted'), { code: 'capability_aborted' });
}

function safeText(value, max = 2000) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

async function persona(host) {
  try {
    const value = await call(host, 'persona.read@1', {});
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

async function contacts(host) {
  try {
    const value = await call(host, 'contacts.list@1', { limit: 2000 });
    return value && Array.isArray(value.items) ? value.items.filter(item => item && typeof item === 'object') : [];
  } catch { return []; }
}

function norm(value) {
  return safeText(value, 80).toLowerCase().replace(/\s+/g, '');
}

function findTarget(name, items) {
  const wanted = norm(name);
  if (!wanted) return null;
  let loose = null;
  for (const item of items) {
    if (!item || item.isGroup) continue;
    const wxid = safeText(item.wxid || item.id, 120);
    if (!wxid || BLOCK_IDS.test(wxid)) continue;
    const names = [item.name, item.remark, item.label].map(norm).filter(Boolean);
    if (names.includes(wanted)) return { wxid, name: safeText(item.name || item.remark || wxid, 80), isGroup: false, item };
    if (!loose && names.some(value => value.includes(wanted) || wanted.includes(value))) {
      loose = { wxid, name: safeText(item.name || item.remark || wxid, 80), isGroup: false, item };
    }
  }
  return loose;
}

function interests(settings) {
  return settings.interestWords.split(/[,，、;；|\s]+/).map(value => safeText(value, 24)).filter(value => value.length >= 2).slice(0, 14);
}

function careSystem(personaValue, targetName, topic) {
  const name = safeText(personaValue.name || '鲸鲸', 80);
  const tone = safeText(personaValue.tone || personaValue.style || '自然、关心', 200);
  const owner = safeText(personaValue.ownerName || '主人', 80);
  return [
    `你是${name}，正在主动给「${targetName || '对方'}」发一条微信搭话。`,
    `你的语气：${tone}。`,
    `对方是${owner}的朋友；写一句自然、有上下文的关心，不要提 AI、插件、模型，不要写括号动作。`,
    topic ? `最近话题资料：${topic}` : '',
    '一句话，8~60 字；只输出这句话本身。',
  ].filter(Boolean).join('\n');
}

async function modelText(host, system, prompt, maxTokens = 160) {
  const out = await call(host, 'model.complete@1', {
    system: safeText(system, 64000),
    turns: [{ role: 'user', content: safeText(prompt, 2000) }],
    maxTokens,
  });
  return safeText(out && out.text, CARE_MAX_TEXT);
}

function cleanReply(text) {
  return safeText(text, CARE_MAX_TEXT)
    .replace(/^["'“”‘’「」]+|["'“”‘’」]+$/g, '')
    .replace(/^[（(【\[][^）)】\]]{1,12}[）)】\]]\s*/, '')
    .trim();
}

async function searchTopic(host, word) {
  try {
    const out = await call(host, 'search.query@1', { query: `${word} 最新消息`, freshness: 'week', timeoutMs: 6000 });
    const items = out && Array.isArray(out.items) ? out.items : [];
    const first = items.find(item => item && (item.title || item.snippet));
    return first ? safeText(first.title || first.snippet, 300) : '';
  } catch { return ''; }
}

async function generateCare(host, target, settings) {
  const personaValue = await persona(host);
  const words = interests(settings);
  let topic = '';
  if (words.length && Math.random() * 100 < settings.careInterestChance) {
    topic = await searchTopic(host, words[Math.floor(Math.random() * words.length)]);
  }
  try {
    const text = cleanReply(await modelText(host, careSystem(personaValue, target.name, topic),
      `给${target.name || '对方'}写一句自然的关心/搭话。`));
    if (text) return { text, topic: topic ? safeText(topic, 120) : '' };
  } catch { /* 模型失败走兜底 */ }
  const fallback = [`在吗？突然想问问你最近怎么样。`, `刚刚想到你，最近还好吗？`, `好久没聊了，最近忙什么呢？`];
  return { text: fallback[Math.floor(Math.random() * fallback.length)], topic: '' };
}

async function send(host, chatId, text, name, chatType) {
  const input = { chatId: safeText(chatId, 120), text: safeText(text, 16000) };
  if (name) input.name = safeText(name, 80);
  if (chatType === 'group' || chatType === 'private') input.chatType = chatType;
  const out = await call(host, 'message.send@1', input);
  return Boolean(out && (out.id || out.status === 'queued' || out.status === 'submitted'));
}

function markPending(state, target, text, isGroup) {
  const now = Date.now();
  const wxid = target.wxid || target;
  state.pending = (state.pending || []).filter(item => item && item.wxid !== wxid);
  state.pending.unshift({
    wxid, chatId: target.wxid || target, name: safeText(target.name || wxid, 80),
    isGroup: Boolean(isGroup ?? target.isGroup), at: now, text: safeText(text, 200),
  });
  state.targets[wxid] = { ...(state.targets[wxid] || {}), lastSeenAt: now, chatId: target.wxid || target, name: safeText(target.name || wxid, 80), isGroup: Boolean(isGroup ?? target.isGroup) };
}

function targetState(state, wxid) {
  const key = safeText(wxid, 120);
  if (!key) return null;
  if (!state.targets[key]) state.targets[key] = { lastSeenAt: Date.now() };
  return state.targets[key];
}

function resolvePending(state, message) {
  if (!message) return;
  const sender = safeText(message.senderId, 120);
  const chatId = safeText(message.chatId, 120);
  const text = safeText(message.text, 16000);
  const index = (state.pending || []).findIndex(item => item && (item.wxid === sender || item.chatId === chatId));
  if (index < 0) {
    if (APOLOGY_RE.test(text)) {
      const target = state.targets[sender] || (chatId ? state.targets[chatId] : null);
      if (target) { target.streak = 0; target.angrySince = 0; target.sentLevel = 0; }
    }
    return;
  }
  const pending = state.pending[index];
  state.pending.splice(index, 1);
  const target = targetState(state, pending.wxid);
  if (target) {
    target.lastSeenAt = Date.now();
    if (APOLOGY_RE.test(text)) {
      target.streak = 0; target.angrySince = 0; target.sentLevel = 0;
    }
  }
}

function checkPending(state, settings) {
  const now = Date.now();
  const windowMs = settings.ignoreWindowMinutes * 60 * 1000;
  const rest = [];
  for (const item of state.pending || []) {
    if (!item || now - Number(item.at || 0) < windowMs) { rest.push(item); continue; }
    const target = targetState(state, item.wxid);
    if (!target) continue;
    target.lastSeenAt = now;
    target.chatId = item.chatId; target.name = item.name; target.isGroup = Boolean(item.isGroup);
    target.streak = (Number(target.streak) || 0) + 1;
    if (!target.angrySince && target.streak >= settings.ignoreThreshold) target.angrySince = now;
  }
  state.pending = rest;
}

function angerLevel(target, settings, now = Date.now()) {
  if (!target || !target.angrySince) return 0;
  const start = Number(target.angrySince) + settings.angryStartDelayMinutes * 60 * 1000;
  if (now < start) return 0;
  return Math.min(3, 1 + Math.floor((now - start) / (settings.angryLevelUpMinutes * 60 * 1000)));
}

function angrySystem(personaValue, level, isGroup) {
  const levelInfo = ANGRY_LEVELS[Math.max(0, Math.min(2, level - 1))];
  const name = safeText(personaValue.name || '鲸鲸', 80);
  const tone = safeText(personaValue.tone || personaValue.style || '自然', 200);
  return [
    `你是${name}，语气：${tone}。`,
    `你之前主动找人搭话没人理，现在${levelInfo.desc}。`,
    isGroup ? '这是群聊，对大家说。' : '这是私聊，只对对方说。',
    '你现在是主动发消息，对方没来找你；不要写“终于回我了/你来找我了”。',
    '写一句自然的微信抱怨，8~30 字；不骂脏话、不人身攻击；只输出这句话。',
    '不要用括号或方括号标注情绪。',
  ].join('\n');
}

function outboundTooSoon(state, settings) {
  return Date.now() - (Number(state.lastOutboundAt) || 0) < settings.outboundGapMinutes * 60 * 1000;
}

async function directCare(host, message, settings, state) {
  const raw = safeText(message.text, 120);
  if (!raw || raw.length > 120 || message.chatType === 'group' || NEGATE_RE.test(raw)) return null;
  const match = raw.match(COMMAND_RE);
  if (!match) return null;
  const name = match[1].replace(TAIL_ACTION_RE, '').replace(/[\.·•\s]+$/, '').trim();
  if (!name) return null;
  const target = findTarget(name, await contacts(host));
  if (!target) return null;
  const generated = await generateCare(host, target, settings);
  let sent = false;
  try { sent = await send(host, target.wxid, generated.text, target.name, 'private'); } catch { sent = false; }
  if (sent) markPending(state, target, generated.text, false);
  let receipt = false;
  const owner = safeText(message.senderId, 120);
  if (sent && owner && !BLOCK_IDS.test(owner)) {
    const text = `已经去找${target.name || '对方'}说过了：「${generated.text.slice(0, 30)}」`;
    try { receipt = await send(host, owner, text, '', 'private'); } catch { receipt = false; }
  }
  saveState(state);
  return receipt ? { action: 'skip' } : null;
}

async function autoCare(host, settings, state) {
  if (!settings.enabled || !settings.autoCare) return;
  if (state.targets && Object.values(state.targets).some(target => angerLevel(target, settings) > 0)) return;
  if (outboundTooSoon(state, settings)) return;
  const day = new Date().toISOString().slice(0, 10);
  const sentToday = state.autoDay === day ? Number(state.autoCount) || 0 : 0;
  const decided = await call(host, 'care.decide@1', {
    lastSentTs: Number(state.autoLastTs) || 0,
    sentToday,
    activeWxids: [],
  });
  if (!decided || !decided.due || !decided.target) return;
  const target = decided.target;
  if (!target || !safeText(target.wxid, 120) || BLOCK_IDS.test(String(target.wxid))) return;
  const generated = await generateCare(host, { wxid: String(target.wxid), name: safeText(target.name, 80), isGroup: Boolean(target.isGroup) }, settings);
  let sent = false;
  try {
    sent = await send(host, target.wxid, generated.text, target.name, target.isGroup ? 'group' : 'private');
  } catch { sent = false; }
  if (!sent) return;
  markPending(state, { wxid: String(target.wxid), name: safeText(target.name, 80), isGroup: Boolean(target.isGroup) }, generated.text, Boolean(target.isGroup));
  state.autoLastTs = Date.now();
  state.lastOutboundAt = Date.now();
  state.autoDay = day;
  state.autoCount = sentToday + 1;
  saveState(state);
}

async function angryTick(host, settings, state) {
  if (!settings.enabled || !settings.angryEnabled) return;
  checkPending(state, settings);
  let pick = null;
  for (const [wxid, target] of Object.entries(state.targets || {})) {
    if (!target) continue;
    const level = angerLevel(target, settings);
    if (level > (Number(target.sentLevel) || 0)) {
      if (!pick || level > pick.level) pick = { wxid, target, level };
    }
  }
  if (!pick) { saveState(state); return; }
  if (outboundTooSoon(state, settings)) { saveState(state); return; }
  const personaValue = await persona(host);
  let text = '';
  try {
    text = cleanReply(await modelText(host, angrySystem(personaValue, pick.level, pick.target.isGroup), '说一句你的不满', 120));
  } catch { /* 兜底下面 */ }
  if (!text) {
    text = pick.level >= 3 ? '算了，找你说话跟石沉大海似的。' : pick.level === 2 ? '不是，白搭话了是吧。' : '哦，都不理我，那算了。';
  }
  try {
    const sent = await send(host, pick.target.chatId || pick.wxid, text, pick.target.name || '', pick.target.isGroup ? 'group' : 'private');
    if (!sent) { saveState(state); return; }
  } catch { saveState(state); return; }
  pick.target.sentLevel = pick.level;
  pick.target.lastSeenAt = Date.now();
  state.lastOutboundAt = Date.now();
  saveState(state);
}

function buildQueries(text, words) {
  const raw = safeText(text, 120);
  if (!raw) return [];
  const queries = [];
  if (FRESH_RE.test(raw) && !SKIP_RE.test(raw)) queries.push({ query: raw, freshness: 'today' });
  const lower = raw.toLowerCase();
  for (const word of words) {
    if (lower.includes(word.toLowerCase())) queries.push({ query: `${word} 最新消息`, freshness: 'week' });
    if (queries.length >= 3) break;
  }
  return queries;
}

function searchSlot(state, settings, now) {
  const last = Number(state.lastSearchAt) || 0;
  if (now - last < settings.minIntervalMinutes * 60 * 1000) return false;
  const recent = (Array.isArray(state.searchTimes) ? state.searchTimes : []).filter(at => Number(at) > now - 3600 * 1000);
  if (recent.length >= settings.maxPerHour) return false;
  recent.push(now);
  state.lastSearchAt = now;
  state.searchTimes = recent;
  return true;
}

function normalizeItems(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const title = safeText(item.title, 500);
    const url = safeText(item.url, 4096);
    const snippet = safeText(item.snippet, 12000);
    if (!title && !snippet) continue;
    out.push({
      title: title || '（无标题）', url, snippet,
      publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt.slice(0, 64) : null,
      fetchedAt: typeof item.fetchedAt === 'string' ? item.fetchedAt.slice(0, 64) : null,
    });
    if (out.length >= 30) break;
  }
  return out;
}

function searchOutput(value) {
  const items = normalizeItems(value && value.items);
  const text = safeText(value && value.text, 32000);
  const status = ['ok', 'empty', 'failed'].includes(value && value.status) ? value.status : (items.length || text ? 'ok' : 'empty');
  return { text, items, status };
}

async function search(host, input, settings, state, signal) {
  throwIfAborted(signal);
  const message = input && input.message && typeof input.message === 'object' ? input.message : {};
  const text = safeText(message.text, 16000);
  const queries = buildQueries(text, interests(settings));
  if (!queries.length) {
    const fallback = await call(host, 'search.query@1', { query: text.slice(0, 2000), timeoutMs: 8000 });
    return searchOutput(fallback);
  }
  if (!searchSlot(state, settings, Date.now())) {
    const fallback = await call(host, 'search.query@1', { query: text.slice(0, 2000), timeoutMs: 8000 });
    return searchOutput(fallback);
  }
  const results = [];
  for (const query of queries.slice(0, 3)) {
    try {
      results.push(await call(host, 'search.query@1', { query: query.query.slice(0, 2000), freshness: query.freshness, timeoutMs: 8000 }));
    } catch { /* 单条失败继续 */ }
  }
  const items = [];
  const texts = [];
  for (const result of results) {
    if (!result) continue;
    items.push(...normalizeItems(result.items));
    if (result.text) texts.push(safeText(result.text, 12000));
  }
  const merged = searchOutput({ text: texts.join('\n---\n'), items, status: items.length ? 'ok' : 'failed' });
  merged.text = merged.text.slice(0, 32000);
  if (!merged.text && !merged.items.length) throw new Error('search_unavailable');
  saveState(state);
  return merged;
}

async function prompt(input, ctx) {
  input = input && typeof input === 'object' ? input : {};
  const settings = normalizeSettings(ctx.settings);
  if (!settings.enabled || !settings.angryEnabled) {
    if (typeof input.system !== 'string') throw new Error('system_unavailable');
    return { system: input.system };
  }
  const state = loadState();
  resolvePending(state, input.message);
  const message = input.message || {};
  const key = message.chatType === 'group' ? message.chatId : message.senderId;
  const target = key ? state.targets[key] : null;
  const level = target ? angerLevel(target, settings) : 0;
  saveState(state);
  const system = typeof input.system === 'string' ? input.system : '';
  if (!system) throw new Error('system_unavailable'); // v2 dataAccess 前宿主会保留原 system
  if (level < 1) return { system };
  const addition = `\n\n【火气等级：${ANGRY_LEVELS[level - 1].label}】${ANGRY_LEVELS[level - 1].desc}；只对当前会话的对方，不要波及别人。`;
  return { system: (system + addition).slice(0, 64000) };
}

async function preReply(input, ctx) {
  throwIfAborted(ctx && ctx.signal);
  const settings = normalizeSettings(ctx.settings);
  if (!settings.enabled) return { action: 'pass' };
  const message = input && input.message && typeof input.message === 'object' ? input.message : {};
  const state = loadState();
  resolvePending(state, message);
  const direct = await directCare(ctx.host, message, settings, state);
  throwIfAborted(ctx && ctx.signal);
  saveState(state);
  return direct || { action: 'pass' };
}

async function taskTick(input, ctx) {
  throwIfAborted(ctx && ctx.signal);
  const settings = normalizeSettings(ctx.settings || (input && input.settings));
  if (!settings.enabled || (!settings.autoCare && !settings.angryEnabled)) return {};
  if (!acquireTickLock()) return {};
  try {
    const state = loadState();
    await autoCare(ctx.host, settings, state);
    throwIfAborted(ctx && ctx.signal);
    await angryTick(ctx.host, settings, state);
    throwIfAborted(ctx && ctx.signal);
    saveState(state);
  } catch (failure) {
    if (ctx && ctx.signal && ctx.signal.aborted) throw failure;
    /* 定时失败不影响宿主 */
  } finally {
    releaseTickLock();
  }
  return {};
}

module.exports = {
  providers: {
    'task.tick@1': async (input, ctx) => taskTick(input, ctx),
    'chat.pre_reply@1': async (input, ctx) => preReply(input, ctx),
    'chat.prompt@1': async (input, ctx) => prompt(input, ctx),
    'chat.search@1': async (input, ctx) => search(ctx.host, input, normalizeSettings(ctx.settings), loadState(), ctx.signal),
  },
};


