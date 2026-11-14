'use strict';
/**
 * End-to-end check against the REAL host executor (WhaleGirl >= 4.1.2).
 *
 *   WHALE_ROOT=/path/to/WhaleGirl node tests/host-e2e.js
 *
 * WHALE_ROOT must be supplied by the runner (no machine-specific path is
 * hardcoded). Uses the offline mock CLI, so no API key or network is needed.
 * Everything is written to a temporary directory and removed afterwards.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = process.env.WHALE_ROOT;
if (!ROOT) {
  console.log('SKIP: set WHALE_ROOT to your WhaleGirl directory to run this test.');
  console.log('      e.g. WHALE_ROOT=/path/to/WhaleGirl node tests/host-e2e.js');
  process.exit(0);
}

const SERVICE = path.join(ROOT, 'src', 'services', 'javascriptPlugins.js');
if (!fs.existsSync(SERVICE)) {
  console.error('FAIL: cannot find', SERVICE);
  process.exit(1);
}
const { JavaScriptPlugins } = require(SERVICE);

const ID = 'codebuddy-cli-model';
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin.json'), 'utf8'));
const MOCK = path.resolve(__dirname, 'mock-cli.js');
// model is intentionally omitted here: the host E2E must prove the built-in
// default (deepseek-v4.1-flash) actually reaches the CLI's --model argument.
const SETTINGS = { apiKey: 'dummy', cliEntry: MOCK, cwd: os.tmpdir() };

function install(root) {
  const dir = path.join(root, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ID + '.enabled'), '');
  const flow = {
    id: ID, api: 4, kind: 'message', hooks: MANIFEST.Hooks,
    permissions: ['system.full'], javascript: SOURCE,
    executionTimeoutMs: 30000, intervalSeconds: 60,
  };
  const bytes = Buffer.from(JSON.stringify(flow), 'utf8');
  fs.writeFileSync(path.join(dir, ID + '.flow.json'), bytes);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(dir, ID + '.flow-grant.json'),
    JSON.stringify({ hash, enabled: true, fullAccess: true, settings: SETTINGS }));
  return { dir, hash };
}

const context = {
  key: 'e2e:private:example', now: Date.now(),
  message: { platform: 'wechat', chatId: 'chat_example', chatType: 'private',
    senderId: 'sender_example', text: '在吗', atMe: true, replyToBot: false, mentionedNames: [] },
  history: [], system: '你是鲸鲸', text: '',
};

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-api4-e2e-'));
  const warnings = [];
  const service = new JavaScriptPlugins({
    dataDir: root, enabled: () => true,
    logger: { warn: m => warnings.push(m), info: () => {} },
  });
  try {
    const { hash } = install(root);
    const grantFile = path.join(root, 'plugins', ID + '.flow-grant.json');
    const list = service.installed();
    console.log('installed():', list.map(p => p.id + ' hooks=' + p.hooks.join('|')).join(', ') || '(empty)');
    if (!list.length) throw new Error('host did not recognise the Api 4 plugin');

    const prompt = await service.run('chat.prompt', context);
    console.log('run(chat.prompt) ->', JSON.stringify(prompt).slice(0, 160));
    const generated = await service.run('chat.generate', context);
    console.log('run(chat.generate) ->', JSON.stringify(generated).slice(0, 300));
    if (!generated.text || !generated.text.includes('离线模拟应答'))
      throw new Error('plugin did not replace the turn with CLI output');
    if (!generated.text.includes('模型=deepseek-v4.1-flash'))
      throw new Error('built-in default model did not reach the CLI: ' + generated.text);
    console.log('default model -> deepseek-v4.1-flash OK');
    if (warnings.length) throw new Error('host recorded a plugin fallback: ' + warnings.join(' / '));

    // v1.2.0: no tool.run -> the launcher must NOT render 「手动运行 / 运行一次」.
    let refused = false;
    try { await service.runTool(ID, {}); }
    catch (failure) { refused = /plugin_not_enabled/.test(failure.code || failure.message || ''); }
    console.log('runTool without tool.run ->', refused ? 'refused (card section hidden)' : 'UNEXPECTED');
    if (!refused) throw new Error('tool.run still enabled; the card would still show 手动运行');

    // Model picking still works entirely inside the chat flow.
    const menu = await service.run('chat.generate', {
      ...context, message: { ...context.message, text: '模型' },
    });
    if (!menu.text || !menu.text.includes('【选模型】'))
      throw new Error('in-chat model menu missing: ' + JSON.stringify(menu));
    console.log('chat menu ->', menu.text.split('\n')[0]);

    // A pre-filled template in the settings box must NOT be treated as a real key.
    fs.writeFileSync(grantFile, JSON.stringify({
      hash, enabled: true, fullAccess: true,
      settings: { apiKey: '在这里粘贴你的 CodeBuddy API Key' },
    }));
    const hint = await service.run('chat.generate', { ...context, key: 'e2e:private:hint' });
    if (!hint.text || !hint.text.includes('{"apiKey":"'))
      throw new Error('missing in-chat config hint: ' + JSON.stringify(hint));
    console.log('config hint ->', hint.text.split('\n')[1]);
    if (warnings.length) throw new Error('host recorded a plugin fallback: ' + warnings.join(' / '));

    // Revoke the per-plugin grant: the host must fall back immediately.
    fs.writeFileSync(grantFile, JSON.stringify({
      hash, enabled: false, fullAccess: false, settings: SETTINGS,
    }));
    const revoked = await service.run('chat.generate', { ...context, text: 'ORIGINAL' });
    console.log('after revoke ->', JSON.stringify(revoked).slice(0, 160));
    if (revoked.text !== 'ORIGINAL') throw new Error('plugin still active after grant revocation');
    if (warnings.length) throw new Error('host recorded a plugin fallback: ' + warnings.join(' / '));

    console.log('\nHOST E2E PASS: real host worker executed the plugin, '
      + 'text replaced the turn, revocation took effect immediately, warnings: (none).');
  } finally {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('HOST E2E FAIL: ' + (error.stack || error.message));
  process.exitCode = 1;
});
