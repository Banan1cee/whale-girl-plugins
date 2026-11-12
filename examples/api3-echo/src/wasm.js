'use strict';

/**
 * 最小 Api 3 插件模板的 Wasm 生成器。
 *
 * 它只做一件事：run() 里把一段固定 JSON 逐字节通过 whale.output_byte 吐出去。
 * 想改成自己的插件，改 DEFAULT_RESPONSE 就够了；要真正读输入，参考
 * plugins/followup-window/src/wasm.js（同样是手写字节码，含 JSON 解析）。
 *
 * 为什么要手写字节码：不是每个作者都装了 clang / wat2wasm / Rust。
 * 这个模板只需要 Node，`node src/build.js` 就能产出合法的 plugin.wasm。
 *
 * 宿主契约（和启动器的 Runner 一致）：
 *   导入 whale.output_byte(v: i32) -> ()
 *   导出 run() -> i32，返回 0 表示成功
 */

const DEFAULT_RESPONSE = '{"action":"pass"}';

function uleb(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

/** 有符号 LEB128，i32.const 用。 */
function sleb(n) {
  const out = [];
  let v = n | 0;
  let more = true;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) more = false;
    else byte |= 0x80;
    out.push(byte);
  }
  return out;
}

function section(id, payload) {
  return [id, ...uleb(payload.length), ...payload];
}

function str(text) {
  const bytes = Buffer.from(text, 'utf8');
  return [...uleb(bytes.length), ...bytes];
}

/** 把一段 JSON 文本编译成「逐字节 output_byte」的函数体。 */
function build(response = DEFAULT_RESPONSE) {
  const payload = Buffer.from(response, 'utf8');
  const body = [0x00];                          // 0 个局部变量
  for (const byte of payload) {
    body.push(0x41, ...sleb(byte));             // i32.const <byte>
    body.push(0x10, 0x00);                      // call output_byte（唯一导入，下标 0）
  }
  body.push(0x41, 0x00, 0x0b);                  // i32.const 0; end

  const typeSection = [
    ...uleb(2),
    0x60, 0x01, 0x7f, 0x00,                     // (i32) -> ()   output_byte
    0x60, 0x00, 0x01, 0x7f,                     // () -> i32     run
  ];
  const importSection = [
    ...uleb(1),
    ...str('whale'), ...str('output_byte'), 0x00, 0x00,
  ];
  const funcSection = [...uleb(1), 0x01];       // 一个函数，类型 1
  const exportSection = [...uleb(1), ...str('run'), 0x00, 0x01];
  const codeSection = [...uleb(1), ...uleb(body.length), ...body];

  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(0x01, typeSection),
    ...section(0x02, importSection),
    ...section(0x03, funcSection),
    ...section(0x07, exportSection),
    ...section(0x0a, codeSection),
  ]);
}

/** 用宿主同款导入在 Node 里跑一遍，返回插件输出的文本。 */
function run(wasmBytes) {
  const output = [];
  const imports = {
    output_byte: (value) => {
      if (value < 0 || value > 255) throw new Error('输出的不是字节：' + value);
      output.push(value);
      return 0;
    },
  };
  const module = new WebAssembly.Module(wasmBytes);
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== 'whale' || !(imp.name in imports)) {
      throw new Error(`插件请求了未开放的接口：${imp.module}.${imp.name}`);
    }
  }
  const instance = new WebAssembly.Instance(module, { whale: imports });
  const value = instance.exports.run();
  if (value !== 0) throw new Error('run() 返回了 ' + value + '，应返回 0');
  return Buffer.from(output).toString('utf8');
}

module.exports = { build, run, DEFAULT_RESPONSE };
