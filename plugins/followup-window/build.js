'use strict';

/**
 * 打包 followup-window：生成 wasm → 装 ZIP → 算 SHA-256 → 产出市场目录条目草稿。
 *
 * 说明：Api 3 目录（index-v3.json）还没在市场发布，宿主里也还是本地开发版，
 * 所以这里把条目写到 dist/index-entry.json，由 PR 时再并入 index-v3.json。
 *
 * 用法：node build.js
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { build, run } = require('./src/wasm');
const { makeZip } = require('./src/zip');
const { decide } = require('./src/reference');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'plugin.json'), 'utf8'));

function assert(ok, message) {
  if (!ok) { console.error('✗ ' + message); process.exit(1); }
}

const HOOKS = ['chat.received', 'chat.pre_reply', 'chat.prompt', 'chat.generate', 'chat.reply', 'chat.before_send', 'chat.dispatched'];
const PERMISSIONS = ['chat.history', 'model.prompt'];

assert(/^[a-z][a-z0-9-]{0,47}$/.test(manifest.Id), 'Id 必须小写字母开头');
assert(/^\d+\.\d+\.\d+$/.test(manifest.Version), 'Version 形如 1.0.0');
assert(/^\d+\.\d+\.\d+$/.test(manifest.MinAppVersion), 'MinAppVersion 形如 4.1.0');
assert(manifest.Api === 3, 'Api 必须是 3');
assert(manifest.Kind === 'message', 'Kind 必须是 message');
assert(Array.isArray(manifest.Hooks) && manifest.Hooks.length > 0 && manifest.Hooks.length <= 7, 'Hooks 1~7 项');
assert(new Set(manifest.Hooks).size === manifest.Hooks.length, 'Hooks 不能重复');
assert(manifest.Hooks.every((h) => HOOKS.includes(h)), 'Hooks 里有未知扩展点');
assert(Array.isArray(manifest.Permissions) && manifest.Permissions.length <= 2, 'Permissions 最多 2 项');
assert(manifest.Permissions.every((p) => PERMISSIONS.includes(p)), 'Permissions 里有未开放的权限');
assert(typeof manifest.ResultLabel === 'string' && manifest.ResultLabel.trim(), 'ResultLabel 必填（市场校验要求）');
assert(typeof manifest.Name === 'string' && manifest.Name.trim().length > 0 && manifest.Name.trim().length <= 80, 'Name 必填且 ≤80');
assert(typeof manifest.Author === 'string' && manifest.Author.trim().length > 0 && manifest.Author.trim().length <= 80, 'Author 必填且 ≤80');
assert(String(manifest.Description || '').length <= 600, 'Description ≤600');
{
  // 宿主 PluginMarket.Valid：消息插件要求 MinAppVersion >= 4.1.0
  const parts = manifest.MinAppVersion.split('.').map(Number);
  const ok = parts[0] > 4 || (parts[0] === 4 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 0)));
  assert(ok, 'MinAppVersion 需 >= 4.1.0（宿主对 Api 3 的硬要求）');
}

const wasm = build();
assert(wasm.length <= 512 * 1024, 'plugin.wasm 超过 512 KiB');

// 打包前用宿主同款契约跑一遍
const sample = {
  api: 3, hook: 'chat.pre_reply',
  message: { platform: 'wechat', chatId: 'g1', chatType: 'group', senderId: 'u1', text: '为啥不加班', atMe: false, replyToBot: false, mentionedNames: [] },
  now: 1762812400000,
  lastBot: { role: 'assistant', text: '在的', uid: 'bot', targetId: 'u1', at: 1762812345678 },
  state: { left: 3, interrupted: false }, settings: {}, decision: 'pass',
};
const actual = Buffer.from(run(wasm, Buffer.from(JSON.stringify(sample)))).toString('utf8');
assert(actual === JSON.stringify(decide(sample)), 'WASM 与参考实现不一致');

const zip = makeZip([
  { name: 'plugin.json', data: fs.readFileSync(path.join(HERE, 'plugin.json')) },
  { name: 'plugin.wasm', data: wasm },
]);
assert(zip.length <= 1024 * 1024, 'ZIP 超过 1 MiB');

const sha = crypto.createHash('sha256').update(zip).digest('hex');
const pkgName = `${manifest.Id}-${manifest.Version}.zip`;
fs.mkdirSync(path.join(ROOT, 'packages'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'packages', pkgName), zip);
fs.mkdirSync(path.join(HERE, 'dist'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'dist', 'plugin.wasm'), wasm);

const entry = {
  ...manifest,
  Download: `https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/packages/${pkgName}`,
  Sha256: sha,
};
fs.writeFileSync(path.join(HERE, 'dist', 'index-entry.json'), JSON.stringify(entry, null, 2) + '\n', 'utf8');

console.log(`✓ plugin.wasm        ${wasm.length} 字节`);
console.log(`✓ ${pkgName}   ${zip.length} 字节`);
console.log(`  SHA-256            ${sha}`);
console.log('✓ dist/index-entry.json 已生成（并入 index-v3.json 用）');
