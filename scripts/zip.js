'use strict';

/**
 * Minimal deterministic ZIP helpers shared by the market scripts.
 *
 * We only need store-style writing and reading of small repo packages, so this
 * file avoids any dependency and stays byte-deterministic: the same source bytes
 * always produce the same ZIP bytes (fixed timestamp), which keeps the
 * packages/<id>-<version>.zip hash stable for the index.
 */

const zlib = require('node:zlib');

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

/** entries: [{ name, data }] → Buffer (stored, fixed timestamp). */
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

/** Read a small ZIP into [{ name, data }] without trusting names or sizes. */
function readZip(buffer, { maxEntries = 8, maxBytes = 16 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > maxBytes) throw new Error('ZIP 超出大小限制');
  const eocd = buffer.length - 22;
  if (eocd < 0 || buffer.readUInt32LE(eocd) !== 0x06054b50 || buffer.readUInt16LE(eocd + 20) !== 0) {
    throw new Error('ZIP 结构无效（缺少 EOCD 或带注释）');
  }
  const count = buffer.readUInt16LE(eocd + 10);
  if (count < 1 || count > maxEntries) throw new Error('ZIP 条目数量不符');
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const expanded = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new Error('ZIP 不允许加密条目');
    if (method !== 0 && method !== 8) throw new Error('ZIP 压缩方式不受支持');
    if (local + 30 > eocd || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP 本地头损坏');
    const localName = buffer.readUInt16LE(local + 26);
    const localExtra = buffer.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const raw = buffer.subarray(start, start + compressed);
    const data = method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(expanded, 1) }) : raw;
    if (data.length !== expanded) throw new Error('ZIP 解压长度不符');
    if (crc32(data) !== crc) throw new Error('ZIP CRC 不符');
    entries.push({ name, data });
  }
  return entries;
}

module.exports = { crc32, zipStore, readZip };
