'use strict';

/**
 * 鲸鲸（whale-girl / WhaleGirl v4.x）插件：breezeblue-sing 点歌翻唱。
 *
 * 群友发「点歌 起风了」后：
 *   1. 落单（cover order），由 timer.tick 起 breeze-prep.mjs；
 *   2. breeze-prep 获取原曲，普通点歌渲染整首并在停顿处分段；
 *   3. 成品出来后直接 spawn 运行时里的 send_cover.py，把本地音频发成语音（不依赖宿主补丁）；
 *      它换成 breezeblue 音色的翻唱音频，录成微信语音发回群里。
 */

const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI_CANDIDATES = [
  path.join(os.homedir(), 'whale-cover', 'tools', 'cover.mjs'),
  path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-whale-cover', 'tools', 'cover.mjs'),
];

const PREFIXES = ['点歌', '点播', '来一首', '來一首', 'cover'];
const HELP_WORDS = ['点歌帮助', '点歌说明', '点歌菜单', '点歌玩法'];
const LIST_WORDS = ['点歌单', '点歌列表', '歌单', '点歌进度', '排队'];
const CANCEL_RE = /^取消(?:点歌|点播)\s*(.*)$/;
const SING_RE = /^(?:唱|唱一个|唱一首|来一段|发歌|发一下|听歌|听听)\s*[:：]?\s*(.*)$/;
const LIKED_ORDER = /^(?:(?:点歌|点播|来一首)\s*)?(?:从我喜欢里?随便挑一首唱?|从我喜欢里?挑一首唱?|我喜欢的|喜欢的歌|随便挑一首喜欢的唱?)$/;
const ORDER_RE = new RegExp('^(?:' + PREFIXES.join('|') + ')[\\s:：,，]*(.*)$', 'i');

// 微信 UIA 发送会把换行压成空格，菜单必须写成一行，用「；」分隔。
const MENU_TEXT = '点歌：点歌 歌名；指定原唱：点歌 歌名 - 歌手；整首翻唱，按人声停顿分多条语音；看队列：点歌单；撤单：取消点歌 歌名';

const recent = new Map(); // `${chatId}|${senderId}|${song}` -> ts，防微信重推导致重复落单

function cliPath(settings) {
  const custom = settings && typeof settings.coverCli === 'string' ? settings.coverCli.trim() : '';
  if (custom && fs.existsSync(custom)) return custom;
  for (const candidate of CLI_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return CLI_CANDIDATES[0];
}

function runCover(settings, args, timeoutMs) {
  return new Promise((resolve) => {
    const cli = cliPath(settings);
    execFile(process.execPath, [cli, ...args, '--json'], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, WHALE_COVER_DATA_DIR: dataRoot(settings) },
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
    'H:\\dshvx\\WhaleGirl',
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

function newestRefAfter(settings, ts) {
  try {
    const dir = path.join(dataRoot(settings), 'voice-ref');
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
  const ref = newestRefAfter(settings, Number(state.voiceChangedAt) - 120000);
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
  return path.join(runtimeRoot(settings), 'data');
}

function runtimeRoot(settings) {
  return path.dirname(path.dirname(cliPath(settings)));
}

function voiceTarget(id, name, chatType) {
  const title = String(name || '').trim();
  if (!id || id === 'anonymous' || id === 'default' || !title || title === id || title === '-' || title === '群友'
    || /^(?:wxid_|gh_)/i.test(title) || /@chatroom$/i.test(title)
    || !['private', 'group'].includes(chatType)) return null;
  return { id, name: title, chatType };
}

function deliveryFile(settings, orderId, target, requestId = '') {
  const key = crypto.createHash('sha256')
    .update(JSON.stringify([orderId, target.chatType, target.id, requestId])).digest('hex');
  return path.join(dataRoot(settings), 'voice-delivery', key + '.json');
}

function deliveryStatus(file) {
  try {
    const stat = fs.statSync(file);
    const status = JSON.parse(fs.readFileSync(file, 'utf8')).status;
    if (status === 'pending') return Date.now() - stat.mtimeMs < 120000 ? 'pending' : 'uncertain';
    return ['sent', 'failed', 'uncertain'].includes(status) ? status : 'uncertain';
  } catch (error) {
    return error.code === 'ENOENT' ? 'new' : 'uncertain';
  }
}

// 录音可以超过 hook 的预算。先独占占位，再由独立发送器写入结果。
function sendCoverFile(settings, target, wav, file, request = '') {
  const root = runtimeRoot(settings);
  const py = settings.voicePython || path.join(root, 'voice', 'venv', 'Scripts', 'python.exe');
  const script = settings.voiceSender || path.join(root, 'voice', 'send_cover.py');
  if (!fs.existsSync(py) || !fs.existsSync(script)) return 'failed';
  const wavPath = path.resolve(dataRoot(settings), String(wav || ''));
  if (!wav || !fs.statSync(wavPath, { throwIfNoEntry: false })?.isFile()) return 'failed';

  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ status: 'pending', request }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') return deliveryStatus(file);
    throw error;
  }
  const failStart = () => {
    try { fs.writeFileSync(file, JSON.stringify({ status: 'failed', request })); }
    catch { /* 保留占位，超时后按不确定处理 */ }
  };
  try {
    const child = spawn(py, [script, '--wav', wavPath, '--chat', target.name,
      '--chat-type', target.chatType, '--result-file', file], {
      detached: true, windowsHide: false, stdio: 'ignore',
    });
    child.once('error', failStart);
    child.unref();
    return 'pending';
  } catch {
    failStart();
    return 'failed';
  }
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
  const stopped = state.voiceStopped || {};
  for (const [id, at] of Object.entries(stopped)) if (!(Number(at) > cutoff)) delete stopped[id];
  state.voiceStopped = stopped;
  const temporary = AUTO_STATE + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, AUTO_STATE);
    return true;
  } catch { return false; }
  finally { try { fs.unlinkSync(temporary); } catch { /* 已提交或未创建 */ } }
}

function groupTarget(order) {
  const id = String(order.group && order.group.id || '');
  if (!id) return null;
  const chatType = order.chatType === 'private' || !/@chatroom$/i.test(id) && order.wxid === id
    ? 'private' : 'group';
  return { id, name: String(order.group.name || id), chatType };
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
  if (!order || order.via === 'proactive' || order.via === PROACTIVE_VIA || order.via === RELAY_SONG_VIA
    || order.engine !== 'seedvc' || !(order.group && order.group.id)) return false;
  if (order.status === 'pending') return true; // 还没下载，source 为空
  return Boolean(order.source && (order.fullTrack === true || /\.wav$/i.test(String(order.source))));
}

async function notifyGroup(whale, order, text) {
  const target = groupTarget(order);
  if (!whale || !target) return;
  const voice = await resolveVoiceTarget(whale, target.id, target.name, target.chatType);
  try {
    await whale.sendText(target.id, text, { name: voice?.name || target.name, chatType: target.chatType });
  } catch { /* 桥没起就算了 */ }
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
  args.push('--full');
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
function startPrep(settings, order, proactiveSource) {
  const prep = prepScriptPath(settings);
  if (!fs.existsSync(prep)) throw new Error('缺少 breeze-prep.mjs：' + prep);
  const python = settings.python || path.join(runtimeRoot(settings), 'engine', 'venv', 'Scripts', 'python.exe');
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
      BREEZE_ENGINE: settings.engine || 'seedvc',
      BREEZE_FFMPEG_DIR: ffmpegDir,
      BREEZE_CACHE: path.join(repo, '.tmp', 'breeze-cache'),
      BREEZE_SECONDS: String(settings.maxSeconds || 30),
      BREEZE_LOG: PREP_LOG,
      BREEZE_FULL_SONG: '1',
      BREEZE_COOKIES: settings.neteaseCookies || process.env.BREEZE_COOKIES || path.join(repo, 'cookies.txt'),
      ...(proactiveSource ? {
        BREEZE_SOURCE_FILE: proactiveSource.file || '',
        BREEZE_LOCAL_ONLY: proactiveSource.file || settings.proactiveAllowDownload !== true ? '1' : '0',
      } : {}),
    },
  });
  if (fd !== 'ignore') { try { fs.closeSync(fd); } catch { /* ignore */ } }
  child.unref();
  return child.pid || 0;
}

// 每段使用独立回执；只有确认前一段后，下一段才允许启动。
function playlistParts(order) {
  const parts = order.audioParts;
  if (!order.fullTrack || !Array.isArray(parts) || !parts.length) return null;
  let first = 0;
  const rate = parts[0]?.sampleRate;
  if (!Number.isSafeInteger(rate) || rate < 8000) return null;
  for (const part of parts) {
    if (!part?.audio || part.sampleRate !== rate || part.startFrame !== first
      || !Number.isSafeInteger(part.endFrame) || part.endFrame <= first
      || part.endFrame - first > 56 * rate) return null;
    first = part.endFrame;
  }
  return Math.abs(first / rate - order.durationSec) <= 0.02 ? parts : null;
}

const LONG_FORMAT = /^点歌格式\s+([a-f0-9]{8})\s+(WAV|语音)$/i;
const registeredFormatOffers = new Set();

function longTrack(order) {
  return order.fullTrack === true && Number.isFinite(order.durationSec) && order.durationSec > 120;
}

async function canSendSongWave(whale) {
  try { return (await whale.capabilities())?.singWave === true; }
  catch { return false; }
}

async function canOfferSongFormats(whale) {
  try { return (await whale.capabilities())?.singFormatChoice === true; }
  catch { return false; }
}

async function waveReceipt(whale, id) {
  if (!id) return 'uncertain';
  try {
    const receipt = await whale.delivery(id);
    if (['queued', 'sending'].includes(receipt?.status)) return 'pending';
    if (receipt?.confirmed === true && receipt?.status === 'confirmed') return 'sent';
    return ['failed', 'cancelled'].includes(receipt?.status) ? 'failed' : 'uncertain';
  } catch { return 'uncertain'; }
}

function longFormatPrompt(order) {
  return '《' + order.song + '》唱好啦！你想要整首音频文件，还是我分 '
    + order.audioParts.length + ' 条语音发给你？';
}

async function offerLongFormat(whale, order, state) {
  if (!registeredFormatOffers.has(order.id)) {
    try {
      const result = await whale.send({ type: 'sing-format-offer', orderId: order.id });
      if (result?.offered !== true) return;
      registeredFormatOffers.add(order.id);
    } catch { return; }
  }
  const selection = state.longFormats[order.id];
  if (selection.announced) return;
  selection.announced = true;
  if (saveAuto(state)) await notifyGroup(whale, order, longFormatPrompt(order));
}

async function restoreFormatOffers(whale, settings, state) {
  for (const [id, selection] of Object.entries(state.longFormats || {})) {
    if (selection.status !== 'offered' || registeredFormatOffers.has(id) && selection.announced) continue;
    const order = readRuntimeOrder(settings, id);
    if (order?.status !== 'ready' || !playlistParts(order)) continue;
    await offerLongFormat(whale, order, state);
    break;
  }
}

async function lookupNaturalFormat(whale, text) {
  if (!/文件|wav|语音|分段|整首/i.test(text)
    || !Object.values(loadAuto().longFormats || {}).some(selection => selection.status === 'offered')) return null;
  try { return await whale.send({ type: 'sing-format-lookup' }); }
  catch { return null; }
}

async function handleLongFormat(whale, message, settings, id, mode) {
  const order = readRuntimeOrder(settings, id);
  const state = loadAuto();
  const existing = state.longFormats?.[id];
  const chat = order && groupTarget(order);
  if (!existing || order?.status !== 'ready' || !longTrack(order) || !chat
    || chat.id !== message.chatId || chat.chatType !== message.chatType
    || !message.senderId || order.wxid !== message.senderId) {
    await reply(whale, message, '这条格式选择需要由点歌人在原会话里回复。');
    return;
  }
  if (existing.status !== 'offered') {
    await notifyGroup(whale, order, '这首歌已经选择过发送格式，请核对聊天里的发送结果。');
    return;
  }
  if (mode === '语音') {
    const target = await resolveVoiceTarget(whale, chat.id, chat.name, chat.chatType);
    if (!target || !playlistParts(order)) {
      await notifyGroup(whale, order, '语音暂时无法发送，可以重新选择 WAV。');
      return;
    }
    const queued = enqueuePlaylist(settings, order, target, 'long-format-' + id);
    if (!['new', 'existing'].includes(queued)) {
      await notifyGroup(whale, order, '上一轮语音发送结果不确定，请先核对聊天。');
      return;
    }
    state.longFormats[id] = { status: 'voice', at: existing.at };
    saveAuto(state);
    registeredFormatOffers.delete(id);
    try { await whale.send({ type: 'sing-format-close', orderId: id }); } catch { /* 语音请求已入队 */ }
    await notifyGroup(whale, order, '好，我分几条语音给你发过去。');
    return;
  }
  if (!await canSendSongWave(whale)) {
    await notifyGroup(whale, order, '附件通道暂时不可用，可以重新选择分段语音。');
    return;
  }
  state.longFormats[id] = { status: 'wave', at: existing.at };
  if (!saveAuto(state)) {
    await notifyGroup(whale, order, '暂时写不了发送记录，WAV 没有排入队列。');
    return;
  }
  try {
    const delivery = await whale.send({ type: 'sing-wav', orderId: id });
    state.longFormats[id].deliveryId = delivery?.id;
    saveAuto(state);
    registeredFormatOffers.delete(id);
  } catch (error) {
    if (/^host_sing_wave_|^host_invalid_sing_wave_/.test(String(error?.code || ''))) {
      state.longFormats[id] = existing;
      saveAuto(state);
      await notifyGroup(whale, order, 'WAV 附件没有排入队列，可以重新选择分段语音。');
    }
  }
}

async function checkLongWaveReceipts(whale, settings, state) {
  for (const [id, selection] of Object.entries(state.longFormats || {})) {
    if (selection.status !== 'wave') continue;
    const status = await waveReceipt(whale, selection.deliveryId);
    if (status === 'pending') continue;
    selection.status = status;
    saveAuto(state);
    const order = readRuntimeOrder(settings, id);
    if (order) {
      const notice = status === 'sent'
        ? '《' + order.song + '》的整首音频给你发过去啦。'
        : '《' + order.song + '》的文件我没能确认发过去，你先看看聊天里有没有收到。';
      await notifyGroup(whale, order, notice);
    }
    break;
  }
}

function playlistProgress(settings, order, target, request) {
  const parts = playlistParts(order);
  if (!parts) return { status: 'failed', completed: 0, total: 0 };
  for (let index = 0; index < parts.length; index += 1) {
    const key = JSON.stringify(['parts', request, index]);
    const file = deliveryFile(settings, order.id, target, key);
    const status = deliveryStatus(file);
    if (status !== 'sent') return { status, file, audio: parts[index].audio, completed: index, total: parts.length };
  }
  return { status: 'sent', completed: parts.length, total: parts.length };
}

async function advancePlaylist(settings, order, target, request) {
  const progress = playlistProgress(settings, order, target, request);
  if (progress.status !== 'new') return progress;
  const voice = await runCover(settings, ['voice', 'ensure'], 5000);
  if (!voice?.ok) return { ...progress, status: 'failed' };
  try { return { ...progress, status: sendCoverFile(settings, target, progress.audio, progress.file) }; }
  catch { return { ...progress, status: 'failed' }; }
}

const MANUAL_PLAYLISTS = path.join(__dirname, 'manual-playlists');

function enqueuePlaylist(settings, order, target, messageKey) {
  fs.mkdirSync(MANUAL_PLAYLISTS, { recursive: true });
  const key = crypto.createHash('sha256')
    .update(JSON.stringify([order.id, target.id, target.chatType, messageKey])).digest('hex');
  const record = path.join(MANUAL_PLAYLISTS, key + '.json');
  const state = loadAuto();
  const current = playlistProgress(settings, order, target, 'auto');
  // 仍在自动发的同一首，用同一份回执；消息重放时不会重新建单。
  const join = !state.sent?.[order.id] && !state.voiceStopped?.[order.id]
    && settings.autoRender !== false && order.group?.id === target.id && ['new', 'pending'].includes(current.status);
  if (current.status === 'uncertain' || state.voiceStopped?.[order.id] && current.completed > 0) return 'uncertain';
  try {
    fs.writeFileSync(record, JSON.stringify({ orderId: order.id, target, request: join ? 'auto' : key, status: 'pending' }),
      { flag: 'wx', mode: 0o600 });
    return 'new';
  } catch (error) {
    if (error.code === 'EEXIST') return 'existing';
    throw error;
  }
}

async function processManualPlaylists(whale, settings) {
  let files;
  try { files = fs.readdirSync(MANUAL_PLAYLISTS).filter(name => /^[a-f0-9]{64}[.]json$/.test(name)); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  // 一次只推进一条整首播放请求，从写盘的分段回执继续。
  for (const file of files) {
    const record = path.join(MANUAL_PLAYLISTS, file);
    const item = JSON.parse(fs.readFileSync(record, 'utf8'));
    if (item.status !== 'pending') continue;
    const order = readRuntimeOrder(settings, item.orderId);
    const target = voiceTarget(item.target?.id, item.target?.name, item.target?.chatType);
    const allowed = target && order?.status === 'ready' && (!order.group?.id || order.group.id === target.id);
    const output = allowed ? await advancePlaylist(settings, order, target, item.request)
      : { status: 'failed', completed: 0, total: 0 };
    if (output.status === 'pending') return true;
    const staged = record + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(staged, JSON.stringify({ ...item, status: output.status }),
      { flag: 'wx', mode: 0o600 });
    fs.renameSync(staged, record);
    if (item.request === 'auto') {
      const state = loadAuto();
      if (output.status === 'sent') {
        state.sent = { ...state.sent, [item.orderId]: Date.now() };
      } else {
        state.voiceStopped = { ...state.voiceStopped, [item.orderId]: Date.now() };
      }
      if (state.active?.id === item.orderId) state.active = null;
      saveAuto(state);
    }
    if (target) {
      const text = output.status === 'sent'
        ? '《' + order.song + '》已唱完，共 ' + output.total + ' 条语音。'
        : '整首播放已停，确认了 ' + output.completed + ' 条语音。请先核对微信里的语音条。';
      await whale.sendText(target.id, text, { name: target.name, chatType: target.chatType });
    }
    return true;
  }
  return false;
}


async function deliverReady(whale, settings, order, state) {
  const chat = groupTarget(order);
  if (state.sent?.[order.id]) return 'already-sent';
  const target = chat && await resolveVoiceTarget(whale, chat.id, chat.name, chat.chatType);
  if (!target) return 'failed';
  if (order.fullTrack) return (await advancePlaylist(settings, order, target, 'auto')).status;

  const file = deliveryFile(settings, order.id, target);
  const status = deliveryStatus(file);
  if (status !== 'new') return status;

  const ensured = await runCover(settings, ['voice', 'ensure'], 5000);
  if (!ensured?.ok) return 'failed';
  try { return sendCoverFile(settings, target, order.audio, file); }
  catch { return 'failed'; }
}

const PROACTIVE_VIA = 'breezeblue-proactive';
const PROACTIVE_STATE = path.join(__dirname, 'proactive-state.json');
const PROACTIVE_TTL = 200 * 60 * 1000;

function readProactive() {
  try {
    const value = JSON.parse(fs.readFileSync(PROACTIVE_STATE, 'utf8'));
    return value && !Array.isArray(value) && typeof value === 'object' ? value : null;
  } catch (error) {
    return error.code === 'ENOENT' ? {} : null;
  }
}

function saveProactive(state) {
  const temporary = PROACTIVE_STATE + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, PROACTIVE_STATE);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename 已提交或临时文件不存在 */ }
  }
}

function localDay(now) {
  const d = new Date(now);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-');
}

function minutesOfDay(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
}

function proactivelyAllowed(settings, state, now) {
  if (settings.proactiveEnabled !== true || settings.autoRender === false) return false;
  const from = minutesOfDay(settings.proactiveQuietStart ?? '22:30');
  const to = minutesOfDay(settings.proactiveQuietEnd ?? '09:00');
  const d = new Date(now);
  const minute = d.getHours() * 60 + d.getMinutes();
  if (from < 0 || to < 0 || from === to) return false;
  if (from < to ? minute >= from && minute < to : minute >= from || minute < to) return false;
  const max = Math.max(0, Math.min(5, Number(settings.proactiveDailyMax ?? 2)));
  const cooldown = Math.max(30, Number(settings.proactiveCooldownMinutes ?? 360)) * 60000;
  const count = state.day === localDay(now) ? Number(state.count) || 0 : 0;
  return count < max && (!state.lastAt || now - state.lastAt >= cooldown);
}

function contactsMatchBridge(contacts, bridge) {
  return Boolean(bridge && Array.isArray(contacts?.items) && contacts.account
    && (contacts.account === bridge.accountWxid || contacts.account === bridge.account));
}

async function resolveVoiceTarget(whale, id, name, chatType) {
  const target = voiceTarget(id, name, chatType);
  if (target) return target;
  if (!id || id === 'filehelper' || !['private', 'group'].includes(chatType)) return null;
  try {
    // 消息钩子可能没有会话名。只从当前已核验账号的通讯录按会话 ID 补齐。
    const status = (await whale.api('/api/status'))?.body;
    const bridge = status?.gateways?.find(item => item.platform === 'wechat')?.bridge;
    if (!bridge?.online || !bridge.uia || bridge.accountGuard !== true || bridge.accountOk !== true
      || id === bridge.accountWxid || id === bridge.account) return null;
    const contacts = (await whale.api('/api/wechat/contacts'))?.body;
    if (!contactsMatchBridge(contacts, bridge)) return null;
    const matches = contacts.items.filter(item => item.wxid === id && item.isGroup === (chatType === 'group'));
    if (matches.length !== 1) return null;
    const title = String(matches[0].remark || matches[0].name || '').trim();
    if (contacts.items.some(item => item.wxid !== id
      && [item.name, item.remark, item.label].some(label => relayName(label) === relayName(title)))) return null;
    return voiceTarget(id, title, chatType);
  } catch {
    return null;
  }
}

async function proactiveContext(whale, settings, now) {
  if (process.permission?.has('ChildProcess') === false) return null;
  const status = (await whale.api('/api/status'))?.body;
  const gateway = status?.gateways?.find(item => item.platform === 'wechat');
  const bridge = gateway?.bridge;
  const last = Number(gateway?.lastMessageAt);
  const idleMs = Math.max(5, Number(settings.proactiveIdleMinutes ?? 120)) * 60000;
  if (!bridge?.online || !bridge.uia || bridge.accountGuard !== true || bridge.accountOk !== true
    || !bridge.account || !Number.isFinite(last)) return null;
  // 刚启动时没有 lastMessageAt（0），没有消息本身也按空闲处理。
  if (last > 0 && now - last < idleMs) return null;
  const plugins = (await whale.api('/api/plugins/status'))?.body?.items;
  if (!Array.isArray(plugins) || plugins.some(item => item.id === 'breeze-proactive')) return null;
  const master = (await whale.api('/api/config'))?.body?.config?.persona?.master;
  const contacts = (await whale.api('/api/wechat/contacts'))?.body;
  if (!Array.isArray(master?.wxids) || !contactsMatchBridge(contacts, bridge)) return null;
  const configured = Array.isArray(settings.proactiveRecipientIds)
    ? new Set(settings.proactiveRecipientIds.map(String)) : null;
  const privateIds = settings.proactivePrivateEnabled === false ? [] : master.wxids.map(String)
    .filter(id => (!configured || configured.has(id)) && !/@chatroom$/i.test(id));
  const groupIds = Array.isArray(settings.proactiveGroupIds)
    ? settings.proactiveGroupIds.map(String).filter(id => /@chatroom$/i.test(id)) : [];
  const targets = [...new Set([...privateIds, ...groupIds])].flatMap(id => {
    if (!id || id === 'filehelper' || id === bridge.accountWxid) return [];
    const group = /@chatroom$/i.test(id);
    const exact = contacts.items.filter(item => item.wxid === id && item.isGroup === group);
    if (exact.length !== 1) return [];
    const title = String(exact[0].remark || exact[0].name || '').trim();
    if (!title || contacts.items.some(item => item.wxid !== id
      && [item.name, item.remark, item.label].some(name => String(name || '').trim() === title))) return [];
    const target = voiceTarget(id, title, group ? 'group' : 'private');
    return target ? [{ ...target, title: group ? '' : String(master.titles?.[id] || '').trim() }] : [];
  });
  return targets.length ? targets : null;
}

function rememberPlayedSongs(whale, state, orders) {
  let seen = {};
  if (whale.paths?.appData) {
    const file = path.join(whale.paths.appData, 'plugins', 'breeze-proactive.data', 'state.json');
    try { seen = JSON.parse(fs.readFileSync(file, 'utf8')).sung || {}; }
    catch (error) { if (error.code !== 'ENOENT') return false; }
  }
  const sent = loadAuto().sent || {};
  for (const order of orders) {
    if (order.song && Object.hasOwn(sent, order.id)) seen[order.song] = sent[order.id];
  }
  const names = state.songs || {};
  let changed = false;
  for (const name of Object.keys(seen)) {
    const extension = path.extname(name).toLowerCase();
    const key = normName(SONG_EXTS.has(extension) ? path.basename(name, extension) : name);
    if (key && !Object.hasOwn(names, key)) {
      Object.defineProperty(names, key, { value: Number(seen[name]) || 1, enumerable: true });
      changed = true;
    }
  }
  if (changed) {
    state.songs = names;
    saveProactive(state);
  }
  return true;
}

function proactiveLibrary(settings, state) {
  const dir = path.join(dataRoot(settings), 'songs');
  let files;
  try { files = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
  const local = files
    .filter(item => item.isFile() && SONG_EXTS.has(path.extname(item.name).toLowerCase()))
    .map(item => ({ name: path.basename(item.name, path.extname(item.name)), file: path.join(dir, item.name) }));
  const remote = settings.proactiveAllowDownload === true && Array.isArray(settings.proactiveDownloadCandidates)
    ? settings.proactiveDownloadCandidates.filter(name => typeof name === 'string')
      .map(name => ({ name: name.trim() })) : [];
  return [...local, ...remote].filter(song => song.name.length > 0 && song.name.length <= 100
    && normName(song.name) && !Object.hasOwn(state.songs || {}, normName(song.name)));
}

function readRuntimeOrder(settings, id) {
  if (!/^[0-9a-f]{8}$/i.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dataRoot(settings), 'orders', id + '.json'), 'utf8')); }
  catch { return null; }
}

function finishProactive(state) {
  delete state.active;
  saveProactive(state);
}

async function pickLikedSong(settings, state) {
  const tools = path.dirname(cliPath(settings));
  const fetcher = path.join(tools, 'fetch_song.py');
  if (!fs.existsSync(fetcher)) return null;
  const root = runtimeRoot(settings);
  const python = settings.python || path.join(root, 'engine', 'venv', 'Scripts', 'python.exe');
  const cookies = settings.neteaseCookies || path.join(root, 'cookies.txt');
  const cache = path.join(root, 'cache');
  try { fs.mkdirSync(cache, { recursive: true }); } catch { /* ignore */ }
  const seen = (state && state.songs) || {};
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const out = path.join(cache, 'liked-' + Date.now() + '-' + attempt + '.mp3');
    const data = await new Promise(resolve => {
      execFile(python, [fetcher, '--liked', '--pick', 'random', '--out', out], {
        timeout: 240000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, BREEZE_COOKIES: cookies, PYTHONIOENCODING: 'utf-8' },
      }, (error, stdout) => {
        const line = String(stdout || '').trim().split('\n').filter(Boolean).pop() || '';
        try { resolve(JSON.parse(line)); } catch { resolve({ ok: false }); }
      });
    });
    if (!data?.ok || !data.path || !fs.existsSync(String(data.path))) continue;
    const title = String(data.title || '').trim();
    const key = normName(title);
    if (key && Object.hasOwn(seen, key)) {
      try { fs.unlinkSync(String(data.path)); } catch { /* ignore */ }
      continue;
    }
    return { name: title.slice(0, 100), artist: String(data.artist || '').trim(), file: String(data.path) };
  }
  return null;
}

async function handleLikedOrder(whale, message, settings) {
  const target = await voiceTargetForMessage(whale, message);
  if (!target) {
    await reply(whale, message, '我没能确认会话标题，先不发。');
    return;
  }
  const liked = await pickLikedSong(settings, readProactive());
  if (!liked) {
    await reply(whale, message, '这次没能从网易云「我喜欢的音乐」拿到可用的歌，等会儿再试吧。');
    return;
  }
  const songsDir = path.join(dataRoot(settings), 'songs');
  try { fs.mkdirSync(songsDir, { recursive: true }); } catch { /* ignore */ }
  const safeName = liked.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'liked';
  const localFile = path.join(songsDir, safeName + '.mp3');
  try { fs.copyFileSync(liked.file, localFile); } catch { /* 仍可由下载器重新取 */ }
  const out = await runCover(settings, ['order', '--song', liked.name, '--artist', liked.artist,
    '--requester', nameFor(message), '--via', message.chatType === 'group' ? 'group' : 'private',
    '--chat-type', message.chatType === 'group' ? 'group' : 'private',
    '--engine', settings.engine || 'seedvc', '--group-id', chatFor(message),
    '--group-name', target.name], 15000);
  if (!out?.ok || !out.order?.id) {
    await reply(whale, message, '这首歌没排上，等会儿再试吧。');
    return;
  }
  const where = target.chatType === 'group' ? '发到群里' : '发给你';
  await reply(whale, message, `收到～从「我喜欢的音乐」随机挑到《${liked.name}》，排第 ${out.position || 1} 位，做好${where}。`);
}

const SYNTH_LIBRARY = path.join(__dirname, 'synth-library');

function findSynthEntry(settings, wanted) {
  const key = normName(wanted);
  if (!key) return null;
  return loadSynthLibrary(settings).find(entry => normName(entry.title) === key
    || (Array.isArray(entry.aliases) && entry.aliases.some(alias => normName(alias) === key))) || null;
}

function loadSynthLibrary(settings) {
  try {
    const root = settings?.synthLibraryDir || SYNTH_LIBRARY;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    return (Array.isArray(manifest.entries) ? manifest.entries : []).filter(entry =>
      entry && typeof entry.id === 'string' && typeof entry.title === 'string'
      && typeof entry.durationSec === 'number' && entry.durationSec > 0
      && typeof entry.libraryPath === 'string'
      && fs.existsSync(entry.libraryPath));
  } catch { return []; }
}

function librarySentFor(state, entry, target) {
  return state.librarySent?.[entry.id]?.[target.id] || null;
}

function markLibrarySent(state, entry, target, info) {
  const table = { ...(state.librarySent || {}) };
  table[entry.id] = { ...(table[entry.id] || {}), [target.id]: { at: Date.now(), ...info } };
  state.librarySent = table;
}

function createLibraryOrder(settings, entry, target, options = {}) {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const root = dataRoot(settings);
  const work = path.join(root, 'work', id);
  fs.mkdirSync(work, { recursive: true });
  const audio = path.join(work, 'cover.wav');
  fs.copyFileSync(entry.libraryPath, audio);
  const now = new Date().toISOString();
  const order = {
    id, song: entry.title, artist: '', note: '', requester: options.requester || '鲸鲸',
    wxid: options.wxid || target.id, via: options.via || PROACTIVE_VIA, chatType: target.chatType, engine: 'seedvc',
    group: { id: target.id, name: target.name || '' },
    source: audio, status: 'ready', hasAudio: true, durationSec: entry.durationSec,
    fullTrack: true, audio, audioParts: [], profile: 'daily', createdAt: now, updatedAt: now,
    events: [{ at: now, status: 'ready', note: '已合成库复用' }],
  };
  const dir = path.join(root, 'orders');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.json');
  fs.writeFileSync(file, JSON.stringify(order, null, 2), 'utf8');
  return { id, order, file };
}

async function proactiveLibrarySend(whale, settings, state, targets) {
  if (settings.proactiveLibrary === false || !targets?.length) return false;
  const entries = loadSynthLibrary(settings);
  if (!entries.length) return false;
  if (state.libraryPending) {
    const pending = state.libraryPending;
    let receipt = null;
    try { receipt = await whale.delivery(pending.deliveryId); } catch { /* ignore */ }
    if (['queued', 'sending'].includes(receipt?.status)) return true;
    const confirmed = receipt?.confirmed === true && receipt?.status === 'confirmed';
    if (confirmed && pending.targetId && pending.song) {
      const target = targets.find(item => item.id === pending.targetId);
      if (target) {
        const call = target.title ? target.title + '，' : '';
        try {
          await whale.sendText(target.id, call + '我唱了《' + pending.song + '》，你喜欢吗？',
            { name: target.name, chatType: target.chatType });
        } catch { /* 文件已送达，留言失败不重发文件 */ }
      }
    }
    const entry = entries.find(item => item.id === pending.entryId);
    const target = targets.find(item => item.id === pending.targetId);
    if (entry && target) markLibrarySent(state, entry, target,
      { status: confirmed ? 'sent' : (receipt?.status || 'uncertain'), orderId: pending.orderId, mode: 'wav' });
    delete state.libraryPending;
    saveProactive(state);
    return true;
  }
  if (settings.proactiveDryRun === true) return false;
  for (const target of targets) {
    const entry = entries.find(item => !librarySentFor(state, item, target));
    if (!entry) continue;
    if (entry.durationSec > 120) {
      const made = createLibraryOrder(settings, entry, target);
      let delivery = null;
      try { delivery = await whale.send({ type: 'sing-wav', orderId: made.id }); }
      catch (error) {
        markLibrarySent(state, entry, target, { status: 'failed', orderId: made.id, mode: 'wav' });
        saveProactive(state);
        return true;
      }
      state.libraryPending = {
        entryId: entry.id, targetId: target.id, song: entry.title, orderId: made.id,
        deliveryId: delivery?.id || '', at: Date.now(),
      };
      saveProactive(state);
      return true;
    }
    const file = deliveryFile(settings, madeIdSafe(entry), target, 'library');
    const status = sendCoverFile(settings, target, entry.libraryPath, file, 'library');
    markLibrarySent(state, entry, target, { status, mode: 'voice' });
    saveProactive(state);
    return true;
  }
  return false;
}

function madeIdSafe(entry) {
  return 'lib-' + String(entry.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
}

async function proactiveTick(whale, settings, orders, allowStart) {
  const state = readProactive();
  if (!state) return false;
  const now = Date.now();
  const job = state.active;
  if (job) {
    const order = readRuntimeOrder(settings, job.orderId);
    const type = job.chatType || 'private';
    const matchesOrder = order && order.chatType === type && order.group?.id === job.targetId
      && (job.reuse || order.via === PROACTIVE_VIA);
    if (job.phase === 'sending') {
      // 旧状态里的单条发送可能已提交。保留它的回执，绝不从第一段重新发送。
      const activeTarget = voiceTarget(job.targetId, job.targetName, type);
      const progress = job.waveMode ? { status: await waveReceipt(whale, job.waveDeliveryId) }
        : job.receipt ? { status: deliveryStatus(job.receipt) }
        : matchesOrder && activeTarget ? playlistProgress(settings, order, activeTarget, 'proactive') : { status: 'failed' };
      if (progress.status === 'pending') return true;
      if (progress.status === 'new' && !job.waveMode && !job.receipt && settings.proactiveEnabled === true) {
        if (!allowStart) return false;
        const target = (await proactiveContext(whale, settings, now))?.find(item =>
          item.id === job.targetId && item.name === job.targetName && item.chatType === type);
        if (target) {
          const delivery = await advancePlaylist(settings, order, target, 'proactive');
          if (!['failed', 'uncertain'].includes(delivery.status)) return true;
        }
      }
      finishProactive(state);
      if (progress.status === 'sent' && settings.proactiveEnabled === true && settings.proactiveFollowup === true) {
        const target = (await proactiveContext(whale, settings, now))?.find(item =>
          item.id === job.targetId && item.name === job.targetName && item.chatType === type);
        if (target) {
          const call = target.title ? target.title + '，' : '';
          await whale.sendText(target.id, call + '我唱了《' + job.song + '》，你喜欢吗？',
            { name: target.name, chatType: target.chatType });
        }
      }
      return false;
    }

    if (!matchesOrder || now - job.startedAt >= PROACTIVE_TTL || ['failed', 'canceled'].includes(order.status)
      || prepStatus(settings, order.id)?.status === 'error') {
      finishProactive(state);
      return false;
    }
    if (order.status === 'making' || order.status === 'pending') return true;
    if (order.status !== 'ready' || !playlistParts(order) || settings.proactiveEnabled !== true) {
      finishProactive(state);
      return false;
    }
    if (!allowStart || !proactivelyAllowed(settings, state, now)) return false;
    const targets = await proactiveContext(whale, settings, now);
    const target = targets?.find(item => item.id === job.targetId && item.chatType === type);
    if (!target) return false;
    const key = normName(job.song);
    const today = localDay(now);
    state.count = (state.day === today ? Number(state.count) || 0 : 0) + 1;
    state.day = today;
    state.lastAt = now;
    state.cursor = ((Number(state.cursor) || 0) + 1) % targets.length;
    state.songs = { ...state.songs, [key]: now };
    const waveMode = longTrack(order) && await canSendSongWave(whale);
    state.active = { ...job, phase: 'sending', chatType: type, targetName: target.name, startedAt: now, waveMode };
    saveProactive(state);
    if (settings.proactiveDryRun === true) {
      finishProactive(state);
    } else if (waveMode) {
      try {
        const delivery = await whale.send({ type: 'sing-wav', orderId: order.id });
        state.active.waveDeliveryId = delivery?.id;
        saveProactive(state);
      } catch { finishProactive(state); }
    } else {
      const delivery = await advancePlaylist(settings, order, target, 'proactive');
      if (['failed', 'uncertain'].includes(delivery.status)) finishProactive(state);
    }
    return false;
  }

  if (!allowStart || !proactivelyAllowed(settings, state, now)) return false;
  const queue = await runCover(settings, ['list', '--status', 'pending,making', '--limit', '500'], 3000);
  if (!queue?.ok || !Array.isArray(queue.orders) || queue.orders.length >= 500) return false;
  if (queue.orders.some(order => !['proactive', PROACTIVE_VIA].includes(order.via)
    || order.status === 'making' && now - Date.parse(order.updatedAt) < PROACTIVE_TTL)) return false;
  const targets = await proactiveContext(whale, settings, now);
  if (!targets) return false;
  if (await proactiveLibrarySend(whale, settings, state, targets)) return true;
  const target = targets[(Number(state.cursor) || 0) % targets.length];
  if (settings.proactiveLiked === true) {
    const liked = await pickLikedSong(settings, state);
    if (liked) {
      const result = await runCover(settings, ['order', '--song', liked.name, '--artist', liked.artist,
        '--requester', '鲸鲸', '--via', PROACTIVE_VIA, '--chat-type', target.chatType,
        '--engine', 'seedvc', '--group-id', target.id, '--group-name', target.name], 5000);
      if (result?.ok && /^[0-9a-f]{8}$/i.test(String(result.order?.id || ''))) {
        state.active = { orderId: result.order.id, targetId: target.id, chatType: target.chatType,
          song: liked.name, startedAt: now };
        saveProactive(state);
        startPrep(settings, result.order, liked);
        return true;
      }
    }
  }
  if (!rememberPlayedSongs(whale, state, orders)) return false;
  const library = proactiveLibrary(settings, state);
  const candidates = library.filter(item => item.file);
  const preferred = candidates.length ? candidates : library;
  const allowed = new Set(preferred.map(item => normName(item.name)));
  const formats = loadAuto().longFormats;
  const reusable = orders.filter(order => order.status === 'ready' && order.audio
    && order.chatType === target.chatType && order.group?.id === target.id && order.fullTrack === true
    && !['offered', 'wave', 'uncertain'].includes(formats?.[order.id]?.status)
    && playlistParts(order) && allowed.has(normName(order.song)))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (reusable) {
    state.active = { orderId: reusable.id, targetId: target.id, chatType: target.chatType, song: reusable.song, startedAt: now, reuse: true };
    saveProactive(state);
    return false;
  }
  const song = preferred[0];
  if (!song) return false;
  const result = await runCover(settings, ['order', '--song', song.name, '--requester', '鲸鲸',
    '--via', PROACTIVE_VIA, '--chat-type', target.chatType, '--engine', 'seedvc',
    '--group-id', target.id, '--group-name', target.name], 5000);
  if (!result?.ok || !/^[0-9a-f]{8}$/i.test(String(result.order?.id || ''))) return false;
  state.active = { orderId: result.order.id, targetId: target.id, chatType: target.chatType, song: song.name, startedAt: now };
  saveProactive(state);
  startPrep(settings, result.order, song);
  return true;
}


async function autoTick(whale, settings) {
  if (!whale || settings.autoRender === false) return;
  const state = loadAuto();
  await restoreFormatOffers(whale, settings, state);
  await checkLongWaveReceipts(whale, settings, state);
  const out = await runCover(settings, ['list', '--status', 'pending,making,ready', '--limit', '100', '--active-first'], 10000);
  if (!out || !out.ok) return;
  const list = Array.isArray(out.orders) ? out.orders : [];
  if (state.active?.id && !list.some(order => order.id === state.active.id)) {
    const ongoing = readRuntimeOrder(settings, state.active.id);
    if (ongoing) list.push(ongoing);
  }
  const orders = fillGroupNames(list);
  if (await proactiveTick(whale, settings, orders, false)) return;
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

  if (active && state.active.prep && ['pending', 'making'].includes(active.status)
    && prepStatus(settings, active.id)?.status === 'error') {
    active = { ...active, status: 'failed' };
  }
  if (active && (active.status === 'making' || (active.status === 'pending' && state.active.prep))) {
    await maybeReportProgress(whale, settings, active, state);
  }

  // 内核/插件重启后 state.active 可能丢了；已经 ready 但没发过的单要补发。
  if (!active) {
    const unsent = ours.find((o) => o.status === 'ready' && !state.sent?.[o.id]
      && !state.voiceStopped?.[o.id] && !state.longFormats?.[o.id]);
    if (unsent) {
      state.active = { id: unsent.id, startedAt: Date.now(), recovered: true };
      saveAuto(state);
      active = unsent;
    }
  }

  if (active && active.status === 'ready') {
    const parts = playlistParts(active);
    const chat = groupTarget(active);
    if (parts && longTrack(active) && chat && active.wxid && !state.sent?.[active.id]
      && ['group', 'private'].includes(active.via) && /^[0-9a-f]{8}$/.test(active.id)) {
      const progress = playlistProgress(settings, active, chat, 'auto');
      if (progress.status === 'new' && progress.completed === 0 && await canOfferSongFormats(whale)) {
        state.longFormats = { ...state.longFormats, [active.id]: { status: 'offered', at: Date.now() } };
        state.active = null;
        state.attempts = {};
        state.progressStartedAt = null;
        state.lastProgressAt = null;
        if (saveAuto(state)) await offerLongFormat(whale, active, state);
        return;
      }
    }
    const delivery = await deliverReady(whale, settings, active, state);
    if (delivery === 'pending') return;

    state.active = null;
    state.attempts = {};
    state.progressStartedAt = null;
    state.lastProgressAt = null;
    if (delivery === 'sent' || delivery === 'already-sent') {
      state.sent = state.sent || {};
      state.sent[active.id] = Date.now();
    } else {
      state.voiceStopped = state.voiceStopped || {};
      state.voiceStopped[active.id] = Date.now();
    }
    saveAuto(state);
    if (delivery === 'sent') {
      await notifyGroup(whale, active, `唱好了～《${active.song}》`);
    } else if (delivery !== 'already-sent' && active.fullTrack) {
      const chat = groupTarget(active);
      const target = chat && await resolveVoiceTarget(whale, chat.id, chat.name, chat.chatType);
      const completed = target ? playlistProgress(settings, active, target, 'auto').completed : 0;
      await notifyGroup(whale, active, '《' + active.song + '》的后续语音已停止，已确认 ' + completed
        + ' 条。请先核对聊天里的语音条。');
    } else if (delivery !== 'already-sent') {
      const hint = delivery === 'uncertain' ? '没能确认语音是否送达' : '语音没发出去';
      await notifyGroup(whale, active, `《${active.song}》已生成，${hint}。确认会话里没有语音后，可回「唱 ${active.song}」。`);
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
    let heartbeat = 0;
    try {
      const file = path.join(dataRoot(settings), 'work', active.id, 'heartbeat.json');
      heartbeat = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).updatedAt) || 0;
    } catch { /* 兼容没有独立心跳的旧运行时 */ }
    const beat = Math.max(heartbeat, Date.parse(hint?.updatedAt || 0) || 0, Date.parse(active.updatedAt || 0) || 0);
    const idle = Date.now() - beat;
    const atEnd = !!(hint && Number(hint.total) > 0 && Number(hint.step) >= Number(hint.total));
    // 有进度文件时看心跳；超过 6 分钟没有任何新进度，说明 seed-vc 卡死/被挂起。
    // 100% 后 seed-vc 可能静默收尾几十秒，不要误杀。
    if (!atEnd && started && Date.now() - started > 5 * 60 * 1000 && idle > (active.fullTrack === true ? 65 * 60 * 1000 : IDLE_STALL_MS)) {
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
    if (active.fullTrack === true || !(age > STALE_MS)) return; // 整首任务按独立进度判断
  }
  if (active && active.status === 'pending') {
    const waited = Date.now() - Number(state.active.startedAt || 0);
    // 准备阶段：下载 + 切副歌，正常 1 分钟内会变 making。
    if (state.active.prep) {
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
  if (!next) {
    await proactiveTick(whale, settings, orders, true);
    return;
  }

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
      await notifyGroup(whale, next, '收到《' + next.song + '》，正在准备整首翻唱～');
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
  return message.chatTitle || message.senderName || message.senderId || message.chatId;
}

function chatFor(message) {
  const isGroup = message.chatType === 'group';
  return isGroup ? message.chatId : (message.senderId || message.chatId);
}

function voiceTargetForMessage(whale, message) {
  const id = chatFor(message);
  const type = message.chatType === 'group' ? 'group' : 'private';
  const title = type === 'group' ? message.chatTitle : (message.chatTitle || message.senderName);
  const direct = voiceTarget(id, title, type);
  if (direct) return direct;
  if (type === 'private' && message.chatId && message.chatId !== id) return null;
  return resolveVoiceTarget(whale, id, '', type);
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


async function recordCoverMemory(whale, message, title, detail = '') {
  try {
    const summary = (detail || '已在当前会话发送翻唱成品') + '《' + title + '》';
    await whale.memory.recordEvent({
      title: '翻唱', summary,
      keywords: ['翻唱', title].filter(Boolean), importance: 0.55,
    });
  } catch { /* 群聊/无权限时不影响发送 */ }
}

async function handleOrder(whale, message, settings, parsed) {
  const me = String(message.senderName || message.senderId || '群友');
  const key = [message.chatId, message.senderId || me, message.msgId || parsed.song].join('|');
  const now = Date.now();
  for (const [k, ts] of recent) if (now - ts > 60000) recent.delete(k);
  if (recent.has(key)) return true;
  recent.set(key, now);

  const existing = findSynthEntry(settings, parsed.song);
  if (existing) {
    const chat = await voiceTargetForMessage(whale, message);
    if (!chat) {
      await reply(whale, message, '我没能确认微信会话标题，先不发。');
      return true;
    }
    if (existing.durationSec <= 120) {
      const file = deliveryFile(settings, 'lib-' + existing.id, chat, 'point');
      let status = 'failed';
      try { status = sendCoverFile(settings, chat, existing.libraryPath, file, 'point'); } catch { /* ignore */ }
      await reply(whale, message, status === 'sent' || status === 'pending'
        ? `《${existing.title}》已经做好了，直接发成品，不重做。`
        : `《${existing.title}》成品发送暂时没确认，先不重做，等会儿再试。`);
      await recordCoverMemory(whale, message, existing.title, '复用成品');
      return true;
    }
    const made = createLibraryOrder(settings, existing, chat, {
      via: message.chatType === 'group' ? 'group' : 'private',
      wxid: String(message.senderId || chat.id), requester: me,
    });
    const state = loadAuto();
    state.active = null;
    state.longFormats = { ...(state.longFormats || {}),
      [made.id]: { status: 'offered', at: Date.now() } };
    if (!saveAuto(state)) {
      await reply(whale, message, '成品记录写不进去，先不重做。');
      return true;
    }
    await offerLongFormat(whale, made.order, state);
    await recordCoverMemory(whale, message, existing.title, '复用成品，等待格式选择');
    return true;
  }

  const args = [
    'order',
    '--song', parsed.song,
    '--requester', me,
    '--via', message.chatType === 'group' ? 'group' : 'private',
    '--chat-type', message.chatType === 'group' ? 'group' : 'private',
    '--engine', settings.engine || 'seedvc',
    '--group-id', chatFor(message),
  ];
  const target = await voiceTargetForMessage(whale, message);
  if (target) args.push('--group-name', target.name);
  if (parsed.artist) args.push('--artist', parsed.artist);
  if (parsed.note) args.push('--note', parsed.note);
  if (message.senderId) args.push('--wxid', String(message.senderId));

  const out = await runCover(settings, args, 15000);
  if (!out || !out.ok) {
    await reply(whale, message, '这张单没接住，等会儿再点一次。');
    return true;
  }
  await reply(whale, message, okText(out.order, out.position));
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
  const current = readRuntimeOrder(settings, order.id);
  const prep = prepStatus(settings, order.id);
  const detail = prep?.status === 'error' ? String(prep.error || '') : '';
  const code = current?.renderFailure || prep?.reasonCode
    || (/no kernel image|CUDA_ARCH_UNSUPPORTED/i.test(detail) ? 'cuda_arch' : '');
  switch (code) {
    case 'cuda_arch': return 'PyTorch 与 NVIDIA 显卡不兼容。请用新版安装器重跑「Python 依赖」。';
    case 'cuda_unavailable': return 'CUDA 算子无法运行。请检查 NVIDIA 驱动后重跑「Python 依赖」。';
    case 'render_timeout': return '渲染进程超过执行时限。';
    case 'reference_required': return '需要先完成方案 B 的参考音录制。';
    default: return prep?.status === 'error' && !code ? '音源准备失败，请检查本机歌曲和渲染日志。' : '';
  }
}

async function handleList(whale, message, settings) {
  const out = await runCover(settings, ['list', '--limit', '100'], 15000);
  if (!out || !out.ok) {
    await reply(whale, message, '队列暂时读不出来。');
    return;
  }
  const mine = (out.orders || []).filter((o) => !o.group || !o.group.id || String(o.group.id) === String(message.chatId));
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
  const sender = String(message.senderId || '').trim();
  const mine = (out.orders || []).filter((o) => sender && ['pending', 'making'].includes(o.status)
    && String(o.wxid || '') === sender && String(o.group?.id || '') === String(chatFor(message)));
  const target = mine.find((o) => o.song === wanted) || (mine.length === 1 && !wanted ? mine[0] : null);
  if (!target) {
    await reply(whale, message, wanted ? `没找到你点的《${wanted}》。` : '你现在没有在排队的歌。');
    return;
  }
  const res = await runCover(settings, ['cancel', target.id], 15000);
  await reply(whale, message, res && res.ok ? `好，撤掉《${target.song}》。` : '撤单失败，晚点再说。');
}

// 「唱 歌名」只播放现成的成品。录音结果由本地发送器确认。
async function handleSing(whale, message, settings, wanted) {
  const out = await runCover(settings, ['list', '--status', 'ready,delivered', '--limit', '100', '--newest'], 15000);
  if (!out || !out.ok) {
    await reply(whale, message, '队列暂时读不出来。');
    return;
  }
  const ready = (out.orders || []).filter((o) => ['ready', 'delivered'].includes(o.status)
    && o.via !== RELAY_SONG_VIA && (o.hasAudio || o.durationSec)
    && (!o.group?.id || String(o.group.id) === String(chatFor(message))));
  const want = String(wanted || '').trim();
  const target = want
    ? ready.find((o) => o.id === want) || ready.find((o) => o.song === want) || ready.find((o) => o.song.includes(want))
    : ready[0];
  if (!target) {
    await reply(whale, message, want
      ? `《${want}》还没唱好，等做好了再喊我。`
      : '这个群还没有唱好的歌，先点一首吧。');
    return;
  }

  const chat = await voiceTargetForMessage(whale, message);
  if (!chat) {
    await reply(whale, message, '我没能确认微信会话标题，先不发。');
    return;
  }
  if (target.fullTrack) {
    const format = loadAuto().longFormats?.[target.id];
    if (format?.status === 'offered') {
      await reply(whale, message, longFormatPrompt(target));
      return;
    }
    if (['wave', 'uncertain'].includes(format?.status)) {
      await reply(whale, message, '整首 WAV 正在发送或等待回执，请先核对聊天。');
      return;
    }
    if (!playlistParts(target)) {
      await reply(whale, message, '整首分段资料不完整，请重新点歌。');
      return;
    }
    const messageKey = String(message.msgId || Math.floor(Date.now() / 120000));
    const queued = enqueuePlaylist(settings, target, chat, messageKey);
    if (queued === 'new') {
      await reply(whale, message, '《' + target.song + '》已排队，确认前一条后继续播放。');
    } else if (queued === 'uncertain') {
      await reply(whale, message, '上一轮播放有一条语音尚未确认，请先核对聊天里的语音条。');
    }
    return;
  }
  const ensured = await runCover(settings, ['voice', 'ensure'], 5000);
  if (!ensured?.ok) {
    await reply(whale, message, '语音通道或账号核验未就绪。');
    return;
  }

  try {
    const autoFile = deliveryFile(settings, target.id, chat);
    const autoStatus = deliveryStatus(autoFile);
    const orderChat = groupTarget(target);
    const canUseAuto = orderChat?.id === chat.id && orderChat.chatType === chat.chatType
      && target.status === 'ready';
    const messageKey = String(message.msgId || Math.floor(Date.now() / 120000));
    const manualFile = deliveryFile(settings, target.id, chat, messageKey);
    const request = path.basename(manualFile);
    let priorRequest = '';
    if (autoStatus !== 'new') {
      try { priorRequest = JSON.parse(fs.readFileSync(autoFile, 'utf8')).request; } catch { /* 当前回执不完整 */ }
    }
    const useAuto = priorRequest === request || (canUseAuto && ['new', 'pending'].includes(autoStatus));
    const file = useAuto ? autoFile : manualFile;
    const status = deliveryStatus(file);
    const delivery = status === 'new' ? sendCoverFile(settings, chat, target.audio, file, request) : status;
    if (delivery === 'pending') {
      await reply(whale, message, `正在尝试发送《${target.song}》，请以微信语音条为准。`);
    } else if (delivery === 'failed') {
      await reply(whale, message, '语音没发出去，检查微信前台和语音设备后再试。');
    } else if (delivery === 'uncertain') {
      await reply(whale, message, '上次发送结果不确定，请先核对聊天里的语音条。');
    }
  } catch {
    await reply(whale, message, '没能启动语音发送器。');
  }
}

const RELAY_SONG_VIA = 'breezeblue-relay';
const RELAY_DIR = path.join(__dirname, 'song-relay');
const RELAY_TTL = 10 * 60 * 1000;
const relayBusy = new Set();

function relayText(value) {
  return String(value || '').normalize('NFKC').trim()
    .replace(/^[《「“"'〈\s]+|[》」”"'〉\s]+$/g, '').trim();
}

const RELAY_LAST = '__relay_last_song__';
const RELAY_CONFIRM_WORDS = new Set(['发', '发吧', '发。', '好', '好叻', '好的', '可以', '唱吧', '确认', '嗯', '冲', '来吧']);
const RELAY_CANCEL_WORDS = new Set(['算了', '取消', '不发', '不用', '别唱', '不要', '先不', '不唱']);

function parseSongRelay(text) {
  const command = String(text || '').normalize('NFKC').trim()
    .replace(/[。！!？?，,]+$/g, '').trim();
  if (!command) return null;
  const action = /^(唱歌确认|唱歌取消)\s*([A-Fa-f0-9]{6})$/.exec(command);
  if (action) return { type: action[1], code: action[2].toLowerCase() };
  if (RELAY_CONFIRM_WORDS.has(command)) return { type: '确认' };
  if (RELAY_CANCEL_WORDS.has(command)) return { type: '取消' };

  let target = '';
  let song = '';
  // 把刚刚/刚才/上一/那首 唱给某人听
  const last = /^(?:帮我|请)?\s*把\s*(?:刚刚|刚才|上一|上上)?\s*那?\s*(?:首|一首)?\s*(?:歌|歌曲)?\s*(?:唱|放)\s*给\s*(.{1,60}?)\s*(?:听|吧|呗)?$/.exec(command);
  if (last) { target = relayText(last[1]); song = RELAY_LAST; }
  // 把《歌名》唱给某人听
  if (!target) {
    const give = /^(?:帮我|请)?\s*把\s*《([^》]{1,100})》\s*唱给\s*(.{1,60}?)\s*(?:听|吧|呗)?$/.exec(command);
    if (give) { song = relayText(give[1]); target = relayText(give[2]); }
  }
  // 唱《歌名》给某人听 / 唱歌名给某人
  if (!target) {
    const sing = /^(?:帮我|请)?\s*唱\s*(?:首|一首)?\s*《?([^》]{1,100}?)》?\s*(?:给|送给)\s*(.{1,60}?)\s*(?:听|吧|呗)?$/.exec(command);
    if (sing) { song = relayText(sing[1]); target = relayText(sing[2]); }
  }
  // 给某人唱《歌名》
  if (!target) {
    const to = /^(?:帮我|请)?\s*(?:给|替|帮)\s*(.{1,60}?)\s*唱\s*(?:首|一首)?\s*《?([^》]{1,100}?)》?$/.exec(command);
    if (to) { target = relayText(to[1]); song = relayText(to[2]); }
  }
  // 唱/放 一首给某人听
  if (!target) {
    const just = /^(?:帮我|请)?\s*(?:唱|放)\s*(?:一?\s*首?)\s*给\s*(.{1,60}?)\s*(?:听|吧|呗)?$/.exec(command);
    if (just) { target = relayText(just[1]); song = RELAY_LAST; }
  }
  if (!target || !song) return null;
  return { type: 'request', target, song };
}

function relayPartyId(value) {
  return String(value || '').trim().toLowerCase().replace(/_[a-f0-9]{4}$/i, '');
}

function relayName(value) {
  return relayText(value).toLowerCase();
}

async function relayContext(whale, settings, owner, word, prior) {
  if (settings.relaySingEnabled !== true || process.permission?.has('ChildProcess') === false) return null;
  const status = (await whale.api('/api/status'))?.body;
  const bridge = status?.gateways?.find(gateway => gateway.platform === 'wechat')?.bridge;
  if (!bridge?.online || !bridge.uia || !bridge.account || bridge.accountOk !== true || bridge.accountGuard !== true) return null;
  const config = (await whale.api('/api/config'))?.body?.config;
  const master = config?.persona?.master;
  if (!Array.isArray(master?.wxids) || !owner || /@chatroom$/i.test(owner) || !master.wxids.some(id => relayPartyId(id) === relayPartyId(owner))) return null;
  const nativeRelay = config?.wechat?.relay;
  if (nativeRelay?.enabled === false) return null;
  const allowed = new Set(Array.isArray(settings.relaySingWhitelist) ? settings.relaySingWhitelist.map(String) : []);
  if (!allowed.size) return null;
  const contacts = (await whale.api('/api/wechat/contacts'))?.body;
  if (!contactsMatchBridge(contacts, bridge)) return null;

  const labels = contact => [contact.name, contact.remark, contact.label].map(relayName).filter(Boolean);
  const roles = item => Object.entries(master.titles || {})
    .filter(([id]) => relayPartyId(id) === relayPartyId(item.wxid)).map(([, role]) => relayName(role));
  const wanted = relayName(word);
  const hits = contacts.items.filter(item => [...labels(item), ...roles(item)].includes(wanted)
    || item.isGroup === true && [wanted.replace(/群里$/, ''), wanted.replace(/里$/, '')].some(name => labels(item).includes(name)));
  if (hits.length !== 1) return null;
  const item = hits[0];
  if (!allowed.has(item.wxid) || item.wxid === 'filehelper' || item.wxid === bridge.accountWxid
    || relayPartyId(item.wxid) === relayPartyId(owner)) return null;
  if (Array.isArray(nativeRelay?.whitelist) && !nativeRelay.whitelist.map(relayName)
    .some(label => [...labels(item), ...roles(item)].includes(label))) return null;
  const title = String(item.remark || item.name || '').trim();
  if (!title || contacts.items.some(other => other.wxid !== item.wxid && labels(other).includes(relayName(title)))) return null;
  const target = voiceTarget(item.wxid, title, item.isGroup === true ? 'group' : 'private');
  if (!target || prior && (prior.id !== target.id || prior.name !== target.name || prior.chatType !== target.chatType)) return null;
  return target;
}

function relayPath(owner) {
  return path.join(RELAY_DIR, crypto.createHash('sha256').update(owner).digest('hex') + '.json');
}

function readRelay(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function saveRelay(file, job) {
  fs.mkdirSync(RELAY_DIR, { recursive: true });
  const staged = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(staged, JSON.stringify(job), { flag: 'wx', mode: 0o600 });
    fs.renameSync(staged, file);
  } finally {
    try { fs.unlinkSync(staged); } catch { /* 已提交或无临时文件 */ }
  }
}

async function resolveRelayLastSong(settings, owner) {
  try {
    const out = await runCover(settings, ['list', '--limit', '200'], 5000);
    const orders = Array.isArray(out?.orders) ? out.orders : [];
    const ready = orders.filter(order => order && order.audio
      && ['ready', 'delivered'].includes(order.status));
    const owned = ready.filter(order => String(order.group?.id || '') === String(owner)
      || String(order.requester || '') === String(owner));
    const pool = owned.length ? owned : ready;
    pool.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    return String(pool[0]?.song || '');
  } catch {
    return '';
  }
}

async function relayOwnerTitle(whale, owner) {
  try {
    const config = (await whale.api('/api/config'))?.body?.config;
    const titles = config?.persona?.master?.titles || {};
    return String(titles[owner] || '').trim();
  } catch {
    return '';
  }
}

async function handleSongRelay(whale, message, settings, intent) {
  if (settings.relaySingEnabled !== true || message.platform !== 'wechat' || message.chatType !== 'private') return false;
  const owner = String(message.senderId || '').trim();
  if (!owner || !message.chatId || message.chatId === '-') return false;
  const from = await voiceTargetForMessage(whale, message);
  if (!from) return false;
  const file = relayPath(owner);
  if (relayBusy.has(file)) return true;
  relayBusy.add(file);
  try {
    const existing = readRelay(file);
    const confirmWord = intent.type === '确认';
    const cancelWord = intent.type === '取消';
    const confirmCode = intent.type === '唱歌确认';
    const cancelCode = intent.type === '唱歌取消';

    if (intent.type === 'request') {
      let song = intent.song;
      if (song === RELAY_LAST) {
        song = await resolveRelayLastSong(settings, owner);
        if (!song) {
          await reply(whale, message, '最近还没有唱好的歌，先点一首吧。');
          return true;
        }
      }
      const target = await relayContext(whale, settings, owner, intent.target);
      if (!target) {
        await reply(whale, message, '我没确认到这个目标或账号，先不发。可以说“唱《歌名》给谁听”。');
        return true;
      }
      if (existing?.sourceMessage && message.msgId === existing.sourceMessage) return true;
      if (['confirmed', 'allocating', 'rendering', 'sending'].includes(existing?.state)) {
        await reply(whale, message, '上一次代发还在准备，等它唱完再来吧。');
        return true;
      }
      const code = crypto.randomBytes(3).toString('hex');
      const ownerTitle = await relayOwnerTitle(whale, owner);
      saveRelay(file, { state: 'draft', code, owner, ownerTitle, from, target, targetWord: intent.target,
        song, originChat: message.chatId, sourceMessage: message.msgId, expires: Date.now() + RELAY_TTL });
      const where = target.chatType === 'group'
        ? `唱到「${target.name}」里`
        : `唱给${intent.target}听`;
      await reply(whale, message, `要我把《${song}》${where}吗？回「发」我就去，回「算了」就取消。`);
      return true;
    }

    // 自然确认词：没有待发草稿时不要拦截普通聊天。
    if ((confirmWord || cancelWord) && !existing) return false;
    if (!existing || existing.originChat !== message.chatId
      || existing.owner !== owner || !['draft', 'stopped'].includes(existing.state)
      || (confirmCode || cancelCode) && existing.code !== String(intent.code || '')) {
      await reply(whale, message, '这条待发歌曲我找不到了，重新跟我说一次吧。');
      return true;
    }
    if (Date.now() >= existing.expires) {
      await reply(whale, message, '这单等太久了，已经失效；重新跟我说一次吧。');
      return true;
    }
    if (existing.state === 'stopped') {
      await reply(whale, message, '这单已经停掉了，重新跟我说一次吧。');
      return true;
    }
    if (cancelWord || cancelCode) {
      saveRelay(file, { ...existing, state: 'stopped' });
      await reply(whale, message, '好，那这次不唱了。');
      return true;
    }
    if (!(await relayContext(whale, settings, owner, existing.targetWord, existing.target))) {
      saveRelay(file, { ...existing, state: 'stopped' });
      await reply(whale, message, '目标或账号刚变了，先不发了；重新跟我说一次吧。');
      return true;
    }
    saveRelay(file, { ...existing, state: 'confirmed', startedAt: Date.now() });
    const where = existing.target.chatType === 'group'
      ? `去「${existing.target.name}」里唱`
      : `去给${existing.targetWord}唱`;
    await reply(whale, message, `好叻，这就${where}。`);
    return true;
  } finally {
    relayBusy.delete(file);
  }
}

function relayTargetText(job) {
  const target = job && job.target;
  if (!target) return '';
  const ownerTitle = String(job.ownerTitle || '').trim();
  const who = String(job.targetWord || target.name || '').trim();
  const prefix = ownerTitle ? ownerTitle + '叫我' : '有人叫我';
  return target.chatType === 'group'
    ? `${prefix}唱《${job.song}》给大家听，我唱得怎么样？`
    : `${prefix}唱《${job.song}》给你听，${who}，我唱得你觉得好听吗？`;
}
async function finishSongRelay(whale, file, job, status, completed) {
  saveRelay(file, { ...job, state: status });
  const target = job.target;
  if (status === 'sent') {
    const who = String(job.targetWord || target?.name || '').trim();
    const text = relayTargetText(job);
    try { await whale.sendText(target.id, text, { name: target.name, chatType: target.chatType }); }
    catch { /* 语音已发，留言失败不重发语音 */ }
    const done = target.chatType === 'group'
      ? `已经在「${target.name}」里唱完啦～`
      : `已经在${who}那边唱完啦～`;
    await whale.sendText(job.from.id, done, { name: job.from.name, chatType: 'private' });
  } else {
    await whale.sendText(job.from.id,
      `这次没唱成，已确认 ${completed} 条。你核对一下目标会话吧。`,
      { name: job.from.name, chatType: 'private' });
  }
}

async function findRelayReusable(settings, song) {
  const out = await runCover(settings, ['list', '--status', 'ready', '--limit', '200'], 5000);
  const key = normName(song);
  const pool = (Array.isArray(out?.orders) ? out.orders : []).filter(order =>
    order && order.status === 'ready' && order.fullTrack === true
    && Array.isArray(order.audioParts) && order.audioParts.length > 0 && order.audio
    && normName(order.song) === key && playlistParts(order)
    && fs.existsSync(path.resolve(dataRoot(settings), String(order.audio))));
  pool.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
  return pool[0] || null;
}

async function processSongRelays(whale, settings) {
  let names;
  try { names = fs.readdirSync(RELAY_DIR).filter(name => /^[a-f0-9]{64}[.]json$/.test(name)); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  for (const name of names) {
    const file = path.join(RELAY_DIR, name);
    const job = readRelay(file);
    if (!job || !['confirmed', 'allocating', 'rendering', 'sending'].includes(job.state) || relayBusy.has(file)) continue;
    relayBusy.add(file);
    try {
      if (job.state === 'allocating') {
        // 工作进程重启且上一轮建单未落回执，宁可停单也不重放。
        await finishSongRelay(whale, file, job, 'stopped', 0);
        return true;
      }
      if (job.state === 'confirmed') {
        if (loadAuto()?.active?.id || readProactive()?.active) return false;
        if (!(await relayContext(whale, settings, job.owner, job.targetWord, job.target))) {
          await finishSongRelay(whale, file, job, 'stopped', 0);
          return true;
        }
        const reusable = await findRelayReusable(settings, job.song);
        if (reusable) {
          saveRelay(file, { ...job, state: 'sending', orderId: reusable.id, reuse: true, startedAt: job.startedAt || Date.now() });
          return true;
        }
        saveRelay(file, { ...job, state: 'allocating' });
        const result = await runCover(settings, ['order', '--song', job.song, '--requester', '代发唱歌',
          '--via', RELAY_SONG_VIA, '--chat-type', job.target.chatType, '--group-id', job.target.id,
          '--group-name', job.target.name], 5000);
        if (!result?.ok || !/^[0-9a-f]{8}$/i.test(String(result.order?.id || ''))) {
          await finishSongRelay(whale, file, job, 'stopped', 0);
          return true;
        }
        saveRelay(file, { ...job, state: 'rendering', orderId: result.order.id });
        try { startPrep(settings, result.order); }
        catch { await finishSongRelay(whale, file, job, 'stopped', 0); }
        return true;
      }
      const order = readRuntimeOrder(settings, job.orderId);
      const match = Boolean(order) && ((job.reuse === true && order.id === job.orderId)
        || (order.via === RELAY_SONG_VIA && order.group?.id === job.target.id));
      if (match && ['pending', 'making'].includes(order.status)
        && Date.now() - job.startedAt < 205 * 60 * 1000 && prepStatus(settings, order.id)?.status !== 'error') return true;
      if (!match || order.status !== 'ready' || !order.fullTrack || !playlistParts(order)) {
        await finishSongRelay(whale, file, job, 'stopped', 0);
        return true;
      }
      const request = 'relay:' + job.code;
      const progress = playlistProgress(settings, order, job.target, request);
      if (progress.status === 'pending') return true;
      const target = await relayContext(whale, settings, job.owner, job.targetWord, job.target);
      if (!target) {
        await finishSongRelay(whale, file, job, 'stopped', progress.completed);
        return true;
      }
      if (job.state !== 'sending') saveRelay(file, { ...job, state: 'sending' });
      const next = await advancePlaylist(settings, order, target, request);
      if (next.status === 'pending') return true;
      await finishSongRelay(whale, file, job, next.status === 'sent' ? 'sent' : 'stopped', next.completed);
      return true;
    } finally {
      relayBusy.delete(file);
    }
  }
  return false;
}


let timerRunning = false;

module.exports = {
  parseOrder,
  parseSongRelay,
  pickLikedSong,
  proactiveLibrarySend,
  loadSynthLibrary,
  findSynthEntry,
  relayTargetText,
  hooks: {
    async 'chat.pre_reply'(input) {
      const whale = input.whale;
      const message = input.message || {};
      const settings = input.settings || {};
      if (!whale || !message.text || (message.platform && message.platform !== 'wechat')) return { action: 'pass' };
      const choiceText = cleanText(message.text).normalize('NFKC');
      const format = LONG_FORMAT.exec(choiceText);
      if (format) {
        await handleLongFormat(whale, message, settings, format[1].toLowerCase(), format[2].toUpperCase());
        return { action: 'skip' };
      }
      const choice = await lookupNaturalFormat(whale, choiceText);
      if (choice?.orderId && ['WAV', '语音'].includes(choice.mode)) {
        await handleLongFormat(whale, message, settings, choice.orderId, choice.mode);
        return { action: 'skip' };
      }
      if (Array.isArray(choice?.choices) && choice.choices.length) {
        const titles = choice.choices.map(song => '《' + song + '》');
        const songs = titles.length > 1 ? titles.slice(0, -1).join('、') + '和' + titles.at(-1) : titles[0];
        await reply(whale, message, songs + '都唱好啦。你想先发哪首？比如「'
          + titles[0] + (choice.mode === 'WAV' ? '发文件吧' : '发语音吧') + '」。');
        return { action: 'skip' };
      }
      const relay = parseSongRelay(cleanText(message.text));
      if (relay && await handleSongRelay(whale, message, settings, relay)) return { action: 'skip' };
      if (LIKED_ORDER.test(cleanText(message.text))) {
        await handleLikedOrder(whale, message, settings);
        return { action: 'skip' };
      }
      if (settings.onlyGroup === true && message.chatType !== 'group') {
        // 群聊限定时保留私聊播放已经生成的成品。
        const privateSing = SING_RE.exec(cleanText(message.text));
        if (!privateSing) return { action: 'pass' };
        await handleSing(whale, message, settings, privateSing[1].trim());
        return { action: 'skip' };
      }

      const text = cleanText(message.text);
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
      if (timerRunning) return {};
      timerRunning = true;
      try {
        const settings = input.settings || {};
        if (input.whale && !(await processManualPlaylists(input.whale, settings))
          && !(await processSongRelays(input.whale, settings))) {
          await autoTick(input.whale, settings);
        }
      } catch (e) {
        try { fs.appendFileSync(AUTO_LOG, `[${new Date().toISOString()}] timer.tick: ${e && e.message || e}\n`); } catch { /* ignore */ }
      } finally {
        timerRunning = false;
      }
      return {};
    },
  },
};
