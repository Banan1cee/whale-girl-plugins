'use strict';
/**
 * 在 Node 里按宿主的同样导入跑一遍 plugin.wasm。
 * 导入集合照抄鲸鲸 4.1.0 的 src/services/messagePlugins.js（只有这三个）。
 */
const fs = require('node:fs');
const path = require('node:path');

const wasm = fs.readFileSync(path.join(__dirname, '..', 'plugin.wasm'));

function run(input) {
  const bytes = Buffer.from(JSON.stringify(input), 'utf8');
  const out = [];
  const imports = {
    input_size: () => bytes.length,
    input_byte: (i) => (i < bytes.length ? bytes[i] : -1),
    output_byte: (v) => {
      if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error('bad byte');
      out.push(v);
    },
  };
  const module = new WebAssembly.Module(wasm);
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== 'whale' || !Object.hasOwn(imports, imp.name)) {
      throw new Error(`请求了未开放的接口：${imp.module}.${imp.name}`);
    }
  }
  const instance = new WebAssembly.Instance(module, { whale: imports });
  if (instance.exports.run() !== 0) throw new Error('run() 必须返回 0');
  return JSON.parse(Buffer.from(out).toString('utf8'));
}

const NOW = 1763000000000;
const base = {
  api: 3, hook: 'chat.prompt',
  message: { chatType: 'group', senderId: 'wxid_a', text: '人呢', atMe: false },
  now: NOW, state: {}, settings: {}, decision: 'pass', text: '',
  system: '你是小鲸鱼。',
};

const cases = [];
const add = (name, input, expect) => cases.push({ name, input, expect });

add('群聊 · 连发 3 条', {
  ...base,
  history: [
    { role: 'user', text: '在吗', uid: 'wxid_a', at: NOW - 5000 },
    { role: 'assistant', text: '在', uid: 'bot', at: NOW - 4000 },
    { role: 'user', text: '那个插件好了没', uid: 'wxid_a', at: NOW - 3000 },
    { role: 'user', text: '在吗在吗', uid: 'wxid_a', at: NOW - 2000 },
    { role: 'user', text: '人呢', uid: 'wxid_a', at: NOW - 1000 },
  ],
}, (o) => o.system.includes('群聊')
  && o.system.includes('对方连发 3 条')
  && o.system.includes('「在」')
  && o.system.includes('节奏快'));

add('多人 · 最近 12 条有两个人', {
  ...base,
  history: [
    { role: 'user', text: '早', uid: 'wxid_a', at: 1 },
    { role: 'user', text: '早啊', uid: 'wxid_b', at: 2 },
    { role: 'assistant', text: '早', uid: 'bot', at: 3 },
    { role: 'user', text: '人呢', uid: 'wxid_a', at: 4 },
  ],
}, (o) => o.system.includes('2 人在说话'));

add('未答问句 · 记进便签', {
  ...base,
  history: [
    { role: 'user', text: '插件好了没？', uid: 'wxid_a', at: 1 },
    { role: 'user', text: '人呢', uid: 'wxid_a', at: 2 },
  ],
}, (o) => o.system.includes('还没回答的问题：「插件好了没？'));

add('已答问句 · 不再提醒', {
  ...base,
  history: [
    { role: 'user', text: '插件好了没？', uid: 'wxid_a', at: 1 },
    { role: 'assistant', text: '好了', uid: 'bot', at: 2 },
    { role: 'user', text: '人呢', uid: 'wxid_a', at: 3 },
  ],
}, (o) => !o.system.includes('还没回答的问题'));

add('私聊 · 无历史', { ...base, message: { chatType: 'private', senderId: 'u2' }, history: [] },
  (o) => o.system.includes('私聊') && o.system.includes('本轮上下文'));

add('转义 · 引号与反斜杠', {
  ...base,
  history: [
    { role: 'assistant', text: '他说"你好"', uid: 'bot', at: 1 },
    { role: 'user', text: '路径 C:\\tmp\\a', uid: 'wxid_a', at: 2 },
  ],
}, (o) => o.system.includes('C:\\\\tmp\\\\a') || o.system.includes('C:\\tmp'));

add('超长 · 截到 36 字以内', {
  ...base,
  history: [{ role: 'user', text: '啊'.repeat(300), uid: 'wxid_a', at: 1 }],
}, (o) => o.system.includes('…') && o.system.length < base.system.length + 400);

add('缺 system · 原样放行', { ...base, system: undefined }, (o) => Object.keys(o).length === 0);

let bad = 0;
const report = (ok, name, out) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) { bad += 1; if (out) console.log('       实际：' + JSON.stringify(out)); }
};

for (const c of cases) {
  const input = Object.fromEntries(Object.entries(c.input).filter(([, v]) => v !== undefined));
  try {
    const out = run(input);
    report(c.expect(out), c.name, out);
  } catch (error) {
    report(false, c.name, error.message);
  }
}

// state 累计：同一个人连续第三次出现时，便签要说出「第 3 次」
{
  const input = { ...base, history: [{ role: 'user', text: '在吗', uid: 'wxid_a', at: NOW - 1000 }] };
  let state = {};
  let last;
  for (let i = 1; i <= 3; i++) {
    last = run({ ...input, now: NOW + i * 10000, state });
    state = last.state;
  }
  report(state.n === 3, 'state 累计 · 第三轮 n=3', state);
  report(last.system.includes('第 3 次找你'), 'state 累计 · 第三轮说出「第 3 次」', last.system);
  report(typeof state.at === 'number' && state.top === 'wxid_a', 'state 写回 at / top', state);
}

// ---- chat.before_send ----
const beforeBase = {
  api: 3, hook: 'chat.before_send',
  message: { chatType: 'group', senderId: 'wxid_a' },
  now: NOW, state: {}, settings: {}, decision: 'reply',
};
const runText = (text, chatType = 'group') => run({ ...beforeBase, message: { chatType }, text }).text;

{
  const md = runText('## 标题\n**加粗**的内容');
  report(md === '标题 加粗的内容', 'before_send · 去掉 Markdown 标记', md);

  report(runText('这是一句普通的话。') === undefined, 'before_send · 干净短句不动');

  const runaway = '啊'.repeat(1159);
  const cut = runText(runaway);
  report(typeof cut === 'string' && cut.length <= 121, 'before_send · 拦下 1159 字的跑飞回复',
    cut && `长度 ${cut.length}`);

  const privateLong = runText('字'.repeat(500), 'private');
  report(typeof privateLong === 'string' && privateLong.length <= 181, 'before_send · 私聊上限 180',
    privateLong && `长度 ${privateLong.length}`);

  report(runText('   ') === undefined, 'before_send · 空白文本不动');
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
