'use strict';

/**
 * 生成 plugin.wasm。
 *
 *   node src/build.js           默认响应 {"action":"pass"}
 *   node src/build.js wake      快捷写法：pass / wake / skip
 *   node src/build.js '{"action":"wake","state":{"turns":1}}'   完整 JSON
 *   node src/build.js out.json  从文件读完整 JSON
 *
 * 快捷写法是为了避开各 shell 吃引号的问题：PowerShell 下直接写 JSON 很容易被剥掉双引号。
 */

const fs = require('node:fs');
const path = require('node:path');
const { build, DEFAULT_RESPONSE } = require('./wasm');

const ACTIONS = new Set(['pass', 'wake', 'skip']);

function resolve(arg) {
  if (!arg) return DEFAULT_RESPONSE;
  if (ACTIONS.has(arg)) return JSON.stringify({ action: arg });
  if (fs.existsSync(arg)) return fs.readFileSync(arg, 'utf8').trim();
  return arg;
}

const response = resolve(process.argv[2]);
let parsed;
try {
  parsed = JSON.parse(response);
} catch (error) {
  console.error('输出必须是 JSON：' + error.message);
  console.error('快捷写法：node src/build.js wake     完整 JSON：node src/build.js out.json');
  process.exit(1);
}
if (typeof parsed !== 'object' || parsed === null) {
  console.error('输出必须是 JSON 对象，例如 {"action":"pass"}');
  process.exit(1);
}

const target = path.join(__dirname, '..', 'plugin.wasm');
fs.writeFileSync(target, build(response));
console.log(`✓ 已生成 plugin.wasm：输出 ${JSON.stringify(parsed)} · 模块 ${fs.statSync(target).size} 字节`);
