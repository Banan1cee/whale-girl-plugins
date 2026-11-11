'use strict';

/**
 * 打包：生成 plugin.wasm → 装进 ZIP → 算 SHA-256 → 更新 index-v2.json。
 *
 * 包内只放 plugin.json 和 plugin.wasm 两个文件（市场校验会检查 namelist 恰好如此），
 * 时间戳固定，同一份源码重复打包得到相同字节，便于核对 SHA-256。
 *
 * 用法：node build.js
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { build, run } = require('./src/wasm');
const { makeZip } = require('./src/zip');
const { transform } = require('./src/reference');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '../..');          // 市场仓库根目录
const manifestPath = path.join(HERE, 'plugin.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function assert(condition, message) {
  if (condition) return;
  console.error('✗ ' + message);
  process.exit(1);
}

// 与 PluginMarket.Valid / validate.py 对齐的清单自检
assert(/^[a-z][a-z0-9-]{0,47}$/.test(manifest.Id), 'Id 必须以小写字母开头，只含小写字母、数字和短横线');
assert(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(manifest.Id), 'Id 不能用 Windows 保留名');
assert(/^\d+\.\d+\.\d+$/.test(manifest.Version), 'Version 必须形如 1.0.0');
assert(/^\d+\.\d+\.\d+$/.test(manifest.MinAppVersion), 'MinAppVersion 必须形如 4.1.0');
assert(manifest.Api === 2, 'Api 必须是 2');
assert(manifest.Kind === 'tool', 'Kind 必须是 tool');
assert(manifest.HostAction === 'chat.summary', 'HostAction 必须是 chat.summary');
assert(typeof manifest.ResultLabel === 'string' && manifest.ResultLabel.trim(), 'ResultLabel 必填');
assert(String(manifest.Description || '').length <= 600, 'Description 不能超过 600 字');
assert(manifest.Name && manifest.Author, 'Name / Author 必填');

const wasm = build();
assert(wasm.length <= 512 * 1024, 'plugin.wasm 超过 512 KiB');

// 用真实样例验证一遍，避免把坏包打进去
const sample = Buffer.from('# 全局日报 · 2026-11-10\n\n## 一句话总结\n今天摸了鱼。\n\n## 重要的事\n- 摸鱼群：聊了加班。\n', 'utf8');
assert(Buffer.from(run(wasm, sample)).equals(Buffer.from(transform(sample))), 'WASM 输出与参考实现不一致');

const zip = makeZip([
  { name: 'plugin.json', data: fs.readFileSync(manifestPath) },
  { name: 'plugin.wasm', data: wasm },
]);
assert(zip.length <= 1024 * 1024, 'ZIP 超过 1 MiB');

const sha = crypto.createHash('sha256').update(zip).digest('hex');
const pkgName = `${manifest.Id}-${manifest.Version}.zip`;
const pkgDir = path.join(ROOT, 'packages');
fs.mkdirSync(pkgDir, { recursive: true });
fs.writeFileSync(path.join(pkgDir, pkgName), zip);

fs.mkdirSync(path.join(HERE, 'dist'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'dist', 'plugin.wasm'), wasm);

const entry = {
  ...manifest,
  Download: `https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/packages/${pkgName}`,
  Sha256: sha,
};

// 合并进 index-v2.json：同 Id+Version 覆盖，其余保留
const indexPath = path.join(ROOT, 'index-v2.json');
let list = [];
if (fs.existsSync(indexPath)) {
  try {
    list = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
}
list = list.filter((item) => !(item.Id === entry.Id && item.Version === entry.Version));
list.push(entry);
list.sort((a, b) => String(a.Id).localeCompare(String(b.Id)) || String(a.Version).localeCompare(String(b.Version)));
fs.writeFileSync(indexPath, JSON.stringify(list, null, 2) + '\n', 'utf8');

console.log(`✓ plugin.wasm      ${wasm.length} 字节`);
console.log(`✓ ${pkgName}  ${zip.length} 字节`);
console.log(`  SHA-256          ${sha}`);
console.log(`✓ index-v2.json    已更新（${list.length} 条）`);
