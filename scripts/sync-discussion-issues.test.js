'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { syncDiscussions } = require('./sync-discussion-issues');

const plugin = (Id, Name = Id) => ({ Id, Name });
const botIssue = (number, id) => ({
  number,
  user: { login: 'github-actions[bot]' },
  body: '<!-- whale-market-discussion:' + id + ' -->\n说明',
});

test('已有评论沿用原编号，新插件只开一个帖，同一 ID 升级复用', () => {
  const existing = { old: 47 };
  const created = [];
  const catalog = [plugin('old', '改名后'), plugin('new', '新插件'), plugin('new', '升级后')];
  const create = (issue) => { created.push(issue); return { number: 60 }; };
  assert.deepEqual(syncDiscussions(catalog, existing, [], create), { old: 47, new: 60 });
  assert.equal(created.length, 1);
  assert.match(created[0].body, /^<!-- whale-market-discussion:new -->/);
  assert.deepEqual(existing, { old: 47 });
});

test('Issue 已创建但目录提交失败时，重跑找回同一个编号', () => {
  const previousRun = { ...botIssue(61, 'new'), state: 'closed' };
  assert.deepEqual(syncDiscussions([plugin('new')], {}, [previousRun], () => assert.fail()), { new: 61 });
});

test('忽略 PR 和普通用户创建的仿冒标记', () => {
  const pull = { ...botIssue(60, 'new'), pull_request: {} };
  const imitation = { ...botIssue(61, 'new'), user: { login: 'someone-else' } };
  assert.deepEqual(syncDiscussions([plugin('new')], {}, [pull, imitation], () => ({ number: 62 })), { new: 62 });
});

test('重复标记或编号归属冲突时停下来，避免把入口绑错', () => {
  assert.throws(() => syncDiscussions([plugin('new')], {}, [botIssue(60, 'new'), botIssue(61, 'new')], () => assert.fail()), /多个/);
  assert.throws(() => syncDiscussions([plugin('new')], { old: 60 }, [botIssue(60, 'new')], () => assert.fail()), /已被使用/);
});
