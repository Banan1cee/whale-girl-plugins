#!/usr/bin/env node
'use strict';

/**
 * 从插件源码目录和 packages/ 自动生成市场目录。
 *
 * 为什么要有它：以前投稿要手改 index*.json，两个人同时提 PR 必然冲突，目录和包也容易对不上。
 * 现在作者只需要提交两样东西：
 *   plugins/<id>/plugin.json   插件清单
 *   packages/<id>-<version>.zip  固定版本的安装包
 * 目录（index.json / index-v2.json / index-v3.json / index-personas.json）由这个脚本生成。
 *
 * 用法：
 *   node scripts/build-index.js              # 写入仓库根目录的四个目录文件
 *   node scripts/build-index.js --out <dir>  # 写到别处（PR 校验用，不动工作区）
 *   node scripts/build-index.js --check      # 只检查目录是否与源码同步，漂移则退出码 1
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = 'https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/packages/';
const PERSONA = 'index-personas.json';
const BY_API = { 1: 'index.json', 2: 'index-v2.json', 3: 'index-v3.json' };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function catalogFor(manifest) {
  if ((manifest.Kind || 'tool') === 'persona') return PERSONA;
  return BY_API[manifest.Api] || null;
}

/** 扫描 plugins/ + packages/，返回 { 目录文件名: [条目...] } */
function collect(root = ROOT) {
  const out = { [BY_API[1]]: [], [BY_API[2]]: [], [BY_API[3]]: [], [PERSONA]: [] };
  const pluginsDir = path.join(root, 'plugins');
  const packagesDir = path.join(root, 'packages');
  if (!fs.existsSync(pluginsDir)) return out;

  for (const name of fs.readdirSync(pluginsDir).sort()) {
    const manifestFile = path.join(pluginsDir, name, 'plugin.json');
    if (!fs.existsSync(manifestFile)) continue;
    let manifest;
    try {
      manifest = readJson(manifestFile);
    } catch (error) {
      console.warn(`跳过 plugins/${name}：plugin.json 解析失败（${error.message}）`);
      continue;
    }
    const catalog = catalogFor(manifest);
    if (!catalog) {
      console.warn(`跳过 plugins/${name}：Api=${manifest.Api} Kind=${manifest.Kind} 没有对应目录`);
      continue;
    }
    const zipName = `${manifest.Id}-${manifest.Version}.zip`;
    const zipFile = path.join(packagesDir, zipName);
    if (!fs.existsSync(zipFile)) {
      // 没有对应 ZIP 视为草稿，不上架，也不报错（作者可以先提源码）。
      continue;
    }
    out[catalog].push({
      ...manifest,
      Download: PREFIX + zipName,
      Sha256: sha256(zipFile),
    });
  }

  const versionKey = (value) => String(value).split('.').map((part) => Number(part) || 0);
  const compare = (a, b) => String(a.Id).localeCompare(String(b.Id))
    || versionKey(a.Version).reduce((acc, part, index) => acc || part - (versionKey(b.Version)[index] || 0), 0);
  for (const key of Object.keys(out)) out[key].sort(compare);
  return out;
}

function serialize(list) {
  return JSON.stringify(list, null, 2) + '\n';
}

function main(argv) {
  const outIndex = argv.indexOf('--out');
  const outDir = outIndex >= 0 ? path.resolve(argv[outIndex + 1]) : ROOT;
  const check = argv.includes('--check');
  const catalogs = collect();

  let drift = [];
  for (const [file, list] of Object.entries(catalogs)) {
    const text = serialize(list);
    const target = path.join(outDir, file);
    if (check) {
      // 工作区可能是 CRLF（Windows 检出），比较前统一成 LF，别把换行差异当成目录漂移。
      const raw = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      const current = raw === null ? null : raw.replace(/\r\n/g, '\n');
      if (current !== text) drift.push(file);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
    console.log(`✓ ${file}：${list.length} 条`);
  }

  if (check && drift.length) {
    console.error('目录与 plugins/ + packages/ 不同步：' + drift.join('、'));
    console.error('运行 node scripts/build-index.js 重新生成后再提交。');
    return 1;
  }
  if (check) console.log('目录已和源码同步。');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { collect, serialize, PREFIX, BY_API, PERSONA };
