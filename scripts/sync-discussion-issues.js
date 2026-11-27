'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { collect } = require('./build-index');

const REPOSITORY = 'Banan1cee/whale-girl-plugins';
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const MARKER = /^<!-- whale-market-discussion:([a-z][a-z0-9-]{0,47}) -->\r?$/m;
const issueNumber = (value) => Number.isInteger(value) && value > 0 && value <= 2147483647;

function syncDiscussions(catalog, current, issues, createIssue) {
  const mapping = { ...current };
  const used = new Set(Object.values(mapping));
  const createdById = new Map();
  for (const issue of issues) {
    if (issue.pull_request || issue.user?.login !== 'github-actions[bot]' || !issueNumber(issue.number)) continue;
    const id = MARKER.exec(issue.body || '')?.[1];
    if (!id) continue;
    const numbers = createdById.get(id) || [];
    numbers.push(issue.number);
    createdById.set(id, numbers);
  }

  for (const plugin of catalog) {
    const id = plugin.Id;
    if (!ID.test(id)) throw new Error('目录包含无效的插件 ID');
    if (Object.hasOwn(mapping, id)) continue;
    const existing = createdById.get(id) || [];
    if (existing.length > 1) throw new Error('插件 ' + id + ' 有多个自动讨论帖，请先核对对应关系');

    // Issue 建好但目录提交失败时，可以按标记找回编号，继续上次同步。
    const name = String(plugin.Name || id).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120) || id;
    const number = existing[0] ?? createIssue({
      title: '插件讨论｜' + name,
      body: [
        '<!-- whale-market-discussion:' + id + ' -->',
        '这是此插件的长期讨论帖。欢迎分享使用体验或反馈问题。',
        '',
        '反馈时请注明鲸鲸版本和插件版本。请在贴日志前删掉密钥、聊天内容和其他个人信息。',
        '',
        '[插件文档](https://github.com/' + REPOSITORY + '/tree/main/plugins/' + id + ')',
      ].join('\n'),
    }).number;
    if (!issueNumber(number) || used.has(number)) throw new Error('插件 ' + id + ' 的讨论帖编号无效或已被使用');
    mapping[id] = number;
    used.add(number);
    console.log('插件讨论帖：' + id + ' → #' + number);
  }
  return mapping;
}

function ghApi(args) {
  const output = execFileSync('gh', ['api', ...args], { encoding: 'utf8', timeout: 60_000 });
  return JSON.parse(output);
}

function main() {
  const root = path.resolve(__dirname, '..');
  const mappingFile = path.join(root, 'discussion-issues.json');
  const catalog = Object.values(collect(root)).flat();
  const current = fs.existsSync(mappingFile) ? JSON.parse(fs.readFileSync(mappingFile, 'utf8').replace(/^\uFEFF/, '')) : {};
  if (catalog.every((plugin) => Object.hasOwn(current, plugin.Id))) return;
  const resource = 'repos/' + REPOSITORY + '/issues';
  const issues = ghApi(['--paginate', '--slurp', resource + '?state=all&per_page=100']).flat();
  const mapping = syncDiscussions(catalog, current, issues, ({ title, body }) =>
    ghApi(['--method', 'POST', resource, '-f', 'title=' + title, '-f', 'body=' + body]));
  const sorted = Object.fromEntries(Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(mappingFile, JSON.stringify(sorted, null, 2) + '\n');
}

if (require.main === module) main();
module.exports = { syncDiscussions };
