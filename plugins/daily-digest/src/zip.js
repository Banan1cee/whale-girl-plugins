'use strict';

/**
 * 极小的 ZIP 写入器（store 模式，不压缩）。
 *
 * 为什么不用 Compress-Archive：需要精确控制「根目录只有 plugin.json 和 plugin.wasm」，
 * 并且希望同一份源码重复打包得到完全相同的字节（时间戳固定），方便核对 SHA-256。
 * 市场校验会检查 namelist 恰好等于这两个文件，多一个目录项都不行。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 固定时间戳：2026-01-01 00:00:00，保证可复现
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function localHeader(name, data, crc) {
  const out = Buffer.alloc(30);
  out.writeUInt32LE(0x04034b50, 0);
  out.writeUInt16LE(20, 4);      // version needed
  out.writeUInt16LE(0, 6);       // flags
  out.writeUInt16LE(0, 8);       // method: store
  out.writeUInt16LE(DOS_TIME, 10);
  out.writeUInt16LE(DOS_DATE, 12);
  out.writeUInt32LE(crc, 14);
  out.writeUInt32LE(data.length, 18);
  out.writeUInt32LE(data.length, 22);
  out.writeUInt16LE(name.length, 26);
  out.writeUInt16LE(0, 28);
  return Buffer.concat([out, name, data]);
}

function centralHeader(name, data, crc, offset) {
  const out = Buffer.alloc(46);
  out.writeUInt32LE(0x02014b50, 0);
  out.writeUInt16LE(20, 4);      // version made by
  out.writeUInt16LE(20, 6);      // version needed
  out.writeUInt16LE(0, 8);       // flags
  out.writeUInt16LE(0, 10);      // method
  out.writeUInt16LE(DOS_TIME, 12);
  out.writeUInt16LE(DOS_DATE, 14);
  out.writeUInt32LE(crc, 16);
  out.writeUInt32LE(data.length, 20);
  out.writeUInt32LE(data.length, 24);
  out.writeUInt16LE(name.length, 28);
  out.writeUInt16LE(0, 30);      // extra
  out.writeUInt16LE(0, 32);      // comment
  out.writeUInt16LE(0, 34);      // disk start
  out.writeUInt16LE(0, 36);      // internal attrs
  out.writeUInt32LE(0, 38);      // external attrs
  out.writeUInt32LE(offset, 42);
  return Buffer.concat([out, name]);
}

/** files: [{ name, data:Buffer }]，按传入顺序写入 */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    locals.push(localHeader(name, file.data, crc));
    centrals.push(centralHeader(name, file.data, crc, offset));
    offset += 30 + name.length + file.data.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

module.exports = { makeZip, crc32 };
