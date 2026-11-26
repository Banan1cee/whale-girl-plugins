'use strict';
/**
 * 锐评（ruiping）· whale-plugin/1 / 4 级 node-full
 *
 * 旧 Api 4 的 chat.search / chat.pre_reply / chat.generate / tool.run 迁移：
 *   - chat.search@1 (replace)：命中关键词时检索并返回 {text,items,status}
 *   - chat.pre_reply@1 (gate)：wake=true 且命中时返回 wake，否则 pass
 *   - chat.generate@1 (replace)：复用本轮搜索缓存或重新检索，生成固定格式锐评
 *   - tool.run@1：卡片手动运行，返回完整 JSON 诊断
 *
 * 宿主的 search.query@1 / model.complete@1 通过 context.host.call 调用；
 * 插件不联网、不监听端口、不调用 /api/*。
 * 新协议没有 provider/attempts/dateFilter/thinking，相关展示/参数已删；
 * replace 是独占模式，与其它 chat.search/chat.generate 插件互斥。
 *
 * 搜索上下文为什么要落文件：chat.search@1 与 chat.generate@1 是两次独立 invocation，
 * 4 级 worker 每次调用都是新进程，模块级 Map 跨不过去；chat.generate.input 的 turns
 * 只是聊天历史，宿主把搜索结果拼成散文塞进最后一条 user 消息，已经拿不回 items。
 * 因此同一轮用 worker 私有 cwd 的文件缓存（键=chatType+chatId+text，可选 senderId/msgId
 * 同时存在时再校验），3 分钟 TTL、最多 16 条、取一次即删。
 */

const fs = require('node:fs');
const path = require('node:path');

const VERSION = '2.0.2';
const MAX_TOPIC = 200;
const MAX_CHAT_TEXT = 1200;

const MODES = ['金句', '暴论'];
const FRESHNESS = ['', 'today', 'yesterday', 'week', 'month', 'year'];
const DEFAULT_KEYWORDS = ['锐评', '暴论'];

// 4.1.6 搜索 API 的两个渠道；zhihu 是问答观点，不能当事实用。
const API_PROVIDERS = ['deepseek', 'zhihu'];
const PROVIDER_LABELS = {
  deepseek: 'DeepSeek 搜索',
  zhihu: '知乎',
  bing: 'Bing',
  '360': '360 搜索',
  sogou: '搜狗',
  google: 'Google',
  web: '本地搜索',
};

// 与宿主同源的清洗规则：控制字符、零宽字符、@所有人，一律不许进入回复。
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const MENTION_ALL = /[@＠][\s\u200B-\u200D\u2060\uFEFF]*(?:所有人|全体成员|all)(?![\p{L}\p{N}.])/iu;

const DEFAULTS = Object.freeze({
  schemaVersion: 1,
  mode: '金句',
  maxChars: 40,
  facts: 2,
  minItems: 2,
  freshness: '',
  timeZone: 'Asia/Shanghai',
  inChat: true,
  wake: false,
  showSources: true,
  showProvider: true,
  evidenceItems: 4,
  searchTimeoutMs: 12000,
  modelMaxTokens: 700,
  thinking: false,
  keywords: DEFAULT_KEYWORDS,
});

const MODE_HINT = {
  金句: '一句能截图转发的金句：先给结论，再留一个反转或对照；短、硬、有画面。',
  暴论: '一句暴论：断言式下结论，敢用强判断和反差；只打事件、决策和结果，不碰个人的人身属性。',
};

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function int(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function text(value, max) {
  return String(value == null ? '' : value).replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeSettings(settings) {
  const raw = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const keywordSource = Array.isArray(raw.keywords) ? raw.keywords
    : typeof raw.keywords === 'string' ? raw.keywords.split(/[,，\s]+/) : DEFAULTS.keywords;
  const keywords = keywordSource
    .filter(word => typeof word === 'string' && word.trim())
    .map(word => word.trim().slice(0, 12))
    .slice(0, 8);
  return {
    schemaVersion: int(raw.schemaVersion, 0, 99, DEFAULTS.schemaVersion),
    mode: MODES.includes(raw.mode) ? raw.mode : DEFAULTS.mode,
    maxChars: int(raw.maxChars, 12, 120, DEFAULTS.maxChars),
    facts: int(raw.facts, 1, 4, DEFAULTS.facts),
    minItems: int(raw.minItems, 1, 6, DEFAULTS.minItems),
    freshness: FRESHNESS.includes(raw.freshness) ? raw.freshness : DEFAULTS.freshness,
    timeZone: timeZone(raw.timeZone),
    inChat: bool(raw.inChat, DEFAULTS.inChat),
    wake: bool(raw.wake, DEFAULTS.wake),
    showSources: bool(raw.showSources, DEFAULTS.showSources),
    showProvider: bool(raw.showProvider, DEFAULTS.showProvider),
    evidenceItems: int(raw.evidenceItems, 1, 8, DEFAULTS.evidenceItems),
    searchTimeoutMs: int(raw.searchTimeoutMs, 1000, 30000, DEFAULTS.searchTimeoutMs),
    modelMaxTokens: int(raw.modelMaxTokens, 100, 4000, DEFAULTS.modelMaxTokens),
    thinking: bool(raw.thinking, DEFAULTS.thinking),
    keywords: keywords.length ? keywords : DEFAULT_KEYWORDS.slice(),
  };
}

function timeZone(value) {
  const zone = typeof value === 'string' ? value.trim() : '';
  if (!zone || zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return DEFAULTS.timeZone;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return DEFAULTS.timeZone;
  }
}

function todayIn(zone, nowMs) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

function shiftDay(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

const DAY_HINTS = [
  [/昨天|昨日|昨晚/, -1],
  [/前天|前晚/, -2],
  [/今天|今日|今晚|刚刚|刚才/, 0],
];

function dateHint(allText, settings, nowMs) {
  const day = todayIn(settings.timeZone, nowMs);
  for (const [pattern, offset] of DAY_HINTS) {
    if (pattern.test(allText)) {
      const date = shiftDay(day, offset);
      return { dateRange: { start: date, end: date }, freshness: '' };
    }
  }
  if (/本周|这周|最近一周|近一周|一周内|这几天/.test(allText)) return { dateRange: null, freshness: 'week' };
  if (/本月|这个月|最近一月|近一月|这一个月/.test(allText)) return { dateRange: null, freshness: 'month' };
  if (/去年|最近一年|近一年/.test(allText)) return { dateRange: null, freshness: 'year' };
  return { dateRange: null, freshness: settings.freshness || '' };
}

function stripTimeWords(value) {
  return String(value == null ? '' : value)
    .replace(/^(?:昨天|昨日|昨晚|今天|今日|今晚|前天|前晚|刚才|刚刚)\s*/, '')
    .trim();
}

function findKeyword(allText, keywords) {
  const sorted = keywords.slice().sort((a, b) => b.length - a.length);
  let hit = null;
  for (const word of sorted) {
    const at = allText.indexOf(word);
    if (at < 0) continue;
    if (!hit || at < hit.at) hit = { word, at };
  }
  return hit;
}

function cleanTopic(value) {
  return stripTimeWords(String(value == null ? '' : value))
    .replace(/^[\s：:，,、。.!！?？~～—\-]+/, '')
    .replace(/[\s。！!？?~～]+$/, '')
    .trim()
    .slice(0, MAX_TOPIC);
}

/**
 * 从聊天文本里识别锐评请求；没有关键词就返回 null，让宿主保持原样。
 */
function parseRequest(messageText, settings, nowMs = Date.now()) {
  const config = normalizeSettings(settings);
  const raw = String(messageText == null ? '' : messageText)
    .replace(/[\u200B-\u200D\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw || raw.length > 2000) return null;
  const hit = findKeyword(raw, config.keywords);
  if (!hit) return null;
  let rest = raw.slice(hit.at + hit.word.length).replace(/^[\s：:，,、。.!！?？~～—\-]+/, '');
  rest = rest.replace(/^(?:一下|下|一嘴|两句|几句|一段|一个|这个|这条|此事|这件事)\s*/, '');
  rest = rest.replace(/(?:吧|呗|啊|呀|哈|嘛|谢谢|说说你的看法|你怎么看|你怎么评价|有什么看法|怎么评价|评价一下|给个评价|来两句)[\s。！!？?~～]*$/g, '');
  const topic = cleanTopic(rest);
  const dates = dateHint(raw, config, nowMs);
  const mode = /暴论|开炮|上强度|得罪/.test(raw) ? '暴论' : config.mode;
  if (!topic || topic.length < 2) {
    return { keyword: hit.word, topic: '', display: raw.slice(0, MAX_TOPIC), mode,
      dateRange: dates.dateRange, freshness: dates.freshness, missingTopic: true };
  }
  return { keyword: hit.word, topic, display: raw.slice(0, MAX_TOPIC), mode,
    dateRange: dates.dateRange, freshness: dates.freshness, missingTopic: false };
}

/**
 * tool.run 的输入：字符串或 JSON。字符串里带「锐评」就走请求解析，否则整句当事件。
 */
function analyzeToolInput(input, settings, nowMs = Date.now()) {
  const config = normalizeSettings(settings);
  if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw) return null;
    const request = parseRequest(raw, settings, nowMs);
    if (request) return request;
    return plainRequest(raw, config, nowMs);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const rawTopic = String(input.topic || input.event || input.query || input.text || '').trim();
  if (!rawTopic) return null;
  const request = parseRequest(rawTopic, settings, nowMs) || plainRequest(rawTopic, config, nowMs);
  if (!request) return null;
  if (typeof input.mode === 'string' && MODES.includes(input.mode)) request.mode = input.mode;
  if (typeof input.freshness === 'string' && FRESHNESS.includes(input.freshness)) {
    request.freshness = input.freshness;
    request.dateRange = null;
  }
  if (input.dateRange && typeof input.dateRange === 'object'
    && /^\d{4}-\d{2}-\d{2}$/.test(input.dateRange.start) && /^\d{4}-\d{2}-\d{2}$/.test(input.dateRange.end)
    && input.dateRange.end >= input.dateRange.start) {
    request.dateRange = { start: input.dateRange.start, end: input.dateRange.end };
    request.freshness = '';
  }
  return request;
}

function plainRequest(value, config, nowMs) {
  const raw = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const topic = cleanTopic(raw);
  const dates = dateHint(raw, config, nowMs);
  const mode = /暴论|开炮|上强度/.test(raw) ? '暴论' : config.mode;
  return { keyword: '', topic, display: raw.slice(0, MAX_TOPIC), mode,
    dateRange: dates.dateRange, freshness: dates.freshness, missingTopic: topic.length < 2 };
}

function providerLabel(value) {
  const key = String(value == null ? '' : value).trim().toLowerCase();
  if (!key) return '来源未知';
  return PROVIDER_LABELS[key] || key;
}

function normalizeAttempts(value) {
  const out = [];
  for (const attempt of Array.isArray(value) ? value : []) {
    if (!attempt || typeof attempt !== 'object') continue;
    out.push({
      provider: text(attempt.provider, 40).toLowerCase(),
      status: text(attempt.status, 20).toLowerCase(),
      code: text(attempt.code, 60),
      selected: attempt.selected !== false,
      elapsedMs: Number.isFinite(Number(attempt.elapsedMs)) ? Number(attempt.elapsedMs) : 0,
    });
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeRequested(value) {
  if (!value || typeof value !== 'object') return null;
  const range = value.dateRange;
  let dateRange = null;
  if (range && typeof range === 'object'
    && /^\d{4}-\d{2}-\d{2}$/.test(String(range.start || ''))
    && /^\d{4}-\d{2}-\d{2}$/.test(String(range.end || ''))
    && String(range.end) >= String(range.start)) {
    dateRange = { start: String(range.start), end: String(range.end) };
  }
  return {
    query: text(value.query, 2000),
    freshness: FRESHNESS.includes(value.freshness) ? value.freshness : '',
    dateRange,
  };
}

/**
 * 从宿主返回的 search 里推断这轮走了哪条搜索链路。
 * 插件看不到宿主的搜索 API 开关，只能依据 items.provider 与 attempts。
 */
function searchMeta(normalized) {
  const items = Array.isArray(normalized.items) ? normalized.items : [];
  const attempts = Array.isArray(normalized.attempts) ? normalized.attempts : [];
  const providers = [...new Set(items.map(item => item.provider).filter(Boolean))];
  const apiItems = items.filter(item => API_PROVIDERS.includes(item.provider));
  const apiAttempts = attempts.filter(attempt => API_PROVIDERS.includes(attempt.provider));
  const failures = apiAttempts.filter(attempt => attempt.status === 'failed' || attempt.status === 'skipped');
  let origin = 'unknown';
  if (apiItems.length) origin = apiItems.length === items.length ? 'api' : 'mixed';
  else if (items.length) origin = 'local';
  let apiState = 'unknown';
  if (apiItems.length) apiState = 'used';
  else if (failures.length) apiState = 'failed_fallback';
  else if (items.length) apiState = 'off';
  return {
    providers,
    origin,
    apiState,
    dateFilter: normalized.dateFilter || '',
    attempts,
    requested: normalized.requested || null,
    apiFailures: failures.map(attempt => ({ provider: attempt.provider, code: attempt.code || '' })),
  };
}

function normalizeSearch(search) {
  if (!search || typeof search !== 'object') {
    return {
      status: 'empty', reason: 'no_search', items: [], text: '',
      attempts: [], dateFilter: '', requested: null,
      providers: [], origin: 'unknown', apiState: 'unknown', apiFailures: [],
    };
  }
  const items = Array.isArray(search.items) ? search.items : [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const title = text(item.title, 120);
    const snippet = text(item.snippet || item.summary || item.description, 400);
    const url = typeof item.url === 'string' ? item.url.trim().slice(0, 500) : '';
    if (!title && !snippet) continue;
    const key = (url || title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      index: out.length + 1,
      title: title || '（无标题）',
      url,
      snippet,
      publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : null,
      fetchedAt: typeof item.fetchedAt === 'string' ? item.fetchedAt : null,
      provider: text(item.provider, 40).toLowerCase(),
    });
    if (out.length >= 12) break;
  }
  const base = {
    status: text(search.status, 20) || (out.length ? 'ok' : 'empty'),
    reason: text(search.reason, 40),
    items: out,
    text: typeof search.text === 'string' ? search.text : '',
    attempts: normalizeAttempts(search.attempts),
    dateFilter: text(search.dateFilter, 40),
    requested: normalizeRequested(search.requested),
  };
  return { ...base, ...searchMeta(base) };
}

function buildEvidence(search, limit) {
  const normalized = normalizeSearch(search);
  const items = normalized.items.slice(0, limit).map(item => ({
    ...item,
    opinion: item.provider === 'zhihu',
    providerLabel: providerLabel(item.provider),
  }));
  const corpus = items.map(item => [
    item.title,
    item.opinion ? '问答观点' : '',
    item.snippet,
    item.publishedAt || '',
  ].join(' ')).join('\n');
  const lines = items.map(item => {
    const tag = item.opinion ? '（问答观点）' : '';
    return `[${item.index}] ${item.title}｜来源：${item.providerLabel}${tag}`
      + `｜发布时间：${item.publishedAt || '未确认'}｜${item.snippet}`;
  });
  const meta = searchMeta({ ...normalized, items });
  return {
    ...normalized,
    ...meta,
    items,
    corpus,
    text: lines.join('\n'),
  };
}

function numericCores(value) {
  const cores = new Set();
  for (const match of String(value == null ? '' : value).matchAll(/\d+(?:[.,]\d+)*/g)) {
    const core = match[0].replace(/[,\s]/g, '').replace(/\.$/, '');
    if (core) cores.add(core);
  }
  return cores;
}

function clip(value, max) {
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  let cut = chars.slice(0, max).join('');
  const stops = ['。', '！', '？', '；', '，', '、'].map(p => cut.lastIndexOf(p));
  const stop = Math.max(...stops);
  if (stop >= Math.floor(max * 0.5)) cut = cut.slice(0, stop);
  return cut.trim();
}

function cleanInline(value, max) {
  let out = String(value == null ? '' : value)
    .replace(UNSAFE, ' ')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^["“”'「」『』\s]+|["“”'「」『』\s]+$/g, '')
    .trim();
  if (MENTION_ALL.test(out)) out = out.replace(MENTION_ALL, '某些人');
  return clip(out, max);
}

function parseModelJson(raw) {
  if (raw && typeof raw === 'object') {
    if (typeof raw.verdict === 'string') {
      return { verdict: raw.verdict, facts: Array.isArray(raw.facts) ? raw.facts : [] };
    }
    return null;
  }
  let source = String(raw == null ? '' : raw).trim();
  if (!source) return null;
  source = source.replace(/^```(?:json|JSON)?\s*/, '').replace(/\s*```$/, '').trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && typeof parsed.verdict === 'string') {
        return { verdict: parsed.verdict, facts: Array.isArray(parsed.facts) ? parsed.facts : [] };
      }
    } catch { /* 落到宽松提取 */ }
  }
  const verdictMatch = source.match(/"verdict"\s*:\s*"([\s\S]*?)"\s*,\s*"facts"/)
    || source.match(/"verdict"\s*:\s*"([\s\S]*?)"\s*\}/);
  const facts = [...source.matchAll(/"text"\s*:\s*"([\s\S]*?)"\s*,\s*"source"\s*:\s*(\d+)/g)]
    .map(match => ({ text: unescapeLoose(match[1]), source: Number(match[2]) }));
  if (verdictMatch) return { verdict: unescapeLoose(verdictMatch[1]), facts };
  return null;
}

function unescapeLoose(value) {
  return String(value).replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\');
}

/**
 * 事实核对：数字必须能在资料里找到；来源编号必须有效；否则丢弃这条，不硬凑。
 */
function verifyFacts(list, evidence, limit) {
  const facts = [];
  const notes = [];
  const seen = new Set();
  const corpus = numericCores(evidence.corpus);
  let dropped = 0;
  let opinions = 0;
  for (const entry of Array.isArray(list) ? list : []) {
    const value = typeof entry === 'string' ? entry : entry && entry.text;
    const body = cleanInline(String(value == null ? '' : value).replace(/\[\d+\]/g, ''), 80);
    if (body.length < 6) continue;
    const index = Number(entry && typeof entry === 'object' ? entry.source : 0);
    if (!Number.isInteger(index) || index < 1 || index > evidence.items.length) {
      dropped += 1;
      continue;
    }
    const missing = [...numericCores(body)].filter(core => !corpus.has(core));
    if (missing.length) {
      dropped += 1;
      continue;
    }
    if (seen.has(body)) continue;
    seen.add(body);
    const item = evidence.items[index - 1];
    const opinion = Boolean(item.opinion || item.provider === 'zhihu');
    facts.push({ text: body, source: index, title: item.title, url: item.url,
      provider: item.provider, opinion });
    if (opinion) opinions += 1;
    if (facts.length >= limit) break;
  }
  if (dropped) notes.push(`有 ${dropped} 条事实因来源编号或数字与资料对不上被删除`);
  if (opinions) notes.push(`其中 ${opinions} 条依据来自知乎问答，按观点标注`);
  return { facts, notes };
}

function buildPrompt(request, config, evidence) {
  const system = [
    '你是中文时事锐评写手。先读资料，再下判断，只写资料支持得住的话。',
    '只输出一个 JSON 对象，不要代码块、不要解释、不要前后缀。',
    '字段：{"verdict":"锐评正文","facts":[{"text":"事实","source":1}]}',
    `verdict 要求：${MODE_HINT[request.mode]} 不超过 ${config.maxChars} 个汉字；必须落到资料里的具体事件、数字或结果上；可以辛辣、可以反讽，但不造谣、不辱骂、不做人身攻击、不歧视地域/性别/民族/职业。`,
    `facts 要求：不超过 ${config.facts} 条，每条 60 字以内，只能写资料中明确出现的事实；数字、日期、名次、金额必须与资料一致；宁缺毋滥。`,
    '资料标了「来源」：DeepSeek、Bing、360 等网页结果可当事实；标注「知乎」或「问答观点」的是用户观点，只能当舆论反应，不得写进 facts，也不得当已证实的事实。',
    '检索用的日期只是查询条件，不代表事件发生时间；资料没写发布时间就不要替它编日期。',
    'source 填资料编号（从 1 开始）。资料不足时 verdict 写「证据不足」，facts 返回空数组。',
  ].join('\n');
  const user = [
    `事件/结果：${request.topic}`,
    `模式：${request.mode}`,
    '资料：',
    evidence.text,
  ].join('\n');
  return { system, user };
}

async function gather(sdk, request, config) {
  if (!sdk || typeof sdk.search !== 'function') {
    return { status: 'failed', reason: 'search_unavailable', items: [], text: '' };
  }
  const options = { timeoutMs: config.searchTimeoutMs, timeZone: config.timeZone };
  if (request.dateRange) options.dateRange = request.dateRange;
  else if (request.freshness) options.freshness = request.freshness;
  try {
    const value = await sdk.search(request.topic, options);
    return value && typeof value === 'object' ? value : { status: 'failed', reason: 'search_error', items: [], text: '' };
  } catch (error) {
    const reason = String((error && (error.code || error.message)) || 'search_error').slice(0, 40);
    return { status: 'failed', reason, items: [], text: '' };
  }
}

function diagnostic(evidence) {
  return {
    status: evidence.status,
    reason: evidence.reason,
    itemCount: evidence.items.length,
    origin: evidence.origin,
    apiState: evidence.apiState,
    dateFilter: evidence.dateFilter,
    providers: evidence.providers,
    items: evidence.items.slice(0, 6).map(item => ({
      index: item.index, title: item.title, url: item.url,
      publishedAt: item.publishedAt, provider: item.provider,
      providerLabel: item.providerLabel, opinion: Boolean(item.opinion),
    })),
  };
}

/**
 * 核心：吃一份搜索结果，产出结构化锐评。search 由调用方给，方便 chat 复用本轮证据。
 */
async function judge(sdk, request, config, search, nowMs = Date.now()) {
  const started = Date.now();
  const evidence = buildEvidence(search, config.evidenceItems);
  const meta = searchMeta(evidence);
  const base = {
    topic: request.topic,
    mode: request.mode,
    dateRange: request.dateRange || null,
    freshness: request.dateRange ? null : (request.freshness || null),
    searchedAt: new Date(nowMs).toISOString(),
    search: meta,
  };
  const found = diagnostic(evidence);
  if (evidence.items.length < config.minItems) {
    return { ok: false, reason: 'insufficient_evidence',
      message: `只搜到 ${evidence.items.length} 条可用资料（至少 ${config.minItems} 条），先不锐评，免得编。`,
      ...base, evidence: found, elapsedMs: Date.now() - started };
  }
  if (!sdk || typeof sdk.model !== 'function') {
    return { ok: false, reason: 'model_unavailable', message: '宿主没有开放模型调用，无法生成锐评。',
      ...base, evidence: found, elapsedMs: Date.now() - started };
  }
  const prompt = buildPrompt(request, config, evidence);
  let raw = null;
  let failure = '';
  try {
    raw = await sdk.model({
      system: prompt.system,
      turns: [{ role: 'user', content: prompt.user }],
      maxTokens: config.modelMaxTokens,
      thinking: config.thinking,
    });
  } catch (error) {
    failure = String((error && (error.code || error.message)) || 'model_failed').slice(0, 60);
  }
  if (!raw && !failure) failure = 'empty_model_output';
  if (failure) {
    return { ok: false, reason: 'model_failed', message: '模型这次没给出结果，本轮不锐评。',
      modelError: failure, ...base, evidence: found, elapsedMs: Date.now() - started };
  }

  const parsed = parseModelJson(raw);
  const notes = [];
  if (meta.apiState === 'failed_fallback') {
    const labels = meta.apiFailures.map(item => providerLabel(item.provider)).join('、');
    notes.push(`搜索 API 未生效（${labels || '接口异常'}），本次已回退本地搜索`);
  }
  let verdict = '';
  let facts = [];
  if (parsed) {
    verdict = cleanInline(parsed.verdict, config.maxChars);
    const checked = verifyFacts(parsed.facts, evidence, config.facts);
    facts = checked.facts;
    notes.push(...checked.notes);
  }
  if (!verdict) {
    // 模型没按 JSON 输出：只取第一段当锐评，不引用任何事实，避免把叙述当证据。
    const plain = String(raw).replace(/```/g, ' ').split(/\n{2,}/)[0];
    verdict = cleanInline(plain, config.maxChars);
    if (verdict) notes.push('模型没按 JSON 返回，只采用锐评正文，未引用事实');
  }
  if (!verdict) {
    return { ok: false, reason: 'empty_verdict', message: '模型没有给出可用的锐评正文。',
      ...base, evidence: found, elapsedMs: Date.now() - started };
  }
  if (/^(?:证据不足|资料不足|資料不足)/.test(verdict)) {
    return { ok: false, reason: 'model_says_insufficient', message: '资料只够确认零星事实，不够下判断：' + verdict,
      ...base, evidence: found, elapsedMs: Date.now() - started };
  }
  // 正文里的数字同样要能落到资料上；对不上就整条不发，避免金句里夹带编造的数字。
  const verdictDigits = [...numericCores(verdict)].filter(core => !numericCores(evidence.corpus).has(core));
  if (verdictDigits.length) {
    return { ok: false, reason: 'verdict_numbers_unverified',
      message: `锐评正文里的数字（${verdictDigits.join('、')}）在资料里找不到出处，本轮不锐评。`,
      ...base, evidence: found, elapsedMs: Date.now() - started };
  }
  if (!facts.length) notes.push('没有事实通过核对，本次只保留锐评正文');
  return {
    ok: true,
    ...base,
    verdict,
    facts,
    sources: evidence.items.map(item => ({
      index: item.index, title: item.title, url: item.url, publishedAt: item.publishedAt,
      provider: item.provider, opinion: Boolean(item.opinion),
    })),
    degraded: notes.length > 0,
    notes,
    evidence: found,
    elapsedMs: Date.now() - started,
  };
}

function pickSources(result, limit) {
  const picked = [];
  const seen = new Set();
  for (const fact of result.facts || []) {
    if (seen.has(fact.source)) continue;
    seen.add(fact.source);
    const source = (result.sources || []).find(item => item.index === fact.source);
    if (source) picked.push(source);
    if (picked.length >= limit) break;
  }
  if (!picked.length && result.sources && result.sources.length) picked.push(result.sources[0]);
  return picked;
}

function renderChat(result, config) {
  const lines = [result.verdict];
  if (result.facts && result.facts.length) {
    const facts = result.facts.slice(0, config.facts)
      .map(fact => (fact.opinion ? '（观点）' : '') + fact.text);
    lines.push('依据：' + facts.join('；'));
  }
  if (config.showSources) {
    const picked = pickSources(result, 2);
    if (picked.length) {
      const sources = picked.map(item => {
        const labels = [];
        if (config.showProvider && item.provider) labels.push(providerLabel(item.provider));
        if (item.opinion) labels.push('观点');
        const tag = labels.length ? `（${labels.join('·')}）` : '';
        return (item.title || '链接') + tag + (item.url ? ' ' + item.url : '');
      });
      lines.push('来源：' + sources.join('；'));
    }
  }
  let value = lines.join('\n');
  if (MENTION_ALL.test(value)) value = value.replace(MENTION_ALL, '大家');
  return value.slice(0, MAX_CHAT_TEXT);
}

function hostSearch(search) {
  if (!search || typeof search !== 'object') return null;
  const items = Array.isArray(search.items) ? search.items.filter(item => item && typeof item === 'object').slice(0, 30) : [];
  const textValue = typeof search.text === 'string' ? search.text.slice(0, 32000) : '';
  if (!items.length && !textValue) return null;
  return {
    status: typeof search.status === 'string' ? search.status : 'empty',
    reason: typeof search.reason === 'string' ? search.reason : '',
    text: textValue,
    items,
    elapsedMs: Number(search.elapsedMs) || 0,
    attempts: normalizeAttempts(search.attempts),
    dateFilter: text(search.dateFilter, 40),
    requested: normalizeRequested(search.requested),
  };
}


// —— 新宿主 SDK 适配：只走 host.call，不访问内部 HTTP ——

function hostSdk(host) {
  if (!host || typeof host.call !== 'function') return null;
  return {
    search: async (query, options = {}) => {
      const input = { query: String(query || '').slice(0, 2000) };
      if (!input.query) throw new Error('search_query_empty');
      if (options.freshness && FRESHNESS.includes(options.freshness) && options.freshness) input.freshness = options.freshness;
      if (Number.isInteger(options.timeoutMs) && options.timeoutMs >= 500) input.timeoutMs = options.timeoutMs;
      return host.call('search.query@1', input);
    },
    model: async ({ system, turns, maxTokens } = {}) => {
      const input = { turns: Array.isArray(turns) ? turns : [] };
      if (typeof system === 'string' && system) input.system = system.slice(0, 64000);
      if (Number.isInteger(maxTokens) && maxTokens > 0) input.maxTokens = Math.min(maxTokens, 32000);
      // model.complete@1 返回 {text}，judge() 需要的是文本；不 unwrap 会把对象当字符串用。
      const out = await host.call('model.complete@1', input);
      return out && typeof out.text === 'string' ? out.text : '';
    },
  };
}

function emptyChatSearch() {
  return { text: '', items: [], status: 'empty' };
}

function toChatSearch(value) {
  const normalized = normalizeSearch(value);
  const items = normalized.items.slice(0, 30).map(item => ({
    title: item.title || '（无标题）',
    url: item.url || '',
    snippet: item.snippet || '',
    publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : null,
    fetchedAt: typeof item.fetchedAt === 'string' ? item.fetchedAt : null,
  }));
  const status = ['ok', 'empty', 'failed'].includes(normalized.status)
    ? normalized.status : (items.length ? 'ok' : 'empty');
  return { text: normalized.text.slice(0, 32000), items, status };
}

// replace 的 chat.search 与 chat.generate 之间没有搜索上下文，且两次调用是两个进程：
// 用 worker 私有 cwd 的文件缓存（TTL 3 分钟、最多 16 条、取一次即删）。
const CACHE_FILE_NAME = 'ruiping-search-cache.json';
const CACHE_TTL_MS = 3 * 60 * 1000;
const CACHE_MAX_ENTRIES = 16;

function cachePath() { return path.join(process.cwd(), CACHE_FILE_NAME); }

function cacheField(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function cacheEntry(message) {
  return {
    chatType: cacheField(message.chatType, 24),
    chatId: cacheField(message.chatId, 120),
    senderId: cacheField(message.senderId, 120),
    msgId: cacheField(message.msgId, 200),
    text: cacheField(message.text, 16000),
  };
}

function cacheMatches(entry, wanted) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.chatType !== wanted.chatType || entry.chatId !== wanted.chatId || entry.text !== wanted.text) return false;
  // search 的 message 目前没有 senderId/msgId（宿主只给 platform/chatType/chatId/text）；
  // 两边都有时才做更严格的校验，避免把「有」和「没有」判成不同消息。
  for (const field of ['senderId', 'msgId']) {
    if (entry[field] && wanted[field] && entry[field] !== wanted[field]) return false;
  }
  return true;
}

function readCache(now) {
  try {
    const value = JSON.parse(fs.readFileSync(cachePath(), 'utf8').replace(/^\uFEFF/, ''));
    const entries = Array.isArray(value && value.entries) ? value.entries : [];
    return entries.filter(entry => entry && typeof entry === 'object'
      && Number(entry.at) > now - CACHE_TTL_MS && entry.search && typeof entry.search === 'object');
  } catch { return []; }
}

function writeCache(entries) {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    const temp = cachePath() + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: entries.slice(-CACHE_MAX_ENTRIES) }));
    try { fs.renameSync(temp, cachePath()); } catch {
      fs.rmSync(cachePath(), { force: true });
      fs.renameSync(temp, cachePath());
    }
  } catch { /* 缓存只是省一次检索，读写失败不影响本轮 */ }
}

function rememberSearch(message, search) {
  if (!message || !search) return;
  // 单条检索结果太大时不落盘：缓存只是省一次检索，不能把状态文件写爆。
  try {
    if (JSON.stringify(search).length > 128 * 1024) return;
  } catch { return; }
  const now = Date.now();
  const entries = readCache(now);
  entries.push({ ...cacheEntry(message), at: now, search });
  writeCache(entries);
}

function takeSearch(message) {
  if (!message) return null;
  const now = Date.now();
  const wanted = cacheEntry(message);
  const entries = readCache(now);
  const index = entries.findIndex(entry => cacheMatches(entry, wanted));
  if (index < 0) return null;
  const [hit] = entries.splice(index, 1);
  // 一次消费：即使本轮生成失败也不留给下一条同文消息，避免用旧检索结果答新消息。
  writeCache(entries);
  return hit.search;
}


async function runTool(input, context = {}) {
  const config = normalizeSettings(context.settings);
  const request = analyzeToolInput(input, config, Date.now());
  if (!request || !request.topic) {
    return { ok: false, reason: 'need_topic',
      message: '在「运行一次」里输入一个真实事件或结果，例如：昨天湖人打勇士谁赢了' };
  }
  if (request.missingTopic) {
    return { ok: false, reason: 'need_topic',
      message: '只看到「锐评」两个字，缺事件或结果。补一句，例如：锐评一下昨天湖人输球' };
  }
  const sdk = hostSdk(context.host);
  const search = await gather(sdk, request, config);
  return judge(sdk, request, config, search, Date.now());
}

exports.providers = {
  'chat.search@1': async (input, context = {}) => {
    const config = normalizeSettings(context.settings);
    const message = input?.message || {};
    if (!config.inChat) return emptyChatSearch();
    const request = parseRequest(message.text, config, Date.now());
    if (!request || request.missingTopic) return emptyChatSearch();
    const search = await gather(hostSdk(context.host), request, config);
    rememberSearch(message, search);
    return toChatSearch(search);
  },

  'chat.pre_reply@1': async (input, context = {}) => {
    const config = normalizeSettings(context.settings);
    const message = input?.message || {};
    if (!config.inChat || !config.wake) return { action: 'pass' };
    const request = parseRequest(message.text, config, Date.now());
    if (!request || request.missingTopic) return { action: 'pass' };
    return { action: 'wake', reason: 'ruiping: wake on keyword' };
  },

  'chat.generate@1': async (input, context = {}) => {
    const config = normalizeSettings(context.settings);
    const message = input?.message || {};
    if (!config.inChat) return { text: '' };
    const request = parseRequest(message.text, config, Date.now());
    if (!request || request.missingTopic) return { text: '' };
    const sdk = hostSdk(context.host);
    const search = takeSearch(message) || await gather(sdk, request, config);
    const result = await judge(sdk, request, config, search, Date.now());
    if (result.ok) return { text: renderChat(result, config) };
    if (result.reason === 'insufficient_evidence' || result.reason === 'model_says_insufficient') {
      return { text: '这次没搜到足够可靠的事实，先不锐评，免得编。' };
    }
    if (result.reason === 'verdict_numbers_unverified') {
      return { text: '这条里的数字我没在资料里核对到，先不锐评，免得编。' };
    }
    // 新协议 replace 没有「交回宿主」通道；失败时返回空文本，由宿主按 plugin_empty 处理。
    return { text: '' };
  },

  'tool.run@1': runTool,
};
