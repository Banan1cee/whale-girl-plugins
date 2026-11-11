'use strict';

/**
 * 差分测试：生成的 WASM 必须和 src/reference.js 输出完全相同的 JSON 字符串。
 *
 * 覆盖三类：
 *   1. 手写样例（窗口、插话、捧场、问句、叫别人、过期、atMe、chat.reply）；
 *   2. 边界（缺 lastBot / 缺 targetId / 缺 now / 缺 at / 空 state / 空正文）；
 *   3. 随机组合（固定种子，可复现）。
 */

const assert = require('node:assert/strict');
const { build } = require('../src/wasm');
const { decide } = require('../src/reference');

const wasm = build();

function runWasm(input) {
  const buf = Buffer.from(JSON.stringify(input), 'utf8');
  const out = [];
  const imports = {
    input_size: () => buf.length,
    input_byte: (i) => (i >= 0 && i < buf.length ? buf[i] : -1),
    output_byte: (v) => { out.push(v & 0xff); },
  };
  const module = new WebAssembly.Module(wasm);
  const instance = new WebAssembly.Instance(module, { whale: imports });
  const code = instance.exports.run();
  if (code !== 0) throw new Error('run 返回 ' + code);
  return Buffer.from(out).toString('utf8');
}

function check(input, label) {
  const expected = JSON.stringify(decide(input));
  const actual = runWasm(input);
  assert.equal(actual, expected, `${label}\n输入：${JSON.stringify(input)}\n期望：${expected}\n实际：${actual}`);
}

const NOW = 1762812400000;
const BOT = { role: 'assistant', text: '在的', uid: 'bot', targetId: 'u1', at: NOW - 30000 };
const MSG = {
  platform: 'wechat', chatId: 'g1', chatType: 'group', senderId: 'u1',
  text: '今天加班吗', atMe: false, replyToBot: false, mentionedNames: [],
};
const base = () => ({
  api: 3, hook: 'chat.pre_reply', message: { ...MSG }, now: NOW,
  lastBot: { ...BOT }, state: { left: 3, interrupted: false }, settings: {}, decision: 'pass',
});

const CASES = [
  ['普通追问', () => ({ ...base(), message: { ...MSG, text: '为啥不加班' } })],
  ['没有线索', () => base()],
  ['别人插话', () => ({ ...base(), message: { ...MSG, senderId: 'u2' } })],
  ['纯捧场 好的', () => ({ ...base(), message: { ...MSG, text: '好的' } })],
  ['纯捧场 收到（大写无关）', () => ({ ...base(), message: { ...MSG, text: 'OK' } })],
  ['她刚问了问号', () => ({ ...base(), lastBot: { ...BOT, text: '你今天累不累？' }, message: { ...MSG, text: '有点' } })],
  ['她问了问号但对方长句', () => ({ ...base(), lastBot: { ...BOT, text: '怎么啦？' }, message: { ...MSG, text: '字'.repeat(100) } })],
  ['atMe 重置窗口', () => ({ ...base(), message: { ...MSG, atMe: true }, state: { left: 0, interrupted: true } })],
  ['额度用完', () => ({ ...base(), state: { left: 0, interrupted: false } })],
  ['已收口', () => ({ ...base(), state: { left: 2, interrupted: true } })],
  ['窗口过期', () => ({ ...base(), lastBot: { ...BOT, at: NOW - 400000 } })],
  ['叫别人', () => ({ ...base(), message: { ...MSG, mentionedNames: ['老王'] } })],
  ['chat.reply', () => ({ ...base(), hook: 'chat.reply', text: '好的呀' })],
  ['没有 lastBot', () => { const i = base(); delete i.lastBot; return i; }],
  ['lastBot 没有 targetId', () => ({ ...base(), lastBot: { ...BOT, targetId: undefined } })],
  ['缺 now', () => { const i = base(); delete i.now; return i; }],
  ['缺 at', () => { const i = base(); i.lastBot = { ...BOT }; delete i.lastBot.at; return i; }],
  ['缺 state', () => { const i = base(); delete i.state; return i; }],
  ['空正文', () => ({ ...base(), message: { ...MSG, text: '' } })],
  ['你+问号', () => ({ ...base(), message: { ...MSG, text: '你觉得呢？' } })],
  ['你+动词', () => ({ ...base(), message: { ...MSG, text: '你说说看' } })],
  ['句首连接词', () => ({ ...base(), message: { ...MSG, text: '然后呢' } })],
  ['私聊', () => ({ ...base(), message: { ...MSG, chatType: 'private' } })],
  ['表情包文本', () => ({ ...base(), message: { ...MSG, text: '😂' } })],
  ['中文长文本', () => ({ ...base(), message: { ...MSG, text: '为什么'.repeat(200) } })],
  // —— 下面是自查后发现的问题，作回归用例 ——
  ['链接不接', () => ({ ...base(), message: { ...MSG, text: 'https://example.com/怎么弄' } })],
  ['链接（大写协议）', () => ({ ...base(), message: { ...MSG, text: 'HTTPS://EXAMPLE.COM/为什么' } })],
  ['捧场词带前后空格', () => ({ ...base(), message: { ...MSG, text: '  好的  ' } })],
  ['捧场词带换行', () => ({ ...base(), message: { ...MSG, text: '\n好的\n' } })],
  ['id 大小写不同算别人', () => ({ ...base(), message: { ...MSG, senderId: 'U1' } })],
  ['left 两位数', () => ({ ...base(), state: { left: 12, interrupted: false } })],
  ['left 小数视为 0', () => ({ ...base(), state: { left: 2.5, interrupted: false } })],
  ['正文恰好 900 字节仍判定', () => ({ ...base(), message: { ...MSG, text: '为'.repeat(300) } })],
  ['正文 901 字节丢弃', () => ({ ...base(), message: { ...MSG, text: '为'.repeat(301) } })],
  // 字段顺序：message 排在 lastBot 后面（宿主以外的实现可能这么排）
  ['message 在 lastBot 之后', () => {
    const m = { ...MSG };
    return { api: 3, hook: 'chat.pre_reply', now: NOW, lastBot: { ...BOT }, state: { left: 3, interrupted: false }, message: m, settings: {} };
  }],
];

for (const [label, make] of CASES) check(make(), label);

// 随机组合
let seed = 20261111;
const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const TEXTS = ['', '好的', '嗯', 'why', '为啥', '你觉得呢', '然后呢', '在吗', '帮我看看', '今天天气不错',
  '你刚说什么？', '不是吧', '继续', '？', '哈哈哈', 'ok', '😀', '怎么办', '给我发一份'];
const BOTS = ['在的', '怎么啦？', '你说呢', '好的', '我在听', '嗯嗯', '要不要一起', '行'];
const SENDERS = ['u1', 'u2', 'u3'];

// 字段顺序随机化：插件是按「键名定位」取值，顺序变化不应该影响结果
function shuffleKeys(obj) {
  const keys = Object.keys(obj);
  for (let i = keys.length - 1; i > 0; i -= 1) {
    const j = rand(i + 1);
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

for (let i = 0; i < 300; i += 1) {
  const senderId = SENDERS[rand(SENDERS.length)];
  const targetId = rand(6) === 0 ? undefined : SENDERS[rand(3)];
  const input = {
    api: 3,
    hook: rand(7) === 0 ? 'chat.reply' : 'chat.pre_reply',
    message: {
      platform: 'wechat', chatId: 'g' + rand(3), chatType: rand(4) === 0 ? 'private' : 'group',
      senderId, text: TEXTS[rand(TEXTS.length)], atMe: rand(5) === 0,
      replyToBot: false, mentionedNames: rand(6) === 0 ? ['老王'] : [],
    },
    now: NOW + rand(1000) - 500,
    lastBot: targetId === undefined ? undefined : {
      role: 'assistant', text: BOTS[rand(BOTS.length)], uid: 'bot', targetId, at: NOW - rand(500000),
    },
    state: rand(8) === 0 ? undefined : { left: rand(5), interrupted: rand(4) === 0 },
    settings: {},
    decision: 'pass',
  };
  // 一半的用例打乱字段顺序（message 可能排到 lastBot 后面）
  const ordered = rand(2) ? shuffleKeys({ ...input, message: shuffleKeys(input.message) }) : input;
  check(ordered, '随机 #' + i);
}

console.log(`✓ 差分测试通过：${CASES.length} 个样例 + 300 组随机，wasm ${wasm.length} 字节`);
