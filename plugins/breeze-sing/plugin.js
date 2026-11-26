'use strict';

/**
 * Breezeblue 翻唱（whale-plugin/1，4 级）：
 *   群内/私聊「点歌」→ cover CLI 落单 → task.tick@1 轮询 → breeze-prep/seed-vc 渲染。
 *
 * 和旧 Api 4 最大的区别：
 *   - 新协议没有 plugin/pre_reply 的「唤醒」控制，也没有音频文件投递能力；
 *     聊天内命令只在宿主已决定回复时进入 chat.pre_reply@1（例如私聊、@、主人）；
 *     翻唱音频无法作为微信语音发出，只能发一句文本提示，成品留在本机 cover 数据目录。
 *   - 没有 whale.* / /api/* / 宿主 config 读取；所有对外消息走 host.call('message.send@1')。
 *   - 没有 state 注入：去重、auto-state、锁都写插件自己的 data 目录（process.cwd()）。
 */

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 宿主的 Node worker 以插件 data 目录为 cwd；这里不碰安装目录，卸载时可整体清理。
const STATE_DIR = process.cwd();
const AUTO_STATE = path.join(STATE_DIR, 'auto-state.json');
const AUTO_LOG = path.join(STATE_DIR, 'auto-render.log');
const PREP_LOG = path.join(STATE_DIR, 'breeze-prep.log');
const RECENT_FILE = path.join(STATE_DIR, 'recent.json');
const TICK_LOCK = path.join(STATE_DIR, 'tick.lock');

const CLI_CANDIDATES = [
  path.join(os.homedir(), 'whale-cover', 'tools', 'cover.mjs'),
  path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-whale-cover', 'tools', 'cover.mjs'),
];

const PREFIXES = ['点歌', '点播', '来一首', '來一首', 'cover'];
const HELP_WORDS = ['点歌帮助', '点歌说明', '点歌菜单', '点歌玩法'];
const LIST_WORDS = ['点歌单', '点歌列表', '歌单', '点歌进度', '排队'];
const CANCEL_RE = /^取消(?:点歌|点播)\s*(.*)$/;
const SING_RE = /^(?:唱|唱一个|唱一首|来一段|发歌|发一下|听歌|听听)\s*[:：]?\s*(.*)$/;
const ORDER_RE = new RegExp('^(?:' + PREFIXES.join('|') + ')[\\s:：,，]*(.*)$', 'i');

// 微信 UIA 发送会把换行压成空格，菜单必须写成一行，用「；」分隔。
const MENU_TEXT = '点歌：点歌 歌名；指定原唱：点歌 歌名 - 歌手；自动下载并做 54 秒 breezeblue 音色翻唱（成品留在本机，新协议不能发微信语音）；看队列：点歌单；撤单：取消点歌 歌名';

const STALE_MS = 15 * 60 * 1000;
const IDLE_STALL_MS = 6 * 60 * 1000;
const PROGRESS_MS = 2 * 60 * 1000;
const ACTIVE_STATUSES = ['pending', 'making', 'ready'];
const STATUS_RANK = { ready: 3, making: 2, pending: 1 };
const SONG_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma']);

function error(message) {
  return Object.assign(new Error(message), { code: message });
}

function ensureStateDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* 宿主 data 目录通常已存在 */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  ensureStateDir();
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value));
    try {
      fs.renameSync(temporary, file);
    } catch {
      // Windows 上目标存在时 rename 可能失败；插件 tick 有单实例锁，退化为覆盖可接受。
      fs.rmSync(file, { force: true });
      fs.renameSync(temporary, file);
    }
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
  }
}

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const engine = value.engine === 'rvc' ? 'rvc' : 'seedvc';
  const maxSeconds = Math.max(10, Math.min(180, Number(value.maxSeconds) || 54));
  return {
    coverCli: typeof value.coverCli === 'string' ? value.coverCli.trim() : '',
    dataDir: typeof value.dataDir === 'string' ? value.dataDir.trim() : '',
    python: typeof value.python === 'string' ? value.python.trim() : '',
    ffmpeg: typeof value.ffmpeg === 'string' ? value.ffmpeg.trim() : '',
    engine,
    maxSeconds,
    onlyGroup: value.onlyGroup !== false,
    autoRender: value.autoRender !== false,
  };
}

function cliPath(settings) {
  const custom = settings.coverCli;
  if (custom && fs.existsSync(custom)) return custom;
  for (const candidate of CLI_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return CLI_CANDIDATES[0];
}

function dataRoot(settings) {
  if (settings.dataDir) return settings.dataDir;
  if (process.env.WHALE_COVER_DATA_DIR) return process.env.WHALE_COVER_DATA_DIR;
  return path.join(os.homedir(), '.dsh', 'whale-cover');
}

function runCover(settings, args, timeoutMs) {
  return new Promise((resolve) => {
    const cli = cliPath(settings);
    execFile(process.execPath, [cli, ...args, '--json'], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    }, (failure, stdout, stderr) => {
      const text = String(stdout || '').trim();
      if (text) {
        try { resolve(JSON.parse(text)); return; } catch { /* 落到下面统一报错 */ }
      }
      resolve({ ok: false, error: (failure && failure.message) || String(stderr || '').trim() || 'cover CLI 没有输出' });
    });
  });
}

function prepScriptPath(settings) {
  return path.join(path.dirname(path.dirname(cliPath(settings))), 'whale-plugin', 'breeze-prep.mjs');
}

function prepStatus(settings, orderId) {
  return readJson(path.join(dataRoot(settings), 'prep-status', orderId + '.json'), null);
}

function renderProgress(settings, orderId) {
  return readJson(path.join(dataRoot(settings), 'work', orderId, 'progress.json'), null);
}

function progressText(order, elapsedMs, hint, settings) {
  const mins = Math.max(1, Math.round(elapsedMs / 60000));
  let stage = '准备中';
  if (hint && hint.stage) stage = hint.stage;
  else {
    const work = path.join(dataRoot(settings), 'work', order.id);
    if (fs.existsSync(path.join(work, 'sep', 'htdemucs', 'song', 'vocals.wav'))) stage = '换声合成';
    else if (fs.existsSync(path.join(work, 'song.wav'))) stage = '分离人声';
  }
  let detail = '';
  if (hint && Number(hint.total) > 0 && Number(hint.step) > 0) {
    const chunk = Number(hint.chunk) || 0;
    detail = chunk > 0
      ? `（第 ${chunk} 段，${Number(hint.step)}/${Number(hint.total)} 步）`
      : `（${Number(hint.step)}/${Number(hint.total)} 步）`;
  }
  return `《${order.song}》进度：已 ${mins} 分钟，${stage}${detail}。完成后会提示（新协议不能发翻唱音频）。`;
}

function loadAuto() {
  const value = readJson(AUTO_STATE, {});
  return value && typeof value === 'object' ? value : {};
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
  writeJson(AUTO_STATE, state);
}

function loadRecent() {
  const raw = readJson(RECENT_FILE, {});
  const now = Date.now();
  const recent = new Map();
  for (const [key, ts] of Object.entries(raw || {})) {
    if (now - Number(ts) <= 60000) recent.set(key, Number(ts));
  }
  return recent;
}

function saveRecent(recent) {
  const now = Date.now();
  const value = {};
  for (const [key, ts] of recent) if (now - Number(ts) <= 60000) value[key] = Number(ts);
  writeJson(RECENT_FILE, value);
}

function acquireTickLock() {
  ensureStateDir();
  try {
    const fd = fs.openSync(TICK_LOCK, 'wx');
    try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
    return true;
  } catch (failure) {
    if (failure && failure.code === 'EEXIST') {
      try {
        const stat = fs.statSync(TICK_LOCK);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          fs.rmSync(TICK_LOCK, { force: true });
          return acquireTickLock();
        }
      } catch { /* 锁刚被删 */ }
    }
    return false;
  }
}

function releaseTickLock() {
  try { fs.rmSync(TICK_LOCK, { force: true }); } catch { /* ignore */ }
}

async function sendText(host, chatId, text, options = {}) {
  if (!host || typeof host.call !== 'function') throw error('host_unavailable');
  const payload = { chatId: String(chatId || ''), text: String(text || '') };
  if (options.name) payload.name = String(options.name).slice(0, 80);
  if (options.chatType) payload.chatType = options.chatType;
  return host.call('message.send@1', payload);
}

function groupTarget(order) {
  const id = String(order && order.group && order.group.id || '');
  if (!id) return null;
  return { id, name: String(order.group.name || id), chatType: 'group' };
}

function fillGroupNames(orders) {
  const names = new Map();
  for (const order of orders) {
    const id = String(order && order.group && order.group.id || '');
    if (id && order.group.name) names.set(id, String(order.group.name));
  }
  for (const order of orders) {
    const id = String(order && order.group && order.group.id || '');
    if (id && !order.group.name && names.has(id)) order.group.name = names.get(id);
  }
  return orders;
}

function isOurs(order) {
  if (!order || order.engine !== 'seedvc' || !(order.group && order.group.id)) return false;
  if (order.status === 'pending') return true;
  return Boolean(order.source && /\.wav$/i.test(String(order.source)));
}

async function notifyGroup(host, order, text) {
  const target = groupTarget(order);
  if (!host || !target) return;
  try {
    await sendText(host, target.id, text, { name: target.name, chatType: 'group' });
  } catch { /* 桥没起时静默，别把插件挂掉 */ }
}

async function maybeReportProgress(host, settings, order, state) {
  if (!host || !order || !order.group) return;
  const started = Number(state.progressStartedAt) || Date.now();
  if (!state.progressStartedAt) { state.progressStartedAt = started; saveAuto(state); }
  const last = Number(state.lastProgressAt) || started;
  if (Date.now() - last < PROGRESS_MS) return;
  state.lastProgressAt = Date.now();
  saveAuto(state);
  const hint = order.status === 'making' ? renderProgress(settings, order.id) : null;
  await notifyGroup(host, order, progressText(order, Date.now() - started, hint, settings));
}

function songsDirs(settings) {
  const dirs = [];
  if (settings.dataDir) dirs.push(path.join(settings.dataDir, 'songs'));
  if (process.env.WHALE_COVER_DATA_DIR) dirs.push(path.join(process.env.WHALE_COVER_DATA_DIR, 'songs'));
  dirs.push(path.join(os.homedir(), '.dsh', 'whale-cover', 'songs'));
  return [...new Set(dirs)];
}

function normName(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\s\-_·.,，。()（）【】'"“”‘’]/g, '');
}

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
  const args = [cliPath(settings), 'render', order.id, '--engine', settings.engine, '--json'];
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

function startPrep(settings, order) {
  const prep = prepScriptPath(settings);
  if (!fs.existsSync(prep)) throw new Error('缺少 breeze-prep.mjs：' + prep);
  const python = settings.python || path.join(os.homedir(), '.dsh', 'whale-cover', 'engine', 'venv', 'Scripts', 'python.exe');
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
      BREEZE_ENGINE: settings.engine,
      BREEZE_FFMPEG_DIR: ffmpegDir,
      BREEZE_CACHE: path.join(repo, '.tmp', 'breeze-cache'),
      BREEZE_SECONDS: String(settings.maxSeconds),
      BREEZE_LOG: PREP_LOG,
    },
  });
  if (fd !== 'ignore') { try { fs.closeSync(fd); } catch { /* ignore */ } }
  child.unref();
  return child.pid || 0;
}

async function deliverReady(host, settings, order, state) {
  const target = groupTarget(order);
  if (!host || !target) return false;
  if (state.sent && state.sent[order.id]) return true;
  try {
    await sendText(host, target.id,
      `《${order.song}》的翻唱做好了，但 whale-plugin/1 不能把音频文件投递成微信语音；成品留在本机 cover 数据目录。`,
      { name: target.name, chatType: 'group' });
  } catch { return false; }
  state.sent = state.sent || {};
  state.sent[order.id] = Date.now();
  return true;
}

async function autoTick(host, settings) {
  if (!host || settings.autoRender === false) return;
  const state = loadAuto();
  const out = await runCover(settings, ['list', '--status', 'pending,making,ready', '--limit', '100'], 10000);
  if (!out || !out.ok) return;
  const orders = fillGroupNames(Array.isArray(out.orders) ? out.orders : []);
  pruneFailedOrders(settings, state.active && state.active.id);
  const tidy = dedupeActive(orders.filter(isOurs), state.active && state.active.id);
  for (const duplicate of tidy.dropped) {
    if (state.active && state.active.id === duplicate.id) state.active = null;
    await dropOrder(settings, duplicate, '重复点歌，自动清理');
  }
  const ours = tidy.keep;
  const byId = new Map(ours.map((order) => [order.id, order]));
  let active = state.active && byId.get(state.active.id) ? byId.get(state.active.id) : null;
  if (active && !isOurs(active)) active = null;
  if (state.active && (!active || !isOurs(active))) { state.active = null; saveAuto(state); }

  if (active && (active.status === 'making' || (active.status === 'pending' && state.active.prep))) {
    await maybeReportProgress(host, settings, active, state);
  }

  if (!active) {
    const unsent = ours.find((order) => order.status === 'ready' && !(state.sent && state.sent[order.id]));
    if (unsent) {
      state.active = { id: unsent.id, startedAt: Date.now(), recovered: true };
      saveAuto(state);
      active = unsent;
    }
  }

  if (active && active.status === 'ready') {
    const ok = await deliverReady(host, settings, active, state);
    if (ok) {
      state.active = null;
      state.attempts = {};
      state.progressStartedAt = null;
      state.lastProgressAt = null;
      saveAuto(state);
      return;
    }
    state.attempts = state.attempts || {};
    const count = (Number(state.attempts[active.id]) || 0) + 1;
    if (count >= 3) {
      state.active = null;
      delete state.attempts[active.id];
      saveAuto(state);
      await notifyGroup(host, active, `《${active.song}》做好了，但文本提示也发不出去；请在本机 cover 数据目录查看成品。`);
    } else {
      state.attempts[active.id] = count;
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
    await notifyGroup(host, active, reason
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
      await notifyGroup(host, active, `《${active.song}》渲染卡住了（${Math.round(idle / 60000)} 分钟没进度），已停掉；等会儿再点一次吧。`);
      return;
    }
    if (!(age > STALE_MS)) return;
  }
  if (active && active.status === 'pending') {
    const waited = Date.now() - Number(state.active.startedAt || 0);
    if (state.active.prep) {
      const hint = prepStatus(settings, active.id);
      if (hint && hint.status === 'error') {
        state.failedAt = state.failedAt || {};
        state.failedAt[active.id] = Date.now();
        state.active = null;
        saveAuto(state);
        await notifyGroup(host, active, `《${active.song}》没准备好：${String(hint.error || '').slice(0, 120)}`);
        await dropOrder(settings, active, '下载/准备失败，自动清理');
        return;
      }
      if (waited < 8 * 60 * 1000) return;
      state.failedAt = state.failedAt || {};
      state.failedAt[active.id] = Date.now();
      state.active = null;
      saveAuto(state);
      await notifyGroup(host, active, `《${active.song}》下载/准备超时了，等会儿再点一次吧。`);
      await dropOrder(settings, active, '下载/准备超时，自动清理');
      return;
    }
    if (waited < 15000) return;
    state.failedAt = state.failedAt || {};
    state.failedAt[active.id] = Date.now();
    state.active = null;
    saveAuto(state);
    await notifyGroup(host, active, `《${active.song}》的引擎没起来，先让主人跑一下 cover engine status。`);
    return;
  }

  let next = null;
  if (active && active.status === 'making') next = active;
  else {
    const blocked = state.failedAt || {};
    const cooled = (id) => Date.now() - Number(blocked[id] || 0) < 10 * 60 * 1000;
    const pending = ours.filter((order) => order.status === 'pending' && !cooled(order.id))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const stale = ours.filter((order) => order.status === 'making' && !cooled(order.id)
      && Date.now() - Date.parse(order.updatedAt || 0) > STALE_MS)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    next = stale[0] || pending[0] || null;
  }
  if (!next) return;

  if (!next.source) {
    const hint = prepStatus(settings, next.id);
    if (hint && hint.status === 'error') {
      state.failedAt = state.failedAt || {};
      state.failedAt[next.id] = Date.now();
      state.active = null;
      saveAuto(state);
      await notifyGroup(host, next, `《${next.song}》没准备好：${String(hint.error || '').slice(0, 120)}`);
      await dropOrder(settings, next, '下载/准备失败，自动清理');
      return;
    }
    try {
      const pid = startPrep(settings, next);
      state.active = { id: next.id, startedAt: Date.now(), pid, prep: true };
      state.progressStartedAt = Date.now();
      state.lastProgressAt = Date.now();
      saveAuto(state);
      await notifyGroup(host, next, `收到《${next.song}》，正在下载原曲、切 ${settings.maxSeconds} 秒副歌～`);
    } catch (failure) {
      state.failedAt = state.failedAt || {};
      state.failedAt[next.id] = Date.now();
      state.active = null;
      saveAuto(state);
      await notifyGroup(host, next, `《${next.song}》起不来：${String(failure && failure.message || failure).slice(0, 100)}`);
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
    await notifyGroup(host, next, `《${next.song}》找不到原曲，先把音频放进 ${dir} 再点一次；文件名起成歌名最省事。`);
    return;
  }
  const pid = startRender(settings, next, source);
  state.active = { id: next.id, startedAt: Date.now(), pid };
  state.progressStartedAt = Date.now();
  state.lastProgressAt = Date.now();
  saveAuto(state);
}

function cleanText(raw) {
  return String(raw || '')
    .replace(/\[CQ:at,[^\]]*\]/g, ' ')
    .replace(/@[^\s@，,。:：]{1,32}/g, ' ')
    .trim();
}

function parseOrder(text) {
  const match = ORDER_RE.exec(text);
  if (!match) return null;
  let rest = String(match[1] || '').trim();
  if (!rest) return { help: true };
  let note = '';
  const noteMatch = /[（(]([^（）()]{1,40})[）)]\s*$/.exec(rest);
  if (noteMatch) {
    note = noteMatch[1].trim();
    rest = rest.slice(0, noteMatch.index).trim();
  }
  let artist = '';
  const sep = /\s+[-—–·|｜]\s+|\s*[·|｜]\s*/.exec(rest);
  if (sep && sep.index > 0) {
    artist = rest.slice(sep.index + sep[0].length).trim();
    rest = rest.slice(0, sep.index).trim();
  }
  const song = rest.replace(/^《|》$/g, '').trim();
  if (!song || song.length > 100) return null;
  return { song, artist: artist.replace(/^《|》$/g, ''), note };
}

function nameFor(message) {
  if (message.chatType === 'group') return message.chatTitle || message.chatId;
  return message.senderName || message.senderId || message.chatId;
}

function chatFor(message) {
  return message.chatType === 'group' ? message.chatId : (message.senderId || message.chatId);
}

async function reply(host, message, text) {
  try {
    await sendText(host, chatFor(message), text, {
      name: nameFor(message),
      chatType: message.chatType === 'group' ? 'group' : 'private',
    });
  } catch { /* 桥没起时静默，别把插件挂掉 */ }
}

function okText(order, position) {
  const pos = Number(position) || 0;
  const tail = pos ? `排第 ${pos} 位` : '排队里';
  return `收到～《${order.song}》${tail}，我自己找原曲；做好后会提示（新协议不能发翻唱音频）。`;
}

async function handleOrder(host, message, settings, parsed) {
  const me = String(message.senderName || message.senderId || '群友');
  const key = [message.chatId, message.senderId || me, message.msgId || parsed.song].join('|');
  const recent = loadRecent();
  if (recent.has(key)) return true;
  recent.set(key, Date.now());
  saveRecent(recent);

  const args = [
    'order',
    '--song', parsed.song,
    '--requester', me,
    '--via', 'group',
    '--engine', settings.engine,
    '--group-id', String(message.chatId || ''),
  ];
  if (message.chatTitle) args.push('--group-name', String(message.chatTitle));
  if (parsed.artist) args.push('--artist', parsed.artist);
  if (parsed.note) args.push('--note', parsed.note);
  if (message.senderId) args.push('--wxid', String(message.senderId));

  const out = await runCover(settings, args, 15000);
  if (!out || !out.ok) {
    await reply(host, message, '这张单没接住，等会儿再点一次。');
    return true;
  }
  await reply(host, message, okText(out.order, out.position));
  return true;
}

function orderKey(order) {
  return [
    String((order.group && order.group.id) || ''),
    normName(order.song),
    normName(order.artist),
  ].join('|');
}

function dedupeActive(orders, activeId) {
  const groups = new Map();
  for (const order of orders) {
    if (!ACTIVE_STATUSES.includes(order.status)) continue;
    const key = orderKey(order);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
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
  try { await runCover(settings, ['cancel', order.id, '--reason', reason], 10000); } catch { /* 已经终态就继续删文件 */ }
  try { fs.rmSync(path.join(dataRoot(settings), 'orders', order.id + '.json'), { force: true }); } catch { /* 删不掉下次 tick 再试 */ }
}

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
    const last = [...events].reverse().find((event) => event && event.note && /fail|error|失败|错/i.test(String(event.status) + String(event.note)));
    return String((last && last.note) || latest.note || '').replace(/\s+/g, ' ').slice(0, 160);
  } catch { return ''; }
}

async function handleList(host, message, settings) {
  const out = await runCover(settings, ['list', '--limit', '100'], 15000);
  if (!out || !out.ok) {
    await reply(host, message, '队列暂时读不出来。');
    return;
  }
  const mine = (out.orders || []).filter((order) => !order.group || !order.group.id || String(order.group.id) === String(message.chatId));
  const { keep } = dedupeActive(mine);
  const active = keep.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (!active.length) {
    await reply(host, message, '这个群还没人点歌，发「点歌 歌名」试试。');
    return;
  }
  const label = { pending: '排队', making: '制作中', ready: '成品（无法发语音）' };
  const parts = active.slice(0, 5).map((order) => {
    const artist = order.artist ? ' / ' + order.artist : '';
    const who = order.requester ? ' ← ' + order.requester : '';
    return `《${order.song}》${artist}${who}（${label[order.status] || order.status}）`;
  });
  let text = '本群点歌单：' + parts.join('；');
  if (active.length > 5) text += `；…… 还有 ${active.length - 5} 首`;
  await reply(host, message, text);
}

async function handleCancel(host, message, settings, wanted) {
  const out = await runCover(settings, ['list', '--limit', '100'], 15000);
  if (!out || !out.ok) {
    await reply(host, message, '队列暂时读不出来。');
    return;
  }
  const names = new Set([message.senderName, message.senderId].filter(Boolean).map(String));
  const mine = (out.orders || []).filter((order) => ['pending', 'making'].includes(order.status)
    && (names.has(String(order.wxid || '')) || names.has(String(order.requester || '')))
    && (!order.group || !order.group.id || String(order.group.id) === String(message.chatId)));
  const target = mine.find((order) => order.song === wanted) || (mine.length === 1 && !wanted ? mine[0] : null);
  if (!target) {
    await reply(host, message, wanted ? `没找到你点的《${wanted}》。` : '你现在没有在排队的歌。');
    return;
  }
  const result = await runCover(settings, ['cancel', target.id], 15000);
  await reply(host, message, result && result.ok ? `好，撤掉《${target.song}》。` : '撤单失败，晚点再说。');
}

async function handleSing(host, message, settings, wanted) {
  const out = await runCover(settings, ['list', '--limit', '100'], 15000);
  if (!out || !out.ok) {
    await reply(host, message, '队列暂时读不出来。');
    return;
  }
  const ready = (out.orders || []).filter((order) => ['ready', 'delivered'].includes(order.status)
    && (order.hasAudio || order.durationSec)
    && (!order.group || !order.group.id || String(order.group.id) === String(message.chatId)));
  const want = String(wanted || '').trim();
  const target = want
    ? ready.find((order) => order.id === want) || ready.find((order) => order.song === want) || ready.find((order) => order.song.includes(want))
    : ready[0];
  if (!target) {
    await reply(host, message, want
      ? `《${want}》还没唱好，等做好了再喊我。`
      : '这个群还没有唱好的歌，先点一首吧。');
    return;
  }
  // 诚实提示：新协议没有音频文件投递；不能再用 whale.sendVoice('[[cover:id]]')。
  await reply(host, message,
    `《${target.song}》已经做好，但 whale-plugin/1 不能把翻唱音频作为微信语音发出；成品留在本机 cover 数据目录，请手动播放。`);
}

async function handlePreReply(input, ctx) {
  const host = ctx.host;
  const message = input.message || {};
  const settings = normalizeSettings(ctx.settings);
  if (!host || !message.text) return { action: 'pass' };

  const text = cleanText(message.text);
  if (!text) return { action: 'pass' };

  if (settings.onlyGroup && message.chatType !== 'group') {
    // 私聊默认不接管点歌，但「唱 歌名」保留；没有音频投递，只回文本说明。
    const privateSing = SING_RE.exec(text);
    if (!privateSing) return { action: 'pass' };
    await handleSing(host, message, settings, privateSing[1].trim());
    return { action: 'skip' };
  }

  if (HELP_WORDS.includes(text)) {
    await reply(host, message, MENU_TEXT);
    return { action: 'skip' };
  }
  if (LIST_WORDS.includes(text)) {
    await handleList(host, message, settings);
    return { action: 'skip' };
  }
  const cancel = CANCEL_RE.exec(text);
  if (cancel) {
    await handleCancel(host, message, settings, cancel[1].trim());
    return { action: 'skip' };
  }
  const sing = SING_RE.exec(text);
  if (sing) {
    await handleSing(host, message, settings, sing[1].trim());
    return { action: 'skip' };
  }
  const parsed = parseOrder(text);
  if (!parsed) return { action: 'pass' };
  if (parsed.help) {
    await reply(host, message, MENU_TEXT);
    return { action: 'skip' };
  }
  await handleOrder(host, message, settings, parsed);
  return { action: 'skip' };
}

async function runAutoTick(host, settings) {
  if (!acquireTickLock()) return;
  try {
    await autoTick(host, settings);
  } catch (failure) {
    try { fs.appendFileSync(AUTO_LOG, `[${new Date().toISOString()}] task.tick: ${failure && failure.message || failure}\n`); } catch { /* ignore */ }
  } finally {
    releaseTickLock();
  }
}

async function taskTick(input, ctx) {
  const settings = normalizeSettings(ctx.settings || (input && input.settings));
  if (settings.autoRender === false) return {};
  await runAutoTick(ctx.host, settings);
  return {};
}

function toolMessage(input) {
  return {
    chatId: String(input.chatId || input.chat_id || ''),
    chatType: input.chatType === 'private' ? 'private' : 'group',
    senderId: String(input.senderId || input.sender_id || ''),
    senderName: String(input.senderName || input.sender_name || ''),
    chatTitle: String(input.chatTitle || input.chat_title || ''),
    msgId: String(input.msgId || input.msg_id || 'tool:' + Date.now()),
    text: String(input.text || ''),
  };
}

async function toolAction(input, ctx) {
  const settings = normalizeSettings(ctx.settings);
  const action = String((input && input.action) || 'status');
  if (action === 'help') return { ok: true, text: MENU_TEXT };
  if (action === 'tick') {
    await runAutoTick(ctx.host, settings);
    return { ok: true, message: 'tick 已执行' };
  }
  if (action === 'status') {
    const out = await runCover(settings, ['list', '--status', 'pending,making,ready', '--limit', '100'], 15000);
    return out && out.ok ? { ok: true, orders: out.orders || [] } : { ok: false, error: (out && out.error) || 'cover CLI 不可用' };
  }
  const message = toolMessage(input || {});
  if (!message.chatId) return { ok: false, error: 'chatId_required' };
  if (action === 'list') { await handleList(ctx.host, message, settings); return { ok: true }; }
  if (action === 'cancel') { await handleCancel(ctx.host, message, settings, String(input.song || '')); return { ok: true }; }
  if (action === 'sing') { await handleSing(ctx.host, message, settings, String(input.song || '')); return { ok: true }; }
  if (action === 'order') {
    if (!message.text) return { ok: false, error: 'text_required' };
    const parsed = parseOrder(message.text);
    if (!parsed || parsed.help) return { ok: false, error: 'order_text_invalid' };
    await handleOrder(ctx.host, message, settings, parsed);
    return { ok: true };
  }
  return { ok: false, error: 'unknown_action' };
}

module.exports = {
  parseOrder,
  normalizeSettings,
  providers: {
    'chat.pre_reply@1': async (input, ctx) => handlePreReply(input, ctx),
    'task.tick@1': async (input, ctx) => taskTick(input, ctx),
    'tool.run@1': async (input, ctx) => toolAction(input, ctx),
  },
};

