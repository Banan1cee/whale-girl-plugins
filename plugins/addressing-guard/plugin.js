'use strict';

/**
 * addressing-guard —— 对话归属识别
 *
 * 群聊里机器人开了「接话窗口」（有人 @ 过她，之后 windowMs 内不用再 @ 也能回）时，
 * 判断当前这句指的是机器人，还是群里另一个人：
 *   - 对机器人说 → 放行（宿主正常回复）
 *   - 对别人说   → skip（不插嘴）
 *
 * 判定 7 步（与需求文档 六.2 一致，第 4 步按复核第 3 轮意见改为不依赖反推）：
 *   0. settings.enabled === false            → 放行 {}
 *   1. chatType !== 'group'                  → 放行
 *   2. atMe 或 replyToBot                    → 放行（明确在叫她，绝不拦）
 *   3. 正文含 botNames 任一名字               → 放行
 *   4. 快筛：含「你/咱」 或 含疑问词 或 ≤30 字 → 才判归属，否则放行
 *        （不再用「她上次接话的同一人」当门槛：assistant 消息没有「回复给谁」
 *          字段，history 反推不可靠，会把「接别人话头」的短句漏掉）
 *   5. 无 lastBot 或 超出 windowMs            → 放行（窗口外交回宿主，不 skip）
 *      （默认 360000 = 6 分钟，与宿主 group.engagedMinutes 默认值对齐，
 *        否则 3~6 分钟之间 engaged 分支仍会唤醒、插件却不判）
 *   6. 调 sdk.model() 判 BOT / OTHER / UNSURE：
 *        BOT    → 放行
 *        OTHER  → skip
 *        UNSURE → 放行（宁可不拦，不能误拦）
 *        异常/超时 → 放行 + 记 state
 *   7. 判定结果写缓存（state 落盘，键 = key|senderId|text 哈希）
 *
 * 保护措施：模型调用有超时（modelTimeoutMs）、连续失败 3 次熔断 5 分钟、
 * 缓存最多 100 条（TTL cacheTtlMs，超了丢最旧）。
 *
 * 注意：
 *   - 插件拿不到说话人昵称（宿主 ctx 只有 uid），提示词里用稳定匿名编号（id1/id2…）
 *     和 wxid 前缀代替名字；机器人用 botNames[0] 标识。
 *   - 「她上次接话的对象」由 history 反推（最后一条 assistant 之前最近一条 user 的 uid），
 *     只用于提示词上下文，不再作为是否调模型的门槛。
 *   - 缓存/熔断都放 state（宿主落盘），不用模块级变量。
 */

const DEFAULTS = {
  enabled: true,
  botNames: '鲸鲸,小鲸,大肥鱼,鲸鱼娘',
  windowMs: 360000,
  modelTimeoutMs: 12000,
  useModel: true,
  cacheTtlMs: 600000,
};

const CACHE_LIMIT = 100;
const BREAKER_FAILS = 3;
const BREAKER_MS = 300000;
const SHORT_LEN = 30;
// 与宿主 trigger.js 的两条唤醒条件保持一致
const YOU_RE = /你|咱/;
const QUESTION_RE = /[?？]|吗|呢|怎么|为什么|啥|多少|几点|谁|哪|是不是|能不能|要不要/;

/** 兼容数组和逗号分隔字符串（启动器设置是裸 JSON 文本框，用户可能写成字符串）。 */
function toList(v) {
  if (Array.isArray(v)) {
    return v.map(String).map((s) => s.trim()).filter(Boolean);
  }
  return String(v == null ? '' : v)
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v) { return String(v == null ? '' : v); }

function cfgOf(ctx) {
  const s = (ctx && ctx.settings && typeof ctx.settings === 'object') ? ctx.settings : {};
  return {
    enabled: s.enabled !== false,
    botNames: toList(s.botNames !== undefined ? s.botNames : DEFAULTS.botNames),
    windowMs: Math.max(0, num(s.windowMs, DEFAULTS.windowMs)),
    modelTimeoutMs: Math.max(500, num(s.modelTimeoutMs, DEFAULTS.modelTimeoutMs)),
    useModel: s.useModel !== false,
    cacheTtlMs: Math.max(1000, num(s.cacheTtlMs, DEFAULTS.cacheTtlMs)),
  };
}

/** 宿主把 SDK 以 whale/host 注入 ctx，测试环境则直接传 ctx.whale/ctx.sdk。 */
function sdkOf(ctx) {
  if (ctx && ctx.whale && typeof ctx.whale.model === 'function') return ctx.whale;
  if (ctx && ctx.host && typeof ctx.host.model === 'function') return ctx.host;
  if (ctx && ctx.sdk && typeof ctx.sdk.model === 'function') return ctx.sdk;
  try {
    const whale = require('whale');
    if (whale && typeof whale.model === 'function') return whale;
  } catch { /* 测试环境没有宿主 SDK */ }
  return null;
}

/** djb2 哈希（缓存键用）。 */
function hashKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/** 从历史反推「她上次接的是谁的话」：最后一条 assistant 之前最近一条 user 的 uid。 */
function engagedWithOf(history) {
  const rows = Array.isArray(history) ? history : [];
  let botIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i] && rows[i].role === 'assistant') { botIdx = i; break; }
  }
  if (botIdx < 0) return '';
  for (let i = botIdx - 1; i >= 0; i--) {
    if (rows[i] && rows[i].role === 'user' && str(rows[i].uid)) return str(rows[i].uid);
  }
  return '';
}

/** 给历史里的每个 uid 分配稳定匿名编号；assistant 用机器人名。 */
function labelMapOf(history, senderId, botName) {
  const labels = new Map();
  let n = 0;
  const labelOf = (uid) => {
    if (!uid) return botName;
    let l = labels.get(uid);
    if (!l) { l = 'id' + (++n); labels.set(uid, l); }
    return l;
  };
  (history || []).forEach((h) => {
    if (h && h.role !== 'assistant' && str(h.uid)) labelOf(str(h.uid));
  });
  const senderLabel = labelOf(str(senderId));
  const members = [];
  labels.forEach((label, uid) => { members.push(label + '（' + uid.slice(0, 16) + '）'); });
  return { labelOf, senderLabel, members: members.join('、') };
}

/** 最近 8 条对话，一行一条；若最后一条就是当前消息（宿主可能已入库）则去掉。 */
function buildLines(history, botName, labelOf, sender, currentText) {
  const rows = (history || [])
    .filter((h) => h && str(h.text))
    .slice(-8)
    .map((h) => {
      const label = h.role === 'assistant' ? botName : (str(h.uid) ? labelOf(str(h.uid)) : '某人');
      return '[' + label + '] ' + str(h.text).slice(0, 60);
    });
  const dup = '[' + labelOf(str(sender)) + '] ' + currentText.slice(0, 60);
  if (rows[rows.length - 1] === dup) rows.pop();
  return rows.join('\n');
}

function buildSystem(cfg, senderLabel, senderId, members, botName, lastBotText, engagedLabel) {
  return [
    '你在判断微信群里的一句话「你」指的是谁。只看事实，不要客套。',
    '',
    '群成员名单：' + (members || '（未知）'),
    '机器人的名字：' + cfg.botNames.join('、'),
    '机器人刚才说的话：「' + lastBotText + '」',
    '她上次接话的对象：' + (engagedLabel || '不明'),
    '当前说话人：' + senderLabel + '（' + str(senderId) + '）',
    '',
    '判断依据：看这句话在接谁的话头、问的是谁、答的是谁。',
    '注意：如果这句话在回应「机器人刚才说的话」，就是 BOT；',
    '如果它接的是群里另一个人的话题（哪怕机器人也说过话），就是 OTHER。',
    '',
    '请回答一个词：',
    '- BOT   —— 这句话是在跟机器人说（问它、答它、怼它、让它做事）',
    '- OTHER —— 这句话是在跟群里其他人说（接别人的话头、问别人、答别人）',
    '- UNSURE —— 判断不了',
    '',
    '只输出 BOT / OTHER / UNSURE 其中一个词，不要解释，不要标点。',
  ].join('\n');
}

function parseVerdict(answer) {
  const m = /\b(BOT|OTHER|UNSURE)\b/.exec(str(answer).toUpperCase());
  return m ? m[1] : 'UNSURE';
}

/** 模型调用加超时，超时或异常都按失败处理。 */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('model_timeout')), ms); }),
  ]).then((v) => { clearTimeout(timer); return v; }, (e) => { clearTimeout(timer); throw e; });
}

function stateOf(ctx) {
  const s = ctx && ctx.state;
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

/** 缓存最多 CACHE_LIMIT 条，超了丢最旧（按 at）。 */
function bumpCache(state, ck, verdict, now) {
  const cache = Object.assign({}, state.cache || {});
  cache[ck] = { v: verdict, at: now };
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
    keys.slice(0, keys.length - CACHE_LIMIT).forEach((k) => { delete cache[k]; });
  }
  state.cache = cache;
}

function breakerPass(state, key, now) {
  const b = state.breaker && state.breaker[key];
  return Boolean(b && num(b.until, 0) > now);
}

/** 连续失败 BREAKER_FAILS 次 → 熔断 BREAKER_MS 毫秒，期间不再调模型。 */
function breakerFail(state, key, now) {
  const breaker = Object.assign({}, state.breaker || {});
  const b = breaker[key] || { fails: 0, until: 0 };
  b.fails = num(b.fails, 0) + 1;
  if (b.fails >= BREAKER_FAILS) { b.until = now + BREAKER_MS; b.fails = 0; }
  breaker[key] = b;
  state.breaker = breaker;
}

function breakerOk(state, key) {
  const breaker = Object.assign({}, state.breaker || {});
  if (breaker[key]) delete breaker[key];
  state.breaker = breaker;
}

async function decide(ctx) {
  const cfg = cfgOf(ctx);
  if (!cfg.enabled) return {};                                       // 第 0 步：总开关

  const m = (ctx && ctx.message) || {};
  if (str(m.chatType) !== 'group') return {};                        // 第 1 步：只管群聊
  if (m.atMe || m.replyToBot) return {};                             // 第 2 步：明确在叫她

  const text = str(m.text);
  if (cfg.botNames.some((n) => n && text.includes(n))) return {};    // 第 3 步：点名了

  const sender = str(m.senderId);
  const history = Array.isArray(ctx.history) ? ctx.history : [];
  const now = Number(ctx && ctx.now) || Date.now();
  const lastBot = (ctx && ctx.lastBot) || null;
  const botAt = lastBot ? num(lastBot.at, 0) : 0;

  // 第 4 步：快筛 —— 窗口内只要可能被她接的话，就调模型判归属
  //   含「你/咱」（followup 路，trigger.js:88）
  //   或 疑问句 / ≤30 字（engaged 路，trigger.js:65-82）
  //   不用「她上次接话的同一人」当门槛：assistant 消息没有「回复给谁」字段，
  //   history 反推会把「接别人话头」的短句漏掉（场景 2/3 就是这么漏的）。
  const engagedWith = engagedWithOf(history);
  const hasYou = YOU_RE.test(text);
  const needJudge = hasYou || QUESTION_RE.test(text) || text.length <= SHORT_LEN;
  if (!needJudge) return {};

  // 第 5 步：接话窗口 —— 窗口外交回宿主（放行，不 skip）
  if (!botAt) return {};
  if (now - botAt >= cfg.windowMs) return {};

  if (!cfg.useModel) return {};                                      // 只做快筛模式

  const botName = cfg.botNames[0] || '机器人';
  const { labelOf, senderLabel, members } = labelMapOf(history, sender, botName);
  const engagedLabel = engagedWith ? labelOf(engagedWith) : '不明';
  const lines = buildLines(history, botName, labelOf, sender, text);
  const system = buildSystem(cfg, senderLabel, sender, members, botName,
    str(lastBot.text).slice(0, 80), engagedLabel);

  const state = stateOf(ctx);
  const ck = hashKey(str(ctx.key) + '|' + sender + '|' + text);
  const cached = state.cache && state.cache[ck];
  if (cached && num(cached.at, 0) > 0 && now - num(cached.at, 0) < cfg.cacheTtlMs) {
    if (cached.v === 'OTHER') {
      return { action: 'skip', state: Object.assign({}, state, { last: { why: 'model_other_cached', at: now } }) };
    }
    return {};                                                       // BOT/UNSURE 缓存 → 放行
  }

  if (breakerPass(state, str(ctx.key), now)) return {};              // 熔断中 → 放行

  const sdk = sdkOf(ctx);
  let verdict = 'UNSURE';
  let failure = null;
  if (sdk) {
    try {                                                            // 第 6 步：模型判定
      const answer = await withTimeout(sdk.model({
        system: system,
        turns: [{ role: 'user', content: '最近几条对话：\n' + lines + '\n\n最后这句：' + text }],
        maxTokens: 16,
      }), cfg.modelTimeoutMs);
      verdict = parseVerdict(answer);
    } catch (err) {
      failure = str(err && err.message ? err.message : err) || 'model_error';
      verdict = 'UNSURE';
    }
  } else {
    failure = 'no_sdk';
  }

  const next = Object.assign({}, state);
  if (failure) {
    breakerFail(next, str(ctx.key), now);
    next.last = { why: 'model_failed', err: failure, at: now };
  } else {
    breakerOk(next, str(ctx.key));
    next.last = { why: 'model_' + verdict.toLowerCase(), at: now };
  }
  bumpCache(next, ck, verdict, now);                                 // 第 7 步：写缓存

  if (verdict === 'OTHER') return { action: 'skip', state: next };
  return { state: next };                                            // BOT/UNSURE/失败 → 放行
}

exports.hooks = { 'chat.pre_reply': decide };
exports.decide = decide;
exports.DEFAULTS = DEFAULTS;
exports.toList = toList;
