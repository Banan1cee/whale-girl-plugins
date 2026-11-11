'use strict';

/**
 * 用**宿主真实的运行时**跑一遍（E:\whale-girl-4.1-main\src\services\messagePlugins.js）。
 *
 * 这一步验证的不是我的模拟器，而是生产代码路径：写 flow/grant → 起 worker 进程 →
 * 喂 JSON → 解析输出 → 校验 action/state → 落盘 state。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST = 'E:/whale-girl-4.1-main/src/services/messagePlugins.js';
const { MessagePlugins } = require(HOST);
const { build } = require('../src/wasm');

const wasm = build();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-host-'));
const root = path.join(dataDir, 'plugins');
fs.mkdirSync(root);

const flow = {
  id: 'followup-window',
  api: 3,
  hooks: ['chat.pre_reply', 'chat.reply'],
  permissions: [],
  wasm: wasm.toString('base64'),
};
fs.writeFileSync(path.join(root, 'followup-window.flow.json'), JSON.stringify(flow));
const hash = crypto.createHash('sha256').update(JSON.stringify(flow)).digest('hex');
fs.writeFileSync(path.join(root, 'followup-window.flow-grant.json'), JSON.stringify({ enabled: true, hash, settings: {} }));

const plugins = new MessagePlugins({ dataDir, logger: { warn() {} } });

const NOW = 1762812400000;
const lastBot = { role: 'assistant', text: '在的', uid: 'bot', targetId: 'u1', at: NOW - 30000 };
const message = (over = {}) => ({
  platform: 'wechat', chatId: 'g1', chatType: 'group', senderId: 'u1',
  text: '为啥不加班', atMe: false, replyToBot: false, mentionedNames: [], ...over,
});
const ctx = (over = {}) => ({ key: 'wechat:g:g1', now: NOW, lastBot, ...over });

(async () => {
  // 0) 延迟：宿主给每个插件 300ms，worker 启动也在里面
  const times = [];
  for (let i = 0; i < 6; i += 1) {
    const t0 = process.hrtime.bigint();
    await plugins.run('chat.pre_reply', ctx({ message: message({ text: '为啥' }) }));
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const max = Math.round(times.at(-1));
  assert.ok(max < 300, '单次调用必须 <300ms（宿主预算），实际 ' + max + 'ms');

  // 1) 她刚回完一句 → 写 state
  const reply = await plugins.run('chat.reply', ctx({ message: message(), text: '好的呀' }));
  assert.equal(reply.action, 'pass', 'chat.reply 不该接管 action');

  // 2) 同一个人继续追问 → wake
  const wake = await plugins.run('chat.pre_reply', ctx({ message: message() }));
  assert.equal(wake.action, 'wake', JSON.stringify(wake));

  // 3) 别人插话 → 不接，并且收口
  const other = await plugins.run('chat.pre_reply', ctx({ message: message({ senderId: 'u2', text: '在吗' }) }));
  assert.equal(other.action, 'pass');

  // 4) 收口后再回到原人也不接
  const back = await plugins.run('chat.pre_reply', ctx({ message: message() }));
  assert.equal(back.action, 'pass', '收口后应保持 pass');

  // 5) 被 @ 到 → 重置窗口（action 交给宿主）
  const at = await plugins.run('chat.pre_reply', ctx({ message: message({ atMe: true, text: '鲸鲸' }) }));
  assert.equal(at.action, 'pass');
  const again = await plugins.run('chat.pre_reply', ctx({ message: message({ text: '继续' }) }));
  assert.equal(again.action, 'wake', 'atMe 之后窗口应该重开');

  // 6) 纯捧场不接
  const ack = await plugins.run('chat.pre_reply', ctx({ message: message({ text: '好的' }) }));
  assert.equal(ack.action, 'pass');

  console.log('✓ 宿主真实运行时集成通过：chat.reply / pre_reply / 收口 / atMe / 捧场');
  console.log('  单次调用耗时：' + times.map((t) => Math.round(t)).join('/') + ' ms（预算 300ms）');
  console.log('  state 文件：' + fs.readdirSync(root).filter((f) => f.endsWith('.state.json')).length + ' 个');
})().finally(() => {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}).catch((err) => {
  console.error('✗ 集成失败：', err && err.message ? err.message : err);
  process.exit(1);
});
