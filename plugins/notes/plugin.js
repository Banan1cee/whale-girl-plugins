'use strict';
/**
 * 鲸鲸随手记 · notes
 * 宿主：鲸鲸 4.1.2 / Api 4 · kind=message · hooks=[chat.generate]
 *
 * 命令：
 *   /record <内容>    记一条，按内容自动归类，同时记下是谁记的
 *   /read [条件]      读回来：最近 / 今天 / 类别 / 关键词 / 第 N 条
 *   /delete [条件]    删记录：搜出来列编号，回编号删；/delete undo 撤销
 *   /whoami           探测宿主到底把哪些字段交给了插件（配 wxid 用）
 *
 * 作用范围被写死在插件数据目录的 note/ 下：命令不接受任何路径参数，
 * 拼接的文件名全部来自内部固定的类别枚举，聊天内容进不了路径。
 *
 * 记录人（by）的取法见 senderOf()：宿主是否提供 wxid 尚无实证，
 * voice-tone 的注释明说插件只拿得到内部会话 id。所以这里按常见字段名
 * 多路探测，并记下 byKind 说明这一条到底取自哪类字段，方便以后校正。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const P = IS_WIN ? path.win32 : path.posix;

const MAX_TEXT = 14000;
const DEFAULT_MAX_ITEM = 5000;
const MAX_ITEMS = 5000;
const DEFAULT_READ_LIMIT = 10;
const PICK_TTL_MS = 60 * 1000;
const UNDO_TTL_MS = 24 * 60 * 60 * 1000;   // 撤销窗口放一整天，误删隔一会儿也能回来

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const MENTION_ALL = /[@＠][\s\u200B-\u200D\u2060\uFEFF]*(?:(?:所有人|全体成员)|all(?![\p{L}\p{N}.]))/giu;

function str(value, fallback) {
  if (value === undefined || value === null) return fallback === undefined ? '' : fallback;
  return String(value);
}

function int(value, fallback, min, max) {
  const n = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', '开'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', '关'].includes(s)) return false;
  return fallback;
}

function sanitize(text, cap) {
  let out = String(text === undefined || text === null ? '' : text).replace(UNSAFE, '').replace(MENTION_ALL, '@大家');
  out = out.trim();
  const limit = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Number(cap) : MAX_TEXT;
  if (out.length > limit) out = out.slice(0, limit - 1) + '…';
  return out;
}

/* ------------------------------------------------------------------ */
/* 长文本分段与补发                                                    */
/* ------------------------------------------------------------------ */

/**
 * 宿主对 chat.generate 返回的 text 上限是 16000，微信单条更是只有两三千字。
 * 超过这个量必然被截断，所以读长内容时要切成多条发。
 */
const DEFAULT_CHUNK = 1200;
const MAX_EXTRA_SEGMENTS = 8;
const SEND_GAP_MS = 250;

/** 宿主 SDK。拿不到就退回只发第一段。 */
let whaleSdk = null;
try { whaleSdk = require('whale'); } catch (_) { whaleSdk = null; }

/**
 * 按行切，找不到合适的行再按句末切，最后才硬切。
 * 硬切会把一行字劈成两半，尽量不走那条路。
 */
function splitText(text, limit) {
  const cap = Number.isFinite(Number(limit)) && Number(limit) >= 200 ? Number(limit) : DEFAULT_CHUNK;
  const source = String(text === undefined || text === null ? '' : text);
  if (source.length <= cap) return [source];
  const out = [];
  let rest = source;
  let guard = 0;
  while (rest.length > cap && guard < 200) {
    guard += 1;
    let cut = rest.lastIndexOf('\n', cap);
    if (cut < cap * 0.5) {
      cut = -1;
      for (const mark of ['。', '！', '？', '；', '…', '.', '!', '?', ';']) {
        const at = rest.lastIndexOf(mark, cap);
        if (at > cut) cut = at;
      }
      if (cut >= 0) cut += 1;
    }
    if (cut <= 0) cut = cap;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/** 找可用于补发消息的会话 id。宿主给什么用什么。 */
function chatIdOf(input) {
  const msg = (input && input.message) || {};
  for (const field of ['chatId', 'conversationId', 'roomId', 'sessionId', 'session', 'talker', 'chat']) {
    const value = msg[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * 把剩余分段依次补发出去。
 *
 * 返回实际发出的段数。任何一段失败就停下，让调用方把剩下的转成翻页提示，
 * 免得发一半丢一半，用户不知道到哪了。
 */
async function pushRemaining(segments, input, cfg) {
  if (!segments || !segments.length) return 0;
  if (!whaleSdk || typeof whaleSdk.sendText !== 'function') return 0;
  const chatId = chatIdOf(input);
  if (!chatId) return 0;
  const chatType = (input && input.message && input.message.chatType) || 'private';
  const queue = segments.slice(0, MAX_EXTRA_SEGMENTS);
  let sent = 0;
  for (const segment of queue) {
    try {
      await whaleSdk.sendText(chatId, sanitize(segment, cfg.chunkChars), { chatType });
      sent += 1;
    } catch (_) {
      break;
    }
    if (sent < queue.length) await new Promise(resolve => setTimeout(resolve, SEND_GAP_MS));
  }
  return sent;
}

function mergeState(input, patch) {
  return Object.assign({}, (input && input.state) || {}, patch || {});
}

function pad2(n) {
  return String(n).length < 2 ? '0' + n : String(n);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return hm;
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm;
}

/**
 * 写进 md 的时间一律用完整日期。
 *
 * md 只在有新记录时才重写，是个静态快照。若沿用 fmtTime 的「今天只显示时分」，
 * 今天写进去的 17:03 明天打开还是 17:03，看的人无从判断是哪天。
 * 实时输出（/read）才适合用相对格式。
 */
function fmtTimeAbs(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function oneLine(text, limit) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}

function shortId(value) {
  const s = String(value === undefined || value === null ? '' : value).trim();
  if (!s) return '';
  return s.length > 18 ? s.slice(0, 18) + '…' : s;
}

/* ------------------------------------------------------------------ */
/* 记录人：宿主给了什么就用什么                                        */
/* ------------------------------------------------------------------ */

/** 可能是 wxid 的字段，按可靠性从高到低排。talker 群里通常是群 id，放最后。 */
const WXID_FIELDS = [
  'wxid', 'Wxid', 'WXID', 'wxId',
  'senderWxid', 'fromWxid', 'senderWXID',
  'senderId', 'memberWxid', 'fromUser', 'sender', 'from',
  'talker',
];
/** 只可能是昵称的字段。 */
const NICK_FIELDS = ['nickname', 'nickName', 'senderName', 'displayName', 'name'];

/** 群 id 的特征：微信里以 @chatroom 结尾。它代表一个群，不代表某个人。 */
function isRoomId(value) {
  return /@chatroom$/i.test(String(value === undefined || value === null ? '' : value).trim());
}

/**
 * 取这条消息是谁发的。
 *
 * 没有任何文档保证宿主会交出 wxid，voice-tone 的注释甚至说只给内部会话 id。
 * 所以这里按字段名多路探测：先找像 wxid 的，再找昵称，最后退到会话 id。
 * byKind 会跟着记录一起存下来，日后确认了真实字段就知道哪批数据要迁移。
 */
function senderOf(input) {
  const msg = (input && input.message) || {};

  for (const field of WXID_FIELDS) {
    const value = msg[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    // 群里 talker 之类给的可能是群 id，它不代表某个人，跳过继续找
    if (isRoomId(value)) continue;
    return { id: value.trim(), kind: 'wxid', field };
  }
  for (const field of NICK_FIELDS) {
    const value = msg[field];
    if (typeof value === 'string' && value.trim()) {
      return { id: value.trim(), kind: 'nick', field };
    }
  }
  // 退而求其次：会话 id。至少能区分「谁在哪记的」。
  for (const field of ['chatId', 'conversationId', 'roomId', 'sessionId', 'session']) {
    const value = msg[field];
    if (typeof value === 'string' && value.trim()) {
      return { id: value.trim(), kind: 'session', field };
    }
  }
  for (const field of WXID_FIELDS) {
    const value = (input || {})[field];
    if (typeof value === 'string' && value.trim()) {
      return { id: value.trim(), kind: 'wxid', field: 'input.' + field };
    }
  }
  return { id: '', kind: 'unknown', field: '' };
}

function byKindLabel(kind) {
  if (kind === 'wxid') return 'wxid';
  if (kind === 'nick') return '昵称，宿主没给 wxid';
  if (kind === 'session') return '会话 id，宿主没给 wxid';
  return '未知，宿主没给任何身份字段';
}

/* ------------------------------------------------------------------ */
/* 位置：只有 note/ 一个目录                                          */
/* ------------------------------------------------------------------ */

function noteDir(input, cfg) {
  const sdk = (input && (input.whale || input.host)) || {};
  const base = sdk.paths && typeof sdk.paths.pluginData === 'string' ? sdk.paths.pluginData : '';
  const configured = str(cfg && cfg.noteDir).trim();
  const fallbackBase = base || os.tmpdir();
  if (!configured) return P.join(fallbackBase, 'note');
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(configured)) return P.resolve(configured);
  return P.join(fallbackBase, configured);
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 分类                                                               */
/* ------------------------------------------------------------------ */

/**
 * 分类优先级（先命中先定）：
 * 账目最前，因为「花了 38 元」这类金额特征是硬证据，比「买」「记得」这种动词靠谱；
 * 待办其次，行动信号强；再往下才是链接、代码、想法，最后兜到笔记。
 */
const CATS = [
  {
    key: 'money', name: '账目', file: 'money.md',
    words: ['花了', '支出', '收入', '账单', '报销', '工资', '付款', '转账', '退款', '¥', '￥'],
    pattern: /\d+\s*(?:元|块|万元|k\b)/i,
  },
  {
    key: 'todo', name: '待办', file: 'todos.md',
    words: ['待办', '要做', '记得', '别忘', '明天', '后天', '下周', '任务', '提醒我', '截止', 'ddl', 'todo', '买', '去办', '联系'],
  },
  {
    key: 'link', name: '链接', file: 'links.md',
    pattern: /https?:\/\/\S+|www\.\S+|\bb23\.tv\/\S+|\bgithub\.com\/\S+/i,
  },
  {
    key: 'code', name: '代码', file: 'code.md',
    pattern: /```|^\s{2,}(?:function|const|let|var|def|class|import|from|public|private|return|if|for)\b|^\s*(?:function|const|let|var|def|class|import|from)\s+[\w$]|\bconsole\.log\(|\bprint\(/m,
  },
  {
    key: 'idea', name: '想法', file: 'ideas.md',
    words: ['想法', '灵感', '点子', '突然想到', '思路', '构思', '如果做个'],
  },
  {
    key: 'memo', name: '笔记', file: 'memo.md',
  },
];

const CAT_BY_KEY = {};
const CAT_BY_NAME = {};
for (const cat of CATS) {
  CAT_BY_KEY[cat.key] = cat;
  CAT_BY_NAME[cat.name] = cat;
}

function classify(text) {
  const lower = String(text).toLowerCase();
  for (const cat of CATS) {
    if (cat.words) {
      for (const word of cat.words) {
        if (lower.indexOf(String(word).toLowerCase()) >= 0) return cat;
      }
    }
    if (cat.pattern && cat.pattern.test(text)) return cat;
  }
  return CAT_BY_KEY.memo;
}

/* ------------------------------------------------------------------ */
/* 索引读写                                                            */
/* ------------------------------------------------------------------ */

function indexPath(dir) {
  return P.join(dir, 'index.json');
}

function loadIndex(dir) {
  const file = indexPath(dir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.items)) {
      return {
        ok: true,
        version: 1,
        items: parsed.items.filter(item => item && typeof item.text === 'string'),
      };
    }
  } catch (_) { /* 不存在或坏了 */ }
  try {
    if (fs.existsSync(file)) fs.renameSync(file, P.join(dir, 'index.broken-' + Date.now() + '.json'));
  } catch (_) { /* ignore */ }
  return { ok: false, version: 1, items: [] };
}

function saveIndex(dir, index) {
  const file = indexPath(dir);
  const body = JSON.stringify({ version: 1, items: index.items }, null, 1);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (_) {
    fs.writeFileSync(file, body, 'utf8');
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

/** 把某一类重新导出成 md，最新的排最前。已删除的不导出。 */
function renderCatFile(dir, cat, items) {
  const mine = items
    .filter(item => item.cat === cat.key && !item.deleted)
    .slice()
    .sort((a, b) => b.ts - a.ts);
  const lines = ['# ' + cat.name, '', '共 ' + mine.length + ' 条，最新在上。', ''];
  for (const item of mine) {
    // md 是本地文件，wxid 写全，方便对着人；列表里才需要截断
    const who = item.by ? ' · by ' + item.by : '';
    lines.push('## ' + fmtTimeAbs(item.ts) + who);
    lines.push('');
    lines.push(item.text.trim());
    lines.push('');
  }
  const file = P.join(dir, cat.file);
  try {
    const body = lines.join('\n');
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (old === body) return;
    fs.writeFileSync(file, body, 'utf8');
  } catch (_) { /* 导出失败不影响索引 */ }
}

function renderAll(dir, items) {
  for (const cat of CATS) renderCatFile(dir, cat, items);
}

/* ------------------------------------------------------------------ */
/* 记录归属                                                           */
/* ------------------------------------------------------------------ */

/**
 * 只取属于某个人的记录。
 *
 * /read 和 /delete 都只看自己的，不设主人、不设白名单。归属就是记录里的 by：
 * 多人共用一个机器人时天然隔离，谁也读不到别人的东西。
 * 拿不到身份标识时返回空，宁可读不到也不要混在一起。
 */
function ownedItems(index, me) {
  const key = str(me).trim();
  if (!key) return [];
  return index.items
    .filter(item => !item.deleted && str(item.by).trim() === key)
    .sort((a, b) => b.ts - a.ts);
}

const NO_IDENTITY = '没拿到你的身份标识，分不清哪些记录是你的。\n发 /whoami 看看宿主给了哪些字段，把结果发我。';

/* ------------------------------------------------------------------ */
/* 筛选：/read 和 /delete 共用                                         */
/* ------------------------------------------------------------------ */

const RANGE_TODAY = ['今天', '今日', 'today'];
const RANGE_YESTERDAY = ['昨天', '昨日', 'yesterday'];
const RANGE_WEEK = ['本周', '这周', '一周', 'week'];

function startOfDay(daysAgo) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (daysAgo || 0));
  return d.getTime();
}

function matchCat(word) {
  const w = String(word).trim().toLowerCase();
  for (const cat of CATS) {
    if (cat.key === w || cat.name === word.trim()) return cat;
  }
  if (w === '钱' || w === '账') return CAT_BY_KEY.money;
  if (w === 'todo') return CAT_BY_KEY.todo;
  if (w === 'memo' || w === 'note') return CAT_BY_KEY.memo;
  return null;
}

/**
 * 按条件筛。返回 { items, label } 或 { error }。
 * 纯数字不在这里处理，由调用方各自决定是「读第 N 条」还是「删列表第 N 条」。
 */
function filterItems(items, query) {
  const q = String(query || '').trim();

  for (const word of RANGE_TODAY) {
    if (q === word) {
      return { items: items.filter(item => item.ts >= startOfDay(0)), label: '今天' };
    }
  }
  for (const word of RANGE_YESTERDAY) {
    if (q === word) {
      const since = startOfDay(1);
      const until = startOfDay(0);
      return { items: items.filter(item => item.ts >= since && item.ts < until), label: '昨天' };
    }
  }
  for (const word of RANGE_WEEK) {
    if (q === word) {
      const since = Date.now() - 7 * 24 * 3600 * 1000;
      return { items: items.filter(item => item.ts >= since), label: '最近七天' };
    }
  }

  const asCat = matchCat(q);
  if (asCat) {
    return { items: items.filter(item => item.cat === asCat.key), label: asCat.name };
  }

  const words = q.split(/[\s\u3000]+/).filter(Boolean);
  if (!words.length) return { items, label: '最近' };
  const hits = items.filter(item => {
    const hay = item.text.toLowerCase() + ' ' + str(item.by).toLowerCase();
    return words.every(w => hay.indexOf(w.toLowerCase()) >= 0);
  });
  return { items: hits, label: '「' + q + '」' };
}

/* ------------------------------------------------------------------ */
/* /record                                                            */
/* ------------------------------------------------------------------ */

function doRecord(input, cfg, raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return { text: '用法：/record 要记的内容。\n例：/record 明天下午三点跟客户开会' };
  }
  if (text.length > cfg.maxItemChars) {
    return {
      text: '这条 ' + text.length + ' 字，超过单条上限 ' + cfg.maxItemChars + ' 字。'
        + '拆成几条记，或者精简一下。',
    };
  }

  const dir = noteDir(input, cfg);
  if (!ensureDir(dir)) return { text: '建不了 note 目录，检查插件数据目录的写权限。' };

  const index = loadIndex(dir);
  const cat = classify(text);
  const sender = senderOf(input);

  const today = new Date().toDateString();
  const dup = index.items.find(item => !item.deleted
    && item.text.trim() === text
    && str(item.by) === sender.id
    && new Date(item.ts).toDateString() === today);
  if (dup) {
    return { text: '这条今天已经记过了（' + fmtTime(dup.ts) + '，在「' + cat.name + '」里），没重复记。' };
  }

  const now = Date.now();
  const item = {
    id: 'n' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    ts: now,
    cat: cat.key,
    text,
    by: sender.id,
    byKind: sender.kind,
  };
  index.items.push(item);
  if (index.items.length > MAX_ITEMS) index.items = index.items.slice(index.items.length - MAX_ITEMS);

  try {
    saveIndex(dir, index);
  } catch (e) {
    return { text: '写索引失败（' + (e && e.code ? e.code : 'unknown') + '），这条没记上。' };
  }
  renderAll(dir, index.items);

  const mine = ownedItems(index, sender.id);
  const todayCount = mine.filter(i => new Date(i.ts).toDateString() === today).length;
  const lines = [
    '已记到「' + cat.name + '」' + cat.file,
    oneLine(text, 80),
    '你今天 ' + todayCount + ' 条，你的合计 ' + mine.length + ' 条。',
  ];
  if (sender.kind === 'unknown') {
    lines.push('（没拿到你的 wxid，这条会归到「未知」，你自己也可能读不到。发 /whoami 看宿主给了哪些字段）');
  }
  return { text: lines.join('\n') };
}

/* ------------------------------------------------------------------ */
/* 展示                                                               */
/* ------------------------------------------------------------------ */

function formatItems(items, label, limit, showBy) {
  const shown = items.slice(0, limit);
  const lines = ['【' + label + ' · 共 ' + items.length + ' 条，显示 ' + shown.length + ' 条】'];
  shown.forEach((item, i) => {
    const cat = CAT_BY_KEY[item.cat] || CAT_BY_KEY.memo;
    const by = showBy && item.by ? ' · ' + shortId(item.by) : '';
    lines.push((i + 1) + '. ' + fmtTime(item.ts) + ' [' + cat.name + '] ' + oneLine(item.text, 80) + by);
  });
  if (items.length > shown.length) lines.push('…还有 ' + (items.length - shown.length) + ' 条。');
  if (shown.length > 1) lines.push('看全文发 /read 编号。');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* /read                                                              */
/* ------------------------------------------------------------------ */

/**
 * 单条全文视图。列表里的摘要只有几十字，用户真正想看的是原文，
 * 所以搜索命中一条、或者 /read N 时都走这里，长内容交给分段补发。
 */
function singleView(item, items, cfg, wantSeg) {
  const cat = CAT_BY_KEY[item.cat] || CAT_BY_KEY.memo;
  const idx = items.indexOf(item) + 1;
  const head = '【' + cat.name + ' · ' + fmtTime(item.ts) + '】';
  const budget = Math.max(300, cfg.chunkChars - head.length - 24);
  const segments = splitText(item.text, budget);
  const seg = Math.min(Math.max(1, Number(wantSeg) || 1), segments.length);
  return {
    text: head + (segments.length > 1 ? ' 第 ' + seg + '/' + segments.length + ' 段' : '')
      + '\n' + segments[seg - 1],
    extra: segments.slice(seg),
    nextCmd: seg < segments.length ? '/read ' + idx + ' ' + (seg + 1) : '',
  };
}

function doRead(input, cfg, raw) {
  const dir = noteDir(input, cfg);
  const me = senderOf(input).id;
  if (!me) return { text: NO_IDENTITY };
  const index = loadIndex(dir);
  const items = ownedItems(index, me);
  if (!items.length) {
    return { text: '你自己还没有记录。用 /record 记一条试试。' };
  }

  const query = String(raw || '').trim();
  const showBy = false;   // 列表里全是你自己的，不必再标记录人

  if (!query) {
    return { text: formatItems(items, '最近', cfg.readLimit, showBy) };
  }

  // 第 N 条，可以再跟一个段号：/read 3 2 = 第 3 条的第 2 段
  const picked = /^(\d{1,4})(?:\s+(\d{1,3}))?$/.exec(query);
  if (picked) {
    const n = Number(picked[1]);
    const want = Number(picked[2] || 1);
    const item = items[n - 1];
    if (!item) return { text: '只有 ' + items.length + ' 条，没有第 ' + n + ' 条。' };
    const cat = CAT_BY_KEY[item.cat] || CAT_BY_KEY.memo;
    // 段长要把标题前缀占的位置让出来，否则外层会再切一刀，段号就对不上了
    const head = '【第 ' + n + ' 条 · ' + cat.name + ' · ' + fmtTime(item.ts) + '】';
    const budget = Math.max(300, cfg.chunkChars - head.length - 24);
    const segments = splitText(item.text, budget);
    const seg = Math.min(Math.max(1, want), segments.length);
    const label = head + (segments.length > 1 ? ' 第 ' + seg + '/' + segments.length + ' 段' : '');
    return {
      text: label + '\n' + segments[seg - 1],
      extra: segments.slice(seg),
      nextCmd: '/read ' + n + ' ' + (seg + 1),
    };
  }

  const filtered = filterItems(items, query);
  if (filtered.error) return { text: filtered.error };
  if (!filtered.items.length) {
    return { text: '「' + filtered.label + '」里没有记录。\n共 ' + items.length + ' 条，发 /read 看最近的。' };
  }

  // 只命中一条就是用户要找的那条，直接给全文，别再让人多发一次 /read
  if (filtered.items.length === 1) return singleView(filtered.items[0], items, cfg);

  return { text: formatItems(filtered.items, filtered.label, cfg.readLimit, showBy) };
}

/* ------------------------------------------------------------------ */
/* /delete                                                            */
/* ------------------------------------------------------------------ */

function doDeleteOne(input, cfg, dir, index, id, me) {
  // 只认自己的记录，别人的 id 就算猜到也删不动
  const item = index.items.find(i => i.id === id && !i.deleted && str(i.by).trim() === str(me).trim());
  if (!item) return { text: '这条已经不在了，可能刚被删过。' };

  item.deleted = true;
  item.deletedAt = Date.now();
  item.deletedBy = senderOf(input).id || '';

  try {
    saveIndex(dir, index);
  } catch (e) {
    return { text: '写索引失败（' + (e && e.code ? e.code : 'unknown') + '），没删成。' };
  }
  renderAll(dir, index.items);

  const cat = CAT_BY_KEY[item.cat] || CAT_BY_KEY.memo;
  return {
    text: '已删除「' + cat.name + '」里的一条：\n' + oneLine(item.text, 80)
      + '\n' + Math.round(UNDO_TTL_MS / 3600000) + ' 小时内发 /delete undo 可以恢复。',
    state: mergeState(input, { delPick: null }),
  };
}

function doDelete(input, cfg, raw) {
  const dir = noteDir(input, cfg);
  const me = senderOf(input).id;
  if (!me) return { text: NO_IDENTITY };
  const index = loadIndex(dir);
  const items = ownedItems(index, me);
  const query = String(raw || '').trim();

  if (!query) {
    return {
      text: '用法：/delete 关键词\n'
        + '条件写法和 /read 一样：今天 / 昨天 / 本周 / 待办 / 牛奶 / 3\n'
        + '搜到多条会列出来让你选编号。',
    };
  }

  // 撤销删除。一次只回一条，从最近删的开始往回走。
  if (/^(undo|撤销|恢复|回退)$/i.test(query)) {
    const deleted = index.items
      .filter(item => item.deleted && str(item.by).trim() === me && Number.isFinite(Number(item.deletedAt)))
      .sort((a, b) => Number(b.deletedAt) - Number(a.deletedAt));

    const alive = deleted.filter(item => Date.now() - Number(item.deletedAt) <= UNDO_TTL_MS);
    const last = alive[0];

    if (!last) {
      if (deleted.length) {
        const hours = Math.round(UNDO_TTL_MS / 3600000);
        return {
          text: '最近一次删除是 ' + fmtTime(Number(deleted[0].deletedAt)) + '，超过可撤销时限（' + hours + ' 小时）。\n'
            + '确实要找回，去 index.json 里把那条的 deleted 字段去掉。',
        };
      }
      return { text: '没有可恢复的删除记录。' };
    }

    delete last.deleted;
    delete last.deletedAt;
    delete last.deletedBy;

    let saveFailed = null;
    try {
      saveIndex(dir, index);
    } catch (e) {
      saveFailed = e && e.code ? e.code : 'unknown';
    }
    if (saveFailed) return { text: '写索引失败（' + saveFailed + '），没恢复成。' };
    renderAll(dir, index.items);

    const cat = CAT_BY_KEY[last.cat] || CAT_BY_KEY.memo;
    const lines = ['已恢复「' + cat.name + '」里的这一条：', oneLine(last.text, 80)];

    // 关键提示：还有更早的删除没恢复，不说明的话用户会以为撤销只有一次
    const left = alive.length - 1;
    if (left > 0) {
      lines.push('');
      lines.push('还有 ' + left + ' 条更早的删除可以恢复，再发一次 /delete undo。');
    }
    return { text: lines.join('\n') };
  }

  // 纯数字：从上次列出的候选里挑
  if (/^\d{1,3}$/.test(query)) {
    const pick = input.state && input.state.delPick;
    if (!pick || !Array.isArray(pick.ids) || !pick.ids.length) {
      return { text: '没有待选的列表。先用 /delete 关键词 搜一次，再回编号。' };
    }
    if (!pick.at || Date.now() - pick.at > PICK_TTL_MS) {
      return {
        text: '上次的列表已经过期（超过 ' + Math.round(PICK_TTL_MS / 1000) + ' 秒），重新发 /delete 关键词 搜一次。',
        state: mergeState(input, { delPick: null }),
      };
    }
    const n = Number(query);
    const id = pick.ids[n - 1];
    if (!id) return { text: '列表里只有 ' + pick.ids.length + ' 条，没有第 ' + n + ' 条。' };
    return doDeleteOne(input, cfg, dir, index, id, me);
  }

  if (!items.length) return { text: '还没有任何记录。' };

  const filtered = filterItems(items, query);
  if (filtered.error) return { text: filtered.error };
  const hits = filtered.items;
  if (!hits.length) {
    return { text: '没找到匹配「' + query + '」的记录。共 ' + items.length + ' 条，发 /read 看看。' };
  }

  const shown = hits.slice(0, 30);
  const lines = ['匹配到 ' + hits.length + ' 条，删哪条？回 /delete 编号：'];
  shown.forEach((item, i) => {
    const cat = CAT_BY_KEY[item.cat] || CAT_BY_KEY.memo;
    const by = item.by ? ' · ' + shortId(item.by) : '';
    lines.push((i + 1) + '. ' + fmtTime(item.ts) + ' [' + cat.name + '] ' + oneLine(item.text, 50) + by);
  });
  if (hits.length > shown.length) {
    lines.push('…还有 ' + (hits.length - shown.length) + ' 条，条件写窄一点再搜。');
  }
  lines.push('直接回数字 ' + (shown.length > 1 ? '1、2…' : '1') + ' 就删，也可以用 /delete 编号。' + Math.round(PICK_TTL_MS / 1000) + ' 秒内有效。');

  return {
    text: lines.join('\n'),
    state: mergeState(input, { delPick: { ids: shown.map(item => item.id), at: Date.now() } }),
  };
}

/* ------------------------------------------------------------------ */
/* /whoami                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把宿主实际交给插件的字段回显出来，用来确认到底有没有 wxid。
 * 只列 message 这一层的键和值，用来定位字段名。
 */
function doWhoami(input) {
  const msg = (input && input.message) || {};
  const lines = ['【上下文探测】message 里这些字段：'];
  const keys = Object.keys(msg);
  if (!keys.length) {
    lines.push('（空的，宿主没给 message）');
  }
  for (const key of keys) {
    const value = msg[key];
    let shown;
    if (typeof value === 'string') shown = value.length > 60 ? value.slice(0, 60) + '…' : value;
    else if (value === null) shown = 'null';
    else if (value === undefined) shown = 'undefined';
    else if (Array.isArray(value)) shown = '[数组 ' + value.length + ' 项]';
    else if (typeof value === 'object') shown = '{' + Object.keys(value).slice(0, 8).join(',') + '}';
    else shown = String(value);
    lines.push('· ' + key + ' = ' + shown);
  }

  const known = ['message', 'state', 'settings', 'history', 'system', 'whale', 'host'];
  const others = Object.keys(input || {}).filter(key => known.indexOf(key) < 0);
  if (others.length) lines.push('input 上的其它键：' + others.join(', '));

  const sender = senderOf(input);
  lines.push('');
  if (sender.id) {
    lines.push('现在识别到：' + sender.id);
    lines.push('取自字段：' + sender.field + '（' + byKindLabel(sender.kind) + '）');
    if (sender.kind !== 'wxid') {
      lines.push('这个不是 wxid。把上面带 wxid 字样的字段名发我，加进探测列表就行。');
    }
  } else {
    lines.push('没识别出任何身份字段。把上面的键名发我。');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 配置与调度                                                          */
/* ------------------------------------------------------------------ */

function readConfig(input) {
  const raw = (input && input.settings) || {};
  let box = raw;
  if (typeof raw === 'string') {
    try { box = JSON.parse(raw); } catch (_) { box = {}; }
  }
  if (!box || typeof box !== 'object' || Array.isArray(box)) box = {};
  for (const key of ['config', 'notes']) {
    const value = box[key];
    if (typeof value === 'string' && value.trim().charAt(0) === '{') {
      try { box = Object.assign({}, box, JSON.parse(value)); } catch (_) { /* 用原设置 */ }
    }
  }
  return {
    noteDir: str(box.noteDir, 'note').trim() || 'note',
    readLimit: int(box.readLimit, DEFAULT_READ_LIMIT, 1, 30),
    maxItemChars: int(box.maxItemChars, DEFAULT_MAX_ITEM, 100, 20000),
    allowDelete: bool(box.allowDelete, true),
    // 一条消息装多少字。微信实测两三千就切，1500 留足余量
    chunkChars: int(box.chunkChars, DEFAULT_CHUNK, 300, 12000),
    // 超出部分是否用主动发送补出去；关掉就只发第一段并给翻页提示
    autoSend: bool(box.autoSend, true),
  };
}

/** 命令词后面必须是空白或直接结束，避免 /readme、/deleted 这类被误认。 */
const CMD_RE = /^\s*[\/／]\s*(record|read|delete|del|whoami)(?=$|[\s\u3000])([\s\S]*)$/i;

/**
 * 群里发命令通常要先 @ 机器人，消息文本会带 `@昵称` 前缀，
 * 微信在 @ 后面插的往往是特殊空白（\u2005），普通空格也可能。
 * 不把这层剥掉，群里发 /read 永远匹配不到开头。
 */
const MENTION_PREFIX = /^(?:\s*[@＠]\S{1,40}?\s+)+/;

function stripMention(text) {
  return String(text === undefined || text === null ? '' : text).replace(MENTION_PREFIX, '').trim();
}

const HELP = [
  '【随手记】',
  '/record 内容     记一条，自动归类，记下是谁记的',
  '/read            看最近 10 条',
  '/read 今天       按时间看（今天/昨天/本周）',
  '/read 待办       按类别看（待办/链接/代码/账目/想法/笔记）',
  '/read 关键词     搜内容，多个词用空格分开',
  '/read 3          读最近第 3 条全文',
  '',
  '/delete 关键词   搜出来列编号，回 /delete 编号 删',
  '/delete undo     撤销删除，连发可逐条往回恢复',
  '',
  '/whoami          看宿主给了哪些字段（确认有没有 wxid）',
  '',
  '长内容超过一条消息会切成多段自动补发，',
  '发不出去时按提示用 /read 条号 段号 翻页。',
  '',
  '每人只看得到自己记的。/read 和 /delete 都按身份隔离。',
  '只写 note 目录，其它路径碰不到。',
].join('\n');

/**
 * 刚列过删除候选时，用户往往直接回一个数字。
 *
 * 这种消息不接管的话会交给正常模型流程，模型还可能编一句「已删除」——
 * 所以只在 delPick 有效期内（60 秒）认裸数字，其它数字照常聊天。
 */
function pickByNumber(input, cfg, body) {
  if (!/^\d{1,3}$/.test(body)) return null;
  const pick = input.state && input.state.delPick;
  if (!pick || !Array.isArray(pick.ids) || !pick.ids.length) return null;
  if (!pick.at || Date.now() - pick.at > PICK_TTL_MS) return null;
  if (!cfg.allowDelete) return { text: '删除功能在设置里被关掉了（allowDelete=false）。' };
  return doDelete(input, cfg, body);
}

exports.hooks = {
  'chat.generate': async (input) => {
    try {
      const raw = str(input && input.message && input.message.text).trim();
      if (!raw) return {};

      const body = stripMention(raw);   // 群里带 @机器人 前缀，先剥掉
      const cfg = readConfig(input);
      const match = CMD_RE.exec(body);
      let result = null;

      if (match) {
        const name = match[1].toLowerCase();
        const arg = str(match[2]).trim();

        if (arg === 'help' || arg === '帮助' || arg === '?') {
          result = { text: HELP };
        } else if (name === 'record') {
          result = doRecord(input, cfg, arg);
        } else if (name === 'read') {
          result = doRead(input, cfg, arg);
        } else if (name === 'whoami') {
          result = { text: doWhoami(input) };
        } else if (!cfg.allowDelete) {
          result = { text: '删除功能在设置里被关掉了（allowDelete=false）。' };
        } else {
          result = doDelete(input, cfg, arg);
        }
      } else {
        result = pickByNumber(input, cfg, body);
      }

      if (!result || !result.text) return {};

      // 先把本轮要说的正文和待补发的分段拢在一起
      let text = sanitize(result.text, MAX_TEXT);
      let rest = Array.isArray(result.extra) ? result.extra.slice() : [];

      // 兜底：正文本身就超过一条消息的容量（列表类输出会遇到），本地先切
      const parts = splitText(text, cfg.chunkChars);
      if (parts.length > 1) {
        text = parts[0];
        rest = parts.slice(1).concat(rest);
      }

      // 剩下的用主动发送补，失败就转成翻页提示，不吞内容
      let sent = 0;
      if (rest.length && cfg.autoSend) sent = await pushRemaining(rest, input, cfg);
      if (sent < rest.length) {
        text += '\n\n（还有 ' + (rest.length - sent) + ' 段没发出去。'
          + (result.nextCmd ? '发 ' + result.nextCmd + ' 继续看。' : '把范围缩小一点再试。') + '）';
      }

      const out = {};
      const safe = sanitize(text, MAX_TEXT);
      if (safe) out.text = safe;
      if (result.state) out.state = result.state;
      return out.text || out.state ? out : {};
    } catch (_) {
      return {};   // 任何异常都交还宿主，绝不吞消息
    }
  },
};

/** 供离线自测读取。 */
exports.classify = classify;
exports.doRead = doRead;
exports.doDelete = doDelete;
exports.doRecord = doRecord;
exports.readConfig = readConfig;
exports.noteDir = noteDir;
exports.senderOf = senderOf;
exports.CATS = CATS;
