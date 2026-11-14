/**
 * 上下文便签 v1.1.1 · Api 3 消息插件
 *
 * 宿主只给 1 MiB 的 wasm 内存（--wasm-max-mem-pages=16），所以整个过程不逐字符拼字符串：
 * 一律按「引号位置 + substring」切片，避免几千次中间分配把内存撑爆。
 *
 * 只使用宿主开放的三条导入：input_size / input_byte / output_byte。
 */

@external("whale", "input_size")
declare function input_size(): i32;

@external("whale", "input_byte")
declare function input_byte(index: i32): i32;

@external("whale", "output_byte")
declare function output_byte(value: i32): void;

const MAX_SYSTEM: i32 = 15000;
const CLIP: i32 = 36;
const HIST_CLIP: i32 = 80;
const MAX_PART: i32 = 220;

/**
 * 宿主只放行 whale.* 三条导入，所以把 AssemblyScript 默认的 env.abort 换成内部实现。
 * 编译时用 `--use abort=src/index/abortImpl`；正常路径走不到这里。
 */
export function abortImpl(message: string, fileName: string, lineNumber: u32, columnNumber: u32): void {
  unreachable();
}

function readInput(): string {
  const size = input_size();
  if (size <= 0) return "";
  const buffer = new Uint8Array(size);
  for (let i = 0; i < size; i++) buffer[i] = <u8>(input_byte(i) & 0xff);
  return String.UTF8.decode(buffer.buffer, false);
}

function emit(text: string): void {
  const bytes = Uint8Array.wrap(String.UTF8.encode(text, false));
  for (let i = 0; i < bytes.length; i++) output_byte(bytes[i]);
}

/** 从开引号往后找配对的闭引号，跳过 \x 转义。返回闭引号下标（找不到就返回末尾）。 */
function scanStringEnd(src: string, quotePos: i32): i32 {
  let i = quotePos + 1;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c == 92) {
      i += 2;
      continue;
    }
    if (c == 34) return i;
    i++;
  }
  return src.length;
}

/** key 的开引号之后，值的开引号位置；值不是字符串返回 -1。 */
function valueQuote(src: string, keyStart: i32): i32 {
  const colon = src.indexOf(":", keyStart);
  if (colon < 0) return -1;
  let i = colon + 1;
  while (i < src.length && src.charCodeAt(i) == 32) i++;
  if (i >= src.length || src.charCodeAt(i) != 34) return -1;
  return i;
}

/** 找 key 之后的字符串值。 */
function stringValue(src: string, key: string): string {
  const k = src.indexOf(key);
  if (k < 0) return "";
  const q = valueQuote(src, k);
  if (q < 0) return "";
  return src.substring(q + 1, scanStringEnd(src, q));
}

/** 找 key 之后的数字；找不到或不是数字返回 -1。 */
function numberValue(src: string, key: string): f64 {
  const k = src.indexOf(key);
  if (k < 0) return -1;
  return numberAfterKey(src, k);
}

/** 从 key 的引号处跳到冒号，再读整数部分。 */
function numberAfterKey(src: string, keyStart: i32): f64 {
  const colon = src.indexOf(":", keyStart);
  if (colon < 0) return -1;
  let i = colon + 1;
  while (i < src.length && src.charCodeAt(i) == 32) i++;
  let value: f64 = 0;
  let digits = 0;
  let negative = false;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c == 45) { negative = true; i++; continue; }
    if (c >= 48 && c <= 57) { value = value * 10 + <f64>(c - 48); digits++; i++; continue; }
    break;
  }
  if (digits == 0) return -1;
  return negative ? -value : value;
}

/** 直接对源串里的一段做截断，保证不切开 \x 转义，也不切开代理对（emoji）。 */
function clipAt(src: string, quotePos: i32, max: i32): string {
  const start = quotePos + 1;
  const end = scanStringEnd(src, quotePos);
  if (end - start <= max) return src.substring(start, end);
  let cut = start + max;
  let backslashes = 0;
  let k = cut - 1;
  while (k >= start && src.charCodeAt(k) == 92) {
    backslashes++;
    k--;
  }
  if (backslashes % 2 == 1) cut--;
  if (cut > start && cut < end) {
    const c = src.charCodeAt(cut - 1);
    if (c >= 0xD800 && c <= 0xDBFF) cut--;
  }
  return src.substring(start, cut) + "…";
}

/** 对已经取出来的字符串做同样的截断。 */
function clipStr(raw: string, max: i32): string {
  if (raw.length <= max) return raw;
  let cut = max;
  let backslashes = 0;
  let k = cut - 1;
  while (k >= 0 && raw.charCodeAt(k) == 92) {
    backslashes++;
    k--;
  }
  if (backslashes % 2 == 1) cut--;
  if (cut > 0 && cut < raw.length) {
    const c = raw.charCodeAt(cut - 1);
    if (c >= 0xD800 && c <= 0xDBFF) cut--;
  }
  return raw.substring(0, cut) + "…";
}

function isQuestion(raw: string): bool {
  if (raw.length == 0) return false;
  const c = raw.charCodeAt(raw.length - 1);
  return c == 65311 || c == 63;
}

/** 在 cap 附近找句末标点切开；找不到就安全截断并补省略号。 */
function cutSentence(text: string, cap: i32): string {
  const limit = cap < text.length ? cap : text.length;
  let best = -1;
  for (let i = 0; i < limit; i++) {
    const c = text.charCodeAt(i);
    if (c == 12290 || c == 65281 || c == 65311 || c == 33 || c == 63) best = i + 1;
  }
  if (best > cap / 2) return text.substring(0, best);
  let cut = cap;
  let backslashes = 0;
  let k = cut - 1;
  while (k >= 0 && text.charCodeAt(k) == 92) {
    backslashes++;
    k--;
  }
  if (backslashes % 2 == 1) cut--;
  if (cut > 0 && cut < text.length) {
    const c = text.charCodeAt(cut - 1);
    if (c >= 0xD800 && c <= 0xDBFF) cut--;
  }
  return text.substring(0, cut) + "…";
}

/**
 * 去掉 Markdown 痕迹、把换行和多余空白压成一个空格、超长按句末截断。
 * 只处理前 400 个字符，避免长文本在 1 MiB 内存里炸掉。
 */
function tidy(raw: string, cap: i32): string {
  const src = raw.length > 400 ? raw.substring(0, 400) : raw;
  let out = "";
  let pendingSpace = false;
  let lineStart = true;
  let i = 0;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c == 92 && i + 1 < src.length) {
      const n = src.charCodeAt(i + 1);
      if (n == 110 || n == 114 || n == 116) {
        pendingSpace = true;
        lineStart = true;
        i += 2;
        continue;
      }
      if (pendingSpace && out.length > 0) {
        out += " ";
        pendingSpace = false;
      }
      out += src.substring(i, i + 2);
      i += 2;
      lineStart = false;
      continue;
    }
    if (c == 10 || c == 13) {
      pendingSpace = true;
      lineStart = true;
      i++;
      continue;
    }
    if (c == 32 || c == 9) {
      pendingSpace = true;
      i++;
      continue;
    }
    // 行首的 # > - * 属于标题/引用/列表标记
    if (lineStart && (c == 35 || c == 62 || c == 45 || c == 42)) {
      i++;
      continue;
    }
    // 行内的 * ` _ 属于强调/代码标记
    if (c == 42 || c == 96 || c == 95) {
      i++;
      continue;
    }
    if (pendingSpace && out.length > 0) out += " ";
    pendingSpace = false;
    out += src.substring(i, i + 1);
    i++;
    lineStart = false;
  }

  // 手动 trim，避免依赖额外实现
  let start = 0;
  let end = out.length;
  while (start < end && out.charCodeAt(start) == 32) start++;
  while (end > start && out.charCodeAt(end - 1) == 32) end--;
  const trimmed = out.substring(start, end);
  if (trimmed.length == 0) return "";
  if (trimmed.length > cap) return cutSentence(trimmed, cap);
  return trimmed;
}

class Turn {
  role: string = "";
  text: string = "";
  uid: string = "";
  at: f64 = -1;
}

function parseHistory(raw: string): Turn[] {
  const out: Turn[] = [];
  const start = raw.indexOf("\"history\":[");
  if (start < 0) return out;
  let i = start + 11;
  while (i < raw.length && out.length < 32) {
    const r = raw.indexOf("\"role\":", i);
    if (r < 0) break;
    const rq = valueQuote(raw, r);
    const role = rq < 0 ? "" : raw.substring(rq + 1, scanStringEnd(raw, rq));
    const t = raw.indexOf("\"text\":", r);
    if (t < 0) break;
    const tq = valueQuote(raw, t);
    const text = tq < 0 ? "" : clipAt(raw, tq, HIST_CLIP);
    const u = raw.indexOf("\"uid\":", t);
    const uq = u < 0 ? -1 : valueQuote(raw, u);
    const uid = uq < 0 ? "" : raw.substring(uq + 1, scanStringEnd(raw, uq));
    const a = raw.indexOf("\"at\":", t);
    const at = a < 0 ? -1 : numberAfterKey(raw, a);
    const turn = new Turn();
    turn.role = role;
    turn.text = text;
    turn.uid = uid;
    turn.at = at;
    out.push(turn);
    i = t + 7;
  }
  return out;
}

/** 只截取 state 对象本身，避免把 history 里的同名字段读混。 */
function stateBlock(raw: string): string {
  const k = raw.indexOf("\"state\":");
  if (k < 0) return "";
  const open = raw.indexOf("{", k);
  if (open < 0) return "";
  let depth = 0;
  let i = open;
  while (i < raw.length) {
    const c = raw.charCodeAt(i);
    if (c == 123) depth++;
    else if (c == 125) {
      depth--;
      if (depth == 0) break;
    }
    i++;
  }
  return raw.substring(open, i + 1);
}

export function run(): i32 {
  const raw = readInput();
  if (raw.length == 0) return 0;

  const hook = stringValue(raw, "\"hook\":");
  const chatType = stringValue(raw, "\"chatType\":");

  // ---- chat.before_send：清 Markdown、压空白、拦住跑飞的长回复 ----
  if (hook == "chat.before_send") {
    const dk = raw.indexOf("\"decision\":");
    const tk = dk >= 0 ? raw.indexOf("\"text\":", dk) : raw.indexOf("\"text\":");
    if (tk < 0) {
      emit("{}");
      return 0;
    }
    const tq = valueQuote(raw, tk);
    if (tq < 0) {
      emit("{}");
      return 0;
    }
    const original = raw.substring(tq + 1, scanStringEnd(raw, tq));
    const tidied = tidy(original, chatType == "group" ? 120 : 180);
    if (tidied.length == 0 || tidied == original) {
      emit("{}");
      return 0;
    }
    emit("{\"text\":\"" + tidied + "\"}");
    return 0;
  }

  const sysKey = raw.indexOf("\"system\":");
  if (sysKey < 0) {
    emit("{}");
    return 0;
  }
  const sysQuote = valueQuote(raw, sysKey);
  if (sysQuote < 0) {
    emit("{}");
    return 0;
  }
  const sysEnd = scanStringEnd(raw, sysQuote);
  const sysLen = sysEnd - (sysQuote + 1);

  const sender = stringValue(raw, "\"senderId\":");
  const nowMs = numberValue(raw, "\"now\":");
  const turns = parseHistory(raw);

  // ---- 从 state 里取上一轮留下的东西 ----
  const st = stateBlock(raw);
  let rounds = <i32>numberValue(st, "\"n\":");
  if (rounds < 0) rounds = 0;
  rounds++;
  const lastAt = numberValue(st, "\"at\":");
  const prevUid = stringValue(st, "\"top\":");
  let prevTopN = <i32>numberValue(st, "\"topN\":");
  if (prevTopN < 0) prevTopN = 0;
  const prevQuestion = stringValue(st, "\"q\":");

  // ---- 这一轮的结构 ----
  let streak = 0;
  let lastUser = "";
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role == "user") {
      if (streak == 0) lastUser = turns[i].text;
      streak++;
    } else {
      break;
    }
  }

  let lastBot = "";
  let lastBotAt = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role == "assistant" && turns[i].text.length > 0) {
      lastBot = turns[i].text;
      lastBotAt = i;
      break;
    }
  }

  // 最后一条机器人回复之后，还没被回应的问句
  let pending = "";
  for (let i = lastBotAt + 1; i < turns.length; i++) {
    if (turns[i].role == "user" && isQuestion(turns[i].text)) pending = turns[i].text;
  }

  // 最近 12 条里有多少个不同的人
  let speakers: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role != "user" || turns[i].uid.length == 0) continue;
    let seen = false;
    for (let j = 0; j < speakers.length; j++) if (speakers[j] == turns[i].uid) seen = true;
    if (!seen && speakers.length < 8) speakers.push(turns[i].uid);
  }

  // 距上一条消息的间隔：优先用历史里的时间戳（跳过当前这条），没有就退回 state
  let prevAt: f64 = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].at > 0 && nowMs - turns[i].at > 1000) {
      prevAt = turns[i].at;
      break;
    }
  }
  if (prevAt < 0 && lastAt > 0) prevAt = lastAt;
  let gapSec: i32 = -1;
  if (prevAt > 0 && nowMs > prevAt) gapSec = <i32>((nowMs - prevAt) / 1000);

  // 同一个人连续出现第几次
  let top = sender;
  let topN = 1;
  if (sender.length > 0 && sender == prevUid) topN = prevTopN + 1;

  // ---- 拼便签 ----
  let parts = chatType == "group" ? "群聊" : "私聊";
  if (speakers.length >= 2) parts += "｜最近 12 条里有 " + speakers.length.toString() + " 人在说话";
  if (streak >= 2) parts += "｜对方连发 " + streak.toString() + " 条";
  if (topN >= 3) parts += "｜这位今天已经第 " + topN.toString() + " 次找你";
  if (gapSec >= 0 && gapSec <= 90) parts += "｜上一句在 " + gapSec.toString() + " 秒前（节奏快）";
  else if (gapSec > 5400) parts += "｜隔了 " + (gapSec / 3600).toString() + " 小时才来";
  if (lastUser.length > 0) parts += "｜对方最后一句：「" + clipStr(lastUser, CLIP) + "」";
  if (lastBot.length > 0) parts += "｜你上一条：「" + clipStr(lastBot, CLIP) + "」";
  if (pending.length > 0) parts += "｜还没回答的问题：「" + clipStr(pending, CLIP) + "」";
  if (rounds >= 20) parts += "｜本次会话累计第 " + rounds.toString() + " 轮";
  parts += "｜别重复上一句的句式。";

  if (parts.length > MAX_PART) parts = clipStr(parts, MAX_PART);
  if (sysLen + parts.length + 20 > MAX_SYSTEM) {
    emit("{}");
    return 0;
  }

  // ---- 写回 state：只留这一轮需要的最小集合 ----
  let state = "{\"n\":" + rounds.toString() + ",\"at\":" + (<i64>nowMs).toString();
  if (top.length > 0) state += ",\"top\":\"" + clipStr(top, 64) + "\",\"topN\":" + topN.toString();
  if (pending.length > 0) state += ",\"q\":\"" + clipStr(pending, 120) + "\"";
  else if (prevQuestion.length > 0) state += ",\"q\":\"\"";

  emit("{\"system\":\"" + raw.substring(sysQuote + 1, sysEnd) + "\\n\\n【本轮上下文】" + parts + "\",\"state\":" + state + "}}");
  return 0;
}
