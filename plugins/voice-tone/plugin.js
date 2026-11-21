/**
 * 鲸鲸语音语气插件（Api 4）。
 *
 * 只做「文本加工」，不抢发送权（1.0.2 起）：
 *   1) 按 data/voice-presets.json 的当前预设，把该预设的 instructions 同步进
 *      data/voice-send.json（语气指令，启动器/桥接读取）；
 *   2) 全语音模式（语音概率 100%）下，把 Breeze 音频标签插进回复文本；
 *   3) 返回加工后的 text，由宿主原生流程决定发文字还是发语音。
 *
 * 为什么不再自己调 whale.sendVoice：宿主 send() 会把插件传入的第一个参数当 wxid
 * 塞进提醒队列，而插件能拿到的只有内部会话 id（不是 wxid/昵称），异步发送时
 * 桥接在微信里搜不到会话 → 语音发不出去、文字又被吞 → 消息彻底丢失。
 * 原生发送通道是可靠的，所以把发送交还宿主。
 */

const fs = require('node:fs');
const path = require('node:path');
const whale = require('whale');

const ROOT = whale.paths.appRoot;
const PRESET_FILE = path.join(ROOT, 'data', 'voice-presets.json');
const SEND_FILE = path.join(ROOT, 'data', 'voice-send.json');
const BREAKS = '，,。！!？?；;…';
// 表演型标签：作用于整句念法，放句首；其余一律按反应型处理（放触发词前）
const LEAD_TAGS = ['[喊叫]', '[耳语]'];
/** 注入给 LLM 的语音标签规范（放在 system prompt 末尾，不改人设文件）。 */
const TAG_RULES_PROMPT = [
  '【语音音效标签（只在发语音时用）】',
  '可用标签仅限这些：[笑][轻笑][咯咯笑][哭声][抽泣][呜咽][叹气][惊呼][吸气][耳语][喊叫][停顿][清嗓][啧嘴][打哈欠][闷哼][冷笑][哼鼻子]。',
  '规则：一句最多用一个；表演型（[喊叫][耳语][冷笑]）放在整句最前面；反应型（[叹气][啧嘴][哼鼻子][轻笑][吸气]）紧贴触发词前面；不要自造其它标签（例如 [撒娇][笑眯眯][开心] 都不行）；发纯文字时完全不要带标签。',
].join('\n');


const LEAD_WORDS = ['唉', '哎', '啧', '哼', '算了', '无所谓'];
// 与 bridge/voice_reply.py 的 REQUEST / NEGATIVE / choose() 保持完全一致，
// 这样插件能算准「这条回复一定会被发成语音」，避免给文字回复加上音效标签。
const REQUEST = /(?:发|来|说|讲|回复)(?:给我|个|一条|一句|句|段|一段|条|一下|点|一段话|个回复|次|一)?\s*语音|用语音(?:回|说|讲)|语音(?:回我|回复|说一句)/;
const NEGATIVE = /不要|别(?:再)?|不想|不用|不能|怎么|如何|他说|她说|有人说|关闭|取消|["“”‘’]/;
// 「没写"语音"两个字、但明显是在要声音」的说法（在 REQUEST 之外补一层）
// —— 这类以前会被当成普通聊天掉进概率骰子，用户看着像「我要语音她怎么打字」
const EXTRA_VOICE = /(?:别|不用|不要)(?:再)?打字|打字太慢|直接说|说给我听|说句话|听你说|听你的声音|听听你的?声音|语音条|录(?:一)?段|发段录音|用嘴说|说话给我听|想听你|想听(?:你)?(?:撒|哄|唱|笑|叫|哼|念)/;

const TEXT_ONLY = /(?:不要|别|不用|不想|取消|关闭).{0,12}语音|语音.{0,8}(?:不要|取消|关闭)|(?:用|只要|只用).{0,3}(?:文字|文本)|(?:文字|文本)回复/;

/** 内置默认预设：与分享包 voice-presets.json 完全一致，预设文件不存在时自动生成；已存在（哪怕损坏）绝不覆盖。 */
const DEFAULT_PRESETS = {
  "_说明": "鲸鲸语音预设。改这里不用改代码，重启 WhaleGirl 生效。active 指向当前用哪套；tags 按顺序匹配，命中第一个就停（整段只插一个）。每条可以用 words（关键词数组，自动转义）或 pattern（正则，进阶）。tag 必须是 breeze 官方中文标签原词。 voiceChance = 这套预设的语音概率（0-100，插件按它掷骰子决定这条回语音还是文字；总概率设为 0 时插件不干预，只在你明确要语音时才发）。",
  "_标签参考": "笑[笑][轻笑][咯咯笑]｜哭[哭声][抽泣][呜咽][呻吟][哀号]｜呼吸[叹气][惊呼][吸气][呼气][喘息]｜发声[耳语][喊叫][惨叫][唱歌][哼歌][结巴][停顿]｜喉鼻[清嗓][咳嗽][吸鼻子]｜口腔[咂嘴][啧嘴]｜反射[打哈欠][打喷嚏][打嗝][打饱嗝][吞咽][干呕]｜反应[闷哼][冷笑][哼鼻子]",
  "_不可用的": "官方没有「开心/生气/惊讶/伤心」这类情绪标签，只能映射到最接近的发声事件。自造的词不会被识别，还会被念出来。",
  "active": "irritable",
  "presets": {
    "irritable": {
      "name": "暴躁",
      "desc": "脾气暴、一点就着、说话冲带脏字：吼人、骂人、嫌弃都不留情面",
      "instructions": "她脾气暴躁，一点就着，说话冲、带脏字，句子短促，语速快，重音砸在句尾。被惹毛时直接爆粗，咬牙切齿地吼出来，音量明显抬高，凶得不留情面，不哄人、不道歉。不用播音腔、不撒娇。",
      "tags": [
        {
          "tag": "[喊叫]",
          "words": [
            "滚",
            "闭嘴",
            "少废话",
            "别逼我",
            "你再说一遍",
            "受够了",
            "忍不了",
            "滚蛋",
            "烦不烦",
            "闭嘴吧"
          ],
          "when": "暴躁吼人"
        },
        {
          "tag": "[喊叫]",
          "pattern": "我[草操]|卧[槽草]|他妈的|你妈的|草泥马|nmsl|nm[lL]|tmd|TMD|妈的[！!？?]|傻[逼比]|去死",
          "when": "爆粗口 / 骂人"
        },
        {
          "tag": "[哼鼻子]",
          "words": [
            "气死",
            "烦死",
            "烦人",
            "过分",
            "凭什么",
            "少来",
            "别烦",
            "够了",
            "神经病",
            "有病",
            "讨厌",
            "离谱",
            "气人"
          ],
          "when": "不耐烦"
        },
        {
          "tag": "[冷笑]",
          "words": [
            "就这",
            "笑死",
            "你行你上",
            "你算老几",
            "典",
            "急了",
            "可笑",
            "呵呵",
            "就你",
            "谁信啊"
          ],
          "when": "冷嘲"
        },
        {
          "tag": "[啧嘴]",
          "words": [
            "啧",
            "切",
            "得了吧",
            "省省",
            "别演了",
            "烦"
          ],
          "when": "嫌弃"
        },
        {
          "tag": "[叹气]",
          "words": [
            "无语",
            "懒得",
            "随便",
            "行吧",
            "算了",
            "爱咋咋"
          ],
          "when": "无语"
        },
        {
          "tag": "[吸气]",
          "words": [
            "真的假的",
            "不是吧",
            "睁眼说瞎话"
          ],
          "when": "惊讶"
        },
        {
          "tag": "[闷哼]",
          "pattern": "啊[？?]|哈[？?]|你说什么",
          "when": "反问"
        }
      ],
      "voiceChance": 25
    },
    "adorkable": {
      "name": "呆萌",
      "desc": "慢半拍、反应夸张、容易惊到也容易笑：多用咯咯笑/吸气/清嗓/结巴，不用攻击性声音",
      "instructions": "她反应慢半拍，语气软、有点憨，语速偏慢，句尾轻轻往上带一点，偶尔说着说着自己笑出来。不装可爱、不撒娇、不用播音腔。",
      "tags": [
        {
          "tag": "[吸气]",
          "pattern": "哇+|诶+|欸+|啊[？?]|天哪|好厉害|好可爱|真的假的",
          "when": "被吓到 / 惊叹"
        },
        {
          "tag": "[咯咯笑]",
          "words": [
            "嘿嘿",
            "哈哈",
            "嘻嘻",
            "笑死",
            "好好笑",
            "好玩"
          ],
          "when": "笑开"
        },
        {
          "tag": "[清嗓]",
          "pattern": "呃+|额+|那个[，,]|不是|等等|让我想想",
          "when": "脑子卡住 / 说错话"
        },
        {
          "tag": "[结巴]",
          "pattern": "([我你他她它])\\1{1,}",
          "when": "紧张 / 结巴"
        },
        {
          "tag": "[呜咽]",
          "words": [
            "呜呜",
            "QAQ",
            "不敢了",
            "别凶我",
            "小声"
          ],
          "when": "委屈巴巴 / 小声"
        },
        {
          "tag": "[停顿]",
          "pattern": "……|\\.{3,}|不知道|忘记了",
          "when": "呆住 / 说不上来"
        },
        {
          "tag": "[轻笑]",
          "words": [
            "好耶",
            "太好了",
            "真的吗",
            "可以吗",
            "要要要"
          ],
          "when": "开心地应答"
        }
      ],
      "voiceChance": 25
    },
    "normal": {
      "name": "普通",
      "desc": "平时聊天、正经答题：语气自然平稳，只留两三处轻音效，不抢戏",
      "instructions": "自然、平稳，像平时说话。语速正常，吐字清楚，句尾不上扬也不刻意压。不带明显情绪表演，不用播音腔、不撒娇。",
      "tags": [
        {
          "tag": "[轻笑]",
          "words": [
            "哈哈",
            "笑死",
            "好好笑",
            "好玩"
          ],
          "when": "真的觉得好笑"
        },
        {
          "tag": "[叹气]",
          "words": [
            "无语",
            "算了",
            "行吧",
            "懒得"
          ],
          "when": "轻微无奈"
        },
        {
          "tag": "[吸气]",
          "pattern": "哇[！!]|天哪|真的假的|不是吧",
          "when": "轻度惊讶"
        }
      ],
      "voiceChance": 10
    },
    "gentle": {
      "name": "温柔",
      "desc": "温柔聪明、说话软而清楚，会认真接话，偶尔轻笑轻叹",
      "instructions": "她温柔聪明，说话轻而清楚，语速从容，句尾柔和。会认真接住对方的话，回答周到，偶尔带一点笑意和温度。不装可爱、不结巴、不慢半拍、不用播音腔。",
      "tags": [
        {
          "tag": "[轻笑]",
          "words": [
            "嘿嘿",
            "好呀",
            "好哦",
            "嗯呢",
            "好好笑"
          ],
          "when": "温柔地笑"
        },
        {
          "tag": "[吸气]",
          "pattern": "哇[！!]?|天哪|好厉害|好可爱|真的假的",
          "when": "轻声惊叹"
        },
        {
          "tag": "[叹气]",
          "words": [
            "算了",
            "没事",
            "好吧",
            "别担心"
          ],
          "when": "轻叹但带安慰"
        },
        {
          "tag": "[清嗓]",
          "pattern": "呃+|那个[，,]|让我想想|认真说",
          "when": "认真开口前清嗓"
        },
        {
          "tag": "[耳语]",
          "words": [
            "悄悄",
            "小声",
            "跟你说",
            "秘密"
          ],
          "when": "凑近说小话"
        }
      ],
      "voiceChance": 20
    },
    "cold": {
      "name": "冷酷",
      "desc": "冷淡、惜字如金、懒得搭理：叹气和啧嘴多，几乎不笑",
      "instructions": "她说话冷淡、简短、不带感情，语速平、音调低，句尾不拖也不上扬。对多数话题兴致缺缺，不耐烦时更冷。不笑、不撒娇、不用播音腔。",
      "tags": [
        {
          "tag": "[叹气]",
          "words": [
            "无语",
            "懒得",
            "随便",
            "哦",
            "嗯",
            "行吧",
            "爱咋咋",
            "就这样"
          ],
          "when": "无语 / 敷衍（触发多，符合冷淡）"
        },
        {
          "tag": "[啧嘴]",
          "words": [
            "啧",
            "切",
            "得了",
            "省省",
            "别演了"
          ],
          "when": "嫌弃 / 不耐烦"
        },
        {
          "tag": "[冷笑]",
          "words": [
            "就这",
            "呵",
            "呵呵",
            "无所谓",
            "随你"
          ],
          "when": "冷嘲"
        },
        {
          "tag": "[打哈欠]",
          "words": [
            "无聊",
            "没意思",
            "困",
            "好累"
          ],
          "when": "觉得无聊"
        },
        {
          "tag": "[闷哼]",
          "pattern": "嗯[？?]|啊[？?]|什么[？?]",
          "when": "冷淡反问"
        }
      ],
      "voiceChance": 15
    }
  }
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** data/voice-presets.json 不存在时写入内置默认预设；已存在（哪怕损坏）一律不动。 */
function ensurePresetFile() {
  try {
    if (fs.existsSync(PRESET_FILE)) return false;
    const dir = path.dirname(PRESET_FILE);
    if (!fs.existsSync(dir)) return false;
    fs.writeFileSync(PRESET_FILE, JSON.stringify(DEFAULT_PRESETS, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 把预设里的 words / pattern 编译成正则，单条写错不影响其它条。 */
/** 概率覆盖的状态文件（放在插件数据目录，随插件走）。 */
const STATE_FILE = path.join(whale.paths.pluginData, 'prob-state.json');

/** 设置页读数字项（ctx.settings 由「插件市场 → 已安装 → 设置」写入）。 */
function numSetting(ctx, key, fallback) {
  const raw = ctx && ctx.settings ? ctx.settings[key] : undefined;
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 设置页读布尔项。 */
function boolSetting(ctx, key, fallback) {
  const raw = ctx && ctx.settings ? ctx.settings[key] : undefined;
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  return !/^(0|false|no|off)$/i.test(String(raw));
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writeState(obj) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj), 'utf8');
  } catch {
    /* 写不进状态文件时宁可不覆盖，避免概率卡死 */
  }
}

function clearState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    /* 没有就算了 */
  }
}

/** 按启动器习惯写回 voice-send.json（纯 ASCII 转义）。 */
function writeSend(send) {
  const escaped = JSON.stringify(send).replace(/[\u0080-\uFFFF]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  fs.writeFileSync(SEND_FILE, escaped, 'ascii');
}

/**
 * 还原上次临时覆盖的 Probability。
 *
 * 关键校验：只有「当前值仍是我们写的临时值」时才还原 —— 如果中间被用户手动改过
 * （启动器设置页写入了新概率），说明用户意图已变，直接放弃还原、清掉状态即可。
 */
function restoreProbability() {
  const st = readState();
  if (!st || st.pending !== true || !Number.isFinite(Number(st.original))) {
    clearState();
    return;
  }
  try {
    const send = readJson(SEND_FILE);
    if (!send) return;
    const current = Number(send.Probability);
    if (Number.isFinite(Number(st.temp)) && current !== Number(st.temp)) {
      // 用户中途改过概率：以用户为准，放弃还原
      clearState();
      return;
    }
    send.Probability = Math.max(0, Math.min(100, Number(st.original)));
    writeSend(send);
  } catch {
    /* 还原失败就留状态，下次再试 */
    return;
  }
  clearState();
}

/** 临时把 Probability 改成 100/0，让 bridge 严格跟随插件这次的决定。 */
function overrideProbability(value, current) {
  const target = Number(value) >= 100 ? 100 : 0;
  if (Number(current) === target) return true;
  if (!Number.isFinite(Number(current))) return false;
  writeState({ pending: true, original: Number(current), temp: target, at: Date.now() });
  try {
    const send = readJson(SEND_FILE);
    if (!send) return false;
    send.Probability = target;
    writeSend(send);
    return true;
  } catch {
    clearState();
    return false;
  }
}

function compileRules(tags) {
  const out = [];
  for (const item of tags || []) {
    if (!item || typeof item.tag !== 'string') continue;
    const tag = item.tag.trim();
    if (!/^\[.+\]$/.test(tag)) continue;
    let source = null;
    if (typeof item.pattern === 'string' && item.pattern.trim()) {
      source = item.pattern;
    } else if (Array.isArray(item.words) && item.words.length) {
      const words = item.words
        .map((word) => String(word == null ? '' : word).trim())
        .filter(Boolean)
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (words.length) source = '(?:' + words.join('|') + ')';
    }
    if (!source) continue;
    try {
      out.push({ re: new RegExp(source), tag: tag });
    } catch {
      /* 跳过这一条 */
    }
  }
  return out;
}

/**
 * 插音频标签。分两类（实测 + 与 Breeze/ElevenLabs 实践一致）：
 *
 *   - 表演型（[喊叫] [耳语]）：放在整句最前面，让整句都用这个"念法"说。
 *   - 反应型（[冷笑] [哼鼻子] [叹气] [啧嘴] [吸气] …）：放在**触发词前面**，
 *     音效紧贴那句话说，不抢整句的语气。
 *
 * 触发词本来就在句首时，反应型标签自然落到句首（比如"烦死了，…"→"[哼鼻子] 烦死了，…"）。
 * 已含标签、文本过短、或没命中规则时原样返回。
 */
function addTags(text, rules) {
  const s = String(text == null ? '' : text);
  if (s.length < 2 || s.indexOf('[') >= 0 || s.indexOf(']') >= 0) return s;
  for (const rule of rules) {
    const match = rule.re.exec(s);
    if (!match) continue;
    if (LEAD_TAGS.indexOf(rule.tag) >= 0) {
      return (rule.tag + ' ' + s).replace(/\s+$/, '');
    }
    const before = s.slice(0, match.index).replace(/\s+$/, '');
    const after = s.slice(match.index);
    if (!before) {
      return (rule.tag + ' ' + after).replace(/\s+$/, '');
    }
    const sep = /[，,。！!？?；;…]$/.test(before) ? '' : ' ';
    return (before + sep + rule.tag + ' ' + after).replace(/\s+$/, '');
  }
  return s;
}

/** 语气指令变了才写盘；与启动器一致，写成纯 ASCII 转义。 */
function syncInstructions(preset) {
  const text = String(preset && preset.instructions ? preset.instructions : '').trim();
  if (!text) return false;
  const send = readJson(SEND_FILE);
  if (!send) return false;
  const provider = String(send.Provider || 'breezeblue');
  const profile = send.Profiles && send.Profiles[provider];
  if (send.Instructions === text && (!profile || profile.Instructions === text)) return true;
  send.Instructions = text;
  if (profile) profile.Instructions = text;
  const escaped = JSON.stringify(send).replace(/[\u0080-\uFFFF]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  fs.writeFileSync(SEND_FILE, escaped, 'ascii');
  return true;
}

/**
 * 用户这句话是不是「明确在要语音」。
 *
 * 比 bridge 的 requested() 更懂说话方式：先把引号里的台词剥掉，只看指令部分。
 * 否则「你发语音说："你烦死人了，别来烦我了"」会因为台词里的引号/「别」被
 * bridge 的 NEGATIVE 判成「不是明确要求」，只能掉进概率骰子。
 */
function wantsVoiceExplicit(incoming) {
  const raw = String(incoming == null ? '' : incoming);
  if (!raw || raw.length > 500) return false;
  // 剥掉成对引号/书名号里的台词（"…" “…” ‘…’ 《…》）
  const core = raw
    .replace(/["“][^"“”]*["”]/g, ' ')
    .replace(/[‘][^‘’]*[’]/g, ' ')
    .replace(/《[^》]*》/g, ' ');
  if (TEXT_ONLY.test(core)) return false;
  // 只排除真正的转述，不再因为引号或「别」而否决
  if (/他说|她说|有人说|听说|别人说/.test(core)) return false;
  return REQUEST.test(core) || EXTRA_VOICE.test(core);
}

/**
 * 这条回复会不会「确定」被发成语音（与 bridge choose() 同规则）。
 *
 * 只有两种情况确定：用户明确要求语音（REQUEST 命中且没被 NEGATIVE/TEXT_ONLY 否决），
 * 或 Probability >= 100。概率落在中间的属于随机场景，这里返回 false ——
 * 宁可这条随机语音没有音效，也绝不给文字回复塞标签。
 */
function certainVoice(incoming, cfg, isGroup) {
  const text = String(incoming == null ? '' : incoming);
  if (!cfg || cfg.Enabled !== true) return false;
  const scope = isGroup ? cfg.Groups : cfg.Private;
  if (scope === false) return false;
  if (TEXT_ONLY.test(text)) return false;
  if (text.length <= 500 && !NEGATIVE.test(text) && REQUEST.test(text)) return true;
  const chance = Number(cfg.Probability);
  return Number.isFinite(chance) && chance >= 100;
}

exports.hooks = {
  // 每次生成前把标签规范追加进 system prompt：让模型主动只用官方标签，
  // 而不是等回复生成后再靠清洗补救（不修改人设文件，仅本次请求生效）。
  'chat.prompt': function (ctx) {
    try {
      if (!boolSetting(ctx, 'injectTagRules', true)) return undefined;
      const system = String((ctx && ctx.system) || '');
      if (!system || system.indexOf('【语音音效标签') >= 0) return undefined;
      return { system: system + '\n\n' + TAG_RULES_PROMPT };
    } catch {
      return undefined;
    }
  },

  // 消息发送完成后立刻还原 Probability。
  // before_send 里临时改的 100/0 只为让「这一条」按插件决定走；
  // gateway 是 await send() 成功之后才抛 dispatched，此时桥接已经读完文件，
  // 在这里还原最安全——以前只在「下一条消息」开头还原，不发消息就会一直卡在临时值。
  'chat.dispatched': function () {
    try {
      restoreProbability();
    } catch {
      /* 还原失败不影响发送结果 */
    }
    return undefined;
  },

  'chat.before_send': async function (ctx) {
    try {
      // 每条消息开头先把上一条临时覆盖的 Probability 还原，否则 100 会被误当成用户设置
      restoreProbability();
      // 设置页总开关：关掉后完全不干预（不改语音方式、不加标签、不写文件）
      if (!boolSetting(ctx, 'enabled', true)) return undefined;
      const raw = String(ctx && ctx.text == null ? '' : ctx.text).trim();
      if (!raw) return undefined;
      const text = raw;

      let data = readJson(PRESET_FILE);
      if (!data) {
        // 预设文件不存在：自动生成内置默认；已存在（哪怕损坏）不覆盖
        ensurePresetFile();
        data = readJson(PRESET_FILE);
      }
      if (!data || !data.presets) return undefined;
      // 设置页可以强制指定预设，留空则用 voice-presets.json 里的 active
      const prefer = String((ctx && ctx.settings && ctx.settings.preset) || '').trim();
      const preset = (prefer && data.presets[prefer]) || data.presets[String(data.active || '')];
      if (!preset) return undefined;

      // 1) 语气指令：每次回复都同步，文字与语音都吃这个设置
      try {
        syncInstructions(preset);
      } catch {
        /* 写不进就沿用旧语气 */
      }

      // 2) 决定这条要不要语音：明确要求语音 → 必语音；否则按预设 voiceChance 掷骰子。
      //    然后把 Probability 临时覆盖成 100/0，让 bridge 严格跟随（标签与发送永远一致）。
      const cfg = readJson(SEND_FILE) || {};
      const msg = (ctx && ctx.message) || {};
      const isGroup = msg.chatType === 'group';

      // 明确要求语音（或用户已设 100%）→ 必语音，不掷骰子
      const certain = wantsVoiceExplicit(msg.text)
        || (Number.isFinite(Number(cfg.Probability)) && Number(cfg.Probability) >= 100);
      const userChance = Number(cfg.Probability);

      // 用户把概率设成 0（明确不要自动语音）时插件完全不干预
      if (!certain && (!Number.isFinite(userChance) || userChance <= 0)) return undefined;

      let wantVoice;
      if (certain) {
        wantVoice = true;
      } else {
        // 中间概率：插件接管，按预设 voiceChance 掷骰子，再强制 bridge 跟随
        // 设置页可覆盖语音概率（-1 = 用预设自带的 voiceChance）
        const override = numSetting(ctx, 'voiceChanceOverride', -1);
        const presetChance = override >= 0 && override <= 100 ? override : Number(preset.voiceChance);
        const target = Number.isFinite(presetChance) ? presetChance : userChance;
        wantVoice = Number.isFinite(target) && target > 0 && Math.random() * 100 < target;
      }

      if (cfg.Enabled === true && Number.isFinite(userChance)) {
        overrideProbability(wantVoice ? 100 : 0, userChance);
      }
      if (!wantVoice) return undefined;

      const tagged = addTags(text, compileRules(preset.tags));
      // 与「原始文本」比较：清洗或加标签只要改变了内容就回传，否则不动
      if (tagged === raw) return undefined;
      // 返回加工后的文本：语音由宿主原生流程合成（标签被 Breeze 识别）
      return { text: tagged };
    } catch {
      // 任何异常都退回宿主默认行为，绝不吞消息
      return undefined;
    }
  },
};

// 插件加载即还原上次的临时覆盖（异常退出的兜底）
try {
  restoreProbability();
} catch {
  /* 加载期出错不影响宿主 */
}
