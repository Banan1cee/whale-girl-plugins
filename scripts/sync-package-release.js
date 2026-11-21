'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { collect } = require('./build-index');

const repository = 'Banan1cee/whale-girl-plugins';
const tag = 'plugin-packages';

function missingPackageFiles(catalog, assets) {
  const byName = new Map(assets.map(asset => [asset.name, asset]));
  const found = new Set();
  const missing = [];
  for (const plugin of catalog) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(plugin.Id) || !/^\d+(?:\.\d+){1,3}$/.test(plugin.Version)
        || !/^[a-f0-9]{64}$/.test(plugin.Sha256)) {
      throw new Error('目录中有无效的插件包坐标');
    }
    const name = `${plugin.Id}-${plugin.Version}.zip`;
    if (found.has(name)) throw new Error(`目录包含重复的安装包：${name}`);
    found.add(name);
    const asset = byName.get(name);
    if (!asset) missing.push(name);
    else if (asset.state !== 'uploaded' || asset.digest !== `sha256:${plugin.Sha256}`) {
      throw new Error(`已发布资产与市场目录不符：${name}`);
    }
  }
  return missing;
}

function main() {
  const release = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/releases/tags/${tag}`], { encoding: 'utf8' }));
  if (release.draft || release.tag_name !== tag || !Number.isSafeInteger(release.id)) {
    throw new Error('下载统计 Release 尚未公开');
  }
  const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp',
    `repos/${repository}/releases/${release.id}/assets?per_page=100`], { encoding: 'utf8' }));
  const root = path.resolve(__dirname, '..');
  const missing = missingPackageFiles(Object.values(collect(root)).flat(), pages.flat());
  for (const name of missing) {
    console.log(`同步插件包 ${name}`);
    execFileSync('gh', ['release', 'upload', tag, path.join(root, 'packages', name), '--repo', repository], { stdio: 'inherit' });
  }
}

if (require.main === module) main();
module.exports = { missingPackageFiles };
