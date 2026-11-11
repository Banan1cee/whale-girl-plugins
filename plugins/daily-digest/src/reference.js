'use strict';

/**
 * 参考实现：把「消息汇总」的 Markdown 日报压成可直接粘贴的纯文本。
 *
 * 为什么要有它：WASM 版本是手写字节码，没有编译器兜底。
 * 这里用 JS 写一份语义完全相同的实现，测试里做「逐字节对比」，
 * 两边不一致就说明生成的字节码错了 —— 这是没有工具链时唯一可靠的验证手段。
 *
 * 规则：
 *   1. 行首的 # 系列 → 整行变成【标题】；
 *   2. 行首 "- " / "* " → "· "；
 *   3. 行内的 ** ** → 去掉；
 *   4. 连续空行压成一行，行尾多余空白去掉；
 *   5. 保证结尾只有一个换行。
 */

const OPEN = [0xe3, 0x80, 0x90];   // 【
const CLOSE = [0xe3, 0x80, 0x91];  // 】
const BULLET = [0xc2, 0xb7];       // ·

function transform(bytes) {
  const out = [];
  const put = (...v) => { for (const b of v) out.push(b); };
  const n = bytes.length;
  let i = 0;
  let lineStart = 1;
  let lastNewline = 1;
  let inHeading = 0;
  let skip = 0;

  while (i < n) {
    const b = bytes[i];
    const next = i + 1 < n ? bytes[i + 1] : -1;

    if (b === 10) {                                   // 换行
      if (inHeading) { put(...CLOSE); inHeading = 0; }
      if (!lastNewline) put(10);
      lastNewline = 1;
      lineStart = 1;
      skip = 0;
      i += 1;
      continue;
    }

    if (lineStart && b === 35) {                      // 行首 '#'
      if (!inHeading) { put(...OPEN); inHeading = 1; }
      skip = 1;
      i += 1;
      continue;
    }

    if (lineStart && b === 42) {                      // 行首 '*'
      if (next === 32) {
        put(...BULLET); put(32);
        i += 2;
        lineStart = 0;
        lastNewline = 0;
        continue;
      }
      skip = 0;
      i += 1;
      continue;
    }

    if (lineStart && b === 45 && next === 32) {       // 行首 '- '
      put(...BULLET); put(32);
      i += 2;
      lineStart = 0;
      lastNewline = 0;
      continue;
    }

    if (b === 42 && next === 42) {                    // 行内 '**'
      i += 2;
      continue;
    }

    if (lineStart && (b === 32 || b === 9)) {         // 行首缩进
      i += 1;
      continue;
    }

    if (b === 32 && skip) {                           // 标题后紧跟的空格
      i += 1;
      continue;
    }

    skip = 0;
    put(b);
    lineStart = 0;
    lastNewline = 0;
    i += 1;
  }

  if (inHeading) put(...CLOSE);
  if (!lastNewline) put(10);
  return Uint8Array.from(out);
}

module.exports = { transform, OPEN, CLOSE, BULLET };
