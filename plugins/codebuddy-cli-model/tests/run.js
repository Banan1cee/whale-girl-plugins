'use strict';
/**
 * Offline contract tests. No network, no API key, no WhaleGirl install needed.
 *   node tests/run.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const plugin = require('../plugin.js');

const MOCK = path.resolve(__dirname, 'mock-cli.js');
const KEY = 'dummy';
const settings = (extra = {}) => Object.assign({ apiKey: KEY, cliEntry: MOCK, cwd: __dirname }, extra);
const input = (extra = {}) => Object.assign({
  api: 4, hook: 'chat.generate', key: 'unit:private:test', now: Date.now(),
  message: { platform: 'wechat', chatId: 'chat_example', chatType: 'private',
    senderId: 'sender_example', text: '在吗', atMe: true, replyToBot: false, mentionedNames: [] },
  history: [], settings: settings(), state: {},
}, extra);

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  PASS ', name); }
  else { failed += 1; console.log('  FAIL ', name, detail === undefined ? '' : '-> ' + JSON.stringify(detail).slice(0, 300)); }
}

async function generate(extraInput, extraSettings) {
  return await plugin.hooks['chat.generate'](input({ settings: settings(extraSettings), ...extraInput }));
}

async function main() {
  console.log('offline contract tests for codebuddy-cli-model\n');

  // 1. chat.prompt stores the persona in session state
  const promptOut = plugin.hooks['chat.prompt'](input({
    hook: 'chat.prompt', system: '你是鲸鲸，一只傲娇的小鲸鱼。',
  }));
  check('chat.prompt 存人设到 state', typeof promptOut.state.system === 'string'
    && promptOut.state.system.includes('傲娇'), promptOut);
  check('chat.prompt 不修改 system/text', promptOut.system === undefined && promptOut.text === undefined, promptOut);

  // 2. normal generation replaces the turn
  const ok = await generate();
  check('正常消息返回 CLI 文本', typeof ok.text === 'string' && ok.text.includes('离线模拟应答'), ok);
  check('成功时不覆盖 state（保留人设）', ok.state === undefined, ok);

  // 3. persona + history flow through to the CLI
  const echo = await generate({ state: { system: '你是鲸鲸' } }, { model: 'mock:echo' });
  check('人设经 state 传给 CLI', typeof echo.text === 'string' && echo.text.includes('SYS=你是鲸鲸'), echo);
  const hist = await generate({ history: [
    { role: 'user', text: '上一句' }, { role: 'assistant', text: '上一句回复' },
  ] }, { model: 'mock:echo', historyTurns: 2 });
  check('historyTurns 开启时把历史拼进 prompt', typeof hist.text === 'string'
    && hist.text.includes('上一句') && hist.text.includes('上一句回复'), hist);
  const noHist = await generate({ history: [{ role: 'user', text: '不该出现' }] }, { model: 'mock:echo' });
  check('默认不发聊天历史', typeof noHist.text === 'string' && !noHist.text.includes('不该出现'), noHist);

  // 4. output sanitising (host rejects control chars and @all)
  const unsafe = await generate({}, { model: 'mock:unsafe' });
  check('控制字符被清除', typeof unsafe.text === 'string' && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(unsafe.text), unsafe);
  check('@所有人 被中和', typeof unsafe.text === 'string' && unsafe.text.includes('@大家')
    && !unsafe.text.includes('@所有人'), unsafe);

  // 5. missing key: friendly hint once, then silent fallback
  const noKey = await plugin.hooks['chat.generate'](input({ settings: settings({ apiKey: '' }) }));
  check('缺 Key 首次给出友好提示', typeof noKey.text === 'string' && noKey.text.includes('API Key'), noKey);
  check('提示不带 Key/路径/命令原文', !noKey.text.includes('dummy') && !noKey.text.includes(MOCK), noKey.text);
  const second = await plugin.hooks['chat.generate'](input({ settings: settings({ apiKey: '' }), state: { notified: true } }));
  check('同会话第二次静默回退', Object.keys(second).length === 0, second);
  const silent = await plugin.hooks['chat.generate'](input({ settings: settings({ apiKey: '', onError: 'fallback' }) }));
  check('onError=fallback 完全静默', Object.keys(silent).length === 0, silent);

  // 6. inputs the plugin should not touch
  const empty = await generate({ message: { text: '' } });
  check('空消息不接管', Object.keys(empty).length === 0, empty);
  const skipped = await generate({}, { skipPatterns: '提醒,取消提醒' });
  // 默认消息不含关键词，这里单独构造命中用例
  const skippedHit = await generate({ message: { text: '取消提醒' } }, { skipPatterns: '提醒,取消提醒' });
  check('skipPatterns 命中时不接管', Object.keys(skippedHit).length === 0, skippedHit);
  check('skipPatterns 未命中时正常接管', typeof skipped.text === 'string', skipped);

  // 7. failure classification, always desensitised
  const auth = await generate({}, { model: 'mock:auth' });
  check('鉴权失败给出可读提示', typeof auth.text === 'string' && auth.text.includes('鉴权'), auth);
  check('鉴权提示不回显 stderr', !auth.text.includes('Authentication'), auth.text);
  const cliFail = await generate({}, { model: 'mock:fail' });
  check('CLI 非零退出给出通用提示', typeof cliFail.text === 'string' && cliFail.text.includes('调用失败'), cliFail);
  const emptyResult = await generate({}, { model: 'mock:empty' });
  check('空结果给出通用提示', typeof emptyResult.text === 'string' && emptyResult.text.includes('没有返回'), emptyResult);
  const debug = await generate({}, { model: 'mock:fail', debug: true });
  check('debug 只追加错误码', typeof debug.text === 'string' && debug.text.includes('错误码：cli_error'), debug);
  const timeout = await generate({}, { model: 'mock:sleep', timeoutMs: 1000 });
  check('超时给出可读提示', typeof timeout.text === 'string' && timeout.text.includes('超时'), timeout);

  // 8. no secrets or machine paths ever leak into a reply
  const leak = await generate({}, { model: 'mock:fail' });
  check('失败回复不含 Key / 本机路径', !JSON.stringify(leak).includes('dummy')
    && !JSON.stringify(leak).includes(MOCK), leak);

  // 9. 默认模型、ID 解析、以及「选择式」改模型
  const DIRS = [];
  function session() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-model-test-'));
    DIRS.push(dir);
    const whale = { paths: { pluginData: dir } };
    return { dir, make: (text, extra = {}) => input(Object.assign({ whale, message: { text } }, extra)) };
  }
  const gen = inp => plugin.hooks['chat.generate'](inp);

  check('导出目录与默认值', plugin.defaultModel === 'deepseek-v4.1-flash'
    && plugin.modelCatalog.length === 22, plugin.defaultModel);
  check('大小写容错：deepseek-V4.1-flash -> 规范 ID',
    plugin.normalizeModel('deepseek-V4.1-flash') === 'deepseek-v4.1-flash');
  check('未知模型 ID 原样透传（CLI 未来新增不受限）',
    plugin.normalizeModel('future-model-x') === 'future-model-x');

  const dflt = await gen(session().make('在吗'));
  check('默认模型是 deepseek-v4.1-flash', typeof dflt.text === 'string'
    && dflt.text.includes('模型=deepseek-v4.1-flash'), dflt.text);
  const byNumber = await gen(session().make('在吗', { settings: settings({ model: '2' }) }));
  check('卡片里填编号 2 也能选模型', byNumber.text.includes('模型=glm-5.3-flash'), byNumber.text);
  const byAlias = await gen(session().make('在吗', { settings: settings({ model: 'DS' }) }));
  check('卡片里填别名 DS 也能选模型', byAlias.text.includes('模型=deepseek-v4.1-flash'), byAlias.text);
  const byCase = await gen(session().make('在吗', { settings: settings({ model: 'deepseek-V4.1-flash' }) }));
  check('卡片里大小写写错也能落到正确 ID', byCase.text.includes('模型=deepseek-v4.1-flash'), byCase.text);

  const menu = await gen(session().make('模型', { settings: settings({ apiKey: '' }) }));
  check('发「模型」出编号菜单（不需要 API Key）', typeof menu.text === 'string'
    && menu.text.includes('【选模型】') && menu.text.includes('1 deepseek-v4.1-flash'), menu.text);
  check('菜单只在 state 里记时间戳，不泄漏 Key/路径', typeof menu.state.menuAt === 'number'
    && !JSON.stringify(menu).includes('dummy') && !JSON.stringify(menu).includes(MOCK), menu);
  const all = await gen(session().make('模型 全部'));
  check('「模型 全部」列出 22 项', all.text.includes('22 deep-model'), all.text);
  const current = await gen(session().make('当前模型'));
  check('「当前模型」返回默认与来源', current.text.includes('deepseek-v4.1-flash')
    && current.text.includes('内置默认'), current.text);
  const bareNumber = await gen(session().make('3'));
  check('没先要菜单时，单独一个数字不误切换', typeof bareNumber.text === 'string'
    && bareNumber.text.includes('离线模拟应答') && !bareNumber.text.includes('已切换到'), bareNumber.text);

  // 同一会话：出菜单 -> 回编号 -> 选择落盘 -> 新消息仍生效 -> 还原
  const s = session();
  const sMenu = await gen(s.make('模型'));
  const pick = await gen(s.make('3', { state: sMenu.state }));
  check('回编号 3 切换到 glm-5.3-flashx', pick.text.includes('glm-5.3-flashx')
    && pick.state.modelChoice === 'glm-5.3-flashx', pick);
  const savedFile = path.join(s.dir, 'model-choice.json');
  check('选择写入宿主官方插件数据目录', fs.existsSync(savedFile)
    && JSON.parse(fs.readFileSync(savedFile, 'utf8')).model === 'glm-5.3-flashx');
  check('选择文件只含模型 ID，不含 Key/聊天内容',
    !fs.readFileSync(savedFile, 'utf8').includes('dummy'));
  const persisted = await gen(s.make('在吗'));   // 新的一轮，state 为空
  check('之后的新消息仍用已保存的模型', persisted.text.includes('模型=glm-5.3-flashx'), persisted.text);
  const forced = await gen(s.make('在吗', { settings: settings({ model: 'glm-5.2' }) }));
  check('卡片设置 model 优先于菜单选择', forced.text.includes('模型=glm-5.2'), forced.text);
  const reset = await gen(s.make('恢复默认模型', { state: pick.state }));
  check('「恢复默认模型」清掉选择', reset.text.includes('内置默认')
    && !fs.existsSync(savedFile), reset.text);
  const afterReset = await gen(s.make('在吗'));
  check('还原后回到默认模型', afterReset.text.includes('模型=deepseek-v4.1-flash'), afterReset.text);

  // 10. v1.2.0：卡片不再有「手动运行」框，配置提示内置在插件里
  check('清单不再声明 tool.run（卡片无「手动运行」区域）',
    typeof plugin.run === 'undefined' && !Object.keys(plugin.hooks).includes('tool.run'));
  check('导出可复制的配置模板',
    plugin.configTemplate === '{"apiKey":"在这里粘贴你的 CodeBuddy API Key"}', plugin.configTemplate);
  const missing = await generate({}, { apiKey: '' });
  check('缺 Key 时给出可直接复制的 JSON 模板',
    typeof missing.text === 'string' && missing.text.includes(plugin.configTemplate), missing.text);
  check('缺 Key 提示包含「最省事改法」',
    missing.text.includes('最省事') && missing.text.includes('"apiKey":"'), missing.text);
  const placeholder = await generate({}, { apiKey: '在这里粘贴你的 CodeBuddy API Key' });
  check('框里还是示例文字时不会被当成真 Key 去调 CLI',
    typeof placeholder.text === 'string' && placeholder.text.includes('示例文字'), placeholder.text);
  check('readKey 支持常见别名', plugin.readKey({ key: 'ck_alias_value_1234567890' }) === 'ck_alias_value_1234567890');
  check('readKey 支持自定义键名下的 ck_ 值',
    plugin.readKey({ whatever: 'ck_custom_value_1234567890' }) === 'ck_custom_value_1234567890');
  check('readKey 拒绝占位文字',
    plugin.readKey({ apiKey: '在这里粘贴你的 CodeBuddy API Key' }) === '');
  const aliasOk = await generate({}, { apiKey: '', key: 'dummy' });
  check('用别名 key 也能正常生成',
    typeof aliasOk.text === 'string' && aliasOk.text.includes('离线模拟应答'), aliasOk.text);
  const bareKey = await plugin.hooks['chat.generate'](input({ settings: 'ck_bare_value_1234567890' }));
  check('settings 被误存成裸字符串时不崩且给出配置提示',
    typeof bareKey.text === 'string' && bareKey.text.includes(plugin.configTemplate), bareKey.text);

  for (const dir of DIRS) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } }

  console.log('\n' + passed + '/' + (passed + failed) + ' PASS');
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error('TEST RUNNER ERROR: ' + (error.stack || error.message));
  process.exitCode = 1;
});
