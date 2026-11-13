'use strict';
// Trusted probe; candidate code runs only in the dedicated disposable container.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JavaScriptPlugins } = require('/host/javascriptPlugins.js');
(async () => {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const dataDir = fs.mkdtempSync('/tmp/whale-api4-');
  const directory = path.join(dataDir, 'plugins'); fs.mkdirSync(directory);
  const flow = { ...request, api: 4, permissions: ['system.full'] };
  const bytes = Buffer.from(JSON.stringify(flow));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(directory, flow.id + '.flow.json'), bytes);
  fs.writeFileSync(path.join(directory, flow.id + '.enabled'), '');
  fs.writeFileSync(path.join(directory, flow.id + '.flow-grant.json'), JSON.stringify({ enabled: true, fullAccess: true, hash, settings: {} }));
  const failures = [];
  const manager = new JavaScriptPlugins({ dataDir, logger: { warn: () => failures.push('fallback') },
    hostCall: async (method) => {
      if (method === 'search') return { status: 'ok', text: 'Synthetic source https://example.test/source', items: [
        { title: 'Synthetic report', url: 'https://example.test/source', snippet: 'Synthetic evidence', publishedAt: null, fetchedAt: '2026-11-12T12:00:00Z' }] };
      if (method === 'model') return 'Synthetic model response';
      if (method === 'send') return { id: 'fixture', status: 'queued', confirmed: false };
      if (method === 'delivery') return { status: 'submitted', confirmed: false };
      if (method === 'api') return { status: 200, ok: true, body: { ok: true, testing: true } };
      return { api: 4, testing: true, hooks: request.hooks };
    } });
  try {
    for (const hook of request.hooks) {
      const context = { testing: true, key: 'synthetic-chat', now: Date.parse('2026-11-13T12:00:00Z'),
        message: { platform: 'wechat', chatType: 'private', chatId: 'test-conversation', senderId: 'test-sender',
          text: '帮我查一下昨天比赛结果', atMe: true }, history: [], text: 'Synthetic reply', system: 'Synthetic prompt',
        search: { status: 'skipped', text: '', items: [] }, input: {} };
      if (hook === 'tool.run') await manager.runTool(flow.id, {});
      else if (['app.start', 'timer.tick', 'app.stop'].includes(hook)) await manager.runSingle(manager.installed()[0], hook);
      else await manager.run(hook, context);
      if (failures.length) throw Error('fallback');
    }
    fs.unlinkSync(path.join(directory, flow.id + '.flow-grant.json'));
    await manager.reconcile();
    if (manager.installed().length || manager.workers.size) throw Error('revocation failed');
    await manager.stop();
    process.stdout.write(JSON.stringify({ passed: true }));
  } finally { await manager.stop(); }
})().catch(() => { process.exitCode = 1; });
