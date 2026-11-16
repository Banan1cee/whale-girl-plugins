'use strict';

/*
 * 深度联网搜索（deep-web-search）1.0.0
 * 鲸鲸 4.1.6+ / JavaScript 插件 API 4（message 插件）。
 *
 * 做的事：
 *   1. 每条要回复的消息都先判断“是否需要联网”：只有问具体既定事实
 *      （比分/赛程、新闻事件、价格行情、天气、政策法规、人物近况、数据统计、
 *      产品发布等）才搜；闲聊、情绪、观点、创作不搜，直接告诉宿主“跳过”。
 *   2. 需要搜时，把“今天/昨天/昨晚/明天/11月12日”等按用户时区换算成具体日期，
 *      作为检索日期范围交给宿主搜索；宿主会优先走已配置的搜索 API
 *      （DeepSeek /v1/tools/search），插件不需要、也不保存 API Key。
 *   3. 用 1~4 条互补查询检索，按 URL 去重、按来源可信度与时间排序；
 *      可选抓取正文并读取页面标注的发布时间，避免旧闻冒充今天的结果。
 *   4. 把结果整理成“一句结论 + 关键事实 + 来源与时间 + 口吻提示”，
 *      让鲸鲸（大肥鱼人格）能直接用短句给出结论和锐评，而不是念来源列表。
 *   5. 篮球问题先查 ESPN 公开记分牌，按用户时区核对日期，给出具体比分、
 *      胜负与比赛状态；该日没有比赛就明说，不拿旧闻顶替。
 *   6. 宿主搜索失败时回退到 Bing RSS；仍失败就返回 {}，让鲸鲸用宿主默认搜索，
 *      不会把“搜不到”伪装成“没有这件事”。
 *
 * 运行环境：宿主为每个插件单独 fork Node 子进程（本机 4.1.6 为 Node 24），
 * 因此可以直接用全局 fetch。插件不读文件、不写日志、不发消息、不调模型。
 */

const VERSION = '1.0.0';
const TAG = 'deep-web-search';
const DEFAULT_TZ = 'Asia/Shanghai';
const MAX_TEXT = 30000;
const MAX_ITEMS = 30;
const MAX_TOOL_TEXT = 12000;
const PAGE_MAX_BYTES = 1200000;

const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// 检索动作：用户明确在“查/搜/核实”。
const VERB = /搜索|搜一下|搜搜|搜下|查一下|查查|查下|帮我查|帮忙查|请查|查询|检索|核实|查证|求证|确认一下|是不是真的|真的吗|怎么回事|发生了什么|进展如何/;
// 时效词：出现它才需要“最新”的信息。
const TIME = /今天|今日|本日|当天|现在|目前|当前|最新|刚刚|刚才|昨天|昨日|昨晚|前天|明天|明日|后天|本周|这周|这个星期|上周|上个星期|周末|今年|去年|20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}|\d{1,2}月\d{1,2}日?|\d{1,2}[\/.]\d{1,2}/;
// 事实名词：新闻、赛事、行情、公告等。
const FACT = /比赛|赛程|赛果|比分|谁赢|赢了|输了|夺冠|冠军|MVP|得分|篮板|助攻|绝杀|排名|战绩|新闻|消息|通报|公告|发布会|官宣|股价|汇率|油价|金价|天气|气温|降雨|台风|地震|事故|政策|判决|开庭|票房|销量|价格|多少钱|上市|发售|开播|上映|财报|裁员|融资|并购|选举|伤情|转会|去世|离婚|结婚|丑闻|调查|回应|辟谣|道歉/;
const QUESTION = /谁|什么|多少|几比几|怎么样|如何|为什么|哪[个里家]|是否|有没有|真的|吗|呢/;
// 足够强的检索信号：有它就直接联网。
const STRONG = /比分|赛果|谁赢|现价|最新|新闻|股价|汇率|天气|出处|怎么读|读音|发布会|官宣|通报|票房|排名|战绩/;
// 闲聊开头：即使带“今天”也不联网，除非同时出现明确检索词。
const CHITCHAT = /^(在吗|在么|干嘛|你在干嘛|吃了吗|睡了吗|晚安|早安|午安|你好|嗨|哈喽|想你|抱抱|亲亲|今天心情|今天好累|今天不开心|今天开心|我回来了)/;
// 创作/情绪/纯观点：要的是陪伴或表达，不是事实；不联网。
const CREATIVE = /写(一首|首|个|一段|篇|点)|作诗|编个|讲个(笑话|故事)|来个(段子|笑话)|夸夸我|安慰我|陪我聊|你觉得我|你喜欢我|我该不该|我好累|好烦|不开心|难过|焦虑|失眠/;

const NBA_TEAMS = ['湖人', '勇士', '凯尔特人', '篮网', '太阳', '雄鹿', '掘金', '热火', '76人', '快船', '国王', '尼克斯', '公牛', '马刺', '雷霆', '森林狼', '骑士', '步行者', '老鹰', '黄蜂', '活塞', '魔术', '奇才', '猛龙', '爵士', '开拓者', '鹈鹕', '灰熊', '火箭', '独行侠', '小牛', '热火', '马刺'];
const FOOTBALL_TEAMS = ['皇马', '巴萨', '曼联', '利物浦', '阿森纳', '曼城', '切尔西', '热刺', '拜仁', '多特', '尤文', 'AC米兰', '国米', '巴黎圣日耳曼', '阿根廷', '巴西', '法国', '德国', '西班牙', '英格兰'];
const LEAGUES = /NBA|CBA|英超|西甲|意甲|德甲|法甲|中超|欧冠|世界杯|欧洲杯|亚冠|WNBA/i;

// ESPN 公开记分牌：按美东日期返回当日赛程/赛果，无需 Key。
const ESPN_NBA_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';

// 中文队名 → ESPN 英文名关键词。用小写包含匹配，兼容 “LA Clippers” / “Los Angeles Lakers”。
const TEAM_ALIASES = {
  湖人: ['lakers'], 勇士: ['warriors'], 凯尔特人: ['celtics'], 篮网: ['nets'], 太阳: ['suns'],
  雄鹿: ['bucks'], 掘金: ['nuggets'], 热火: ['heat'], '76人': ['76ers'], 快船: ['clippers'],
  国王: ['kings'], 尼克斯: ['knicks'], 公牛: ['bulls'], 马刺: ['spurs'], 雷霆: ['thunder'],
  森林狼: ['timberwolves'], 骑士: ['cavaliers'], 步行者: ['pacers'], 老鹰: ['hawks'],
  黄蜂: ['hornets'], 活塞: ['pistons'], 魔术: ['magic'], 奇才: ['wizards'], 猛龙: ['raptors'],
  爵士: ['jazz'], 开拓者: ['trail blazers', 'blazers'], 鹈鹕: ['pelicans'], 灰熊: ['grizzlies'],
  火箭: ['rockets'], 独行侠: ['mavericks'], 小牛: ['mavericks'],
};

const ESPN_STATUS = {
  STATUS_FINAL: '已结束',
  STATUS_IN_PROGRESS: '进行中',
  STATUS_HALFTIME: '中场',
  STATUS_END_PERIOD: '节间',
  STATUS_SCHEDULED: '未开赛',
  STATUS_POSTPONED: '延期',
  STATUS_CANCELED: '取消',
  STATUS_SUSPENDED: '暂停',
  STATUS_DELAYED: '延迟',
};

const STOP = new Set(['今天', '昨天', '明天', '现在', '最新', '什么', '怎么', '如何', '多少', '为什么', '帮我', '查一下', '搜索', '然后', '这个', '那个', '一下', '我们', '你们', '他们', '可以', '有没', '没有']);

// 来源可信度。越接近官方/通讯社，分越高。
const TRUSTED = [
  [/\.gov\.cn$/i, 100], [/\.edu\.cn$/i, 80],
  [/(^|\.)nba\.com$/i, 98], [/(^|\.)cba\.net$/i, 98], [/(^|\.)fiba\.com$/i, 96],
  [/(^|\.)xinhuanet\.com$/i, 95], [/(^|\.)news\.cn$/i, 95], [/(^|\.)people\.com\.cn$/i, 93],
  [/(^|\.)cctv\.com$/i, 93], [/(^|\.)chinanews\.com\.cn$/i, 90],
  [/(^|\.)thepaper\.cn$/i, 88], [/(^|\.)jiemian\.com$/i, 86], [/(^|\.)caixin\.com$/i, 88],
  [/(^|\.)sina\.com\.cn$/i, 82], [/(^|\.)sina\.cn$/i, 82], [/(^|\.)qq\.com$/i, 80],
  [/(^|\.)163\.com$/i, 78], [/(^|\.)sohu\.com$/i, 74], [/(^|\.)ifeng\.com$/i, 74],
  [/(^|\.)espn\.com$/i, 92], [/(^|\.)bbc\.com$/i, 90], [/(^|\.)reuters\.com$/i, 92], [/(^|\.)apnews\.com$/i, 90],
];

function str(value, fallback = '') {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function int(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function bool(value, fallback) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function list(value) {
  return str(value).split(/[,，;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean).slice(0, 20);
}

function clip(text, max) {
  const s = str(text).replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function safeZone(zone) {
  const z = str(zone).trim();
  if (z) {
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: z }).format(0); return z; } catch { /* 用系统时区 */ }
  }
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ; } catch { return DEFAULT_TZ; }
}

function ymd(now, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const box = {};
  for (const part of parts) box[part.type] = part.value;
  return `${box.year}-${box.month}-${box.day}`;
}

function addDays(day, offset) {
  return new Date(Date.parse(day + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
}

function weekday(day) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(day + 'T00:00:00Z').getUTCDay()];
}

function mondayOf(day) {
  const index = new Date(day + 'T00:00:00Z').getUTCDay();
  return addDays(day, -((index + 6) % 7));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function humanDay(day) {
  return `${day}（${weekday(day)}）`;
}

function fmtTime(value, zone) {
  const ms = Date.parse(str(value));
  if (!Number.isFinite(ms)) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(ms));
    const box = {};
    for (const part of parts) box[part.type] = part.value;
    const hour = box.hour === '24' ? '00' : box.hour;
    return `${box.year}-${box.month}-${box.day} ${hour}:${box.minute}`;
  } catch { return ''; }
}

function nowLabel(now, zone) {
  return fmtTime(new Date(now).toISOString(), zone);
}

// ---------- 日期与意图 ----------

function parseDateRange(text, now, zone) {
  const today = ymd(now, zone);
  const raw = str(text);
  const pick = (start, end, label) => ({
    start, end: end || start, label: label || (start === (end || start) ? humanDay(start) : `${start} 至 ${end}`),
  });

  const absolute = raw.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (absolute) {
    const month = Number(absolute[2]), day = Number(absolute[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = `${absolute[1]}-${pad2(month)}-${pad2(day)}`;
      return pick(date, date, humanDay(date));
    }
  }

  const monthDay = raw.match(/(\d{1,2})月(\d{1,2})日?/) || raw.match(/(?:^|[^\d])(\d{1,2})[\/.](\d{1,2})(?!\d)/);
  if (monthDay) {
    const month = Number(monthDay[1]), day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = Number(today.slice(0, 4));
      let date = `${year}-${pad2(month)}-${pad2(day)}`;
      // 没写年份时取“最近一次”：晚于今天两天以上，视为去年。
      if (date > addDays(today, 2)) date = `${year - 1}-${pad2(month)}-${pad2(day)}`;
      return pick(date, date, humanDay(date));
    }
  }

  if (/上周|上个星期|上星期/.test(raw)) {
    const monday = addDays(mondayOf(today), -7);
    return pick(monday, addDays(monday, 6), '上周');
  }
  if (/本周|这周|这个星期|这星期/.test(raw)) {
    return pick(mondayOf(today), today, '本周');
  }
  if (/周末/.test(raw)) {
    const saturday = addDays(mondayOf(today), 5);
    return pick(saturday, addDays(saturday, 1), '本周末');
  }
  if (/今年/.test(raw)) return pick(`${today.slice(0, 4)}-01-01`, today, '今年');
  if (/去年/.test(raw)) {
    const year = Number(today.slice(0, 4)) - 1;
    return pick(`${year}-01-01`, `${year}-12-31`, '去年');
  }

  const rel = (day, label) => pick(day, day, `${label} ${humanDay(day)}`);
  if (/昨天|昨日|昨晚/.test(raw)) return rel(addDays(today, -1), '昨天');
  if (/前天/.test(raw)) return rel(addDays(today, -2), '前天');
  if (/明天|明日/.test(raw)) return rel(addDays(today, 1), '明天');
  if (/后天/.test(raw)) return rel(addDays(today, 2), '后天');
  if (/今天|今日|本日|当天|现在|目前|当前|最新|刚刚|刚才/.test(raw)) return rel(today, '今天');
  return null;
}

function domainOf(text) {
  const t = str(text);
  if (/天气|气温|降雨|台风|下雨|温度|空气质量/.test(t)) return 'weather';
  if (LEAGUES.test(t) || /比分|赛果|赛程|谁赢|夺冠|冠军|比赛结果|球队|球员|赢了|输了|战胜|击败|不敌/.test(t)) return 'sports';
  if (/新闻|消息|通报|公告|发布会|官宣|事故|政策|判决|地震|股价|汇率|财报|选举|回应|辟谣/.test(t)) return 'news';
  return 'web';
}

function cleanQuery(text) {
  let q = str(text).trim();
  q = q.replace(/^[\s，,。！!？?、~～]*(鲸鲸|宝宝|亲爱的)?[，,]?\s*(请|麻烦|能不能|可以|帮我|帮忙)?\s*(搜索一下|搜索|搜一下|搜搜|查一下|查查|查下|查询|检索|核实|查证|求证)[一下下\s]*[，,：:]?\s*/, '');
  q = q.replace(/[？?！!。]+$/g, '').trim();
  return q.slice(0, 80);
}

function detect(rawText, options) {
  const text = str(rawText).trim();
  if (!text) return null;
  const now = Number.isFinite(Number(options && options.now)) ? Number(options.now) : Date.now();
  const zone = safeZone(options && options.timeZone);
  const force = bool(options && options.force, false);

  const normalized = text.replace(/\s+/g, ' ');
  const command = /^[\/／](查|search)[\s:：]/i.test(normalized);
  const sports = LEAGUES.test(normalized) || NBA_TEAMS.some(name => normalized.includes(name))
    || FOOTBALL_TEAMS.some(name => normalized.includes(name)) || /比分|赛果|赛程|谁赢/.test(normalized);
  const hasTime = TIME.test(normalized);
  const hasFact = FACT.test(normalized);
  const hasQuestion = QUESTION.test(normalized);
  const hasVerb = VERB.test(normalized);
  const hasStrong = STRONG.test(normalized);
  const chitchat = CHITCHAT.test(normalized);
  const creative = CREATIVE.test(normalized);

  let triggered = force || command || hasStrong || hasVerb
    || (hasTime && hasFact && (hasQuestion || sports))
    || (hasFact && hasQuestion && normalized.length <= 60)
    || (sports && hasQuestion)
    || (sports && /比赛|赛程|比分|结果|谁赢|赢|输/.test(normalized) && hasTime);
  if (!triggered) return null;
  if (chitchat && !command && !force && !hasVerb && !hasStrong) return null;
  if (creative && !command && !force && !hasVerb && !hasStrong) return null;

  const domain = domainOf(normalized);
  let dateRange = parseDateRange(normalized, now, zone);
  // “现价/最新/刚刚”这类词本身就在问当下；而“出处/怎么读”不该被强行加上今天。
  if (!dateRange && (domain === 'sports' || domain === 'weather' || hasTime || /现价|最新|刚刚|现在|目前|当前/.test(normalized))) {
    const today = ymd(now, zone);
    dateRange = { start: today, end: today, label: `今天（${humanDay(today)}）` };
  }
  return {
    text: normalized,
    query: cleanQuery(normalized),
    domain,
    dateRange,
    timeZone: zone,
    now,
    sports,
  };
}

function teamNames(text) {
  const found = [];
  for (const name of [...NBA_TEAMS, ...FOOTBALL_TEAMS]) {
    if (text.includes(name) && !found.includes(name)) found.push(name);
  }
  return found.slice(0, 3);
}

function buildQueries(intent, settings) {
  const box = settings || {};
  const max = int(box.maxQueries, 2, 1, 4);
  const text = str(intent.text);
  const base = str(intent.query) || cleanQuery(text);
  const range = intent.dateRange;
  const dateToken = range ? (range.start === range.end ? range.start : `${range.start}至${range.end}`) : '';
  const teams = teamNames(text);
  const league = (text.match(LEAGUES) || [])[0] || (teams.length ? (FOOTBALL_TEAMS.some(x => teams.includes(x)) ? '足球' : 'NBA') : '');
  const stripped = base.replace(/今天|今日|昨天|昨日|昨晚|前天|明天|后天|最新|现在|目前|当前|刚刚/g, '').replace(/\s+/g, ' ').trim();
  const out = [];
  const push = query => {
    const q = clip(query, 120);
    if (q && !out.includes(q)) out.push(q);
  };

  if (intent.domain === 'sports') {
    if (teams.length >= 2) push(`${teams[0]} ${teams[1]} 比分 赛果 ${dateToken}`.trim());
    else if (teams.length === 1) push(`${teams[0]} 比分 赛果 ${dateToken}`.trim());
    else push(`${league || 'NBA'} 比分 赛果 ${dateToken}`.trim());
    push(`${stripped || base} ${dateToken}`.trim());
    if (max >= 3) push(`${league || 'NBA'} 战报 ${dateToken}`.trim());
  } else if (intent.domain === 'weather') {
    push(base);
    if (max >= 3 && range) push(`${base} ${dateToken}`.trim());
  } else if (intent.domain === 'news') {
    push(base);
    push(`${stripped || base} ${dateToken}`.trim());
    if (max >= 3) push(`${stripped || base} 最新进展`.trim());
  } else {
    push(base);
    if (max >= 2 && dateToken) push(`${base} ${dateToken}`.trim());
    if (max >= 3) push(`${base} 官方 消息`.trim());
  }
  return out.slice(0, max).map(query => ({ query, dateRange: range, timeZone: intent.timeZone }));
}

// ---------- 来源整理 ----------

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|spm|from|share|ref|source$)/i.test(key)) parsed.searchParams.delete(key);
    }
    let out = parsed.toString();
    if (out.endsWith('/') && parsed.pathname !== '/') out = out.slice(0, -1);
    return out;
  } catch { return ''; }
}

function trustOf(url) {
  const host = hostOf(url);
  if (!host) return 0;
  for (const [pattern, score] of TRUSTED) if (pattern.test(host)) return score;
  return 50;
}

function blocked(url, settings) {
  const host = hostOf(url);
  if (!host) return true;
  if (/\.(pdf|zip|rar|7z|exe|dmg|mp4|m3u8|mp3|jpg|jpeg|png|gif|webp|svg|ico)$/i.test(host + new URL(url).pathname)) return true;
  if (/^(bing|www\.bing|cn\.bing|www\.baidu|www\.so|www\.google)\./i.test(host)) return true;
  for (const item of settings.blocked || []) if (host === item || host.endsWith('.' + item)) return true;
  return false;
}

function normalizeItem(item, provider) {
  const url = normalizeUrl(str(item && item.url));
  const title = clip(item && (item.title || item.name), 200);
  if (!url || !/^https?:\/\//i.test(url) || !title) return null;
  const published = str(item && (item.publishedAt || item.published || item.date));
  const publishedAt = Number.isFinite(Date.parse(published)) ? new Date(Date.parse(published)).toISOString() : '';
  return {
    title,
    url,
    snippet: clip(item && (item.snippet || item.summary || item.description), 500),
    publishedAt,
    provider: str(provider || (item && item.provider) || 'host', 'host'),
    fetchedAt: str(item && item.fetchedAt) || new Date().toISOString(),
  };
}

function dedupe(items) {
  const out = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  for (const item of items) {
    if (!item) continue;
    const key = item.url;
    const titleKey = hostOf(item.url) + '|' + item.title.replace(/\s+/g, '').slice(0, 60);
    if (seenUrl.has(key) || seenTitle.has(titleKey)) continue;
    seenUrl.add(key);
    seenTitle.add(titleKey);
    out.push(item);
  }
  return out;
}

function rank(items, intent, settings) {
  const teams = teamNames(intent.text);
  const keywords = [...teams, ...(intent.text.match(LEAGUES) || [])];
  const scored = items.map((item, index) => {
    let score = trustOf(item.url);
    const hay = item.title + ' ' + item.snippet;
    for (const word of keywords) if (word && hay.includes(word)) score += 6;
    if (intent.dateRange && item.publishedAt) {
      const day = item.publishedAt.slice(0, 10);
      if (day >= intent.dateRange.start && day <= intent.dateRange.end) score += 10;
      else score -= 8;
    }
    if (!item.publishedAt) score -= 2;
    // 中文提问优先中文来源：宿主 API 会返回不少外文结果，外文标题对群聊没用。
    const cjk = (str(item.title) + ' ' + str(item.snippet)).match(/[\u4e00-\u9fa5]/g);
    const cjkCount = cjk ? cjk.length : 0;
    const cnSite = /\.(cn|com\.cn)$/.test(hostOf(item.url)) || /(qq|sina|163|sohu|ifeng|thepaper|zhihu|douban|bilibili|hupu|dongqiudi)/.test(hostOf(item.url));
    if (cjkCount >= 8) score += 10;
    else if (cjkCount >= 3) score += 5;
    else if (cnSite) score += 4;
    else if (!cjkCount) score -= 18;
    // 球队资料页/赛程汇总页不是“昨天的比赛结果”，别让它挤掉真正的新闻。
    if (/\/(teams?|kbsweb)\b|teams\.htm/i.test(item.url)) score -= 22;
    if (/季前赛|夏季联赛/.test(str(item.snippet)) && intent.dateRange) score -= 10;
    const extra = (settings.trusted || []).some(host => hostOf(item.url) === host || hostOf(item.url).endsWith('.' + host)) ? 15 : 0;
    return { item, score, index };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.map(entry => entry.item).slice(0, int(settings.maxSources, 4, 1, 8));
}

// ---------- 网络 ----------

function decodeEntities(input) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
    hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', times: '×',
  };
  return str(input).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const value = Number.parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    }
    return Object.prototype.hasOwnProperty.call(named, code.toLowerCase()) ? named[code.toLowerCase()] : whole;
  });
}

function htmlToText(html) {
  let text = str(html).replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|svg|iframe|template|head)[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  return text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function metaDate(html) {
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:article:published_time|datePublished|pubdate|publishdate|og:release_date)["'][^>]*content=["']([^"']+)/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:article:published_time|datePublished)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<time[^>]+datetime=["']([^"']+)/i,
  ];
  for (const pattern of patterns) {
    const hit = str(html).match(pattern);
    if (hit) {
      const ms = Date.parse(hit[1]);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }
  return '';
}

async function readLimited(response, maxBytes) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          chunks.push(value.subarray(0, value.byteLength - (size - maxBytes)));
          break;
        }
        chunks.push(value);
      }
    } finally {
      try { await reader.cancel(); } catch { /* 已结束 */ }
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.subarray(0, maxBytes);
}

function decodeBody(buffer, contentType) {
  const match = /charset=["']?([\w-]+)/i.exec(str(contentType));
  let encoding = (match ? match[1] : 'utf-8').toLowerCase();
  if (encoding === 'gb2312' || encoding === 'gbk') encoding = 'gb18030';
  try { return new TextDecoder(encoding).decode(buffer); } catch { return new TextDecoder('utf-8').decode(buffer); }
}

async function httpGet(context, url, options) {
  const fetchImpl = context.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(options.timeoutMs) || 6000));
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) throw new Error('http_' + response.status);
    const buffer = await readLimited(response, Number(options.maxBytes) || PAGE_MAX_BYTES);
    return {
      status: response.status,
      url: str(response.url) || url,
      contentType: str(response.headers && response.headers.get ? response.headers.get('content-type') : ''),
      body: decodeBody(buffer, str(response.headers && response.headers.get ? response.headers.get('content-type') : '')),
    };
  } finally {
    clearTimeout(timer);
  }
}

function pickPassages(text, keys, maxChars) {
  const limit = Math.max(80, Number(maxChars) || 240);
  // 导航栏、页脚、备案信息：这类段落没有信息量，别占正文摘录的位置。
  const NAV = /关于腾讯|About Tencent|服务协议|隐私政策|隐私保护|开放平台|广告服务|腾讯招聘|腾讯公益|客服中心|举报中心|网站导航|版权所有|Copyright|All Rights Reserved|登录|注册|下载客户端|意见反馈|ICP|网络文化经营|举报电话|未成年人|友情链接|联系我们/;
  const paragraphs = str(text)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length >= 12 && !(NAV.test(line) && line.length < 200));
  const wanted = [...new Set(keys.filter(Boolean))];
  const scored = paragraphs.map((line, index) => {
    let score = 0;
    for (const key of wanted) if (line.includes(key)) score += 2;
    if (/比分|赛果|战胜|击败|不敌|拿下|夺冠|发布|通报|宣布|回应|表示/.test(line)) score += 1;
    return { line, index, score };
  });
  const hits = scored.filter(entry => entry.score > 0);
  // 没有相关段落时就别硬摘了：宁可空着，也不把“关于腾讯/服务协议”当正文。
  const fallback = scored.filter(entry => entry.line.length >= 60 && !NAV.test(entry.line)).slice(0, 2);
  const chosen = (hits.length ? hits : fallback).slice(0, 8).sort((a, b) => a.index - b.index);
  let out = '';
  for (const entry of chosen) {
    if (out.length >= limit) break;
    const piece = clip(entry.line, Math.min(limit - out.length, 300));
    if (!piece) continue;
    out += (out ? '\n' : '') + piece;
  }
  return out.slice(0, limit);
}

async function deepRead(context, item, intent, settings, deadline) {
  const left = deadline - Date.now();
  if (left <= 600) return null;
  try {
    const page = await httpGet(context, item.url, {
      timeoutMs: Math.min(6000, Math.max(800, left - 200)),
      maxBytes: PAGE_MAX_BYTES,
    });
    if (!/text\/html|application\/xhtml/i.test(page.contentType)) return null;
    const raw = page.body;
    if (!raw || raw.length < 200) return null;
    const text = htmlToText(raw);
    if (text.length < 40) return null;
    const keys = [...teamNames(intent.text), ...(intent.text.match(LEAGUES) || []), '比分', '赛果', '比赛', '发布', '通报', '宣布'];
    return {
      text: pickPassages(text, keys, settings.deepReadChars),
      publishedAt: metaDate(raw),
      title: clip((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '', 160),
    };
  } catch { return null; }
}

// ---------- 搜索 ----------

function failure(status, reason, attempts) {
  return { status, reason: reason || 'no_results', items: [], staleItems: [], attempts: attempts || [], elapsedMs: 0 };
}

async function hostSearch(context, request, settings, deadline) {
  const whale = context.whale || context.host;
  if (!whale || typeof whale.search !== 'function') return failure('failed', 'host_search_unavailable');
  const left = deadline - Date.now();
  if (left <= 500) return failure('failed', 'deadline_exceeded');
  const options = {
    timeZone: request.timeZone,
    timeoutMs: Math.max(500, Math.min(settings.searchTimeoutMs, left - 200)),
  };
  if (request.dateRange) options.dateRange = { start: request.dateRange.start, end: request.dateRange.end };
  try {
    const out = await whale.search(request.query, options);
    if (!out || typeof out !== 'object') return failure('failed', 'invalid_host_result');
    const items = (Array.isArray(out.items) ? out.items : []).map(item => normalizeItem(item, 'host')).filter(Boolean);
    return {
      status: str(out.status) || (items.length ? 'ok' : 'empty'),
      reason: str(out.reason),
      items,
      staleItems: Array.isArray(out.staleItems) ? out.staleItems : [],
      attempts: Array.isArray(out.attempts) ? out.attempts : [],
      elapsedMs: Number(out.elapsedMs) || 0,
    };
  } catch (error) {
    return failure('failed', str(error && error.code) || 'host_search_failed');
  }
}

function parseRss(xml) {
  const blocks = str(xml).match(/<item[\s\S]*?<\/item>/gi) || [];
  const items = [];
  for (const block of blocks.slice(0, 10)) {
    const pick = tag => {
      const hit = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
      return hit ? clip(decodeEntities(hit[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')), 600) : '';
    };
    const title = pick('title');
    const url = pick('link');
    if (!title || !url) continue;
    const published = pick('pubDate');
    const ms = Date.parse(published);
    items.push({
      title,
      url,
      snippet: pick('description'),
      publishedAt: Number.isFinite(ms) ? new Date(ms).toISOString() : '',
      provider: 'bing-rss',
      fetchedAt: new Date().toISOString(),
    });
  }
  return items;
}

async function rssSearch(context, request, deadline) {
  const left = deadline - Date.now();
  if (left <= 800) return [];
  const url = 'https://www.bing.com/search?format=rss&setlang=zh-CN&q=' + encodeURIComponent(request.query);
  try {
    const page = await httpGet(context, url, {
      timeoutMs: Math.min(5000, Math.max(800, left - 200)),
      maxBytes: 600000,
    });
    return parseRss(page.body).map(item => normalizeItem(item, 'bing-rss')).filter(Boolean);
  } catch { return []; }
}

async function collect(context, plan, settings, deadline) {
  const results = await Promise.allSettled(plan.map(request =>
    hostSearch(context, request, settings, deadline)));
  const items = [];
  const attempts = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      items.push(...result.value.items);
      attempts.push(...result.value.attempts);
    }
  }
  let status = items.length ? 'ok' : 'empty';
  if (!items.length) {
    for (const request of plan) {
      if (Date.now() >= deadline - 800) break;
      const fallback = await rssSearch(context, request, deadline);
      if (fallback.length) {
        items.push(...fallback);
        attempts.push({ provider: 'bing-rss', status: 'ok', parsed: fallback.length, relevant: fallback.length });
        break;
      }
    }
    if (items.length) status = 'ok';
  }
  return { status, items: dedupe(items), attempts };
}

// ---------- ESPN 结构化赛果 ----------

function localDay(iso, zone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: safeZone(zone), year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function teamKeys(text) {
  const keys = [];
  for (const [name, aliases] of Object.entries(TEAM_ALIASES)) {
    if (!str(text).includes(name)) continue;
    for (const alias of aliases) if (!keys.includes(alias)) keys.push(alias);
  }
  return keys;
}

function cnTeam(name) {
  const lower = str(name).toLowerCase();
  for (const [cn, aliases] of Object.entries(TEAM_ALIASES)) {
    if (aliases.some(alias => lower.includes(alias))) return cn;
  }
  return str(name);
}

function eventTeams(event) {
  const competition = (event.competitions && event.competitions[0]) || {};
  const list = Array.isArray(competition.competitors) ? competition.competitors : [];
  return {
    home: list.find(x => x.homeAway === 'home') || {},
    away: list.find(x => x.homeAway === 'away') || {},
    competition,
  };
}

function eventSearchText(event) {
  const { home, away } = eventTeams(event);
  return [home.team, away.team]
    .map(team => team && `${team.displayName} ${team.name} ${team.shortDisplayName} ${team.abbreviation}`)
    .join(' ').toLowerCase();
}

function statusCn(event) {
  const type = (event.status && event.status.type) || {};
  return ESPN_STATUS[type.name] || str(type.description) || '状态未知';
}

function scoreOf(competitor) {
  const n = Number.parseInt(competitor && competitor.score, 10);
  return Number.isFinite(n) ? String(n) : '';
}

function scoreboardItem(event, zone) {
  const { home, away, competition } = eventTeams(event);
  const homeName = cnTeam(home.team && home.team.displayName);
  const awayName = cnTeam(away.team && away.team.displayName);
  const status = statusCn(event);
  const homeScore = scoreOf(home);
  const awayScore = scoreOf(away);
  const played = ['已结束', '进行中', '中场', '节间'].includes(status);
  const score = played && homeScore && awayScore ? `${awayScore}-${homeScore}` : '';
  const winner = played && (home.winner ? homeName : away.winner ? awayName : '');
  const title = `${awayName}${score ? ' ' + awayScore : ''} vs ${homeName}${score ? ' ' + homeScore : ''}（${status}${winner ? '，' + winner + '胜' : ''}）`;
  const venue = str(competition.venue && competition.venue.fullName);
  const when = fmtTime(event.date, zone) || str(event.date);
  const url = event.id
    ? `https://www.espn.com/nba/game/_/gameId/${event.id}`
    : 'https://www.espn.com/nba/scoreboard';
  return {
    title,
    url,
    snippet: `${status}｜${when}${venue ? '｜' + venue : ''}${score ? '｜比分 ' + score : ''}`,
    publishedAt: event.date || null,
    provider: 'espn',
    scoreboard: true,
    noRead: true,
    fetchedAt: new Date().toISOString(),
  };
}

async function espnDay(context, day, zone, deadline) {
  const budget = Math.min(5000, Math.max(600, deadline - Date.now() - 500));
  if (budget < 400) return [];
  const fetchImpl = context.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const url = `${ESPN_NBA_SCOREBOARD}?dates=${day.replace(/-/g, '')}`;
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/125', Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const data = JSON.parse(await response.text());
    return Array.isArray(data.events) ? data.events : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function espnScoreboard(context, intent, settings, deadline) {
  const zone = intent.timeZone;
  const nowDay = ymd(intent.now, zone);
  const range = intent.dateRange || { start: nowDay, end: nowDay, label: '' };
  if (!range.start || !range.end) return null;
  // ESPN 的 dates 是美东日期，可能比北京时间晚一天；两侧各多查一天再按用户时区过滤。
  const days = [];
  for (let day = addDays(range.start, -1); day <= addDays(range.end, 1); day = addDays(day, 1)) days.push(day);
  const settled = await Promise.allSettled(days.slice(0, 4).map(day => espnDay(context, day, zone, deadline)));
  const seen = new Set();
  const events = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const event of result.value) {
      if (event && event.id && !seen.has(event.id)) { seen.add(event.id); events.push(event); }
    }
  }
  const inRange = events.filter(event => {
    const day = localDay(event.date, zone);
    return day && day >= range.start && day <= range.end;
  });
  const keys = teamKeys(intent.text);
  const picked = keys.length ? inRange.filter(event => keys.some(key => eventSearchText(event).includes(key))) : inRange;
  const shown = (picked.length ? picked : inRange).slice(0, 8).map(event => scoreboardItem(event, zone));
  const missed = [];
  if (picked.length) {
    for (const [cn, aliases] of Object.entries(TEAM_ALIASES)) {
      if (!intent.text.includes(cn)) continue;
      if (!picked.some(event => aliases.some(alias => eventSearchText(event).includes(alias)))) missed.push(cn);
    }
  }
  const dayLabel = range.start === range.end ? humanDay(range.start) : `${range.start} 至 ${range.end}`;
  const lines = [];
  if (picked.length) {
    lines.push(`【赛果（ESPN 记分牌）】${dayLabel}（${zone}）`);
    shown.forEach(item => lines.push(`· ${item.title}｜${item.snippet}`));
    if (missed.length) lines.push(`· 未找到${[...new Set(missed)].join('、')}在该日期的比赛。`);
  } else if (inRange.length) {
    const asked = teamNames(intent.text);
    const who = asked.length ? asked.join(' / ') : keys.length ? keys.join(' / ') : '指定球队';
    lines.push(`【赛果（ESPN 记分牌）】${dayLabel}：没有 ${who} 的比赛。`);
    lines.push('当日其他场次：');
    shown.forEach(item => lines.push(`· ${item.title}`));
  } else {
    lines.push(`【赛果（ESPN 记分牌）】${dayLabel}（${zone}）：ESPN 没有该日期的 NBA 比赛记录。`);
  }
  return {
    items: shown,
    text: lines.join('\n'),
    matched: picked.length > 0,
    day: range.start === range.end ? range.start : `${range.start}~${range.end}`,
  };
}

// ---------- 组装注入文本 ----------

function pubLabel(item, zone) {
  if (!item.publishedAt) return '未确认';
  const shown = fmtTime(item.publishedAt, zone);
  return shown ? `${shown}（${item.pubFrom === 'page' ? '页面标注' : '来源标注'}）` : '未确认';
}

function offDate(item, range, zone) {
  if (!item.publishedAt || !range) return false;
  const day = localDay(item.publishedAt, zone || DEFAULT_TZ);
  // 前一晚的比赛常在次日才出报道，允许目标日期后一天。
  return day < range.start || day > addDays(range.end, 1);
}

// 从摘要里挑一句最有“结论感”的话：优先带数字、胜负、涨跌、发布/回应。
function bestSentence(item) {
  const raw = str(item && item.snippet).replace(/\s+/g, ' ');
  const parts = raw.split(/[。！？!?；;]/).map(x => x.trim()).filter(x => x.length >= 8);
  const scored = parts.map(part => ({
    part,
    score: (/\d/.test(part) ? 3 : 0)
      + (/胜|负|赢|输|涨|跌|发布|宣布|通报|回应|上涨|下跌|亿元|%/.test(part) ? 2 : 0)
      + (/20\d{2}|月|日|时|点/.test(part) ? 1 : 0),
  })).sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].part : '';
}

// 简单归纳：一句结论 + 最多 3 条关键事实。不做二次模型调用，延迟可控。
function summarize(bundle) {
  const items = Array.isArray(bundle.items) ? bundle.items : [];
  const lines = [];
  if (bundle.scoreText) {
    const rows = str(bundle.scoreText).split('\n').map(x => x.trim()).filter(Boolean);
    // 先看赛果标题行：“没有某队的比赛”本身就是结论，别拿当天其他场次冒充。
    const headline = rows.find(x => x.startsWith('【赛果') && /没有|未找到/.test(x));
    const firstGame = rows.find(x => x.startsWith('·'));
    if (headline) lines.push(clip(headline.replace(/^【赛果（ESPN 记分牌）】/, ''), 110));
    else if (firstGame) lines.push(clip(firstGame.replace(/^·\s*/, '').split('｜')[0], 110));
  }
  if (!lines.length && items.length) {
    const item = items[0];
    const sentence = bestSentence(item);
    lines.push(clip(`${clip(item.title, 64)}${sentence ? '：' + sentence : ''}`, 130));
  }
  if (!lines.length) lines.push('这次没有查到能确认的具体事实。');

  const facts = [];
  const noMatch = !!(bundle.scoreboard && bundle.scoreText && !bundle.scoreboard.matched);
  if (noMatch) {
    // 当天没有这队/这场：只报“没有”，别把其他场次塞进关键事实里冒充答案。
    facts.push(clip(str(bundle.scoreText).split('\n')[0].replace(/^【赛果（ESPN 记分牌）】/, ''), 100));
  } else {
    items.slice(0, Math.max(1, Math.min(3, Number(bundle.maxFacts) || 3))).forEach(item => {
      const host = hostOf(item.url);
      const when = item.publishedAt ? localDay(item.publishedAt, bundle.timeZone) : '';
      const sentence = bestSentence(item);
      const detail = sentence && !lines[0].includes(sentence) ? '：' + sentence : '';
      facts.push(clip(`${clip(item.title, 44)}${detail}（${host || '来源未知'}${when ? '｜' + when : ''}）`, 100));
    });
  }
  return { conclusion: lines[0], facts };
}

// 给模型的口吻提示。资料是资料，最终怎么说仍由人格预设决定。
function voiceHint(voice) {
  const name = str(voice, 'dafeiyu');
  if (name === 'plain') return '';
  if (name === 'jingjing') {
    return '【给鲸鲸的提示】用鲸鲸平时温柔、慢热、嘴硬心软的口吻说：先给结论或数字，再补一句关心；最多两句，别列点、别报来源。';
  }
  return '【给鲸鲸的提示】用大肥鱼的口气说：先甩结论/比分/数字，再补一句锐评或嫌弃（麻了、闹麻了、你无敌了、6 都行）；最多两句，别列点、别分段、别复述来源，也别说“根据搜索结果”。';
}

function composeText(bundle) {
  const items = Array.isArray(bundle.items) ? bundle.items.slice(0, MAX_ITEMS) : [];
  const zone = bundle.timeZone;
  const max = Math.max(600, Math.min(MAX_TEXT, Number(bundle.maxChars) || 1500));
  const range = bundle.dateRange;
  const lines = [];
  const used = () => lines.reduce((sum, line) => sum + line.length + 1, 0);
  const push = line => {
    const text = str(line).replace(UNSAFE, ' ');
    if (!text) return true;
    if (used() + text.length + 1 > max) return false;
    lines.push(text);
    return true;
  };

  push(`【深度联网搜索】${bundle.nowLabel}（${zone}）`);
  push(`问题：${clip(bundle.query, 100)}`);
  push(`时间范围：${bundle.dateLabel || (range ? `${range.start} 至 ${range.end}` : '不限')}｜来源：${items.length} 个${bundle.deepReadCount ? `｜已读正文：${bundle.deepReadCount} 篇` : ''}`);
  if (bundle.scoreText) push(bundle.scoreText);

  // 结论和事实放在来源列表前面：即使后面被字数上限截断，也先保住“能直接说出口”的部分。
  const brief = summarize({ ...bundle, items });
  push(`【一句话结论】${brief.conclusion}`);
  if (brief.facts.length) {
    push('【关键事实】');
    brief.facts.forEach((fact, index) => push(`${index + 1}. ${fact}`));
  }
  push('核对：发布时间以来源页标注为准；标“未确认”的别当事实；比分/通报以官方或多源一致为准，冲突时先说明冲突。');

  if (bundle.deepReadCount) {
    const excerpts = items.filter(item => item.read && item.read.text).slice(0, 2);
    if (excerpts.length) {
      push('【正文摘录】');
      excerpts.forEach((item, index) => {
        push(`${index + 1}) ${clip(item.read.text, Math.min(bundle.deepReadChars || 240, 160))}`);
      });
    }
  }

  items.forEach((item, index) => {
    const host = hostOf(item.url);
    const flag = offDate(item, range, zone) ? '｜注意：发布时间不在目标日期' : '';
    if (!push(`${index + 1}. ${clip(item.title, 110)}`)) return;
    push(`   来源：${host || '未知'}｜发布：${pubLabel(item, zone)}${flag}`);
    if (index < 2 && item.snippet) push(`   摘要：${clip(item.snippet, 110)}`);
    push(`   链接：${item.url}`);
  });

  const hint = voiceHint(bundle.voice);
  if (hint) push(hint);
  const statusLine = bundle.status && bundle.status !== 'ok' ? `检索状态：${bundle.status}（来源可能不完整）` : '';
  if (statusLine) push(statusLine);
  return lines.join('\n').replace(UNSAFE, ' ').slice(0, max);
}

function makeSearch(bundle) {
  const items = (bundle.items || []).slice(0, MAX_ITEMS).map(item => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    publishedAt: item.publishedAt || null,
    provider: item.provider || 'host',
    fetchedAt: item.fetchedAt || new Date().toISOString(),
  }));
  return {
    status: bundle.status || (items.length ? 'ok' : 'empty'),
    reason: bundle.reason || (items.length ? 'available' : 'no_results'),
    items,
    staleItems: [],
    attempts: bundle.attempts || [],
    elapsedMs: bundle.elapsedMs || 0,
    text: bundle.text,
    source: TAG,
    requested: {
      query: bundle.query,
      timeZone: bundle.timeZone,
      dateRange: bundle.dateRange || null,
      domain: bundle.domain,
    },
    dateFilter: 'query_hint_only',
  };
}

// ---------- 设置 ----------

function readSettings(raw) {
  const box = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = ['smart', 'always', 'off'].includes(str(box.mode)) ? str(box.mode) : 'smart';
  const voice = ['dafeiyu', 'jingjing', 'plain'].includes(str(box.voice)) ? str(box.voice) : 'dafeiyu';
  return {
    mode,
    voice,
    timeZone: safeZone(box.timeZone),
    maxQueries: int(box.maxQueries, 2, 1, 4),
    maxSources: int(box.maxSources, 4, 1, 8),
    maxFacts: int(box.maxFacts, 3, 1, 5),
    deepRead: bool(box.deepRead, true),
    deepReadCount: int(box.deepReadCount, 2, 0, 3),
    deepReadChars: int(box.deepReadChars, 240, 120, 800),
    maxTextChars: int(box.maxTextChars, 1500, 800, 24000),
    searchTimeoutMs: int(box.searchTimeoutMs, 8000, 2000, 20000),
    timeoutMs: int(box.timeoutMs, 20000, 5000, 90000),
    forceAll: bool(box.forceAll, false),
    enrichHost: bool(box.enrichHost, false),
    sportsApi: bool(box.sportsApi, true),
    trusted: list(box.trustedDomains),
    blocked: list(box.blockedDomains),
    demoQuery: clip(box.demoQuery, 80) || '今天NBA有什么比赛结果',
  };
}

function effectiveSettings(settings) {
  return {
    mode: settings.mode,
    voice: settings.voice,
    timeZone: settings.timeZone,
    maxQueries: settings.maxQueries,
    maxSources: settings.maxSources,
    maxFacts: settings.maxFacts,
    deepRead: settings.deepRead,
    deepReadCount: settings.deepReadCount,
    deepReadChars: settings.deepReadChars,
    maxTextChars: settings.maxTextChars,
    searchTimeoutMs: settings.searchTimeoutMs,
    timeoutMs: settings.timeoutMs,
    forceAll: settings.forceAll,
    enrichHost: settings.enrichHost,
    sportsApi: settings.sportsApi,
    trustedDomains: settings.trusted,
    blockedDomains: settings.blocked,
  };
}

// chat.search 与 chat.search_result 是两次独立调用，now 会差几毫秒，不能进签名；
// 用「会话 + 分钟窗口 + 原文」判断是不是同一条消息的同一轮。
function signature(context) {
  const bucket = Math.floor((Number(context.now) || Date.now()) / 60000);
  return `${str(context.key || 'chat')}|${bucket}|${str(context.message && context.message.text).slice(0, 160)}`;
}

// ---------- 主流程 ----------

async function research(context, intent, settings) {
  const started = Date.now();
  const deadline = started + settings.timeoutMs;
  const plan = buildQueries(intent, settings);
  const gathered = await collect(context, plan, settings, deadline);
  const basketball = /NBA|篮球|CBA|WNBA/i.test(intent.text) || NBA_TEAMS.some(name => intent.text.includes(name));
  let board = null;
  if (settings.sportsApi && intent.domain === 'sports' && basketball) {
    board = await espnScoreboard(context, intent, settings, deadline);
  }
  const ranked = rank(gathered.items, intent, settings);
  let items = board && board.items.length ? dedupe([...board.items, ...ranked]) : ranked;
  let reads = 0;

  if (settings.deepRead && settings.deepReadCount > 0 && items.length) {
    // 多抓几条候选再采纳前 N 条成功的，避免首条被反爬或空壳页挡住。
    const limit = Math.min(4, Math.max(settings.deepReadCount, 3));
    const targets = items.filter(item => !item.noRead && !blocked(item.url, settings)).slice(0, limit);
    const pages = await Promise.allSettled(targets.map(item =>
      deepRead(context, item, intent, settings, deadline)));
    for (let index = 0; index < pages.length; index += 1) {
      if (reads >= settings.deepReadCount) break;
      const result = pages[index];
      if (result.status !== 'fulfilled' || !result.value || !result.value.text) continue;
      const item = targets[index];
      item.read = { text: result.value.text };
      if (!item.publishedAt && result.value.publishedAt) {
        item.publishedAt = result.value.publishedAt;
        item.pubFrom = 'page';
      }
      reads += 1;
    }
    // 抓到正文后按“有发布时间”重排一次，让信息更完整的来源排在前面。
    items = rank(items, intent, settings);
  }

  const text = composeText({
    items,
    query: intent.text,
    dateRange: intent.dateRange,
    dateLabel: intent.dateRange ? intent.dateRange.label : '',
    timeZone: intent.timeZone,
    nowLabel: nowLabel(intent.now, intent.timeZone),
    status: items.length ? 'ok' : 'empty',
    deepReadCount: reads,
    deepReadChars: settings.deepReadChars,
    maxChars: settings.maxTextChars,
    domain: intent.domain,
    scoreText: board ? board.text : '',
    scoreboard: board ? { matched: board.matched, day: board.day, items: board.items.length } : null,
    voice: settings.voice,
    maxFacts: settings.maxFacts,
  });

  const ok = items.length > 0 || Boolean(board && board.text);
  return {
    status: ok ? 'ok' : 'empty',
    reason: ok ? (board && board.matched ? 'scoreboard' : 'available') : gathered.reason || 'no_results',
    items,
    attempts: gathered.attempts,
    elapsedMs: Date.now() - started,
    text,
    query: intent.text,
    dateRange: intent.dateRange,
    domain: intent.domain,
    timeZone: intent.timeZone,
    reads,
    plan,
    scoreText: board ? board.text : '',
    scoreboard: board ? { matched: board.matched, day: board.day, items: board.items.length } : null,
  };
}

exports.intent = detect;
exports.parseDateRange = parseDateRange;
exports.buildQueries = buildQueries;
exports.composeText = composeText;
exports.cleanQuery = cleanQuery;
exports.VERSION = VERSION;

function makeSkip(reason) {
  return {
    status: 'skipped',
    reason,
    items: [],
    staleItems: [],
    attempts: [],
    elapsedMs: 0,
    text: '',
    source: TAG,
    dateFilter: 'query_hint_only',
  };
}

async function chatSearch(context) {
    const settings = readSettings(context.settings);
    const message = context.message || {};
    const raw = str(message.text);
    let detected = detect(raw, {
      now: context.now,
      timeZone: settings.timeZone,
      force: settings.forceAll || /^[\/／](查|search)[\s:：]/i.test(raw),
    });
    if (!detected && settings.mode === 'always') {
      detected = {
        text: raw, query: cleanQuery(raw), domain: 'web', dateRange: null,
        timeZone: settings.timeZone, now: context.now, sports: false,
      };
    }
    if (!detected) {
      // 判断“这句不需要既定事实”：返回 skipped 让宿主别再默认搜一遍。
      // 拿不准的长句/问句仍返回 {}，交给宿主自己的搜索判断兜底。
      const quiet = CHITCHAT.test(raw) || CREATIVE.test(raw);
      const uncertain = raw.length > 40 || /[?？]/.test(raw) || FACT.test(raw);
      if (settings.mode === 'off' || quiet || !uncertain) {
        return { search: makeSkip(settings.mode === 'off' ? 'off' : 'not_needed') };
      }
      return {};
    }

    const bundle = await research(context, detected, settings);
    if (!bundle.items.length) {
      // 不让空结果挡住宿主默认搜索；下一钩子会把宿主结果补强。
      return {
        state: {
          ...(context.state && typeof context.state === 'object' ? context.state : {}),
          deepWeb: { sig: signature(context), ok: false, at: Date.now() },
        },
      };
    }

    return {
      search: makeSearch(bundle),
      state: {
        ...(context.state && typeof context.state === 'object' ? context.state : {}),
        deepWeb: { sig: signature(context), ok: true, at: Date.now() },
      },
    };
}

async function chatSearchResult(context) {
    const settings = readSettings(context.settings);
    const state = context.state && typeof context.state === 'object' ? context.state : {};
    const mark = state.deepWeb;
    const same = mark && mark.sig === signature(context);
    if (same && mark.ok) return {};
    if (!settings.enrichHost) return {};

    const original = context.search;
    if (!original || typeof original !== 'object' || original.status !== 'ok' || !Array.isArray(original.items)) return {};
    const items = original.items.map(item => normalizeItem(item, 'host')).filter(Boolean);
    if (!items.length) return {};

    const intent = {
      text: str(context.message && context.message.text),
      query: str(context.message && context.message.text),
      dateRange: parseDateRange(str(context.message && context.message.text), context.now, settings.timeZone),
      timeZone: settings.timeZone,
      now: context.now,
      domain: domainOf(str(context.message && context.message.text)),
    };
    const deadline = Date.now() + settings.timeoutMs;
    let reads = 0;
    if (settings.deepRead && settings.deepReadCount > 0) {
      const targets = rank(items, intent, settings).filter(item => !blocked(item.url, settings)).slice(0, settings.deepReadCount);
      const pages = await Promise.allSettled(targets.map(item => deepRead(context, item, intent, settings, deadline)));
      pages.forEach((result, index) => {
        if (result.status !== 'fulfilled' || !result.value) return;
        const item = targets[index];
        item.read = { text: result.value.text };
        if (!item.publishedAt && result.value.publishedAt) {
          item.publishedAt = result.value.publishedAt;
          item.pubFrom = 'page';
        }
        reads += 1;
      });
    }
    const text = composeText({
      items: rank(items, intent, settings),
      query: intent.query,
      dateRange: intent.dateRange,
      dateLabel: intent.dateRange ? intent.dateRange.label : '',
      timeZone: settings.timeZone,
      nowLabel: nowLabel(context.now, settings.timeZone),
      status: 'ok',
      deepReadCount: reads,
      deepReadChars: settings.deepReadChars,
      maxChars: settings.maxTextChars,
      domain: intent.domain,
      voice: settings.voice,
      maxFacts: settings.maxFacts,
    });
    return { search: { ...original, text, source: TAG + '+host' } };
}

async function toolRun(context) {
    const settings = readSettings(context.settings);
    const raw = context.input;
    const text = typeof raw === 'string'
      ? raw
      : str(raw && (raw.text || raw.query || raw.q || raw.message));
    if (!text.trim()) {
      return {
        text: [
          '深度联网搜索：每条要回复的消息都会先判断要不要联网；点「运行一次」填一句具体问题可以手动试查。',
          `  ${settings.demoQuery}`,
          ' 昨天NBA湖人打勇士谁赢了，比分多少',
          ' 今天有什么新闻',
          '结果会整理成「一句话结论 + 关键事实 + 来源与时间」，并附一句大肥鱼口吻提示。',
          'mode=smart（默认，按需）/always（每条都查）/off（不查）；voice=dafeiyu/jingjing/plain。',
          '配置项都在卡片「设置」的 JSON 里，留空使用默认值。',
        ].join('\n'),
        data: {
          ok: true,
          plugin: TAG,
          version: VERSION,
          settings: effectiveSettings(settings),
          examples: ['今天NBA有什么比赛结果', '昨天湖人打勇士谁赢了', '今天有什么新闻', '帮我查一下明天成都天气', '帮我写一首关于秋天的诗'],
        },
      };
    }

    const detected = detect(text, { now: context.now, timeZone: settings.timeZone, force: true });
    const bundle = await research(context, detected, settings);
    const summary = composeText({
      items: bundle.items,
      query: bundle.query,
      dateRange: bundle.dateRange,
      dateLabel: bundle.dateRange ? bundle.dateRange.label : '',
      timeZone: bundle.timeZone,
      nowLabel: nowLabel(context.now, bundle.timeZone),
      status: bundle.status,
      deepReadCount: bundle.reads,
      deepReadChars: settings.deepReadChars,
      maxChars: Math.min(settings.maxTextChars, MAX_TOOL_TEXT),
      domain: bundle.domain,
      scoreText: bundle.scoreText || '',
      scoreboard: bundle.scoreboard || null,
      voice: settings.voice,
      maxFacts: settings.maxFacts,
    });
    return {
      text: summary || '没有检索到可用来源。可以换一种说法，或在设置里把 maxQueries 调到 3。',
      data: {
        ok: bundle.status === 'ok',
        status: bundle.status,
        query: bundle.query,
        domain: bundle.domain,
        dateRange: bundle.dateRange,
        timeZone: bundle.timeZone,
        queries: bundle.plan.map(entry => entry.query),
        sources: bundle.items.map(item => ({
          title: item.title,
          url: item.url,
          publishedAt: item.publishedAt || null,
          provider: item.provider,
          read: Boolean(item.read && item.read.text),
        })),
        elapsedMs: bundle.elapsedMs,
        settings: effectiveSettings(settings),
      },
    };
}

function guard(fn, fallback) {
  return async function guarded(context) {
    try {
      return await fn(context);
    } catch {
      return typeof fallback === 'function' ? fallback(context) : fallback;
    }
  };
}

exports.hooks = {
  'chat.search': guard(chatSearch, () => ({})),
  'chat.search_result': guard(chatSearchResult, () => ({})),
  'tool.run': guard(toolRun, () => ({
    text: '查证失败：插件内部错误，本次已跳过。可以稍后重试，或把 maxQueries 调到 1 再试。',
    data: { ok: false, error: 'internal_error' },
  })),
};

exports.run = exports.hooks['tool.run'];
