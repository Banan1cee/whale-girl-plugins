'use strict';

/**
 * 接话窗口（followup-window）——Api 3 消息插件。
 *
 * 把 PR #104 的判定逻辑搬成插件：
 *   · chat.reply     她刚回完一句 → 记下「还能再顺接 3 句」
 *   · chat.pre_reply 判断这条要不要接：不同人插话就收口；纯捧场、叫别人、超窗口都不接
 *
 * 状态由宿主按「插件 + 会话」隔离保存，插件每次把完整 state 交回去。
 *
 * 这是**参考实现**：WASM 版是手写字节码，没有编译器兜底，
 * 测试里用这份 JS 做差分对比（逐字节比较输出），两边不一致就是字节码写错了。
 */

const TURNS = 3;
const WINDOW_MS = 180000;
const MAX_TEXT_BYTES = 900;      // ≈300 个汉字
const MAX_QUESTION_BYTES = 240;  // ≈80 个汉字

/** 纯捧场，不值得为它再开一轮 */
const ACKS = [
  '好', '好的', '好滴', '好吧', '嗯', '嗯嗯', '哦', '行', '可以', '收到',
  '谢谢', '谢了', '哈哈', '哈哈哈', '哈', '666', '牛', '厉害', 'ok',
];

/** 明确的「还在跟我说」信号 */
const CUES = [
  '为啥', '为什么', '怎么', '咋', '啥意思', '什么意思', '然后', '还有',
  '继续', '不对', '不是', '所以', '帮我', '再来', '换个', '说说', '解释',
  '行不行', '可以吗', '能不能', '是不是', '对不对', '什么', '哪',
  '多少', '如何', '看看', '看下', '给我', '发我', '人呢', '在吗',
  '刚才', '刚刚', '你说', '你刚', '觉得', '认为', '咋办', '怎么办',
];

/** 句首连接词：接着上句往下说 */
const CONNECTIVES = ['然后', '还有', '所以', '可是', '但是', '不过', '对了', '不是'];

const ASK_VERBS = ['帮', '说', '看', '发', '来'];
const QUESTION_MARKS = ['?', '？', '吗', '呢', '吧'];

const bytes = (text) => Buffer.byteLength(text, 'utf8');

function wake(left) {
  return { action: 'wake', state: { left: Math.max(0, left - 1), interrupted: false } };
}

function pass(state) {
  return state ? { action: 'pass', state } : { action: 'pass' };
}

function isAck(text) {
  const t = String(text).trim().toLowerCase();
  return ACKS.includes(t);
}

function endsWithQuestion(text) {
  const t = String(text).trim();
  return t.endsWith('?') || t.endsWith('？');
}

function hasCue(text) {
  const t = String(text);
  for (const cue of CUES) if (t.includes(cue)) return true;
  if (t.includes('你') || t.includes('您')) {
    if (QUESTION_MARKS.some((m) => t.includes(m))) return true;
    if (ASK_VERBS.some((v) => t.includes(v))) return true;
  }
  return CONNECTIVES.some((c) => t.startsWith(c));
}

/**
 * @param {object} input Api 3 输入（api/hook/message/now/lastBot/state/settings）
 * @returns {{action?:string, state?:object}}
 */
function decide(input) {
  const hook = String((input && input.hook) || '');

  // 她刚发完：重开窗口
  if (hook === 'chat.reply') return { state: { left: TURNS, interrupted: false } };

  const msg = (input && input.message) || {};
  const st = (input && input.state) || {};
  const left = Number.isInteger(st.left) ? st.left : 0;
  const interrupted = st.interrupted === true;
  const last = (input && input.lastBot) || null;

  // 没有上一条机器人回复 → 不接管
  if (!last || !last.targetId) return pass();

  // 被明确叫到：宿主本来就会回，这里只把窗口重置
  if (msg.atMe === true) return pass({ left: TURNS, interrupted: false });

  // 别人插话 → 当场收口（原逻辑最核心的一条）
  if (String(msg.senderId || '') !== String(last.targetId)) return pass({ left, interrupted: true });

  if (interrupted || left <= 0) return pass();

  // 窗口过期：她上一条回复太久远了
  const now = Number(input.now) || 0;
  const at = Number(last.at) || 0;
  if (!at || now - at > WINDOW_MS) return pass();

  // 在叫别人（@ 了别人 / 出现其他成员名字）
  if (Array.isArray(msg.mentionedNames) && msg.mentionedNames.length) {
    return pass({ left, interrupted: true });
  }

  const text = String(msg.text || '');
  if (!text || bytes(text) > MAX_TEXT_BYTES) return pass();

  // 链接不接（原逻辑：一段网址多半不是接话）
  if (/^https?:\/\//i.test(text)) return pass();

  // 纯捧场不接
  if (isAck(text)) return pass();

  // 她刚问了个问号，对方短句回答 → 接
  if (endsWithQuestion(last.text) && bytes(text) <= MAX_QUESTION_BYTES) return wake(left);

  // 有明显的追问线索 → 接
  if (hasCue(text)) return wake(left);

  return pass();
}

module.exports = { decide, ACKS, CUES, CONNECTIVES, TURNS, WINDOW_MS, MAX_TEXT_BYTES, MAX_QUESTION_BYTES };
