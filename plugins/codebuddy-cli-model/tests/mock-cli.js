'use strict';
/**
 * Offline fake CodeBuddy CLI used by the tests.
 *
 * It is spawned exactly like the real CLI (node <entry> -p <prompt> --output-format
 * json ... --model <id>), but never touches the network and needs no API key.
 * Behaviour is selected with --model so it also works inside the host's isolated
 * worker process, whose environment variables are stripped by design.
 */
const args = process.argv.slice(2);

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? String(args[index + 1] || '') : '';
}

const model = valueOf('--model') || 'deepseek-v4.1-flash';
const prompt = valueOf('-p');
const system = valueOf('--system-prompt');

function emit(text) {
  process.stdout.write(JSON.stringify([{ type: 'result', result: text }], null, 2));
}

switch (model) {
  case 'mock:echo':
    emit('SYS=' + system.slice(0, 120) + ' | PROMPT=' + prompt.slice(0, 200));
    break;
  case 'mock:unsafe':
    emit('@所有人\u0001你\u0007好');
    break;
  case 'mock:auth':
    process.stderr.write('Authentication required\n');
    process.exit(1);
    break;
  case 'mock:fail':
    process.stderr.write('simulated failure\n');
    process.exit(2);
    break;
  case 'mock:empty':
    process.stdout.write('[]');
    break;
  case 'mock:sleep':
    setTimeout(() => emit('too late'), 5000);
    break;
  default:
    // 把实际收到的 --model 回显出来，测试就能断言默认/编号/别名最终落到哪个 ID。
    emit('咕噜～（离线模拟应答）｜模型=' + model);
    break;
}
