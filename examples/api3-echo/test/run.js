'use strict';

/** 不需要鲸鲸客户端：用和宿主一样的导入在 Node 里跑一遍生成器。 */

const assert = require('node:assert/strict');
const { build, run, DEFAULT_RESPONSE } = require('../src/wasm');

assert.equal(run(build()), DEFAULT_RESPONSE);

const custom = '{"action":"wake","state":{"turns":1}}';
assert.equal(run(build(custom)), custom);
assert.deepEqual(JSON.parse(run(build(custom))), { action: 'wake', state: { turns: 1 } });

// 中文/emoji 也要按 UTF-8 一个字节一个字节吐出去
const utf8 = '{"action":"pass","state":{"note":"中文🙂"}}';
assert.equal(run(build(utf8)), utf8);

console.log('模板测试通过');
