'use strict';
/**
 * 鲸鲸随手记 · notes · whale-plugin/1（4 级 Node）—— 迁移稿
 *
 * 旧 Api 4 hooks['chat.generate'] → providers['chat.generate@1']（replace）。
 * 旧实现依赖 input.state、input.whale.paths.pluginData、whale.sendText，新协议都没有：
 *   - 删除候选改存插件数据目录 state.json；
 *   - 数据目录 = process.cwd()（4 级 worker 的 cwd，需读宿主运行时源码才知道）；
 *   - 补发改 host.call('message.send@1')（排队语义）；
 *   - 非命令消息无法再返回 {} 交还宿主，改为 host.call('model.complete@1') 回退。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_TEXT = 16000;
const DEFAULT_MAX_ITEM = 5000;
const MAX_ITEMS = 5000;
const DEFAULT_READ_LIMIT = 10;
const PICK_TTL_MS = 60 * 1000;
const UNDO_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CHUNK = 1200;
const MAX_EXTRA_SEGMENTS = 8;
const SEND_GAP_MS = 250;
const STATE_FILE = 'state.json';

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
function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }
function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return hm;
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm;
}
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

/* 记录人：新 message 固定带 senderId；仍多路兜底，避免个别版本字段缺失。 */
const WXID_FIELDS = ['senderId', 'senderWxid', 'fromWxid', 'wxid', 'memberWxid', 'from'];
const NICK_FIELDS = ['senderName', 'nickname', 'nickName', 'displayName', 'name'];

function senderOf(input) {
  const msg = (input && input.message) || {};
  for (const field of WXID_FIELDS) {
    const value = msg[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (/@chatroom$/i.test(value.trim())) continue;
    return { id: value.trim(), kind: 'wxid', field };
  }
  for (const field of NICK_FIELDS) {
    const value = msg[field];
    if (typeof value === 'string' && value.trim()) return { id: value.trim(), kind: 'nick', field };
  }
  for (const field of ['chatId']) {
    const value = msg[field];
    if (typeof value === 'string' && value.trim()) return { id: value.trim(), kind: 'session', field };
  }
  return { id: '', kind: 'unknown', field: '' };
}

function byKindLabel(kind) {
  if (kind === 'wxid') return 'wxid';
  if (kind === 'nick') return '昵称，宿主没给 wxid';
  if (kind === 'session') return '会话 id，宿主没给 wxid';
  return '未知，宿主没给任何身份字段';
}

/* 数据目录 = 插件数据目录（worker cwd） */
function dataDir() { return process.cwd(); }

function noteDir(cfg) {
  const configured = str(cfg && cfg.noteDir).trim();
  const base = dataDir();
  if (!configured) return path.join(base, 'note');
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(configured)) return path.join(base, 'note');
  return path.join(base, configured);
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (_) { return false; }
}

/* 跨轮状态：旧 input.state.delPick → state.json（8 KiB 硬上限，避免按会话无限增长） */
const MAX_STATE_BYTES = 8 * 1024;
function statePath() { return path.join(dataDir(), STATE_FILE); }
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}
function writeState(state) {
  // 状态按 chat|sender 累积，必须有硬上限；候选本身只有 60 秒有效期，过期直接丢。
  const box = {};
  let dropped = 0;
  for (const [key, pick] of Object.entries(state || {})) {
    if (key === '__meta') continue;
    if (!pick || !Array.isArray(pick.ids) || !pick.ids.length
      || !Number.isFinite(Number(pick.at)) || Date.now() - Number(pick.at) > PICK_TTL_MS) {
      dropped += 1;
      continue;
    }
    box[key] = pick;
  }
  const keys = Object.keys(box);
  while (keys.length && Buffer.byteLength(JSON.stringify(box)) > MAX_STATE_BYTES) {
    keys.sort((a, b) => Number(box[b].at || 0) - Number(box[a].at || 0));
    delete box[keys.pop()];
    dropped += 1;
  }
  const previous = Number(state && state.__meta && state.__meta.dropped) || 0;
  if (dropped) box.__meta = { dropped: previous + dropped };
  let body = JSON.stringify(box);
  if (Buffer.byteLength(body) > MAX_STATE_BYTES) {
    // 极端情况下只保留计数，保证文件永不超过上限。
    body = JSON.stringify({ __meta: { dropped: previous + dropped } });
  }
  const file = statePath();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(tmp, body, 'utf8');
    try { fs.renameSync(tmp, file); } catch (_) {
      fs.writeFileSync(file, body, 'utf8');
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  } catch (_) { /* 状态写失败只影响删除候选 */ }
}
function chatKeyOf(input) {
  const msg = (input && input.message) || {};
  return String(msg.chatId || '') + '|' + String(msg.senderId || '');
}
function readPick(input) {
  const pick = readState()[chatKeyOf(input)];
  return pick && Array.isArray(pick.ids) && pick.ids.length ? pick : null;
}
function savePick(input, pick) {
  const state = readState();
  state[chatKeyOf(input)] = pick;
  writeState(state);
}

/* 分类 */
const CATS = [
  { key: 'money', name: '账目', file: 'money.md',
    words: ['花了', '支出', '收入', '账单', '报销', '工资', '付款', '转账', '退款', '¥', '￥'],
    pattern: /\d+\s*(?:元|块|万元|k\b)/i },
  { key: 'todo', name: '待办', file: 'todos.md',
    words: ['待办', '要做', '记得', '别忘', '明天', '后天', '下周', '任务', '提醒我', '截止', 'ddl', 'todo', '买', '去办', '联系'] },
  { key: 'link', name: '链接', file: 'links.md',
    pattern: /https?:\/\/\S+|www\.\S+|\bb23\.tv\/\S+|\bgithub\.com\/\S+/i },
  { key: 'code', name: '代码', file: 'code.md',
    pattern: /```|^\s{2,}(?:function|const|let|var|def|class|import|from|public|private|return|if|for)\b|^\s*(?:function|const|let|var|def|class|import|from)\s+[\w$]|\bconsole\.log\(|\bprint\(/m },
  { key: 'idea', name: '想法', file: 'ideas.md',
    words: ['想法', '灵感', '点子', '突然想到', '思路', '构思', '如果做个'] },
  { key: 'memo', name: '笔记', file: 'memo.md' },
];
const CAT_BY_KEY = {};
for (const cat of CATS) CAT_BY_KEY[cat.key] = cat;
function classify(text) {
  const lower = String(text).toLowerCase();
  for (const cat of CATS) {
    if (cat.words) for (const word of cat.words) if (lower.indexOf(String(word).toLowerCase()) >= 0) return cat;
    if (cat.pattern && cat.pattern.test(text)) return cat;
  }
  return CAT_BY_KEY.memo;
}

/* 索引 */
function indexPath(dir) { return path.join(dir, 'index.json'); }
function loadIndex(dir) {
  const file = indexPath(dir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.items)) {
      return { ok: true, version: 1, items: parsed.items.filter(item => item && typeof item.text === 'string') };
    }
  } catch (_) { /* 不存在或坏了 */ }
  try {
    if (fs.existsSync(file)) fs.renameSync(file, path.join(dir, 'index.broken-' + Date.now() + '.json'));
  } catch (_) { /* ignore */ }
  return { ok: false, version: 1, items: [] };
}
function saveIndex(dir, index) {
  const file = indexPath(dir);
  const body = JSON.stringify({ version: 1, items: index.items }, null, 1);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  try { fs.renameSync(tmp, file); } catch (_) {
    fs.writeFileSync(file, body, 'utf8');
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}
function renderCatFile(dir, cat, items) {
  const mine = items.filter(item => item.cat === cat.key && !item.deleted).slice().sort((a, b) => b.ts - a.ts);
  const lines = ['# ' + cat.name, '', '共 ' + mine.length + ' 条，最新在上。', ''];
  for (const item of mine) {
    const who = item.by ? ' · by ' + item.by : '';
    lines.push('## ' + fmtTimeAbs(item.ts) + who);
    lines.push('');
    lines.push(item.text.trim());
    lines.push('');
  }
  const file = path.join(dir, cat.file);
  try {
    const body = lines.join('\n');
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (old === body) return;
    fs.writeFileSync(file, body, 'utf8');
  } catch (_) { /* 导出失败不影响索引 */ }
}
function renderAll(dir, items) { for (const cat of CATS) renderCatFile(dir, cat, items); }

function ownedItems(index, me) {
  const key = str(me).trim();
  if (!key) return [];
  return index.items.filter(item => !item.deleted && str(item.by).trim() === key).sort((a, b) => b.ts - a.ts);
}

const NO_IDENTITY = '没拿到你的身份标识，分不清哪些记录是你的。\n发 /whoami 看看宿主给了哪些字段，把结果发我。';

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
  for (const cat of CATS) if (cat.key === w || cat.name === word.trim()) return cat;
  if (w === '钱' || w === '账') return CAT_BY_KEY.money;
  if (w === 'todo') return CAT_BY_KEY.todo;
  if (w === 'memo' || w === 'note') return CAT_BY_KEY.memo;
  return null;
}
function filterItems(items, query) {
  const q = String(query || '').trim();
  for (const word of RANGE_TODAY) if (q === word) return { items: items.filter(item => item.ts >= startOfDay(0)), label: '今天' };
  for (const word of RANGE_YESTERDAY) {
    if (q === word) {
      const since = startOfDay(1), until = startOfDay(0);
      return { items: items.filter(item => item.ts >= since && item.ts < until), label: '昨天' };
    }
  }
  for (const word of RANGE_WEEK) {
    if (q === word) return { items: items.filter(item => item.ts >= Date.now() - 7 * 24 * 3600 * 1000), label: '最近七天' };
  }
  const asCat = matchCat(q);
  if (asCat) return { items: items.filter(item => item.cat === asCat.key), label: asCat.name };
  const words = q.split(/[\s\u3000]+/).filter(Boolean);
  if (!words.length) return { items, label: '最近' };
  const hits = items.filter(item => {
    const hay = item.text.toLowerCase() + ' ' + str(item.by).toLowerCase();
    return words.every(w => hay.indexOf(w.toLowerCase()) >= 0);
  });
  return { items: hits, label: '「' + q + '」' };
}

/* /record */
function doRecord(input, cfg, raw) {
  const text = String(raw || '').trim();
  if (!text) return { text: '用法：/record 要记的内容。\n例：/record 明天下午三点跟客户开会' };
  if (text.length > cfg.maxItemChars) {
    return { text: '这条 ' + text.length + ' 字，超过单条上限 ' + cfg.maxItemChars + ' 字。\n拆成几条记，或者精简一下。' };
  }
  const dir = noteDir(cfg);
  if (!ensureDir(dir)) return { text: '建不了 note 目录，检查插件数据目录的写权限。' };
  const index = loadIndex(dir);
  const cat = classify(text);
  const sender = senderOf(input);
  const today = new Date().toDateString();
  const dup = index.items.find(item => !item.deleted && item.text.trim() === text
    && str(item.by) === sender.id && new Date(item.ts).toDateString() === today);
  if (dup) return { text: '这条今天已经记过了（' + fmtTime(dup.ts) + '，在「' + cat.name + '」里），没重复记。' };
  const now = Date.now();
  index.items.push({
    id: 'n' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    ts: now, cat: cat.key, text, by: sender.id, byKind: sender.kind,
  });
  if (index.items.length > MAX_ITEMS) index.items = index.items.slice(index.items.length - MAX_ITEMS);
  try { saveIndex(dir, index); } catch (e) {
    return { text: '写索引失败（' + (e && e.code ? e.code : 'unknown') + '），这条没记上。' };
  }
  renderAll(dir, index.items);
  const mine = ownedItems(index, sender.id);
  const todayCount = mine.filter(i => new Date(i.ts).toDateString() === today).length;
  const lines = ['已记到「' + cat.name + '」' + cat.file, oneLine(text, 80),
    '你今天 ' + todayCount + ' 条，你的合计 ' + mine.length + ' 条。'];
  if (sender.kind === 'unknown') lines.push('（没拿到你的 wxid，这条会归到「未知」，你自己也可能读不到。发 /whoami 看宿主给了哪些字段）');
  return { text: lines.join('\n') };
}

/* 展示 / /read */
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
function singleView(item, items, cfg, wantSeg) {
  const cat = CAT_BY_KEY[item.cat] || CAT_BY_KEY.memo;
  const idx = items.indexOf(item) + 1;
  const head = '【' + cat.name + ' · ' + fmtTime(item.ts) + '】';
  const budget = Math.max(300, cfg.chunkChars - head.length - 24);
  const segments = splitText(item.text, budget);
  const seg = Math.min(Math.max(1, Number(wantSeg) || 1), segments.length);
  return {
    text: head + (segments.length > 1 ? ' 第 ' + seg + '/' + segments.length + ' 段' : '') + '\n' + segments[seg - 1],
    extra: segments.slice(seg),
    nextCmd: seg < segments.length ? '/read ' + idx + ' ' + (seg + 1) : '',
  };
}
function doRead(input, cfg, raw) {
  const dir = noteDir(cfg);
  const me = senderOf(input).id;
  if (!me) return { text: NO_IDENTITY };
  const index = loadIndex(dir);
  const items = ownedItems(index, me);
  if (!items.length) return { text: '你自己还没有记录。用 /record 记一条试试。' };
  const query = String(raw || '').trim();
  if (!query) return { text: formatItems(items, '最近', cfg.readLimit, false) };
  const picked = /^(\d{1,4})(?:\s+(\d{1,3}))?$/.exec(query);
  if (picked) {
    const n = Number(picked[1]);
    const want = Number(picked[2] || 1);
    const item = items[n - 1];
    if (!item) return { text: '只有 ' + items.length + ' 条，没有第 ' + n + ' 条。' };
    const cat = CAT_BY_KEY[item.cat] || CAT_BY_KEY.memo;
    const head = '【第 ' + n + ' 条 · ' + cat.name + ' · ' + fmtTime(item.ts) + '】';
    const budget = Math.max(300, cfg.chunkChars - head.length - 24);
    const segments = splitText(item.text, budget);
    const seg = Math.min(Math.max(1, want), segments.length);
    const label = head + (segments.length > 1 ? ' 第 ' + seg + '/' + segments.length + ' 段' : '');
    return { text: label + '\n' + segments[seg - 1], extra: segments.slice(seg), nextCmd: '/read ' + n + ' ' + (seg + 1) };
  }
  const filtered = filterItems(items, query);
  if (!filtered.items.length) return { text: '「' + filtered.label + '」里没有记录。\n共 ' + items.length + ' 条，发 /read 看最近的。' };
  if (filtered.items.length === 1) return singleView(filtered.items[0], items, cfg);
  return { text: formatItems(filtered.items, filtered.label, cfg.readLimit, false) };
}

/* /delete */
function doDeleteOne(input, cfg, dir, index, id, me) {
  const item = index.items.find(i => i.id === id && !i.deleted && str(i.by).trim() === str(me).trim());
  if (!item) return { text: '这条已经不在了，可能刚被删过。' };
  item.deleted = true;
  item.deletedAt = Date.now();
  item.deletedBy = senderOf(input).id || '';
  try { saveIndex(dir, index); } catch (e) {
    return { text: '写索引失败（' + (e && e.code ? e.code : 'unknown') + '），没删成。' };
  }
  renderAll(dir, index.items);
  const cat = CAT_BY_KEY[item.cat] || CAT_BY_KEY.memo;
  return {
    text: '已删除「' + cat.name + '」里的一条：\n' + oneLine(item.text, 80)
      + '\n' + Math.round(UNDO_TTL_MS / 3600000) + ' 小时内发 /delete undo 可以恢复。',
  };
}
function doDelete(input, cfg, raw) {
  const dir = noteDir(cfg);
  const me = senderOf(input).id;
  if (!me) return { text: NO_IDENTITY };
  const index = loadIndex(dir);
  const items = ownedItems(index, me);
  const query = String(raw || '').trim();
  if (!query) {
    return { text: '用法：/delete 关键词\n条件写法和 /read 一样：今天 / 昨天 / 本周 / 待办 / 牛奶 / 3\n搜到多条会列出来让你选编号。' };
  }
  if (/^(undo|撤销|恢复|回退)$/i.test(query)) {
    const deleted = index.items.filter(item => item.deleted && str(item.by).trim() === me && Number.isFinite(Number(item.deletedAt)))
      .sort((a, b) => Number(b.deletedAt) - Number(a.deletedAt));
    const alive = deleted.filter(item => Date.now() - Number(item.deletedAt) <= UNDO_TTL_MS);
    const last = alive[0];
    if (!last) {
      if (deleted.length) {
        return { text: '最近一次删除是 ' + fmtTime(Number(deleted[0].deletedAt)) + '，超过可撤销时限（'
          + Math.round(UNDO_TTL_MS / 3600000) + ' 小时）。\n确实要找回，去 index.json 里把那条的 deleted 字段去掉。' };
      }
      return { text: '没有可恢复的删除记录。' };
    }
    delete last.deleted; delete last.deletedAt; delete last.deletedBy;
    let saveFailed = null;
    try { saveIndex(dir, index); } catch (e) { saveFailed = e && e.code ? e.code : 'unknown'; }
    if (saveFailed) return { text: '写索引失败（' + saveFailed + '），没恢复成。' };
    renderAll(dir, index.items);
    const cat = CAT_BY_KEY[last.cat] || CAT_BY_KEY.memo;
    const lines = ['已恢复「' + cat.name + '」里的这一条：', oneLine(last.text, 80)];
    const left = alive.length - 1;
    if (left > 0) { lines.push(''); lines.push('还有 ' + left + ' 条更早的删除可以恢复，再发一次 /delete undo。'); }
    return { text: lines.join('\n') };
  }
  if (/^\d{1,3}$/.test(query)) {
    const pick = readPick(input);
    if (!pick) return { text: '没有待选的列表。先用 /delete 关键词 搜一次，再回编号。' };
    if (!pick.at || Date.now() - pick.at > PICK_TTL_MS) {
      savePick(input, { ids: [], at: 0 });
      return { text: '上次的列表已经过期（超过 ' + Math.round(PICK_TTL_MS / 1000) + ' 秒），重新发 /delete 关键词 搜一次。' };
    }
    const n = Number(query);
    const id = pick.ids[n - 1];
    if (!id) return { text: '列表里只有 ' + pick.ids.length + ' 条，没有第 ' + n + ' 条。' };
    return doDeleteOne(input, cfg, dir, index, id, me);
  }
  if (!items.length) return { text: '还没有任何记录。' };
  const hits = filterItems(items, query).items;
  if (!hits.length) return { text: '没找到匹配「' + query + '」的记录。共 ' + items.length + ' 条，发 /read 看看。' };
  const shown = hits.slice(0, 30);
  const lines = ['匹配到 ' + hits.length + ' 条，删哪条？回 /delete 编号：'];
  shown.forEach((item, i) => {
    const cat = CAT_BY_KEY[item.cat] || CAT_BY_KEY.memo;
    const by = item.by ? ' · ' + shortId(item.by) : '';
    lines.push((i + 1) + '. ' + fmtTime(item.ts) + ' [' + cat.name + '] ' + oneLine(item.text, 50) + by);
  });
  if (hits.length > shown.length) lines.push('…还有 ' + (hits.length - shown.length) + ' 条，条件写窄一点再搜。');
  lines.push('直接回数字 ' + (shown.length > 1 ? '1、2…' : '1') + ' 就删，也可以用 /delete 编号。' + Math.round(PICK_TTL_MS / 1000) + ' 秒内有效。');
  savePick(input, { ids: shown.map(item => item.id), at: Date.now() });
  return { text: lines.join('\n') };
}

/* /whoami */
function doWhoami(input) {
  const msg = (input && input.message) || {};
  const lines = ['【上下文探测】message 里这些字段：'];
  const keys = Object.keys(msg);
  if (!keys.length) lines.push('（空的，宿主没给 message）');
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
  const sender = senderOf(input);
  lines.push('');
  if (sender.id) {
    lines.push('现在识别到：' + sender.id);
    lines.push('取自字段：' + sender.field + '（' + byKindLabel(sender.kind) + '）');
  } else {
    lines.push('没识别出任何身份字段。把上面的键名发我。');
  }
  return lines.join('\n');
}

/* 配置（settingsSchema 无 default 关键字，默认值只能写在这里） */
function readConfig(settings) {
  const box = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  return {
    noteDir: str(box.noteDir, 'note').trim() || 'note',
    readLimit: int(box.readLimit, DEFAULT_READ_LIMIT, 1, 30),
    maxItemChars: int(box.maxItemChars, DEFAULT_MAX_ITEM, 100, 20000),
    allowDelete: bool(box.allowDelete, true),
    chunkChars: int(box.chunkChars, DEFAULT_CHUNK, 300, 12000),
    autoSend: bool(box.autoSend, true),
  };
}

/* 补发：旧 whale.sendText → message.send@1（排队） */
function chatIdOf(input) {
  const msg = (input && input.message) || {};
  return typeof msg.chatId === 'string' ? msg.chatId.trim() : '';
}
async function pushRemaining(segments, input, cfg, ctx) {
  if (!segments || !segments.length || !ctx || !ctx.host) return 0;
  const chatId = chatIdOf(input);
  if (!chatId) return 0;
  const chatType = (input.message && input.message.chatType) || 'private';
  const queue = segments.slice(0, MAX_EXTRA_SEGMENTS);
  let queued = 0;
  for (const segment of queue) {
    try {
      await ctx.host.call('message.send@1', { chatId, chatType, text: sanitize(segment, cfg.chunkChars) });
      queued += 1;
    } catch (_) { break; }
    if (queued < queue.length) await new Promise(resolve => setTimeout(resolve, SEND_GAP_MS));
  }
  return queued;
}

/** 非命令消息：新 replace 模式没有「交还宿主」，用原模型补一条。 */
async function hostReply(input, ctx) {
  try {
    const result = await ctx.host.call('model.complete@1', {
      system: str(input.system),
      turns: Array.isArray(input.turns) ? input.turns : [],
    });
    return { text: sanitize(str(result && result.text)) };
  } catch (error) {
    // 原模型失败也不能把整轮变成 plugin_error；给一句可解释的短期回复。
    const code = String((error && error.code) || 'model_unavailable').slice(0, 40);
    return { text: '原模型暂时不可用（' + code + '），这条先没回上，稍后再试。' };
  }
}

/* 命令 */
const CMD_RE = /^\s*[\/／]\s*(record|read|delete|del|whoami)(?=$|[\s\u3000])([\s\S]*)$/i;
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
  '长内容会切成多段经宿主发送通道补发（排队，不一定立即送达），',
  '发不出去时按提示用 /read 条号 段号 翻页。',
  '',
  '每人只看得到自己记的。/read 和 /delete 都按身份隔离。',
  '只写插件数据目录，其它路径碰不到。',
].join('\n');

exports.providers = {
  'chat.generate@1': async (input, ctx) => {
    const settings = (ctx && ctx.settings) || {};
    const cfg = readConfig(settings);
    const raw = str(input && input.message && input.message.text).trim();
    if (!raw) return hostReply(input || {}, ctx);

    const body = stripMention(raw);
    const match = CMD_RE.exec(body);
    let result = null;
    if (match) {
      const name = match[1].toLowerCase();
      const arg = str(match[2]).trim();
      if (arg === 'help' || arg === '帮助' || arg === '?') result = { text: HELP };
      else if (name === 'record') result = doRecord(input, cfg, arg);
      else if (name === 'read') result = doRead(input, cfg, arg);
      else if (name === 'whoami') result = { text: doWhoami(input) };
      else if (!cfg.allowDelete) result = { text: '删除功能在设置里被关掉了（allowDelete=false）。' };
      else result = doDelete(input, cfg, arg);
    } else if (/^\d{1,3}$/.test(body)) {
      const pick = readPick(input);
      if (pick && pick.at && Date.now() - pick.at <= PICK_TTL_MS) {
        if (!cfg.allowDelete) result = { text: '删除功能在设置里被关掉了（allowDelete=false）。' };
        else result = doDelete(input, cfg, body);
      }
    }
    if (!result || !result.text) return hostReply(input, ctx);

    let text = sanitize(result.text, MAX_TEXT);
    let rest = Array.isArray(result.extra) ? result.extra.slice() : [];
    const parts = splitText(text, cfg.chunkChars);
    if (parts.length > 1) { text = parts[0]; rest = parts.slice(1).concat(rest); }
    let queued = 0;
    if (rest.length && cfg.autoSend) queued = await pushRemaining(rest, input, cfg, ctx);
    if (queued < rest.length) {
      text += '\n\n（还有 ' + (rest.length - queued) + ' 段没发出去。'
        + (result.nextCmd ? '发 ' + result.nextCmd + ' 继续看。' : '把范围缩小一点再试。') + '）';
    }
    return { text: sanitize(text, MAX_TEXT) };
  },
};
