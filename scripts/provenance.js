#!/usr/bin/env node
'use strict';

/**
 * 生成 Api 3 插件需要的 provenance/<id>-<version>.json。
 *
 *   node scripts/provenance.js plugins/my-plugin --login <你的 GitHub 名>
 *   node scripts/provenance.js plugins/my-plugin --login <名> --publisher-id 123456
 *
 * 为什么要有它：小白（和替他跑腿的 agent）不知道要填什么数字 ID、commit、目录，
 * 手抄一遍容易错。这里从 git 和 GitHub API 自动取，取不到就明确报错，而不是给个空字段。
 *
 * 字段含义见 security/README.md：
 *   publisher.login / publisher.id  发布主体的 GitHub 账号与数字 ID（组织也可以）
 *   source.repository               承载这份源码的 GitHub 仓库
 *   source.commit                   完整 40 位 commit
 *   source.path                     插件在仓库里的目录
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/** Windows 编辑器常给 UTF-8 加 BOM；JSON.parse 不认，先剥掉。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : '';
}

async function publisherId(login) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return null;
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: { Authorization: 'token ' + token, 'User-Agent': 'whale-plugin-provenance', Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user.id === 'number' ? user.id : null;
}

async function main() {
  const dir = path.resolve(ROOT, process.argv[2] || '');
  const manifestFile = path.join(dir, 'plugin.json');
  if (!fs.existsSync(manifestFile)) {
    console.error('用法：node scripts/provenance.js plugins/<id> --login <GitHub 名> [--publisher-id <数字>]');
    return 1;
  }
  const manifest = JSON.parse(stripBom(fs.readFileSync(manifestFile, 'utf8')));
  if (![3, 4].includes(manifest.Api)) {
    console.error('provenance 对 Api 3/4 插件必需；当前清单 Api=' + manifest.Api);
    return 1;
  }

  const login = arg('--login') || process.env.GITHUB_ACTOR || '';
  if (!login) {
    console.error('缺少 --login（GitHub 用户名，也就是这份源码的发布主体）。');
    return 1;
  }
  let id = Number(arg('--publisher-id')) || null;
  if (!id) id = await publisherId(login);
  if (!id) {
    console.error(`拿不到 ${login} 的数字 ID。设 GITHUB_TOKEN 后重试，或直接传 --publisher-id <数字>。`);
    return 1;
  }

  const GIT = process.env.GIT || 'git';
  const git = (args) => {
    try {
      return execFileSync(GIT, args, { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('找不到 git：请安装 Git，或用环境变量 GIT 指向 git 可执行文件');
      throw error;
    }
  };
  const remote = git(['config', '--get', 'remote.origin.url']);
  const repo = remote.replace(/^git@github\.com:/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    console.error('无法从 remote.origin.url 解析仓库：' + remote);
    return 1;
  }
  const commit = git(['rev-parse', 'HEAD']);
  const rel = path.relative(ROOT, dir).replace(/\\/g, '/');

  // 源码还没提交时 commit 内容对不上，提前拦住，免得审查时发现 provenance 指向旧提交。
  try {
    const dirty = execFileSync(GIT, ['status', '--porcelain', '--', rel], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (dirty) {
      console.error('插件目录还有未提交改动：先 git add 并 commit，再生成 provenance。');
      return 1;
    }
  } catch { /* 不是 git 仓库时跳过这项检查 */ }

  const file = path.join(ROOT, 'provenance', `${manifest.Id}-${manifest.Version}.json`);
  if (fs.existsSync(file)) {
    console.error(`provenance/${manifest.Id}-${manifest.Version}.json 已存在；升版本号后再生成。`);
    return 1;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    publisher: { login, id },
    source: { repository: repo, commit, path: rel },
  }, null, 2) + '\n', 'utf8');
  console.log(`✓ provenance/${manifest.Id}-${manifest.Version}.json`);
  console.log(`  ${login} (${id}) · ${repo} @ ${commit.slice(0, 7)} · ${rel}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('生成失败：' + error.message);
  process.exit(1);
});
