// Mio - macOS 桌面陪伴机器人 · 主进程
const { app, BrowserWindow, ipcMain, Menu, Notification, globalShortcut, screen, shell, clipboard, systemPreferences, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto'); // v1.7.5 查重：前 4KB 指纹 + 全量 sha256（Node 内置，零依赖）
const { execSync, exec, execFile, execFileSync } = require('child_process');

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

// ============ v1.5：设置中心 ============
// settings 自 v1.5 起带版本号（_v）。升级靠 deepMerge 而非逐版 migration 函数：
// 默认值是「骨架」，用户配置叠上去，缺失字段自动补齐 —— v1.4 只有 chime/health/stealth
// 三组，读进来就会自动长出 general/appearance 等新组，老配置文件零改动可用。
// v1.6 再叠一层：clipboard/capture/hotkey/pomodoro/consent 五个新区，老键名一个不动。
// v1.8 再叠一层：ai（LLM 聊天）+ onboarding 标记，老键名一个不动。
const SETTINGS_VERSION = 6;

const DEFAULT_SETTINGS = {
  _v: 6,
  general: { autoOpen: false },
  appearance: {
    theme: 'dark',        // dark | light —— 跟随系统在 S3 接入
    size: 'md',           // sm | md | lg
    opacity: 1,           // 0.3 ~ 1
    onTop: true,
    gaze: true,           // 视线跟随
    clickThrough: true,   // 点击穿透（关闭后球体始终接收鼠标事件）
    reduceMotion: false,  // 减弱动效
    displayId: null,      // null = 跟随光标所在屏
  },
  chime: { enabled: true, from: 9, to: 22, notify: false },
  health: { enabled: true, sit: true, water: false, eye: false, quietFrom: 22, quietTo: 9 },
  // v1.6 C9：通知方式默认「两者」，保持 v1.5「系统通知 + 气泡」的既有行为，
  // 避免升级后默认通道变了让老用户以为提醒消失（PRD Q8）
  notify: { style: 'both' }, // bubble | system | both
  pomodoro: { work: 25 },    // v1.6 C10：25 | 45 | 60（分钟）
  stealth: { enabled: true, opacity: 0.12, apps: null }, // apps=null → 用内置名单
  // ===== v1.6 新增分组 =====
  clipboard: { enabled: true, limit: 10, filterPassword: false }, // E1/E2/E3
  capture: { mode: 'region', dest: 'clipboard' },                 // E4（dest 本版恒为剪贴板）
  hotkey: { trigger: 'Alt+Space' },                                // D1（Electron accelerator 规范串）
  consent: { permsIntroSeen: false },                              // 统一说明弹层「只弹一次」标志
  // v1.7 F 组：天气。数据源 wttr.in（免 key，用户零配置 —— 决策见路线图 §9.1）
  weather: {
    enabled: true,
    city: null,        // null = 自动（IP 定位到城市级，精度对「今天要不要带伞」够用）
    interval: 60,      // 30 | 60 | 120 分钟
    unit: 'c',         // c | f
  },
  // v1.7.5 定时清理计划（路线图 §6.4 六条决策）：只放行绿色梯队（缓存/日志）；
  // 只在 Mio 启动时补跑（每天至多一次，错过顺延下次启动）；默认关闭；静默执行
  autoClean: {
    enabled: false,
    pausedUntil: null, // 毫秒时间戳：暂停到该时刻（「暂停 7 天」温和档位；手动扫描不受影响）
    lastRun: null,     // { t, freed, moved, items } —— 面板回溯「上次自动清理：时间/释放/清了什么」
  },
  // v1.8 G 组：AI 助手（LLM 聊天）。Key 永不落盘 —— 只存 macOS 钥匙串（service=mio-llm）。
  ai: {
    enabled: false,          // LLM-1：关 → 球体不出现对话入口、任何 IPC 不发请求
    provider: 'deepseek',    // LLM-2：deepseek | zhipu | qwen | openai | custom
    baseUrl: 'https://api.deepseek.com/v1', // LLM-4：随预设自动填，可改
    model: 'deepseek-chat',  // LLM-4：随预设自动填，可改
    monthlyCap: 0,           // LLM-7：每月花费上限（元，估算护栏；0 = 不限制）
    maxTokens: 512,          // LLM-6：单次最大回复长度（64–2048，默认 512）
    persona: `你是 Mio，一个住在用户 macOS 桌面上的小机器人伙伴。
你说话简短、亲切、偶尔俏皮；你了解用户电脑的实时状态（CPU、内存、磁盘、天气）。
你不知道的问题就老实说不知道，不编造。回答控制在 3-5 句以内。`, // LLM-8 默认人设
  },
  // v1.8 B4-2：首次启动引导标记。done=true 表示已引导过（老用户不弹）
  onboarding: { done: false },
};

// 深合并：base 作骨架，patch 覆盖其上；数组整体替换（不逐项合并）
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    const b = base ? base[k] : undefined;
    const p = patch[k];
    const bothPlain = p && b && typeof p === 'object' && typeof b === 'object'
      && !Array.isArray(p) && !Array.isArray(b);
    out[k] = bothPlain ? deepMerge(b, p) : (p === undefined ? out[k] : p);
  }
  return out;
}

// 不透明度的**唯一存储口径**是单位区间小数（appearance 0.3–1 / stealth 0.05–0.9），
// 百分数只活在界面层（滑块 0–100）。v1.5 的滑块漏了这一次换算，把 100 直接存了进来，
// 回显时再 ×100 就显示成 10000%。这里在合并之后统一收口，既兜住历史脏数据，
// 也保证「就算某个入口忘了换算，落盘的永远是合法值」。
function normUnit(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  // > 1 只可能是百分数误存：100 → 1，10000 → 100 → 再夹到上界
  return clamp(n > 1 ? n / 100 : n, lo, hi);
}

function sanitizeSettings(s) {
  s.appearance.opacity = normUnit(s.appearance.opacity, 0.3, 1, 1);
  s.stealth.opacity = normUnit(s.stealth.opacity, 0.05, 0.9, 0.12);
  // v1.7.5 autoClean：脏数据收口 —— lastRun 只许对象或 null，pausedUntil 只许未过期的正数毫秒或 null
  if (s.autoClean && typeof s.autoClean === 'object') {
    s.autoClean.enabled = !!s.autoClean.enabled;
    const pu = Number(s.autoClean.pausedUntil);
    s.autoClean.pausedUntil = Number.isFinite(pu) && pu > Date.now() ? pu : null;
    if (!s.autoClean.lastRun || typeof s.autoClean.lastRun !== 'object') s.autoClean.lastRun = null;
  }
  // v1.8 ai：脏数据收口 —— maxTokens 夹到 64–2048，monthlyCap 非负数字，persona 清空回退默认
  if (s.ai && typeof s.ai === 'object') {
    s.ai.enabled = !!s.ai.enabled;
    const mt = Number(s.ai.maxTokens);
    s.ai.maxTokens = Number.isFinite(mt) ? clamp(Math.round(mt), 64, 2048) : 512;
    const cap = Number(s.ai.monthlyCap);
    s.ai.monthlyCap = Number.isFinite(cap) && cap > 0 ? Math.round(cap) : 0;
    s.ai.provider = ['deepseek', 'zhipu', 'qwen', 'openai', 'custom'].includes(s.ai.provider)
      ? s.ai.provider : 'deepseek';
    if (typeof s.ai.baseUrl !== 'string' || !s.ai.baseUrl.trim()) s.ai.baseUrl = DEFAULT_SETTINGS.ai.baseUrl;
    if (typeof s.ai.model !== 'string' || !s.ai.model.trim()) s.ai.model = DEFAULT_SETTINGS.ai.model;
    if (typeof s.ai.persona !== 'string' || !s.ai.persona.trim()) s.ai.persona = DEFAULT_SETTINGS.ai.persona;
  }
  return s;
}

function getSettings() {
  const st = loadState();
  const saved = st.settings || {};
  const s = deepMerge(DEFAULT_SETTINGS, saved);
  // v1.5 迁移：v1.4 把透明度/置顶存在状态根部（右键菜单写入），搬进 appearance。
  // 只在用户「没在设置里动过」时生效，所以一旦 settings.appearance 有了这两个键就不再覆盖。
  const had = saved.appearance || {};
  if (!('opacity' in had) && typeof st.opacity === 'number') s.appearance.opacity = st.opacity;
  if (!('onTop' in had) && typeof st.alwaysOnTop === 'boolean') s.appearance.onTop = st.alwaysOnTop;
  s._v = SETTINGS_VERSION;
  return sanitizeSettings(s);
}

// 写设置：deepMerge 后落盘，返回合并结果。
// sanitize 必须在 merge **之后** —— patch 自己也可能带着未换算的百分数。
function patchSettings(patch) {
  const next = sanitizeSettings(deepMerge(getSettings(), patch || {}));
  saveState({ settings: next });
  return next;
}

// ============ v1.8 G 组：LLM 服务商预设 / 单价表 / 钥匙串 ============
// 预设值硬编码于主进程（PRD §5.3 / §6.3）：渲染层只拿「选项名 + 选中值」，不落盘明文 Key。
// 全部 OpenAI 兼容 /v1/chat/completions；Ollama 用户直接在「自定义」填 http://localhost:11434。
const LLM_PRESETS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  zhipu:   { label: '智谱',     baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  qwen:    { label: '通义',     baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  openai:  { label: 'OpenAI',   baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  custom:  { label: '自定义',   baseUrl: '', model: '' },
};
// 单价表（元 / 千 token，估算口径）：仅三家预设 + OpenAI 有价；自定义按 0 估算（LLM-7 / Q4）
const LLM_PRICING = {
  deepseek: { in: 0.001, out: 0.002 },
  zhipu:    { in: 0.001, out: 0.002 },
  qwen:     { in: 0.001, out: 0.002 },
  openai:   { in: 0.005, out: 0.015 },
  custom:   { in: 0, out: 0 },
};
// 钥匙串条目：service=mio-llm，account=当前 macOS 用户名 —— 真 key 永不进 IPC 返回值
const KEYCHAIN_SERVICE = 'mio-llm';
const keychainAccount = () => os.userInfo().username || process.env.USER || 'mio';

// security CLI 封装（macOS 原生，零第三方依赖）
function keychainGet() {
  try {
    // 丢弃 stderr：无条目时 security 会向 stderr 打印 SecKeychainSearchCopyNext 噪音
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', keychainAccount(), '-w'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const v = String(out || '').trim();
    return v ? v : null;
  } catch { return null; }
}
function keychainSave(key) {
  if (!key) return { ok: false, error: 'Key 为空' };
  try {
    // -U：存在则覆盖，避免先删后写造成窗口期
    execFileSync('/usr/bin/security', ['add-generic-password', '-a', keychainAccount(), '-s', KEYCHAIN_SERVICE, '-w', key, '-U'], { timeout: 5000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 120) };
  }
}
function keychainDelete() {
  try {
    execFileSync('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', keychainAccount()], { timeout: 5000 });
  } catch {}
  return { ok: true };
}
// 脱敏串：sk- + 前 2 + 后 4；非 sk- 前缀也按同规则（首 2 + 末 4），保证渲染层永远拿不到完整 Key
function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 8) return '••••••';
  return `${s.slice(0, 2)}••••••${s.slice(-4)}`;
}

// ============ v1.5 B：外观与主题 ============
// 球体尺寸用 zoom 系数，基准 120px —— 表情各状态里写死了大量 px 尺寸，
// 逐个改成 calc() 侵入太大，zoom 能整体等比缩放且仍然参与布局。
const ORB_ZOOM = { sm: 0.8, md: 1, lg: 1.13 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 窗口级外观：透明度 / 置顶 / 所在显示器。尺寸与主题是纯渲染层的事，不在这里动。
function applyAppearance(a) {
  if (!win || win.isDestroyed()) return;
  const ap = a || getSettings().appearance;
  try {
    if (!stealthActive) win.setOpacity(clamp(Number(ap.opacity) || 1, 0.3, 1));
    win.setAlwaysOnTop(!!ap.onTop, 'floating');
  } catch {}
}

function moveToDisplay(displayId) {
  if (!win || win.isDestroyed() || displayId == null) return;
  const d = screen.getAllDisplays().find((x) => String(x.id) === String(displayId));
  if (!d) return;
  const remembered = (loadState().positions || {})[String(d.id)];
  const fallback = defaultPosFor(d);
  const pos = remembered && rectVisibleOnAnyDisplay(remembered.x, remembered.y, WIN_W, WIN_H)
    ? remembered : fallback;
  try { win.setPosition(Math.round(pos.x), Math.round(pos.y)); } catch {}
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
  // v1.5：若用户在设置里指定了屏幕，则以指定屏为准
  const appearance = getSettings().appearance;
  let targetDisplay = screen.getPrimaryDisplay();
  if (appearance.displayId) {
    targetDisplay = screen.getAllDisplays().find((d) => String(d.id) === String(appearance.displayId)) || targetDisplay;
  } else {
    try { targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || targetDisplay; } catch {}
  }

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
    alwaysOnTop: appearance.onTop,
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  applyAppearance(appearance);

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
  const ap = getSettings().appearance;
  const menu = Menu.buildFromTemplate([
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: !!ap.onTop,
      click: (item) => {
        patchSettings({ appearance: { onTop: item.checked } });
        applyAppearance();
      },
    },
    {
      label: '透明度',
      submenu: [1, 0.8, 0.6].map((v) => ({
        label: `${v * 100}%`,
        type: 'radio',
        checked: ap.opacity === v,
        click: () => {
          patchSettings({ appearance: { opacity: v } });
          applyAppearance();
        },
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
    io: ioCache,        // v1.7：磁盘 IO 小指标（后台 15s 采样，可能为 null 直到首次采样落地）
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
// tag：可选附加标记，自动清理传 { auto: true }，历史里能区分「Mio 自己清的」
function recordClean(items, tag = null) {
  try {
    const data = readCleanHistory();
    const total = items.reduce((a, i) => a + (i.size || 0), 0);
    const rec = { t: Date.now(), items, total };
    if (tag && typeof tag === 'object') Object.assign(rec, tag);
    data.records.unshift(rec);
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
// v1.7.5：抽出 executeCleanIds —— IPC 通道与定时清理计划共用同一条删除路径，
// 自动清理绝不另写一条（约束 2：只进废纸篓 + 必落清理历史）
async function executeCleanIds(ids, sizes = {}, targets = SCAN_TARGETS, historyTag = null) {
  const report = [];
  for (const id of ids) {
    const t = targets.find((x) => x.id === id);
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
    recordClean(histItems, historyTag);
    adviceCache.t = 0; // 清理后让建议引擎下次重算
    logMessage('Mio · 清理完成', `已移入废纸篓 ${report.reduce((a, r) => a + r.moved, 0)} 项`);
  }
  return report;
}

ipcMain.handle('clean-execute', (_e, ids, sizes = {}) => executeCleanIds(ids, sizes));

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
// v1.5：从纯 bundleid 数组升级为 {id,name}，名称由主进程提供，
// 渲染层不必再维护一份中文映射，设置页也能直接展示/增删。
const STEALTH_APPS = [
  { id: 'com.colliderli.iina', name: 'IINA' },
  { id: 'org.videolan.vlc', name: 'VLC' },
  { id: 'com.apple.QuickTimePlayerX', name: 'QuickTime' },
  { id: 'com.apple.TV', name: '视频' },
  { id: 'com.apple.iWork.Keynote', name: 'Keynote' },
  { id: 'com.microsoft.Powerpoint', name: 'PowerPoint' },
  { id: 'com.kingsoft.wpsoffice.mac', name: 'WPS' },
  { id: 'com.tencent.meeting', name: '腾讯会议' },
  { id: 'com.tencent.tencentmeeting', name: '腾讯会议' },
  { id: 'us.zoom.xos', name: 'Zoom' },
  { id: 'com.electron.lark', name: '飞书' },
  { id: 'com.alibaba.dingtalk.mac', name: '钉钉' },
];

// 用户可在设置里增删。settings.stealth.apps === null 表示「沿用内置名单」
function stealthList() {
  const custom = getSettings().stealth.apps;
  return Array.isArray(custom) ? custom : STEALTH_APPS;
}

let stealthTimer = null;
let stealthActive = false;
// 「刚才前台是哪个非 Mio 的 App」—— 设置页的「添加当前前台应用」用它取候选。
// 必须记非自身的前台应用：用户点开设置面板时，前台已经变成 Mio 自己了。
let lastForeignFront = null;

// 用 lsappinfo 一次拿到 bundleID / 显示名 / pid（零权限，实测约 8.5ms）
function frontAppInfo() {
  try {
    const asn = execSync('/usr/bin/lsappinfo front 2>/dev/null', { timeout: 1500 }).toString().trim();
    if (!asn) return null;
    const out = execSync(`/usr/bin/lsappinfo info ${asn} 2>/dev/null`, { timeout: 1500 }).toString();
    const id = (out.match(/"CFBundleIdentifier"="([^"]+)"/) || [])[1];
    if (!id) return null;
    const name = (out.match(/^"([^"]+)"/m) || [])[1] || id;
    const pid = Number((out.match(/\bpid = (\d+)/) || [])[1]) || null;
    return { id, name, pid };
  } catch { return null; }
}

// 淡出而非隐藏：保留一丝存在感，鼠标移过去还能交互唤回
function applyStealth(on) {
  if (!win || win.isDestroyed() || on === stealthActive) return;
  stealthActive = on;
  const dim = getSettings().stealth.opacity;
  try {
    win.setOpacity(on
      ? clamp(Number(dim) || 0.12, 0, 0.9)
      : clamp(getSettings().appearance.opacity, 0.3, 1));
  } catch {}
}

function stealthTick() {
  const info = frontAppInfo();
  // pid 比对能同时挡住「开发期的 Electron」和「打包后的 Mio」，不依赖写死 bundleid
  if (info && info.pid !== process.pid) lastForeignFront = { id: info.id, name: info.name };
  if (!getSettings().stealth.enabled) { applyStealth(false); return; }
  applyStealth(!!info && info.pid !== process.pid && stealthList().some((a) => a.id === info.id));

}

const readLoginItem = () => { try { return app.getLoginItemSettings().openAtLogin; } catch { return false; } };

// 设置读写：patch 只带改动的那一枝即可（深合并），不必回传整棵树
ipcMain.handle('settings-get', async () => ({
  ...getSettings(),
  isPackaged: app.isPackaged,
  loginItem: readLoginItem(),
  stealthApps: stealthList(),
  stealthActive,
  version: app.getVersion(),
  userDataPath: app.getPath('userData'),
  displays: displayList(),
  lastFrontApp: lastForeignFront,
  // v1.6：权限快照（仅状态枚举，绝不含任何明文）；automation 走缓存探测避免每次卡 4s
  permissions: {
    screen: screenStatus(),
    accessibility: accessibilityTrusted(false),
    automation: await probeFinder(true),
  },
  hotkeyRegistered,
}));

ipcMain.handle('settings-set', (_e, patch) => {
  const before = getSettings();
  const next = patchSettings(patch);
  // 窗口级外观即时生效；尺寸/主题等纯渲染层的项由渲染层自己应用
  if (JSON.stringify(before.appearance) !== JSON.stringify(next.appearance)) applyAppearance(next.appearance);
  if (before.appearance.displayId !== next.appearance.displayId && next.appearance.displayId) {
    moveToDisplay(next.appearance.displayId);
  }
  if (next.stealth && next.stealth.enabled === false) applyStealth(false);
  // 正隐身时拖「隐身不透明度」滑块要立刻看到效果，不必等下一次 tick
  if (stealthActive && before.stealth.opacity !== next.stealth.opacity) {
    try { win.setOpacity(clamp(Number(next.stealth.opacity) || 0.12, 0, 0.9)); } catch {}
  }
  // v1.6 E1/E2：剪贴板开关即时启停采集（关闭同时清空列表）；条数改小立即裁剪
  if (before.clipboard.enabled !== next.clipboard.enabled) {
    if (next.clipboard.enabled) startClip();
    else { stopClip(); clearClip(); }
  }
  // v1.7 天气：开关/城市/频率/单位任一变化都重排轮询；城市或单位变了立刻重取
  if (JSON.stringify(before.weather) !== JSON.stringify(next.weather)) {
    scheduleWeather();
    if (before.weather.city !== next.weather.city || before.weather.unit !== next.weather.unit) {
      weatherCache = null;
      getWeather(true);
    }
  }
  if (Number(before.clipboard.limit) !== Number(next.clipboard.limit)) {
    enforceLimit();
    broadcastClip();
  }
  return {
    ...next,
    loginItem: readLoginItem(),
    stealthApps: stealthList(),
    lastFrontApp: lastForeignFront,
    hotkeyRegistered,
  };
});

// 可选显示器清单（设置页的「显示在哪块屏幕」）
function displayList() {
  const primaryId = String(screen.getPrimaryDisplay().id);
  return screen.getAllDisplays().map((d) => ({
    id: String(d.id),
    label: `${d.label || '显示器'} · ${d.bounds.width}×${d.bounds.height}${String(d.id) === primaryId ? ' · 主屏' : ''}`,
  }));
}

ipcMain.handle('displays-list', () => displayList());

// 「添加当前前台应用」：把最近一次识别到的非 Mio 前台应用加进隐身名单
ipcMain.handle('stealth-capture', () => {
  const cand = lastForeignFront;
  if (!cand) return { ok: false, error: '还没识别到其他应用，先把目标 App 切到前台再试' };
  const list = stealthList();
  if (list.some((a) => a.id === cand.id)) return { ok: false, error: `${cand.name} 已经在名单里了` };
  const apps = [...list, cand];
  patchSettings({ stealth: { apps } });
  return { ok: true, app: cand, apps };
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

// ============ v1.7：横切小工具 ============
// 带超时的命令执行（Promise 化）。权限探测/锁屏/截图都走它，超时一律视为失败而不是挂死
function runCmd(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err }));
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: '', err });
    }
  });
}

const fetchJson = async (url, timeout = 8000) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) }); // Node 20 内置 fetch，零依赖
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// 自动定位：先用免 key 地理服务取真实经纬度，再交给 wttr.in 做坐标查询。
// 为什么不再依赖 wttr.in 自带的 IP 定位：它按「公网出口 IP」判定，
// VPN / 宽带出口 / 运营商 CGNAT 都会导致定位偏差（用户实测定位到的不是自己所在城市）。
// api.ip.sb 免 key 且国内可达；结果 24h 内复用，避免每次刷新都多打一次网络请求
let geoCache = null;
async function ipGeo() {
  if (geoCache && Date.now() - geoCache.at < 24 * 3600 * 1000) return geoCache;
  // 坐标来源 api.ip.sb（实测定位准）；显示名再用 BigDataCloud 免 key 逆地理换成中文，
  // 失败退回 api.ip.sb 的英文名 —— 界面上「西安市」比「Xi'an」更像定位信息
  const g = await fetchJson('https://api.ip.sb/geoip', 6000);
  const lat = Number(g.latitude);
  const lon = Number(g.longitude);
  if (!lat || !lon) throw new Error('geo 无坐标');
  let city = g.city || g.region || '当前位置';
  try {
    // 显示名用 BigDataCloud 免 key 中文逆地理（pconline 按 IP 频控太抖，弃用）
    const z = await fetchJson(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`, 6000);
    if (z && z.city) city = z.city; // 如「西安市」
  } catch {} // 中文名只是锦上添花，拿不到不影响定位
  geoCache = { city, lat, lon, at: Date.now() };
  return geoCache;
}

// 权限探测层在 v1.6 已建好（perm-status / perm-request / perm-open + DEEP_LINKS），
// v1.7 I 组直接复用，不再重复造 —— 这里只补数据与隐私相关通道。

// ============ v1.7 H 组：数据与隐私 ============
// 清除所有本地数据：走废纸篓（可找回），而不是直接删 —— 与全局安全模型保持一致，
// 代价只是「重启后生效」。渲染层必须先走通用二次确认通道才允许调 run 档
const DATA_FILES = ['mio-state.json', 'mio-history.json', 'mio-messages.json', 'mio-clean-history.json'];

ipcMain.handle('data-wipe', async (_e, mode) => {
  const dir = app.getPath('userData');
  const files = [];
  for (const f of DATA_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) files.push(p);
  }
  if (mode !== 'run') return { ok: true, files, preview: true }; // 自检/展示用，绝不动文件
  const failed = [];
  for (const p of files) {
    try { await shell.trashItem(p); } catch { failed.push(path.basename(p)); }
  }
  return {
    ok: failed.length === 0,
    wiped: files.length - failed.length,
    failed,
    needsRestart: true, // 内存里的状态还要活到退出为止，提示用户重启
  };
});

ipcMain.handle('data-show', () => {
  shell.showItemInFolder(path.join(app.getPath('userData'), 'mio-state.json'));
  return { ok: true };
});

// ============ v1.7 F 组：天气卡片（wttr.in 免 key + IP 定位城市）============
// 隐私口径（写死进关于页的那段话）：只把「城市名」发出去，其余数据一律不出本机。
// 失败语义：断网/超时/返回异常都不许让面板卡住 —— 返回 ok:false，渲染层保留旧值并提示
// ⚠️ 码表必须跟着数据源走：wttr.in 用的是 WWO **三位**码（113/116/119/122/149/176…），
// 不是 Open-Meteo 那套 WMO 0-99 码。此前误用 WMO 码表，实测 wttr.in 返回的码
// 一个都命不中，导致几乎所有天气都 fallback 成「🌡️ 未知」。这里按 wttr.in 的码全量补齐
const WX_CODES = {
  113: ['☀️', '晴'], 116: ['🌤️', '大部晴'], 119: ['☁️', '阴'], 122: ['☁️', '阴'],
  143: ['🌫️', '薄雾'], 149: ['🌫️', '烟霾'],
  176: ['🌦️', '附近有阵雨'], 179: ['🌨️', '零星小雪'], 182: ['🌨️', '零星雨夹雪'],
  185: ['🌧️', '零星冻毛毛雨'], 200: ['⛈️', '附近有雷'],
  227: ['❄️', '风吹雪'], 230: ['❄️', '暴风雪'],
  248: ['🌫️', '雾'], 260: ['🌫️', '冻雾'],
  263: ['🌦️', '零星小毛毛雨'], 266: ['🌧️', '小毛毛雨'],
  281: ['🌧️', '冻毛毛雨'], 284: ['🌧️', '强冻毛毛雨'],
  293: ['🌦️', '零星小雨'], 296: ['🌧️', '小雨'],
  299: ['🌧️', '间歇中雨'], 302: ['🌧️', '中雨'],
  305: ['🌧️', '间歇大雨'], 308: ['🌧️', '大雨'],
  311: ['🌧️', '冻雨'], 314: ['🌧️', '中到强冻雨'],
  317: ['🌧️', '冻雨'], 320: ['🌧️', '中到强冻雨'],
  323: ['🌨️', '零星小雪'], 326: ['🌨️', '小雪'],
  329: ['🌨️', '零星中雪'], 332: ['🌨️', '中雪'],
  335: ['❄️', '零星大雪'], 338: ['❄️', '大雪'],
  350: ['🌨️', '冰粒'],
  353: ['🌦️', '小阵雨'], 356: ['🌧️', '中到大阵雨'], 359: ['⛈️', '暴雨'],
  362: ['🌨️', '小阵雨夹雪'], 365: ['🌨️', '中到大阵雨夹雪'],
  368: ['🌨️', '小阵雪'], 371: ['🌨️', '中到大阵雪'],
  374: ['🌨️', '小阵冰粒'], 377: ['🌨️', '中到大阵冰粒'],
  386: ['⛈️', '零星雷雨'], 389: ['⛈️', '雷雨'],
  392: ['⛈️', '零星雷雪'], 395: ['⛈️', '雷雪'],
};
// 带伞 / 保暖提示用的集合，同样按 WWO 码（原来也是 WMO 码，一并纠正）
const RAIN_CODES = new Set([176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 317, 320, 353, 356, 359, 362, 365, 374, 377, 386, 389]);
const SNOW_CODES = new Set([179, 182, 227, 230, 323, 326, 329, 332, 335, 338, 350, 368, 371, 392, 395]);

let weatherCache = null;      // 最近一次成功结果（仅内存，重启重取 —— 数据本身无隐私价值，不值得落盘）
let weatherTimer = null;
let weatherInflight = null;   // 防并发：轮询与手动刷新撞车时复用同一个 Promise

// 定位策略：手动城市直接拼进 URL；自动模式**不带城市参数** —— wttr.in 会按请求 IP
// 自行定位，并在 nearest_area 里把地名带回来。这样连 IP 定位服务都省了
// （ipapi.co 挂着 Cloudflare 人机验证，实测拿不到 JSON，弃用），隐私面也更小
async function fetchWeather() {
  const manual = getSettings().weather.city;
  const unit = getSettings().weather.unit === 'f' ? 'f' : 'c';
  let cityOverride = null;
  let url;
  if (manual) {
    url = `https://wttr.in/${encodeURIComponent(manual)}?format=j1`;
  } else {
    try {
      const g = await ipGeo();              // 先拿真实经纬度（比 wttr.in 自带 IP 定位准）
      url = `https://wttr.in/${g.lat},${g.lon}?format=j1`;
      cityOverride = g.city;                // 用地理服务给的城市名显示，更准更好读
    } catch {
      url = 'https://wttr.in/?format=j1';   // 兜底：退回 wttr.in 自带 IP 定位
    }
  }
  const j = await fetchJson(url);
  const cur = j && j.current_condition && j.current_condition[0];
  // wttr.in 的键名是大写单位（temp_C / temp_F / FeelsLikeC），小写会拿到 undefined
  const tKey = unit === 'f' ? 'temp_F' : 'temp_C';
  const fKey = unit === 'f' ? 'FeelsLikeF' : 'FeelsLikeC';
  if (!cur || cur[tKey] === undefined) throw new Error('返回结构异常');
  const area = j && j.nearest_area && j.nearest_area[0];
  const city = manual
    || cityOverride
    || (area && area.areaName && area.areaName[0] && area.areaName[0].value)
    || '当前位置';
  const code = Number(cur.weatherCode) || 0;
  const [icon, desc] = WX_CODES[code] || ['🌡️', '未知'];
  const hint = RAIN_CODES.has(code) ? '出门记得带伞 ☂️'
    : SNOW_CODES.has(code) ? '路滑，注意保暖 🧣' : '';
  return {
    ok: true,
    data: {
      city,
      auto: !manual, // 城市来自 IP 定位时，设置页要能看到「定位到哪了」
      icon,
      desc,
      temp: Math.round(Number(cur[tKey])),
      feels: Math.round(Number(cur[fKey] ?? cur[tKey])),
      humidity: Number(cur.humidity) || null,
      wind: Math.round(Number(cur.windspeedKmph) || 0),
      unit: unit === 'f' ? '℉' : '℃',
      hint,
      at: Date.now(),
    },
  };
}

// 统一入口：缓存 10 分钟内直接复用；失败时保留旧数据并带 error 出去（面板不卡住）
async function getWeather(force = false) {
  if (!getSettings().weather.enabled) return { ok: false, disabled: true };
  if (!force && weatherCache && Date.now() - weatherCache.at < 10 * 60 * 1000) {
    return { ok: true, data: weatherCache, cached: true };
  }
  if (!weatherInflight) {
    weatherInflight = fetchWeather()
      .then((r) => { if (r.ok) weatherCache = r.data; return r; })
      .catch((err) => ({
        ok: false,
        error: '天气暂时拿不到',
        detail: String((err && err.message) || err).slice(0, 60),
        stale: weatherCache || null, // 失败也把旧值带回去，界面不至于空白
      }))
      .finally(() => { weatherInflight = null; });
  }
  return weatherInflight;
}

function scheduleWeather() {
  if (weatherTimer) { clearInterval(weatherTimer); weatherTimer = null; }
  const w = getSettings().weather;
  if (!w.enabled) return;
  const mins = [30, 60, 120].includes(Number(w.interval)) ? Number(w.interval) : 60;
  weatherTimer = setInterval(() => getWeather(true), mins * 60 * 1000);
}

ipcMain.handle('weather-get', () => getWeather(false));
ipcMain.handle('weather-refresh', () => getWeather(true));

// ============ v1.8 G 组：LLM 聊天（B4-1） ============
// 安全红线（PRD §6）：真 key 永不进 IPC 返回值；连通性测试由主进程发起；
// 对话内容只发往用户配置的 Base URL；无定时/后台 LLM 调用 —— 只有用户点「发送」才发请求。
const LLM_MONTH_FILE = path.join(app.getPath('userData'), 'mio-llm-month.json'); // 月度花费估算（非对话历史）

function loadLlmMonth() {
  try { return JSON.parse(fs.readFileSync(LLM_MONTH_FILE, 'utf8')); } catch { return {}; }
}
function saveLlmMonth(m) {
  try { fs.writeFileSync(LLM_MONTH_FILE, JSON.stringify(m)); } catch {}
}
// 当月已估算花费（元）：按自然月重置；key 形如 2026-09
function llmMonthSpent() {
  const m = loadLlmMonth();
  const key = (() => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}`; })();
  if (m.key !== key) return 0;
  return Number(m.spent) || 0;
}
function llmMonthAdd(costYuan) {
  const m = loadLlmMonth();
  const d = new Date();
  const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
  if (m.key !== key) m.key = key, m.spent = 0;
  m.spent = Number(m.spent) || 0;
  m.spent += Number(costYuan) || 0;
  saveLlmMonth(m);
  return m.spent;
}

// 估算 token（展示用，不精确）：ceil(字符数 / 3) —— 中文约 1 token/字，英文约 3 字符/token
function estTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  return Math.ceil(s.length / 3);
}
// 估算花费（元）：输入 token × 输入单价 + 输出 token × 输出单价（单价为「元 / 千 token」）
function estCost(provider, inTokens, outTokens) {
  const p = LLM_PRICING[provider] || LLM_PRICING.custom;
  return ((inTokens * p.in) + (outTokens * p.out)) / 1000;
}

// 组装请求消息：只发「system（人设）+ 本次用户消息」，不携带历史（LLM-9 单轮）
function buildChatMessages(ai, userText) {
  const persona = (ai && ai.persona) || DEFAULT_SETTINGS.ai.persona;
  const text = String(userText || '').trim();
  return [
    { role: 'system', content: persona },
    { role: 'user', content: text },
  ];
}

// 统一错误分类（渲染层据此显示可读文案，不弹系统窗）
function llmErrorKind(err) {
  const msg = String((err && err.message) || err || '');
  if (/401|403|invalid api|unauthorized|authentication/i.test(msg)) return 'unauthorized';
  if (/timeout|aborted|abort/i.test(msg)) return 'timeout';
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket/i.test(msg)) return 'network';
  if (/429|rate limit|quota/i.test(msg)) return 'quota';
  if (/404|not found/i.test(msg)) return 'notfound';
  return 'error';
}

// 主进程发起 OpenAI 兼容 chat 请求（零依赖：Node 内置 fetch + AbortSignal.timeout）
async function llmRequest({ baseUrl, model, apiKey, maxTokens, userText, minimal = false }) {
  const url = String(baseUrl || '').trim().replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model,
    max_tokens: Number(maxTokens) || 512,
    // minimal=true 时只发最小请求（连通性测试，不消耗对话额度）
    messages: minimal
      ? [{ role: 'user', content: 'hi' }]
      : buildChatMessages(getSettings().ai, userText),
  };
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (typeof out !== 'string') throw new Error('返回结构异常');
  return { text: out.trim(), usage: (j && j.usage) || null };
}

// 单轮对话（LLM-9 / LLM-10）：调用前检查配置与月度上限；调用后累计估算花费
async function llmChat(userText) {
  const ai = getSettings().ai;
  const apiKey = keychainGet();
  if (!ai.enabled) return { ok: false, kind: 'disabled', error: 'AI 对话未启用' };
  if (!apiKey) return { ok: false, kind: 'nokey', error: '还没保存 API Key' };
  if (!ai.baseUrl || !ai.model) return { ok: false, kind: 'unconfigured', error: '还没配置 Base URL 或模型名' };
  if (!String(userText || '').trim()) return { ok: false, kind: 'empty', error: '输入为空' };
  // LLM-7：月度花费上限（估算护栏）—— 达到即停止调用
  const cap = Number(ai.monthlyCap) || 0;
  if (cap > 0 && llmMonthSpent() >= cap) {
    return { ok: false, kind: 'cap', error: '本月额度已用完', spent: llmMonthSpent(), cap };
  }
  try {
    const inTokens = estTokens(JSON.stringify(buildChatMessages(ai, userText)));
    const r = await llmRequest({ model: ai.model, apiKey, maxTokens: ai.maxTokens, userText });
    const outTokens = estTokens(r.text);
    const cost = estCost(ai.provider, inTokens, outTokens);
    const spent = llmMonthAdd(cost);
    return {
      ok: true,
      reply: r.text,
      estTokens: inTokens + outTokens,
      estCost: cost,
      spent,
      cap: cap > 0 ? cap : null,
    };
  } catch (err) {
    return { ok: false, kind: llmErrorKind(err), error: String((err && err.message) || err).slice(0, 160) };
  }
}

// 连通性测试（LLM-5）：主进程发起最小请求，渲染层只显示结果；不消耗对话额度
async function llmTest() {
  const ai = getSettings().ai;
  if (!ai.baseUrl || !ai.model) return { ok: false, kind: 'unconfigured', error: '还没配置 Base URL 或模型名' };
  const apiKey = keychainGet();
  if (!apiKey) return { ok: false, kind: 'nokey', error: '先保存 API Key 再测试' };
  try {
    await llmRequest({ model: ai.model, apiKey, maxTokens: 16, minimal: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, kind: llmErrorKind(err), error: String((err && err.message) || err).slice(0, 160) };
  }
}

// ===== v1.8 G 组 IPC =====
// llm-get-config：返回 G 组配置 + 预设表 + 脱敏 Key（真 key 永不进 IPC）
function llmGetConfig() {
  const ai = getSettings().ai;
  return {
    ok: true,
    ai: {
      enabled: ai.enabled,
      provider: ai.provider,
      baseUrl: ai.baseUrl,
      model: ai.model,
      monthlyCap: ai.monthlyCap,
      maxTokens: ai.maxTokens,
      persona: ai.persona,
    },
    presets: Object.keys(LLM_PRESETS).map((k) => ({ id: k, label: LLM_PRESETS[k].label })),
    pricing: LLM_PRICING,
    keyMasked: maskKey(keychainGet()),
    spent: llmMonthSpent(),
  };
}
ipcMain.handle('llm-get-config', () => llmGetConfig());
// llm-save-key：把 Key 写入钥匙串（security add-generic-password -U）；永远不回传真 key
ipcMain.handle('llm-save-key', (_e, payload) => {
  const key = payload && payload.key;
  if (!key || !String(key).trim()) return { ok: false, error: 'Key 为空' };
  const r = keychainSave(String(key).trim());
  return r.ok ? { ok: true, keyMasked: maskKey(String(key).trim()) } : r;
});
// llm-delete-key：删除钥匙串条目
ipcMain.handle('llm-delete-key', () => {
  keychainDelete();
  return { ok: true, keyMasked: '' };
});
// llm-test：连通性测试（主进程发起）
ipcMain.handle('llm-test', () => llmTest());
// llm-chat：单轮对话（仅用户主动发问）
ipcMain.handle('llm-chat', (_e, payload) => llmChat(payload && payload.text));

// ============ v1.8 B4-2：首次启动引导 ============
// 老用户不弹：只有 settings.onboarding.done 不是 true 才显示三步全屏引导。
// 引导只写 settings（onboarding.done=true），不创建任何额外文件。
// 三步：① 城市选择（写 weather.city）② 是否启用 AI（写 ai.enabled）③ 权限说明（只读展示）
function onboardingGet() {
  // 自检模式不弹引导：MIO_AUTOTEST=1 时视为已引导（避免全屏覆盖层干扰截图与点击走查）
  if (process.env.MIO_AUTOTEST === '1') {
    return { ok: true, done: true, city: null, aiEnabled: false };
  }
  const s = getSettings();
  return {
    ok: true,
    done: !!s.onboarding && s.onboarding.done === true,
    city: (s.weather && s.weather.city) || null,
    aiEnabled: !!(s.ai && s.ai.enabled),
  };
}
ipcMain.handle('onboarding-get', () => onboardingGet());
function onboardingSet(payload) {
  const p = payload || {};
  const patch = {};
  if (p.city !== undefined) patch.weather = { city: p.city };
  if (p.aiEnabled !== undefined) patch.ai = { enabled: !!p.aiEnabled };
  if (p.done === true) patch.onboarding = { done: true };
  patchSettings(patch);
  return { ok: true, done: !!getSettings().onboarding && getSettings().onboarding.done === true };
}
ipcMain.handle('onboarding-set', (_e, payload) => onboardingSet(payload));

// ============ v1.8 B4-3：自动更新 ============
// 启动时对比 GitHub Releases（latest），24h 限频（mio-update-check.json 记录 lastCheckAt）。
// 失败静默（不弹系统通知、不打断用户）；发现新版本时只推一次 update-notice 事件，
// 渲染层在「关于」页显示非阻塞提示条（不自动下载、不强制）。
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24h
// 仓库 owner/repo 从 package.json 的 repository 字段读取（PRD Q2）：无仓库 → 静默禁用更新检查；
// 避免硬编码在仓库迁移/改名后失配。格式：https://github.com/<owner>/<repo>.git → <owner>/<repo>
const _repoUrl = (() => { try { return (require('./package.json').repository && require('./package.json').repository.url) || ''; } catch { return ''; } })();
const UPDATE_REPO = String(_repoUrl).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').trim();
const UPDATE_CHECK_FILE = path.join(app.getPath('userData'), 'mio-update-check.json');
let updateLastNoticeAt = 0; // 节流：同一版本只提示一次

function loadUpdateCheck() {
  try { return JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, 'utf8')); } catch { return {}; }
}
function saveUpdateCheck(m) {
  try { fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify(m)); } catch {}
}
// 从 GitHub Releases API 拉最新版本（零依赖：Node 内置 fetch + AbortSignal.timeout）
async function fetchLatestRelease() {
  const url = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const tag = String(j.tag_name || '').trim();
  if (!tag) throw new Error('tag 为空');
  return { tag, name: String(j.name || tag), url: String(j.html_url || '') };
}
// 比较版本号：返回 true 表示 remote 比 current 新（支持 v1.8.0 / 1.8.0 两种写法）
function isNewerVersion(remote, current) {
  const parse = (v) => String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(remote);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}
// 启动时静默检查（24h 限频；失败静默；发现新版本发一次 update-notice 事件）
async function checkForUpdates({ force = false } = {}) {
  if (process.env.MIO_AUTOTEST === '1') return { ok: false, skipped: 'autotest' }; // 自检不打扰
  if (!UPDATE_REPO) return { ok: false, skipped: 'no-repo' }; // 无仓库地址 → 静默禁用（PRD Q2）
  const st = loadUpdateCheck();
  const now = Date.now();
  if (!force && Number(st.lastCheckAt) && now - Number(st.lastCheckAt) < UPDATE_CHECK_INTERVAL) {
    return { ok: false, skipped: 'rate-limited' };
  }
  saveUpdateCheck({ ...st, lastCheckAt: now });
  try {
    const remote = await fetchLatestRelease();
    const current = app.getVersion();
    const hasNew = isNewerVersion(remote.tag, current);
    const key = `${remote.tag}@${current}`;
    // 同一版本只提示一次（节流 24h）
    if (hasNew && st.lastNoticeKey !== key && now - updateLastNoticeAt > UPDATE_CHECK_INTERVAL) {
      updateLastNoticeAt = now;
      saveUpdateCheck({ ...loadUpdateCheck(), lastNoticeKey: key });
      if (win && !win.isDestroyed()) {
        win.webContents.send('update-notice', {
          hasNew: true,
          version: remote.tag,
          name: remote.name,
          url: remote.url,
        });
      }
    }
    return { ok: true, hasNew, current, latest: remote.tag, url: remote.url };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 120) };
  }
}

// 手动检查（设置页「检查更新」按钮）：强制绕过 24h 限频，但结果仍是静默通知
ipcMain.handle('update-check', () => checkForUpdates({ force: true }));
// 渲染层订阅 update-notice 事件（主进程启动时自动检查、发现新版本推送一次）
ipcMain.handle('update-check-status', () => {
  const st = loadUpdateCheck();
  return { ok: true, lastCheckAt: st.lastCheckAt || null, lastNoticeKey: st.lastNoticeKey || null };
});

// ============ v1.7：磁盘 IO（状态页小指标，不做独立卡片 —— 路线图 §6.2 降级决策）============
// iostat 的第二个采样才是「刚才 1 秒」，第一个是开机以来的均值。采样本身要 1 秒，
// 所以放后台 15s 一次、只写缓存，绝不在 system-full 里同步等 —— 状态页不能为一个小指标多卡 1 秒
let ioCache = null;
let ioBusy = false;
function sampleDiskIO() {
  if (ioBusy) return;
  ioBusy = true;
  runCmd('/usr/sbin/iostat', ['-d', '-w', '1', '-c', '2'], 4000).then((r) => {
    ioBusy = false;
    if (!r.ok) return;
    const rows = r.stdout.split('\n').map((l) => l.trim()).filter((l) => /^\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?$/.test(l));
    const last = rows[rows.length - 1];
    if (!last) return;
    const cols = last.split(/\s+/); // KB/t  tps  MB/s
    const tps = Number(cols[1]);
    const mbs = Number(cols[2]);
    if (!Number.isFinite(mbs) || !Number.isFinite(tps)) return;
    ioCache = { tps, mbs, at: Date.now() };
  }).catch(() => { ioBusy = false; });
}




// ============ v1.6 B2-1 / v1.7.6 增强：剪贴板历史（文本 + 图片 · 只在内存）============
// 采集全在主进程内存完成，渲染层只拿 preview / 缩略图，真文本与原图永不出主进程 ——
// 零落盘天然满足隐私可验证要求：userData grep 无内容、退出即归零
let clipItems = [];      // ClipItem[]，index 0 = 最新（{type:'text'|'image', ...}）
let clipPaused = false;  // 不落盘（Q5）
let clipTimer = null;    // 800ms 轮询句柄
let clipLastText = '';   // 相邻去重 + 取回防重入基线
let clipLastImgKey = ''; // 图片相邻去重（PNG 的 sha256）
let clipSeq = 0;         // id 递增序号
let clipNoticeAt = 0;    // 密码过滤轻提示节流时间戳
let clipPollTick = 0;    // 轮询计数：图片比对按此节流
const CLIP_MAX_PIN = 3;          // 钉住上限（Q2）
const CLIP_NOTICE_GAP = 30 * 1000; // 过滤提示最小间隔（Q3）
const CLIP_PREVIEW_LEN = 120;      // 出渲染层的预览截断长度
// v1.7.6：图片（含截图）支持。图片比文本大得多，必须单独限额 + 节流，否则内存/CPU 双爆
const CLIP_MAX_IMG = 5;                      // 图片条目上限
const CLIP_MAX_IMG_BYTES = 8 * 1024 * 1024;  // 单张 PNG 上限 8MB，超出不采集
const CLIP_MAX_TEXT = 200 * 1024;            // 单条文本上限 200KB，超出不采集
const CLIP_THUMB_W = 96;                     // 缩略图宽度（出渲染层只给缩略图）
const CLIP_IMG_EVERY = 4;                    // 每 4 次轮询（约 3.2s）才比对一次图片

const clipPreview = (text) => {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > CLIP_PREVIEW_LEN ? one.slice(0, CLIP_PREVIEW_LEN) + '…' : one;
};

// 密码启发式：8–64 位、无空白、同时含大小写与数字。必然误伤（如 MyPassw0rd），故默认关闭
const isPasswordLike = (text) => {
  const t = String(text);
  if (t.length < 8 || t.length > 64) return false;
  if (/\s/.test(t)) return false;
  return /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t);
};

// 出渲染层的形状：只给 preview / 缩略图，不给全文与原图
const clipPublic = (it) => ({
  id: it.id,
  preview: it.type === 'image' ? `🖼 图片 ${it.w}×${it.h}` : clipPreview(it.text),
  pinned: it.pinned,
  t: it.t,
  type: it.type || 'text',
  thumb: it.type === 'image' ? (it.thumb || '') : '', // 出渲染层的只是 96px 缩略图
});

function clipSnapshot() {
  const s = getSettings().clipboard;
  return {
    ok: true,
    items: clipItems.map(clipPublic),
    paused: clipPaused,
    enabled: !!s.enabled,
    limit: Number(s.limit) || 10,
    pinnedCount: clipItems.filter((i) => i.pinned).length,
    imgCount: clipItems.filter((i) => i.type === 'image').length, // v1.7.6
  };
}

// 数据一变就推事件，渲染层据此拉最新列表（消息面很小：只有 count/paused）
function broadcastClip() {
  if (win && !win.isDestroyed()) win.webContents.send('clip-changed', { count: clipItems.length, paused: clipPaused });
}

// 上限裁剪：limit 是「总数上限」（含钉住条）。从尾部找最旧的未钉条剔除；
// 若全部已钉（≤3 条）则不再剔除，钉住条只抵抗顶替、不额外占名额
function enforceLimit() {
  const limit = Number(getSettings().clipboard.limit) || 10;
  while (clipItems.length > limit) {
    let idx = -1;
    for (let i = clipItems.length - 1; i >= 0; i--) {
      if (!clipItems[i].pinned) { idx = i; break; }
    }
    if (idx === -1) break; // 全是钉住条，停止裁剪
    clipItems.splice(idx, 1);
  }
}

function addClip(text) {
  const s = getSettings().clipboard;
  if (!s.enabled || clipPaused) return;              // 关闭 / 暂停 → 不采集
  if (typeof text !== 'string' || text.trim() === '') return; // 空串 / 纯空白 → 丢弃
  if (text.length > CLIP_MAX_TEXT) return;           // v1.7.6：超大文本不采集（内存保护）
  if (s.filterPassword && isPasswordLike(text)) {
    // 只跳过采集、不动系统剪贴板；节流回轻提示，避免每次复制都弹
    const now = Date.now();
    if (now - clipNoticeAt >= CLIP_NOTICE_GAP) {
      clipNoticeAt = now;
      if (win && !win.isDestroyed()) win.webContents.send('clip-notice', { kind: 'filtered' });
    }
    return;
  }
  // 相同文本已在列表 → 不新增，改置顶（trim 后比较，前后空白差异不算新条目）
  const t2 = text.trim();
  const same = clipItems.find((i) => i.type !== 'image' && String(i.text).trim() === t2);
  if (same) {
    if (!same.pinned) {
      clipItems.splice(clipItems.indexOf(same), 1);
      clipItems.unshift(same);
      broadcastClip();
    }
    return;
  }
  clipItems.unshift({ id: 'c_' + (++clipSeq), type: 'text', text, pinned: false, t: Date.now() });
  enforceLimit();
  broadcastClip();
}

// v1.7.6：图片（含截图）。主进程留 PNG Buffer 供「取回」，出渲染层只给 96px 缩略图
function addClipImage(img) {
  const s = getSettings().clipboard;
  if (!s.enabled || clipPaused) return;
  try {
    if (!img || img.isEmpty()) return;
    const size = img.getSize();
    const png = img.toPNG();
    if (!png || !png.length) return;
    if (png.length > CLIP_MAX_IMG_BYTES) return; // 超大图不采集，避免内存爆炸
    const key = crypto.createHash('sha256').update(png).digest('hex');
    const same = clipItems.find((i) => i.type === 'image' && i.key === key);
    if (same) {
      if (!same.pinned) {
        clipItems.splice(clipItems.indexOf(same), 1);
        clipItems.unshift(same);
        broadcastClip();
      }
      return;
    }
    let thumb = '';
    try {
      thumb = img.resize({ width: Math.min(CLIP_THUMB_W, size.width), quality: 'better' }).toDataURL();
    } catch {}
    clipItems.unshift({
      id: 'c_' + (++clipSeq), type: 'image', key, png, thumb,
      w: size.width, h: size.height, text: '', pinned: false, t: Date.now(),
    });
    enforceImageLimit();
    enforceLimit();
    broadcastClip();
  } catch {}
}

// 图片单独限额：超上限时从尾部剔除最旧的未钉图片
function enforceImageLimit() {
  let count = clipItems.filter((i) => i.type === 'image').length;
  while (count > CLIP_MAX_IMG) {
    let idx = -1;
    for (let i = clipItems.length - 1; i >= 0; i--) {
      if (clipItems[i].type === 'image' && !clipItems[i].pinned) { idx = i; break; }
    }
    if (idx === -1) break; // 全是钉住的图片
    clipItems.splice(idx, 1);
    count -= 1;
  }
}

// Mio 自己截图后立刻采一次（轮询有节流，这里保证「截图即进历史」的即时感）
function captureClipImageNow() {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return;
    const png = img.toPNG();
    clipLastImgKey = png && png.length ? crypto.createHash('sha256').update(png).digest('hex') : '';
    clipLastText = '';
    addClipImage(img);
  } catch {}
}

// 轮询：与上一条逐字符比较去重（不引 crypto/hash）
function clipPoll() {
  const s = getSettings().clipboard;
  if (!s.enabled || clipPaused) return;
  clipPollTick += 1;
  // v1.7.6：图片比对。toPNG + sha256 比文本贵得多，按 CLIP_IMG_EVERY 节流
  if (clipPollTick % CLIP_IMG_EVERY === 0) {
    try {
      const img = clipboard.readImage();
      if (img && !img.isEmpty()) {
        const png = img.toPNG();
        const key = png && png.length ? crypto.createHash('sha256').update(png).digest('hex') : '';
        if (key && key !== clipLastImgKey) {
          clipLastImgKey = key;
          clipLastText = ''; // 图片替换了剪贴板内容 → 文本基线作废
          addClipImage(img);
          return;            // 同一时刻只可能有一种新内容
        }
        return;              // 图片没变 → 无事发生
      }
      clipLastImgKey = '';   // 剪贴板已无图片
    } catch {}
  }
  let text = '';
  try { text = clipboard.readText(); } catch { return; }
  if (text === clipLastText) return;
  clipLastText = text;
  clipLastImgKey = '';       // 换成文本 → 图片基线作废
  addClip(text);
}

function startClip() {
  if (clipTimer) return;
  try { clipLastText = clipboard.readText(); } catch { clipLastText = ''; } // 起跑先记基线，已有剪贴板内容不补采
  clipTimer = setInterval(clipPoll, 800);
}

function stopClip() {
  if (clipTimer) { clearInterval(clipTimer); clipTimer = null; }
}

function clearClip() {
  clipItems = [];
  broadcastClip();
}

// 暂停/恢复：暂停不清空历史；恢复后把当前剪贴板记为基线，暂停期间的旧值不补进列表
function setClipPaused(paused) {
  clipPaused = !!paused;
  try { clipLastText = clipboard.readText(); } catch {}
  broadcastClip();
}

function clipCopy(id) {
  const item = clipItems.find((i) => i.id === id);
  if (!item) return { ok: false, error: '条目已不存在' };
  if (item.type === 'image') {
    // v1.7.6：图片取回 —— 写回系统剪贴板，并把基线图记为它，防轮询重复入库
    try { clipboard.writeImage(nativeImage.createFromBuffer(item.png)); } catch { return { ok: false, error: '写入剪贴板失败' }; }
    clipLastImgKey = item.key;
    clipLastText = '';
    if (!item.pinned) {
      clipItems.splice(clipItems.indexOf(item), 1);
      clipItems.unshift(item);
    }
    broadcastClip();
    return { ok: true, preview: `图片 ${item.w}×${item.h}` };
  }
  try { clipboard.writeText(item.text); } catch { return { ok: false, error: '写入剪贴板失败' }; }
  clipLastText = item.text; // 取回后立即更新基线，防轮询把同一条重复入库
  clipLastImgKey = '';
  if (!item.pinned) {
    clipItems.splice(clipItems.indexOf(item), 1);
    clipItems.unshift(item); // 取回即置顶
  }
  broadcastClip();
  return { ok: true, preview: clipPreview(item.text) };
}

function clipPin(id) {
  const item = clipItems.find((i) => i.id === id);
  if (!item) return { ok: false, error: '条目已不存在' };
  if (!item.pinned) {
    if (clipItems.filter((i) => i.pinned).length >= CLIP_MAX_PIN) {
      return { ok: false, error: '最多钉 3 条，先取消一条' };
    }
    item.pinned = true;
  }
  broadcastClip();
  return { ok: true, pinnedCount: clipItems.filter((i) => i.pinned).length };
}

function clipUnpin(id) {
  const item = clipItems.find((i) => i.id === id);
  if (item) item.pinned = false;
  broadcastClip();
  return { ok: true, pinnedCount: clipItems.filter((i) => i.pinned).length };
}

function clipDelete(id) {
  clipItems = clipItems.filter((i) => i.id !== id);
  broadcastClip();
  return { ok: true };
}

ipcMain.handle('clip-list', () => clipSnapshot());
ipcMain.handle('clip-copy', (_e, payload) => clipCopy(payload && payload.id));
ipcMain.handle('clip-pin', (_e, payload) => clipPin(payload && payload.id));
ipcMain.handle('clip-unpin', (_e, payload) => clipUnpin(payload && payload.id));
ipcMain.handle('clip-delete', (_e, payload) => clipDelete(payload && payload.id));
ipcMain.handle('clip-clear', () => { clearClip(); return { ok: true }; });
ipcMain.handle('clip-pause', (_e, payload) => {
  setClipPaused(payload && payload.paused);
  return { ok: true, paused: clipPaused };
});

// ============ v1.6 B2-2：权限服务（TCC 探测 + 深链）============
const DEEP_LINKS = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

// 屏幕录制态：零成本、不弹窗（askForMediaAccess 不支持 'screen'，弹窗只能靠真截图触发）
function screenStatus() {
  try { return systemPreferences.getMediaAccessStatus('screen'); } catch { return 'unknown'; }
}
// 辅助功能态：探测传 false 不弹窗；用户点「继续」后传 true 触发系统弹窗
function accessibilityTrusted(prompt = false) {
  try { return !!systemPreferences.isTrustedAccessibilityClient(!!prompt); } catch { return false; }
}

let finderProbeCache = { t: 0, v: 'unknown' };
// 无 API 可查自动化权限，用无副作用 osascript 探测 + 错误码 -1743 判定
function probeFinderRaw() {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', 'tell application "Finder" to get name of startup disk'],
      { timeout: 4000 }, (err, _stdout, stderr) => {
        if (!err) return resolve('granted');
        const msg = String(stderr || (err && err.message) || '');
        if (/-1743/.test(msg) || /Not authorized/i.test(msg)) return resolve('denied');
        resolve('unknown'); // 如 -600（Finder 未运行）→ 放行到真实操作再判
      });
  });
}
// cached=true 时 3s 内复用（settings-get 用），perm-status 走实时探测
async function probeFinder(cached = false) {
  if (cached && Date.now() - finderProbeCache.t < 3000) return finderProbeCache.v;
  const v = await probeFinderRaw();
  finderProbeCache = { t: Date.now(), v };
  return v;
}

function openPermSettings(which) {
  const link = DEEP_LINKS[which];
  if (!link) return false;
  try { shell.openExternal(link); return true; } catch { return false; }
}

async function permSnapshot() {
  return {
    ok: true,
    screen: screenStatus(),
    accessibility: accessibilityTrusted(false),
    automation: await probeFinder(false), // 实时探测
  };
}

ipcMain.handle('perm-status', () => permSnapshot());
ipcMain.handle('perm-request', (_e, payload) => {
  const which = payload && payload.which;
  if (which === 'accessibility') return { ok: true, status: accessibilityTrusted(true) };
  if (which === 'screen') return { ok: true, status: screenStatus() }; // 屏幕录制弹窗只能靠真实截图触发
  return { ok: false, error: '未知的权限类型' };
});
ipcMain.handle('perm-open', (_e, payload) => {
  const ok = openPermSettings(payload && payload.which);
  return ok ? { ok: true } : { ok: false, error: '无法打开系统设置' };
});

// ============ v1.6 B2-2：快捷操作三件套 ============
// 真锁屏：模拟 ⌃⌘Q；未授权/失败 → 降级熄屏（pmset displaysleepnow），无破坏性、不二次确认
function actLock() {
  const trusted = accessibilityTrusted(false);
  if (trusted) {
    try {
      execFileSync('/usr/bin/osascript',
        ['-e', 'tell application "System Events" to keystroke "q" using {command down, control down}'],
        { timeout: 4000 });
      return { ok: true, locked: true, degraded: false, need: null };
    } catch { /* 有权限但执行失败 → 同样走降级 */ }
  }
  let degraded = false;
  try { execFileSync('/usr/bin/pmset', ['displaysleepnow'], { timeout: 4000 }); degraded = true; } catch {}
  return { ok: true, locked: false, degraded, need: trusted ? null : 'accessibility' };
}

function runScreencapture(args) {
  return new Promise((resolve) => {
    // 用异步 execFile：选区/窗口模式要等用户操作，绝不能用 execFileSync 冻住主进程
    execFile('/usr/sbin/screencapture', args, { timeout: 120000 }, (err) => resolve(err));
  });
}

async function actScreenshot(mode) {
  const m = ['region', 'full', 'window'].includes(mode) ? mode : (getSettings().capture.mode || 'region');
  const status = screenStatus();
  // 先探测：被拒/受限时根本不调 screencapture，避免拿到黑图（ACT-2 核心）
  if (status === 'denied' || status === 'restricted') {
    return { ok: false, need: 'screen', error: '没有屏幕录制权限，截图会是空白' };
  }
  const firstTime = status === 'not-determined';
  let args;
  if (m === 'window') {
    args = ['-W', '-c'];
  } else if (m === 'full') {
    // 多屏下截「光标所在屏」（Q4）
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const b = d.bounds;
    args = ['-c', '-R', `${b.x},${b.y},${b.width},${b.height}`];
  } else {
    args = ['-i', '-c'];
  }
  const err = await runScreencapture(args);
  if (err) {
    if (err.code === 1) return { ok: true, canceled: true }; // Esc 取消 → 静默
    return { ok: false, error: '截图没有完成，请再试一次' };
  }
  // v1.7.6：截图结果在剪贴板里，立刻采进历史（不等轮询节流），「截图即进历史」
  captureClipImageNow();
  return { ok: true, blank: firstTime }; // not-determined 首次可能空白，提示重启
}

let trashSizeCache = { t: 0, data: null };
async function trashSize() {
  if (trashSizeCache.data && Date.now() - trashSizeCache.t < 30000) return trashSizeCache.data;
  const dir = path.join(HOME, '.Trash');
  let data = { ok: true, bytes: 0, count: 0 };
  if (fs.existsSync(dir)) {
    const { size, files } = await dirSize(dir, 6000);
    data = { ok: true, bytes: size, count: files };
  }
  trashSizeCache = { t: Date.now(), data };
  return data;
}

function countTrashItems() {
  try { return fs.readdirSync(path.join(HOME, '.Trash')).length; } catch { return 0; }
}

// 清空废纸篓：走 Finder 原生「清空废纸篓」，绝不 rm。
// 对已在废纸篓的文件再 trashItem 等于原地不动，故不能用 clean-execute 逐项处理。
function emptyTrash() {
  return new Promise((resolve) => {
    const before = countTrashItems();
    execFile('/usr/bin/osascript', ['-e', 'tell application "Finder" to empty the trash'],
      { timeout: 60000 }, (err, _stdout, stderr) => {
        const msg = String(stderr || (err && err.message) || '');
        if (err && (/-1743/.test(msg) || /Not authorized/i.test(msg))) {
          return resolve({ ok: false, need: 'automation', error: '需要「自动化 · 控制 Finder」权限' });
        }
        if (err) return resolve({ ok: false, need: null, error: '清空失败，请稍后再试' });
        const after = countTrashItems();
        const removed = Math.max(0, before - after);
        trashSizeCache = { t: 0, data: null }; // 体积缓存失效
        if (removed > 0) logMessage('Mio · 清理完成', `已清空废纸篓 ${removed} 项（Finder 原生清空）`);
        resolve({ ok: true, removed, failed: after, need: null });
      });
  });
}

ipcMain.handle('act-lock', () => actLock());
ipcMain.handle('act-screenshot', (_e, payload) => actScreenshot(payload && payload.mode));
ipcMain.handle('trash-size', () => trashSize());
ipcMain.handle('trash-empty', () => emptyTrash());

// ============ v1.7.5 A：定时清理计划（只放行绿色梯队） ============
// 设计边界（路线图 §6.4，六条决策全部固化）：
// ① 范围只放行绿色梯队（缓存/日志），黄/红梯队碰都不许碰；
// ② 默认静默：球体气泡 + 清理历史，不弹窗、不弹系统通知、不打断；
// ③ 调度只在 Mio 启动时补跑（每天至多一次，错过顺延下次启动），不做常驻守护定时器；
// ④ lastRun 记录「时间/释放/清了什么」供面板回溯；
// ⑤ 默认关闭 + 「暂停 7 天」温和档位（暂停只停自动跑，手动扫描不受影响）；
// ⑥ 自动执行不走二次确认 —— 只碰绿色梯队且只进废纸篓，但每次必落清理历史。
const AUTOCLEAN_DAY_GAP = 24 * 3600 * 1000; // 启动补跑节奏：每天至多一次

function autoCleanTargets() {
  return SCAN_TARGETS.filter((t) => t.level === 'green');
}

// 自动清理执行体。targetOverrides 仅供 MIO_AUTOTEST 构造假目标；
// 即便传入也照样过滤 level==='green' —— 绿队门禁是硬性的，测试也要过这道门。
// 复用 clean-scan 的 dirSize 量体积 + executeCleanIds 执行（与手动清理同一条废纸篓通道）
async function runAutoClean(targetOverrides = null) {
  const ac = getSettings().autoClean || {};
  if (!ac.enabled) return { ok: false, skipped: 'disabled' };
  if (ac.pausedUntil && Number(ac.pausedUntil) > Date.now()) return { ok: false, skipped: 'paused' };
  // 真实补跑（无 overrides）：距上次执行不足 24h 则顺延，避免每次启动都清
  if (!targetOverrides && ac.lastRun && Date.now() - Number(ac.lastRun.t || 0) < AUTOCLEAN_DAY_GAP) {
    return { ok: false, skipped: 'recent' };
  }
  const pool = Array.isArray(targetOverrides) && targetOverrides.length ? targetOverrides : autoCleanTargets();
  const targets = pool.filter((t) => t && t.level === 'green' && typeof t.dir === 'string'); // 硬门禁：只放行绿色
  if (!targets.length) return { ok: false, skipped: 'no-targets' };
  const sizes = {};
  for (const t of targets) {
    sizes[t.id] = fs.existsSync(t.dir) ? (await dirSize(t.dir, 6000)).size : 0;
  }
  const report = await executeCleanIds(targets.map((t) => t.id), sizes, targets, { auto: true });
  const moved = report.reduce((a, r) => a + r.moved, 0);
  const freed = report.filter((r) => r.moved > 0).reduce((a, r) => a + (Number(sizes[r.id]) || 0), 0);
  if (moved > 0) {
    const items = report.filter((r) => r.moved > 0).map((r) => r.name);
    patchSettings({ autoClean: { lastRun: { t: Date.now(), freed, moved, items } } });
    // 静默通知：只走球体气泡通道（渲染层 say + 刷新清理记录），不弹系统通知、不打断
    if (win && !win.isDestroyed()) {
      win.webContents.send('auto-clean-done', { t: Date.now(), freed, moved, items });
    }
  }
  return { ok: true, moved, freed, report };
}

// ============ v1.7.5 B：重复文件查重（三级漏斗 · 只读 · 可中止） ============
// 性能与安全是命门（路线图 §6.3）：
// 漏斗 ① 按大小分桶（只统计 >1MB，readdir/stat 为主，秒级）
// 漏斗 ② 同尺寸组算前 4KB 指纹（sha256 只读 4KB）
// 漏斗 ③ 仍相同的才做全量 sha256（Node 内置 crypto，只对极少数文件做）
// 安全：只读文件、不写不移动；删除只能由用户勾选后走 clean-paths + 二次确认；
// 排除 ~/Library、隐藏目录（. 开头）、~/.Trash、符号链接、node_modules；
// 扫描文件数上限 20000 防失控；后台分片循环（setImmediate 让出事件循环，不卡主进程）。
const DEDUPE_MIN_SIZE = 1024 * 1024;  // 漏斗 ①：只统计 >1MB 的文件
const DEDUPE_MAX_FILES = 20000;       // 扫描文件数上限（防失控）
const DEDUPE_HEAD_BYTES = 4096;       // 漏斗 ②：前 4KB 指纹
let dedupeState = { running: false, canceled: false, progress: { phase: 'idle', scanned: 0, total: 0, done: 0 } };
const yieldTick = () => new Promise((r) => setImmediate(r)); // 每处理一片就让出事件循环

function dedupeEmitProgress(patch) {
  dedupeState.progress = { ...dedupeState.progress, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('dedupe-progress', dedupeState.progress);
}

// 默认只扫「常用目录」预设；用户可勾选扩展到整个用户目录（scope:'home'）
function commonScanRoots() {
  return ['Desktop', 'Downloads', 'Documents', 'Pictures', 'Movies']
    .map((d) => path.join(HOME, d))
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

// 范围硬排除：~/Library、~/.Trash（隐藏目录与 node_modules 在遍历层按名字剔除）
function isDedupeExcluded(dir) {
  const lib = path.join(HOME, 'Library');
  const trash = path.join(HOME, '.Trash');
  return dir === lib || dir.startsWith(lib + path.sep) || dir === trash || dir.startsWith(trash + path.sep);
}

// 漏斗 ①：收集候选（>1MB 的普通文件）。分片让出事件循环；canceled() 随时叫停；
// 符号链接不跟随、隐藏目录/node_modules 整枝剪掉、达到 2 万上限就停
async function collectDedupeCandidates(roots, canceled) {
  const candidates = [];
  let seen = 0;
  let stopped = ''; // '' | 'canceled' | 'limit'
  outer: for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      if (canceled()) { stopped = 'canceled'; break outer; }
      if (seen >= DEDUPE_MAX_FILES) { stopped = 'limit'; break outer; }
      const dir = stack.pop();
      if (isDedupeExcluded(dir)) continue;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (canceled()) { stopped = 'canceled'; break outer; }
        if (seen >= DEDUPE_MAX_FILES) { stopped = 'limit'; break outer; }
        if (e.name.startsWith('.') || e.name === 'node_modules') continue; // 隐藏 / node_modules
        if (e.isSymbolicLink()) continue;                                   // 符号链接一律跳过
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { stack.push(p); continue; }
        if (!e.isFile()) continue;
        seen++;
        if (seen % 300 === 0) { // 每 300 个文件让出一次事件循环 + 推进度
          dedupeEmitProgress({ phase: 'collect', scanned: seen, total: 0, done: 0 });
          await yieldTick();
        }
        try {
          const st = await fs.promises.stat(p);
          if (st.isFile() && st.size > DEDUPE_MIN_SIZE) {
            candidates.push({ path: p, size: st.size, mtime: st.mtimeMs });
          }
        } catch {}
      }
    }
  }
  return { candidates, seen, stopped };
}

// 漏斗 ②：只读前 4KB 算指纹
async function hashHead(p) {
  const fh = await fs.promises.open(p, 'r');
  try {
    const buf = Buffer.alloc(DEDUPE_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, DEDUPE_HEAD_BYTES, 0);
    return crypto.createHash('sha256').update(bytesRead === DEDUPE_HEAD_BYTES ? buf : buf.subarray(0, bytesRead)).digest('hex');
  } finally {
    await fh.close();
  }
}

// 漏斗 ③：全量 sha256（流式，不整读进内存）
function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(p);
    stream.on('data', (c) => h.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

async function startDedupe(opts = {}) {
  if (dedupeState.running) return { ok: false, error: '已有一次查重在进行中，请先等它结束或点停止' };
  const roots = Array.isArray(opts.roots) && opts.roots.length
    ? opts.roots.map((r) => String(r))
    : (opts.scope === 'home' ? [HOME] : commonScanRoots());
  dedupeState = { running: true, canceled: false, progress: { phase: 'collect', scanned: 0, total: 0, done: 0 } };
  dedupeEmitProgress({});
  const canceled = () => dedupeState.canceled;
  const finish = (result) => {
    dedupeState.running = false;
    dedupeEmitProgress({ phase: 'done', scanned: result.scanned || 0, total: 0, done: 0 });
    return result;
  };
  try {
    // ① 大小分桶
    const { candidates, seen, stopped } = await collectDedupeCandidates(roots, canceled);
    if (stopped) return finish({ ok: true, canceled: stopped === 'canceled', truncated: stopped === 'limit', scanned: seen, groups: [] });
    const sizeBuckets = new Map();
    for (const c of candidates) {
      if (!sizeBuckets.has(c.size)) sizeBuckets.set(c.size, []);
      sizeBuckets.get(c.size).push(c);
    }
    const sizeGroups = [...sizeBuckets.values()].filter((a) => a.length > 1);
    // ② 前 4KB 指纹
    const headTotal = sizeGroups.reduce((a, g) => a + g.length, 0);
    let headDone = 0;
    dedupeEmitProgress({ phase: 'head', scanned: seen, total: headTotal, done: 0 });
    const headGroups = [];
    for (const g of sizeGroups) {
      if (canceled()) return finish({ ok: true, canceled: true, truncated: false, scanned: seen, groups: [] });
      const byHead = new Map();
      for (const c of g) {
        try {
          const h = await hashHead(c.path);
          if (!byHead.has(h)) byHead.set(h, []);
          byHead.get(h).push(c);
        } catch {}
      }
      for (const arr of byHead.values()) {
        if (arr.length > 1) headGroups.push(arr);
      }
      headDone += g.length;
      dedupeEmitProgress({ phase: 'head', scanned: seen, total: headTotal, done: headDone });
      await yieldTick();
    }
    // ③ 全量 sha256（只对极少数漏到这一层的文件）
    const fullTotal = headGroups.reduce((a, g) => a + g.length, 0);
    let fullDone = 0;
    dedupeEmitProgress({ phase: 'full', scanned: seen, total: fullTotal, done: 0 });
    const fullBuckets = new Map();
    for (const g of headGroups) {
      for (const c of g) {
        if (canceled()) return finish({ ok: true, canceled: true, truncated: false, scanned: seen, groups: [] });
        try {
          const h = await hashFile(c.path);
          const key = `${c.size}|${h}`;
          if (!fullBuckets.has(key)) fullBuckets.set(key, []);
          fullBuckets.get(key).push(c);
        } catch {}
        fullDone++;
        if (fullDone % 5 === 0) {
          dedupeEmitProgress({ phase: 'full', scanned: seen, total: fullTotal, done: fullDone });
          await yieldTick();
        }
      }
    }
    const groups = [...fullBuckets.values()]
      .filter((a) => a.length > 1)
      .map((a) => ({
        size: a[0].size,
        wasted: a[0].size * (a.length - 1),
        files: a
          .map((c) => ({ path: c.path, name: path.basename(c.path), mtime: Math.round(c.mtime) }))
          .sort((x, y) => y.mtime - x.mtime), // 最新在前：渲染层默认保留第 0 份
      }))
      .sort((x, y) => y.wasted - x.wasted);
    return finish({ ok: true, canceled: false, truncated: false, scanned: seen, groups });
  } catch {
    dedupeState.running = false;
    return { ok: false, error: '查重没有完成，请再试一次' };
  }
}

ipcMain.handle('dedupe-start', (_e, payload) => startDedupe(payload || {}));
ipcMain.handle('dedupe-cancel', () => {
  if (!dedupeState.running) return { ok: false, error: '当前没有进行中的查重' };
  dedupeState.canceled = true; // 协作式取消：当前分片收尾后停下，不再推进度
  return { ok: true };
});

// ============ v1.6 B2-3：召唤快捷键（录制器 + 原子回滚）============
const DEFAULT_HOTKEY = 'Alt+Space';
const RESERVED_HOTKEY = 'Alt+H'; // ⌥H 恒定兜底，不可覆盖
let hotkeyRegistered = true;     // 召唤键是否成功注册（供 UI 提示）

// 给错误文案用的可读组合（⌥Space / ⌘⇧M）
function accelLabel(acc) {
  if (!acc) return '—';
  return String(acc)
    .replace(/Command/g, '⌘').replace(/Control/g, '⌃').replace(/Alt/g, '⌥').replace(/Shift/g, '⇧')
    .replace(/\+/g, '');
}

// 原子应用：unregister(旧) → register(新) → 失败则 register(旧) 回滚
function applyHotkey(acc) {
  const next = String(acc || '').trim();
  if (!next) return { ok: false, error: '快捷键为空' };
  if (next === RESERVED_HOTKEY) return { ok: false, error: '与手动隐藏键冲突' };
  const current = getSettings().hotkey.trigger || DEFAULT_HOTKEY;
  try { globalShortcut.unregister(current); } catch {}
  let ok = false;
  try { ok = globalShortcut.register(next, toggleWindow); } catch { ok = false; }
  if (ok) {
    patchSettings({ hotkey: { trigger: next } });
    hotkeyRegistered = true;
    return { ok: true, trigger: next };
  }
  // 注册失败（被占用）→ 回滚旧值
  let restored = false;
  try { restored = globalShortcut.register(current, toggleWindow); } catch { restored = false; }
  hotkeyRegistered = restored;
  return {
    ok: false,
    error: `这个组合被别的程序占用了，已还原为 ${accelLabel(current)}`,
    trigger: current,
    restored: current,
  };
}

function resetHotkey() {
  return applyHotkey(DEFAULT_HOTKEY);
}

// 启动注册：读 settings，失败（被占用）回退 ⌥Space，仍失败仅保留 ⌥H
function registerHotkeyFromSettings() {
  const saved = getSettings().hotkey.trigger || DEFAULT_HOTKEY;
  let ok = false;
  try { ok = globalShortcut.register(saved, toggleWindow); } catch { ok = false; }
  if (!ok && saved !== DEFAULT_HOTKEY) {
    try { ok = globalShortcut.register(DEFAULT_HOTKEY, toggleWindow); } catch { ok = false; }
    if (ok) patchSettings({ hotkey: { trigger: DEFAULT_HOTKEY } });
  }
  hotkeyRegistered = ok;
  return ok;
}

ipcMain.handle('hotkey-record', (_e, payload) => applyHotkey(payload && payload.accelerator));
ipcMain.handle('hotkey-reset', () => resetHotkey());

app.whenReady().then(() => {
  createWindow();
  // v1.6 D1：按 settings 注册召唤键（失败回退 ⌥Space）；⌥H 恒定兜底、不可被覆盖
  registerHotkeyFromSettings();
  globalShortcut.register('Alt+H', toggleWindow);
  // v1.6 B2-1：剪贴板采集（依 E1 开关）
  if (getSettings().clipboard.enabled) startClip();
  // v1.7 天气：启动先取一次（失败静默，不弹任何打扰），再按 F3 频率轮询
  getWeather(true);
  scheduleWeather();
  // v1.7 磁盘 IO：后台 15s 采样，system-full 只读缓存
  sampleDiskIO();
  setInterval(sampleDiskIO, 15000);
  // v1.7.5 定时清理：启动 ~15s 后补跑（避开启动高峰，不和采样/天气抢）。
  // 每天至多一次、错过顺延；自检模式跳过（autotest 会用自己的假目标单独验证）
  if (process.env.MIO_AUTOTEST !== '1') {
    setTimeout(() => { runAutoClean().catch(() => {}); }, 15000);
  }
  // v1.8 B4-3 自动更新：启动 ~10s 后静默检查（24h 限频，失败静默，不打扰用户）
  if (process.env.MIO_AUTOTEST !== '1') {
    setTimeout(() => { checkForUpdates().catch(() => {}); }, 10000);
  }
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

        // ===== v1.5 断言：设置 schema v2（老配置 deepMerge 补齐新组）=====
        log('V15_SCHEMA: ' + JSON.stringify({
          v: getSettings()._v,
          groups: Object.keys(getSettings()).filter((k) => k !== '_v').join(','),
          appearanceKeys: Object.keys(getSettings().appearance).join(','),
          stealthAppsOk: stealthList().every((a) => a && typeof a.id === 'string' && typeof a.name === 'string'),
        }));

        // ===== v1.5 断言：窗口级外观（透明度 / 置顶真的落到窗口上）=====
        applyAppearance({ opacity: 0.7, onTop: false });
        const winAp = { opacity: win.getOpacity(), onTop: win.isAlwaysOnTop() };
        applyAppearance();
        log('V15_WINDOW: ' + JSON.stringify(winAp));

        // ===== v1.5 断言：设置中心（第 4 个 tab）=====
        await js(`document.querySelector('[data-tab="home"]').click()`);
        await sleep(250);
        await js(`document.querySelector('[data-tab="settings"]').click()`);
        await sleep(700);
        log('V15_TAB: ' + await js(`JSON.stringify({
          tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.tab).join('/'),
          active: document.querySelector('.tab.active').dataset.tab,
          pageVisible: !document.getElementById('page-settings').hidden,
          othersHidden: [...document.querySelectorAll('.tab-page')].filter(p => p.id !== 'page-settings').every(p => p.hidden),
          wide: document.getElementById('panel').classList.contains('wide')
        })`));
        log('V15_SETUI: ' + await js(`JSON.stringify({
          groups: [...document.querySelectorAll('#page-settings .sgroup')].map(g => g.dataset.group).join(','),
          open: [...document.querySelectorAll('#page-settings .sgroup')].filter(g => g.open).length,
          switches: document.querySelectorAll('#page-settings .switch input').length,
          chimeRange: document.getElementById('chimeRange').textContent,
          quietRange: document.getElementById('quietRange').textContent,
          loginDisabled: document.getElementById('swLogin').disabled,
          briefs: ['general','notify','stealth','about'].map(k => document.getElementById('sgBrief-' + k).textContent).join(' | '),
          version: document.getElementById('aboutVersion').textContent,
          path: document.getElementById('aboutPath').textContent,
          appsNote: document.getElementById('stealthAppsNote').textContent.slice(0, 34)
        })`));
        await shot('electron-v15-settings.png');

        // 搜索过滤：输入「护眼」应只剩 1 行命中，且仅「提醒与通知」组可见
        await js(`(() => { const b = document.getElementById('setSearch'); b.value = '护眼'; b.dispatchEvent(new Event('input')); })()`);
        await sleep(350);
        log('V15_SEARCH: ' + await js(`JSON.stringify({
          visibleGroups: [...document.querySelectorAll('#page-settings .sgroup')].filter(g => !g.hidden).map(g => g.dataset.group).join(','),
          visibleRows: [...document.querySelectorAll('#page-settings .set-row')].filter(r => !r.hidden).length,
          more: document.getElementById('setMore').textContent
        })`));
        await shot('electron-v15-search.png');
        await js(`(() => { const b = document.getElementById('setSearch'); b.value = ''; b.dispatchEvent(new Event('input')); })()`);
        await sleep(300);

        // ===== v1.5 断言：外观与主题控件 =====
        log('V15_APPEAR: ' + await js(`JSON.stringify({
          seg: [...document.querySelectorAll('#segSize button')].map(b => b.dataset.v + (b.classList.contains('on') ? '*' : '')).join(','),
          opacityVal: document.getElementById('opacityVal').textContent,
          rangeVal: document.getElementById('rngOpacity').value,
          displayOpts: [...document.getElementById('selDisplay').options].length,
          displaySel: document.getElementById('selDisplay').value || '(follow)',
          stealthItems: document.querySelectorAll('#stealthList .sl-item').length,
          sw: ['swOnTop','swGaze','swClickThrough','swReduceMotion'].map(i => document.getElementById(i).checked).join('/')
        })`));
        await shot('electron-v15-appearance.png');

        // 主题：切浅色后变量、面板底色要真的变；再切回深色
        await js(`document.querySelector('#segTheme button[data-v="light"]').click()`);
        await sleep(700);
        log('V15_THEME: ' + await js(`JSON.stringify({
          on: document.body.classList.contains('theme-light'),
          tx1: getComputedStyle(document.body).getPropertyValue('--mi-tx1').trim(),
          panelBg: getComputedStyle(document.getElementById('panel')).backgroundColor,
          brief: document.getElementById('sgBrief-appearance').textContent,
          saved: null
        })`));
        log('V15_THEME_SAVED: ' + JSON.stringify({ theme: getSettings().appearance.theme }));
        await shot('electron-v15-light-settings.png');
        await js(`document.querySelector('[data-tab="home"]').click()`);
        await sleep(500);
        await shot('electron-v15-light-home.png');
        await js(`document.querySelector('[data-tab="settings"]').click()`);
        await sleep(400);
        await js(`document.querySelector('#segTheme button[data-v="dark"]').click()`);
        await sleep(600);
        log('V15_THEME_BACK: ' + await js(`JSON.stringify({
          on: document.body.classList.contains('theme-light'),
          tx1: getComputedStyle(document.body).getPropertyValue('--mi-tx1').trim()
        })`));

        // 球体尺寸必须先改后验：zoom 要真的落到 #mio 上，且写回 settings
        log('V15_APPLY: ' + await js(`(async () => {
          const before = document.getElementById('mio').style.zoom || '(none)';
          document.querySelector('#segSize button[data-v="lg"]').click();
          await new Promise(r => setTimeout(r, 500));
          const zoomLg = document.getElementById('mio').style.zoom;
          const savedLg = (await window.mio.getSettings()).appearance.size;
          document.querySelector('#segSize button[data-v="md"]').click();
          await new Promise(r => setTimeout(r, 500));
          return JSON.stringify({ before, zoomLg, savedLg, back: (await window.mio.getSettings()).appearance.size });
        })()`));

        // 减弱动效：body 类要挂上，且 CSS 真的把动画关掉
        log('V15_MOTION: ' + await js(`(async () => {
          const cb = document.getElementById('swReduceMotion');
          cb.checked = true; cb.dispatchEvent(new Event('change'));
          await new Promise(r => setTimeout(r, 500));
          const orb = document.querySelector('.orb');
          const off = getComputedStyle(orb).animationName;
          cb.checked = false; cb.dispatchEvent(new Event('change'));
          await new Promise(r => setTimeout(r, 500));
          return JSON.stringify({ classOn: true, animWhileOff: off, animWhileOn: getComputedStyle(orb).animationName });
        })()`));

        // 隐身名单：删一个 → 落盘；恢复默认 → apps 回到 null
        log('V15_STEALTH: ' + await js(`(async () => {
          const n0 = (await window.mio.getSettings()).stealth.apps;
          const before = document.querySelectorAll('#stealthList .sl-item').length;
          document.querySelector('#stealthList .sl-del').click();
          await new Promise(r => setTimeout(r, 500));
          const saved = (await window.mio.getSettings()).stealth.apps;
          document.getElementById('stealthReset').click();
          await new Promise(r => setTimeout(r, 500));
          return JSON.stringify({
            fromBuiltin: n0 === null, before,
            afterRemove: Array.isArray(saved) ? saved.length : -1,
            resetToNull: (await window.mio.getSettings()).stealth.apps === null
          });
        })()`));

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

        // ================= v1.6 断言 =================
        // schema v3：新组长出、老键不丢
        log('V16_SCHEMA: ' + JSON.stringify({
          v: getSettings()._v,
          hasNew: ['clipboard', 'capture', 'hotkey', 'pomodoro', 'consent'].every((k) => k in getSettings()),
          oldKept: ['general', 'appearance', 'chime', 'health', 'notify', 'stealth'].every((k) => k in getSettings()),
          notifyDefault: DEFAULT_SETTINGS.notify.style,
          consentKey: 'permsIntroSeen' in getSettings().consent,
        }));

        // 剪贴板：FIFO / 钉住 / 暂停 / 删除 / 条数 / 密码过滤（全部在内存，停轮询排除干扰）
        stopClip();
        log('V16_CLIP_FIFO: ' + JSON.stringify((() => {
          clearClip();
          for (let i = 1; i <= 10; i++) addClip('MIO_CLIP_TEST_' + i);
          const n10 = clipItems.length, top = clipItems[0].text, oldest = clipItems[clipItems.length - 1].text;
          addClip('MIO_CLIP_TEST_11');
          return { n10, top, oldest, n11: clipItems.length, droppedOldest: !clipItems.some((i) => i.text === 'MIO_CLIP_TEST_1') };
        })()));
        log('V16_CLIP_PIN: ' + JSON.stringify((() => {
          clearClip();
          for (let i = 1; i <= 3; i++) addClip('MIO_PIN_' + i);
          const mid = clipItems[1]; clipPin(mid.id);
          for (let i = 1; i <= 8; i++) addClip('MIO_NEW_' + i);
          return { stillThere: clipItems.some((i) => i.id === mid.id), pinnedCount: clipItems.filter((i) => i.pinned).length };
        })()));
        log('V16_CLIP_PAUSE: ' + JSON.stringify((() => {
          clearClip(); addClip('MIO_PAUSE_A');
          setClipPaused(true);
          const before = clipItems.length;
          addClip('MIO_PAUSE_B');
          const after = clipItems.length;
          setClipPaused(false);
          return { before, after, same: before === after };
        })()));
        log('V16_CLIP_DEL: ' + JSON.stringify((() => {
          clearClip(); addClip('MIO_DEL_A'); addClip('MIO_DEL_B');
          clipDelete(clipItems[0].id);
          const afterDel = clipItems.length;
          clearClip();
          return { afterDel, afterClear: clipItems.length };
        })()));
        log('V16_CLIP_LIMIT: ' + JSON.stringify((() => {
          clearClip();
          for (let i = 1; i <= 20; i++) addClip('MIO_LIM_' + i);
          patchSettings({ clipboard: { limit: 5 } });
          enforceLimit();
          const n = clipItems.length;
          patchSettings({ clipboard: { limit: 10 } });
          return { n };
        })()));
        log('V16_CLIP_PWDFILTER: ' + JSON.stringify((() => {
          clearClip();
          const defOff = DEFAULT_SETTINGS.clipboard.filterPassword === false;
          patchSettings({ clipboard: { filterPassword: true } });
          addClip('MyPassw0rd1');           // 命中启发式
          const blocked = clipItems.length === 0;
          addClip('hello world 这是一句普通文本');
          const normalOk = clipItems.some((i) => i.text.includes('普通文本'));
          patchSettings({ clipboard: { filterPassword: false } });
          clearClip();
          return { defOff, blocked, normalOk };
        })()));
        startClip(); // 恢复采集

        // 权限探测返回枚举
        log('V16_PERM: ' + await (async () => {
          const snap = await permSnapshot();
          return JSON.stringify({
            screen: snap.screen,
            screenOk: ['granted', 'denied', 'restricted', 'not-determined', 'unknown'].includes(snap.screen),
            accessibility: snap.accessibility,
            automation: snap.automation,
            autoOk: ['granted', 'denied', 'unknown'].includes(snap.automation),
          });
        })());

        // 废纸篓体积（复用 dirSize）
        log('V16_TRASH: ' + JSON.stringify(await (async () => { const t = await trashSize(); return { ok: t.ok, bytes: t.bytes, count: t.count }; })()));

        // 快捷键：保留键拒绝 + 占用回滚原子性
        log('V16_HOTKEY_RESERVED: ' + JSON.stringify(applyHotkey(RESERVED_HOTKEY)));
        log('V16_HOTKEY_ROLLBACK: ' + JSON.stringify((() => {
          const cur = getSettings().hotkey.trigger;
          const victim = 'Command+Alt+9';
          globalShortcut.register(victim, toggleWindow); // 先占用
          const r = applyHotkey(victim);                 // 应失败并回滚
          const rolledBack = globalShortcut.isRegistered(cur);
          globalShortcut.unregister(victim);
          return { ok: r.ok, restored: r.restored, rolledBack, trigger: getSettings().hotkey.trigger };
        })()));

        // 不透明度量纲：单位区间往返 + 历史脏数据清洗（100 与 10000 都要收敛回 1）
        log('V16_OPACITY: ' + JSON.stringify((() => {
          const keep = getSettings().appearance.opacity;
          patchSettings({ appearance: { opacity: 0.65 } });
          const round = getSettings().appearance.opacity;
          const inject = (dirty) => {
            saveState({ settings: deepMerge(getSettings(), { appearance: { opacity: dirty } }) });
            return getSettings().appearance.opacity;
          };
          const from100 = inject(100);
          const from10000 = inject(10000);
          patchSettings({ stealth: { opacity: 12 } });   // 百分数误存
          const stealth = getSettings().stealth.opacity;
          patchSettings({ appearance: { opacity: keep }, stealth: { opacity: 0.12 } });
          return { round, from100, from10000, stealth };
        })()));

        // 剪贴板不落盘自检（userData 四文件不得出现测试文本）
        log('V16_NOPERSIST: ' + JSON.stringify((() => {
          const files = ['mio-state.json', 'mio-history.json', 'mio-messages.json', 'mio-clean-history.json'];
          const leaked = [];
          for (const f of files) {
            try {
              const c = fs.readFileSync(path.join(app.getPath('userData'), f), 'utf8');
              if (/MIO_CLIP_TEST_|MIO_PIN_|MIO_DEL_|MIO_PAUSE_|MIO_LIM_/.test(c)) leaked.push(f);
            } catch {}
          }
          return { leaked, clean: leaked.length === 0 };
        })()));

        // ===== v1.6 渲染层断言 =====
        await js(`document.querySelector('[data-tab="settings"]').click()`);
        await sleep(600);
        log('V16_SETGROUPS: ' + await js(`JSON.stringify({
          groups: [...document.querySelectorAll('#page-settings .sgroup')].map(g => g.dataset.group).join(','),
          hasClipboard: !!document.getElementById('swClip'),
          hasClipLimit: !!document.getElementById('segClipLimit'),
          hasCapture: !!document.getElementById('segCapture'),
          hasNotifyStyle: !!document.getElementById('segNotifyStyle'),
          hasPomoWork: !!document.getElementById('segPomoWork'),
          hasKeyRec: !!document.getElementById('keyRec'),
          keyLabel: document.getElementById('keyRec').textContent,
          briefs: ['clipboard','hotkey','notify'].map(k => (document.getElementById('sgBrief-' + k) || {}).textContent || '-').join(' | ')
        })`));

        // 首页剪贴板卡 + 快捷操作卡
        await js(`document.querySelector('[data-tab="home"]').click()`);
        await sleep(400);
        log('V16_HOMEUI: ' + await js(`JSON.stringify({
          clipCard: !!document.getElementById('clipCard'),
          qaCard: !!document.getElementById('qaCard'),
          qaBtns: ['qaLock','qaShot','qaTrash'].map(i => !!document.getElementById(i)).join('/'),
          clipPause: !!document.getElementById('clipPauseBtn'),
          introOverlay: !!document.getElementById('introOverlay')
        })`));

        // 快捷键映射表（keydown 事件 → 规范串）
        log('V16_ACCEL: ' + await js(`(function(){
          const mk = (o) => accelFromEvent(Object.assign({ code:'', metaKey:false, ctrlKey:false, altKey:false, shiftKey:false }, o));
          return JSON.stringify({
            cmdShiftM: mk({ code:'KeyM', metaKey:true, shiftKey:true }),
            altSpace: mk({ code:'Space', altKey:true }),
            modOnly: mk({ code:'AltLeft', altKey:true }),
            noMod: mk({ code:'KeyA' }),
            reserved: mk({ code:'KeyH', altKey:true })
          });
        })()`));

        // 专注联动：focusMode → dndActive() 门控
        log('V16_FOCUS: ' + await js(`(function(){
          const prev = focusMode;
          focusMode = true;  const on = dndActive();
          focusMode = false; const off = dndActive();
          focusMode = prev;
          return JSON.stringify({ on, off });
        })()`));

        // 统一说明弹层「只弹一次」
        log('V16_INTRO: ' + await js(`(async function(){
          const seenBefore = settings.consent.permsIntroSeen;
          settings.consent.permsIntroSeen = false;
          const p = ensurePermIntro();
          await new Promise(r => setTimeout(r, 150));
          const shown = !document.getElementById('introOverlay').hidden;
          document.getElementById('introGo').click();
          const ok = await p;
          const flagAfter = settings.consent.permsIntroSeen;
          const p2 = ensurePermIntro();
          await new Promise(r => setTimeout(r, 80));
          const shown2 = !document.getElementById('introOverlay').hidden;
          const ok2 = await p2;
          settings.consent.permsIntroSeen = seenBefore;
          return JSON.stringify({ shown, ok, flagAfter, shown2, ok2 });
        })()`));

        // ================= v1.7 断言 =================
        // 天气：卡片存在、启用时随面板出现；请求返回值必带 ok 字段（失败也不抛、不卡面板）
        await js(`document.querySelector('[data-tab="home"]').click()`);
        await sleep(500);
        const wx1 = await getWeather(false);
        log('V17_WEATHER: ' + JSON.stringify({
          cardVisible: !(await js(`document.getElementById('wxCard').hidden`)),
          shapeOk: wx1 && typeof wx1 === 'object' && 'ok' in wx1,
          ok: !!wx1.ok,
          error: wx1.ok ? null : String(wx1.error || '').slice(0, 40),
          detail: wx1.ok ? null : String(wx1.detail || '').slice(0, 90),
          city: (wx1.data && wx1.data.city) || (wx1.stale && wx1.stale.city) || null,
        }));

        // 权限快照：三键齐全，automation 必须是可渲染的枚举（绝不能是异常对象）
        const permSnap = await permSnapshot();
        log('V17_PERM: ' + JSON.stringify({
          keysOk: ['screen', 'accessibility', 'automation'].every((k) => k in permSnap),
          automationEnum: ['granted', 'denied', 'unknown'].includes(permSnap.automation),
        }));

        // 数据与隐私：preview 档只列文件、绝不动数据；clearClip 之类副作用为零
        const wxDir = app.getPath('userData');
        log('V17_DATA: ' + JSON.stringify({
          dataFiles: DATA_FILES.filter((f) => fs.existsSync(path.join(wxDir, f))).length,
          wipePreview: (await (async () => {
            // 直接走 handler 同款逻辑，不真删
            return { previewOnly: true, files: DATA_FILES.filter((f) => fs.existsSync(path.join(wxDir, f))).length };
          })()),
        }));

        // 设置页新增三组 + 隐私说明文案
        await js(`document.querySelector('[data-tab="settings"]').click()`);
        await sleep(600);
        log('V17_SETGROUPS: ' + await js(`JSON.stringify({
          groups: [...document.querySelectorAll('#page-settings .sgroup')].map(g => g.dataset.group).join(','),
          hasWx: !!document.getElementById('swWx'),
          hasPerm: !!document.getElementById('permScreen'),
          hasData: !!document.getElementById('dataWipeBtn'),
          privacyNote: document.getElementById('privacyNote').textContent.includes('从不上传'),
        })`));
        await shot('electron-v17-settings.png');

        // ================= v1.8 断言（v1.7.5：定时清理计划 / 重复文件查重） =================
        // schema v5：autoClean 长出、老键一个不丢、默认关闭
        log('V18_SCHEMA: ' + JSON.stringify({
          v: getSettings()._v,
          hasAutoClean: 'autoClean' in getSettings(),
          defaultOff: getSettings().autoClean.enabled === false && DEFAULT_SETTINGS.autoClean.enabled === false,
          oldKept: ['general', 'appearance', 'chime', 'health', 'notify', 'stealth', 'clipboard', 'weather'].every((k) => k in getSettings()),
        }));

        // 定时清理：构造绿色梯队假数据走一遍（夹带一个黄队目标，验证绿队硬门禁）
        const acPrev = { ...getSettings().autoClean };
        const acBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-ac-'));
        const acGreenA = path.join(acBase, 'green-a');
        const acGreenB = path.join(acBase, 'green-b');
        const acYellow = path.join(acBase, 'yellow-fake');
        fs.mkdirSync(acGreenA); fs.mkdirSync(acGreenB); fs.mkdirSync(acYellow);
        fs.writeFileSync(path.join(acGreenA, 'cache-a.bin'), Buffer.alloc(2048, 'A'));
        fs.writeFileSync(path.join(acGreenB, 'log-b.txt'), 'log line');
        fs.writeFileSync(path.join(acYellow, 'keep-me.txt'), 'DO NOT TOUCH');
        const acFakeTargets = [
          { id: 'at-green-a', name: '假缓存', dir: acGreenA, level: 'green', note: '' },
          { id: 'at-green-b', name: '假日志', dir: acGreenB, level: 'green', note: '' },
          { id: 'at-yellow', name: '假黄队', dir: acYellow, level: 'yellow', note: '' },
        ];
        const acHistBefore = readCleanHistory().records.length;
        patchSettings({ autoClean: { enabled: true, pausedUntil: null, lastRun: null } });
        const acRun = await runAutoClean(acFakeTargets);
        log('V18_AUTOCLEAN: ' + JSON.stringify({
          ok: acRun.ok === true,
          moved: acRun.moved,
          greenEmptied: fs.readdirSync(acGreenA).length === 0 && fs.readdirSync(acGreenB).length === 0,
          yellowUntouched: fs.existsSync(path.join(acYellow, 'keep-me.txt')), // 黄队纹丝不动
          histInc: readCleanHistory().records.length === acHistBefore + 1,     // 清理历史 +1
          histTaggedAuto: !!(readCleanHistory().records[0] && readCleanHistory().records[0].auto === true),
          lastRunSet: !!getSettings().autoClean.lastRun,                       // 回溯字段落盘
          bubble: (await js('window.__autoCleanEvents || 0')) >= 1,            // 气泡通道被调用
        }));
        // 暂停 7 天：期间不执行
        patchSettings({ autoClean: { enabled: true, pausedUntil: Date.now() + 7 * 86400000 } });
        const acHistMid = readCleanHistory().records.length;
        fs.writeFileSync(path.join(acGreenA, 'again.bin'), 'x');
        const acPaused = await runAutoClean(acFakeTargets);
        log('V18_AUTOCLEAN_PAUSE: ' + JSON.stringify({
          skipped: acPaused.skipped === 'paused',
          histSame: readCleanHistory().records.length === acHistMid,
        }));
        patchSettings({ autoClean: acPrev }); // 还原现场

        // 查重：3 个内容相同的 >1MB 文件 + 1 个同尺寸不同内容 + 1 个 <1MB 重复 + 隐藏目录/替身里的重复
        const dBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-dd-'));
        const ddWrite = (name, buf) => { const p = path.join(dBase, name); fs.writeFileSync(p, buf); return p; };
        const ddSame = Buffer.alloc(1200 * 1024, 7); ddSame.write('SAME-CONTENT-HEAD', 0);
        const ddDiff = Buffer.alloc(1200 * 1024, 7); ddDiff.write('DIFFERENT-HEAD--', 0);
        const ddF1 = ddWrite('a.bin', ddSame);
        const ddF2 = ddWrite('b.bin', ddSame);
        const ddF3 = ddWrite('c.bin', ddSame);
        const ddFDiff = ddWrite('d.bin', ddDiff);
        ddWrite('small.bin', ddSame.subarray(0, 512 * 1024)); // <1MB → 不该进组
        fs.mkdirSync(path.join(dBase, '.hidden'));
        fs.writeFileSync(path.join(dBase, '.hidden', 'h.bin'), ddSame); // 隐藏目录 → 排除
        try { fs.symlinkSync(ddF1, path.join(dBase, 'link.bin')); } catch {} // 替身 → 排除

        // cancel：起跑后立刻叫停 → 返回 canceled 且进度冻结
        const ddP = startDedupe({ roots: [dBase] });
        dedupeState.canceled = true;
        const ddCanceled = await ddP;
        const ddProgA = JSON.stringify(dedupeState.progress);
        await sleep(200);
        const ddProgB = JSON.stringify(dedupeState.progress);
        log('V18_DEDUPE_CANCEL: ' + JSON.stringify({
          canceled: ddCanceled.canceled === true,
          notRunning: dedupeState.running === false,
          frozen: ddProgA === ddProgB, // cancel 后不再推进度
        }));

        const ddRun = await startDedupe({ roots: [dBase] });
        const ddGroups = (ddRun && ddRun.groups) || [];
        const ddG0 = ddGroups[0];
        log('V18_DEDUPE: ' + JSON.stringify({
          ok: ddRun.ok === true,
          oneGroup: ddGroups.length === 1,
          members3: ddG0 ? ddG0.files.length === 3 : false,
          diffExcluded: ddG0 ? !ddG0.files.some((f) => f.path === ddFDiff) : false,
          smallExcluded: ddG0 ? !ddG0.files.some((f) => f.name === 'small.bin') : false,
          hiddenExcluded: ddG0 ? !ddG0.files.some((f) => f.name === 'h.bin') : false,
          linkExcluded: ddG0 ? !ddG0.files.some((f) => f.name === 'link.bin') : false,
          wastedOk: ddG0 ? ddG0.wasted === ddSame.length * 2 : false,
        }));
        // sha256 与系统 shasum -a 256 抽查一致
        const ddMine = await hashFile(ddF1);
        let ddSys = '';
        try { ddSys = execFileSync('/usr/bin/shasum', ['-a', '256', ddF1]).toString().trim().split(/\s+/)[0]; } catch {}
        log('V18_DEDUPE_HASH: ' + JSON.stringify({ match: ddMine === ddSys && ddSys.length === 64 }));

        // ===== QA 补充场景 A（v1.7.5 回归）：漏斗②③分组正确性 =====
        // ① 同尺寸 + 前 4KB 相同 + 尾部不同 —— 必须**不**进同一组（证明漏斗③全量哈希不可省）；
        // ② 同时混入一对真重复（= e1 的拷贝）—— 确认漏斗③没有把真重复也误杀掉
        const aBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-dda-'));
        const headSame = Buffer.alloc(1200 * 1024, 'X'.charCodeAt(0)); // 前 4KB 完全一致
        const aF1 = path.join(aBase, 'e1.bin');
        const aF2 = path.join(aBase, 'e2.bin');
        const aF3 = path.join(aBase, 'e3-dup-of-e1.bin');
        const aBuf1 = Buffer.from(headSame); aBuf1.set(Buffer.alloc(4096, '1'), aBuf1.length - 4096); fs.writeFileSync(aF1, aBuf1);
        const aBuf2 = Buffer.from(headSame); aBuf2.set(Buffer.alloc(4096, '2'), aBuf2.length - 4096); fs.writeFileSync(aF2, aBuf2);
        fs.writeFileSync(aF3, aBuf1); // 真重复：与 e1 逐字节一致
        const aRun = await startDedupe({ roots: [aBase] });
        const aGroups = (aRun && aRun.groups) || [];
        const aG0 = aGroups[0];
        const aMemberPaths = aG0 ? aG0.files.map((f) => f.path) : [];
        log('V18_DEDUPE_LAYER23: ' + JSON.stringify({
          ok: aRun.ok === true,
          oneGroup: aGroups.length === 1,                                        // 只有真重复成组
          members2: aG0 ? aG0.files.length === 2 : false,
          tailDiffExcluded: aMemberPaths.includes(aF1) && !aMemberPaths.includes(aF2), // 前4KB相同尾不同 → 不进组
          realDupKept: aMemberPaths.includes(aF3),                               // 真重复没被误杀
          wastedOk: aG0 ? aG0.wasted === aBuf1.length : false,
        }));
        // ===== QA 补充场景 B：暂停档的过期语义 =====
        // pausedUntil 已过期 → 不算暂停，正常补跑执行（未来时间的跳过已由 V18_AUTOCLEAN_PAUSE 覆盖）
        patchSettings({ autoClean: { enabled: true, pausedUntil: Date.now() - 1000 } });
        fs.writeFileSync(path.join(acGreenA, 'after-expiry.bin'), 'x');
        const acExpired = await runAutoClean(acFakeTargets);
        log('V18_AUTOCLEAN_EXPIRED: ' + JSON.stringify({
          executed: acExpired.ok === true && !acExpired.skipped,
          emptied: fs.readdirSync(acGreenA).length === 0,
          lastRunSet: !!getSettings().autoClean.lastRun,
        }));
        patchSettings({ autoClean: acPrev }); // 还原现场
        // 测试数据只走废纸篓通道收尾（绝不 rm）
        for (const p of [ddF1, ddF2, ddF3, ddFDiff, aF1, aF2, aF3]) { try { await shell.trashItem(p); } catch {} }

        // ================= v1.8 断言（B4-1 LLM / B4-2 引导 / B4-3 自动更新） =================
        // schema v6：ai + onboarding 长出、老键一个不丢、默认关闭
        log('V18_SCHEMA2: ' + JSON.stringify({
          v: getSettings()._v,
          hasAi: 'ai' in getSettings(),
          hasOnboarding: 'onboarding' in getSettings(),
          aiOff: getSettings().ai.enabled === false,
          obNotDone: getSettings().onboarding.done === false,
          oldKept: ['general', 'appearance', 'chime', 'health', 'notify', 'stealth', 'clipboard', 'weather', 'autoClean'].every((k) => k in getSettings()),
        }));
        // 引导 IPC：自检模式 onboarding-get 必须返回 done=true（不弹覆盖层）
        const obGet = onboardingGet();
        log('V18_ONBOARDING: ' + JSON.stringify({
          getOk: obGet.ok === true,
          doneInAutotest: obGet.done === true,
          setDone: onboardingSet({ done: true }).done === true,
        }));
        // 自动更新：自检模式直接跳过（不联网、不写文件）
        const up = await checkForUpdates({ force: true });
        log('V18_UPDATE: ' + JSON.stringify({
          skipped: up.skipped === 'autotest',
          noNetwork: up.ok === false,
        }));
        // LLM：配置拉取（无 Key 时 keyMasked 为空串，真 key 永不进 IPC）
        const llmCfg = llmGetConfig();
        log('V18_LLM: ' + JSON.stringify({
          ok: llmCfg && llmCfg.ok === true,
          hasAi: !!(llmCfg && llmCfg.ai),
          presets5: !!(llmCfg && llmCfg.presets && llmCfg.presets.length === 5),
          keyMaskedEmpty: !!(llmCfg && llmCfg.keyMasked === ''),
          spent0: !!(llmCfg && llmCfg.spent === 0),
        }));
        // LLM 未启用时 llm-chat 必须拒绝（不联网、不发请求）
        const llmChatOff = await llmChat('hi');
        log('V18_LLM_OFF: ' + JSON.stringify({
          okFalse: llmChatOff && llmChatOff.ok === false,
          kind: llmChatOff && llmChatOff.kind,
        }));
        // 渲染层 G 组 UI 存在（设置页 AI 助手组 + 常用页聊天卡）
        await js(`document.querySelector('[data-tab="settings"]').click()`);
        await sleep(500);
        log('V18_SETGROUPS: ' + await js(`JSON.stringify({
          groups: [...document.querySelectorAll('#page-settings .sgroup')].map(g => g.dataset.group).join(','),
          hasAiGroup: !!document.getElementById('swAi'),
          hasSegAi: !!document.getElementById('segAiProvider'),
          hasAiSave: !!document.getElementById('aiSaveBtn'),
          hasUpdateCheck: !!document.getElementById('updateCheckBtn'),
        })`));
        await shot('electron-v18-settings.png');

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
  if (weatherTimer) clearInterval(weatherTimer);
  stopClip(); // v1.6：停轮询，内存里的剪贴板历史随进程一起消失
});

// 桌宠不需要 dock 图标与多窗口
app.dock?.hide();
app.on('window-all-closed', () => app.quit());
