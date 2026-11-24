'use strict';

/**
 * 鲸鲸（whale-girl / WhaleGirl v4.x）插件：breeze-sing 点歌翻唱。
 *
 * 群友发「点歌 起风了」后：
 *   1. 落单（cover order），由 timer.tick 起 breeze-prep.mjs；
 *   2. breeze-prep 用在线音源下原曲、切 30 秒副歌，再调 seed-vc 换声；
 *   3. 成品出来后用 whale.sendVoice 发 [[cover:<单号>]]，鲸鲸语音桥把
 *      它换成 breezeblue 音色的翻唱音频，录成微信语音发回群里。
 */

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI_CANDIDATES = [
  path.join(os.homedir(), 'whale-cover', 'tools', 'cover.mjs'),
];

const PREFIXES = ['点歌', '点播', '来一首', '來一首', 'cover'];
const HELP_WORDS = ['点歌帮助', '点歌说明', '点歌菜单', '点歌玩法'];
const LIST_WORDS = ['点歌单', '点歌列表', '歌单', '点歌进度', '排队'];
const CANCEL_RE = /^取消(?:点歌|点播)\s*(.*)$/;
const SING_RE = /^(?:唱|唱一个|唱一首|来一段|发歌|发一下|听歌|听听)\s*[:：]?\s*(.*)$/;
const GIVE_SONG_RE = /^把《(.+?)》(?:唱|放|发|送)给\s*([^\s，,。！!?？]{1,12}?)(?:听|吧|好吗|好不好)?$/;
const GIVE_RE = /^(?:把)?(?:这?首?歌)?(?:唱|放|发|送)给\s*([^\s，,。！!?？]{1,12}?)(?:听|吧|好吗|好不好)?$/;
const ORDER_RE = new RegExp('^(?:' + PREFIXES.join('|') + ')[\\s:：,，]*(.*)$', 'i');

// 微信 UIA 发送会把换行压成空格，菜单必须写成一行，用「；」分隔。
const MENU_TEXT = '点歌：点歌 歌名；指定原唱：点歌 歌名 - 歌手；自动下载并做 30 秒 breezeblue 音色翻唱；发成品：唱 歌名；发给主人：把《歌名》唱给主人1/主人2听（单主人用主人）；看队列：点歌单；撤单：取消点歌 歌名';

const recent = new Map(); // `${chatId}|${senderId}|${song}` -> ts，防微信重推导致重复落单

function cliPath(settings) {
  const custom = settings && typeof settings.coverCli === 'string' ? settings.coverCli.trim() : '';
  if (custom && fs.existsSync(custom)) return custom;
  for (const candidate of CLI_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return CLI_CANDIDATES[0];
}

function runtimeRoot(settings) {
  const cli = cliPath(settings);
  return path.dirname(path.dirname(cli));
}
function voicePaths(settings) {
  const root = runtimeRoot(settings);
  return {
    python: settings.voicePython || path.join(root, 'voice', 'venv', 'Scripts', 'python.exe'),
    sender: settings.voiceSender || path.join(root, 'voice', 'send_cover.py'),
  };
}
function coverWavPath(settings, order) {
  const audio = String(order && order.audio || '').trim();
  if (audio && fs.existsSync(audio)) return audio;
  const work = path.join(dataRoot(settings), 'work', String(order && order.id || ''), 'cover.wav');
  return fs.existsSync(work) ? work : '';
}
// 直接调用本地发送器：不依赖鲸鲸桥接补丁，也不需要宿主 sendVoiceFile 接口。
function sendCoverVoice(settings, order, chatName) {
  return new Promise((resolve) => {
    const { python, sender } = voicePaths(settings);
    const wav = coverWavPath(settings, order);
    if (!wav) return resolve({ ok: false, error: '找不到成品音频' });
    if (!fs.existsSync(python) || !fs.existsSync(sender)) {
      return resolve({ ok: false, error: '语音发送器未安装' });
    }
    const args = [sender, '--wav', wav, '--chat', String(chatName || '')];
    execFile(python, args, { timeout: 180000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = (String(stdout || '') + String(stderr || '')).trim();
        resolve({ ok: !error && /OK/.test(output), output: output.slice(-500) });
      });
  });
}
function runCover(settings, args, timeoutMs) {
  return new Promise((resolve) => {
    const cli = cliPath(settings);
    execFile(process.execPath, [cli, ...args, '--json'], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      const text = String(stdout || '').trim();
      if (text) {
        try {
          resolve(JSON.parse(text));
          return;
        } catch { /* 落到下面统一报错 */ }
      }
      resolve({
        ok: false,
        error: (error && error.message) || String(stderr || '').trim() || 'cover CLI 没有输出',
      });
    });
  });
}


function whaleHome() {
  const env = String(process.env.WHALE_GIRL_HOME || '').trim();
  if (env && fs.existsSync(path.join(env, 'data', 'voice-send.json'))) return env;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WhaleGirl'),
    path.join(process.env.ProgramFiles || '', 'WhaleGirl'),
    path.join(process.env.ProgramW6432 || '', 'WhaleGirl'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'data', 'voice-send.json'))) return c; } catch { /* ignore */ }
  }
  return '';
}

function voiceSignature() {
  try {
    const home = whaleHome();
    if (!home) return '';
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'data', 'voice-send.json'), 'utf8'));
    return `${cfg.Model || ''}|${cfg.Voice || ''}`;
  } catch { return ''; }
}

function newestRefAfter(ts) {
  try {
    const dir = path.join(dataRoot({}), 'voice-ref');
    const files = fs.readdirSync(dir)
      .filter((n) => /^ref-\d+\.(wav|mp3)$/i.test(n))
      .map((n) => ({ n, p: path.join(dir, n), m: fs.statSync(path.join(dir, n)).mtimeMs, s: fs.statSync(path.join(dir, n)).size }))
      .filter((x) => x.s > 20 * 1024 && x.m >= ts)
      .sort((a, b) => b.m - a.m);
    return files[0] ? files[0].p : '';
  } catch { return ''; }
}

// 鲸鲸设置里换 BreezeBlue 音色后：等一条新的普通语音样本，自动把它设为 seed-vc 参考。
async function syncVoice(whale, settings, state, orders) {
  const sig = voiceSignature();
  if (!sig) return false;
  if (!state.voiceSig) { state.voiceSig = sig; saveAuto(state); return false; }
  if (state.voiceSig === sig) return false;
  if (!state.voiceChangedAt) {
    state.voiceChangedAt = Date.now();
    state.voiceWarned = false;
    saveAuto(state);
  }
  const ref = newestRefAfter(Number(state.voiceChangedAt) - 120000);
  if (!ref) {
    if (!state.voiceWarned) {
      state.voiceWarned = true;
      saveAuto(state);
      const t = (orders || []).find((o) => isOurs(o) && o.group && o.group.id);
      if (t) await notifyGroup(whale, t, '检测到换音色了，先随便发一句话让鲸鲸回个语音，我采一段新参考就同步。');
    }
    return true;
  }
  const res = await runCover(settings, ['engine', 'ref', ref], 20000);
  if (res && res.ok) {
    state.voiceSig = sig;
    delete state.voiceChangedAt;
    delete state.voiceWarned;
    saveAuto(state);
    const t = (orders || []).find((o) => isOurs(o) && o.group && o.group.id);
    if (t) await notifyGroup(whale, t, '新音色参考已同步，接下来点的歌会用新音色。');
    return false;
  }
  return true;
}

// ── 自动渲染队列 ────────────────────────────────────────────────────────────
// 点歌只落单；这里用 timer.tick 轮询：串行跑 cover render，做完把成品当语音发回群。
// 状态写在插件自己的 data 目录（cover-orders.data/auto-state.json），重启不重复发。
const AUTO_STATE = path.join(__dirname, 'auto-state.json');
const AUTO_LOG = path.join(__dirname, 'auto-render.log');
const PREP_LOG = path.join(__dirname, 'breeze-prep.log');
const STALE_MS = 15 * 60 * 1000;
const IDLE_STALL_MS = 6 * 60 * 1000;

function dataRoot(settings) {
  const custom = settings && settings.dataDir ? String(settings.dataDir) : '';
  if (custom) return custom;
  if (process.env.WHALE_COVER_DATA_DIR) return process.env.WHALE_COVER_DATA_DIR;
  return path.join(os.homedir(), 'whale-cover', 'data');
}

function prepScriptPath(settings) {
  return path.join(path.dirname(path.dirname(cliPath(settings))), 'whale-plugin', 'breeze-prep.mjs');
}

function prepStatus(settings, orderId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataRoot(settings), 'prep-status', orderId + '.json'), 'utf8'));
  } catch { return null; }
}

const PROGRESS_MS = 2 * 60 * 1000;

function renderProgress(settings, orderId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataRoot(settings), 'work', orderId, 'progress.json'), 'utf8'));
  } catch { return null; }
}

function progressText(order, elapsedMs, hint, settings) {
  const mins = Math.max(1, Math.round(elapsedMs / 60000));
  let stage = '准备中';
  if (hint && hint.stage) stage = hint.stage;
  else {
    const work = path.join(dataRoot(settings || {}), 'work', order.id);
    if (fs.existsSync(path.join(work, 'sep', 'htdemucs', 'song', 'vocals.wav'))) stage = '换声合成';
    else if (fs.existsSync(path.join(work, 'song.wav'))) stage = '分离人声';
  }
  let detail = '';
  if (hint && Number(hint.total) > 0 && Number(hint.step) > 0) {
    // seed-vc 是按段跑的，每段都会从 1/10 重新开始，不能用单段百分比冒充整首进度。
    const chunk = Number(hint.chunk) || 0;
    detail = chunk > 0
      ? `（第 ${chunk} 段，${Number(hint.step)}/${Number(hint.total)} 步）`
      : `（${Number(hint.step)}/${Number(hint.total)} 步）`;
  }
  return `《${order.song}》进度：已 ${mins} 分钟，${stage}${detail}。好了发语音。`;
}

async function maybeReportProgress(whale, settings, order, state) {
  if (!whale || !order || !order.group) return;
  const started = Number(state.progressStartedAt) || Date.now();
  if (!state.progressStartedAt) { state.progressStartedAt = started; saveAuto(state); }
  const last = Number(state.lastProgressAt) || started;
  if (Date.now() - last < PROGRESS_MS) return;
  state.lastProgressAt = Date.now();
  saveAuto(state);
  const hint = order.status === 'making' ? renderProgress(settings, order.id) : null;
  await notifyGroup(whale, order, progressText(order, Date.now() - started, hint, settings));
}

function loadAuto() {
  try {
    const value = JSON.parse(fs.readFileSync(AUTO_STATE, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function saveAuto(state) {
  const sent = state.sent || {};
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const [id, at] of Object.entries(sent)) if (!(Number(at) > cutoff)) delete sent[id];
  state.sent = sent;
  const failed = state.failedAt || {};
  const failedCutoff = Date.now() - 24 * 3600 * 1000;
  for (const [id, at] of Object.entries(failed)) if (!(Number(at) > failedCutoff)) delete failed[id];
  state.failedAt = failed;
  try { fs.writeFileSync(AUTO_STATE, JSON.stringify(state)); } catch { /* data 目录不可写就只跑内存态 */ }
}

function chatTypeOf(message) {
  return message.chatType === 'group' ? 'group' : 'private';
}
// 私聊的 chatId 在内核里不是 wxid，发送目标要用 senderId/昵称
function chatKey(message) {
  return String((message.chatType === 'group' ? message.chatId : (message.senderId || message.chatId)) || '');
}
function masterList() {
  try {
    const file = path.join(require('whale').paths.appRoot, 'data', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const master = (cfg.persona && cfg.persona.master) || {};
    const ids = Array.isArray(master.wxids) ? master.wxids.map(String) : [];
    const names = Array.isArray(master.names) ? master.names : [];
    const titleMap = master.titles && typeof master.titles === 'object' && !Array.isArray(master.titles)
      ? master.titles : {};
    const titleList = Array.isArray(master.titles) ? master.titles : [];
    const total = ids.length;
    return ids.map((id, i) => ({
      id,
      index: i,
      name: String(names[i] || id),
      title: total > 1 ? '主人' + (i + 1) : '主人',
      legacy: String(titleMap[id] || titleList[i] || ''),
    })).filter(item => item.id);
  } catch { return []; }
}
function titleOf(wxid) {
  try {
    const item = masterList().find(x => x.id === String(wxid || ''));
    return item ? item.title : '';
  } catch { return ''; }
}
function isMaster(wxid) {
  return masterList().some(item => item.id === String(wxid || ''));
}
function masterNameOf(wxid) {
  try {
    const file = path.join(require('whale').paths.appRoot, 'data', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const master = (cfg.persona && cfg.persona.master) || {};
    const ids = Array.isArray(master.wxids) ? master.wxids.map(String) : [];
    const names = Array.isArray(master.names) ? master.names : [];
    const index = ids.indexOf(String(wxid || ''));
    return index >= 0 ? String(names[index] || '') : '';
  } catch { return ''; }
}
function chatName(message) {
  if (message.chatType === 'group') return String(message.chatTitle || message.chatId || '');
  const senderId = String(message.senderId || '');
  const direct = String(message.senderName || '');
  if (direct && !direct.startsWith('wxid_')) return direct;
  // 私聊消息的 senderName 可能是空或 wxid，搜不到会话；用主人备注名兜底
  return masterNameOf(senderId) || direct || senderId || String(message.chatId || '');
}
function targetOf(order) {
  const id = String(order.group && order.group.id || '');
  if (!id) return null;
  return { id, name: String(order.group.name || id), chatType: order.chatType === 'private' ? 'private' : 'group' };
}

// 群里点歌时 chatTitle 偶尔为空，导致 order.group.name 空、语音发不出去。
// 用同一个群其它历史单里已知的群名补上，避免每次都要手工写。
function fillGroupNames(orders) {
  const names = new Map();
  for (const o of orders) {
    const id = String(o && o.group && o.group.id || '');
    if (id && o.group.name) names.set(id, String(o.group.name));
  }
  for (const o of orders) {
    const id = String(o && o.group && o.group.id || '');
    if (id && !o.group.name && names.has(id)) o.group.name = names.get(id);
  }
  return orders;
}

// 工单库里还躺着旧 RVC/网页演示单；这个插件只认自己下的 seedvc 单，避免重启后
// 把很久以前的成品重新发一遍。
function isOurs(order) {
  if (!order || order.engine !== 'seedvc' || !(order.group && order.group.id)) return false;
  if (order.via === 'proactive') return false; // 主动唱歌由 breeze-proactive 自己发，避免两个插件抢同一个单
  if (order.status === 'pending') return true; // 还没下载，source 为空
  return Boolean(order.source && /\.wav$/i.test(String(order.source)));
}

async function notifyGroup(whale, order, text) {
  const target = targetOf(order);
  if (!whale || !target) return;
  try { await whale.sendText(target.id, text, { name: target.name, chatType: target.chatType }); } catch { /* 桥没起就算了 */ }
}

const SONG_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma']);

function normName(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\s\-_·.,，。()（）【】'"“”‘’]/g, '');
}

function songsDirs(settings) {
  const dirs = [];
  if (settings && settings.dataDir) dirs.push(path.join(String(settings.dataDir), 'songs'));
  if (process.env.WHALE_COVER_DATA_DIR) dirs.push(path.join(process.env.WHALE_COVER_DATA_DIR, 'songs'));
  dirs.push(path.join(os.homedir(), '.dsh', 'whale-cover', 'songs'));
  return [...new Set(dirs)];
}

/**
 * RVC 要原曲。点歌时群友只给歌名，所以在主人本地的 songs/ 里按文件名找；
 * 找不到就明确回群，不盲目起 10 分钟的子进程。
 */
function resolveSource(order, settings) {
  if (order.source && fs.existsSync(order.source)) return order.source;
  const want = normName(order.song);
  if (!want) return '';
  let loose = '';
  for (const dir of songsDirs(settings)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!SONG_EXTS.has(path.extname(name).toLowerCase())) continue;
      const stem = normName(path.basename(name, path.extname(name)));
      if (!stem) continue;
      if (stem === want) return path.join(dir, name);
      if (!loose && (stem.includes(want) || want.includes(stem))) loose = path.join(dir, name);
    }
  }
  return loose;
}

function startRender(settings, order, source) {
  let fd = 'ignore';
  try { fd = fs.openSync(AUTO_LOG, 'a'); } catch { /* 日志开不了也不影响渲染 */ }
  const engine = settings.engine || 'rvc';
  const args = [cliPath(settings), 'render', order.id, '--engine', engine, '--json'];
  if (source) args.push('--source', source);
  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  if (fd !== 'ignore') { try { fs.closeSync(fd); } catch { /* ignore */ } }
  child.unref();
  return child.pid || 0;
}

/**
 * 没有原曲的单：起一个独立 worker 去下载 + 切副歌，再由它调 render。
 * worker 不占插件 hook 的 20 秒预算，插件只轮询订单状态。
 */
function startPrep(settings, order) {
  const prep = prepScriptPath(settings);
  if (!fs.existsSync(prep)) throw new Error('缺少 breeze-prep.mjs：' + prep);
  const python = settings.python || path.join(os.homedir(), 'whale-cover', 'engine', 'venv', 'Scripts', 'python.exe');
  const repo = path.dirname(path.dirname(cliPath(settings)));
  const repoFfmpeg = path.join(repo, 'tools', 'ffmpeg');
  const ffmpegDir = settings.ffmpeg || (fs.existsSync(path.join(repoFfmpeg, 'ffmpeg.exe')) ? repoFfmpeg : path.join(path.dirname(repo), 'tools', 'ffmpeg'));
  let fd = 'ignore';
  try { fd = fs.openSync(PREP_LOG, 'a'); } catch { /* ignore */ }
  const child = spawn(process.execPath, [prep, order.id, order.song, order.artist || ''], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: {
      ...process.env,
      BREEZE_CLI: cliPath(settings),
      BREEZE_PYTHON: python,
      BREEZE_DATA: dataRoot(settings),
      BREEZE_COOKIES: settings.neteaseCookies || path.join(dataRoot(settings), 'cookies.txt'),
      BREEZE_ENGINE: settings.engine || 'seedvc',
      BREEZE_FFMPEG_DIR: ffmpegDir,
      BREEZE_CACHE: path.join(repo, '.tmp', 'breeze-cache'),
      BREEZE_SECONDS: String(settings.maxSeconds || 54),
      BREEZE_LOG: PREP_LOG,
    },
  });
  if (fd !== 'ignore') { try { fs.closeSync(fd); } catch { /* ignore */ } }
  child.unref();
  return child.pid || 0;
}

async function deliverReady(whale, settings, order, state) {
  const target = targetOf(order);
  if (!whale || !target) return false;
  if (state.sent && state.sent[order.id]) return true;

  const result = await sendCoverVoice(settings, order, target.name || target.id);
  if (!result.ok) return false;

  state.sent = state.sent || {};
  state.sent[order.id] = Date.now();
  try {
    const delay = (Number(order.durationSec) || 30) * 1000 + 12000;
    const title = target.chatType === 'private' ? titleOf(target.id) : '';
    state.followups = Array.isArray(state.followups) ? state.followups : [];
    state.followups.push({
      id: target.id,
      name: target.name,
      text: (title ? title + '，' : '') + '我唱了《' + order.song + '》，你觉得好听吗？',
      chatType: target.chatType,
      dueAt: Date.now() + delay,
    });
    saveAuto(state);
  } catch { /* 追问发不出去不影响语音 */ }
  return true;
}

async function flushFollowups(whale, state) {
  const pending = Array.isArray(state.followups) ? state.followups : [];
  if (!pending.length) return;
  const now = Date.now();
  const keep = [];
  for (const item of pending) {
    if (Number(item.dueAt) > now) { keep.push(item); continue; }
    try {
      await whale.sendText(item.id, item.text, { name: item.name, chatType: item.chatType || 'private' });
    } catch { /* 发不出去就丢掉，不积压 */ }
  }
  state.followups = keep;
  saveAuto(state);
}

async function autoTick(whale, settings) {
  if (!whale || settings.autoRender === false) return;
  const state = loadAuto();
  await flushFollowups(whale, state);
  const out = await runCover(settings, ['list', '--status', 'pending,making,ready', '--limit', '100'], 10000);
  if (!out || !out.ok) return;
  const orders = fillGroupNames(Array.isArray(out.orders) ? out.orders : []);
  const syncPending = await syncVoice(whale, settings, state, orders);
  pruneFailedOrders(settings, state.active && state.active.id);
  const tidy = dedupeActive(orders.filter(isOurs), state.active && state.active.id);
  for (const dup of tidy.dropped) {
    if (state.active && state.active.id === dup.id) state.active = null;
    await dropOrder(settings, dup, '重复点歌，自动清理');
  }
  const ours = tidy.keep;
  const byId = new Map(ours.map((o) => [o.id, o]));
  let active = state.active && byId.get(state.active.id) ? byId.get(state.active.id) : null;
  if (active && !isOurs(active)) active = null;
  if (state.active && (!active || !isOurs(active))) { state.active = null; saveAuto(state); }


  // 内核/插件重启后 state.active 可能丢了；已经 ready 但没发过的单要补发。
  if (!active) {
    const unsent = ours.find((o) => o.status === 'ready' && !(state.sent && state.sent[o.id]));
    if (unsent) {
      state.active = { id: unsent.id, startedAt: Date.now(), recovered: true };
      saveAuto(state);
      active = unsent;
    }
  }

  if (active && active.status === 'ready') {
    const ok = await deliverReady(whale, settings, active, state);
    if (ok) {
      state.active = null;
      state.attempts = {};
      state.progressStartedAt = null;
      state.lastProgressAt = null;
      saveAuto(state);
      return;
    }
    state.attempts = state.attempts || {};
    const n = (Number(state.attempts[active.id]) || 0) + 1;
    if (n >= 3) {
      state.active = null;
      delete state.attempts[active.id];
      saveAuto(state);
      await notifyGroup(whale, active, `《${active.song}》做好了，但语音没发出去；回「唱 ${active.song}」我再试。`);
    } else {
      state.attempts[active.id] = n;
      saveAuto(state);
    }
    return;
  }
  if (active && active.status === 'failed') {
    const reason = failureReason(settings, active);
    state.active = null;
    state.progressStartedAt = null;
    state.lastProgressAt = null;
    saveAuto(state);
    await notifyGroup(whale, active, reason
      ? `《${active.song}》渲染失败：${reason}`
      : `《${active.song}》渲染失败，等会儿再点一次吧。`);
    await dropOrder(settings, active, '制作失败，自动清理');
    return;
  }
  if (active && active.status === 'canceled') { state.active = null; saveAuto(state); return; }
  if (active && active.status === 'making') {
    const age = Date.now() - Date.parse(active.updatedAt || 0);
    const started = Number(state.active && state.active.startedAt) || 0;
    const hint = renderProgress(settings, active.id);
    const beat = hint && hint.updatedAt ? Date.parse(hint.updatedAt) : Date.parse(active.updatedAt || 0);
    const idle = Date.now() - beat;
    const atEnd = !!(hint && Number(hint.total) > 0 && Number(hint.step) >= Number(hint.total));
    // 有进度文件时看心跳；超过 6 分钟没有任何新进度，说明 seed-vc 卡死/被挂起。
    // 100% 后 seed-vc 可能静默收尾几十秒，不要误杀。
    if (!atEnd && started && Date.now() - started > 5 * 60 * 1000 && idle > IDLE_STALL_MS) {
      const pid = Number(state.active && state.active.pid) || 0;
      if (pid) {
        try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 可能已经退出 */ }
      }
      state.failedAt = state.failedAt || {};
      state.failedAt[active.id] = Date.now();
      state.active = null;
      state.progressStartedAt = null;
      state.lastProgressAt = null;
      saveAuto(state);
      await notifyGroup(whale, active, `《${active.song}》渲染卡住了（${Math.round(idle / 60000)} 分钟没进度），已停掉；等会儿再点一次吧。`);
      return;
    }
    if (!(age > STALE_MS)) return; // 还在做，别插一脚
  }
  if (active && active.status === 'pending') {
    const waited = Date.now() - Number(state.active.startedAt || 0);
    // 准备阶段：下载 + 切副歌，正常 1 分钟内会变 making。
    if (state.active.prep) {
      const hint = prepStatus(settings, active.id);
      if (hint && hint.status === 'error') {
        state.failedAt = state.failedAt || {};
        state.failedAt[active.id] = Date.now();
        state.active = null;
        saveAuto(state);
        await notifyGroup(whale, active, `《${active.song}》没准备好：${String(hint.error || '').slice(0, 120)}`);
        await dropOrder(settings, active, '下载/准备失败，自动清理');
        return;
      }
      if (waited < 8 * 60 * 1000) return;
      state.failedAt = state.failedAt || {};
      state.failedAt[active.id] = Date.now();
      state.active = null;
      saveAuto(state);
      await notifyGroup(whale, active, `《${active.song}》下载/准备超时了，等会儿再点一次吧。`);
      await dropOrder(settings, active, '下载/准备超时，自动清理');
      return;
    }
    // render 正常应先 pending→making；15 秒还没动，多半是引擎没配好/起不来。
    if (waited < 15000) return;
    state.failedAt = state.failedAt || {};
    state.failedAt[active.id] = Date.now();
    state.active = null;
    saveAuto(state);
    await notifyGroup(whale, active, `《${active.song}》的引擎没起来，先让主人跑一下 cover engine status。`);
    return;
  }

  if (syncPending) return;

  // 没有在跑的单：挑「卡住的 making」或最早 pending；一次只跑一首，4GB 显存扛不住并行。
  let next = null;
  if (active && active.status === 'making') next = active;
  else {
    const blocked = state.failedAt || {};
    const cooled = (id) => Date.now() - Number(blocked[id] || 0) < 10 * 60 * 1000;
    const pending = ours.filter((o) => o.status === 'pending' && !cooled(o.id))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const stale = ours.filter((o) => o.status === 'making' && !cooled(o.id)
      && Date.now() - Date.parse(o.updatedAt || 0) > STALE_MS)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    next = stale[0] || pending[0] || null;
  }
  if (!next) return;

  // 没有原曲：交给 breeze-prep 下载 + 切副歌，它渲染前会自己调 cover render。
  if (!next.source) {
    const hint = prepStatus(settings, next.id);
    if (hint && hint.status === 'error') {
      state.failedAt = state.failedAt || {};
      state.failedAt[next.id] = Date.now();
      state.active = null;
      saveAuto(state);
      await notifyGroup(whale, next, `《${next.song}》没准备好：${String(hint.error || '').slice(0, 120)}`);
      await dropOrder(settings, next, '下载/准备失败，自动清理');
      return;
    }
    try {
      const pid = startPrep(settings, next);
      state.active = { id: next.id, startedAt: Date.now(), pid, prep: true };
      state.progressStartedAt = Date.now();
      state.lastProgressAt = Date.now();
      saveAuto(state);
    } catch (error) {
      state.failedAt = state.failedAt || {};
      state.failedAt[next.id] = Date.now();
      state.active = null;
      saveAuto(state);
      await notifyGroup(whale, next, `《${next.song}》起不来：${String(error && error.message || error).slice(0, 100)}`);
    }
    return;
  }

  const source = resolveSource(next, settings);
  if (!source) {
    state.active = null;
    state.failedAt = state.failedAt || {};
    state.failedAt[next.id] = Date.now();
    saveAuto(state);
    const dir = songsDirs(settings)[0];
    await notifyGroup(whale, next, `《${next.song}》找不到原曲，先把音频放进 ${dir} 再点一次；文件名起成歌名最省事。`);
    return;
  }
  const pid = startRender(settings, next, source);
  state.active = { id: next.id, startedAt: Date.now(), pid };
  state.progressStartedAt = Date.now();
  state.lastProgressAt = Date.now();
  saveAuto(state);
}

function cleanText(raw) {
  let text = String(raw || '')
    .replace(/\[CQ:at,[^\]]*\]/g, ' ')
    .replace(/@[^\s@，,。:：]{1,32}/g, ' ')
    .trim();
  return text;
}

/** 「点歌 起风了 - 买辣椒也用券（女声）」→ { song, artist, note } */
function commandText(raw) {
  const text = cleanText(raw);
  if (text.length <= 60) return text;
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (SING_RE.test(line) || ORDER_RE.test(line) || CANCEL_RE.test(line)
      || HELP_WORDS.includes(line) || LIST_WORDS.includes(line)
      || GIVE_RE.test(line) || GIVE_SONG_RE.test(line)) return line;
  }
  return text;
}
function parseOrder(text) {
  const m = ORDER_RE.exec(text);
  if (!m) return null;
  let rest = String(m[1] || '').trim();
  if (!rest) return { help: true };
  let note = '';
  const noteMatch = /[（(]([^（）()]{1,40})[）)]\s*$/.exec(rest);
  if (noteMatch) {
    note = noteMatch[1].trim();
    rest = rest.slice(0, noteMatch.index).trim();
  }
  let artist = '';
  // 只在明确的「空格+分隔符+空格」处拆原唱；空格本身属于歌名（See You Again）。
  const sep = /\s+[-—–·|｜]\s+|\s*[·|｜]\s*/.exec(rest);
  if (sep && sep.index > 0) {
    artist = rest.slice(sep.index + sep[0].length).trim();
    rest = rest.slice(0, sep.index).trim();
  }
  const song = rest.replace(/^《|》$/g, '').trim();
  if (!song || song.length > 100) return null;
  return { song, artist: artist.replace(/^《|》$/g, ''), note };
}

// 桥靠「昵称/群名」去微信搜索框里找会话；私聊的 chatId 是内部 id，搜不到
function nameFor(message) {
  const isGroup = message.chatType === 'group';
  if (isGroup) return message.chatTitle || message.chatId;
  // 私聊的 senderName 可能为空/是 wxid，桥接按 wxid 搜不到会直接失败；用主人备注名兜底
  return chatName(message);
}

function chatFor(message) {
  const isGroup = message.chatType === 'group';
  return isGroup ? message.chatId : (message.senderId || message.chatId);
}

async function reply(whale, message, text) {
  try {
    await whale.sendText(chatFor(message), text, {
      name: nameFor(message),
      chatType: message.chatType === 'group' ? 'group' : 'private',
    });
  } catch { /* 桥没起时静默，别把插件挂掉 */ }
}

function okText(order, position) {
  const pos = Number(position) || 0;
  const tail = pos ? `排第 ${pos} 位` : '排队里';
  return `收到～《${order.song}》${tail}，我自己找原曲，做好发语音。`;
}

async function handleOrder(whale, message, settings, parsed) {
  const me = String(message.senderName || message.senderId || '群友');
  const key = [message.chatId, message.senderId || me, message.msgId || parsed.song].join('|');
  const now = Date.now();
  for (const [k, ts] of recent) if (now - ts > 60000) recent.delete(k);
  if (recent.has(key)) return true;
  recent.set(key, now);

  const targetId = chatKey(message);
  const targetName = chatName(message);
  const args = [
    'order',
    '--song', parsed.song,
    '--requester', me,
    '--via', chatTypeOf(message),
    '--chat-type', chatTypeOf(message),
    '--engine', settings.engine || 'seedvc',
    '--group-id', String(targetId || ''),
  ];
  if (targetName) args.push('--group-name', String(targetName));
  if (parsed.artist) args.push('--artist', parsed.artist);
  if (parsed.note) args.push('--note', parsed.note);
  if (message.senderId) args.push('--wxid', String(message.senderId));

  const isPrivate = chatTypeOf(message) === 'private';
  if (isPrivate) await reply(whale, message, '是《' + parsed.song + '》对吧，我先找原曲～');
  const out = await runCover(settings, args, 15000);
  if (!out || !out.ok) {
    await reply(whale, message, '这张单没接住，等会儿再点一次。');
    return true;
  }
  if (!isPrivate) await reply(whale, message, okText(out.order, out.position));
  return true;
}

function groupOn(cfg) {
  return cfg && cfg.channels && cfg.channels.wechat && cfg.channels.wechat.groups;
}

const ACTIVE_STATUSES = ['pending', 'making', 'ready'];
const STATUS_RANK = { ready: 3, making: 2, pending: 1 };

function orderKey(order) {
  return [
    String((order.group && order.group.id) || ''),
    normName(order.song),
    normName(order.artist),
  ].join('|');
}

/** 同一群、同歌名+歌手只保留一条：成品优先，其次制作中，再其次排队；其余自动撤掉。 */
function dedupeActive(orders, activeId) {
  const groups = new Map();
  for (const o of orders) {
    if (!ACTIVE_STATUSES.includes(o.status)) continue;
    const key = orderKey(o);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const keep = [];
  const dropped = [];
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const rankA = a.id === activeId ? 4 : (STATUS_RANK[a.status] || 0);
      const rankB = b.id === activeId ? 4 : (STATUS_RANK[b.status] || 0);
      const rank = rankB - rankA;
      if (rank) return rank;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
    keep.push(list[0]);
    dropped.push(...list.slice(1));
  }
  return { keep, dropped };
}

async function dropOrder(settings, order, reason) {
  try {
    await runCover(settings, ['cancel', order.id, '--reason', reason], 10000);
  } catch { /* 已经终态就继续删文件 */ }
  try {
    fs.rmSync(path.join(dataRoot(settings), 'orders', order.id + '.json'), { force: true });
  } catch { /* 删不掉下次 tick 再试 */ }
}

/** 清掉做失败的单；它们已经在群里提示过，留在点歌单里只会越攒越多。 */
function pruneFailedOrders(settings, keepId) {
  let removed = 0;
  const dir = path.join(dataRoot(settings), 'orders');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const order = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (order.status === 'failed' && order.id !== keepId) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    } catch { /* 坏文件不碰 */ }
  }
  return removed;
}

function failureReason(settings, order) {
  try {
    const file = path.join(dataRoot(settings), 'orders', order.id + '.json');
    const latest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const events = Array.isArray(latest.events) ? latest.events : [];
    const last = [...events].reverse().find((e) => e && e.note && /fail|error|失败|错/i.test(String(e.status) + String(e.note)));
    return String((last && last.note) || latest.note || '').replace(/\s+/g, ' ').slice(0, 160);
  } catch { return ''; }
}

async function handleList(whale, message, settings) {
  const out = await runCover(settings, ['list', '--limit', '100'], 15000);
  if (!out || !out.ok) {
    await reply(whale, message, '队列暂时读不出来。');
    return;
  }
  const mine = (out.orders || []).filter((o) => !o.group || !o.group.id || String(o.group.id) === String(chatKey(message)));
  const { keep } = dedupeActive(mine);
  const active = keep.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (!active.length) {
    await reply(whale, message, '这个群还没人点歌，发「点歌 歌名」试试。');
    return;
  }
  const label = { pending: '排队', making: '制作中', ready: '待投递' };
  const parts = active.slice(0, 5).map((o) => {
    const artist = o.artist ? ' / ' + o.artist : '';
    const who = o.requester ? ' ← ' + o.requester : '';
    return `《${o.song}》${artist}${who}（${label[o.status] || o.status}）`;
  });
  let text = '本群点歌单：' + parts.join('；');
  if (active.length > 5) text += `；…… 还有 ${active.length - 5} 首`;
  await reply(whale, message, text);
}

async function handleCancel(whale, message, settings, wanted) {
  const out = await runCover(settings, ['list', '--limit', '100'], 15000);
  if (!out || !out.ok) {
    await reply(whale, message, '队列暂时读不出来。');
    return;
  }
  const names = new Set([message.senderName, message.senderId].filter(Boolean).map(String));
  const mine = (out.orders || []).filter((o) => ['pending', 'making'].includes(o.status)
    && (names.has(String(o.wxid || '')) || names.has(String(o.requester || '')))
    && (!o.group || !o.group.id || String(o.group.id) === String(chatKey(message))));
  const target = mine.find((o) => o.song === wanted) || (mine.length === 1 && !wanted ? mine[0] : null);
  if (!target) {
    await reply(whale, message, wanted ? `没找到你点的《${wanted}》。` : '你现在没有在排队的歌。');
    return;
  }
  const res = await runCover(settings, ['cancel', target.id], 15000);
  await reply(whale, message, res && res.ok ? `好，撤掉《${target.song}》。` : '撤单失败，晚点再说。');
}

/**
 * 「唱 起风了」：把已经做好的成品，通过鲸鲸的语音链路唱出来。
 *
 * 做法不是发文件（插件也没有发文件的能力），而是让鲸鲸照常「发语音」：
 * 语音里那句文本实际是 [[cover:<单号>]]，本机语音桥把它换成成品音频，
 * 播放进虚拟声卡 → 微信录成语音。见 whale-plugin/voice-bridge.mjs。
 */
async function handleSing(whale, message, settings, wanted) {
  const out = await runCover(settings, ['list', '--limit', '100'], 15000);
  if (!out || !out.ok) {
    await reply(whale, message, '队列暂时读不出来。');
    return;
  }
  const ready = (out.orders || []).filter((o) => ['ready', 'delivered'].includes(o.status)
    && (o.hasAudio || o.durationSec));
  const mine = ready.filter((o) => !o.group || !o.group.id || String(o.group.id) === String(chatKey(message)));
  const want = String(wanted || '').trim();
  const findBy = (list) => (want
    ? list.find((o) => o.id === want) || list.find((o) => o.song === want) || list.find((o) => o.song.includes(want))
    : list[0]);
  const target = findBy(mine) || findBy(ready);
  if (!target) {
    await reply(whale, message, want
      ? `《${want}》还没唱好，等做好了再喊我。`
      : '这里还没有唱好的歌，先点一首吧。');
    return;
  }

  try {
    const isGroup = message.chatType === 'group';
    const sent = await sendCoverVoice(settings, target, nameFor(message));
    if (!sent.ok) throw new Error(sent.error || '发送失败');
    const followTitle = isGroup ? '' : titleOf(chatFor(message));
    const state = loadAuto();
    state.followups = Array.isArray(state.followups) ? state.followups : [];
    state.followups.push({
      id: chatFor(message),
      name: nameFor(message),
      text: (followTitle ? followTitle + '，' : '') + '我唱了《' + target.song + '》，你觉得好听吗？',
      chatType: isGroup ? 'group' : 'private',
      dueAt: Date.now() + (Number(target.durationSec) || 30) * 1000 + 12000,
    });
    saveAuto(state);
  } catch {
    await reply(whale, message, '这段没发出去，等会儿再试。');
    return;
  }
}

async function handleGive(whale, message, settings, targetWord, songWord) {
  if (!isMaster(message.senderId)) {
    await reply(whale, message, '只有主人可以让我唱给别人听。');
    return;
  }
  const list = masterList();
  const key = String(targetWord || '').trim();
  const target = (key === '主人' && list.length === 1) ? list[0]
    : list.find(item => item.title === key || item.name === key || item.legacy === key
      || (item.legacy && item.legacy.includes(key))
      || (item.title && item.title.includes(key)) || (item.name && item.name.includes(key)));
  if (!target) {
    await reply(whale, message, '没找到「' + key + '」，我只认识：' + list.map(item => item.title || item.name).join('、'));
    return;
  }
  const out = await runCover(settings, ['list', '--limit', '100'], 15000);
  if (!out || !out.ok) {
    await reply(whale, message, '队列暂时读不出来。');
    return;
  }
  const ready = (out.orders || []).filter(o => ['ready', 'delivered'].includes(o.status)
    && (o.hasAudio || o.durationSec));
  const song = String(songWord || '').trim();
  const order = song
    ? ready.find(o => o.song === song) || ready.find(o => o.song.includes(song))
    : ready[ready.length - 1];
  if (!order) {
    await reply(whale, message, song ? '《' + song + '》还没唱好。' : '还没有唱好的歌。');
    return;
  }
  const from = String(message.senderName || '主人');
  try {
    await whale.sendText(target.id, from + '让我把这首《' + order.song + '》唱给你听～',
      { name: target.name, chatType: 'private' });
    const sent = await sendCoverVoice(settings, order, target.name || target.legacy || target.id);
    if (!sent.ok) throw new Error(sent.error || '发送失败');
    const delay = (Number(order.durationSec) || 30) * 1000 + 12000;
    const state = loadAuto();
    state.followups = Array.isArray(state.followups) ? state.followups : [];
    state.followups.push({
      id: target.id,
      name: target.name,
      text: (target.title || target.name) + '，我唱了《' + order.song + '》，你觉得好听吗？',
      dueAt: Date.now() + delay,
    });
    saveAuto(state);
  } catch {
    await reply(whale, message, '没发出去，等会儿再试。');
    return;
  }
  await reply(whale, message, '好，《' + order.song + '》已安排给' + (target.title || target.name) + '，35 秒内微信保持前台；没收到就再发一次。');
}

// ===== 闲时主动唱歌（可单主人/双主人） =====
const PROACTIVE_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma']);

function proactiveStatePath() {
  return path.join(require('whale').paths.pluginData, 'proactive-state.json');
}
function proactiveLoad() {
  try { return JSON.parse(fs.readFileSync(proactiveStatePath(), 'utf8')) || {}; } catch { return {}; }
}
function proactiveSave(state) {
  try { fs.writeFileSync(proactiveStatePath(), JSON.stringify(state)); } catch { /* ignore */ }
}
function proactiveDay() { return new Date().toISOString().slice(0, 10); }
function proactiveHhmm() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function proactiveQuiet(settings) {
  const start = String(settings.proactiveQuietStart || '22:30');
  const end = String(settings.proactiveQuietEnd || '09:00');
  const now = proactiveHhmm();
  return start <= end ? (now >= start && now < end) : (now >= start || now < end);
}
async function proactiveIdleOk(whale, settings) {
  try {
    const res = await whale.api('/api/status');
    const gateway = res && res.body && res.body.gateways && res.body.gateways[0];
    if (!gateway) return false;
    const last = Number(gateway.lastMessageAt) || 0;
    const minutes = Math.max(5, Number(settings.proactiveIdleMinutes) || 120);
    if (!last) return true;
    if (Date.now() - last < minutes * 60000) return false;
    return !!(gateway.bridge && gateway.bridge.online && gateway.bridge.uia);
  } catch { return false; }
}
function proactiveSongList(settings) {
  try {
    const dir = path.join(dataRoot(settings), 'songs');
    return fs.readdirSync(dir).filter(name => PROACTIVE_EXTS.has(path.extname(name).toLowerCase()))
      .map(name => ({ file: name, key: path.basename(name, path.extname(name)) }));
  } catch { return []; }
}
function scheduleFollowup(state, chatId, name, text, delayMs, chatType) {
  state.followups = Array.isArray(state.followups) ? state.followups : [];
  state.followups.push({ id: chatId, name, text, chatType: chatType || 'private', dueAt: Date.now() + delayMs });
}
async function proactiveDeliver(whale, settings, order, target) {
  try {
    await whale.sendText(target.id, '突然想唱首歌给你听～《' + order.song + '》', {
      name: target.name, chatType: 'private',
    });
    const sent = await sendCoverVoice(settings, order, target.name || target.id);
    if (!sent.ok) throw new Error(sent.error || '发送失败');
    const state = loadAuto();
    scheduleFollowup(state, target.id, target.name,
      (target.title ? target.title + '，' : '') + '我唱了《' + order.song + '》，你听听看喜欢吗～',
      (Number(order.durationSec) || 30) * 1000 + 15000, 'private');
    saveAuto(state);
    return true;
  } catch { return false; }
}
async function proactiveTick(whale, settings) {
  if (!whale || settings.proactiveEnabled === false) return;
  if (settings.autoRender === false) return;
  const listed = await runCover(settings, ['list', '--status', 'pending,making,ready', '--limit', '100'], 10000);
  if (!listed || !listed.ok) return;
  const orders = Array.isArray(listed.orders) ? listed.orders : [];
  const masters = masterList();
  if (!masters.length) return;
  const st = proactiveLoad();
  const today = proactiveDay();
  if (st.day !== today) { st.day = today; st.count = 0; }

  if (st.active && st.active.id) {
    const order = orders.find(o => o.id === st.active.id);
    if (!order) st.active = null;
    else if (order.status === 'ready') {
      const target = st.active.target || masters[0];
      if (await proactiveDeliver(whale, settings, order, target)) {
        st.sung = st.sung || {};
        st.sung[order.song] = Date.now();
        st.count = (Number(st.count) || 0) + 1;
        st.lastAt = Date.now();
        if (!st.delivered) st.delivered = {};
        st.delivered[order.id] = Date.now();
        st.active = null;
      }
    } else if (order.status === 'failed' || order.status === 'canceled') {
      st.active = null;
    }
    proactiveSave(st);
    if (st.active) return;
  }

  if (proactiveQuiet(settings)) return;
  if ((Number(st.count) || 0) >= Math.max(1, Number(settings.proactiveDailyMax) || 2)) return;
  if (st.lastAt && Date.now() - st.lastAt < (Number(settings.proactiveCooldownMinutes) || 360) * 60000) return;
  if (!(await proactiveIdleOk(whale, settings))) return;

  const sung = st.sung || {};
  const readySongs = new Set(orders.filter(o => o.status === 'ready').map(o => o.song));
  const ready = orders.filter(o => o.status === 'ready' && (o.hasAudio || o.durationSec)
    && !sung[o.song] && !(st.delivered && st.delivered[o.id]));
  if (ready.length) {
    const order = ready[ready.length - 1];
    const target = masters[(Number(st.targetIndex) || 0) % masters.length];
    if (await proactiveDeliver(whale, settings, order, target)) {
      st.sung = sung;
      st.sung[order.song] = Date.now();
      st.count = (Number(st.count) || 0) + 1;
      st.lastAt = Date.now();
      if (!st.delivered) st.delivered = {};
      st.delivered[order.id] = Date.now();
      st.targetIndex = (Number(st.targetIndex) || 0) + 1;
    }
    proactiveSave(st);
    return;
  }

  const pool = proactiveSongList(settings).filter(s => !sung[s.key] && !readySongs.has(s.key));
  let songName = pool.length ? pool[Math.floor(Math.random() * pool.length)].key : '';
  if (!songName && settings.allowDownload !== false) {
    const cands = (Array.isArray(settings.downloadCandidates) ? settings.downloadCandidates : [])
      .filter(n => n && !sung[n] && !readySongs.has(n));
    if (cands.length) songName = cands[Math.floor(Math.random() * cands.length)];
  }
  if (!songName) return;

  const target = masters[(Number(st.targetIndex) || 0) % masters.length];
  const out = await runCover(settings, ['order', '--song', songName, '--requester', '鲸鲸',
    '--via', 'proactive', '--chat-type', 'private',
    '--engine', settings.engine || 'seedvc',
    '--group-id', target.id, '--group-name', target.name], 15000);
  if (!out || !out.ok) return;
  let pid = 0;
  try { pid = startPrep(settings, out.order); } catch { pid = 0; }
  st.active = { id: out.order.id, song: out.order.song, at: Date.now(), pid, target };
  st.targetIndex = (Number(st.targetIndex) || 0) + 1;
  proactiveSave(st);
}


module.exports = {
  parseOrder,
  hooks: {
    async 'chat.pre_reply'(input) {
      const whale = input.whale;
      const message = input.message || {};
      const settings = input.settings || {};
      if (!whale || !message.text) return { action: 'pass' };
      if (settings.onlyGroup !== false && message.chatType !== 'group') {
        // 私聊默认不接管点歌，但「唱 歌名」要能用：语音翻唱在私聊里最方便验货
        const privateSing = SING_RE.exec(cleanText(message.text));
        if (!privateSing) return { action: 'pass' };
        await handleSing(whale, message, settings, privateSing[1].trim());
        return { action: 'skip' };
      }

      const text = commandText(message.text);
      if (!text) return { action: 'pass' };

      if (HELP_WORDS.includes(text)) {
        await reply(whale, message, MENU_TEXT);
        return { action: 'skip' };
      }
      if (LIST_WORDS.includes(text)) {
        await handleList(whale, message, settings);
        return { action: 'skip' };
      }
      const cancel = CANCEL_RE.exec(text);
      if (cancel) {
        await handleCancel(whale, message, settings, cancel[1].trim());
        return { action: 'skip' };
      }
      const giveSong = GIVE_SONG_RE.exec(text);
      const givePlain = giveSong ? null : GIVE_RE.exec(text);
      if (giveSong || givePlain) {
        await handleGive(whale, message, settings,
          giveSong ? giveSong[2] : givePlain[1],
          giveSong ? giveSong[1] : '');
        return { action: 'skip' };
      }
      const sing = SING_RE.exec(text);
      if (sing) {
        await handleSing(whale, message, settings, sing[1].trim());
        return { action: 'skip' };
      }
      const parsed = parseOrder(text);
      if (!parsed) return { action: 'pass' };
      if (parsed.help) {
        await reply(whale, message, MENU_TEXT);
        return { action: 'skip' };
      }
      await handleOrder(whale, message, settings, parsed);
      return { action: 'skip' };
    },

    // 后台队列：宿主每 intervalSeconds 调一次；这里只做「查状态 / 起进程 / 发语音」，
    // 真正渲染在独立子进程里跑，避免 hook 超时把 worker 和 10 分钟的渲染一起杀掉。
    async 'timer.tick'(input) {
      try {
        await autoTick(input.whale, input.settings || {});
        await proactiveTick(input.whale, input.settings || {});
      } catch (e) {
        try { fs.appendFileSync(AUTO_LOG, `[${new Date().toISOString()}] timer.tick: ${e && e.message || e}\n`); } catch { /* ignore */ }
      }
      return {};
    },
  },
};
