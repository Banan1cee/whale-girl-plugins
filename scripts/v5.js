'use strict';

/**
 * whale-plugin/1 support for the market tooling (index-v5 + packaging helpers).
 *
 * Static only: this module reads manifests, package bytes and display files. It
 * never imports or executes plugin code. The authority for levels, capabilities,
 * schemas and limits is protocol.json, a copy of the host
 * src/services/pluginProtocolRegistry.json with its source commit/hash recorded.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readZip } = require('./zip');

const ROOT = path.resolve(__dirname, '..');
const V5_INDEX = 'index-v5.json';
const PREFIX = 'https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/packages/';
const DISPLAY_FILE = 'market.json';
const README_LIMIT = 64 * 1024;
const DISPLAY_LIMIT = 64 * 1024;
const MAX_IMAGES = 8;
const IMAGE_LIMIT = 2 * 1024 * 1024;
const IMAGE_MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
const VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

const caches = new Map();

function readBytes(file) {
  return fs.readFileSync(file);
}

function decodeStrictUtf8(buffer, where) {
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) throw new Error(`${where} 必须是 UTF-8 文本`);
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${where} 不允许 UTF-8 BOM`);
  return text;
}

function readJsonStrict(file, where = file) {
  const text = decodeStrictUtf8(readBytes(file), where);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} 不是合法 JSON：${error.message}`);
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function loadProtocol(root = ROOT) {
  const key = path.resolve(root);
  if (!caches.has(key)) {
    const file = path.join(key, 'protocol.json');
    if (!fs.existsSync(file)) throw new Error('缺少 protocol.json：请从宿主仓库复制当前注册表');
    const document = readJsonStrict(file, 'protocol.json');
    if (!document || !document.registry || document.registry.format !== 'whale-plugin/1') {
      throw new Error('protocol.json 缺少有效的 whale-plugin/1 registry');
    }
    caches.set(key, document.registry);
  }
  return caches.get(key);
}

function levelPolicy(root, level) {
  const registry = loadProtocol(root);
  const policy = registry.levels[String(level)];
  if (!policy) throw new Error(`不支持的 level：${level}`);
  return policy;
}

function entryName(root, level) {
  return levelPolicy(root, level).entry;
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function gitUpdatedAt(root, relative) {
  try {
    const output = execFileSync('git', ['-C', root, 'log', '-1', '--format=%cI', '--', relative], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

function displayFor(root, directory, manifest) {
  const pluginId = manifest.id;
  let meta = {};
  const metaFile = path.join(directory, DISPLAY_FILE);
  if (fs.existsSync(metaFile)) {
    const raw = readBytes(metaFile);
    if (raw.length > DISPLAY_LIMIT) throw new Error(`plugins/${pluginId}/${DISPLAY_FILE} 超过大小限制`);
    meta = readJsonStrict(metaFile, `plugins/${pluginId}/${DISPLAY_FILE}`);
    if (!asObject(meta)) throw new Error(`plugins/${pluginId}/${DISPLAY_FILE} 必须是对象`);
    for (const key of Object.keys(meta)) {
      if (!['readme', 'images', 'donation'].includes(key)) {
        throw new Error(`plugins/${pluginId}/${DISPLAY_FILE} 含未知字段 ${key}`);
      }
    }
  }
  const display = {};
  const readmeName = meta.readme === undefined ? 'README.md' : meta.readme;
  if (typeof readmeName !== 'string' || !readmeName || /[/\\]/.test(readmeName)
    || readmeName === '..' || !readmeName.toLowerCase().endsWith('.md')) {
    throw new Error(`plugins/${pluginId}: readme 必须是插件目录内的 Markdown 文件名`);
  }
  const readmePath = path.join(directory, readmeName);
  if (fs.existsSync(readmePath)) {
    if (fs.lstatSync(readmePath).isSymbolicLink()) throw new Error(`plugins/${pluginId}/${readmeName} 不能是链接`);
    const raw = readBytes(readmePath);
    if (raw.length > README_LIMIT) throw new Error(`plugins/${pluginId}/${readmeName} 超过 64 KiB`);
    decodeStrictUtf8(raw, `plugins/${pluginId}/${readmeName}`);
    display.readme = {
      path: `plugins/${pluginId}/${readmeName}`,
      sha256: sha256(raw),
      bytes: raw.length,
    };
  }
  const images = meta.images === undefined ? [] : meta.images;
  if (!Array.isArray(images) || images.length > MAX_IMAGES || new Set(images).size !== images.length) {
    throw new Error(`plugins/${pluginId}: images 必须是不超过 ${MAX_IMAGES} 个的唯一路径数组`);
  }
  const rendered = [];
  for (const relative of images) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
      || relative.includes('\\') || relative.split('/').includes('..')) {
      throw new Error(`plugins/${pluginId}: 图片路径必须留在插件目录内：${relative}`);
    }
    const suffix = path.extname(relative).toLowerCase();
    if (!IMAGE_MEDIA[suffix]) throw new Error(`plugins/${pluginId}: 不支持的图片扩展名：${relative}`);
    const file = path.join(directory, relative);
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) {
      throw new Error(`plugins/${pluginId}: 图片不存在或为链接：${relative}`);
    }
    const raw = readBytes(file);
    if (raw.length > IMAGE_LIMIT) throw new Error(`plugins/${pluginId}: 图片超过 2 MiB：${relative}`);
    rendered.push({
      path: `plugins/${pluginId}/${relative}`,
      sha256: sha256(raw),
      bytes: raw.length,
      media: IMAGE_MEDIA[suffix],
    });
  }
  if (rendered.length) display.images = rendered;
  if (meta.donation !== undefined) {
    if (!asObject(meta.donation) || Object.keys(meta.donation).length !== 1
      || typeof meta.donation.afdian !== 'string') {
      throw new Error(`plugins/${pluginId}: donation 只能包含 afdian 字符串`);
    }
    display.donation = { afdian: meta.donation.afdian };
  }
  const updated = gitUpdatedAt(root, `plugins/${pluginId}/plugin.json`);
  if (updated) display.updatedAt = updated;
  return display;
}

function versionParts(value) {
  return String(value).split('.').map(part => Number(part) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

/** Build the index-v5 entry for one source directory, or null when it is not a v5 package. */
function entryFor(root, directory) {
  const manifestFile = path.join(directory, 'plugin.json');
  if (!fs.existsSync(manifestFile)) return null;
  const sourceBytes = readBytes(manifestFile);
  const manifest = readJsonStrict(manifestFile, `plugins/${directory.name}/plugin.json`);
  if (!asObject(manifest) || manifest.format !== 'whale-plugin/1') return null;
  const pluginId = manifest.id;
  const version = manifest.version;
  if (typeof pluginId !== 'string' || !ID.test(pluginId) || RESERVED.test(pluginId)) {
    throw new Error(`plugins/${directory.name}: 插件 id 无效`);
  }
  if (typeof manifest.level !== 'number' || !Number.isInteger(manifest.level)) {
    throw new Error(`plugins/${directory.name}: level 必须是整数`);
  }
  const policy = levelPolicy(root, manifest.level);
  if (manifest.runtime !== policy.runtime) throw new Error(`plugins/${directory.name}: runtime 与 level 不匹配`);
  if (manifest.entry !== policy.entry) throw new Error(`plugins/${directory.name}: entry 与 level 不匹配`);
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`plugins/${directory.name}: version 无效`);
  }
  const zipName = `${pluginId}-${version}.zip`;
  const packageFile = path.join(root, 'packages', zipName);
  if (!fs.existsSync(packageFile)) return null; // source-only draft: not listed yet
  const packageBytes = readBytes(packageFile);
  const entries = readZip(packageBytes, { maxEntries: 2, maxBytes: loadProtocol(root).limits.maxPackageBytes });
  const byName = new Map(entries.map(entry => [entry.name, entry.data]));
  if (byName.size !== 2 || !byName.has('plugin.json') || !byName.has(policy.entry)) {
    throw new Error(`packages/${zipName}: 必须只包含 plugin.json 和 ${policy.entry}`);
  }
  const packagedManifest = byName.get('plugin.json');
  if (!Buffer.from(packagedManifest).equals(sourceBytes)) {
    throw new Error(`packages/${zipName}: 包内 plugin.json 必须与 plugins/${pluginId}/plugin.json 完全一致`);
  }
  return {
    manifest,
    manifestSha256: sha256(packagedManifest),
    package: {
      path: `packages/${zipName}`,
      download: PREFIX + zipName,
      sha256: sha256(packageBytes),
      bytes: packageBytes.length,
    },
    display: displayFor(root, directory, manifest),
  };
}

/** Collect all whale-plugin/1 entries for index-v5.json. */
function collectV5(root = ROOT) {
  const plugins = path.join(root, 'plugins');
  const entries = [];
  if (!fs.existsSync(plugins)) return entries;
  for (const name of fs.readdirSync(plugins).sort()) {
    const directory = path.join(plugins, name);
    if (!fs.statSync(directory).isDirectory()) continue;
    const entry = entryFor(root, directory);
    if (entry) entries.push(entry);
  }
  entries.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)
    || compareVersions(left.manifest.version, right.manifest.version));
  return entries;
}

module.exports = {
  V5_INDEX,
  PREFIX,
  DISPLAY_FILE,
  collectV5,
  compareVersions,
  entryName,
  loadProtocol,
  readJsonStrict,
  sha256,
};
