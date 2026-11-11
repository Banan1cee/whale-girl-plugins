'use strict';

/**
 * 契约测试：生成的 WASM 必须和参考实现逐字节一致。
 *
 * 没有编译器兜底，所以这里做三件事：
 *   1. 样例对比（真实日报、边界、中文）；
 *   2. 随机差分（随机字节流，两边必须一样）；
 *   3. 契约检查（只导入 whale.*、run() 返回 0、64 KiB 上限内不炸）。
 */

const assert = require('node:assert/strict');
const { build, run } = require('../src/wasm');
const { transform } = require('../src/reference');

const wasm = build();

function bytesOf(text) { return Buffer.from(text, 'utf8'); }
function textOf(bytes) { return Buffer.from(bytes).toString('utf8'); }

function same(input, label) {
  const expected = transform(Buffer.from(input));
  const actual = run(wasm, Buffer.from(input));
  assert.deepEqual(
    Buffer.from(actual),
    Buffer.from(expected),
    `${label}\n期望：${JSON.stringify(textOf(expected))}\n实际：${JSON.stringify(textOf(actual))}`
  );
}

const SAMPLE = [
  '# 全局日报 · 2026-11-10',
  '',
  '## 一句话总结',
  '今天聊了加班和带饭，整体比较轻松。',
  '',
  '## 重要的事',
  '- 摸鱼群：聊了加班，阿强说今晚不加班。',
  '- 小明：让帮忙带饭。',
  '- 老板：**周五交周报**，别忘了。',
  '',
  '## 需要我跟进的',
  '- 给小明带饭',
  '- 周报',
  '',
].join('\n');

const CASES = [
  ['', '空输入'],
  ['\n', '只有一个换行'],
  ['\n\n\n', '纯空行'],
  [SAMPLE, '真实日报'],
  ['## 一句话总结', '只有标题没有正文'],
  ['### 三级标题', '三个井号'],
  ['###### 六级标题', '六个井号'],
  ['#标题没空格', '井号后没有空格'],
  ['#', '只有一个井号'],
  ['- item', '减号列表'],
  ['* item', '星号列表'],
  ['-item', '减号后没空格（不是列表）'],
  ['**加粗**', '行内加粗'],
  ['a**b**c', '中间加粗'],
  ['行内 # 号', '正文里的井号'],
  ['  缩进行', '行首空格'],
  ['\t制表符行', '行首制表符'],
  ['句子  ', '行尾空格'],
  ['中文，标点。', '纯中文'],
  ['emoji 🐋 和引号「」', 'emoji 与中文标点'],
  ['a\r\nb', 'CRLF'],
  ['# 标题\n\n\n\n正文', '多空行压缩'],
  [SAMPLE + '\n\n\n', '结尾多余空行'],
  ['- \n- \n- ', '空列表项'],
  ['* * *', '星号分隔线'],
  ['---', '减号分隔线'],
];

for (const [input, label] of CASES) same(input, label);

// 大输入：确认 64 KiB 内不炸、且和参考实现一致
const big = Buffer.from(SAMPLE.repeat(60));
assert.ok(big.length < 65536, '样例重复后应仍在 64 KiB 内，实际 ' + big.length);
same(big, '接近 64 KiB 的输入');

// 随机差分：用最容易出错的字符集
const alphabet = ['#', '*', '-', ' ', '\t', '\n', 'a', 'B', '中', '文', '🐋', '「', '」'];
let seed = 20261110;
function rand(n) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
}
for (let round = 0; round < 300; round += 1) {
  const len = rand(120);
  let text = '';
  for (let i = 0; i < len; i += 1) text += alphabet[rand(alphabet.length)];
  same(text, `随机第 ${round} 组：${JSON.stringify(text)}`);
}

// 契约：导入项只能是 whale 的这三个函数
const mod = new WebAssembly.Module(wasm);
const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`).sort();
assert.deepEqual(imports, ['whale.input_byte', 'whale.input_size', 'whale.output_byte']);
assert.deepEqual(WebAssembly.Module.exports(mod).map((e) => e.name), ['run']);

console.log(`✓ 契约测试通过：${CASES.length} 个样例 + 1 个大输入 + 300 组随机差分`);
console.log(`  wasm 大小 ${wasm.length} 字节`);
