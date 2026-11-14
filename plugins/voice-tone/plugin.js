'use strict';

/**
 * 鲸鲸语音语气插件（Api 4）。
 *
 * 职责：在回复最终发送前，按 data/voice-presets.json 的当前预设
 *   1) 给语音文本加 breeze 音频标签；
 *   2) 把该预设的 instructions 同步进 data/voice-send.json；
 *   3) 用 whale.sendVoice() 自己把语音投递出去；
 *   4) 返回空 text，阻止宿主再把同一句当文字发一遍。
 *   5) 预设文件不存在时，自动生成内置默认预设（暴躁 / 呆萌）。
 *
 * 只在「决定要发语音」时才这么干，其它情况一律返回 undefined，
 * 让宿主按原流程发文字，行为与原生一致。
 */

const fs = require('node:fs');
const path = require('node:path');
const whale = require('whale');

const ROOT = whale.paths.appRoot;
const PRESET_FILE = path.join(ROOT, 'data', 'voice-presets.json');
const SEND_FILE = path.join(ROOT, 'data', 'voice-send.json');
const BREAKS = '，,。！!？?；;…';
const LEAD_WORDS = ['唉', '哎', '啧', '哼', '算了', '无所谓'];
const VOICE_REQUEST = /(?:发|来|说|讲|回复)(?:给我|个|一条|一句|句|段|一段|条|一下|点|一段话|个回复|次|一)?\s*语音|用语音(?:回|说|讲)|语音(?:回我|回复|说一句)/;
const NO_VOICE = /不要|别(?:再)?|不想|不用|不能|怎么|如何|关闭|取消/;
const TEXT_ONLY = /(?:不要|别|不用|不想|取消|关闭).{0,12}语音|语音.{0,8}(?:不要|取消|关闭)|(?:用|只要|只用).{0,3}(?:文字|文本)|(?:文字|文本)回复/;

/** 内置默认预设：与分享包 voice-presets.json 完全一致，预设文件不存在时自动生成；已存在（哪怕损坏）绝不覆盖。 */
const DEFAULT_PRESETS = {
  "_说明": "鲸鲸语音预设。改这里不用改代码，重启 WhaleGirl 生效。active 指向当前用哪套；tags 按顺序匹配，命中第一个就停（整段只插一个）。每条可以用 words（关键词数组，自动转义）或 pattern（正则，进阶）。tag 必须是 breeze 官方中文标签原词。",
  "_标签参考": "笑[笑][轻笑][咯咯笑]｜哭[哭声][抽泣][呜咽][呻吟][哀号]｜呼吸[叹气][惊呼][吸气][呼气][喘息]｜发声[耳语][喊叫][惨叫][唱歌][哼歌][结巴][停顿]｜喉鼻[清嗓][咳嗽][吸鼻子]｜口腔[咂嘴][啧嘴]｜反射[打哈欠][打喷嚏][打嗝][打饱嗝][吞咽][干呕]｜反应[闷哼][冷笑][哼鼻子]",
  "_不可用的": "官方没有「开心/生气/惊讶/伤心」这类情绪标签，只能映射到最接近的发声事件。自造的词不会被识别，还会被念出来。",
  "active": "irritable",
  "presets": {
    "irritable": {
      "name": "暴躁",
      "desc": "一点就炸、没耐心、说话冲：多用哼鼻子/冷笑/啧嘴/喊叫，几乎不用温柔音",
      "instructions": "她脾气不好，说话冲、没耐心，句子短、收得快。语速偏快，重音落在句尾，不带笑意。不用播音腔、不撒娇、不哄人。",
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
            "忍不了"
          ],
          "when": "炸毛 / 被惹火（唯一会明显变响的）"
        },
        {
          "tag": "[哼鼻子]",
          "words": [
            "气死",
            "烦死",
            "过分",
            "凭什么",
            "少来",
            "别烦",
            "够了",
            "神经病",
            "有病"
          ],
          "when": "生气 / 不耐烦"
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
            "呵呵"
          ],
          "when": "嘲讽 / 看不起"
        },
        {
          "tag": "[啧嘴]",
          "words": [
            "啧",
            "切",
            "得了吧",
            "省省",
            "别演了"
          ],
          "when": "嫌弃 / 打断"
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
          "when": "无语 / 懒得理"
        },
        {
          "tag": "[吸气]",
          "words": [
            "卧槽",
            "我靠",
            "真的假的",
            "不是吧",
            "睁眼说瞎话"
          ],
          "when": "惊讶但不服气"
        },
        {
          "tag": "[闷哼]",
          "pattern": "啊[？?]|哈[？?]|你说什么",
          "when": "反问 / 不服"
        }
      ]
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
      ]
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

/** 与 Python 侧 add_audio_tags 保持一致：整段最多一个，句首语气词改放句末。 */
function addTags(text, rules) {
  const s = String(text == null ? '' : text);
  if (s.length < 4 || s.indexOf('[') >= 0 || s.indexOf(']') >= 0) return s;
  for (const rule of rules) {
    const match = rule.re.exec(s);
    if (!match) continue;
    const head = s.slice(0, match.index + match[0].length).trim();
    if (match.index <= 1 && LEAD_WORDS.indexOf(head) >= 0) {
      return (s.replace(/\s+$/, '') + ' ' + rule.tag).replace(/\s+$/, '');
    }
    const rest = s.slice(match.index + match[0].length);
    let cut = -1;
    for (let i = 0; i < rest.length; i += 1) {
      if (BREAKS.indexOf(rest[i]) >= 0) {
        cut = match.index + match[0].length + i + 1;
        break;
      }
    }
    if (cut < 0) return (s.replace(/\s+$/, '') + ' ' + rule.tag).replace(/\s+$/, '');
    const before = s.slice(0, cut).replace(/\s+$/, '');
    const after = s.slice(cut).replace(/^\s+/, '');
    return (before + rule.tag + ' ' + after).replace(/\s+$/, '');
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

/** 是否发语音：明确要求优先，否则按概率。规则与原 Python 侧保持一致。 */
function shouldVoice(incoming, cfg, isGroup) {
  const text = String(incoming == null ? '' : incoming);
  if (!cfg || cfg.Enabled !== true) return false;
  const scope = isGroup ? cfg.Groups : cfg.Private;
  if (scope === false) return false;
  if (TEXT_ONLY.test(text)) return false;
  if (text.length <= 500 && !NO_VOICE.test(text) && VOICE_REQUEST.test(text)) return true;
  const chance = Number(cfg.Probability);
  if (!Number.isFinite(chance) || chance <= 0 || chance > 100) return false;
  return Math.random() < chance / 100;
}

exports.hooks = {
  'chat.before_send': async function (ctx) {
    try {
      const msg = (ctx && ctx.message) || {};
      const chatId = String(msg.chatId || '').trim();
      if (!chatId) return;
      let data = readJson(PRESET_FILE);
      if (!data) {
        // 预设文件不存在：自动生成内置默认；已存在（哪怕损坏）不覆盖
        ensurePresetFile();
        data = readJson(PRESET_FILE);
      }
      if (!data || !data.presets) return;
      const preset = data.presets[String(data.active || '')];
      if (!preset) return;
      const cfg = readJson(SEND_FILE);
      const isGroup = msg.chatType === 'group';
      if (!shouldVoice(msg.text, cfg, isGroup)) return;
      const text = String(ctx.text == null ? '' : ctx.text).trim();
      if (!text) return;
      const tagged = addTags(text, compileRules(preset.tags));
      try {
        syncInstructions(preset);
      } catch {
        /* 写不进就沿用旧语气，不影响发语音 */
      }
      const sent = await whale.sendVoice(chatId, tagged, {
        name: String(msg.chatTitle || msg.senderName || chatId),
        chatType: isGroup ? 'group' : 'private',
      });
      if (!sent || !sent.id) return;
      // 已入队：返回空文本，阻止宿主把同一句再当文字发一遍
      return { text: '' };
    } catch {
      // 任何异常都退回宿主默认行为（正常发文字），不让消息丢失
      return;
    }
  },
};
