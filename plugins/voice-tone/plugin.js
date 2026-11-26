'use strict';

/**
 * voice-tone（whale-plugin/1，4 级）：Breeze 语音标签提示词 + 发送前标签增强。
 *
 * 旧版靠改写宿主 data/voice-send.json 的 Probability 来决定本轮发语音还是文字；
 * 新协议没有写宿主语音配置/发送通道的能力，chat.dispatched 只能观察、不能反向改设置。
 * 因此本版只保留能安全保留的两件事：
 *   1) chat.prompt@1：把“只用官方 34 个标签”的规则追加到 system；
 *   2) chat.before_send@1：用户明确要语音时，按预设给草稿插入官方标签。
 * 概率覆盖、发送后还原 Probability、同步 voice-send.json 的 Instructions 均删除。
 *
 * 注意：4 级 dataAccess（model.prompt）要等协议 v2；当前清单先不写，
 * 所以 prompt 在 v1 宿主拿不到 system，插件会抛错让宿主保留原 system（不会清空）。
 */

const LEAD_TAGS = ['[喊叫]', '[耳语]'];

const TAG_RULES_PROMPT = [
  '【语音音效标签（只在发语音时用）】',
  '可用标签仅限这些：[笑][轻笑][咯咯笑][哭声][抽泣][呜咽][叹气][惊呼][吸气][耳语][喊叫][停顿][清嗓][啧嘴][打哈欠][闷哼][冷笑][哼鼻子]。',
  '规则：一句最多用一个；表演型（[喊叫][耳语][冷笑]）放在整句最前面；反应型（[叹气][啧嘴][哼鼻子][轻笑][吸气]）紧贴触发词前面；不要自造其它标签（例如 [撒娇][笑眯眯][开心] 都不行）；发纯文字时完全不要带标签。',
].join('\n');

const REQUEST = /(?:发|来|说|讲|回复)(?:给我|个|一条|一句|句|段|一段|条|一下|点|一段话|个回复|次|一)?\s*语音|用语音(?:回|说|讲)|语音(?:回我|回复|说一句)/;
const EXTRA_VOICE = /(?:别|不用|不要)(?:再)?打字|打字太慢|直接说|说给我听|说句话|听你说|听你的声音|听听你的?声音|语音条|录(?:一)?段|发段录音|用嘴说|说话给我听|想听你|想听(?:你)?(?:撒|哄|唱|笑|叫|哼|念)/;
const TEXT_ONLY = /(?:不要|别|不用|不想|取消|关闭).{0,12}语音|语音.{0,8}(?:不要|取消|关闭)|(?:用|只要|只用).{0,3}(?:文字|文本)|(?:文字|文本)回复/;

// 旧版 DEFAULT_PRESETS 原样保留；不再写 appRoot 文件，作为内置预设。
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

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const chance = Number(value.voiceChanceOverride);
  return {
    enabled: value.enabled !== false,
    preset: typeof value.preset === 'string' ? value.preset.trim().slice(0, 40) : '',
    // 迁移后无发送通道控制；字段仅保留迁移兼容，不参与任何行为。
    voiceChanceOverride: Number.isFinite(chance) ? Math.max(-1, Math.min(100, chance)) : -1,
    injectTagRules: value.injectTagRules !== false,
  };
}

function presetFor(settings) {
  const prefer = settings.preset;
  const active = String(DEFAULT_PRESETS.active || '');
  const preset = (prefer && DEFAULT_PRESETS.presets[prefer]) || DEFAULT_PRESETS.presets[active] || DEFAULT_PRESETS.presets.irritable;
  return preset && typeof preset === 'object' ? preset : null;
}

function compileRules(tags) {
  const out = [];
  for (const item of tags || []) {
    if (!item || typeof item.tag !== 'string') continue;
    const tag = item.tag.trim();
    if (!/^\[.+\]$/.test(tag)) continue;
    let source = null;
    if (typeof item.pattern === 'string' && item.pattern.trim()) source = item.pattern;
    else if (Array.isArray(item.words) && item.words.length) {
      const words = item.words.map(word => String(word == null ? '' : word).trim()).filter(Boolean);
      if (words.length) source = '(?:' + words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
    }
    if (!source) continue;
    try { out.push({ re: new RegExp(source), tag }); } catch { /* 单条坏规则跳过 */ }
  }
  return out;
}

function addTags(text, rules) {
  const source = String(text == null ? '' : text);
  if (source.length < 2 || source.includes('[') || source.includes(']')) return source;
  for (const rule of rules) {
    const match = rule.re.exec(source);
    if (!match) continue;
    if (LEAD_TAGS.includes(rule.tag)) return (rule.tag + ' ' + source).trim();
    const before = source.slice(0, match.index).trimEnd();
    const after = source.slice(match.index);
    if (!before) return (rule.tag + ' ' + after).trim();
    const sep = /[，,。！!？?；;…]$/.test(before) ? '' : ' ';
    return (before + sep + rule.tag + ' ' + after).trim();
  }
  return source;
}

/** 只在“用户明确要语音”时加标签；新协议无法确认发送通道，宁可少加。 */
function wantsVoiceExplicit(incoming) {
  const raw = String(incoming == null ? '' : incoming);
  if (!raw || raw.length > 500) return false;
  const core = raw
    .replace(/["“][^"“”]*["”]/g, ' ')
    .replace(/[‘][^‘’]*[’]/g, ' ')
    .replace(/《[^》]*》/g, ' ');
  if (TEXT_ONLY.test(core)) return false;
  if (/他说|她说|有人说|听说|别人说/.test(core)) return false;
  return REQUEST.test(core) || EXTRA_VOICE.test(core);
}

async function prompt(input, ctx) {
  input = input && typeof input === 'object' ? input : {};
  const settings = normalizeSettings(ctx.settings);
  if (!settings.enabled || !settings.injectTagRules) {
    if (typeof input.system !== 'string') throw new Error('system_unavailable');
    return { system: input.system };
  }
  const system = typeof input.system === 'string' ? input.system : '';
  if (!system) throw new Error('system_unavailable'); // 宿主会保留原 system
  if (system.includes('【语音音效标签')) return { system };
  return { system: (system + '\n\n' + TAG_RULES_PROMPT).slice(0, 64000) };
}

async function beforeSend(input, ctx) {
  input = input && typeof input === 'object' ? input : {};
  const settings = normalizeSettings(ctx.settings);
  const text = typeof input.text === 'string' ? input.text : '';
  if (!settings.enabled || !text) return { text };
  if (!wantsVoiceExplicit(input.message && input.message.text)) return { text };
  if (settings.voiceChanceOverride === 0) return { text };
  const preset = presetFor(settings);
  if (!preset) return { text };
  return { text: addTags(text, compileRules(preset.tags)).slice(0, 16000) };
}

module.exports = {
  presets: DEFAULT_PRESETS,
  providers: {
    'chat.prompt@1': async (input, ctx) => prompt(input, ctx),
    'chat.before_send@1': async (input, ctx) => beforeSend(input, ctx),
    // 观察点：新协议不能反向改宿主语音配置；保留空返回，不伪装成功。
    'chat.dispatched@1': async () => ({}),
  },
};



