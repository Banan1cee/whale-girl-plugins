"use strict";

// 小咪叮 4 级迁移版：只保留 tool.run 的 send/list/ping。
// 独立监听转发、图片发送、投递回执查询、app.start/app.stop 保活全部删除；
// 插件不监听端口、不走 /api/*、不读取宿主 config.json。
const AUTHOR = "atroy";
const VERSION = "2.0.2";
const MAX_TEXT = 4000;
const MAX_ID = 120;
const MAX_NAME = 80;

function fail(code, message, extra) {
  return { ok: false, code: code, message: message, ...(extra || {}) };
}

function cleanText(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

function isGroupId(id) {
  return /@chatroom$/i.test(String(id || ""));
}

function looksLikeId(value) {
  const text = String(value || "").trim();
  return /^wxid_[A-Za-z0-9_-]+$/i.test(text) || isGroupId(text) || /^[A-Za-z0-9_-]{6,}$/.test(text);
}

function normalizeWant(value) {
  return String(value == null ? "" : value).replace(/\s+/g, "").toLowerCase();
}

function candidate(item) {
  return {
    wxid: item.wxid,
    chatId: item.wxid,
    name: String(item.name || "").slice(0, MAX_NAME),
    label: String(item.label || item.remark || item.name || "").slice(0, MAX_NAME),
    isGroup: item.isGroup === true || isGroupId(item.wxid),
  };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    // 联系人缓存来自桥接推送，数组里可能是 null/字符串；不能直接取 item.wxid。
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const wxid = String(item.wxid || "").trim().slice(0, MAX_ID);
    if (!wxid || seen.has(wxid)) continue;
    seen.add(wxid);
    out.push(candidate({ ...item, wxid: wxid }));
  }
  return out;
}

async function loadContacts(host, query) {
  const out = await host.call("contacts.list@1", { q: String(query || ""), type: "all" });
  if (!out || out.ok === false) throw new Error("contacts_unavailable");
  // items 可能缺失或不是数组（旧缓存/空账号）；按空列表处理，不抛 for...of 错误。
  const items = dedupe(out.items);
  return { items: items, total: Number(out.total) || 0, account: String(out.account || "").slice(0, MAX_ID) };
}

/** 旧 resolveTarget 的语义保留：显式 ID → 精确 ID → 精确名称/备注 → 唯一包含。 */
async function resolveTarget(host, input) {
  const explicit = String(input.chatId || input.wxid || "").trim();
  const want = String(input.to || input.name || "").trim();
  const directory = await loadContacts(host, explicit || want);
  const items = directory.items;
  if (explicit) {
    const hit = items.find((item) => item.chatId === explicit) || { chatId: explicit, wxid: explicit, name: "", label: "", isGroup: isGroupId(explicit) };
    return { target: hit, items: items, directory: directory };
  }
  if (!want) return { error: fail("missing_target", "缺少 to/chatId：要发给谁？"), items: items, directory: directory };
  const key = normalizeWant(want);
  const exact = items.find((item) => normalizeWant(item.chatId) === key)
    || items.find((item) => normalizeWant(item.label) === key)
    || items.find((item) => normalizeWant(item.name) === key);
  if (exact) return { target: exact, items: items, directory: directory };
  const contains = items.filter((item) => normalizeWant(item.label).includes(key) || normalizeWant(item.name).includes(key));
  if (contains.length === 1) return { target: contains[0], items: items, directory: directory };
  if (contains.length > 1) {
    return {
      error: fail("ambiguous_target", "匹配到多个联系人，请改用会话 ID", {
        candidates: contains.slice(0, 10).map((item) => ({ wxid: item.wxid, name: item.label || item.name, isGroup: item.isGroup })),
      }), items: items, directory: directory,
    };
  }
  return { error: fail("target_not_found", "联系人里没有匹配的会话：" + want), items: items, directory: directory };
}

async function doSend(host, input, settings) {
  const text = cleanText(input.text);
  if (!text) return fail("missing_text", "text 必填");
  if ([...text].length > MAX_TEXT) return fail("text_too_long", "text 最多 " + MAX_TEXT + " 字");
  const delivery = String(input.delivery || "text").toLowerCase();
  if (delivery === "image") return fail("unsupported_delivery", "新协议没有图片投递能力");
  if (delivery !== "text" && delivery !== "voice") return fail("invalid_delivery", "delivery 只能是 text 或 voice");
  const resolved = await resolveTarget(host, input);
  if (resolved.error) return resolved.error;
  const target = resolved.target;
  // registry 的 chatId 上限 120；显式传入的 ID 可能超长，必须在 host.call 前拒绝。
  if (!target.chatId || String(target.chatId).length > MAX_ID) return fail("invalid_target", "会话 ID 为空或过长");
  const payloadText = settings.keepNewline === false ? text.replace(/\n+/g, " ") : text;
  const plan = {
    chatId: String(target.chatId),
    chatType: target.isGroup ? "group" : "private",
    name: String(target.label || target.name || "").slice(0, MAX_NAME),
    text: payloadText,
    delivery: delivery,
  };
  if (input.dryRun === true) {
    return { ok: true, action: "send", dryRun: true, resolved: candidate(target), planned: plan,
      note: "dryRun 只解析目标，未排队任何消息" };
  }
  const out = await host.call("message.send@1", plan);
  return {
    ok: true, action: "send",
    queued: Boolean(out && out.status === "queued"),
    delivered: false,
    confirmed: false,
    id: String((out && out.id) || ""),
    status: String((out && out.status) || "queued"),
    chat: { chatId: target.chatId, name: target.label || target.name || "", isGroup: target.isGroup },
    note: "queued 只代表已排队到宿主发送通道，不是微信已送达；新协议没有回执查询",
  };
}

async function doList(host, input) {
  const directory = await loadContacts(host, input.q);
  const items = directory.items.slice(0, 50).map((item) => ({
    wxid: item.wxid, name: item.label || item.name || item.wxid, isGroup: item.isGroup,
  }));
  return { ok: true, action: "list", account: directory.account, total: directory.total,
    count: items.length, truncated: directory.items.length > items.length, items: items };
}

function doPing() {
  return { ok: true, action: "ping", name: "xmding", version: VERSION, author: AUTHOR, level: 4,
    actions: ["send", "list", "ping", "status"],
    removed: ["relay (0.0.0.0:8790 监听转发)", "image delivery", "whale.delivery 回执查询",
      "app.start/app.stop 启停", "宿主 config/token 读取"] };
}

exports.providers = {
  "tool.run@1": async (input, context) => {
    const host = context && context.host;
    const settings = (context && context.settings) || {};
    if (!host || typeof host.call !== "function") return fail("host_unavailable", "宿主 SDK 不可用");
    const action = String((input && input.action) || "").toLowerCase();
    try {
      if (action === "send") return await doSend(host, input || {}, settings);
      if (action === "list") return await doList(host, input || {});
      if (action === "ping") return doPing();
      if (action === "status") {
        return fail("unsupported", "新协议没有投递回执查询；message.send@1 只返回 queued，不代表已送达");
      }
      if (action === "") return fail("missing_action", "action 必填：send/list/ping");
      return fail("unsupported_action", "不支持的动作：" + action);
    } catch (error) {
      // 用户可见错误只回类别，不透出宿主/内部错误文本（可能含路径、能力名或参数细节）。
      if (error && error.message === "contacts_unavailable") return fail("contacts_unavailable", "读取联系人失败，请稍后重试");
      return fail("xmding_failed", "操作失败，请稍后重试；如果持续失败，请查看宿主日志");
    }
  },
};
