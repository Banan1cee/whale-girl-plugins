'use strict';

/**
 * 小咪叮 · 鲸鲸主动发消息（指定群 / 指定人）
 *
 * ── 归属 ────────────────────────────────────────────────────────────────
 * 插件 ID：xmding（ID 保持不变，显示名「小咪叮」，作者 atroy）
 * Api：4    Kind：tool    Hooks：tool.run
 * 权限：system.full（Api 4 必需，用户逐个确认）
 *
 * ── 能做什么 ────────────────────────────────────────────────────────────
 * 按「群名 / 人名 / 备注 / wxid」或直接给「会话 ID」向指定会话主动发消息。
 * 支持 text / voice / image 三种投递方式，支持 dryRun 预检与回执查询。
 *
 * ── 怎么发出去的 ────────────────────────────────────────────────────────
 * 不直接操作微信窗口。调用 whale.send*() 把消息交给内核的主动发送队列，
 * 由微信桥接（Python）领取后经零焦点通道真正送达：
 *
 *     whale.sendText() → reminders 入队 → 桥接 /api/reminders/due → 微信发出
 *
 * 因此本插件只负责「解析目标 + 校验 + 入队」，不碰 UIA。
 *
 * ── 调用方式 ────────────────────────────────────────────────────────────
 * POST http://127.0.0.1:8787/api/plugins/run
 *   { "id": "xmding", "input": { "action": "send",   "to": "群名", "text": "内容" } }
 *   { "id": "xmding", "input": { "action": "send",   "chatId": "xxx@chatroom", "text": "内容" } }
 *   { "id": "xmding", "input": { "action": "status", "id": "<入队返回的 id>" } }
 *   { "id": "xmding", "input": { "action": "list",   "q": "研发", "chatType": "group" } }
 *   { "id": "xmding", "input": { "action": "ping" } }
 *
 * ── 最重要的使用约束 ────────────────────────────────────────────────────
 * 返回 { queued: true } 只代表「已入队」，不代表已送达。
 * 必须用 action=status 查到 status 为 submitted / done 才算真的发出去。
 *
 * ── 设计原则 ────────────────────────────────────────────────────────────
 * 1. 宁可不发，不发错人：名字有歧义一律拒绝，并列出候选让人确认。
 * 2. 永不抛异常：worker 里抛错只会变成无信息的 plugin_error，所以统一返回
 *    { ok:false, code, message }。
 */

/* ------------------------------------------------------------------ 常量 */

/** Api 4 宿主注入的 SDK，固定从 'whale' 引入；其余依赖走 Node 原生 require。 */
const whale = require('whale');

/*
 * v1.1.1 起使用 Node 内置模块实现「独立监听转发」。
 * worker 的 entry.require 只拦截 'whale'，其余模块走原生 require，
 * 因此这里可以安全地 require('node:http') 等内置模块（Api 4 = system.full，非沙箱）。
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** 单条正文上限。留足余量给宿主 16000 的平台限制。 */
const MAX_TEXT = 4000;
/** 单次 list 返回上限，避免输出超出宿主 512 KiB 的 IO 限制。 */
const MAX_LIST = 50;
/** 歧义时最多列出的候选数。 */
const MAX_CANDIDATES = 8;
/** 会话 ID 长度上限。 */
const MAX_ID = 120;

/**
 * 微信多行换行 workaround（实测有效，见 README「多行文本」）：
 * 宿主 bg_sender 会把 \n 压成空格，但 VT(U+000B) / FF(U+000C) 能穿透且被微信渲染成换行。
 * 本插件统一用 VT 替换正文里的内部换行；首尾换行已被 cleanText 的 trim 去掉，不受影响。
 * 注意：只用于 text 投递；voice 的 text 是 TTS 朗读内容，不做替换。
 */
const WECHAT_NEWLINE = '\v';

/** 可接受的 delivery 取值。 */
const DELIVERIES = ['text', 'voice', 'image'];

/**
 * ── 独立监听转发（v1.1.1）相关默认值 ────────────────────────────────
 * 目标：绕过宿主「插件接口仅允许本机」的硬闸。做法是在插件 worker 内
 * 用 node:http 起一个监听服务绑 0.0.0.0，收到请求后从本机（环回）
 * 原样转发到 http://127.0.0.1:<server.port>/api/plugins/run。
 * 环回请求会被宿主 isLoopbackRequest() 直接放行，无需改宿主任何代码。
 */
const RELAY_DEFAULTS = Object.freeze({
  port: 8790,                 // 监听端口，可由配置文件覆盖
  bind: '0.0.0.0',            // 绑定地址，默认全网卡（局域网可达）
  forwardHost: '127.0.0.1',   // 转发目标主机，固定环回
  forwardPath: '/api/plugins/run',
});
/** 运行时配置文件名（写在 pluginData，不进安装包）。 */
const RELAY_CONFIG_FILE = 'relay.config.json';
/** token 缓存时长：宿主运行中改 token 时最多这么久后生效。 */
const TOKEN_CACHE_MS = 60000;
/** 转发超时：与 ExecutionTimeoutMs 留余量。 */
const FORWARD_TIMEOUT_MS = 30000;
/** 单次请求体上限（与宿主 512 KiB 对齐，留余量）。 */
const RELAY_MAX_BODY = 600 * 1024;

/** 监听服务实例（模块级单例，随 worker 常驻）。 */
let relayServer = null;
/** 当前监听的端口/绑定地址，供自检比对。 */
let relayBind = null;
/** token 缓存：{ value, at }。 */
let tokenCache = null;
/**
 * 插件配置项缓存（来自宿主注入的 ctx.settings，即 flow-grant.json 的 settings）。
 * 只在 hook 调用上下文里能读到（whale.context 依赖 AsyncLocalStorage），
 * 因此在各入口捕获到模块变量，供 HTTP 回调（无 invocation 上下文）使用。
 * 优先级：ctx.settings > relay.config.json > 默认值。
 */
let relayCfgFromSettings = null;

/**
 * 从 hook 上下文捕获插件配置（port/bind）。
 * 宿主把 flow-grant.json 的 settings 经 javascriptPlugins.js 注入为 ctx.settings。
 */
function captureSettings(ctx) {
  let s = ctx && ctx.settings;
  if (!s && whale.context) s = whale.context.settings;
  if (!s || typeof s !== 'object') return;
  // grant.json 手工编辑时 port 可能写成字符串，统一转成整数再校验。
  let port = s.port;
  if (typeof port === 'string' && /^\d+$/.test(port.trim())) port = parseInt(port.trim(), 10);
  relayCfgFromSettings = {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    bind: typeof s.bind === 'string' && s.bind.trim() ? s.bind.trim() : null,
  };
}

/** 回执状态 → 中文说明。 */
const STATUS_NOTES = Object.freeze({
  queued: '已入队，桥接还没来取',
  pending: '已入队，等桥接来取',
  sending: '桥接正在发（2 分钟内应有回执）',
  submitted: '桥接已回执：微信那边发出去了',
  done: '已送达（桥接回执成功）',
  unconfirmed: '未确认送达，按策略不自动重发',
  failed: '发送失败',
  expired: '过期未发（不补发）',
  cancelled: '已取消',
});

/** 视为「已送达」的状态集合。 */
const DELIVERED = new Set(['submitted', 'done']);

/* ---------------------------------------------------------------- 小工具 */

/**
 * 清洗「标识类」字符串：去掉控制字符、裁剪长度。
 * chatId / 目标名一律走这里，避免把换行或 NUL 注入进去。
 */
function str(value, max) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max || 200);
}

/** 清洗「正文」：保留换行与制表符，只去掉 NUL 并归一化换行。 */
function cleanText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, MAX_TEXT);
}

/** 群会话 ID 以 @chatroom 结尾（微信约定）。 */
function isGroupId(id) {
  return /@chatroom$/i.test(String(id || ''));
}

/**
 * 判断是否本机绝对路径。
 * 发图片要求绝对路径：宿主的 path.resolve 会把相对路径解析到它自己的 cwd，
 * 与调用方预期不符，失败时报 ENOENT 很难排查，这里提前拦下。
 */
function isAbsolutePath(p) {
  const v = String(p || '');
  // Windows 盘符（C:\ 或 C:/）或 UNC 路径（\\server\share）
  return /^[a-zA-Z]:[\\/]/.test(v) || /^\\\\[^\\]/.test(v) || v.startsWith('/');
}

/**
 * 判断一个字符串是否「本身就是会话 ID」。
 * 是的话跳过名称匹配，直接按 ID 发送——既快，也避免同名误判。
 */
function looksLikeId(value) {
  const v = String(value || '');
  return (
    isGroupId(v) ||
    /^wxid_[a-z0-9_-]+$/i.test(v) ||   // 普通个人号
    /^gh_[a-z0-9_-]+$/i.test(v) ||     // 公众号
    /^qqmail_/i.test(v) ||             // QQ 邮箱联系人
    v === 'filehelper'                 // 文件传输助手
  );
}

/**
 * 归一化 chatType。
 * @param {*} value 用户输入
 * @param {boolean} fallbackAll 无法识别时是否回退成 'all'
 */
function normalizeWant(value, fallbackAll) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'group' || v === '群' || v === 'chatroom') return 'group';
  if (v === 'private' || v === 'user' || v === 'friend' || v === '私聊' || v === 'single') return 'private';
  return fallbackAll ? 'all' : '';
}

/** 统一失败返回。所有分支都返回对象，不抛异常。 */
function fail(code, message, extra) {
  return Object.assign({ ok: false, code: code, message: message || code }, extra || {});
}

/** 取第一个非空值，用于兼容同一语义的多个参数别名。 */
function pick() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

/* ------------------------------------------------------------ 通讯录解析 */

/**
 * 读联系人缓存（由桥接定期同步到内核）。
 * 只读接口，不改状态；失败时抛错，由调用方转成结构化失败。
 */
async function loadContacts(query, want) {
  const params = [];
  if (query) params.push('q=' + encodeURIComponent(query));
  if (want === 'group') params.push('type=group');
  else if (want === 'private') params.push('type=user');

  const path = '/api/wechat/contacts' + (params.length ? '?' + params.join('&') : '');
  const res = await whale.api(path, { method: 'GET' });

  if (!res || res.ok !== true) {
    throw new Error('contacts_unavailable(status=' + ((res && res.status) || 0) + ')');
  }
  const body = res.body || {};
  return Array.isArray(body.items) ? body.items : [];
}

/** 把内核返回的联系人记录规范化成插件内部结构。 */
function shape(item) {
  const wxid = str(item && item.wxid, MAX_ID);
  const name = str(item && item.name, 80) || wxid;
  const remark = str(item && item.remark, 80);
  return {
    wxid: wxid,
    name: name,
    remark: remark,
    // 微信会话列表显示「备注优先」，发送时按这个对齐才找得到会话行。
    label: remark || name || wxid,
    chatType: (item && item.isGroup === true) || isGroupId(wxid) ? 'group' : 'private',
  };
}

/** 按 wxid 去重（大小写不敏感），空 ID 丢弃。 */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || !item.wxid) continue;
    const key = item.wxid.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 歧义时回给调用方的候选列表（精简字段，避免超长）。 */
function candidates(list) {
  return dedupe(list).slice(0, MAX_CANDIDATES).map(function (x) {
    return { wxid: x.wxid, label: x.label, chatType: x.chatType };
  });
}

/**
 * 把 to / chatId 解析成一个确定的会话。
 *
 * 匹配优先级：显式 ID → 精确 ID → 精确名称/备注 → 唯一包含。
 * 任何一步命中多个，都返回 ambiguous_target 并列出候选，绝不猜测。
 */
async function resolveTarget(input) {
  const explicit = str(pick(input.chatId, input.wxid), MAX_ID);
  const raw = str(pick(input.to, input.target), MAX_ID);
  const want = normalizeWant(input.chatType, true);

  // ---- 路径 1：已有明确 ID，跳过名称匹配 ----
  if (explicit || looksLikeId(raw)) {
    const wxid = explicit || raw;
    let hit = null;
    try {
      // 顺手补一个显示名，拿不到也不影响发送。
      const items = await loadContacts(wxid, 'all');
      hit = items.map(shape).find(function (x) {
        return x.wxid.toLowerCase() === wxid.toLowerCase();
      }) || null;
    } catch (err) {
      hit = null;
    }
    const fixed = normalizeWant(input.chatType, false);
    return {
      ok: true,
      chatId: wxid,
      name: hit ? hit.label : wxid,
      chatType: fixed || (hit ? hit.chatType : (isGroupId(wxid) ? 'group' : 'private')),
      matchedBy: 'id',
    };
  }

  // ---- 路径 2：按名称匹配 ----
  if (!raw) {
    return fail('missing_target', '请用 to 指定群名 / 人名 / 微信号，或用 chatId 直接给会话 ID');
  }

  let items;
  try {
    items = (await loadContacts(raw, want)).map(shape);
  } catch (err) {
    return fail('contacts_unavailable', '读不到联系人缓存，请改用 chatId 直接指定会话 ID：' + err.message);
  }

  const key = raw.toLowerCase();

  // 精确 ID
  const exactId = items.find(function (x) { return x.wxid.toLowerCase() === key; });
  if (exactId) {
    return { ok: true, chatId: exactId.wxid, name: exactId.label, chatType: exactId.chatType, matchedBy: 'wxid' };
  }

  // 精确名称 / 备注 → 否则退回「唯一包含」
  const exact = items.filter(function (x) {
    return x.label.toLowerCase() === key || x.name.toLowerCase() === key || x.remark.toLowerCase() === key;
  });
  const pool = exact.length
    ? exact
    : items.filter(function (x) {
      return x.label.toLowerCase().indexOf(key) >= 0 || x.name.toLowerCase().indexOf(key) >= 0;
    });

  const uniq = dedupe(pool);
  const matchedBy = exact.length ? 'name' : 'contains';

  if (uniq.length === 1) {
    return { ok: true, chatId: uniq[0].wxid, name: uniq[0].label, chatType: uniq[0].chatType, matchedBy: matchedBy };
  }
  if (!uniq.length) {
    return fail('target_not_found',
      '通讯录里没有匹配「' + raw + '」的会话。可先用 action=list 搜索，或直接给 chatId。');
  }
  return fail('ambiguous_target',
    '「' + raw + '」匹配到 ' + uniq.length + ' 个会话，为避免发错人，请改用 chatId 精确指定。',
    { candidates: candidates(uniq) });
}

/* ---------------------------------------------------------------- 各动作 */

/** action=send：解析目标 → 可选预检 → 入队。 */
async function doSend(input) {
  const rawText = pick(input.text, input.message);
  const text = cleanText(rawText);

  // text 对三种 delivery 都是必填：图片/语音也要带一段文字。
  // 宿主 pluginHost.send 对 image 之外的路径同样要求非空 text。
  if (!text) return fail('empty_text', 'text 不能为空（发图片/语音也需要给一段文字）');
  if (String(rawText).length > MAX_TEXT) {
    return fail('text_too_long', '正文超过 ' + MAX_TEXT + ' 字，请拆成几条发');
  }

  const target = await resolveTarget(input);
  if (!target.ok) return target;

  // dryRun：只解析目标，不入队。用于确认「这个名字会不会点错人」。
  if (input.dryRun === true) {
    return {
      ok: true,
      action: 'send',
      dryRun: true,
      queued: false,
      confirmed: false,
      chatId: target.chatId,
      chatType: target.chatType,
      name: target.name,
      matchedBy: target.matchedBy,
      textLength: text.length,
      note: '只做了目标解析，没有发送。去掉 dryRun 才会真发。',
    };
  }

  const delivery = String(pick(input.delivery, input.type, 'text')).trim().toLowerCase();
  if (DELIVERIES.indexOf(delivery) < 0) {
    return fail('invalid_delivery', 'delivery 只能是 ' + DELIVERIES.join(' / '));
  }

  const opts = { chatType: target.chatType, name: target.name };

  // 多行换行 workaround：宿主 bg_sender 会把 \n 压成空格，导致微信里多行变一行。
  // 实测 VT(U+000B) 能穿透宿主且被微信渲染成换行，故 text 投递默认把内部 \n 换成 \v。
  // keepNewline=true 时不替换（保留原样）；voice 的 text 是 TTS 朗读内容，永不替换。
  const outText = (delivery === 'text' && input.keepNewline !== true)
    ? text.replace(/\n/g, WECHAT_NEWLINE)
    : text;

  let out;
  try {
    if (delivery === 'image') {
      // 图片走宿主的表情包通道（与文字的提醒队列不同）：
      //   1) file 必须是本机绝对路径，相对路径会 ENOENT
      //   2) 单张 ≤ 4 MB
      //   3) 需要 features.stickers = true，否则宿主抛「表情包功能未开启」
      const file = str(input.file, 400);
      if (!file) return fail('missing_file', '发图片需要 file（本机绝对路径）');
      if (!isAbsolutePath(file)) {
        return fail('invalid_file', 'file 必须是本机绝对路径，收到的是相对路径：' + file);
      }
      out = await whale.sendImage(target.chatId, file, opts);
    } else if (delivery === 'voice') {
      out = await whale.sendVoice(target.chatId, text, opts);
    } else {
      out = await whale.sendText(target.chatId, outText, opts);
    }
  } catch (err) {
    return fail('send_rejected', '内核拒绝了这次发送：' + str(err && err.message, 200));
  }

  const receipt = out && typeof out === 'object' ? out : {};
  const id = receipt.id || '';

  return {
    ok: true,
    action: 'send',
    // 入队成功 ≠ 已送达，confirmed 恒为 false，必须再查 status。
    queued: true,
    delivered: false,
    confirmed: false,
    id: id,
    status: receipt.status || 'queued',
    delivery: delivery,
    chatId: target.chatId,
    chatType: target.chatType,
    name: target.name,
    matchedBy: target.matchedBy,
    textLength: text.length,
    // 文字终态是 submitted/done，图片走表情包通道终态是 confirmed。
    // 语音需要微信与目标会话都在前台，且回执只到「开始录音」，提示里单独说明。
    note: delivery === 'voice'
      ? '已入队。语音要求微信主窗与目标会话都在前台（否则会报「请保持微信目标聊天在前台」）；'
        + '其 confirmed 只代表「已交给语音工作进程并开始录音」，不等于对方收到，请以微信实际收到为准。'
      : '已入队（queued ≠ 已送达）。请用 {action:"status", id:"' + (id || '<id>') + '"} 查回执，'
        + (delivery === 'image'
          ? '直到 status 为 confirmed。'
          : '直到 status 为 submitted / done。'),
  };
}

/** action=status：查投递回执。 */
async function doStatus(input) {
  // 兼容把 id 写成 delivery / deliveryId 的调用方。
  const id = str(pick(input.id, input.deliveryId, input.delivery), MAX_ID);
  if (!id) return fail('missing_id', '请给 id（action=send 返回的那个）');

  let out;
  try {
    out = await whale.delivery(id);
  } catch (err) {
    return fail('delivery_not_found', '查不到这条投递：' + str(err && err.message, 160));
  }

  const d = out && typeof out === 'object' ? out : {};
  const status = String(d.status || 'unknown');

  return {
    ok: true,
    action: 'status',
    id: d.id || id,
    status: status,
    error: d.error || '',
    confirmed: d.confirmed === true || DELIVERED.has(status),
    note: STATUS_NOTES[status] || ('未知状态：' + status),
  };
}

/** action=list：搜索联系人与群。 */
async function doList(input) {
  const q = str(pick(input.q, input.to, input.query), MAX_ID);
  const want = normalizeWant(input.chatType, true);

  let items;
  try {
    items = (await loadContacts(q, want)).map(shape);
  } catch (err) {
    return fail('contacts_unavailable', '读不到联系人缓存：' + str(err && err.message, 160));
  }

  const uniq = dedupe(items);
  return {
    ok: true,
    action: 'list',
    query: q,
    total: uniq.length,
    items: uniq.slice(0, MAX_LIST).map(function (x) {
      return { wxid: x.wxid, label: x.label, name: x.name, remark: x.remark, chatType: x.chatType };
    }),
    truncated: uniq.length > MAX_LIST,
  };
}

/** action=ping：探活与版本自检，不触碰任何外部资源。 */
function doPing() {
  return {
    ok: true,
    action: 'ping',
    plugin: 'xmding',
    name: '小咪叮',
    author: 'atroy',
    api: 4,
    version: VERSION,
    now: Date.now(),
    relay: relayBind ? { port: relayBind.port, bind: relayBind.bind, listening: !!(relayServer && relayServer.listening) } : null,
  };
}

/* ------------------------------------------------- 独立监听转发 (v1.1.1) */

/** 插件版本号（ping 与 healthz 共用）。 */
const VERSION = '1.1.1';

/** 恒定时间字符串比较，避免靠响应时间猜 token（与宿主 security.js 同口径）。 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch { return false; }
}

/** 读宿主 config.json（appRoot 由宿主注入），失败返回空对象。 */
function appConfig() {
  try {
    const root = (whale.paths && whale.paths.appRoot) || '';
    if (!root) return {};
    return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  } catch { return {}; }
}

/** 转发目标 URL：从宿主 server.port 自适应拼环回地址。 */
function forwardUrl() {
  const cfg = appConfig();
  const sp = cfg && cfg.server && cfg.server.port;
  const port = Number.isInteger(sp) && sp > 0 && sp < 65536 ? sp : 8787;
  return 'http://' + RELAY_DEFAULTS.forwardHost + ':' + port + RELAY_DEFAULTS.forwardPath;
}

/** 宿主 inboundToken（带缓存），用作转发器的 x-bot-token 校验基准。 */
function hostToken() {
  const now = Date.now();
  if (tokenCache && now - tokenCache.at < TOKEN_CACHE_MS) return tokenCache.value;
  const cfg = appConfig();
  const t = String((cfg && cfg.gateway && cfg.gateway.wechat && cfg.gateway.wechat.inboundToken) || '').trim() || null;
  tokenCache = { value: t, at: now };
  return t;
}

/**
 * 读转发器配置。优先级：
 *   1) 插件配置项（flow-grant.json 的 settings，经 ctx.settings 注入）——主配置源
 *   2) relay.config.json（pluginData 里的旧文件）——兜底/兼容手工编辑
 *   3) 默认值（8790 / 0.0.0.0）
 * 配置文件已不作为主配置入口，仅在 settings 缺失时兜底。
 */
function relayConfig() {
  let cfg = {};
  try {
    const dir = (whale.paths && whale.paths.pluginData) || '.';
    const file = path.join(dir, RELAY_CONFIG_FILE);
    if (fs.existsSync(file)) {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    }
  } catch { cfg = {}; }

  const s = relayCfgFromSettings || {};
  let filePort = cfg.port;
  if (typeof filePort === 'string' && /^\d+$/.test(filePort.trim())) filePort = parseInt(filePort.trim(), 10);
  const port = (Number.isInteger(s.port) && s.port)
    ? s.port
    : (Number.isInteger(filePort) && filePort > 0 && filePort < 65536 ? filePort : RELAY_DEFAULTS.port);
  const bind = s.bind
    ? s.bind
    : (typeof cfg.bind === 'string' && cfg.bind ? cfg.bind : RELAY_DEFAULTS.bind);
  return { port, bind };
}

/** 读请求体，带体积上限。 */
function readRequestBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > RELAY_MAX_BODY) { reject(Error('body_too_large')); try { req.destroy(); } catch {} return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/** 把请求体原样 POST 到宿主 /api/plugins/run，返回宿主的响应。 */
function forwardRequest(body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(forwardUrl());
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        // 带上 token：宿主环回虽不校验，但兼容未来策略变化；token 不写进源码。
        'x-bot-token': hostToken() || '',
        'x-whale-plugin': 'xmding',
      },
      timeout: FORWARD_TIMEOUT_MS,
    };
    const r = http.request(opts, function (resp) {
      const chunks = [];
      resp.on('data', function (c) { chunks.push(c); });
      resp.on('end', function () {
        resolve({ status: resp.statusCode || 502, body: Buffer.concat(chunks), ctype: resp.headers['content-type'] || 'application/json' });
      });
    });
    r.on('timeout', function () { r.destroy(); reject(Error('forward_timeout')); });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

/** 监听器的请求入口：先校验 token，再原样转发。 */
async function relayHandler(req, res) {
  try {
    if (req.url === '/healthz' || req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, plugin: 'xmding', version: VERSION,
        relay: relayBind ? { port: relayBind.port, bind: relayBind.bind, listening: !!(relayServer && relayServer.listening) } : null }));
      return;
    }

    // 自带 x-bot-token 校验：调用方必须用宿主同一把 token。
    const provided = String((req.headers && req.headers['x-bot-token']) || '').trim();
    const expected = hostToken();
    if (!expected || !safeEqual(provided, expected)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'invalid x-bot-token' }));
      return;
    }

    const body = await readRequestBody(req);
    if (!body.length) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'empty body' }));
      return;
    }

    const out = await forwardRequest(body);
    res.writeHead(out.status, { 'content-type': out.ctype });
    res.end(out.body);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'relay_error: ' + String((err && err.message) || err) }));
  }
}

/** 启动监听（幂等：端口/地址未变且已在听则跳过）。 */
function startRelay() {
  const cfg = relayConfig();
  if (relayServer && relayBind && relayBind.port === cfg.port && relayBind.bind === cfg.bind && relayServer.listening) {
    return Promise.resolve({ ok: true, already: true, port: cfg.port, bind: cfg.bind });
  }
  return stopRelay().then(function () {
    return new Promise(function (resolve) {
      const server = http.createServer(function (req, res) { void relayHandler(req, res); });
      server.on('error', function (err) {
        relayServer = null; relayBind = null;
        resolve({ ok: false, error: String((err && err.message) || err) });
      });
      server.listen(cfg.port, cfg.bind, function () {
        relayServer = server;
        relayBind = { port: cfg.port, bind: cfg.bind };
        resolve({ ok: true, port: cfg.port, bind: cfg.bind });
      });
    });
  });
}

/** 关闭监听并释放端口。 */
function stopRelay() {
  if (!relayServer) return Promise.resolve({ ok: true, stopped: false });
  const server = relayServer;
  relayServer = null; relayBind = null;
  return new Promise(function (resolve) {
    try { server.close(function () { resolve({ ok: true, stopped: true }); }); }
    catch { resolve({ ok: true, stopped: true }); }
  });
}

/** 存活自检：配置变了或监听掉了就重建。供 timer.tick 与 tool.run 调用。 */
function ensureRelay() {
  const cfg = relayConfig();
  if (relayServer && relayBind && relayBind.port === cfg.port && relayBind.bind === cfg.bind && relayServer.listening) {
    return Promise.resolve({ ok: true, already: true });
  }
  tokenCache = null; // 配置可能变了，顺手让 token 重读
  return startRelay();
}

/** app.start：启动监听并快速返回（不能占用执行槽）。 */
function onAppStart(ctx) {
  captureSettings(ctx);
  return ensureRelay().then(function (r) {
    return { ok: true, action: 'app.start', relay: r, note: '独立监听转发已启动（若失败会由 timer.tick 重试）' };
  });
}

/** app.stop：关闭监听。 */
function onAppStop(ctx) {
  captureSettings(ctx);
  return stopRelay().then(function (r) {
    return { ok: true, action: 'app.stop', relay: r };
  });
}

/** timer.tick：保活自检（顺带刷新配置，端口/bind 变了就重建监听）。 */
function onTimerTick(ctx) {
  captureSettings(ctx);
  return ensureRelay().then(function (r) {
    return { ok: true, action: 'timer.tick', relay: r };
  });
}

/* ---------------------------------------------------------------- 入口 */

/**
 * 宿主 tool.run 入口。
 *
 * 按上下文取 input；支持三种导出形态（hooks.tool.run / tool.run / run），
 * 覆盖宿主 worker 的解析顺序。
 */
async function run(ctx) {
  const input = (ctx && ctx.input) || {};
  const action = String(input.action || 'send').trim().toLowerCase();

  try {
    // 每次调用都刷新插件配置缓存：改了 flow-grant.json 的 settings 后，
    // 下一次 ping / timer.tick 就能读到新值（timer 每 30s 自动触发）。
    captureSettings(ctx);

    // 生命周期钩子（由宿主在启动/停止/定时时以 hook 名作为 action 调用）。
    if (action === 'app.start') return await onAppStart();
    if (action === 'app.stop') return await onAppStop();
    if (action === 'timer.tick') return await onTimerTick();

    switch (action) {
      // tool.run 顺带做一次监听自检：worker 被杀后 app.start 不会重放，
      // 只要有调用进来就能自愈重建监听（消除永久 down 的窗口）。
      case 'send':
      case 'status':
      case 'list':
      case 'ping':
        void ensureRelay();
        break;
      default:
        break;
    }

    switch (action) {
      case 'send': return await doSend(input);
      case 'status': return await doStatus(input);
      case 'list': return await doList(input);
      case 'ping': return doPing();
      default:
        return fail('invalid_action', 'action 只能是 send / status / list / ping');
    }
  } catch (err) {
    // 不往外抛：插件抛错只会变成无信息量的 plugin_error。
    return fail('plugin_error', str(err && err.message, 300));
  }
}

exports.run = run;
exports.hooks = {
  'tool.run': run,
  'app.start': onAppStart,
  'app.stop': onAppStop,
  'timer.tick': onTimerTick,
};
