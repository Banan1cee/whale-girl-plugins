#!/usr/bin/env node
'use strict';

/**
 * 把插件目录打成 packages/<id>-<version>.zip。
 *
 *   node scripts/package.js plugins/my-plugin
 *
 * 为什么要有它：投稿只需要 plugins/ 和 packages/ 两个路径，但 Windows 上不一定有 zip 命令，
 * 手搓 ZIP 又容易多一层目录、把 .git 打进去。这个脚本按市场规则生成「根目录只有清单和 wasm」的包，
 * 顺便算好 SHA-256 打出来（目录条目由 CI 生成，这里的值用于核对）。
 *
 * 只做 store（不压缩）：文件都很小，确定性比压缩率重要，同一份源码永远打出一模一样的字节。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Windows 编辑器常给 UTF-8 加 BOM；JSON.parse 不认，先剥掉。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function u16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

function dosTime(date) {
  return [...u16((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)),
    ...u16(((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate())];
}

/** entries: [{ name, data }] → Buffer */
function zipStore(entries, date = new Date(0)) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const header = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...dosTime(date),
      ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length),
      ...u16(name.length), ...u16(0), ...name,
    ];
    const local = Buffer.concat([Buffer.from(header), entry.data]);
    locals.push(local);
    centrals.push(Buffer.from([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...dosTime(date),
      ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length), ...u32(offset), ...u16(0),
  ]);
  return Buffer.concat([...locals, central, eocd]);
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

  const zipName = `${manifest.Id}-${manifest.Version}.zip`;
  const target = path.join(ROOT, 'packages', zipName);
  const bytes = zipStore([
    { name: 'plugin.json', data: fs.readFileSync(manifestFile) },
    { name: payload, data: fs.readFileSync(wasmFile) },
  ]);
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

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { zipStore, crc32 };
