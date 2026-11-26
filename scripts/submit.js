#!/usr/bin/env node
'use strict';

/**
 * 一条命令跑完投稿自检（给 agent 和小白用）：
 *
 *   node scripts/submit.js plugins/my-plugin
 *
 * 做三件事：
 *   1. 打包到 packages/<id>-<version>.zip（已存在则拒绝，防止覆盖旧版本）
 *   2. 在临时副本里重新生成目录
 *   3. 用 market 的 validate.py 校验（没有 python 就跳过并提示）
 *
 * 然后打印下一步要执行的 git / gh 命令。它不联网、不提交、不推送。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/** Windows 编辑器常给 UTF-8 加 BOM；JSON.parse 不认，先剥掉。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function run(script, args, options = {}) {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT, stdio: 'inherit', ...options,
  });
}

const SKIP = new Set(['.git', 'node_modules']);

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    // 跳过 .git、node_modules，以及上一次没清掉的临时目录（否则会把自己拷进自己）。
    if (SKIP.has(entry.name) || entry.name.startsWith('.submit-')) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function hasPython() {
  try {
    execFileSync('python', ['--version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function main(argv) {
  const dir = path.resolve(ROOT, argv[0] || '');
  const manifestFile = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestFile)) {
    console.error('用法：node scripts/submit.js plugins/<id>');
    return 1;
  }
  const manifest = JSON.parse(stripBom(fs.readFileSync(manifestFile, 'utf8')));

  console.log('\n[1/3] 打包');
  const before = fs.existsSync(path.join(ROOT, 'packages', `${manifest.Id}-${manifest.Version}.zip`));
  try {
    run('package.js', [path.relative(ROOT, dir)]);
  } catch {
    if (before) return 1; // 已有同版本包：package.js 已经说清楚了
    return 1;
  }

  console.log('\n[2/3] 在临时副本里生成目录');
    // 先试系统临时目录；受限环境会拒绝 mkdtemp，这时退到仓库内（copyDir 已跳过 .submit-*）。
  let temp;
  try {
    temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'whale-submit-'));
  } catch {
    temp = fs.mkdtempSync(path.join(ROOT, '.submit-'));
  }
  try {
    copyDir(ROOT, temp);
    run('build-index.js', [], { cwd: temp });

    console.log('\n[3/3] 市场校验');
    if (!hasPython()) {
      console.log('  跳过：本机没有 python。提交前在 CI 上会跑同样的校验。');
    } else {
      const result = execFileSync('python', ['validate.py'], { cwd: temp, encoding: 'utf8' });
      process.stdout.write(result);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const unified = manifest.format === 'whale-plugin/1';
  const id = unified ? manifest.id : manifest.Id;
  const version = unified ? manifest.version : manifest.Version;
  const name = unified ? manifest.name : manifest.Name;
  const minVersion = unified ? manifest.minAppVersion : manifest.MinAppVersion;
  const zip = `packages/${id}-${version}.zip`;
  // whale-plugin/1 不要求旧 Api 的 provenance；其余 Api 3/4 仍按旧流程。
  const extra = !unified && [3, 4].includes(manifest.Api) ? ` provenance/${id}-${version}.json` : '';
  console.log(`
本地自检通过。下一步（只提交插件目录和 ZIP，别改 index*.json）：
${unified ? '\n  说明：whale-plugin/1 会由 scripts/build-index.js 生成 index-v5.json；' +
    'README/market.json/图片只随源码提交，不进安装 ZIP。\n' : ''}
  git checkout -b plugin/${id}
  git add ${path.posix.join('plugins', id)} ${zip}${extra}
  git commit -m "plugin: ${name} ${version}"
  gh repo fork Banan1cee/whale-girl-plugins --clone=false
  git push -u <你的 GitHub 用户名> plugin/${id}
  gh pr create --repo Banan1cee/whale-girl-plugins --base main \\
    --title "plugin: ${name} ${version}" \\
    --body "功能：…；所需客户端版本：${minVersion}；本地校验：submit.js 通过"
`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
