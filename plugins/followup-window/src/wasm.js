'use strict';

/**
 * 手写字节码生成 followup-window 的 plugin.wasm（Api 3 / Kind=message）。
 *
 * 本机没有 wasm 工具链，插件又必须是 WebAssembly，所以直接生成模块字节。
 * 逻辑与 src/reference.js 等价，test/run.js 里做逐字节差分。
 *
 * 模块形状（对齐 src/services/messagePlugins.js 的 WORKER）：
 *   导入 whale.input_size() -> i32 / input_byte(i32) -> i32 / output_byte(i32)
 *   导出 run() -> i32（0 = 成功）
 *   1 页线性内存：常量在数据段，字符串解码用 4 KiB 之后的缓冲区
 *
 * 输入是宿主 JSON.stringify 出来的定形对象，键名唯一，因此用「找键 + 取值」定位，
 * 不实现完整 JSON 解析器。
 */

const ACKS = ['好', '好的', '好滴', '好吧', '嗯', '嗯嗯', '哦', '行', '可以', '收到',
  '谢谢', '谢了', '哈哈', '哈哈哈', '哈', '666', '牛', '厉害', 'ok'];
const CUES = ['为啥', '为什么', '怎么', '咋', '啥意思', '什么意思', '然后', '还有',
  '继续', '不对', '不是', '所以', '帮我', '再来', '换个', '说说', '解释',
  '行不行', '可以吗', '能不能', '是不是', '对不对', '什么', '哪',
  '多少', '如何', '看看', '看下', '给我', '发我', '人呢', '在吗',
  '刚才', '刚刚', '你说', '你刚', '觉得', '认为', '咋办', '怎么办'];
const CONNECTIVES = ['然后', '还有', '所以', '可是', '但是', '不过', '对了', '不是'];
const QMARKS = ['?', '？', '吗', '呢', '吧'];
const VERBS = ['帮', '说', '看', '发', '来'];

const SENDER = 4096;
const TARGET = 4160;
const TEXT = 4224;
const BOTTEXT = 5000;
const DIGITS = 60000;

const TURNS = 3;
const WINDOW_MS = 180000;

const BLOCK = 0x02, LOOP = 0x03, IF = 0x04, ELSE = 0x05, END = 0x0B, BR = 0x0C, BR_IF = 0x0D, RET = 0x0F;
const CALL = 0x10, LOCAL_GET = 0x20, LOCAL_SET = 0x21, I32_CONST = 0x41, I64_CONST = 0x42;
const EQZ = 0x45, I32_EQ = 0x46, I32_NE = 0x47, I32_LT_S = 0x48, I32_GE_S = 0x4E, I32_LE_S = 0x4C, I32_GT_U = 0x4B, I32_GT_S = 0x4A;
const I32_ADD = 0x6A, I32_SUB = 0x6B, I32_MUL = 0x6C, I32_DIV_U = 0x6E, I32_REM_U = 0x70;
const I32_AND = 0x71, I32_OR = 0x72, LOAD8 = 0x2D, STORE8 = 0x3A;
const I64_ADD = 0x7C, I64_SUB = 0x7D, I64_MUL = 0x7E, I64_GT_S = 0x55, I64_EXT_U = 0xAD, I64_EQ = 0x51;

class E {
  constructor() { this.b = []; }
  u(...v) { for (const x of v) this.b.push(x & 0xff); return this; }
  uleb(n) { let v = n >>> 0; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; this.b.push(b); } while (v); return this; }
  sleb(n) {
    let v = n | 0; let more = true;
    while (more) {
      let b = v & 0x7f; v >>= 7;
      if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) more = false; else b |= 0x80;
      this.b.push(b);
    }
    return this;
  }
  c32(n) { this.b.push(I32_CONST); this.sleb(n); return this; }
  c64(n) { this.b.push(I64_CONST); this.sleb(n); return this; }
  l(i) { this.b.push(LOCAL_GET); this.uleb(i); return this; }
  set(i) { this.b.push(LOCAL_SET); this.uleb(i); return this; }
  call(i) { this.b.push(CALL); this.uleb(i); return this; }
  op(c) { this.b.push(c); return this; }
  load8() { this.u(LOAD8, 0, 0); return this; }
  store8() { this.u(STORE8, 0, 0); return this; }
  br(d) { this.u(BR); this.uleb(d); return this; }
  brIf(d) { this.u(BR_IF); this.uleb(d); return this; }
  ret() { this.u(RET); return this; }
  if_(then, els) { this.u(IF, 0x40); then(this); if (els) { this.u(ELSE); els(this); } this.u(END); return this; }
  block(fn) { this.u(BLOCK, 0x40); fn(this); this.u(END); return this; }
  loop(fn) { this.u(LOOP, 0x40); fn(this); this.u(END); return this; }
}

function pack() {
  const parts = [];
  let at = 0;
  const putTable = (list) => {
    const start = at;
    for (const item of list) {
      const bytes = Buffer.from(item, 'utf8');
      parts.push(bytes, Buffer.from([0]));
      at += bytes.length + 1;
    }
    parts.push(Buffer.from([0]));
    at += 1;
    return { ptr: start, len: at - start };
  };
  const putText = (text) => {
    const bytes = Buffer.from(text, 'utf8');
    const ptr = at;
    parts.push(bytes);
    at += bytes.length;
    return { ptr, len: bytes.length };
  };
  const T = {
    acks: putTable(ACKS),
    cues: putTable(CUES),
    connectives: putTable(CONNECTIVES),
    qmarks: putTable(QMARKS),
    verbs: putTable(VERBS),
    urls: putTable(['http://', 'https://', 'HTTP://', 'HTTPS://']),
  };
  const K = {
    sender: putText('"senderId":"'),
    target: putText('"targetId":"'),
    text: putText('"text":"'),
    atMe: putText('"atMe":true'),
    mentioned: putText('"mentionedNames":['),
    now: putText('"now":'),
    lastBot: putText('"lastBot":{'),
    at: putText('"at":'),
    left: putText('"left":'),
    interrupted: putText('"interrupted":true'),
    replyHook: putText('"hook":"chat.reply"'),
    message: putText('"message":{"'),
    you: putText('你'),
    nin: putText('您'),
  };
  return { data: Buffer.concat(parts), T, K };
}

// 3: eq(inputPos, ptr, len) -> i32
function fEq() {
  const e = new E();
  e.c32(0).set(3);
  e.block(b => b.loop(l => {
    l.l(3).l(2).op(I32_GE_S).brIf(1);
    l.l(0).l(3).op(I32_ADD).call(1);
    l.l(1).l(3).op(I32_ADD).load8();
    l.op(I32_NE).if_(t => t.c32(0).ret());
    l.l(3).c32(1).op(I32_ADD).set(3);
    l.br(0);
  }));
  e.c32(1);
  return e.b;
}

// 4: find(from, ptr, len) -> i32
function fFind() {
  const e = new E();
  e.l(0).set(3);
  e.block(b => b.loop(l => {
    l.l(3).l(2).op(I32_ADD).call(0).op(I32_GT_S).brIf(1);
    l.l(3).l(1).l(2).call(3);
    l.if_(t => t.l(3).ret());
    l.l(3).c32(1).op(I32_ADD).set(3);
    l.br(0);
  }));
  e.c32(-1);
  return e.b;
}

// 5: copy(inputPos, dst, max) -> i32
function fCopy() {
  const e = new E();
  const I = 3, OUT = 4, B = 5, STOP = 6;
  e.l(0).set(I);
  e.l(1).set(OUT);
  e.c32(0).set(STOP);
  e.block(b => b.loop(l => {
    l.l(STOP).brIf(1);
    l.l(OUT).l(1).op(I32_SUB).l(2).op(I32_GE_S).if_(t => t.c32(1).set(STOP));
    l.l(STOP).op(EQZ).if_(t => {
      t.l(I).call(1).set(B);
      t.l(B).c32(-1).op(I32_EQ).if_(u => u.c32(1).set(STOP));
    });
    l.l(STOP).op(EQZ).if_(t => {
      t.l(B).c32(92).op(I32_EQ).if_(u => {
        u.l(I).c32(1).op(I32_ADD).set(I);
        u.l(I).call(1).set(B);
        u.l(B).c32(-1).op(I32_EQ).if_(v => v.c32(1).set(STOP));
      });
    });
    l.l(STOP).op(EQZ).if_(t => {
      t.l(B).c32(34).op(I32_EQ).if_(u => u.c32(1).set(STOP));
    });
    l.l(STOP).op(EQZ).if_(t => {
      t.l(OUT).l(B).store8();
      t.l(OUT).c32(1).op(I32_ADD).set(OUT);
      t.l(I).c32(1).op(I32_ADD).set(I);
    });
    l.br(0);
  }));
  e.l(OUT).l(1).op(I32_SUB);
  return e.b;
}

// 6: eqAt(buf, pos, ptr, plen) -> i32
function fEqAt() {
  const e = new E();
  e.c32(0).set(4);
  e.block(b => b.loop(l => {
    l.l(4).l(3).op(I32_GE_S).brIf(1);
    l.l(0).l(1).op(I32_ADD).l(4).op(I32_ADD).load8();
    l.l(2).l(4).op(I32_ADD).load8();
    l.op(I32_NE).if_(t => t.c32(0).ret());
    l.l(4).c32(1).op(I32_ADD).set(4);
    l.br(0);
  }));
  e.c32(1);
  return e.b;
}

// 7: bufHas(buf, len, ptr, plen) -> i32
function fBufHas() {
  const e = new E();
  e.c32(0).set(4);
  e.block(b => b.loop(l => {
    l.l(4).l(3).op(I32_ADD).l(1).op(I32_GT_S).brIf(1);
    l.l(0).l(4).l(2).l(3).call(6);
    l.if_(t => t.c32(1).ret());
    l.l(4).c32(1).op(I32_ADD).set(4);
    l.br(0);
  }));
  e.c32(0);
  return e.b;
}

// 8: bufEqLower(buf, len, ptr, plen) -> i32
function fBufEqLower() {
  const e = new E();
  const I = 4, A = 5, B = 6;
  e.l(1).l(3).op(I32_NE).if_(t => t.c32(0).ret());
  e.c32(0).set(I);
  e.block(b => b.loop(l => {
    l.l(I).l(1).op(I32_GE_S).brIf(1);
    l.l(0).l(I).op(I32_ADD).load8().set(A);
    l.l(2).l(I).op(I32_ADD).load8().set(B);
    for (const reg of [A, B]) {
      l.l(reg).c32(65).op(I32_GE_S);
      l.l(reg).c32(90).op(I32_LE_S);
      l.op(I32_AND);
      l.if_(t => t.l(reg).c32(32).op(I32_ADD).set(reg));
    }
    l.l(A).l(B).op(I32_NE).if_(t => t.c32(0).ret());
    l.l(I).c32(1).op(I32_ADD).set(I);
    l.br(0);
  }));
  e.c32(1);
  return e.b;
}

// 9: tableHas(buf, len, table) -> i32
function fTableHas() {
  const e = new E();
  const P = 3, L = 4;
  e.l(2).set(P);
  e.block(b => b.loop(l => {
    l.l(P).load8().op(EQZ).if_(t => t.c32(0).ret());
    l.l(P).call(12).set(L);
    l.l(0).l(1).l(P).l(L).call(7).if_(t => t.c32(1).ret());
    l.l(P).l(L).op(I32_ADD).c32(1).op(I32_ADD).set(P);
    l.br(0);
  }));
  e.c32(0);
  return e.b;
}

// 10: tableEq(buf, len, table) -> i32
function fTableEq() {
  const e = new E();
  const P = 3, L = 4;
  e.l(2).set(P);
  e.block(b => b.loop(l => {
    l.l(P).load8().op(EQZ).if_(t => t.c32(0).ret());
    l.l(P).call(12).set(L);
    l.l(L).l(1).op(I32_EQ).if_(t => {
      t.l(0).l(1).l(P).l(L).call(8);
      t.if_(u => u.c32(1).ret());
    });
    l.l(P).l(L).op(I32_ADD).c32(1).op(I32_ADD).set(P);
    l.br(0);
  }));
  e.c32(0);
  return e.b;
}

// 11: tableStarts(buf, len, table) -> i32
function fTableStarts() {
  const e = new E();
  const P = 3, L = 4;
  e.l(2).set(P);
  e.block(b => b.loop(l => {
    l.l(P).load8().op(EQZ).if_(t => t.c32(0).ret());
    l.l(P).call(12).set(L);
    l.l(0).c32(0).l(P).l(L).call(6).if_(t => t.c32(1).ret());
    l.l(P).l(L).op(I32_ADD).c32(1).op(I32_ADD).set(P);
    l.br(0);
  }));
  e.c32(0);
  return e.b;
}

// 12: strlen(ptr) -> i32
function fStrlen() {
  const e = new E();
  e.l(0).set(1);
  e.block(b => b.loop(l => {
    l.l(1).load8().op(EQZ).if_(t => t.l(1).l(0).op(I32_SUB).ret());
    l.l(1).c32(1).op(I32_ADD).set(1);
    l.br(0);
  }));
  e.c32(0);
  return e.b;
}

// 13: skipSpaces(pos) -> i32
function fSkipSpaces() {
  const e = new E();
  e.l(0).set(1);
  e.block(b => b.loop(l => {
    l.l(1).call(1).c32(32).op(I32_EQ).op(EQZ).brIf(1);
    l.l(1).c32(1).op(I32_ADD).set(1);
    l.br(0);
  }));
  e.l(1);
  return e.b;
}

// 14: num32(pos) -> i32
function fNum32() {
  const e = new E();
  e.l(0).set(1);
  e.c32(0).set(2);
  e.block(b => b.loop(l => {
    l.l(1).call(1).c32(48).op(I32_SUB).set(3);
    l.l(3).c32(9).op(I32_GT_U).brIf(1);
    l.l(2).c32(10).op(I32_MUL).l(3).op(I32_ADD).set(2);
    l.l(1).c32(1).op(I32_ADD).set(1);
    l.br(0);
  }));
  e.l(2);
  return e.b;
}

// 15: num64(pos) -> i64（locals: 1 i32 pos, 2 i32 digit, 3 i64 acc）
function fNum64() {
  const e = new E();
  e.l(0).set(1);
  e.c64(0).set(3);
  e.block(b => b.loop(l => {
    l.l(1).call(1).c32(48).op(I32_SUB).set(2);
    l.l(2).c32(9).op(I32_GT_U).brIf(1);
    l.l(3).c64(10).op(I64_MUL).l(2).op(I64_EXT_U).op(I64_ADD).set(3);
    l.l(1).c32(1).op(I32_ADD).set(1);
    l.br(0);
  }));
  e.l(3);
  return e.b;
}

// 16: emitNum(n)
function fEmitNum() {
  const e = new E();
  const I = 1, D = 2;
  e.l(0).op(EQZ).if_(t => { t.c32(48).call(2).ret(); });
  e.c32(0).set(I);
  e.block(b => b.loop(l => {
    l.l(0).c32(10).op(I32_REM_U).set(D);
    l.c32(DIGITS).l(I).op(I32_ADD).l(D).c32(48).op(I32_ADD).store8();
    l.l(I).c32(1).op(I32_ADD).set(I);
    l.l(0).c32(10).op(I32_DIV_U).set(0);
    l.l(0).brIf(0);
  }));
  e.block(b => b.loop(l => {
    l.l(I).op(EQZ).brIf(1);
    l.l(I).c32(1).op(I32_SUB).set(I);
    l.c32(DIGITS).l(I).op(I32_ADD).load8().call(2);
    l.br(0);
  }));
  return e.b;
}

function emitStr(e, text) { for (const b of Buffer.from(text, 'utf8')) e.c32(b).call(2); }
function passPlain(e) { emitStr(e, '{"action":"pass"}'); e.c32(0).ret(); }
function passConst(e, left, interrupted) {
  emitStr(e, '{"action":"pass","state":{"left":' + left + ',"interrupted":' + interrupted + '}}');
  e.c32(0).ret();
}
function passLocal(e, leftLocal, interrupted) {
  emitStr(e, '{"action":"pass","state":{"left":');
  e.l(leftLocal).call(16);
  emitStr(e, ',"interrupted":' + interrupted + '}}');
  e.c32(0).ret();
}
function wakeLocal(e, leftLocal) {
  emitStr(e, '{"action":"wake","state":{"left":');
  e.l(leftLocal).c32(1).op(I32_SUB).call(16);
  emitStr(e, ',"interrupted":false}}');
  e.c32(0).ret();
}
function replyState(e) {
  emitStr(e, '{"state":{"left":3,"interrupted":false}}');
  e.c32(0).ret();
}

// 17: run()
function fRun(K, T) {
  const e = new E();
  const N = 0, P = 1, LB = 2, SLEN = 3, TLEN = 4, XLEN = 5, BLEN = 6,
    ATME = 7, MSG = 8, INTR = 9, LEFT = 10, TMP = 11, H = 12;
  const NOW = 13, AT = 14, DIFF = 15;

  // 从常量 0 开始找；另有一个从局部变量开始找的版本
  const find0 = (key) => { e.c32(0).c32(key.ptr).c32(key.len).call(4); };
  const findFrom = (local, key) => { e.l(local).c32(key.ptr).c32(key.len).call(4); };

  // chat.reply：重开窗口
  find0(K.replyHook);
  e.c32(-1).op(I32_NE).if_(t => replyState(t));

  e.call(0).set(N);

  // message 对象：字段都从它内部取，避免 lastBot 里的同名字段被先命中
  find0(K.message);
  e.set(MSG);
  e.l(MSG).c32(-1).op(I32_EQ).if_(t => passPlain(t));

  // state.left
  e.c32(0).set(LEFT);
  find0(K.left);
  e.set(P);
  e.l(P).c32(-1).op(I32_NE).if_(t => {
    t.l(P).c32(K.left.len).op(I32_ADD).call(14).set(LEFT);
  });

  // state.interrupted
  find0(K.interrupted);
  e.c32(-1).op(I32_NE).set(INTR);

  // atMe
  findFrom(MSG, K.atMe);
  e.c32(-1).op(I32_NE).set(ATME);

  // lastBot
  find0(K.lastBot);
  e.set(LB);
  e.l(LB).c32(-1).op(I32_EQ).if_(t => passPlain(t));

  // 被明确叫到：重置窗口
  e.l(ATME).if_(t => passConst(t, TURNS, 'false'));

  // targetId
  findFrom(LB, K.target);
  e.set(P);
  e.l(P).c32(-1).op(I32_EQ).if_(t => passPlain(t));
  e.l(P).c32(K.target.len).op(I32_ADD).c32(TARGET).c32(64).call(5).set(TLEN);

  // senderId
  findFrom(MSG, K.sender);
  e.set(P);
  e.l(P).c32(-1).op(I32_EQ).if_(t => passPlain(t));
  e.l(P).c32(K.sender.len).op(I32_ADD).c32(SENDER).c32(64).call(5).set(SLEN);

  // 别人插话 → 收口
  e.l(SLEN).l(TLEN).op(I32_NE).if_(t => passLocal(t, LEFT, 'true'));
  e.c32(SENDER).c32(0).c32(TARGET).l(TLEN).call(6).op(EQZ)
    .if_(t => passLocal(t, LEFT, 'true'));

  // 已收口 / 额度用完
  e.l(INTR).if_(t => passPlain(t));
  e.l(LEFT).c32(1).op(I32_GE_S).op(EQZ).if_(t => passPlain(t));

  // 窗口过期
  e.c64(0).set(NOW);
  find0(K.now);
  e.set(P);
  e.l(P).c32(-1).op(I32_NE).if_(t => {
    t.l(P).c32(K.now.len).op(I32_ADD).call(15).set(NOW);
  });
  findFrom(LB, K.at);
  e.set(P);
  e.l(P).c32(-1).op(I32_EQ).if_(t => passPlain(t));
  e.l(P).c32(K.at.len).op(I32_ADD).call(15).set(AT);
  e.l(AT).c64(0).op(I64_EQ).if_(t => passPlain(t));
  e.l(NOW).l(AT).op(I64_SUB).set(DIFF);
  e.l(DIFF).c64(WINDOW_MS).op(I64_GT_S).if_(t => passPlain(t));

  // 在叫别人 → 收口
  findFrom(MSG, K.mentioned);
  e.set(P);
  e.l(P).c32(-1).op(I32_NE).if_(t => {
    t.l(P).c32(K.mentioned.len).op(I32_ADD).call(13).call(1).c32(93).op(I32_EQ).op(EQZ)
      .if_(u => passLocal(u, LEFT, 'true'));
  });

  // 正文
  findFrom(MSG, K.text);
  e.set(P);
  e.l(P).c32(-1).op(I32_EQ).if_(t => passPlain(t));
  e.l(P).c32(K.text.len).op(I32_ADD).c32(TEXT).c32(901).call(5).set(XLEN);
  e.l(XLEN).op(EQZ).if_(t => passPlain(t));
  e.l(XLEN).c32(901).op(I32_GE_S).if_(t => passPlain(t));

  // 链接不接（原逻辑排在捧场之前）
  e.c32(TEXT).l(XLEN).c32(T.urls.ptr).call(11).if_(t => passPlain(t));

  // 纯捧场
  e.c32(TEXT).l(XLEN).c32(T.acks.ptr).call(10).if_(t => passPlain(t));

  // 她上一句是不是问句
  e.c32(0).set(BLEN);
  findFrom(LB, K.text);
  e.set(P);
  e.l(P).c32(-1).op(I32_NE).if_(t => {
    t.l(P).c32(K.text.len).op(I32_ADD).c32(BOTTEXT).c32(900).call(5).set(BLEN);
  });
  e.c32(0).set(TMP);
  e.l(BLEN).c32(1).op(I32_GE_S).if_(t => {
    t.c32(BOTTEXT).l(BLEN).op(I32_ADD).c32(1).op(I32_SUB).load8().c32(63).op(I32_EQ)
      .if_(u => u.c32(1).set(TMP));
  });
  e.l(BLEN).c32(3).op(I32_GE_S).if_(t => {
    t.c32(BOTTEXT).l(BLEN).op(I32_ADD).c32(3).op(I32_SUB).load8().c32(0xEF).op(I32_EQ);
    t.c32(BOTTEXT).l(BLEN).op(I32_ADD).c32(2).op(I32_SUB).load8().c32(0xBC).op(I32_EQ).op(I32_AND);
    t.c32(BOTTEXT).l(BLEN).op(I32_ADD).c32(1).op(I32_SUB).load8().c32(0x9F).op(I32_EQ).op(I32_AND);
    t.if_(u => u.c32(1).set(TMP));
  });
  // 她问了问号 且 对方短句 → 接
  e.l(TMP).l(XLEN).c32(240).op(I32_LE_S).op(I32_AND)
    .if_(t => wakeLocal(t, LEFT));

  // 追问线索
  e.c32(TEXT).l(XLEN).c32(T.cues.ptr).call(9).if_(t => wakeLocal(t, LEFT));

  // 「你/您」+ 问句或请求动词
  e.c32(TEXT).l(XLEN).c32(K.you.ptr).c32(K.you.len).call(7);
  e.c32(TEXT).l(XLEN).c32(K.nin.ptr).c32(K.nin.len).call(7).op(I32_OR).set(H);
  e.l(H).if_(t => {
    t.c32(TEXT).l(XLEN).c32(T.qmarks.ptr).call(9);
    t.c32(TEXT).l(XLEN).c32(T.verbs.ptr).call(9).op(I32_OR);
    t.if_(u => wakeLocal(u, LEFT));
  });

  // 句首连接词
  e.c32(TEXT).l(XLEN).c32(T.connectives.ptr).call(11).if_(t => wakeLocal(t, LEFT));

  passPlain(e);
  return e.b;
}

function vec(items) {
  const out = [];
  const uleb = (n) => { let v = n >>> 0; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); };
  uleb(items.length);
  for (const item of items) out.push(...item);
  return out;
}
function str(text) { const b = [...Buffer.from(text, 'utf8')]; return [b.length, ...b]; }
function section(id, payload) {
  const out = [id];
  let v = payload.length;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  out.push(...payload);
  return out;
}

function build() {
  const { data, T, K } = pack();
  const bodies = [
    fEq(), fFind(), fCopy(), fEqAt(), fBufHas(), fBufEqLower(), fTableHas(), fTableEq(),
    fTableStarts(), fStrlen(), fSkipSpaces(), fNum32(), fNum64(), fEmitNum(), fRun(K, T),
  ];
  const types = [
    [0x60, 0x00, 0x01, 0x7f],                            // 0 () -> i32
    [0x60, 0x01, 0x7f, 0x01, 0x7f],                      // 1 (i32) -> i32
    [0x60, 0x01, 0x7f, 0x00],                            // 2 (i32) -> ()
    [0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x01, 0x7f],          // 3 (i32,i32,i32) -> i32
    [0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f],    // 4 (i32 x4) -> i32
    [0x60, 0x01, 0x7f, 0x01, 0x7e],                      // 5 (i32) -> i64
  ];
  const funcTypes = [3, 3, 3, 4, 4, 4, 3, 3, 3, 1, 1, 1, 5, 2, 0];
  const imports = [
    [...str('whale'), ...str('input_size'), 0x00, 0x00],
    [...str('whale'), ...str('input_byte'), 0x00, 0x01],
    [...str('whale'), ...str('output_byte'), 0x00, 0x02],
  ];
  // 局部声明：vec( (count, type) ... )
  const locals = [
    [0x01, 0x01, 0x7f],                                  // 3  i
    [0x01, 0x01, 0x7f],                                  // 4  pos
    [0x01, 0x04, 0x7f],                                  // 5  i,out,b,stop
    [0x01, 0x01, 0x7f],                                  // 6  i
    [0x01, 0x01, 0x7f],                                  // 7  i
    [0x01, 0x03, 0x7f],                                  // 8  i,a,b
    [0x01, 0x02, 0x7f],                                  // 9  p,l
    [0x01, 0x02, 0x7f],                                  // 10 p,l
    [0x01, 0x02, 0x7f],                                  // 11 p,l
    [0x01, 0x01, 0x7f],                                  // 12 p
    [0x01, 0x01, 0x7f],                                  // 13 p
    [0x01, 0x03, 0x7f],                                  // 14 i,v,d
    [0x02, 0x02, 0x7f, 0x01, 0x7e],                      // 15 i,d + i64 acc
    [0x01, 0x02, 0x7f],                                  // 16 i,d
    [0x02, 0x0d, 0x7f, 0x03, 0x7e],                      // 17 run: 13 i32 + 3 i64
  ];

  const codeVec = bodies.map((body, i) => {
    const full = [...locals[i], ...body, 0x0b];
    let n = full.length;
    const size = [];
    do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; size.push(b); } while (n);
    return [...size, ...full];
  });

  const dataSegment = [0x00, 0x41, 0x00, 0x0b, ...(() => {
    let n = data.length; const out = [];
    do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
    return out;
  })(), ...data];

  const module = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(0x01, vec(types)),
    ...section(0x02, vec(imports)),
    ...section(0x03, vec(funcTypes.map((t) => [t]))),
    ...section(0x05, vec([[0x01, 0x01, 0x01]])),
    ...section(0x07, vec([[...str('run'), 0x00, 0x11]])),
    ...section(0x0a, vec(codeVec)),
    ...section(0x0b, vec([dataSegment])),
  ];
  return Buffer.from(module);
}

function run(wasmBytes, inputBytes) {
  const out = [];
  const imports = {
    input_size: () => inputBytes.length,
    input_byte: (i) => (i >= 0 && i < inputBytes.length ? inputBytes[i] : -1),
    output_byte: (v) => { out.push(v & 0xff); },
  };
  const module = new WebAssembly.Module(wasmBytes);
  const instance = new WebAssembly.Instance(module, { whale: imports });
  if (instance.exports.run() !== 0) throw new Error('run 返回非 0');
  return Buffer.from(out);
}

module.exports = { build, run };
