/**
 * 鲸鲸智能搭话插件（Api 4）—— 搜索增强 + 点名搭话 合一
 *
 * 两个钩子：
 *   - chat.generate：点名搭话（私聊主人发「去找 tree 搭话」）。
 *       识别指令 → 生成搭话发给对方 → 用 model 按人设自由发挥生成回执、whale.send 发给主人
 *       → 返回 {text:''} 让主回复被 ignore，避免重复。两条消息都走 reminders 队列，顺序天然。
 *   - chat.search：搜索增强（时效话题或人设兴趣词命中 → 注入真实资料）。
 *
 * 为什么点名搭话挂在 chat.generate 而不是 chat.search：
 *   主流水线顺序是 decide(chat.generate) → chat.search → 发送。
 *   只有 chat.generate 返回空文本才能抑制主回复（decision.action='ignore'）；
 *   而 ignore 会跳过后续 chat.search，所以两条逻辑必须分开挂两个钩子。
 *
 * 关键（避开 sendVoice 踩过的坑）：
 *   - 绝不用 ctx.chatId 当发送目标（内部 id ≠ wxid，微信搜不到）
 *   - 从 contacts-cache.json 按昵称/备注反查真实 wxid + 显示名，whale.send 时用昵称定位
 *   - 回执发给主人用 ctx.message.senderId（真实 wxid），不新建会话
 *   - 兴趣从 data/persona.json 的 customPrompt 动态提取（system.full + node:fs），改人设即生效
 *   - 不定时（应用本体 care 已有间隔主动搭话），点名搭话只在指令触发
 *   - 所有失败都不吞消息、不注入空资料
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const whale = require('whale');

const ROOT = whale.paths.appRoot;
const PERSONA_FILE = path.join(ROOT, 'data', 'persona.json');
const CONTACTS = path.join(ROOT, 'data', 'contacts-cache.json');
const CONFIG_FILE = path.join(ROOT, 'data', 'config.json');
const CARE_STATE_FILE = path.join(ROOT, 'data', 'care-state.json'); // 与 bridge 共享的「主动搭话」账本
const STATE_FILE = path.join(whale.paths.pluginData, 'smart-care-state.json');

// ---------------- 公共工具 ----------------
function numSetting(ctx, key, fallback, min, max) {
  const raw = ctx && ctx.settings ? ctx.settings[key] : undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function boolSetting(ctx, key, fallback) {
  const raw = ctx && ctx.settings ? ctx.settings[key] : undefined;
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  return !/^(0|false|no|off)$/i.test(String(raw));
}
function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
function writeState(obj) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj), 'utf8');
  } catch { /* 写不进只影响记录精度，不影响回复/发送 */ }
}

// ---- 与 bridge 共享的主动搭话账本 care-state.json ----
function readCareState() {
  try { return JSON.parse(fs.readFileSync(CARE_STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
/** 原子写 care-state（temp + rename），避免 bridge 读到写一半的坏 JSON */
function writeCareState(obj) {
  const tmp = CARE_STATE_FILE + '.plugin-tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, CARE_STATE_FILE);
  } catch { try { fs.unlinkSync(tmp); } catch {} }
}

// ---- DeepSeek Search API 直连（拿网页正文，主程序 whale.search 只给摘要）----
const DS_SEARCH_HOST = 'api.deepseek.com';
const DS_SEARCH_PATH = '/v1/tools/search';
const DS_CONTENT_MAX = 1200; // 喂给模型的正文上限

/** 读 DeepSeek 搜索 key（websearch 段） */
function readDeepSeekKey() {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return String(d.websearch?.deepseek?.apiKey || '').trim();
  } catch { return ''; }
}

/**
 * 按兴趣类型换搜索角度：搜玩家/网友的讨论热点，而不是官方更新公告。
 * 统一加否定词排除「更新说明/维护/补偿」这类官方公告（再新也没聊头）。
 */
const TOPIC_ANGLES = {
  '原神': '新角色 剧情 玩家讨论 爆料',
  '英雄联盟': '新赛季 版本 选手 比赛 玩家讨论',
  'lol': '新赛季 版本 选手 比赛 玩家讨论',
  'csgo': 'major 比赛 新地图 选手 讨论',
  'cs2': 'major 比赛 新地图 选手 讨论',
  '时政': '热点 讨论 今日 新进展',
  'ai': '新模型 发布 讨论 应用',
  'ai科技': '新模型 发布 讨论 应用',
  '科技': '新品 发布 讨论 评测',
};
const NEG_QUERY = ' -更新说明 -维护公告 -补偿 -停服 -版本更新 -更新内容';
/** 时效限定：只搜最近 N 天的文章（DeepSeek 搜索语法 after:YYYY-MM-DD），源头过滤旧闻 */
const FRESH_DAYS = 30;
function afterClause() {
  try {
    const d = new Date(Date.now() - FRESH_DAYS * 86400000);
    return ' after:' + d.toISOString().slice(0, 10);
  } catch { return ''; }
}
/** 写死的角度表（AI 动态生成失败时的兜底） */
function buildSearchQuery(topic) {
  const t = String(topic || '').trim();
  const lower = t.toLowerCase();
  let angle = '';
  for (const key of Object.keys(TOPIC_ANGLES)) {
    if (lower === key.toLowerCase() || lower.includes(key.toLowerCase())) { angle = TOPIC_ANGLES[key]; break; }
  }
  return (angle ? `${t} ${angle}` : t) + afterClause() + NEG_QUERY;
}
/** 通用否定词（动态生成时也要带，且要模型别把否定词写进角度里） */
const ANGLE_RULES = [
  '你在帮一个聊天机器人想搜索词：它要找朋友聊「{topic}」这个话题的**新鲜讨论**，',
  '不是官方公告（更新说明/维护/补偿/停服这类没人想聊）。',
  '请给出 2~4 个搜索角度关键词，用来拼在话题后面搜玩家/网友的讨论、爆料、评测、热点。',
  '例如话题是「摄影」→ 可给「新镜头 作品分享 摄影展 技巧讨论」；「煲汤」→「新做法 食材搭配 秋季食谱」。',
  '只输出关键词本身，空格分隔，不要话题名、不要句子、不要否定词、不要标点、不要解释。',
].join('\n');

/**
 * 动态生成搜索角度：调 model 按兴趣想角度词 → 拼否定词。
 * 任何失败（模型挂/输出脏）退回写死的 buildSearchQuery，保证搜索不受影响。
 */
async function buildSearchQueryAsync(topic) {
  const t = String(topic || '').trim();
  if (!t) return (afterClause() + NEG_QUERY).trim();
  try {
    const raw = await whale.model({
      system: ANGLE_RULES.replace('{topic}', t.slice(0, 30)),
      turns: [{ role: 'user', content: `话题：${t}\n搜索角度关键词：` }],
      maxTokens: 60,
    });
    let angle = modelText(raw).trim();
    angle = angle.split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || '';
    // 清洗：只留中英文数字空格，去标点/否定词/话题名残留
    angle = angle.replace(/[^\u4e00-\u9fa5A-Za-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (angle.includes('更新说明') || angle.includes('维护') || angle.includes('补偿')) angle = '';
    const words = angle.split(/\s+/).filter(w => w.length >= 2 && w.length <= 12).slice(0, 5);
    if (!words.length) return buildSearchQuery(t); // 输出脏 → 兜底
    return `${t} ${words.join(' ')}` + afterClause() + NEG_QUERY;
  } catch {
    return buildSearchQuery(t); // 模型失败 → 兜底
  }
}

/**
 * 搜索结果打分：时效(date) + 权威性(authority) + 相关性(rerank_score) + 正文丰富度。
 * Search API 没有浏览量字段，用 authority 作可信度近似。分数越高越该选。
 */
function scoreSearchRow(row) {
  let score = 0;
  // 1) 时效性：发布时间越近越高（1年内线性衰减，超过2年基本0分）
  const ts = Date.parse(row?.date || '');
  if (Number.isFinite(ts)) {
    const ageDays = (Date.now() - ts) / 86400000;
    if (ageDays >= 0 && ageDays < 730) score += Math.max(0, 30 * (1 - ageDays / 730));
  }
  // 2) 权威性 0-4（官方字段，越高越权威）→ 最高 20 分
  const authority = Number(row?.authority);
  if (Number.isFinite(authority) && authority >= 0) score += Math.min(4, authority) * 5;
  // 3) 相关性 0-3（官方综合排序分）→ 最高 30 分
  const rerank = Number(row?.rerank_score);
  if (Number.isFinite(rerank) && rerank > 0) score += Math.min(3, rerank) * 10;
  // 4) 正文丰富度：只做基础分，不再是唯一标准（有正文+10，长度分封顶10）
  const clen = String(row?.content || '').length;
  if (clen > 0) score += 10 + Math.min(10, clen / 300);
  else score += Math.min(5, String(row?.summary || row?.snippet || '').length / 200);
  return score;
}

/** 直连 DeepSeek Search API，need_content:true 拿正文。失败返回 null（调用方退回 whale.search） */
function deepSeekSearchWithContent(query, { count = 3, timeoutMs = 9000 } = {}) {
  return new Promise(resolve => {
    const key = readDeepSeekKey();
    if (!key) return resolve(null);
    let body;
    try {
      body = JSON.stringify({ query: String(query).slice(0, 128), count, need_content: true });
    } catch { return resolve(null); }
    const req = https.request({
      hostname: DS_SEARCH_HOST, port: 443, path: DS_SEARCH_PATH, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs,
    }, res => {
      let out = '';
      res.on('data', c => { out += c; if (out.length > 1.5e6) req.destroy(); });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return resolve(null);
          const j = JSON.parse(out);
          const rows = Array.isArray(j.results) ? j.results : [];
          if (!rows.length) return resolve(null);
          // 选链接：按「时效 + 权威性 + 相关性 + 正文丰富度」加权打分，不再只看正文长度。
          // Search API 不返回浏览量，用 authority(0-4) 作可信度信号，date 作时效信号。
          const scored = rows.map(row => ({ row, score: scoreSearchRow(row) }));
          scored.sort((a, b) => b.score - a.score);
          const best = scored[0].row;
          const content = String(best.content || '').trim();
          const summary = String(best.summary || best.snippet || '').trim();
          const material = (content || summary).slice(0, DS_CONTENT_MAX).replace(/\s+/g, ' ').trim();
          resolve(material ? { material, title: String(best.title || ''), url: String(best.url || ''),
            hasContent: !!content, score: scored[0].score } : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

// ---- 读本体配置（时间窗 / 频率 / 白名单 / 时区）----
function readCareConfig() {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')) || {};
    return { care: d.care || {}, tz: (d.env && d.env.timezone) || '',
      ownerName: String(d.persona?.ownerName || '').trim(),
      masterWxids: Array.isArray(d.persona?.master?.wxids) ? d.persona.master.wxids : [] };
  } catch { return { care: {}, tz: '', ownerName: '', masterWxids: [] }; }
}
/** 搭话时怎么称呼对方：主人用 config.persona.ownerName，别直呼微信昵称/备注（Identity） */
function addressName(targetName, wxid) {
  const cfg = readCareConfig();
  if (wxid && cfg.masterWxids.includes(wxid)) return cfg.ownerName || '主人';
  return targetName;
}
/** 解析 "08:30-09:30" 时间窗，判断当前分钟是否落在任一窗口内（含时区） */
function inCareWindow(windows, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const hh = Number(parts.find(p => p.type === 'hour').value) % 24;
    const mm = Number(parts.find(p => p.type === 'minute').value);
    const now = hh * 60 + mm;
    const list = Array.isArray(windows) && windows.length ? windows : ['00:00-24:00'];
    return list.some(w => {
      const m = String(w).match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
      if (!m) return false;
      const start = Number(m[1]) * 60 + Number(m[2]);
      const end = Number(m[3]) * 60 + Number(m[4]);
      return end >= start ? (now >= start && now < end) : (now >= start || now < end); // 跨午夜
    });
  } catch { return true; } // 算不出来就放行，别误伤
}
function todayKey(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return parts; // YYYY-MM-DD
  } catch { return new Date().toISOString().slice(0, 10); }
}

const SEARCH_MAX_TEXT = 1200;   // 注入提示词上限
const SEARCH_TIMEOUT = 6000;    // 搜索超时
const CARE_MAX_TEXT = 4000;     // 搭话文本上限
const CARE_TIMEOUT = 8000;      // care 接口超时
const INTEREST_TTL = 5 * 60 * 1000;
// ---- 被无视生气模块 ----
const IGNORE_WINDOW_DEFAULT = 20;         // 默认判定窗口（分钟），可在设置里改
const ANGRY_COOLDOWN_MS = 30 * 60 * 1000; // 生气后冷却，避免连续轰炸（固定30分钟）
/** 读取判定窗口（分钟→毫秒），设置项 ignoreWindowMinutes，范围1~240 */
function ignoreWindowMs(ctx) {
  const min = numSetting(ctx, 'ignoreWindowMinutes', IGNORE_WINDOW_DEFAULT, 1, 240);
  return min * 60 * 1000;
}

/** 读生气模块状态（与现有 state 共存，不冲掉限流字段） */
function readAngryState() {
  const s = readState();
  const ci = s.careIgnore || {};
  // 兼容旧版单条 pending
  let pending = Array.isArray(ci.pending) ? ci.pending : (ci.pending ? [ci.pending] : []);
  return {
    root: s,
    pending,                             // 待确认搭话数组（每条独立判定，不再互相覆盖）
    lastIgnored: ci.lastIgnored || null, // 最近一次被无视的搭话（供 timer.tick 生气用）
    streak: Number(ci.streak) || 0,
    lastAngryAt: Number(ci.lastAngryAt) || 0,
  };
}
function writeAngryState(st, patch) {
  const ci = {
    pending: patch.pending !== undefined ? patch.pending : st.pending,
    lastIgnored: patch.lastIgnored !== undefined ? patch.lastIgnored : st.lastIgnored,
    streak: patch.streak !== undefined ? patch.streak : st.streak,
    lastAngryAt: patch.lastAngryAt !== undefined ? patch.lastAngryAt : st.lastAngryAt,
  };
  writeState({ ...st.root, careIgnore: ci });
}
/** 发搭话后：追加一条待确认（每条独立，不再覆盖之前的） */
function markCareSent(chatId, targetWxid, text) {
  const st = readAngryState();
  const item = { at: Date.now(), chatId: String(chatId || ''),
    targetWxid: String(targetWxid || ''), name: nameForWxid(String(targetWxid || ''), loadContacts()),
    text: String(text || '').slice(0, 80) };
  const pending = st.pending.concat([item]).slice(-20); // 最多留20条，防止状态膨胀
  writeAngryState(st, { pending });
}
/**
 * 检查所有 pending：目标回话→删该条（并清零该目标的连续无视）；超时→删该条+streak++。
 * @param ctx 当前消息上下文（chat.prompt 用；timer.tick 传 null）
 * @returns {{streak, justBumped, replied}}
 */
function checkPending(ctx) {
  const st = readAngryState();
  if (!st.pending.length) return { streak: st.streak, justBumped: false, replied: false };
  const msg = ctx && ctx.message;
  const sender = msg && msg.senderId ? String(msg.senderId) : '';
  const now = Date.now();
  let pending = [], streak = st.streak, lastIgnored = st.lastIgnored;
  let replied = false, bumped = 0;

  for (const cur of st.pending) {
    // 目标本人回话了 → 删这条 + 该目标连续无视清零
    if (sender && sender === String(cur.targetWxid)) {
      replied = true;
      streak = 0;
      continue; // 不保留这条
    }
    // 超时且目标没回 → 这条算被无视，streak++
    if (now - Number(cur.at || 0) >= ignoreWindowMs(ctx)) {
      bumped += 1;
      streak += 1;
      lastIgnored = cur; // 最近一条被无视的（供生气发到对的地方）
      continue;
    }
    pending.push(cur); // 还在窗口内，保留
  }
  writeAngryState(st, { pending, streak, lastIgnored });
  return { streak, justBumped: bumped > 0, replied };
}
/** 是否该生气（开关 + 阈值 + 冷却） */
function shouldGetAngry(ctx, strength) {
  if (!boolSetting(ctx, 'enabled', true) || !boolSetting(ctx, 'angryEnabled', true)) return false;
  const threshold = Math.max(1, Math.min(10, numSetting(ctx, 'ignoreThreshold', 2, 1, 10)));
  if (strength < threshold) return false;
  const st = readAngryState();
  if (Date.now() - st.lastAngryAt < ANGRY_COOLDOWN_MS) return false;
  return true;
}
/** 生气后复位：streak 清零、记冷却时间 */
function markAngryDone() {
  const st = readAngryState();
  writeAngryState(st, { streak: 0, lastAngryAt: Date.now() });
}
/** 生气口吻注入 system（chat.prompt 用） */
const ANGRY_PROMPT = (n) => [
  '\n\n【现在很火大】你连续 ' + n + ' 次主动搭话都没人理，现在明显不爽、带脾气。',
  '这次回复要明显带怒气/不耐烦/嫌弃（按你人设的方式），别装没事、别客套。',
  '可以直接吐槽「又没人理我」「白搭话了」这种意思，但别骂脏话、别人身攻击。',
  '仍然要回答对方这条消息本身的问题，只是语气带火。',
].join('\n');

// ================= 分支 1：点名搭话 =================
// 原版单一正则（回滚后再做最小修正：动作词表补「聊聊天/聊天」，解决连写吞字）
const COMMAND_RE = /^\s*(?:去找|找|跟|和|搭话|关心一下|问候一下)\s*([\u4e00-\u9fa5A-Za-z0-9_\-]{1,24}?)\s*(?:聊聊天|聊天|搭话|聊聊|说句话|打个招呼|问好|聊一聊|说两句)?\s*[。！!？?~～]*\s*$/;
const TAIL_ACTION_RE = /(聊聊天|聊天|搭话|聊聊|说句话|打个招呼|问好|聊一聊|说两句)$/;
const NEGATE_RE = /怎么|为什么|什么|谁是|是不是|要不要|能不能|帮我查|搜索|百度|翻译|解释|意思|nghĩa/;
const BLOCK_IDS = /^(notifymessage|weixin|fmessage|medianote|floatbottle|gh_|filehelper|wxid_votjw5lxp0h929)/;

function loadContacts() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONTACTS, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(raw.items) ? raw.items : [];
  } catch { return []; }
}
function findTarget(nameWanted, items) {
  const wanted = String(nameWanted || '').trim().toLowerCase();
  if (!wanted) return null;
  const live = items.filter(c => c && c.wxid && !c.isGroup && !BLOCK_IDS.test(c.wxid));
  let hit = live.find(c =>
    String(c.remark || '').trim().toLowerCase() === wanted ||
    String(c.name || '').trim().toLowerCase() === wanted);
  if (!hit) hit = live.find(c =>
    String(c.remark || '').toLowerCase().includes(wanted) ||
    String(c.name || '').toLowerCase().includes(wanted));
  if (!hit) return null;
  const display = String(hit.remark || hit.name || '').trim();
  if (!display || BLOCK_IDS.test(display)) return null;
  return { wxid: hit.wxid, name: display };
}

/** 按 wxid 反查联系人的真实昵称/备注（给 whale.send 定位会话用） */
function nameForWxid(wxid, items) {
  const hit = (items || []).find(c => c && c.wxid === wxid);
  if (!hit) return '';
  return String(hit.remark || hit.name || hit.label || '').trim();
}
async function generateCare(wxid) {
  try {
    const resp = await whale.api('/api/care?chat=' + encodeURIComponent(wxid), { method: 'GET', timeoutMs: CARE_TIMEOUT });
    if (resp && resp.ok && resp.body && resp.body.text) {
      return { text: String(resp.body.text).trim(), mock: false, mode: 'care' };
    }
  } catch { /* 落内置兜底 */ }
  const templates = ['在干啥呢', '今天还好吗', '忙完了没'];
  return { text: templates[Math.floor(Math.random() * templates.length)], mock: true, mode: 'care' };
}

/** 读完整人设（回执要让模型按人设口吻自由发挥） */
function readPersona() {
  try {
    return JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch { return {}; }
}

/**
 * 用 model 按人设生成一条「自由发挥」的回执（告诉主人去找谁说了啥、说得怎样）。
 * 模型读完整人设 + 本次搭话的实际情况，自己组织口吻，不再写死模板。
 */
async function generateFreeReceipt(ctx, { targetName, text, mode, topic }) {
  try {
    const p = readPersona();
    const persona = String(p.customPrompt || p.text || '').slice(0, 5000);
    const name = String(p.name || '鲸鲸');
    const modeLine = mode === 'interest'
      ? `你挑了「${topic || '一个话题'}」当开场，说了句「${String(text).slice(0, 40)}」。`
      : `你说了句朴实的关心「${String(text).slice(0, 40)}」。`.replace('你说了句', '你简单说了句');
    const system = [
      persona ? persona + '\n\n---\n' : '',
      '现在是这个情况：主人刚才让你主动去找人搭话，你已经照做，消息发给对方了。',
      `你去找的是「${targetName}」。${modeLine}`,
      '现在你要跟主人汇报这件事——用你自己的口吻，一两句话，符合你的人设（该吐槽就吐槽，该傲娇就傲娇）。',
      '可以带点个人反应（比如提到话题、或抱怨又搭话了），但别编造对方回复了什么。',
      '只输出汇报这一句话本身，不要解释、不要列点、不要引号。',
      `（你的名字是${name}）`,
    ].join('\n');
    const raw = await whale.model({
      system,
      turns: [{ role: 'user', content: '去找人搭话这事，怎么样了？' }],
      maxTokens: 200,
    });
    let out = modelText(raw).trim();
    out = out.split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || '';
    out = out.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').replace(/[~～]+\s*$/g, '').trim();
    if (!out) return null;
    return out.slice(0, 200);
  } catch {
    return null; // 回执生成失败 → 调用方用固定兜底
  }
}

/** 从 model 返回里取文本（可能是字符串，也可能是 {text}/{content}） */
function modelText(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return String(raw.text || raw.content || '');
  return '';
}

/**
 * 兴趣搭话：搜一条薇薇人设兴趣的近况 → 让模型揉成一句自然的关心话。
 * 成功返回 {text, mode:'interest', topic}；任何一步失败返回 null，让调用方退回普通关心。
 */
async function generateInterestCare(ctx, targetName) {
  try {
    const interests = getInterests(ctx);
    if (!interests.length) return null;
    // 偏向人设里靠前（权重高）的兴趣，从前几个里随机挑一个
    const pool = interests.slice(0, Math.min(4, interests.length));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const topic = String(pick.word || '').trim();
    if (!topic) return null;

    // 优先直连 DeepSeek Search API 拿网页正文（细节丰富）；失败退回主程序 whale.search 摘要
    let material = '', withContent = false;
    const searchQuery = await buildSearchQueryAsync(topic);
    const direct = await deepSeekSearchWithContent(searchQuery, { count: 3 });
    if (direct && direct.material) { material = direct.material; withContent = direct.hasContent; }
    else {
      const r = await ctx.whale.search(`${topic} 最新消息`, { freshness: 'week', timeoutMs: SEARCH_TIMEOUT });
      if (r && r.status === 'ok' && r.text) material = String(r.text).slice(0, 240).replace(/\s+/g, ' ').trim();
    }
    if (!material) return null;

    // 揉成一句自然的搭话：有正文时强制引用一个具体细节，避免「有新消息」这种空话
    const system = [
      '你在微信上主动找人聊天，要像真人随手发的一句话。',
      `对方是「${targetName}」。别直呼微信昵称或备注名（如「Identity」这种）；需要称呼时用「${targetName}」或「主人」，`,
      '但不用每次都带称呼——像真人一样，很多时候直接说事、带句关心就行，自然就好。',
      withContent
        ? '下面是一篇文章的正文，挑里面一个具体的点（版本名、角色名、数字、活动、事件等）随口聊一句。'
        : '下面是一条刚看到的消息，自然地拿它当话题关心对方一句。',
      withContent
        ? '硬性要求：必须带一个正文里真实出现的细节，别写「有新消息」「最近怎么样」这种空话；不要编造正文里没有的东西。'
        : '要求：挑其中一点，别空泛。',
      '一句话，10~26 字；不要「据悉/据报道/最新消息」播报腔；不要自我介绍；不要问号堆砌；只输出这句话本身。',
    ].join('\n');
    const raw = await whale.model({ system, turns: [{ role: 'user', content: material }], maxTokens: 120 });
    let text = modelText(raw).trim();
    text = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || '';
    text = text.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').replace(/[~～]+\s*$/g, '').trim();
    text = text.slice(0, CARE_MAX_TEXT);
    if (!text) return null;
    return { text, mode: 'interest', topic, withContent };
  } catch {
    return null; // 搜索/生成任一失败 → 退回普通关心
  }
}

/**
 * 点名搭话（挂在 chat.generate）：
 *   搭话发给对方 → 记录到最近动态 → 用 model 按人设自由生成回执、发给主人
 *   → 返回 {text:''} 抑制主回复（避免重复）。
 * 两条消息都走 whale.send 的 reminders 队列，bridge 依次发，顺序天然保证，无需等待。
 * 返回 null 表示不是点名指令，交还宿主正常流程。
 */
async function handleCareDirect(ctx) {
  const msg = (ctx && ctx.message) || {};
  const raw = String(msg.text || '').trim();
  if (!raw || raw.length > 120) return null;
  if (msg.chatType === 'group') return null; // 群聊易误触发，只处理私聊
  if (NEGATE_RE.test(raw)) return null;
  const m = raw.match(COMMAND_RE);
  if (!m) return null;
  const targetName = m[1].replace(TAIL_ACTION_RE, '').trim();
  if (!targetName) return null;

  // 主人（回执接收方）= 当前发指令的人，用真实 senderId，不新建会话
  const ownerWxid = String(msg.senderId || '').trim();

  const target = findTarget(targetName, loadContacts());
  if (!target) {
    // 找不到人：不抑制主回复，让大肥鱼自己说「没找到」（返回 null 交还宿主）
    const st = readState(); const log = Array.isArray(st.log) ? st.log : [];
    log.unshift({ at: ctx.now || Date.now(), target: targetName, reason: 'not_found', sent: false });
    writeState({ ...st, log: log.slice(0, 50) });
    return null;
  }

  // 概率分叉：默认 80% 兴趣搜索搭话，20% 普通关心；兴趣失败自动退回普通关心
  const interestChance = numSetting(ctx, 'careInterestChance', 80, 0, 100);
  let generated = null;
  if (Math.random() * 100 < interestChance) {
    generated = await generateInterestCare(ctx, addressName(target.name, target.wxid));
  }
  if (!generated) generated = await generateCare(target.wxid);

  const finalText = String(generated.text || '').slice(0, CARE_MAX_TEXT).trim();
  let sent = false, err = '', deliveryId = '';
  try {
    const r = await whale.send({ chatId: target.wxid, name: target.name, text: finalText, type: 'text' });
    sent = !!(r && (r.status === 'queued' || r.status === 'submitted' || r.id));
    deliveryId = String((r && r.id) || '');
  } catch (e) { err = String(e && e.message || e); }

  // 被无视生气模块：记一条待确认（点名搭话）
  if (sent && boolSetting(ctx, 'angryEnabled', true)) markCareSent(msg.chatId, target.wxid, finalText);

  // 记进对方会话，让「最近动态」出现独立记录
  let recorded = false;
  if (sent && finalText) {
    try {
      const resp = await whale.api('/api/care/sent', {
        method: 'POST',
        body: { chat: target.wxid, text: finalText, group: false, id: deliveryId || ('plugin-' + Date.now()) },
      });
      recorded = !!(resp && resp.ok);
    } catch { /* 记录失败不影响已发出的消息 */ }
  }

  // 回执：model 按人设自由发挥，whale.send 发给主人（同一队列，排在搭话之后）
  let receiptSent = false, receiptText = '', receiptErr = '';
  if (ownerWxid && !BLOCK_IDS.test(ownerWxid)) {
    try {
      const free = await generateFreeReceipt(ctx,
        { targetName: addressName(target.name, target.wxid), text: finalText, mode: generated.mode, topic: generated.topic });
      const modeTag = generated.mode === 'interest' ? `（聊${generated.topic}）` : '';
      receiptText = free || (sent
        ? `已经去找${target.name}说过了：「${finalText.slice(0, 20)}」${modeTag}`
        : `想去找${target.name}说话，但没发出去（${err || '发送失败'}）`);
      // 关键：name 必须是主人自己的真实昵称（如 Identity），不能用机器人名字「大肥鱼」，
      // 否则 bridge 拿这个名字去微信搜会话会命中群里同名的，切错窗口 → 会话核对失败 → 回执发不出。
      const ownerName = nameForWxid(ownerWxid, loadContacts()) || '主人';
      const r2 = await whale.send({ chatId: ownerWxid, name: ownerName, text: receiptText, type: 'text' });
      receiptSent = !!(r2 && (r2.status === 'queued' || r2.status === 'submitted' || r2.id));
    } catch (e) { receiptErr = String(e && e.message || e); }
  }

  // 记一笔
  const st = readState();
  const log = Array.isArray(st.log) ? st.log : [];
  log.unshift({ at: ctx.now || Date.now(), target: target.name, wxid: target.wxid,
    text: finalText, mode: generated.mode, topic: generated.topic || '', withContent: !!generated.withContent,
    sent, recorded, receiptSent, receiptText, receiptErr, err });
  writeState({ ...st, log: log.slice(0, 50) });

  // 抑制主回复（回执已由插件发出，避免主人收到两条）；
  // 若回执没发成功，则放行主回复，让大肥鱼在主链路里补一句，避免主人啥也收不到。
  if (receiptSent) return { text: '' };
  return null;
}

// ================= 分支 2：搜索增强 =================
const FRESH_PATTERNS = [
  /最近|今天|今日|这周|本周|这几天|最新|现在|目前|刚|近期/i,
  /热搜|热点|新闻|新闻联播|热榜|热搜榜|头条|资讯/,
  /天气|气温|下雨|下雪|台风|降温|空气质量|温度|穿什么/,
  /多少钱|涨价|降价|股价|油价|金价|汇率|行情|价格/,
  /比赛|比分|赛程|谁赢|发布会|开幕|上映|开播|发售/,
];
const SKIP_PATTERNS = [/晚安|早安|睡了|吃了吗|你是谁|你谁|在吗|忙吗|干嘛呢|干啥呢/];

const SYNONYMS = {
  '动漫': ['动漫', '新番', '番剧', '追番', '二次元', '动画', '漫画', 'cos'],
  '二次元': ['二次元', '动漫', '新番', '番剧', 'cos', '漫展'],
  '游戏': ['游戏', '原神', '鸣潮', '王者', 'lol', 'steam', 'switch', '主机', '手游', '新游', '副本', '抽卡'],
  '电脑游戏': ['电脑游戏', 'steam', '单机', '主机游戏', '端游'],
  '科技': ['科技', '手机', '数码', 'ai', '芯片', '发布会', '新品', '汽车', '电车', '智能家居', 'iphone', '华为', '小米'],
  '电子设备': ['电子设备', '手机', '数码', '耳机', '电脑', '平板', '手表', '新品'],
  '投资': ['投资', '股票', 'a股', '美股', '基金', '期货', '大盘', '涨停', '跌停', '行情', '利好', '财报'],
  '股民': ['股票', 'a股', '美股', '大盘', '行情'],
  '电脑': ['电脑', '装机', '显卡', 'cpu', '数码'],
};

function readPersonaInterests() {
  let raw;
  try { raw = fs.readFileSync(PERSONA_FILE, 'utf8').replace(/^\uFEFF/, ''); } catch { return []; }
  let persona;
  try { persona = JSON.parse(raw); } catch { return []; }
  const fields = [persona.customPrompt, persona.interests, persona.hobbies, persona.interest, persona.hobby]
    .filter(Boolean).map(v => Array.isArray(v) ? v.join('\n') : String(v));
  const text = fields.join('\n');
  if (!text) return [];

  const out = [];
  const add = (s) => {
    let clean = String(s == null ? '' : s).trim();
    clean = clean.replace(/[（(][^）)]*权重[^）)]*[）)]/g, '');
    clean = clean.replace(/^(我|她|薇薇)?(很?喜欢|爱|爱好是?|感兴趣的是?|对|热衷于|平时(喜欢|爱)|爱玩|喜欢(玩|看|听|吃|聊)?)\s*/, '');
    clean = clean.replace(/^(玩|看|听|追|读|打|吃|喝|聊|逛|刷)\s*/, '');
    clean = clean.replace(/^[\s\-*·、,，:：。.|/]+|[\s\-*·、,，:：。.|/]+$/g, '').trim();
    if (clean.length < 2 || clean.length > 24) return;
    if (/^(什么|这个|那个|一点|一些|很多|等等|以及|和|跟|就行|无感|不感兴趣)$/.test(clean)) return;
    if (/不|无感|厌恶|讨厌|没兴趣/.test(clean)) return;
    if (out.some(o => o.word === clean)) return;
    const alias = new Set();
    for (const key of Object.keys(SYNONYMS)) {
      if (clean === key || clean.includes(key)) SYNONYMS[key].forEach(a => alias.add(a));
    }
    out.push({ word: clean, alias: [...alias].slice(0, 14) });
  };
  const weighted = [...text.matchAll(/喜欢([\s\S]{2,60}?)[（(][^）)]*权重\s*\d+\s*%[^）)]*[）)]/g)];
  weighted.forEach(m => m[1].split(/和|与|、|,|，|\/|以及/).forEach(add));
  const section = text.match(/(?:兴趣爱好?|爱好|我的兴趣|喜欢的东西|其他爱好)\s*[:：]?\s*([\s\S]*?)(?=\n\s*(?:[一二三四五六七八九十]+[、.]|-|【)|$)/i);
  if (section && section[1]) section[1].split(/[\n、,，;；|/]+/).forEach(add);
  const inline = text.match(/(?:喜欢|热爱|感兴趣的是|热衷于)([\u4e00-\u9fa5A-Za-z0-9]{2,12})/g) || [];
  inline.forEach(m => add(m.replace(/^(?:喜欢|热爱|感兴趣的是|热衷于)/, '')));
  return out.slice(0, 14);
}

let cachedInterests = null;
let cachedAt = 0;
function getInterests(ctx) {
  const now = ctx && ctx.now ? Number(ctx.now) : Date.now();
  if (cachedInterests && now - cachedAt < INTEREST_TTL) return cachedInterests;
  cachedInterests = readPersonaInterests();
  cachedAt = now;
  return cachedInterests;
}

function acquireSlot(ctx, minIntervalMin, maxPerHour) {
  const now = ctx && ctx.now ? Number(ctx.now) : Date.now();
  const st = readState();
  const last = Number(st.lastAt) || 0;
  if (now - last < minIntervalMin * 60 * 1000) {
    return { ok: false, reason: 'min_interval' };
  }
  const hourAgo = now - 3600000;
  const recent = Array.isArray(st.timestamps) ? st.timestamps.filter(t => Number(t) > hourAgo) : [];
  if (recent.length >= maxPerHour) return { ok: false, reason: 'max_per_hour' };
  recent.push(now);
  // 保留其他状态字段（如点名搭话 log）
  writeState({ ...st, lastAt: now, timestamps: recent });
  return { ok: true };
}

function buildQueries(text, interests) {
  const q = String(text || '').trim();
  const queries = [];
  const trimmed = q.slice(0, 120);
  const fresh = FRESH_PATTERNS.some(re => re.test(q));
  if (fresh && !SKIP_PATTERNS.some(re => re.test(q))) {
    queries.push({ query: trimmed, freshness: 'today', tag: 'fresh' });
  }
  const lower = q.toLowerCase();
  const matched = [];
  const seenHits = new Set();
  for (const it of interests) {
    const forms = [it.word, ...(it.alias || [])].filter(Boolean).map(s => String(s).toLowerCase());
    const hit = forms.filter(f => f.length >= 2 && lower.includes(f)).sort((a, b) => b.length - a.length)[0];
    if (hit && !seenHits.has(hit)) { seenHits.add(hit); matched.push({ word: it.word, hit }); }
  }
  for (const m of matched.slice(0, 2)) {
    queries.push({ query: `${m.hit} 最新消息`, freshness: 'week', tag: 'interest:' + m.word });
  }
  return queries;
}

function mergeSearch(results) {
  const items = [], texts = [];
  for (const r of results) {
    if (!r || r.status !== 'ok') continue;
    if (r.text) texts.push(String(r.text).trim());
    if (Array.isArray(r.items)) items.push(...r.items);
  }
  let text = texts.join('\n---\n').trim();
  if (text.length > SEARCH_MAX_TEXT) text = text.slice(0, SEARCH_MAX_TEXT) + '…';
  return { status: 'ok', reason: 'smart_search', text, items: items.slice(0, 12), elapsedMs: 0 };
}

/** 搜索增强分支：命中返回资料，不命中/限流/失败返回 null */
async function handleSearchBoost(ctx, text) {
  const minInterval = numSetting(ctx, 'minIntervalMinutes', 30, 0, 1440);
  const maxPerHour = numSetting(ctx, 'maxPerHour', 4, 1, 60);
  const queries = buildQueries(text, getInterests(ctx));
  if (!queries.length) return null;
  if (!acquireSlot(ctx, minInterval, maxPerHour).ok) return null;

  const results = [];
  for (const q of queries) {
    try {
      results.push(await ctx.whale.search(q.query, { freshness: q.freshness, timeoutMs: SEARCH_TIMEOUT }));
    } catch { /* 单条失败不影响整体 */ }
  }
  const merged = mergeSearch(results);
  if (!merged.text) return null; // 全失败：交还宿主，绝不注入空资料
  return { search: merged };
}

// ================= 定时主动搭话（timer.tick，读本体配置 + 共享账本）=================
/**
 * 本体 care 一行不改：插件按本体 config.care 的时间窗/频率/白名单自己判定，
 * 到点按兴趣搜索生成搭话发给目标，并把次数写回与 bridge 共享的 care-state.json，
 * 让本体下轮读到后自动少发（偶发重复可接受）。
 */
async function handleAutoCare(ctx) {
  // 开关：定时搭话独立开关（autoCare），默认开；总开关 enabled 也要开
  if (!boolSetting(ctx, 'enabled', true) || !boolSetting(ctx, 'autoCare', true)) return;

  const { care, tz } = readCareConfig();
  if (care.enabled === false) return; // 本体总开关关了，尊重它

  const now = Date.now();
  // 1) 时间窗判定
  if (!inCareWindow(care.windows, tz)) return;

  // 2) 读共享账本（count 用于共享每日额度；lastTs 不用于间隔判定——那是本体的，我们预支了未来时间）
  const st = readCareState();
  const today = todayKey(tz);
  const isToday = String(st.day || '') === today;
  let sentToday = isToday ? (Number(st.count) || 0) : 0;

  // 3) 每日上限
  const maxPerDay = Number(care.maxPerDay);
  if (Number.isFinite(maxPerDay) && maxPerDay > 0 && sentToday >= maxPerDay) return;

  // 4) 间隔判定用插件自己的时间戳（独立节奏），不读共享 lastTs：
  //    因为插件写共享账本时会预支 +10min 把 lastTs 推到未来，若用它判定会把自己也挡住。
  const myState = readState();
  const myLastTs = Number(myState.autoLastTs) || 0;
  const every = Number(care.everyMinutes);
  const jitter = Number(care.jitterMinutes) || 0;
  const gapMin = Math.max(1, (Number.isFinite(every) ? every : 90) + Math.random() * jitter);
  if (myLastTs && now - myLastTs < gapMin * 60000) return;

  // 5) 选目标：从本体白名单挑（排除机器人自己），优先挑最久没说话的
  const whitelist = Array.isArray(care.whitelist) ? care.whitelist : [];
  const contacts = loadContacts();
  const byWxid = new Map(contacts.map(c => [c.wxid, c]));
  const candidates = whitelist
    .map(w => String(w).trim())
    .filter(w => w && !BLOCK_IDS.test(w) && !/^\w+@chatroom$/.test(w)) // 先只挑私聊，群另说
    .map(w => {
      const c = byWxid.get(w) || {};
      const name = String(c.remark || c.name || c.label || '').trim();
      return { wxid: w, name, lastAt: Number(c.lastAt) || 0 };
    })
    .filter(t => t.name);
  if (!candidates.length) return;
  candidates.sort((a, b) => a.lastAt - b.lastAt); // 最久没聊的优先
  const target = candidates[0];

  // 6) 生成搭话：和点名共用同一概率设置（默认 80% 兴趣带话题，20% 普通关心）
  const interestChance = numSetting(ctx, 'careInterestChance', 80, 0, 100);
  let generated = null;
  if (Math.random() * 100 < interestChance) generated = await generateInterestCare(ctx, addressName(target.name, target.wxid));
  if (!generated) generated = await generateCare(target.wxid);
  const finalText = String(generated.text || '').slice(0, CARE_MAX_TEXT).trim();
  if (!finalText) return;

  // 7) 发给目标（name 用真实昵称，避免切错会话）
  let sent = false, deliveryId = '', err = '';
  try {
    const r = await whale.send({ chatId: target.wxid, name: target.name, text: finalText, type: 'text' });
    sent = !!(r && (r.status === 'queued' || r.status === 'submitted' || r.id));
    deliveryId = String((r && r.id) || '');
  } catch (e) { err = String(e && e.message || e); }
  if (!sent) return; // 失败不记账（本体同理）

  // 被无视生气模块：记一条待确认（定时搭话）
  if (boolSetting(ctx, 'angryEnabled', true)) markCareSent(target.wxid, target.wxid, finalText);

  // 8) 写回共享账本：count+1（共享额度），lastTs 预支 +10min 把本体推后，
  //    这样无论本体间隔是 5min 还是 90min，插件总能按自己的节奏抢先（预支>>间隔差）。
  const LEAD_MIN = 10;
  writeCareState({ ...st, lastTs: Math.floor(now / 1000) + LEAD_MIN * 60, day: today, count: sentToday + 1 });
  // 插件自己的节奏时间戳（真实发送时间，不预支），用于间隔判定
  try {
    const ps = readState();
    writeState({ ...ps, autoLastTs: now });
  } catch { /* 记节奏失败只影响精度 */ }

  // 9) 记一条到 store，最近动态可见（插件自己记，不等本体）
  try {
    await whale.api('/api/care/sent', {
      method: 'POST',
      body: { chat: target.wxid, text: finalText, group: false, id: deliveryId || ('plugin-auto-' + now) },
    });
  } catch { /* 记账失败不影响已发消息 */ }

  // 10) 插件自己的 log（记在 autoLog，不混进点名 log）
  try {
    const ps = readState();
    const autoLog = Array.isArray(ps.autoLog) ? ps.autoLog : [];
    autoLog.unshift({ at: now, target: target.name, wxid: target.wxid, text: finalText,
      mode: generated.mode, topic: generated.topic || '', withContent: !!generated.withContent, count: sentToday + 1 });
    writeState({ ...ps, autoLog: autoLog.slice(0, 50) });
  } catch { /* 记日志失败不影响发送 */ }
}

// ================= 被无视生气②：timer.tick 兜底主动发 =================
/** 连续 N 次搭话被无视、且宿主没触发 chat.prompt 生气时，主动发一句生气话到原会话 */
async function handleAngryTick(ctx) {
  if (!boolSetting(ctx, 'enabled', true) || !boolSetting(ctx, 'angryEnabled', true)) return;
  const chk = checkPending(ctx); // 定时无当前消息，只判定超时（ctx 带 settings 用于读窗口）
  const threshold = Math.max(1, Math.min(10, numSetting(ctx, 'ignoreThreshold', 2, 1, 10)));
  if (chk.streak < threshold || !shouldGetAngry(ctx, chk.streak)) return;

  const st = readAngryState();
  const ignored = st.lastIgnored || {};
  const targetChat = String(ignored.chatId || ignored.targetWxid || '');
  const targetName = String(ignored.name || nameForWxid(ignored.targetWxid || '', loadContacts()) || '好友');

  // 生成生气话（按人设）
  let text = '';
  try {
    const p = readPersona();
    const persona = String(p.customPrompt || p.text || '').slice(0, 5000);
    const system = [
      persona ? persona + '\n\n---\n' : '',
      `你连续 ${chk.streak} 次主动找人搭话都没人理，现在很火大、带脾气。`,
      '写一句微信消息，吐槽「又没人理我 / 白搭话了」这种意思，符合你的人设（毒舌/傲娇/不爽都行）。',
      '一句话，8~30 字；别骂脏话、别人身攻击；只输出这句话本身。',
    ].join('\n');
    const raw = await whale.model({ system, turns: [{ role: 'user', content: '说一句你的不满' }], maxTokens: 120 });
    text = modelText(raw).trim().split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || '';
    text = text.replace(/^["'“”‘’「」]+|["'“”‘’」]+$/g, '').slice(0, 200);
  } catch { /* 生成失败用固定兜底 */ }
  if (!text) text = `不是，我又白搭话了是吧，${chk.streak} 次没人理，行。`.slice(0, 200);
  if (!targetChat || BLOCK_IDS.test(targetChat)) { markAngryDone(); return; }

  try {
    await whale.send({ chatId: targetChat, name: targetName || '好友', text, type: 'text' });
  } catch { /* 发送失败不影响其它 */ }
  markAngryDone();
}

// ---------------- 钩子 ----------------
exports.hooks = {
  // 被无视生气①：宿主决定回复时，检查 pending（目标回话→清零 / 超时→streak++），达阈值注入怒气口吻
  'chat.prompt': async function (ctx) {
    try {
      if (!boolSetting(ctx, 'enabled', true) || !boolSetting(ctx, 'angryEnabled', true)) return {};
      const chk = checkPending(ctx);
      const threshold = Math.max(1, Math.min(10, numSetting(ctx, 'ignoreThreshold', 2, 1, 10)));
      if (chk.streak >= threshold && shouldGetAngry(ctx, chk.streak)) {
        markAngryDone(); // 只生气一次（timer.tick 的冷却+清零防重复）
        const base = String((ctx && ctx.system) || '');
        return { system: base + ANGRY_PROMPT(chk.streak) };
      }
      return {};
    } catch { return {}; }
  },
  // 定时主动搭话：读本体 config.care 时间窗 + 共享 care-state 账本，到点发一条带话题的
  'timer.tick': async function (ctx) {
    try { await handleAutoCare(ctx); } catch { /* 定时异常不影响宿主 */ }
    try { await handleAngryTick(ctx); } catch { /* 生气异常不影响宿主 */ }
    return {}; // timer.tick 返回对象（返回 null 会 plugin_error）
  },
  // 点名搭话：必须在 chat.generate 处理（只有这里返回空文本能抑制主回复，避免重复回执）
  'chat.generate': async function (ctx) {
    try {
      if (!boolSetting(ctx, 'enabled', true)) return undefined;
      const out = await handleCareDirect(ctx);
      // 关键：宿主只允许 hook 返回对象或 undefined；返回 null 会触发 invalid_output/plugin_error。
      // 命中指令 → {text:''} 抑制主回复；未命中/失败 → undefined 交还宿主。
      return out && typeof out === 'object' ? out : undefined;
    } catch {
      return undefined; // 异常交还宿主正常回复
    }
  },
  // 搜索增强：只在 chat.search（点名指令已被 chat.generate 拦截并 ignore，不会走到这）
  'chat.search': async function (ctx) {
    try {
      if (!boolSetting(ctx, 'enabled', true)) return {};
      const text = String((ctx && ctx.message && ctx.message.text) || '').trim();
      if (!text) return {};
      const boost = await handleSearchBoost(ctx, text);
      if (boost) return boost;
      return {};
    } catch {
      return {}; // 任何异常都退回宿主默认行为
    }
  },
};
