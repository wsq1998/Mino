// Mio - macOS 桌面陪伴机器人 · 主进程
const { app, BrowserWindow, ipcMain, Menu, Notification, globalShortcut, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, exec } = require('child_process');

const WIN_W = 320;
const WIN_W_WIDE = 440; // v1.2 详情档：面板 360px + 两侧边距
const WIN_H = 560;
const stateFile = path.join(app.getPath('userData'), 'mio-state.json');
// v1.2 持久化文件（均位于 userData，上限可控）
const historyFile = path.join(app.getPath('userData'), 'mio-history.json');      // S5 24h 采样
const messagesFile = path.join(app.getPath('userData'), 'mio-messages.json');    // S6 消息中心
const cleanHistoryFile = path.join(app.getPath('userData'), 'mio-clean-history.json'); // C5 清理历史

let win = null;
let cursorTimer = null;
let samplerTimer = null;

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  const next = { ...loadState(), ...patch };
  try { fs.writeFileSync(stateFile, JSON.stringify(next)); } catch {}
}

// ============ v1.4：设置（含默认值，缺失字段自动补齐 → 老配置文件可直接升级）============
const DEFAULT_SETTINGS = {
  chime: { enabled: true, from: 9, to: 22, notify: false },
  health: { enabled: true, sit: true, water: false, eye: false, quietFrom: 22, quietTo: 9 },
  stealth: { enabled: true },
};

function getSettings() {
  const s = loadState().settings || {};
  const merge = (k) => ({ ...DEFAULT_SETTINGS[k], ...(s[k] || {}) });
  return { chime: merge('chime'), health: merge('health'), stealth: merge('stealth') };
}

// ============ v1.4 F：多显示器位置记忆 ============
// 旧版只存一组全局 x/y，外接屏拔掉后窗口会落到所有屏幕之外。
// 现按显示器 id 分别记忆，并做越界回退。
function displayIdOf(x, y) {
  try {
    return String(screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).id);
  } catch { return '0'; }
}

// 窗口矩形与任一显示器有交集才算可见（只判左上角不够，窗口可能大半个在屏外）
function rectVisibleOnAnyDisplay(x, y, w, h) {
  try {
    return screen.getAllDisplays().some((d) => {
      const b = d.bounds;
      return x < b.x + b.width && x + w > b.x && y < b.y + b.height && y + h > b.y;
    });
  } catch { return false; }
}

function defaultPosFor(display) {
  const b = (display && (display.workArea || display.bounds)) || { x: 0, y: 0, width: 1440, height: 900 };
  return { x: b.x + b.width - WIN_W - 40, y: b.y + b.height - WIN_H - 40 };
}

// 异步执行 shell 命令（扫描类重命令专用，防主进程阻塞）。
// 无条件返回 stdout：du 等命令遇 TCC 保护目录会部分失败（exit 1），
// 但 stdout 里已算出的有效行仍然可用，调用方按行解析并过滤空行，语义安全
function execP(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: opts.timeout || 15000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
      resolve((stdout || '').toString());
    });
  });
}

function createWindow() {
  const saved = loadState();

  // v1.4 F：优先落在光标所在那块屏，并按屏分别记忆位置
  let targetDisplay = screen.getPrimaryDisplay();
  try { targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || targetDisplay; } catch {}

  const positions = { ...(saved.positions || {}) };
  // 旧配置迁移：只有全局 x/y 时把它当作主屏记录，避免升级后位置跳变
  const primaryId = String(screen.getPrimaryDisplay().id);
  if (!positions[primaryId] && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    positions[primaryId] = { x: saved.x, y: saved.y };
  }

  let pos = positions[String(targetDisplay.id)];
  if (!pos || !rectVisibleOnAnyDisplay(pos.x, pos.y, WIN_W, WIN_H)) {
    pos = defaultPosFor(targetDisplay); // 首次或记录已越界 → 落到该屏右下角
  }
  // 迁移/首次结果即时落盘，避免每次启动重复推导
  if (!saved.positions) saveState({ positions });
  const { x, y } = pos;

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x, y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: saved.alwaysOnTop ?? true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(saved.alwaysOnTop ?? true, 'floating');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.setOpacity(saved.opacity ?? 1);

  // 默认点击穿透，悬停在可交互元素上时由渲染进程关闭
  win.setIgnoreMouseEvents(true, { forward: true });

  // v1.4 F：按窗口中心所在显示器分别记忆位置
  win.on('moved', () => {
    const [mx, my] = win.getPosition();
    const id = displayIdOf(mx + WIN_W / 2, my + WIN_H / 2);
    const positions = { ...(loadState().positions || {}), [id]: { x: mx, y: my } };
    saveState({ x: mx, y: my, positions }); // 仍写全局 x/y，向后兼容
  });

  // 全局光标轮询：让 Mio 的视线能跟随屏幕任意位置的鼠标
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    try {
      const pt = screen.getCursorScreenPoint();
      const [wx, wy] = win.getPosition();
      win.webContents.send('cursor', { x: pt.x - wx, y: pt.y - wy });
    } catch {}
  }, 80);
}

function showContextMenu() {
  const saved = loadState();
  const menu = Menu.buildFromTemplate([
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: saved.alwaysOnTop ?? true,
      click: (item) => {
        win.setAlwaysOnTop(item.checked, 'floating');
        saveState({ alwaysOnTop: item.checked });
      },
    },
    {
      label: '透明度',
      submenu: [1, 0.8, 0.6].map((v) => ({
        label: `${v * 100}%`,
        type: 'radio',
        checked: (saved.opacity ?? 1) === v,
        click: () => { win.setOpacity(v); saveState({ opacity: v }); },
      })),
    },
    { type: 'separator' },
    { label: '显示/隐藏 (⌥Space)', click: () => toggleWindow() },
    { type: 'separator' },
    { label: '退出 Mio', click: () => app.quit() },
  ]);
  menu.popup({ window: win });
}

function toggleWindow() {
  if (!win) return;
  win.isVisible() ? win.hide() : win.show();
}

// ---- IPC ----
ipcMain.on('mouse-interactive', (_e, interactive) => {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!interactive, { forward: true });
});

ipcMain.on('context-menu', showContextMenu);

// v1.2 双档宽度：卡片展开时窗口加宽到 440（面板 360），保持右缘锚定
// 注意：窗口必须"瞬时"改尺寸，视觉过渡全部交给渲染层 CSS —— 两边同时做动画会互相打架导致掉帧
ipcMain.on('panel-expand', (_e, expand) => {
  if (!win || win.isDestroyed()) return;
  try {
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    const target = expand ? WIN_W_WIDE : WIN_W;
    if (w === target) return;
    const delta = target - w;
    win.setBounds({ x: x - delta, y, width: target, height: h }, false);
  } catch {}
});

let dragState = null;
ipcMain.on('drag-start', () => {
  const pt = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragState = { dx: pt.x - wx, dy: pt.y - wy };
});
ipcMain.on('drag-move', () => {
  if (!dragState) return;
  const pt = screen.getCursorScreenPoint();
  win.setPosition(Math.round(pt.x - dragState.dx), Math.round(pt.y - dragState.dy));
});
ipcMain.on('drag-end', () => { dragState = null; });

ipcMain.handle('system-stats', () => {
  const cpus = os.cpus();
  const load = os.loadavg()[0] / cpus.length; // 1 分钟负载 / 核数
  return {
    cpu: Math.min(100, Math.round(load * 100)),
    mem: memUsage(),
    uptime: os.uptime(),
  };
});

// ============ 状态中心：完整系统指标 ============

let lastNet = null;
function netRate() {
  try {
    const out = execSync('/usr/sbin/netstat -ibn 2>/dev/null', { timeout: 3000 }).toString();
    let rx = 0, tx = 0;
    for (const line of out.split('\n')) {
      const c = line.trim().split(/\s+/);
      // en0 链路层行（Address 含冒号），避免 IP 行重复计数
      if (c[0] === 'en0' && c.length >= 10 && (c[3] || '').includes(':')) {
        rx += Number(c[6]) || 0;
        tx += Number(c[9]) || 0;
      }
    }
    const now = Date.now();
    let rates = { down: 0, up: 0 };
    if (lastNet) {
      const dt = Math.max(0.5, (now - lastNet.t) / 1000);
      rates = {
        down: Math.max(0, Math.round((rx - lastNet.rx) / dt)),
        up: Math.max(0, Math.round((tx - lastNet.tx) / dt)),
      };
    }
    lastNet = { rx, tx, t: now };
    return rates;
  } catch {
    return { down: 0, up: 0 };
  }
}

function diskInfo() {
  try {
    const out = execSync('/bin/df -k /', { timeout: 3000 }).toString().split('\n')[1].split(/\s+/);
    const total = Number(out[1]) * 1024;
    const avail = Number(out[3]) * 1024;
    return { total, avail, usedPct: Math.round(((total - avail) / total) * 100) };
  } catch {
    return { total: 0, avail: 0, usedPct: 0 };
  }
}

function batteryInfo() {
  try {
    const out = execSync('/usr/bin/pmset -g batt', { timeout: 3000 }).toString();
    const m = out.match(/(\d+)%/);
    if (!m) return null;
    return {
      pct: Number(m[1]),
      charging: /charging|charged/i.test(out) && !/discharging/i.test(out),
    };
  } catch {
    return null; // 台式机无电池
  }
}

// v1.2 S4：Top10 进程，带 pid 供排序与结束进程使用
function topProcesses() {
  try {
    const out = execSync('/bin/ps -Ao pcpu,pmem,pid,comm -r 2>/dev/null | head -11', { timeout: 3000 }).toString();
    return out.split('\n').slice(1).map((l) => {
      const c = l.trim().split(/\s+/);
      return c.length >= 4
        ? { cpu: Number(c[0]), mem: Number(c[1]), pid: Number(c[2]), name: c.slice(3).join(' ').split('/').pop() }
        : null;
    }).filter((p) => p && p.pid);
  } catch {
    return [];
  }
}

// v1.2 S4：结束进程（仅 SIGTERM + 系统进程黑名单 + PID 下限）
const PROC_BLACKLIST = new Set([
  'windowserver', 'loginwindow', 'kernel_task', 'launchd', 'cfprefsd',
  'finder', 'dock', 'systemuiserver', 'spotlight', 'mds', 'distnoted',
  'opendirectoryd', 'syslogd', 'configd', 'powerd', 'mio', 'electron',
]);
ipcMain.handle('kill-process', (_e, payload) => {
  const pid = Number(payload && payload.pid);
  const name = String((payload && payload.name) || '').toLowerCase();
  if (!Number.isInteger(pid) || pid < 200) {
    return { ok: false, error: '系统关键进程受保护，无法结束' };
  }
  if (PROC_BLACKLIST.has(name)) {
    return { ok: false, error: `${name} 是系统进程，已加入黑名单` };
  }
  try {
    process.kill(pid, 'SIGTERM'); // 只发 SIGTERM，永不 kill -9
    logMessage('Mio · 进程管理', `已结束进程 ${name}（PID ${pid}）`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// macOS 的 os.freemem() 把缓存也算作占用，常年显示 99%，
// 改用 vm_stat 的 active + wired + compressor 口径，贴近活动监视器
function memUsage() {
  try {
    const out = execSync('/usr/bin/vm_stat', { timeout: 3000 }).toString();
    const psMatch = out.match(/page size of (\d+)/);
    const ps = psMatch ? Number(psMatch[1]) : 16384;
    const pages = (key) => {
      const m = out.match(new RegExp(key + ':\\s+(\\d+)'));
      return m ? Number(m[1]) : 0;
    };
    const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * ps;
    return Math.min(100, Math.round((used / os.totalmem()) * 100));
  } catch {
    const total = os.totalmem();
    return Math.round(((total - os.freemem()) / total) * 100);
  }
}

// v1.2 S1：内存压力等级（memory_pressure 快照，3s 超时保护）
function memPressure() {
  try {
    const out = execSync('/usr/bin/memory_pressure 2>/dev/null', { timeout: 3000 }).toString();
    const m = out.match(/free percentage:\s+(\d+)%/);
    const freePct = m ? Number(m[1]) : 50;
    // 压力等级：空闲越少压力越大
    const level = freePct >= 50 ? 'normal' : freePct >= 25 ? 'warn' : 'crit';
    return { freePct, level };
  } catch {
    return { freePct: 50, level: 'normal' };
  }
}

// v1.2 S1：内存细分（App 内存 / Wired / 压缩 / 可用）+ 压力等级
function memDetail() {
  const total = os.totalmem();
  const fallback = { pct: memUsage(), app: 0, wired: 0, compressed: 0, avail: 0, total, pressure: memPressure() };
  try {
    const out = execSync('/usr/bin/vm_stat', { timeout: 3000 }).toString();
    const psMatch = out.match(/page size of (\d+)/);
    const ps = psMatch ? Number(psMatch[1]) : 16384;
    const pages = (key) => {
      const m = out.match(new RegExp(key + ':\\s+(\\d+)'));
      return m ? Number(m[1]) : 0;
    };
    const app = pages('Anonymous pages') * ps;          // App 内存（匿名页）
    const wired = pages('Pages wired down') * ps;       // Wired（内核锁定）
    const compressed = pages('Pages occupied by compressor') * ps; // 压缩内存
    const avail = (pages('Pages free') + pages('Pages inactive')) * ps; // 可用
    const used = app + wired + compressed;
    return {
      pct: Math.min(100, Math.round((used / total) * 100)),
      app, wired, compressed, avail, total,
      pressure: memPressure(),
    };
  } catch {
    return fallback;
  }
}

// v1.2 S2：开机时长 + 上次重启（boot）时间
function bootInfo() {
  try {
    const out = execSync('/usr/sbin/sysctl kern.boottime', { timeout: 3000 }).toString();
    const m = out.match(/sec = (\d+)/);
    const bootTs = Number(m[1]) * 1000;
    const up = Date.now() - bootTs;
    const d = Math.floor(up / 86400000);
    const h = Math.floor((up % 86400000) / 3600000);
    const min = Math.floor((up % 3600000) / 60000);
    const uptimeText = d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${min} 分` : `${min} 分钟`;
    const bd = new Date(bootTs);
    const bootText = `${bd.getMonth() + 1}月${bd.getDate()}日 ${String(bd.getHours()).padStart(2, '0')}:${String(bd.getMinutes()).padStart(2, '0')}`;
    return { bootTs, uptimeText, bootText };
  } catch {
    // 兜底：os.uptime() 只有秒数，反推开机时间
    const bootTs = Date.now() - os.uptime() * 1000;
    const h = Math.floor(os.uptime() / 3600);
    const min = Math.floor((os.uptime() % 3600) / 60);
    return { bootTs, uptimeText: h > 0 ? `${h} 小时 ${min} 分` : `${min} 分钟`, bootText: '' };
  }
}

// v1.2 S3：网络详情（本机 IP / WiFi SSID / 当前连接数）
function netDetail() {
  let ip = '', ssid = '', conns = 0;
  try {
    const out = execSync('/sbin/ifconfig en0 2>/dev/null', { timeout: 3000 }).toString();
    const m = out.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    ip = m ? m[1] : '';
  } catch {}
  try {
    const out = execSync('/usr/sbin/networksetup -getairportnetwork en0 2>/dev/null', { timeout: 3000 }).toString();
    const m = out.match(/Current Wi-Fi Network:\s*(.+)/);
    ssid = m ? m[1].trim() : '';
  } catch {}
  try {
    const out = execSync('/usr/sbin/netstat -an 2>/dev/null | /usr/bin/wc -l', { timeout: 3000 }).toString();
    conns = parseInt(out.trim(), 10) || 0;
  } catch {}
  return { ip, ssid, conns };
}

// ============ v1.4 D：电池健康（system_profiler，30 分钟缓存）============
// 口径说明：AS 芯片上 ioreg 顶层 MaxCapacity 返回的是百分比、与系统显示对不上，
// 这里改用 system_profiler 的官方口径（实测 0.12s，与「系统设置 → 电池」一致）
let batteryHealthCache = { t: 0, data: null };

function batteryHealth() {
  if (batteryHealthCache.data && Date.now() - batteryHealthCache.t < 30 * 60 * 1000) {
    return batteryHealthCache.data;
  }
  let data = null;
  try {
    const out = execSync('/usr/sbin/system_profiler SPPowerDataType 2>/dev/null', { timeout: 8000 }).toString();
    const grab = (re) => { const m = out.match(re); return m ? m[1].trim() : null; };
    const maxCap = grab(/Maximum Capacity:\s*(\d+)%/);
    const cycles = grab(/Cycle Count:\s*(\d+)/);
    const cond = grab(/Condition:\s*(\S+)/);
    const watt = grab(/Wattage \(W\):\s*(\d+)/);
    const charging = /Charging:\s*Yes/.test(out);
    if (maxCap !== null && cycles !== null) {
      const pct = parseInt(maxCap, 10);
      data = {
        pct,
        cycles: parseInt(cycles, 10),
        condition: cond || '未知',
        adapterWatt: watt ? parseInt(watt, 10) : null,
        charging,
        level: pct >= 80 ? 'good' : pct >= 60 ? 'warn' : 'bad',
      };
    }
  } catch {}
  batteryHealthCache = { t: Date.now(), data }; // 无电池机器缓存 null，避免反复调用
  return data;
}

ipcMain.handle('system-full', () => {
  const cpus = os.cpus();
  const load = os.loadavg()[0] / cpus.length;
  const md = memDetail();
  return {
    cpu: Math.min(100, Math.round(load * 100)),
    mem: md.pct,
    memDetail: md,      // v1.2 S1
    boot: bootInfo(),   // v1.2 S2
    netDetail: netDetail(), // v1.2 S3
    disk: diskInfo(),
    net: netRate(),
    battery: batteryInfo(),
    batteryHealth: batteryHealth(), // v1.4 D：无电池时为 null，渲染层整行隐藏
    top: topProcesses(), // v1.2 S4：Top10 + pid
  };
});

// ============ v1.2 S5：24h 采样器（30s/点，JSON 持久化，~1MB 滚动裁剪）============
let pressureHighStreak = 0; // 连续高压力采样点数（供 C4/A1 规则：持续 5 分钟高 = 10 点）

function readHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function sampleOnce() {
  try {
    const cpus = os.cpus();
    const cpu = Math.min(100, Math.round((os.loadavg()[0] / cpus.length) * 100));
    const mem = memUsage();
    const disk = diskInfo().usedPct;
    const pressure = memPressure().level;
    // 内存压力持续跟踪（warn/crit 计为高压）
    if (pressure === 'warn' || pressure === 'crit') pressureHighStreak++;
    else pressureHighStreak = 0;

    let arr = readHistory();
    arr.push({ t: Date.now(), cpu, mem, disk, pressure });
    // 只保留最近 24h
    const cutoff = Date.now() - 24 * 3600 * 1000;
    arr = arr.filter((p) => p.t >= cutoff);
    // ~1MB 上限滚动裁剪（每点约 60B，24h/30s = 2880 点约 170KB，双保险）
    let json = JSON.stringify(arr);
    while (json.length > 950000 && arr.length > 100) {
      arr.splice(0, 100);
      json = JSON.stringify(arr);
    }
    fs.writeFileSync(historyFile, json);
  } catch {}
}

ipcMain.handle('history-get', () => {
  const points = readHistory();
  // 今日峰值（本地零点起）
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const today = points.filter((p) => p.t >= dayStart.getTime());
  const fmtTime = (t) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  let peak = { cpu: null, cpuAt: '', mem: null, memAt: '' };
  for (const p of today) {
    if (peak.cpu === null || p.cpu > peak.cpu) { peak.cpu = p.cpu; peak.cpuAt = fmtTime(p.t); }
    if (peak.mem === null || p.mem > peak.mem) { peak.mem = p.mem; peak.memAt = fmtTime(p.t); }
  }
  return { points, peak };
});

// ============ v1.2 S6：消息中心（全部通知/提醒事件持久化）============
function readMessages() {
  try {
    const arr = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function logMessage(title, body) {
  try {
    const arr = readMessages();
    arr.unshift({ t: Date.now(), title, body });
    if (arr.length > 200) arr.length = 200; // 最多保留 200 条
    fs.writeFileSync(messagesFile, JSON.stringify(arr));
  } catch {}
}

ipcMain.handle('messages-get', () => readMessages());
ipcMain.handle('messages-clear', () => {
  try { fs.writeFileSync(messagesFile, '[]'); } catch {}
  return true;
});
// 渲染层自身产生的事件（建议出现、清理完成等）也汇入消息中心
ipcMain.on('message-log', (_e, { title, body }) => logMessage(title, body));

// ============ 系统清理：只读扫描 + 确认后移入废纸篓 ============
const HOME = os.homedir();
const SCAN_TARGETS = [
  { id: 'user-caches', name: '用户缓存', dir: path.join(HOME, 'Library/Caches'), level: 'green', note: '应用缓存，删除后自动重建' },
  { id: 'user-logs', name: '用户日志', dir: path.join(HOME, 'Library/Logs'), level: 'green', note: '历史日志文件' },
  { id: 'npm-cache', name: 'npm 缓存', dir: path.join(HOME, '.npm/_cacache'), level: 'green', note: '包下载缓存' },
  { id: 'pip-cache', name: 'pip 缓存', dir: path.join(HOME, 'Library/Caches/pip'), level: 'green', note: '包下载缓存' },
  { id: 'xcode-derived', name: 'Xcode DerivedData', dir: path.join(HOME, 'Library/Developer/Xcode/DerivedData'), level: 'green', note: '构建产物，可安全删除' },
  { id: 'trash', name: '废纸篓', dir: path.join(HOME, '.Trash'), level: 'yellow', note: '清空后不可恢复' },
];

async function dirSize(dir, budgetMs = 8000) {
  const start = Date.now();
  let total = 0;
  let count = 0;
  async function walk(d) {
    if (Date.now() - start > budgetMs) return;
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (Date.now() - start > budgetMs) return;
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) {
          await walk(p);
        } else if (e.isFile()) {
          const st = await fs.promises.stat(p);
          total += st.size;
          count++;
        }
      } catch {}
    }
  }
  await walk(dir);
  return { size: total, files: count };
}

ipcMain.handle('clean-scan', async () => {
  const results = [];
  for (const t of SCAN_TARGETS) {
    if (!fs.existsSync(t.dir)) {
      results.push({ ...t, size: 0, files: 0 });
      continue;
    }
    const { size, files } = await dirSize(t.dir);
    results.push({ ...t, size, files });
  }
  return results;
});

// ============ v1.2 C5：清理历史 & 累计释放统计 ============
function readCleanHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(cleanHistoryFile, 'utf8'));
    return { records: Array.isArray(data.records) ? data.records : [], totalFreed: Number(data.totalFreed) || 0 };
  } catch {
    return { records: [], totalFreed: 0 };
  }
}

// 清理执行成功后追加记录（items: [{name, size, path?}]）
function recordClean(items) {
  try {
    const data = readCleanHistory();
    const total = items.reduce((a, i) => a + (i.size || 0), 0);
    data.records.unshift({ t: Date.now(), items, total });
    if (data.records.length > 100) data.records.length = 100;
    data.totalFreed += total;
    fs.writeFileSync(cleanHistoryFile, JSON.stringify(data));
  } catch {}
}

ipcMain.handle('clean-history-get', () => {
  const data = readCleanHistory();
  const cutoff30 = Date.now() - 30 * 86400000;
  const freed30d = data.records.filter((r) => r.t >= cutoff30).reduce((a, r) => a + (r.total || 0), 0);
  return { records: data.records, totalFreed: data.totalFreed, freed30d };
});

// 清理 = 把目标目录下的"子项"逐个移入废纸篓（目录本身保留）
// sizes：渲染层扫描时已知的大小映射（id -> bytes），用于 C5 记录释放量
ipcMain.handle('clean-execute', async (_e, ids, sizes = {}) => {
  const report = [];
  for (const id of ids) {
    const t = SCAN_TARGETS.find((x) => x.id === id);
    if (!t || !fs.existsSync(t.dir)) continue;
    let moved = 0, failed = 0;
    let children = [];
    try {
      children = await fs.promises.readdir(t.dir);
    } catch {}
    for (const name of children) {
      try {
        await shell.trashItem(path.join(t.dir, name));
        moved++;
      } catch {
        failed++;
      }
    }
    report.push({ id, name: t.name, moved, failed });
  }
  const histItems = report.filter((r) => r.moved > 0).map((r) => ({ name: r.name, size: Number(sizes[r.id]) || 0 }));
  if (histItems.length) {
    recordClean(histItems);
    adviceCache.t = 0; // 清理后让建议引擎下次重算
    logMessage('Mio · 清理完成', `已移入废纸篓 ${report.reduce((a, r) => a + r.moved, 0)} 项`);
  }
  return report;
});

// ============ 清理安全：路径黑名单（展示与执行共用）============
function isBlacklistedPath(p) {
  if (typeof p !== 'string' || !p) return true;
  const norm = path.normalize(p);
  // 系统级目录永不展示/清理
  if (norm.startsWith('/System') || norm.startsWith('/usr') || norm === '/Library' || norm.startsWith('/Library/')) return true;
  // 仅限用户目录
  if (!norm.startsWith(HOME + path.sep)) return true;
  const rel = norm.slice(HOME.length);
  const badPrefixes = [
    '/Library/Containers', '/Library/Group Containers', // 沙盒数据
    '/Library/Keychains', '/Library/Mail',              // 钥匙串 / 邮件
  ];
  if (badPrefixes.some((b) => rel === b || rel.startsWith(b + path.sep))) return true;
  if (rel.includes('Photos Library')) return true;      // 照片图库
  return false;
}

// v1.2 C1/C2/C3/C4 统一执行入口：把用户勾选的具体路径移入废纸篓
// entries: [{path, name?, size?}] 或 [path]
ipcMain.handle('clean-paths', async (_e, entries) => {
  const report = [];
  const histItems = [];
  for (const e of entries) {
    const p = typeof e === 'string' ? e : e.path;
    const name = typeof e === 'string' ? path.basename(e) : (e.name || path.basename(e));
    if (isBlacklistedPath(p)) {
      report.push({ path: p, ok: false, error: '路径不在安全范围，已拒绝' });
      continue;
    }
    let size = typeof e === 'object' && e && Number(e.size) || 0;
    if (!size) {
      try {
        const st = await fs.promises.stat(p);
        size = st.isDirectory() ? 0 : st.size; // 目录大小靠渲染层传入，避免递归统计拖慢执行
      } catch {}
    }
    try {
      await shell.trashItem(p); // 只走废纸篓，永不 rm
      report.push({ path: p, ok: true });
      histItems.push({ name, size, path: p });
    } catch (err) {
      report.push({ path: p, ok: false, error: String(err && err.message || err) });
    }
  }
  if (histItems.length) {
    recordClean(histItems);
    adviceCache.t = 0;
    logMessage('Mio · 清理完成', `已移入废纸篓 ${histItems.length} 项：${histItems.map((i) => i.name).slice(0, 3).join('、')}${histItems.length > 3 ? ' 等' : ''}`);
  }
  return report;
});

// ============ v1.2 C1：大文件猎人（mdfind >500MB，限用户目录，Top20）============
ipcMain.handle('bigfiles-scan', async () => {
  const out = await execP(`/usr/bin/mdfind -onlyin "${HOME}" 'kMDItemFSSize > 524288000' 2>/dev/null`, { timeout: 20000 });
  const paths = out.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 80);
  const items = [];
  for (const p of paths) {
    if (isBlacklistedPath(p)) continue;
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile()) continue;
      if (Date.now() - st.mtimeMs < 24 * 3600 * 1000) continue; // 24h 内新文件不展示
      items.push({ path: p, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  items.sort((a, b) => b.size - a.size);
  const top = items.slice(0, 20);
  const result = [];
  for (const it of top) {
    // 最后打开时间 + iCloud 占位检查（未下载的跳过）
    const meta = await execP(`/usr/bin/mdls -name kMDItemLastUsedDate -name kMDItemIsDownloaded "${it.path.replace(/"/g, '\\"')}" 2>/dev/null`, { timeout: 5000 });
    if (/kMDItemIsDownloaded\s*=\s*0/.test(meta)) continue;
    const m = meta.match(/kMDItemLastUsedDate\s*=\s*([0-9-]+ [0-9:]+)/);
    result.push({
      name: path.basename(it.path),
      path: it.path,
      size: it.size,
      lastUsed: m ? m[1].slice(0, 10) : '', // 只留日期
      level: 'yellow', // 大文件一律黄队：二次确认
    });
  }
  return result;
});

// ============ v1.2 C2：按 App 缓存排行（~/Library/Caches 一级子目录，Top10）============
ipcMain.handle('cache-ranking', async () => {
  const out = await execP(`/usr/bin/du -sk "${HOME}/Library/Caches/"*/ 2>/dev/null`, { timeout: 30000 });
  const running = new Set();
  try {
    execSync('/bin/ps -Aco comm= 2>/dev/null', { timeout: 3000 }).toString()
      .split('\n').forEach((n) => running.add(n.trim().toLowerCase()));
  } catch {}
  const rows = out.split('\n').map((l) => {
    const m = l.trim().match(/^(\d+)\s+(.+)$/);
    return m ? { kb: Number(m[1]), dir: m[2] } : null;
  }).filter(Boolean);
  rows.sort((a, b) => b.kb - a.kb);
  return rows.slice(0, 10).map((r) => {
    const name = path.basename(r.dir);
    const lower = name.toLowerCase();
    // 运行中标注：目录名包含某个运行中的进程名（启发式，仅提示用途）
    const isRunning = [...running].some((proc) => proc.length >= 4 && lower.includes(proc));
    return {
      name,
      path: r.dir,
      size: r.kb * 1024,
      running: isRunning,
      level: 'green', // 用户缓存绿队
    };
  });
});

// ============ v1.2 C3：应用残留（已删 App 的支持文件孤儿目录）============
ipcMain.handle('leftovers-scan', async () => {
  // 1) 已安装 App 列表 → 名称 token 集合
  const tokens = new Set();
  const appDirs = ['/Applications', path.join(HOME, 'Applications')];
  for (const ad of appDirs) {
    let files = [];
    try { files = await fs.promises.readdir(ad); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.app')) continue;
      const base = f.slice(0, -4).toLowerCase();
      tokens.add(base.replace(/[\s.\-_]/g, ''));
      base.split(/[\s.\-_]+/).forEach((w) => { if (w.length >= 3) tokens.add(w); });
    }
  }
  const tokenList = [...tokens];
  const isInstalled = (dirName) => {
    const lower = dirName.toLowerCase();
    const squashed = lower.replace(/[\s.\-_]/g, '');
    if (tokens.has(squashed)) return true;
    // bundle id 末段匹配（如 com.google.Chrome → chrome 命中 Google Chrome）
    const segs = lower.split('.');
    const lastSeg = segs[segs.length - 1];
    if (lastSeg.length >= 3 && tokens.has(lastSeg)) return true;
    // 包含任一 app token（如 "Google Chrome Helper" 目录）
    return tokenList.some((t) => t.length >= 4 && squashed.includes(t));
  };
  // 系统目录跳过（这些即使匹配不到 app 也绝不算残留）
  const SKIP_RE = /^(\.|com\.apple|apple|adobe|group\.)/i;
  const SKIP_WORDS = /(keychain|mail|photos|icloud|cloudkit|containers)/i;

  // 2) 扫描常见支持目录（明确排除 Containers / Group Containers）
  const LIBS = ['Application Support', 'Preferences', 'Caches', 'Saved Application State', 'Logs', 'LaunchAgents'];
  const orphans = [];
  for (const lib of LIBS) {
    const base = path.join(HOME, 'Library', lib);
    let entries = [];
    try { entries = await fs.promises.readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const name = e.name;
      if (SKIP_RE.test(name) || SKIP_WORDS.test(name)) continue;
      if (isInstalled(name)) continue;
      orphans.push({ name, path: path.join(base, name), from: lib });
      if (orphans.length >= 40) break;
    }
    if (orphans.length >= 40) break;
  }
  // 3) 批量 du 计算大小
  if (orphans.length) {
    const duOut = await execP(`/usr/bin/du -sk ${orphans.map((o) => `"${o.path.replace(/"/g, '\\"')}"`).join(' ')} 2>/dev/null`, { timeout: 30000 });
    const sizeMap = {};
    duOut.split('\n').forEach((l) => {
      const m = l.trim().match(/^(\d+)\s+(.+)$/);
      if (m) sizeMap[m[2]] = Number(m[1]) * 1024;
    });
    orphans.forEach((o) => { o.size = sizeMap[o.path] || 0; });
  }
  orphans.sort((a, b) => b.size - a.size);
  return orphans.map((o) => ({
    name: o.name,
    path: o.path,
    size: o.size,
    note: `${o.from} · 未找到对应 App`,
    // 目录名形如显示名（无点号）→ 绿队；bundle id 风格 → 黄队（更需谨慎）
    level: o.name.includes('.') ? 'yellow' : 'green',
  }));
});

// ============ v1.2 C4 + A1：智能建议引擎（规则集，可扩展）============
let adviceCache = { t: 0, data: [] };
let nmScanCache = { t: 0, dirs: [] }; // node_modules 扫描较重，缓存 30 分钟

// 规则数据源：找到 >30 天未访问且 >500MB 的 node_modules
async function scanStaleNodeModules() {
  if (Date.now() - nmScanCache.t < 30 * 60000) return nmScanCache.dirs;
  const roots = ['dev', 'Developer', 'code', 'Documents', 'Projects', 'Desktop']
    .map((d) => path.join(HOME, d))
    .filter((d) => fs.existsSync(d));
  const found = [];
  if (roots.length) {
    const cmd = `/usr/bin/find ${roots.map((r) => `"${r}"`).join(' ')} -maxdepth 4 -name node_modules -type d -prune 2>/dev/null`;
    const out = await execP(cmd, { timeout: 20000 });
    const dirs = out.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 15);
    let sizeMap = {};
    if (dirs.length) {
      const duOut = await execP(`/usr/bin/du -sk ${dirs.map((d) => `"${d}"`).join(' ')} 2>/dev/null`, { timeout: 30000 });
      duOut.split('\n').forEach((l) => {
        const m = l.trim().match(/^(\d+)\s+(.+)$/);
        if (m) sizeMap[m[2]] = Number(m[1]) * 1024;
      });
    }
    for (const d of dirs) {
      try {
        const st = await fs.promises.stat(d);
        found.push({ path: d, size: sizeMap[d] || 0, atime: st.atimeMs });
      } catch {}
    }
  }
  nmScanCache = { t: Date.now(), dirs: found };
  return found;
}

async function computeAdvice() {
  const list = [];
  // 规则 1：磁盘可用 < 20GB
  const disk = diskInfo();
  if (disk.avail > 0 && disk.avail < 20e9) {
    list.push({
      id: 'disk-low', icon: '⚠️',
      title: `磁盘仅剩 ${(disk.avail / 1e9).toFixed(1)}GB`,
      detail: '可用空间不足 20GB，要我帮你找找大文件吗？',
      action: 'bigfiles',
    });
  }
  // 规则 2：node_modules 30 天未动且 >500MB
  const nm = await scanStaleNodeModules();
  const stale = nm.filter((d) => d.size > 500e6 && Date.now() - d.atime > 30 * 86400000);
  if (stale.length) {
    const total = stale.reduce((a, d) => a + d.size, 0);
    const oldest = Math.max(...stale.map((d) => Math.floor((Date.now() - d.atime) / 86400000)));
    list.push({
      id: 'stale-node-modules', icon: '📦',
      title: `node_modules × ${stale.length}，共 ${(total / 1e9).toFixed(1)}GB`,
      detail: `最久 ${oldest} 天未访问，可以安全清理（需要时 npm install 重建）`,
      action: 'clean-paths',
      paths: stale.map((d) => ({ path: d.path, name: d.path.split('/').slice(-2).join('/'), size: d.size })),
    });
  }
  // 规则 3：7 天未清理
  const hist = readCleanHistory();
  const lastClean = hist.records.length ? hist.records[0].t : 0;
  if (Date.now() - lastClean > 7 * 86400000) {
    list.push({
      id: 'no-clean-7d', icon: '🧹',
      title: '已经 7 天没清理了',
      detail: '扫一下缓存和日志，让 Mac 保持清爽',
      action: 'open-clean',
    });
  }
  // 规则 4：内存压力持续 5 分钟偏高（30s × 10 个采样点）
  if (pressureHighStreak >= 10) {
    list.push({
      id: 'mem-pressure', icon: '🧠',
      title: '内存压力持续偏高',
      detail: '已持续 5 分钟以上，看看占用最高的进程',
      action: 'open-status',
    });
  }
  return list;
}

ipcMain.handle('advice-get', async () => {
  if (Date.now() - adviceCache.t < 10 * 60000) return adviceCache.data;
  const data = await computeAdvice();
  adviceCache = { t: Date.now(), data };
  return data;
});

ipcMain.on('notify', (_e, { title, body }) => {
  logMessage(title, body); // v1.2 S6：所有通知进消息中心
  new Notification({ title, body, silent: false }).show();
});

ipcMain.on('quit', () => app.quit());

// ============ v1.4 E：前台应用智能隐身 ============
// 真正的「检测全屏」要读 AXFullScreen，需要辅助功能权限 —— 本批次不引入权限，
// 改用「前台应用 bundleid 名单」近似，并配 ⌥H 手动兜底。UI 文案也如实叫「看视频/演示时自动隐身」。
const STEALTH_APPS = [
  'com.colliderli.iina',           // IINA
  'org.videolan.vlc',              // VLC
  'com.apple.QuickTimePlayerX',    // QuickTime Player
  'com.apple.TV',                  // 系统「视频」
  'com.apple.iWork.Keynote',       // Keynote
  'com.microsoft.Powerpoint',      // PowerPoint
  'com.kingsoft.wpsoffice.mac',    // WPS
  'com.tencent.meeting',           // 腾讯会议
  'com.tencent.tencentmeeting',    // 腾讯会议（备用 id）
  'us.zoom.xos',                   // Zoom
  'com.electron.lark',             // 飞书
  'com.alibaba.dingtalk.mac',      // 钉钉
];

let stealthTimer = null;
let stealthActive = false;

function frontBundleId() {
  try {
    const asn = execSync('/usr/bin/lsappinfo front 2>/dev/null', { timeout: 1500 }).toString().trim();
    if (!asn) return null;
    const out = execSync(`/usr/bin/lsappinfo info -only bundleid ${asn} 2>/dev/null`, { timeout: 1500 }).toString();
    const m = out.match(/"CFBundleIdentifier"="([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

// 淡出而非隐藏：保留一丝存在感，鼠标移过去还能交互唤回
function applyStealth(on) {
  if (!win || win.isDestroyed() || on === stealthActive) return;
  stealthActive = on;
  try { win.setOpacity(on ? 0.12 : (loadState().opacity ?? 1)); } catch {}
}

function stealthTick() {
  if (!getSettings().stealth.enabled) { applyStealth(false); return; }
  const id = frontBundleId();
  applyStealth(!!id && STEALTH_APPS.includes(id));
}

const readLoginItem = () => { try { return app.getLoginItemSettings().openAtLogin; } catch { return false; } };

ipcMain.handle('settings-get', () => ({
  ...getSettings(),
  isPackaged: app.isPackaged,
  loginItem: readLoginItem(),
  stealthApps: STEALTH_APPS,
  stealthActive,
}));

ipcMain.handle('settings-set', (_e, patch) => {
  const next = { ...getSettings(), ...(patch || {}) };
  saveState({ settings: next });
  if (next.stealth && next.stealth.enabled === false) applyStealth(false);
  return { ...next, loginItem: readLoginItem() };
});

// v1.4 A：开机自启。以系统登录项为唯一真相，不额外落盘，避免两边不一致
ipcMain.handle('login-set', (_e, enabled) => {
  if (!app.isPackaged) return { ok: false, error: '开发模式不支持，打包后可用' };
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: false });
    return { ok: true, openAtLogin: readLoginItem() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register('Alt+Space', toggleWindow);
  globalShortcut.register('Alt+H', toggleWindow); // v1.4 E：手动隐藏兜底
  // v1.4 E：前台应用探测（实测 8.5ms/次，2s 一次成本可忽略）
  stealthTimer = setInterval(stealthTick, 2000);

  // v1.2 S5：启动 24h 采样器（面板收起也维持 30s 不变）
  sampleOnce();
  samplerTimer = setInterval(sampleOnce, 30000);

  // 自动化自检模式：MIO_AUTOTEST=1 时走查核心交互并截图留证
  if (process.env.MIO_AUTOTEST === '1') {
    const shotsDir = path.join(__dirname, 'docs', 'shots');
    const logFile = path.join(shotsDir, 'autotest.log');
    fs.mkdirSync(shotsDir, { recursive: true });
    fs.writeFileSync(logFile, '');
    const log = (s) => { fs.appendFileSync(logFile, s + '\n'); console.log(s); };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const shot = async (name) => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(shotsDir, name), img.toPNG());
    };
    const js = (code) => win.webContents.executeJavaScript(code);

    win.webContents.on('did-finish-load', async () => {
      try {
        await sleep(1500);
        const init = await js(`['panelOpen','POMO_WORK','dragging'].map(k => { try { return k + '=' + eval('typeof ' + k) } catch(e) { return k + '=TDZ' } }).join(', ')`);
        log('INIT: ' + init);
        await shot('electron-idle.png');

        await js(`document.getElementById('mio').click()`);
        await sleep(700);
        log('AFTER_CLICK: ' + await js(`JSON.stringify({panel: !document.getElementById('panel').hidden, cls: document.getElementById('mio').className})`));
        await shot('electron-panel.png');

        await js(`document.getElementById('pomodoroCard').click()`);
        await sleep(2500);
        log('POMODORO: ' + await js(`JSON.stringify({time: document.getElementById('pomoTime').textContent, state: document.getElementById('pomoState').textContent, working: document.getElementById('mio').className.includes('working')})`));
        await shot('electron-pomo.png');

        log('STATS: ' + await js(`window.mio.getStats().then(s => 'cpu=' + s.cpu + '% mem=' + s.mem + '%')`));

        // v1.1：状态中心 + 清理扫描
        log('FULLSTATS: ' + await js(`window.mio.getFullStats().then(s => JSON.stringify({cpu: s.cpu, mem: s.mem, diskPct: s.disk.usedPct, net: s.net, batt: s.battery, topN: s.top.length}))`));
        log('CLEANSCAN: ' + await js(`window.mio.cleanScan().then(rs => rs.map(r => r.id + ':' + Math.round(r.size / 1e6) + 'MB:' + r.level).join(' | '))`));

        // v1.2 关键断言：S1-S5 新字段
        log('V12_STATS: ' + await js(`window.mio.getFullStats().then(s => JSON.stringify({
          memKeys: s.memDetail ? Object.keys(s.memDetail) : null,
          pressure: s.memDetail && s.memDetail.pressure && s.memDetail.pressure.level,
          boot: s.boot && s.boot.uptimeText,
          ip: s.netDetail && s.netDetail.ip, ssid: s.netDetail && s.netDetail.ssid, conns: s.netDetail && s.netDetail.conns,
          topN: s.top.length, pid0: s.top[0] && typeof s.top[0].pid,
        }))`));
        log('V12_HISTORY: ' + await js(`window.mio.getHistory().then(h => 'points=' + h.points.length + ' peakCpu=' + (h.peak.cpu === null ? '-' : h.peak.cpu + '@' + h.peak.cpuAt))`));
        log('V12_MESSAGES: ' + await js(`window.mio.getMessages().then(ms => 'n=' + ms.length)`));
        // v1.2 关键断言：C1/C2/C4
        log('V12_BIGFILES: ' + await js(`window.mio.scanBigFiles().then(rs => 'n=' + rs.length + (rs[0] ? ' top=' + rs[0].name + ' ' + Math.round(rs[0].size/1e6) + 'MB' : ''))`));
        log('V12_CACHERANK: ' + await js(`window.mio.getCacheRanking().then(rs => 'n=' + rs.length + (rs[0] ? ' top=' + rs[0].name + ' ' + Math.round(rs[0].size/1e6) + 'MB running=' + rs[0].running : ''))`));
        log('V12_ADVICE: ' + await js(`window.mio.getAdvice().then(rs => 'n=' + rs.length + ' ids=[' + rs.map(a => a.id).join(',') + ']')`));
        log('V12_LEFTOVERS: ' + await js(`window.mio.scanLeftovers().then(rs => 'n=' + rs.length + (rs[0] ? ' top=' + rs[0].name : ''))`));
        log('V12_CLEANHISTORY: ' + await js(`window.mio.getCleanHistory().then(h => 'records=' + h.records.length + ' totalFreed=' + h.totalFreed + ' freed30d=' + h.freed30d)`));
        // v1.2 关键断言：S4 黑名单保护（kernel_task 必须被拒绝）
        log('V12_KILLGUARD: ' + await js(`window.mio.killProcess({pid: 1, name: 'launchd'}).then(r => 'blocked=' + (r.ok === false))`));

        // v1.3 交互走查：点卡片应钻入详情页（单面板显示 + 双档加宽），返回后复位
        await js(`document.querySelector('[data-tab="status"]').click()`);
        await sleep(800);
        await js(`document.getElementById('memCard').click()`);
        await sleep(600);
        log('V13_DETAIL: ' + await js(`JSON.stringify({
          wide: document.getElementById('panel').classList.contains('wide'),
          dvOpen: !document.getElementById('detailView').hidden,
          movedIn: document.getElementById('dvBody').children.length > 0,
          hasBack: !!document.getElementById('dvBack')
        })`));
        await shot('electron-v13-detail.png');
        await js(`document.getElementById('dvBack').click()`);
        await sleep(500);
        log('V13_DETAIL_BACK: ' + await js(`JSON.stringify({
          wide: document.getElementById('panel').classList.contains('wide'),
          dvHidden: document.getElementById('detailView').hidden
        })`));

        // 全选按钮走查
        await js(`document.querySelector('[data-tab="clean"]').click()`);
        await sleep(300);
        await js(`document.getElementById('scanBtn').click()`);
        await sleep(3500);
        const selAll = await js(`(() => {
          const all = document.getElementById('cleanAll');
          if (!all) return JSON.stringify({ hasSelectAll: false });
          const before = document.querySelectorAll('.clean-item.checked').length;
          all.click();
          const afterAll = document.querySelectorAll('.clean-item.checked').length;
          all.click();
          const afterNone = document.querySelectorAll('.clean-item.checked').length;
          return JSON.stringify({ hasSelectAll: true, before, afterAll, afterNone, countText: all.querySelector('.pa-count').textContent });
        })()`);
        log('V13_SELECTALL: ' + selAll);

        // ===== v1.4 断言 =====
        log('V14_SETTINGS: ' + await js(`window.mio.getSettings().then(s => JSON.stringify({
          chime: s.chime && s.chime.enabled, from: s.chime && s.chime.from, to: s.chime && s.chime.to,
          health: s.health && [s.health.sit, s.health.water, s.health.eye].join('/'),
          quiet: s.health && (s.health.quietFrom + '-' + s.health.quietTo),
          stealth: s.stealth && s.stealth.enabled,
          isPackaged: s.isPackaged, loginItem: s.loginItem,
          stealthApps: (s.stealthApps || []).length
        }))`));
        log('V14_BATT: ' + await js(`window.mio.getFullStats().then(s => JSON.stringify({
          has: !!s.batteryHealth,
          pct: s.batteryHealth && s.batteryHealth.pct,
          cycles: s.batteryHealth && s.batteryHealth.cycles,
          level: s.batteryHealth && s.batteryHealth.level,
          cond: s.batteryHealth && s.batteryHealth.condition,
          watt: s.batteryHealth && s.batteryHealth.adapterWatt
        }))`));

        // 设置面板：钻入 → 开关渲染 → 返回
        await js(`document.querySelector('[data-tab="home"]').click()`);
        await sleep(300);
        await js(`document.getElementById('settingsCard').click()`);
        await sleep(700);
        log('V14_SETUI: ' + await js(`JSON.stringify({
          dvOpen: !document.getElementById('detailView').hidden,
          title: document.getElementById('dvTitle').textContent,
          switches: document.querySelectorAll('#dvBody .switch input').length,
          chimeRange: document.getElementById('chimeRange').textContent,
          quietRange: document.getElementById('quietRange').textContent,
          loginDisabled: document.getElementById('swLogin').disabled,
          brief: document.getElementById('settingsBrief').textContent
        })`));
        await shot('electron-v14-settings.png');
        await js(`document.getElementById('dvBack').click()`);
        await sleep(500);
        log('V14_SETTINGS_BACK: ' + await js(`JSON.stringify({ dvHidden: document.getElementById('detailView').hidden })`));

        // 设置往返：切一次健康提醒总开关，确认能写回主进程
        log('V14_SET_ROUNDTRIP: ' + await js(`(async () => {
          const before = (await window.mio.getSettings()).health.enabled;
          const r = await window.mio.setSettings({ health: Object.assign({}, (await window.mio.getSettings()).health, { enabled: !before }) });
          const after = r.health.enabled;
          await window.mio.setSettings({ health: Object.assign({}, r.health, { enabled: before }) });
          return JSON.stringify({ before, after, restored: (await window.mio.getSettings()).health.enabled });
        })()`));

        // 电池健康卡渲染（切到状态页后刷新）
        await js(`document.querySelector('[data-tab="status"]').click()`);
        await sleep(1500);
        log('V14_BATTCARD: ' + await js(`JSON.stringify({
          hidden: document.getElementById('battHealthCard').hidden,
          brief: document.getElementById('battHealthBrief').textContent,
          cls: document.getElementById('bhPct').className,
          cond: document.getElementById('bhCond').textContent
        })`));
        await shot('electron-v14-status.png');

        log('AUTOTEST_DONE');
        setTimeout(() => app.quit(), 600); // 自检跑完自动退出，便于脚本化
      } catch (e) {
        log('AUTOTEST_FAIL: ' + e.message);
        setTimeout(() => app.quit(), 600);
      }
    });
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (cursorTimer) clearInterval(cursorTimer);
  if (samplerTimer) clearInterval(samplerTimer);
  if (stealthTimer) clearInterval(stealthTimer);
});

// 桌宠不需要 dock 图标与多窗口
app.dock?.hide();
app.on('window-all-closed', () => app.quit());
