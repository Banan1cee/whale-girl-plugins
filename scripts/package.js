#!/usr/bin/env node
'use strict';

/**
 * 把插件目录打成 packages/<id>-<version>.zip。
 *
 *   node scripts/package.js plugins/my-plugin
 *
 * 为什么要有它：投稿只需要 plugins/ 和 packages/ 两个路径，但 Windows 上不一定有 zip 命令，
 * 手搓 ZIP 又容易多一层目录、把 .git 打进去。这个脚本按市场规则生成「根目录只有清单和入口」的包，
 * 顺便算好 SHA-256 打出来（目录条目由 CI 生成，这里的值用于核对）。
 *
 * 两种协议：
 *   - Api 1-4（旧）：入口是 plugin.wasm / plugin.js；
 *   - whale-plugin/1（v5）：入口由 protocol.json 的 level 决定
 *     （0 级 theme.json，1-3 级 plugin.wasm，4 级 plugin.js）。
 *   两种都只放「清单 + 入口」两个文件，README/market.json 等展示文件不进包。
 *
 * 只做 store（不压缩）：文件都很小，确定性比压缩率重要，同一份源码永远打出一模一样的字节。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { crc32, zipStore } = require('./zip');

const ROOT = path.resolve(__dirname, '..');

/** Windows 编辑器常给 UTF-8 加 BOM；JSON.parse 不认，先剥掉。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function emit(zipName, bytes) {
  const target = path.join(ROOT, 'packages', zipName);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (fs.existsSync(target)) {
    const existing = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    if (existing !== sha) {
      console.error(`packages/${zipName} 已存在且内容不同。已发布的版本不要覆盖，请先升 Version。`);
      return 1;
    }
    // 内容一致就当作幂等：作者/agent 反复跑 submit 不应该报错。
    console.log(`✓ packages/${zipName} 已存在且内容一致（${bytes.length} 字节），跳过写入`);
    console.log('  SHA-256 ' + sha);
    return 0;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  console.log(`✓ packages/${zipName}（${bytes.length} 字节）`);
  console.log('  SHA-256 ' + sha);
  console.log('  下一步：node scripts/build-index.js --check 看目录，然后提交这两个路径');
  return 0;
}

function packV5(directory, manifest) {
  const { loadProtocol } = require('./v5');
  const registry = loadProtocol(ROOT);
  const policy = registry.levels[String(manifest.level)];
  if (!policy) {
    console.error('whale-plugin/1 的 level 必须是 0-4');
    return 1;
  }
  if (manifest.runtime !== policy.runtime || manifest.entry !== policy.entry) {
    console.error(`该 level 必须使用 runtime=${policy.runtime}、entry=${policy.entry}`);
    return 1;
  }
  const manifestFile = path.join(directory, 'plugin.json');
  const entryFile = path.join(directory, policy.entry);
  if (!fs.existsSync(entryFile)) {
    console.error(`缺少 ${policy.entry}：先完成插件构建`);
    return 1;
  }
  const manifestBytes = fs.readFileSync(manifestFile);
  const entryBytes = fs.readFileSync(entryFile);
  const limits = registry.limits;
  if (manifestBytes.length > limits.maxManifestBytes) {
    console.error('plugin.json 超过清单大小限制');
    return 1;
  }
  if (entryBytes.length > policy.maxEntryBytes) {
    console.error(`${policy.entry} 超过该等级入口大小限制`);
    return 1;
  }
  const bytes = zipStore([
    { name: 'plugin.json', data: manifestBytes },
    { name: policy.entry, data: entryBytes },
  ]);
  if (bytes.length > limits.maxPackageBytes) {
    console.error('打包结果超过包大小限制');
    return 1;
  }
  return emit(`${manifest.id}-${manifest.version}.zip`, bytes);
}

function main(argv) {
  const dir = path.resolve(ROOT, argv[0] || '');
  const manifestFile = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestFile)) {
    console.error('用法：node scripts/package.js plugins/<id>');
    console.error('找不到 ' + path.relative(ROOT, manifestFile));
    return 1;
  }
  const manifest = JSON.parse(stripBom(fs.readFileSync(manifestFile, 'utf8')));
  if (manifest.format === 'whale-plugin/1') {
    for (const key of ['id', 'version', 'level']) {
      if (manifest[key] === undefined || manifest[key] === null || manifest[key] === '') {
        console.error('plugin.json 缺少 ' + key);
        return 1;
      }
    }
    return packV5(dir, manifest);
  }
  for (const key of ['Id', 'Version']) {
    if (!manifest[key]) {
      console.error('plugin.json 缺少 ' + key);
      return 1;
    }
  }
  const payload = manifest.Api === 4 ? 'plugin.js' : 'plugin.wasm';
  const wasmFile = path.join(dir, payload);
  if (!fs.existsSync(wasmFile)) {
    console.error('缺少 ' + payload + '：先完成插件构建');
    return 1;
  }

  const bytes = zipStore([
    { name: 'plugin.json', data: fs.readFileSync(manifestFile) },
    { name: payload, data: fs.readFileSync(wasmFile) },
  ]);
  return emit(`${manifest.Id}-${manifest.Version}.zip`, bytes);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { zipStore, crc32 };
