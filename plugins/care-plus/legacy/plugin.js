'use strict';

/**
 * care-plus —— 主动搭话增强（鲸鲸 JavaScript 插件 Api 4）
 *
 * 官方 care 的问题不是模型不行，是策略太单薄：
 *   锚点是「上次搭话」而不是「用户最后说话」；没有未回复记忆；提示词只有 6 行、
 *   跟人设完全脱钩，于是每 90 分钟产出一句「在干啥 / 吃了吗」。
 *
 * 这个插件把「什么时候说」和「说什么」拆开：
 *   调度：以用户的沉默时长为锚 + 真随机间隔 + 未回复次数硬上限 + 免打扰时段
 *   内容：沿用官方 /api/debug/prompt 的完整人设 system，再从人物卡里挑具体话头
 *   反馈：发完记下台词与被回复结果，下次据此收语气，重复的直接淘汰
 *
 * 安全边界：只发给 config.persona.master.wxids 里的主人私聊，绝不进群、绝不发给别人。
 * 默认不改任何配置；要接管官方 care 需要显式传 {action:'takeover'}。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = 2;

const DEFAULTS = {
  // 允许开口的时段；正常情况下由官方 care.windows 覆盖，这里只是读不到时的兜底
  windows: '10:00-23:59',
  // 额外禁止的时段（可选，插件设置框里写了「静默」才生效）
  quiet: '',
  // 沉默多久之后可能开口：区间内真随机，每次重新掷
  minIntervalMinutes: 25,
  maxIntervalMinutes: 300,
  // 连续多少次主动开口没被回应就彻底停手，直到对方先说话。0 = 不限制
  maxUnanswered: 3,
  maxPerDay: 5,
  // 插件/内核刚起来时强制安静这么久，避免重启后立刻冒一句（官方无对应项）
  bootSilentMinutes: 30,
  candidates: 3,
  maxChars: 60,
  askQuestions: true,
  useDiary: true,
  useFacts: true,
};

/* ------------------------------ 基础工具 ------------------------------ */

function sdk(ctx) {
  if (ctx && ctx.whale) return ctx.whale;
  return require('whale');
}

function int(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* 设置项的中文写法。启动器那个框只能存 JSON 对象，所以把键名做成中文、项数压到最少。 */
/* ---------- 官方 care 的设定 → 插件参数（唯一真相源） ---------- */

/**
 * 官方「主动与提醒」页里的每一项，翻译成插件要的形态。
 * 这样主人只需要在一个地方调参数，插件跟着走，自己不再有设置界面。
 */
function careToSettings(config) {
  const care = (config && config.care) || {};
  const out = {};
  const every = Number(care.everyMinutes);
  const jitter = Number(care.jitterMinutes);
  if (Number.isFinite(every) && every > 0) {
    const j = Number.isFinite(jitter) && jitter >= 0 ? jitter : 0;
    out.minIntervalMinutes = Math.max(1, Math.round(every - j));
    out.maxIntervalMinutes = Math.max(1, Math.round(every + j));
  }
  const cap = Number(care.maxPerDay);
  if (Number.isFinite(cap) && cap >= 0) out.maxPerDay = cap;
  // 官方的 quietAfterMinutes = 「最近聊过就先不打扰」，并进最短沉默时长
  const quietAfter = Number(care.quietAfterMinutes);
  if (Number.isFinite(quietAfter) && quietAfter > 0) {
    out.minIntervalMinutes = Math.max(Number(out.minIntervalMinutes) || 0, Math.round(quietAfter));
    out.maxIntervalMinutes = Math.max(Number(out.maxIntervalMinutes) || 0, out.minIntervalMinutes);
  }
  const windows = (Array.isArray(care.windows) ? care.windows : []).join(',');
  if (String(windows).trim()) out.windows = String(windows);
  return out;
}

/* ---------- 插件自己的设置框：正常留空 {}，只当应急覆盖 ---------- */

const ALIASES = {
  windows: ['时段', '允许', '允许时段', '窗口', 'windows'],
  quiet: ['静默', '免打扰', '静默时段', '免打扰时段', 'quiet'],
  interval: ['间隔', '等多久', '多久', '沉默'],
  minIntervalMinutes: ['最短', '最短间隔', '最少等'],
  maxIntervalMinutes: ['最长', '最长间隔', '最多等'],
  maxPerDay: ['每天', '每日', '每天最多', '上限', '每天几次'],
  maxUnanswered: ['没回', '未回', '没被回', '未回复'],
  candidates: ['候选', '候选数', '生成几个'],
  maxChars: ['字数', '长度', '最多字'],
  bootSilentMinutes: ['启动', '刚启动', '启动静默', '开机'],
  askQuestions: ['提问', '问问题', '问句'],
  useDiary: ['日记'],
  useFacts: ['人物卡', '事实', '话头', '话题'],
};

const KEY_OF = (() => {
  const map = new Map();
  for (const canon of Object.keys(ALIASES)) {
    map.set(canon.toLowerCase(), canon);
    for (const alias of ALIASES[canon]) {
      map.set(String(alias).toLowerCase().replace(/[\s_\-·:：]/g, ''), canon);
    }
  }
  return map;
})();

function canonicalKey(raw) {
  const key = String(raw == null ? '' : raw).toLowerCase().replace(/[\s_\-·:：]/g, '');
  return KEY_OF.get(key) || '';
}

function truthy(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (['开', '是', '要', 'on', 'true', 'yes', '1', '启用', '打开', '开启', '用'].includes(s)) return true;
  if (['关', '否', '不', '不要', '不用', '不开', 'off', 'false', 'no', '0', '停用', '关闭', '禁用'].includes(s)) return false;
  return null;
}

/** '30-240' / '30~240' / '30 240' / 30 都认 */
function parseRange(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? [value, value] : null;
  const s = String(value == null ? '' : value).trim();
  const m = /^(\d+)\s*(?:[-~到至]|\s)\s*(\d+)$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2])];
  if (/^\d+$/.test(s)) return [Number(s), Number(s)];
  return null;
}

function parseSettingsInput(src) {
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const [rawKey, rawValue] of Object.entries(src)) {
    const canon = canonicalKey(rawKey);
    if (!canon) continue;
    if (canon === 'interval') {
      const range = parseRange(rawValue);
      if (range) {
        out.minIntervalMinutes = range[0];
        out.maxIntervalMinutes = range[1];
      }
      continue;
    }
    if (typeof DEFAULTS[canon] === 'boolean') {
      const flag = truthy(rawValue);
      if (flag !== null) out[canon] = flag;
      continue;
    }
    out[canon] = rawValue;
  }
  return out;
}

/**
 * 生效中的参数：官方设定 → 插件设置框覆盖 → 兜底默认，最后统一钳制。
 * @param {object} ctx 钩子上下文（读 ctx.settings）
 * @param {object} config 运行时配置（读 config.care）
 */
function settingsOf(ctx, config) {
  const out = { ...DEFAULTS };
  Object.assign(out, careToSettings(config));
  const src = parseSettingsInput(ctx && ctx.settings);
  for (const key of Object.keys(DEFAULTS)) {
    const value = src[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof DEFAULTS[key] === 'boolean') out[key] = value === true;
    else if (typeof DEFAULTS[key] === 'string') out[key] = String(value);
    else out[key] = Number(value);
  }
  out.minIntervalMinutes = int(out.minIntervalMinutes, 25, 1, 43200);
  out.maxIntervalMinutes = int(out.maxIntervalMinutes, 300, 1, 43200);
  if (out.maxIntervalMinutes < out.minIntervalMinutes) out.maxIntervalMinutes = out.minIntervalMinutes;
  out.maxPerDay = int(out.maxPerDay, 5, 0, 50);
  out.maxUnanswered = int(out.maxUnanswered, 3, 0, 20);
  out.candidates = int(out.candidates, 3, 1, 5);
  out.maxChars = int(out.maxChars, 60, 12, 200);
  out.bootSilentMinutes = int(out.bootSilentMinutes, 30, 0, 1440);
  out.windowList = parseWindowsOf(out.windows);
  if (!out.windowList.length) out.windowList = parseWindowsOf(DEFAULTS.windows);
  out.quietRange = parseQuiet(String(out.quiet || ''));
  return out;
}

/** 把生效中的参数写成人话，用来在「运行一次」里核对。 */
function describeSettings(s) {
  const win = (s.windowList || []).map((w) => `${fmtClock(w.start)}~${fmtClock(w.end)}`).join('、');
  return [
    `允许时段 ${win || '—'}`,
    s.quietRange ? `额外静默 ${fmtClock(s.quietRange.start)}~${fmtClock(s.quietRange.end)}` : '',
    `沉默 ${s.minIntervalMinutes}~${s.maxIntervalMinutes} 分钟后可能开口`,
    s.maxPerDay > 0 ? `每天最多 ${s.maxPerDay} 次` : '每天不限次数',
    s.maxUnanswered > 0 ? `连续 ${s.maxUnanswered} 次没回就停` : '不因没回而停手',
    `候选 ${s.candidates} 条`,
    `单句不超过 ${s.maxChars} 字`,
    `启动先静默 ${s.bootSilentMinutes} 分钟`,
    `提问${s.askQuestions ? '开' : '关'}`,
    `日记${s.useDiary ? '开' : '关'}`,
    `人物卡${s.useFacts ? '开' : '关'}`,
  ].filter(Boolean).join('・');
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function sha1_16(value) {
  return crypto.createHash('sha1').update(String(value), 'utf8').digest('hex').slice(0, 16);
}

/** 与主程序 memory/hash.js 保持一致：sha1(chatId).slice(0,16) */
function chatDir(appData, chatId) {
  return path.join(appData, 'memory', 'chats', sha1_16(chatId));
}

/* ------------------------------ 时间处理 ------------------------------ */

function tzOf(config) {
  const t = String((config && config.env && config.env.timezone) || '').trim();
  return t || undefined;
}

function dayKey(now, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
}

function clockOf(now, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(now));
}

function weekdayOf(now, tz) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, weekday: 'long' }).format(new Date(now));
}

function hourOf(now, tz) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', hour12: false,
  }).format(new Date(now)));
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 把 '02:00-09:00' 解析成分钟区间，支持跨零点；非法返回 null */
function parseQuiet(text) {
  const parts = String(text || '').split(/[-~到至]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const start = minutesOf(parts[0]);
  const end = minutesOf(parts[1] === '24:00' ? '00:00' : parts[1]);
  if (start === null || end === null) return null;
  return { start, end };
}

function inQuiet(range, now, tz) {
  if (!range) return { quiet: false };
  const [h, m] = clockOf(now, tz).split(':').map(Number);
  const cur = h * 60 + m;
  const quiet = range.start <= range.end
    ? cur >= range.start && cur < range.end
    : cur >= range.start || cur < range.end;
  return { quiet };
}

function minutesOfDay(now, tz) {
  const [h, m] = clockOf(now, tz).split(':').map(Number);
  return h * 60 + m;
}

/** 一段区间内？支持跨零点（22:00-02:00）。 */
function inRange(range, minute) {
  if (!range) return false;
  return range.start <= range.end
    ? minute >= range.start && minute < range.end
    : minute >= range.start || minute < range.end;
}

function inWindows(minute, windows) {
  for (const w of windows || []) if (inRange(w, minute)) return true;
  return false;
}

/** '10:00-23:59,00:00-02:00' 或 ['10:00-23:59','00:00-02:00'] → 区间数组 */
function parseWindowsOf(value) {
  const list = Array.isArray(value)
    ? value
    : String(value == null ? '' : value).split(/[,，;；\n]+/);
  const out = [];
  for (const item of list) {
    const range = parseQuiet(String(item == null ? '' : item).trim());
    if (range) out.push(range);
  }
  return out;
}

/** 分钟数 → 'HH:MM'，给日志和人话描述用 */
function fmtClock(minute) {
  const m = Math.max(0, Math.min(1439, Math.round(Number(minute) || 0)));
  const h = Math.floor(m / 60);
  return String(h < 10 ? '0' + h : h) + ':' + String(m % 60 < 10 ? '0' + (m % 60) : m % 60);
}

function fmtDelta(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`;
}

function partOfDay(now, tz) {
  const h = hourOf(now, tz);
  if (h < 5) return '凌晨';
  if (h < 9) return '清早';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 22) return '晚上';
  return '深夜';
}

/* ------------------------------ 会话与人物卡 ------------------------------ */

/**
 * 读真实的会话流水：最后一条 user 消息时间、最后一条 care 消息时间和内容。
 * 只读，不写；读不到就返回空，绝不因为读失败而误发。
 */
function inspectChat(appData, chatId, recentLimit = 0) {
  const out = { lastUserTs: 0, lastUserText: '', lastCareTs: 0, lastCareText: '', total: 0, ok: false, recent: [] };
  try {
    const file = path.join(chatDir(appData, chatId), 'messages.jsonl');
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      out.total += 1;
      const ts = Number(m.ts) || 0;
      if (m.role === 'user' && ts >= out.lastUserTs) {
        out.lastUserTs = ts;
        out.lastUserText = String(m.text || '').slice(0, 80);
      }
      const msgId = String(m.msgId || '');
      if (m.role === 'assistant' && msgId.startsWith('care:') && ts >= out.lastCareTs) {
        out.lastCareTs = ts;
        out.lastCareText = String(m.text || '').slice(0, 80);
      }
      if (recentLimit > 0 && m.text && (m.role === 'user' || m.role === 'assistant')) {
        out.recent.push({
          role: m.role,
          name: String(m.name || (m.role === 'user' ? '' : '')),
          text: String(m.text).slice(0, 120),
          ts,
        });
        if (out.recent.length > recentLimit) out.recent.shift();
      }
    }
    out.ok = true;
  } catch { /* 没有历史就是没有历史 */ }
  return out;
}

function readCard(appData, chatId, uid) {
  try {
    const file = path.join(chatDir(appData, chatId), 'people', sha1_16(uid) + '.json');
    return readJson(file, null);
  } catch {
    return null;
  }
}

const STALE_FACT = /今天|今晚|明天|明天早上|刚刚|这会儿|等下|今晚要|现在在/;

/**
 * 「系统功能是否正常」这类话题不是在讲生活，是主人在调试机器人。
 * 拿它当话头，模型很容易写成「我刚发了语音」「我收到回执了」这种没发生过的动作。
 */
const META_TOPIC = /(语音|消息|回执|引用|截图|图片|表情包|联网|插件|接口|后台|数据库)(.{0,14})(收到|接收|能不能|能否|是否|确认|生效|正常|成功)/;

/** 从人物卡里挑「可以自然提一句」的具体话头；宁缺毋滥。 */
function pickAnchors(card, now) {
  const anchors = [];
  if (!card) return anchors;
  const threads = (card.threads || [])
    .filter((t) => t && !t.deleted && t.status === 'open' && t.text && !META_TOPIC.test(t.text));
  for (const t of threads.slice(0, 4)) anchors.push({ kind: 'thread', text: String(t.text).slice(0, 90) });
  const facts = (card.preferences || []).filter((p) => {
    if (!p || p.deleted || !p.text || META_TOPIC.test(p.text)) return false;
    // 时效性事实（「今天看了3个病人」）超过 36 小时就不可信，别再当成现在的事说出去。
    const fresh = now - Number(p.createdAt || 0) < 36 * 3600 * 1000;
    if (STALE_FACT.test(p.text) && !fresh) return false;
    return String(p.text).length >= 8;
  });
  for (const p of facts.slice(-4).reverse()) anchors.push({ kind: 'fact', text: String(p.text).slice(0, 90) });
  const events = (card.events || []).filter((e) => e && !e.deleted && e.title && !META_TOPIC.test(e.title));
  for (const e of events.slice(-2).reverse()) {
    const title = String(e.title).slice(0, 40);
    const summary = String(e.summary || '').slice(0, 70);
    anchors.push({ kind: 'event', text: summary ? `${title}：${summary}` : title });
  }
  return anchors.slice(0, 5);
}

/**
 * 她自己昨天写下的日记末段。这是「她自己的事」唯一可靠来源——
 * 否则让模型「说一件你自己的事」只会编出「我今天翻了翻书」这种没发生过的事。
 */
function readDiaryTail(appData, now) {
  try {
    const tz = undefined;
    const y = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(new Date(now));
    const dir = path.join(appData, 'diary', y);
    const files = fs.readdirSync(dir).filter((f) => /^\d{2}-\d{2}\.md$/.test(f)).sort();
    if (!files.length) return '';
    const text = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8');
    const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    for (let i = paras.length - 1; i >= 0; i -= 1) {
      const p = paras[i].replace(/^#+\s*/, '').replace(/^>.*$/gm, '').trim();
      if (p.length >= 12 && !/^日记写到这里/.test(p)) return p.slice(0, 140);
    }
    return '';
  } catch {
    return '';
  }
}

/* ------------------------------ 生成 ------------------------------ */

const CLICHE = /在干啥|干嘛呢|在忙吗|忙不忙|吃了吗|吃饭了|睡了吗|累不累|早点休息|在干嘛|干什么呢|想你|在吗/;
// 被冷落之后最容易冒出来的催促 / 索取语气：这时候再催，观感比问候还差
const PRESSURE = /给我个准话|到底|赶紧|必须|快点|别让我|说了几次|问了.{0,2}次|第二遍|不然|回我|快点回|说话|理我/;

function grams(text) {
  const s = String(text || '').replace(/[\s，,。.!！？?；;：:、"'“”‘’（）()【】\[\]]/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

function similarity(a, b) {
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

function maxSimilarity(text, lines) {
  let max = 0;
  for (const line of lines || []) max = Math.max(max, similarity(text, line));
  return max;
}

function escapeRe(value) {
  return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 她可能被写成的前缀（「小星：」「我：」），按当前人设算，不写死任何名字 */
function herDisplayNames(config) {
  const persona = (config && config.persona) || {};
  const out = ['我'];
  const push = (v) => {
    const s = String(v == null ? '' : v).trim();
    if (s.length >= 1 && !out.includes(s)) out.push(s);
  };
  push(persona.name);
  for (const alias of Array.isArray(persona.aliases) ? persona.aliases : []) push(alias);
  return out;
}

function stripNamePrefix(text, names) {
  const list = (Array.isArray(names) ? names : []).filter(Boolean).map(escapeRe);
  if (!list.length) return text;
  return text.replace(new RegExp('^(?:' + list.join('|') + ')\\s*[:：]\\s*'), '');
}

function cleanText(raw, maxChars, names) {
  let t = String(raw == null ? '' : raw).trim();
  const first = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (first.length) t = first[0];
  t = t.replace(/^[-*>\d.、)\s]+/, '');
  t = t.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
  t = stripNamePrefix(t, names);
  if (t.length > maxChars) {
    // 截到最后一个完整句子，别把话切断
    const cut = t.slice(0, maxChars);
    const idx = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('？'), cut.lastIndexOf('！'));
    t = idx >= 12 ? cut.slice(0, idx + 1) : cut;
  }
  return t.trim();
}

function buildTail({ config, ownerName, clock, weekday, part, idleMs, unanswered, lastCare, anchors, diary, avoid }) {
  const lines = [];
  lines.push('【这不是回复，是你自己开口找人说话】');
  lines.push(`现在是${weekday} ${clock}，${part}。对方（${ownerName}）最后一次说话是 ${fmtDelta(idleMs)}前，之后一直没有动静。`);
  lines.push('你没有收到任何新消息——不要假装他刚才说了话，也不要问「你刚说什么 / 怎么不理我」。');
  lines.push('');

  if (lastCare.text) {
    lines.push(`你上一次主动开口是 ${fmtDelta(lastCare.agoMs)}前：「${lastCare.text}」`);
    if (unanswered > 0) {
      lines.push(`对方没有回。这已经是你连续第 ${unanswered} 次主动开口没被回应了。`);
      lines.push('→ 语气往回收：不要撒娇、不要连问、不要表示委屈。可以只说一句你自己的事，给他一个不用解释就能接的台阶。');
    } else {
      lines.push('对方回了。可以从上次停下的地方往下接。');
    }
    lines.push('');
  }

  if (anchors.length) {
    lines.push('【可以提的具体事】（下面这些都是「他」的事，不要写成你自己的经历；挑一件，或者都不用）');
    for (const a of anchors) lines.push(`- ${a.text}`);
    lines.push('');
  }

  if (diary) {
    lines.push('【你自己最近写下的】（可以顺着这里的感觉说一句，但不要复述原文、不要说「我写了日记」）');
    lines.push(`- ${diary}`);
    lines.push('');
  }

  if (unanswered >= 2) {
    lines.push('【这一次的特别提醒】');
    lines.push('已经连着好几次没被回了。这一条不要再问他任何问题，也不要要求他回应、不要催、不要表达委屈。');
    lines.push('只说一件你自己的事，或者一个不需要他回答的念头。他不回也没关系。');
    lines.push('');
  }

  lines.push('【硬要求】');
  lines.push('- 一句话，15~40 字，像随手打的一条微信。');
  lines.push('- 句子里必须有一个具体的东西：一个时间、一件事、一个书名、一个数字、一个人。全是空话的句子不要发。');
  lines.push(`- 禁止用「${CLICHE.source.replace(/\|/g, '」「')}」这类问候开场，这些已经用过太多遍。`);
  lines.push('- 不许写你做过什么动作（翻书、做饭、出门、睡醒），也不许说你「发了语音 / 发了图片 / 收到了什么」——你只能打字，编出来会立刻穿帮。');
  lines.push('- 说自己的时候只用「我」：不要用名字当主语自称，也不要用第三人称说「她」。');
  lines.push('- 不要汇报自己的状态（我在…/我刚…/我正在…）。');
  lines.push('- 不要解释你为什么要找他，不要提「提醒」「任务」「系统」。');
  if (avoid.length) lines.push(`- 这几句最近说过，换一个完全不同的说法：${avoid.map((s) => `「${s}」`).join('、')}`);
  lines.push('- 只输出这一句本身，不要加引号、不要分多条。');
  return lines.join('\n');
}

/** 群聊：先把「冷场」讲清楚，再要求能让人接话的开放话题，并禁止泄露私聊内容。 */
function buildGroupTail({ groupName, clock, weekday, part, idleMs, recent, lastCare, unanswered, avoid }) {
  const lines = [];
  lines.push('【群里已经安静了，你可以起个头】');
  lines.push(`现在是${weekday} ${clock}，${part}。这个群（${groupName}）已经 ${fmtDelta(idleMs)} 没人说话。`);
  lines.push('你不是在回复谁，是你自己想找点话说。不要假装刚才有人 @ 你。');
  lines.push('');

  if (lastCare.text) {
    lines.push(`你上一次在这个群说话是 ${fmtDelta(lastCare.agoMs)}前：「${lastCare.text}」`);
    if (unanswered > 0) {
      lines.push(`没人接。这已经是你连续第 ${unanswered} 次在群里起头没人理了。`);
      lines.push('→ 这一条不要再追问「有人在吗」，换个完全不同的角度。');
    }
    lines.push('');
  }

  if (recent.length) {
    lines.push('【群里最近说的话】（只作参考，别复述、别逐条总结）');
    for (const m of recent) {
      const who = m.role === 'assistant' ? '你' : (m.name || '有人');
      lines.push(`- ${who}：${m.text}`);
    }
    lines.push('');
  }

  lines.push('【硬要求】');
  lines.push('- 一句话，10~35 字，像群里随手发的一句。');
  lines.push('- 要能让好几个人都接得上：一个开放的问题，或者一件大家都有共鸣的小事。');
  lines.push('- 不要 @ 任何人，不要点名，不要单独对某个人说话。');
  lines.push('- 不要提只有你和某个人才知道的事（私聊内容、日记内容一律不提）。');
  lines.push('- 不要说「我发了」「我收到了」这类没发生过的动作。');
  lines.push('- 不要用「在干啥」「还有人吗」「好安静啊」「都在忙吗」这类开场。');
  if (avoid && avoid.length) lines.push(`- 这几句最近在群里说过，换个说法：${avoid.map((t) => `「${t}」`).join('、')}`);
  lines.push('- 只输出这一句本身，不要引号、不要分条。');
  return lines.join('\n');
}

const LENSES = [
  '角度：接着上面「可以提的具体事」里最靠前的那一件往下问一句。',
  '角度：顺着「你自己最近写下的」里那个感觉说一句（不问他任何问题）。没有那段素材就只说一个念头或感叹。',
  '角度：提一个他一句话就能回答的小问题，问题必须落在具体的事上，不能是问候。',
];

async function buildSystem(W, config, target, isGroup) {
  const persona = (config && config.persona) || {};
  try {
    const res = await W.api('/api/debug/prompt', {
      method: 'POST',
      body: {
        text: '',
        senderId: isGroup ? '' : target.wxid,
        senderName: isGroup ? '' : (target.name || persona.ownerName || ''),
        chatType: isGroup ? 'group' : 'private',
      },
    });
    const system = res && res.body && res.body.system;
    if (res && res.ok && typeof system === 'string' && system.trim()) {
      return { system, source: 'official' };
    }
  } catch { /* 退回自拼 */ }
  // 降级：官方接口变了也不能不发，用配置里的人设拼一份最简的
  const bits = [
    String(persona.name || '').trim() ? `你叫${String(persona.name).trim()}。` : '',
    persona.age ? `你 ${persona.age} 岁。` : '',
    persona.job ? `你的职业是${persona.job}。` : '',
    persona.appearance ? `外貌：${persona.appearance}` : '',
    persona.personality ? `性格：${persona.personality}` : '',
    persona.background ? `背景：${persona.background}` : '',
    `你称呼对方为「${persona.ownerName || '主人'}」，对方是你最亲近的人。`,
    '说话像微信聊天，口语化，不用客服腔，不自我介绍，不说自己是 AI。',
  ].filter(Boolean);
  return { system: bits.join('\n'), source: 'fallback' };
}

async function generate(W, system, tail, settings, lens) {
  const raw = await W.model({
    system: `${system}\n\n${tail}${lens ? '\n\n' + lens : ''}`,
    turns: [{ role: 'user', content: '（现在没有新消息。按上面的要求，直接给出你要发的那一句。）' }],
    maxTokens: 300,
  });
  return typeof raw === 'string' ? raw : (raw && raw.text) || '';
}

/**
 * 生成候选并按「重复度 + 口头禅」打分选一条。
 * 评分越低越好；全部撞车时返回 null，宁可不发也不发一句重复的。
 */
const GROUP_LENSES = [
  '角度：接着群里最后聊的那个话题，往下问一句，让之前说话的人也能接。',
  '角度：抛一个大家都有共鸣的小事（这个点还不睡、明天要上班之类），不用点任何人。',
  '角度：一个轻量的开放问题，谁都能答一句，别问需要长篇回答的。',
];

const GROUP_CLICHE = /还有人|有人在|好安静|冒个泡|冒泡|都睡|都在忙|在吗|在干啥|有人在吗/;

/**
 * 生成候选并按「重复度 + 口头禅 + 催促语气」挑一条。
 * 群聊走另一套提示词：只用群里的聊天内容，不碰人物卡和日记。
 */
async function compose({ W, appData, config, target, card, chat, settings, now, session }) {
  const isGroup = Boolean(target.isGroup);
  const tz = tzOf(config);
  const systemPack = await buildSystem(W, config, target, isGroup);
  const herNames = herDisplayNames(config);
  const lastLines = (session.lastLines || []).slice(-8);
  const hadCare = Boolean(chat.lastCareTs);
  const answered = hadCare && chat.lastUserTs > chat.lastCareTs;
  const unanswered = hadCare && !answered ? Math.max(1, Number(session.streak) || 1) : 0;
  const idleMs = Math.max(0, now - (chat.lastUserTs || now));

  let tail;
  let anchors = [];
  let diary = '';
  if (isGroup) {
    tail = buildGroupTail({
      groupName: target.name,
      clock: clockOf(now, tz),
      weekday: weekdayOf(now, tz),
      part: partOfDay(now, tz),
      idleMs,
      recent: (chat.recent || []).slice(-8),
      lastCare: hadCare
        ? { text: chat.lastCareText, agoMs: Math.max(0, now - chat.lastCareTs) }
        : { text: '', agoMs: 0 },
      unanswered,
      avoid: lastLines.slice(-3),
    });
  } else {
    // 只有主人的私聊用她的日记；别人的私聊只用那个人自己的卡，避免把主人的私事说出去
    const allowDiary = settings.useDiary && target.kind === 'master';
    anchors = settings.useFacts ? pickAnchors(card, now) : [];
    diary = allowDiary ? readDiaryTail(appData, now) : '';
    tail = buildTail({
      config,
      ownerName: target.name || (config.persona && config.persona.ownerName) || '',
      clock: clockOf(now, tz),
      weekday: weekdayOf(now, tz),
      part: partOfDay(now, tz),
      idleMs,
      unanswered,
      lastCare: hadCare
        ? { text: chat.lastCareText, agoMs: Math.max(0, now - chat.lastCareTs) }
        : { text: '', agoMs: 0 },
      anchors,
      diary,
      avoid: lastLines.slice(-4),
    });
  }

  const wanted = settings.candidates;
  const lenses = isGroup
    ? GROUP_LENSES
    : ((!settings.askQuestions || unanswered >= 2) ? [LENSES[1]] : LENSES);
  const jobs = [];
  const errors = [];
  for (let i = 0; i < wanted; i += 1) {
    jobs.push(generate(W, systemPack.system, tail, settings, lenses[i % lenses.length])
      .catch((err) => { errors.push(String((err && err.message) || err).slice(0, 120)); return ''; }));
  }
  const raws = await Promise.all(jobs);

  const clicheRe = isGroup ? new RegExp(`${CLICHE.source}|${GROUP_CLICHE.source}`) : CLICHE;
  const scored = [];
  for (const raw of raws) {
    const text = cleanText(raw, settings.maxChars, herNames);
    if (!text || text.length < 6) continue;
    const sim = maxSimilarity(text, lastLines);
    const cliche = clicheRe.test(text) ? 1 : 0;
    const pressure = unanswered > 0 && PRESSURE.test(text) ? 1 : 0;
    scored.push({
      text, sim: Number(sim.toFixed(2)), cliche, pressure,
      score: Number((sim * 0.6 + cliche * 0.25 + pressure * 0.15).toFixed(3)),
    });
  }
  scored.sort((a, b) => a.score - b.score);
  return {
    candidates: scored,
    picked: scored.length ? scored[0] : null,
    anchors,
    diary,
    promptSource: systemPack.source,
    answered,
    unanswered,
    errors,
    tail,
  };
}

/* ------------------------------ 发送 ------------------------------ */

function readContacts(appData) {
  try {
    const cache = readJson(path.join(appData || '', 'contacts-cache.json'), null);
    return cache && Array.isArray(cache.items) ? cache.items : [];
  } catch {
    return [];
  }
}

/** 发一条，并把这句话写回她的上下文（否则对方回过来她不知道自己说过什么）。 */
async function sendNow(W, target, text) {
  const isGroup = Boolean(target.isGroup);
  const sent = await W.sendText(target.wxid, text, {
    name: target.name,
    chatType: isGroup ? 'group' : 'private',
  });
  const id = String((sent && sent.id) || '');
  let recorded = false;
  if (id) {
    try {
      const res = await W.api('/api/care/sent', {
        method: 'POST',
        body: { id, chat: target.wxid, text, group: isGroup },
      });
      recorded = Boolean(res && res.ok);
    } catch { /* 记账失败不影响已发出的消息 */ }
  }
  return { id, status: (sent && sent.status) || '', confirmed: Boolean(sent && sent.confirmed), recorded };
}

/** 新会话的初始状态 */
function initSession(chat, now, settings, isGroup) {
  const anchor = chat.lastUserTs || now;
  return {
    lastUserTs: anchor,
    nextAt: anchor + intervalMsFor(settings, isGroup),
    streak: 0,
    lastSentTs: 0,
    lastLines: [],
    lastReason: 'init',
  };
}

/** 群聊比私聊更克制：间隔拉长、每天更少。 */
const GROUP_INTERVAL = { factor: 1.6, minFloor: 45 };
const GROUP_MAX_PER_DAY = 2;
const GROUP_STREAK_CAP = 2;

function intervalMsFor(settings, isGroup) {
  if (!isGroup) return drawIntervalFor(settings.minIntervalMinutes, settings.maxIntervalMinutes);
  const min = Math.max(settings.minIntervalMinutes, GROUP_INTERVAL.minFloor);
  const max = Math.max(min + 30, Math.round(settings.maxIntervalMinutes * GROUP_INTERVAL.factor));
  return drawIntervalFor(min, max);
}

function drawIntervalFor(min, max) {
  const lo = Math.max(1, Math.round(min));
  const hi = Math.max(lo, Math.round(max));
  return (lo + crypto.randomInt(0, hi - lo + 1)) * 60000;
}

/**
 * 单个会话该不该开口。返回 {session, due, reason, note}。
 * 纯函数，不发送、不写盘，方便单测和试跑。
 */
function evaluateSession({ config, settings, session, chat, now, isGroup }) {
  const s = { ...session };
  const tz = tzOf(config);
  const today = dayKey(now, tz);

  // 用户说话了 → 计时器归零、未回复清零、重掷间隔，且这一轮不发
  if (chat.lastUserTs && chat.lastUserTs > (s.lastUserTs || 0)) {
    s.lastUserTs = chat.lastUserTs;
    s.streak = 0;
    s.nextAt = chat.lastUserTs + intervalMsFor(settings, isGroup);
    return { session: s, due: false, reason: 'user_spoke', note: '' };
  }

  const q = inQuiet(settings.quietRange, now, tz);
  if (q.quiet) {
    return { session: s, due: false, reason: 'quiet_hours', note: `${fmtClock(settings.quietRange.start)}~${fmtClock(settings.quietRange.end)}` };
  }

  const windows = settings.windowList || [];
  if (windows.length && !inWindows(minutesOfDay(now, tz), windows)) {
    return {
      session: s, due: false, reason: 'out_of_window',
      note: windows.map((w) => `${fmtClock(w.start)}~${fmtClock(w.end)}`).join('、'),
    };
  }

  // 读不到会话流水（别的版本换了存储布局）时，不能靠未回复计数停手，否则会永久沉默
  const cap = isGroup ? GROUP_STREAK_CAP : settings.maxUnanswered;
  if (chat.ok !== false && cap > 0 && (s.streak || 0) >= cap) {
    return { session: s, due: false, reason: 'unanswered_cap', note: `连续 ${s.streak} 次没被回` };
  }

  if (!s.nextAt) s.nextAt = now + intervalMsFor(settings, isGroup);
  if (now < s.nextAt) {
    return { session: s, due: false, reason: 'too_soon', note: `还差 ${fmtDelta(s.nextAt - now)}` };
  }

  return { session: s, due: true, reason: 'due', note: `沉默了 ${fmtDelta(now - (chat.lastUserTs || now))}` };
}

/* ------------------------------ 发给谁 ------------------------------ */

/** 复刻官方 sendDenial：只认「静音会话」，支持 * 通配和群名匹配。 */
function denied(config, { id, names = [], isGroup = false }) {
  const key = String(id || '').trim().toLowerCase();
  const muted = (config && config.group && config.group.mutedGroups) || [];
  if (!Array.isArray(muted) || !muted.length) return '';
  for (const value of muted) {
    const entry = String(value || '').trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return 'muted';
    if (key && key === entry) return 'muted';
    if (isGroup && names.some((name) => name && String(name).trim().toLowerCase() === entry)) return 'muted';
  }
  return '';
}

/**
 * 主动搭话的收件人集合。完全按官方语义走：
 *   care.whitelist 决定名单，allowOthers / allowGroups / onlyMaster 决定取舍，
 *   group.mutedGroups 里的会话一律跳过。
 * 文件传输助手不主动找（官方会带上，这里刻意去掉）。
 */
function careTargets(config, appData) {
  const care = (config && config.care) || {};
  const raw = care.whitelist;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\n,;，；\s]+/);
  const whitelist = [...new Set(list.map((v) => String(v || '').trim()).filter(Boolean))];
  const items = readContacts(appData);
  const masterWhitelist = ((config.persona && config.persona.master && config.persona.master.wxids) || [])
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const onlyMaster = Object.hasOwn(care, 'onlyMaster') ? care.onlyMaster !== false : care.allowOthers !== true;
  const allowOthers = care.allowOthers === true;
  const allowGroups = care.allowGroups === true;

  const out = [];
  for (const wxid of whitelist) {
    if (wxid.toLowerCase() === 'filehelper') continue;
    const hit = items.find((it) => it && it.wxid === wxid) || null;
    const isGroup = /@chatroom$/i.test(wxid) || Boolean(hit && hit.isGroup);
    const name = String((hit && (hit.label || hit.remark || hit.name)) || wxid);
    if (denied(config, { id: wxid, names: [name, hit && hit.name, hit && hit.remark], isGroup })) continue;
    const isMaster = !isGroup && masterWhitelist.includes(wxid);
    if (onlyMaster && !isMaster) continue;
    if (isGroup ? !allowGroups : (!isMaster && !allowOthers)) continue;
    out.push({
      wxid,
      name,
      isGroup,
      kind: isGroup ? 'group' : (isMaster ? 'master' : 'other'),
      chatId: isGroup ? `wechat:g:${wxid}` : `wechat:u:${wxid}`,
    });
  }
  const rank = (t) => (t.kind === 'master' ? 0 : t.kind === 'other' ? 1 : 2);
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}

function newState(now) {
  return { schemaVersion: SCHEMA, startedAt: now, day: '', sentToday: 0, sessions: {}, lastReason: 'init', groupSentToday: 0 };
}

/* ------------------------------ 钩子 ------------------------------ */

async function appDataOf(W) {
  const paths = (W && W.paths) || {};
  return String(paths.appData || process.env.WHALE_APPDATA || '').trim();
}

async function loadConfig(W) {
  try {
    const res = await W.api('/api/config');
    if (res && res.ok && res.body && res.body.config) return res.body.config;
  } catch { /* 退回读文件 */ }
  const appData = await appDataOf(W);
  return readJson(path.join(appData, 'config.json'), {});
}

/* ------------------------------ 接管官方 care ------------------------------ */

function flagPath(W) {
  const dir = String((W && W.paths && W.paths.pluginData) || '').trim();
  return dir ? path.join(dir, 'takeover.json') : '';
}

function readFlag(W) {
  const file = flagPath(W);
  if (!file) return {};
  try {
    return readJson(file, {}) || {};
  } catch {
    return {};
  }
}

function writeFlag(W, value) {
  const file = flagPath(W);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  } catch { /* 写不了就算了，下次 tick 再说 */ }
}

/**
 * 官方 care 还开着就关掉：插件存在的意义就是替代它，两条链路同时发会重复。
 * 主人手动点过「恢复官方」（pause=true）时不再自动关，直到再点「接管」。
 */
async function enforceTakeover(W, config) {
  const flag = readFlag(W);
  if (flag.pause) return { taken: false, reason: 'paused' };
  if (!(config && config.care && config.care.enabled)) return { taken: false, reason: 'already_off' };
  try {
    const res = await W.api('/api/config', { method: 'POST', body: { patch: { care: { enabled: false } } } });
    const ok = Boolean(res && res.ok);
    writeFlag(W, { pause: false, at: Date.now(), ok, byUs: ok });
    return { taken: ok, reason: ok ? 'disabled_official_care' : 'patch_failed' };
  } catch (err) {
    return { taken: false, reason: 'patch_error', error: String((err && err.message) || err).slice(0, 120) };
  }
}

exports.hooks = {
  async 'app.start'(ctx) {
    const W = sdk(ctx);
    const config = await loadConfig(W);
    const appData = await appDataOf(W);
    const settings = settingsOf(ctx, config);
    // 上一次若是因为生成失败而交还官方，这次启动说明代码或网络已换新，重新接管
    const flag = readFlag(W);
    if (flag.pause && flag.reason === 'generate_failed') {
      writeFlag(W, { pause: false, at: Number(ctx.now) || Date.now(), byUs: false, resumedFrom: 'generate_failed' });
    }
    const takeover = await enforceTakeover(W, config);
    const targets = careTargets(config, appData);
    const st = newState(Number(ctx.now) || Date.now());
    st.takeover = takeover;
    st.bootNote = `启动：静默 ${settings.bootSilentMinutes} 分钟后才可能开口`;
    st.targets = targets.map((t) => `${t.kind}:${t.name}`);
    if (!targets.length) st.error = 'no_target';
    return { state: st };
  },

  async 'timer.tick'(ctx) {
    const W = sdk(ctx);
    const now = Number(ctx.now) || Date.now();
    const config = await loadConfig(W);
    const appData = await appDataOf(W);
    const settings = settingsOf(ctx, config);
    // 主人可能在官方页面把 care 又打开了：每次检查都兜底关一次
    const takeover = await enforceTakeover(W, config);

    let state = ctx.state || {};
    if (!state.schemaVersion || state.schemaVersion !== SCHEMA || !state.sessions) state = newState(now);
    if (!state.startedAt) state.startedAt = now;

    const tz = tzOf(config);
    const today = dayKey(now, tz);
    state = { ...state };
    if (state.day !== today) { state.day = today; state.sentToday = 0; state.groupSentToday = 0; }

    const targets = careTargets(config, appData);
    if (!targets.length) {
      return { state: { ...state, lastReason: 'no_target', lastCheckAt: now, takeover: takeover.reason } };
    }

    if (settings.bootSilentMinutes > 0 && now - state.startedAt < settings.bootSilentMinutes * 60000) {
      return { state: { ...state, lastReason: 'boot_silent', lastCheckAt: now, takeover: takeover.reason } };
    }

    // 每个会话独立判定
    const sessions = {};
    const dueList = [];
    for (const target of targets) {
      const chat = inspectChat(appData, target.chatId, target.isGroup ? 8 : 0);
      const prev = (state.sessions && state.sessions[target.chatId]) || initSession(chat, now, settings, target.isGroup);
      const decided = evaluateSession({ config, settings, session: prev, chat, now, isGroup: target.isGroup });
      sessions[target.chatId] = { ...decided.session, lastReason: decided.reason };
      if (decided.due) {
        dueList.push({
          target, chat, session: decided.session, note: decided.note,
          overdue: now - (decided.session.nextAt || now),
        });
      }
    }

    if (!dueList.length) {
      return { state: { ...state, sessions, lastReason: 'not_due', lastCheckAt: now, takeover: takeover.reason } };
    }

    // 每日总上限（和官方一致，全局算）
    if (settings.maxPerDay > 0 && (state.sentToday || 0) >= settings.maxPerDay) {
      return { state: { ...state, sessions, lastReason: 'daily_cap', lastCheckAt: now, takeover: takeover.reason } };
    }

    // 一次只发一条，避免几个会话同时刷屏；其余留到下一个 tick
    dueList.sort((a, b) => b.overdue - a.overdue);
    const picked = dueList.find((d) => !d.target.isGroup || (state.groupSentToday || 0) < GROUP_MAX_PER_DAY);
    if (!picked) {
      return { state: { ...state, sessions, lastReason: 'group_cap', lastCheckAt: now, takeover: takeover.reason } };
    }

    const { target, chat } = picked;
    const session = sessions[target.chatId];
    const card = target.isGroup ? null : readCard(appData, target.chatId, target.wxid);

    let result;
    try {
      result = await compose({ W, appData, config, target, card, chat, settings, now, session });
    } catch (err) {
      return { state: handBack(W, state, sessions, now, String((err && err.message) || err)) };
    }
    if (!result.picked) {
      const errors = (result.errors || []).filter(Boolean);
      if (!errors.length) {
        // 模型正常返回但没一句能用：换下一个时间点，不计失败
        sessions[target.chatId] = { ...session, nextAt: now + intervalMsFor(settings, target.isGroup), lastReason: 'no_candidate' };
        return { state: { ...state, sessions, lastReason: 'no_candidate', lastCheckAt: now, takeover: takeover.reason } };
      }
      return { state: handBack(W, state, sessions, now, String(errors[0])) };
    }
    // 全都和最近说过的高度相似：宁可这轮不发，也不重复
    if (result.picked.sim > 0.8) {
      sessions[target.chatId] = { ...session, nextAt: now + intervalMsFor(settings, target.isGroup), lastReason: 'too_similar' };
      return { state: { ...state, sessions, lastReason: 'too_similar', lastCheckAt: now, takeover: takeover.reason } };
    }

    const text = result.picked.text;
    let delivery;
    try {
      delivery = await sendNow(W, target, text);
    } catch (err) {
      sessions[target.chatId] = { ...session, lastReason: 'send_failed' };
      return {
        state: {
          ...state, sessions, lastReason: 'send_failed', lastCheckAt: now,
          lastError: String((err && err.message) || err).slice(0, 120), takeover: takeover.reason,
        },
      };
    }

    // 上一次开口之后对方有没有回过：以流水里最后一条 user / care 消息的先后为准
    const hadCare = Boolean(chat.lastCareTs);
    const answered = hadCare && chat.lastUserTs > chat.lastCareTs;
    const streak = chat.ok === false
      ? 0
      : hadCare
        ? (answered ? 0 : Math.max(0, Number(session.streak) || 0) + 1)
        : 0;

    sessions[target.chatId] = {
      ...session,
      lastSentTs: now,
      nextAt: now + intervalMsFor(settings, target.isGroup),
      streak,
      lastLines: (session.lastLines || []).concat([text]).slice(-8),
      lastText: text,
      lastDelivery: delivery,
      lastReason: 'sent',
    };

    return {
      state: {
        ...state,
        sessions,
        sentToday: (state.sentToday || 0) + 1,
        groupSentToday: (state.groupSentToday || 0) + (target.isGroup ? 1 : 0),
        lastCheckAt: now,
        lastReason: 'sent',
        lastTarget: `${target.kind}:${target.name}`,
        lastText: text,
        genFailStreak: 0,
        genFailSince: 0,
        takeover: takeover.reason,
      },
    };
  },

  async 'app.stop'(ctx) {
    const W = sdk(ctx);
    const flag = readFlag(W);
    let restored = false;
    // 只还原「我们自己关掉的那一次」：别人本来关着的，不动。
    // 宿主给 app.stop 的预算只有 300ms，所以这里只用一次本地 PATCH，失败就算。
    if (flag.byUs) {
      try {
        const res = await W.api('/api/config', { method: 'POST', body: { patch: { care: { enabled: true } } } });
        restored = Boolean(res && res.ok);
        if (restored) writeFlag(W, { pause: false, at: Date.now(), byUs: false });
      } catch { /* 撤权或超时都无所谓，下次启用会重新接管 */ }
    }
    return { state: { ...(ctx.state || {}), stoppedAt: Number(ctx.now) || Date.now(), restoredOfficialCare: restored } };
  },

  async 'tool.run'(ctx) {
    const W = sdk(ctx);
    const input = (ctx.input && typeof ctx.input === 'object') ? ctx.input : {};
    const action = String(input.action || 'dry-run');
    const config = await loadConfig(W);
    const now = Number(ctx.now) || Date.now();
    const appData = await appDataOf(W);
    const settings = settingsOf(ctx, config);
    const targets = careTargets(config, appData);

    if (action === 'takeover' || action === 'restore') {
      const toOfficial = action === 'restore';
      // restore 之后必须记一个 pause，否则下一次 tick 又会把官方 care 关掉
      writeFlag(W, { pause: toOfficial, at: now });
      try {
        const res = await W.api('/api/config', { method: 'POST', body: { patch: { care: { enabled: toOfficial } } } });
        return {
          ok: Boolean(res && res.ok), action,
          careEnabled: toOfficial,
          note: toOfficial ? '官方 care 已临时恢复，插件下次 tick 不会再关它；点 takeover 交回来' : '已接管：官方 care 关闭，由插件负责主动搭话',
        };
      } catch (err) {
        return { ok: false, action, error: String((err && err.message) || err).slice(0, 160) };
      }
    }

    if (action === 'status') {
      const sessions = {};
      for (const t of targets) {
        const chat = inspectChat(appData, t.chatId, 0);
        const s = (ctx.state && ctx.state.sessions && ctx.state.sessions[t.chatId]) || null;
        sessions[t.name] = {
          kind: t.kind,
          wxid: t.wxid,
          lastUserAt: chat.lastUserTs ? new Date(chat.lastUserTs).toISOString() : null,
          lastCareText: chat.lastCareText,
          streak: s ? s.streak || 0 : 0,
          nextAt: s && s.nextAt ? new Date(s.nextAt).toISOString() : null,
          lastReason: s ? s.lastReason : 'not_yet',
          lastLines: s ? s.lastLines || [] : [],
        };
      }
      return {
        ok: true,
        action,
        builtinCareEnabled: Boolean(config.care && config.care.enabled),
        autoTakeoverPaused: Boolean(readFlag(W).pause),
        targetCount: targets.length,
        targets: targets.map((t) => ({ kind: t.kind, name: t.name, wxid: t.wxid })),
        sessions,
        sentToday: (ctx.state && ctx.state.sentToday) || 0,
        groupSentToday: (ctx.state && ctx.state.groupSentToday) || 0,
        settingsText: describeSettings(settings),
        settings,
        rawSettings: (ctx && ctx.settings) || {},
      };
    }

    if (!targets.length) {
      return {
        ok: false,
        error: '官方白名单里没有可发的人。去「主动搭话」页把私聊或群加进白名单；只发主人时检查 onlyMaster。',
        builtinCareEnabled: Boolean(config.care && config.care.enabled),
      };
    }

    // 默认：试跑。只生成，不发送，不动定时状态。
    const want = String(input.target || input.mode || '').trim();
    const target = targets.find((t) => t.wxid === want || t.kind === want || (want === 'group' && t.isGroup) || (want === 'private' && !t.isGroup)) || targets[0];
    const count = int(input.count, settings.candidates, 1, 6);
    const chat = inspectChat(appData, target.chatId, target.isGroup ? 8 : 0);
    const card = target.isGroup ? null : readCard(appData, target.chatId, target.wxid);
    const session = (ctx.state && ctx.state.sessions && ctx.state.sessions[target.chatId]) || initSession(chat, now, settings, target.isGroup);
    const preview = {
      ...session,
      streak: input.streak === undefined ? (session.streak || 0) : int(input.streak, 0, 0, 20),
    };

    const result = await compose({
      W, appData, config, target, card, chat,
      settings: { ...settings, candidates: count },
      now,
      session: preview,
    });
    const decided = evaluateSession({ config, settings, session: preview, chat, now, isGroup: target.isGroup });

    return {
      ok: true,
      action: 'dry-run',
      sent: false,
      target: { kind: target.kind, name: target.name, wxid: target.wxid, isGroup: target.isGroup },
      builtinCareEnabled: Boolean(config.care && config.care.enabled),
      settingsText: describeSettings(settings),
      wouldSendNow: decided.due,
      reason: decided.reason,
      promptSource: result.promptSource,
      anchorCount: result.anchors.length,
      answered: result.answered,
      unanswered: result.unanswered,
      errors: result.errors,
      candidates: result.candidates,
      picked: result.picked,
      tail: result.tail,
    };
  },
};

/** 连续生成失败：连着三次就交还官方 care，别让主人一条消息都收不到 */
function handBack(W, state, sessions, now, message) {
  const fails = (Number(state.genFailStreak) || 0) + 1;
  const since = Number(state.genFailSince) || now;
  // 短暂 503 不该把话筒交出去：要连续 4 次、且横跨 20 分钟以上
  const giveUp = fails >= 4 && now - since >= 20 * 60000;
  const next = {
    ...state,
    sessions,
    genFailStreak: fails,
    genFailSince: since,
    lastReason: giveUp ? 'handed_back_to_official' : 'generate_failed',
    lastError: String(message || '').slice(0, 120),
    lastCheckAt: now,
  };
  if (giveUp) {
    writeFlag(W, { pause: true, at: now, reason: 'generate_failed' });
    try {
      W.api('/api/config', { method: 'POST', body: { patch: { care: { enabled: true } } } });
    } catch { /* 交还失败也没别的办法 */ }
    next.genFailStreak = 0;
    next.genFailSince = 0;
  }
  return next;
}

exports._internal = {
  DEFAULTS,
  careToSettings,
  settingsOf,
  parseSettingsInput,
  parseWindowsOf,
  canonicalKey,
  describeSettings,
  pickAnchors,
  careTargets,
  denied,
  evaluateSession,
  initSession,
  inspectChat,
  cleanText,
  similarity,
  maxSimilarity,
  CLICHE,
  PRESSURE,
  GROUP_CLICHE,
  parseQuiet,
  buildTail,
  buildGroupTail,
  intervalMsFor,
  intervalMsFor,
  herDisplayNames,
  enforceTakeover,
  readFlag,
  writeFlag,
  readDiaryTail,
  compose,
};
