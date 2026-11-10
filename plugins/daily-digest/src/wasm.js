'use strict';

/**
 * 用手写字节码的方式产出 plugin.wasm。
 *
 * 为什么不用工具链：本机没有 clang / wat2wasm / npm，插件又是必须的 WebAssembly。
 * 这个模块只做两件事：生成模块字节、用宿主同款导入在 Node 里跑一遍验证。
 * 逻辑必须和 src/reference.js 逐字节一致 —— 测试会对比两边。
 *
 * 模块形状（和 launcher/PluginMarket.cs 里的 Runner 对齐）：
 *   导入 whale.input_size() -> i32
 *        whale.input_byte(i: i32) -> i32
 *        whale.output_byte(v: i32) -> i32
 *   导出 run() -> i32     返回 0 表示成功，输出即 output_byte 收集到的字节
 *   不使用线性内存（不需要 memory 段）
 */

const OPEN = [0xe3, 0x80, 0x90];
const CLOSE = [0xe3, 0x80, 0x91];
const BULLET = [0xc2, 0xb7];

// 操作码
const EQ = 0x46;
const EQZ = 0x45;
const LT_S = 0x48;
const GE_S = 0x4e;
const ADD = 0x6a;
const AND = 0x71;
const OR = 0x72;

// 局部变量
const I = 0;
const N = 1;
const B = 2;
const NEXT = 3;
const LS = 4;
const LN = 5;
const HEAD = 6;
const SKIP = 7;

// 导入函数下标
const IN_SIZE = 0;
const IN_BYTE = 1;
const OUT = 2;

class Emitter {
  constructor() { this.b = []; }

  u8(...v) { for (const x of v) this.b.push(x & 0xff); return this; }

  uleb(n) {
    let v = n >>> 0;
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v) byte |= 0x80;
      this.b.push(byte);
    } while (v);
    return this;
  }

  sleb(n) {
    let v = n | 0;
    let more = true;
    while (more) {
      let byte = v & 0x7f;
      v >>= 7;
      if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) more = false;
      else byte |= 0x80;
      this.b.push(byte);
    }
    return this;
  }

  i32(n) { this.b.push(0x41); this.sleb(n); return this; }
  get(i) { this.b.push(0x20); this.uleb(i); return this; }
  set(i) { this.b.push(0x21); this.uleb(i); return this; }
  call(i) { this.b.push(0x10); this.uleb(i); return this; }
  op(c) { this.b.push(c); return this; }

  /** cond 把 i32 留在栈上；then/else 各自追加指令 */
  ifThenElse(cond, then, els) {
    cond(this);
    this.u8(0x04, 0x40);
    then(this);
    if (els) { this.u8(0x05); els(this); }
    this.u8(0x0b);
    return this;
  }
}

function emitByte(e, value) {
  e.i32(value);
  e.call(OUT);
}

function emitConst(e, bytes) {
  for (const b of bytes) emitByte(e, b);
}

/** if / else if / ... / else 链；每段只负责把条件压栈和追加指令 */
function chain(e, cases, fallback) {
  const go = (k) => {
    if (k === cases.length) { fallback(e); return; }
    cases[k].cond(e);
    e.u8(0x04, 0x40);
    cases[k].then(e);
    e.u8(0x05);
    go(k + 1);
    e.u8(0x0b);
  };
  go(0);
}

function emitBody(e) {
  e.call(IN_SIZE); e.set(N);
  e.i32(0); e.set(I);
  e.i32(1); e.set(LS);
  e.i32(1); e.set(LN);
  e.i32(0); e.set(HEAD);
  e.i32(0); e.set(SKIP);

  e.u8(0x02, 0x40);                       // block（用于 break）
  e.u8(0x03, 0x40);                       // loop
  e.get(I); e.get(N); e.op(GE_S);
  e.u8(0x0d); e.uleb(1);                  // i >= n → br 1 跳出 block

  e.get(I); e.call(IN_BYTE); e.set(B);
  e.get(I); e.i32(1); e.op(ADD); e.call(IN_BYTE); e.set(NEXT);

  chain(e, [
    {
      cond: (e) => { e.get(B); e.i32(10); e.op(EQ); },
      then: (e) => {
        e.ifThenElse((e) => e.get(HEAD), (e) => { emitConst(e, CLOSE); e.i32(0); e.set(HEAD); });
        e.ifThenElse((e) => { e.get(LN); e.op(EQZ); }, (e) => emitByte(e, 10));
        e.i32(1); e.set(LN);
        e.i32(1); e.set(LS);
        e.i32(0); e.set(SKIP);
        e.get(I); e.i32(1); e.op(ADD); e.set(I);
      },
    },
    {
      cond: (e) => { e.get(LS); e.get(B); e.i32(35); e.op(EQ); e.op(AND); },
      then: (e) => {
        e.ifThenElse((e) => { e.get(HEAD); e.op(EQZ); }, (e) => { emitConst(e, OPEN); e.i32(1); e.set(HEAD); });
        e.i32(1); e.set(SKIP);
        e.get(I); e.i32(1); e.op(ADD); e.set(I);
      },
    },
    {
      cond: (e) => { e.get(LS); e.get(B); e.i32(42); e.op(EQ); e.op(AND); },
      then: (e) => {
        e.ifThenElse((e) => { e.get(NEXT); e.i32(32); e.op(EQ); }, (e) => {
          emitConst(e, BULLET); emitByte(e, 32);
          e.get(I); e.i32(2); e.op(ADD); e.set(I);
          e.i32(0); e.set(LS);
          e.i32(0); e.set(LN);
        }, (e) => {
          e.i32(0); e.set(SKIP);
          e.get(I); e.i32(1); e.op(ADD); e.set(I);
        });
      },
    },
    {
      cond: (e) => {
        e.get(LS); e.get(B); e.i32(45); e.op(EQ); e.op(AND);
        e.get(NEXT); e.i32(32); e.op(EQ); e.op(AND);
      },
      then: (e) => {
        emitConst(e, BULLET); emitByte(e, 32);
        e.get(I); e.i32(2); e.op(ADD); e.set(I);
        e.i32(0); e.set(LS);
        e.i32(0); e.set(LN);
      },
    },
    {
      cond: (e) => {
        e.get(B); e.i32(42); e.op(EQ);
        e.get(NEXT); e.i32(42); e.op(EQ);
        e.op(AND);
      },
      then: (e) => { e.get(I); e.i32(2); e.op(ADD); e.set(I); },
    },
    {
      cond: (e) => {
        e.get(LS);
        e.get(B); e.i32(32); e.op(EQ);
        e.get(B); e.i32(9); e.op(EQ);
        e.op(OR);
        e.op(AND);
      },
      then: (e) => { e.get(I); e.i32(1); e.op(ADD); e.set(I); },
    },
    {
      cond: (e) => { e.get(B); e.i32(32); e.op(EQ); e.get(SKIP); e.op(AND); },
      then: (e) => { e.get(I); e.i32(1); e.op(ADD); e.set(I); },
    },
  ], (e) => {
    e.i32(0); e.set(SKIP);
    e.get(B); e.call(OUT);
    e.i32(0); e.set(LS);
    e.i32(0); e.set(LN);
    e.get(I); e.i32(1); e.op(ADD); e.set(I);
  });

  e.u8(0x0c); e.uleb(0);                  // br 0 → 下一轮
  e.u8(0x0b);                             // end loop
  e.u8(0x0b);                             // end block

  e.ifThenElse((e) => e.get(HEAD), (e) => { emitConst(e, CLOSE); e.i32(0); e.set(HEAD); });
  e.ifThenElse((e) => { e.get(LN); e.op(EQZ); }, (e) => emitByte(e, 10));
  e.i32(0);                               // run() 返回 0
}

function vec(list) {
  const out = [];
  const push = (n) => {
    let v = n >>> 0;
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  };
  push(list.length);
  for (const item of list) out.push(...item);
  return out;
}

function str(text) {
  const bytes = Buffer.from(text, 'utf8');
  return [bytes.length, ...bytes];
}

function section(id, payload) {
  const out = [id];
  let v = payload.length;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  out.push(...payload);
  return out;
}

function build() {
  const e = new Emitter();
  emitBody(e);

  const typeSection = vec([
    [0x60, 0x00, 0x01, 0x7f],             // () -> i32
    [0x60, 0x01, 0x7f, 0x01, 0x7f],       // (i32) -> i32
    [0x60, 0x01, 0x7f, 0x00],             // (i32) -> ()   output_byte 不要返回值，免得栈上留垃圾
  ]);
  const importSection = vec([
    [...str('whale'), ...str('input_size'), 0x00, 0x00],
    [...str('whale'), ...str('input_byte'), 0x00, 0x01],
    [...str('whale'), ...str('output_byte'), 0x00, 0x02],
  ]);
  const funcSection = vec([[0x00]]);       // 一个函数，类型 0
  const exportSection = vec([[...str('run'), 0x00, 0x03]]);

  const locals = [0x01, 0x08, 0x7f];       // 1 组、8 个 i32
  const body = [...locals, ...e.b, 0x0b];
  const bodyVec = [];
  let v = body.length;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; bodyVec.push(b); } while (v);
  const codeSection = vec([[...bodyVec, ...body]]);

  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(0x01, typeSection),
    ...section(0x02, importSection),
    ...section(0x03, funcSection),
    ...section(0x07, exportSection),
    ...section(0x0a, codeSection),
  ];
  return Buffer.from(bytes);
}

/**
 * 按启动器 Runner 的契约跑一遍：同样的导入、同样的 0 表示成功、同样的 64 KiB 上限。
 * 返回输出字节；任何不合约的地方直接抛错。
 */
function run(wasmBytes, inputBytes) {
  const output = [];
  const imports = {
    input_size: () => inputBytes.length,
    input_byte: (i) => (i < 0 || i >= inputBytes.length ? -1 : inputBytes[i]),
    output_byte: (value) => {
      if (output.length >= 65536) throw new Error('输出超过 64 KiB');
      if (value < 0 || value > 255) throw new Error('输出的不是字节：' + value);
      output.push(value);
      return 0;
    },
  };

  const module = new WebAssembly.Module(wasmBytes);
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== 'whale' || imp.kind !== 'function' || !(imp.name in imports)) {
      throw new Error(`插件请求了未开放的接口：${imp.module}.${imp.name}`);
    }
  }
  const instance = new WebAssembly.Instance(module, { whale: imports });
  const value = instance.exports.run();
  if (value !== 0) throw new Error('run() 返回了 ' + value + '，应返回 0');
  return Uint8Array.from(output);
}

module.exports = { build, run };
