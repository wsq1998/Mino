// Mio 渲染层：表情状态机 + 生命感动画 + 快捷面板
// 同时兼容 Electron（window.mio 存在）与纯浏览器预览（降级运行）
// 注意：id="mio" 的元素会作为命名属性挂到 window.mio，
// 所以必须通过方法签名来甄别真正的 Electron 桥接对象
const bridge = (window.mio && typeof window.mio.getStats === 'function') ? window.mio : null;
// 浏览器预览模式的设置副本，让开关能真的拨动（含深合并，模拟主进程行为）
const previewSettings = {
  _v: 3,
  general: { autoOpen: false },
  appearance: { theme: 'dark', size: 'md', opacity: 1, onTop: true, gaze: true, clickThrough: true, reduceMotion: false, displayId: null },
  chime: { enabled: true, from: 9, to: 22, notify: false },
  health: { enabled: true, sit: true, water: false, eye: false, quietFrom: 22, quietTo: 9 },
  notify: { style: 'both' },
  pomodoro: { work: 25 },
  stealth: { enabled: true, opacity: 0.12, apps: null },
  clipboard: { enabled: true, limit: 10, filterPassword: false },
  capture: { mode: 'region', dest: 'clipboard' },
  hotkey: { trigger: 'Alt+Space' },
  consent: { permsIntroSeen: false },
  isPackaged: false, loginItem: false,
  stealthApps: [{ id: 'com.colliderli.iina', name: 'IINA' }, { id: 'org.videolan.vlc', name: 'VLC' }],
  version: '1.6.0', userDataPath: '~/Library/Application Support/Mio',
};
function previewMerge(base, patch) {
  const out = { ...base };
  Object.keys(patch || {}).forEach((k) => {
    const b = base[k], p = patch[k];
    out[k] = (p && b && typeof p === 'object' && typeof b === 'object') ? previewMerge(b, p) : p;
  });
  return out;
}
const api = bridge || {
  setInteractive: () => {}, contextMenu: () => {}, dragStart: () => {},
  dragMove: () => {}, dragEnd: () => {},
  getStats: async () => ({ cpu: 12, mem: 58 }),
  getFullStats: async () => ({
    cpu: 12, mem: 58,
    memDetail: {
      pct: 58, app: 6.2e9, wired: 1.8e9, compressed: 1.3e9, avail: 6.7e9, total: 16e9,
      pressure: { freePct: 42, level: 'normal' },
    },
    boot: { bootTs: Date.now() - 3 * 86400000, uptimeText: '3 天 4 小时', bootText: '9月7日 09:12' },
    netDetail: { ip: '192.168.1.23', ssid: 'Home-5G', conns: 182 },
    disk: { total: 245e9, avail: 47e9, usedPct: 81 },
    net: { down: 102400, up: 20480 },
    battery: { pct: 76, charging: false },
    top: [
      { name: 'WindowServer', cpu: 8.2, mem: 3.1, pid: 188 },
      { name: 'Electron', cpu: 5.4, mem: 2.2, pid: 8012 },
      { name: 'Safari', cpu: 3.0, mem: 4.5, pid: 6231 },
      { name: 'Code', cpu: 2.6, mem: 6.8, pid: 5400 },
      { name: 'WeChat', cpu: 1.2, mem: 2.9, pid: 4321 },
      { name: 'node', cpu: 0.8, mem: 1.5, pid: 9102 },
    ],
  }),
  cleanScan: async () => ([
    { id: 'user-caches', name: '用户缓存', level: 'green', note: '应用缓存，删除后自动重建', size: 3.2e9, files: 8120 },
    { id: 'user-logs', name: '用户日志', level: 'green', note: '历史日志文件', size: 4.1e8, files: 940 },
    { id: 'trash', name: '废纸篓', level: 'yellow', note: '清空后不可恢复', size: 1.7e9, files: 133 },
  ]),
  cleanExecute: async (ids) => ids.map((id) => ({ id, name: id, moved: 10, failed: 0 })),
  notify: (t, b) => console.log('[notify]', t, b),
  quit: () => {}, onCursor: () => {},
  // ===== v1.2 降级 mock =====
  setPanelWidth: () => {},
  killProcess: async () => ({ ok: true }),
  getHistory: async () => {
    // 生成 24h 模拟曲线（48 点）
    const pts = [];
    const now = Date.now();
    for (let i = 47; i >= 0; i--) {
      pts.push({ t: now - i * 30 * 60000, cpu: 20 + Math.round(35 * Math.abs(Math.sin(i / 6))), mem: 45 + Math.round(20 * Math.abs(Math.cos(i / 9))), disk: 81, pressure: 'normal' });
    }
    return { points: pts, peak: { cpu: 55, cpuAt: '14:32', mem: 68, memAt: '10:05' } };
  },
  getMessages: async () => ([
    { t: Date.now() - 3600000, title: 'Mio · 番茄钟', body: '专注结束，休息 5 分钟吧' },
    { t: Date.now() - 7200000, title: 'Mio · 提醒', body: '30 分钟到了！' },
  ]),
  clearMessages: async () => true,
  logMessage: (t, b) => console.log('[message]', t, b),
  scanBigFiles: async () => ([
    { name: 'Xcode-15.2.dmg', path: '/Users/demo/Downloads/Xcode-15.2.dmg', size: 7.8e9, lastUsed: '2025-08-02', level: 'yellow' },
    { name: 'final-cut.mp4', path: '/Users/demo/Movies/final-cut.mp4', size: 3.1e9, lastUsed: '2025-09-01', level: 'yellow' },
    { name: 'backup-2024.zip', path: '/Users/demo/Documents/backup-2024.zip', size: 1.2e9, lastUsed: '', level: 'yellow' },
  ]),
  getCacheRanking: async () => ([
    { name: 'com.tencent.xinWeChat', path: '/Users/demo/Library/Caches/com.tencent.xinWeChat', size: 2.4e9, running: true, level: 'green' },
    { name: 'com.google.Chrome', path: '/Users/demo/Library/Caches/com.google.Chrome', size: 1.1e9, running: true, level: 'green' },
    { name: 'pip', path: '/Users/demo/Library/Caches/pip', size: 6.4e8, running: false, level: 'green' },
  ]),
  scanLeftovers: async () => ([
    { name: 'OldApp', path: '/Users/demo/Library/Application Support/OldApp', size: 3.2e8, note: 'Application Support · 未找到对应 App', level: 'green' },
    { name: 'com.old.tool', path: '/Users/demo/Library/Preferences/com.old.tool', size: 2.1e6, note: 'Preferences · 未找到对应 App', level: 'yellow' },
  ]),
  getAdvice: async () => ([
    { id: 'stale-node-modules', icon: '📦', title: 'node_modules × 3，共 3.2GB', detail: '最久 42 天未访问，可以安全清理（需要时 npm install 重建）', action: 'clean-paths',
      paths: [
        { path: '/Users/demo/dev/old-proj/node_modules', name: 'old-proj/node_modules', size: 1.4e9 },
        { path: '/Users/demo/dev/demo2/node_modules', name: 'demo2/node_modules', size: 1.8e9 },
      ] },
  ]),
  getCleanHistory: async () => ({
    records: [{ t: Date.now() - 2 * 86400000, items: [{ name: '用户缓存', size: 2.1e9 }], total: 2.1e9 }],
    totalFreed: 12.4e9, freed30d: 4.2e9,
  }),
  cleanPaths: async (entries) => entries.map((e) => ({ path: e.path, ok: true })),
  // ===== v1.5 降级 mock =====
  getSettings: async () => previewSettings,
  setSettings: async (patch) => {
    Object.assign(previewSettings, previewMerge(previewSettings, patch));
    return previewSettings;
  },
  setLoginItem: async () => ({ ok: false, error: '浏览器预览模式不支持' }),
  getDisplays: async () => ([
    { id: '1', label: '内建视网膜显示器 · 1440×900 · 主屏' },
    { id: '2', label: 'DELL U2720Q · 2560×1440' },
  ]),
  stealthCapture: async () => ({ ok: false, error: '浏览器预览模式不支持' }),
  // ===== v1.6 降级 mock =====
  clipList: async () => ({
    ok: true,
    items: [
      { id: 'c_3', preview: 'https://example.com/docs/getting-started', pinned: false, t: Date.now() },
      { id: 'c_2', preview: 'Mio 记的剪贴板活不过这次开机', pinned: true, t: Date.now() - 6000 },
      { id: 'c_1', preview: 'npm run start', pinned: false, t: Date.now() - 12000 },
    ],
    paused: false, enabled: true, limit: 10, pinnedCount: 1,
  }),
  clipCopy: async () => ({ ok: true, preview: '已复制' }),
  clipPin: async () => ({ ok: true, pinnedCount: 1 }),
  clipUnpin: async () => ({ ok: true, pinnedCount: 0 }),
  clipDelete: async () => ({ ok: true }),
  clipClear: async () => ({ ok: true }),
  clipPause: async (paused) => ({ ok: true, paused: !!paused }),
  onClipChanged: () => {}, onClipNotice: () => {},
  actLock: async () => ({ ok: true, locked: true, degraded: false, need: null }),
  actScreenshot: async () => ({ ok: true }),
  trashSize: async () => ({ ok: true, bytes: 2.4e9, count: 148 }),
  trashEmpty: async () => ({ ok: true, removed: 148, failed: 0, need: null }),
  permStatus: async () => ({ ok: true, screen: 'granted', accessibility: true, automation: 'granted' }),
  permRequest: async () => ({ ok: true, status: true }),
  permOpen: async () => ({ ok: true }),
  hotkeyRecord: async (accelerator) => ({ ok: true, trigger: accelerator }),
  hotkeyReset: async () => ({ ok: true, trigger: 'Alt+Space' }),
};

const mioEl = document.getElementById('mio');
const panel = document.getElementById('panel');
const bubble = document.getElementById('bubble');
const eyes = [...document.querySelectorAll('.eye')];
const pupils = [...document.querySelectorAll('.pupil')];

// HTML 转义（文件名/路径可能含特殊字符）
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============ v1.5：设置中心（第 4 个 tab）============
// 声明放在前面：tickClock 会在启动阶段立即调用 chimeTick，不能等到文件末尾才初始化
const pad2 = (n) => String(n).padStart(2, '0');
// 只有这些键属于「设置」，其余是 meta（isPackaged / version …），不能混进 settings
const SETTING_KEYS = ['general', 'appearance', 'chime', 'health', 'notify', 'pomodoro', 'stealth', 'clipboard', 'capture', 'hotkey', 'consent'];
let settings = {
  general: { autoOpen: false },
  appearance: { theme: 'dark', size: 'md', opacity: 1, onTop: true, gaze: true, clickThrough: true, reduceMotion: false, displayId: null },
  chime: { enabled: true, from: 9, to: 22, notify: false },
  health: { enabled: true, sit: true, water: false, eye: false, quietFrom: 22, quietTo: 9 },
  notify: { style: 'both' },
  pomodoro: { work: 25 },
  stealth: { enabled: true, opacity: 0.12, apps: null },
  clipboard: { enabled: true, limit: 10, filterPassword: false },
  capture: { mode: 'region', dest: 'clipboard' },
  hotkey: { trigger: 'Alt+Space' },
  consent: { permsIntroSeen: false },
};
let settingsMeta = { isPackaged: false, loginItem: false, stealthApps: [], version: '', userDataPath: '', displays: [], permissions: null, hotkeyRegistered: true };
let gazeEnabled = true; // 视线跟随开关，由 appearance.gaze 决定
// v1.6 B2-4：专注联动（内存态，不落盘；重启归零）
let focusMode = false;
// 免打扰判据：番茄钟专注 或 处于时段免打扰，任一命中即静默（FOCUS-3 叠加）
function dndActive() { return focusMode || inQuietHours(new Date().getHours()); }

function pickSettings(s) {
  const out = {};
  SETTING_KEYS.forEach((k) => { if (s && s[k]) out[k] = s[k]; });
  return out;
}

// 报时时段（闭区间，支持跨零点）
function inChimeRange(h, from, to) {
  from = Number(from); to = Number(to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
  return from <= to ? (h >= from && h <= to) : (h >= from || h <= to);
}

// 免打扰时段：跨零点时 to 表示「次日几点结束」，故用 <
function inQuietHours(h) {
  const q = settings.health || {};
  const from = Number(q.quietFrom), to = Number(q.quietTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  return from > to ? (h >= from || h < to) : (h >= from && h < to);
}

function reminderSummary() {
  const h = settings.health;
  if (!h.enabled) return '健康提醒：已关闭';
  const on = [h.sit && '久坐 45 分钟', h.water && '喝水 45 分钟', h.eye && '护眼 20 分钟'].filter(Boolean);
  return on.length ? `健康提醒：${on.join(' · ')}` : '健康提醒：未选择任何项目';
}

function renderSettings() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
  const el = (id) => document.getElementById(id);
  set('swLogin', settingsMeta.loginItem);
  set('swAutoOpen', settings.general.autoOpen);
  set('swChime', settings.chime.enabled);
  set('swChimeNotify', settings.chime.notify);
  set('swHealth', settings.health.enabled);
  set('swSit', settings.health.sit);
  set('swWater', settings.health.water);
  set('swEye', settings.health.eye);
  set('swStealth', settings.stealth.enabled);

  if (el('chimeRange')) el('chimeRange').textContent =
    `${pad2(settings.chime.from)}:00 — ${pad2(settings.chime.to)}:00`;
  if (el('quietRange')) el('quietRange').textContent =
    `${pad2(settings.health.quietFrom)}:00 — ${pad2(settings.health.quietTo)}:00`;
  if (el('swLogin')) el('swLogin').disabled = !settingsMeta.isPackaged;
  if (el('loginHint')) el('loginHint').textContent = settingsMeta.isPackaged
    ? '关闭后 Mio 不再随登录启动'
    : '开发模式无法写入登录项，打包版可用';
  if (el('reminderInfo')) el('reminderInfo').textContent = reminderSummary();

  const apps = settingsMeta.stealthApps || [];
  if (el('stealthAppsNote')) el('stealthAppsNote').textContent =
    apps.length ? `当前名单 ${apps.length} 个` : '名单是空的，Mio 不会自动隐身';
  if (el('aboutVersion')) el('aboutVersion').textContent = settingsMeta.version ? `v${settingsMeta.version}` : '—';
  if (el('aboutPath')) el('aboutPath').textContent = settingsMeta.userDataPath || '—';

  // 外观与主题
  const ap = settings.appearance;
  const sizeLabel = { sm: '小', md: '中', lg: '大' }[ap.size] || '中';
  const themeLabel = { dark: '深色', light: '浅色', auto: '跟随系统' }[ap.theme] || '深色';
  const seg = el('segSize');
  if (seg) [...seg.querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b.dataset.v === ap.size));
  const segT = el('segTheme');
  if (segT) [...segT.querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b.dataset.v === ap.theme));
  if (el('opacityVal')) el('opacityVal').textContent = `${Math.round(ap.opacity * 100)}%`;
  if (el('rngOpacity')) el('rngOpacity').value = String(Math.round(ap.opacity * 100));
  set('swOnTop', ap.onTop);
  set('swGaze', ap.gaze);
  set('swClickThrough', ap.clickThrough);
  set('swReduceMotion', ap.reduceMotion);
  if (el('stealthOpacityVal')) el('stealthOpacityVal').textContent = `${Math.round(settings.stealth.opacity * 100)}%`;
  if (el('rngStealthOpacity')) el('rngStealthOpacity').value = String(Math.round(settings.stealth.opacity * 100));
  renderStealthList();

  // v1.6：剪贴板 / 快捷操作 / 通知方式 / 番茄钟时长 / 快捷键
  const cl = settings.clipboard;
  set('swClip', cl.enabled);
  set('swClipPwd', cl.filterPassword);
  const segCL = el('segClipLimit');
  if (segCL) [...segCL.querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b.dataset.v === String(cl.limit)));
  const segCap = el('segCapture');
  if (segCap) [...segCap.querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b.dataset.v === settings.capture.mode));
  const segNS = el('segNotifyStyle');
  if (segNS) [...segNS.querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b.dataset.v === settings.notify.style));
  const segPW = el('segPomoWork');
  if (segPW) [...segPW.querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b.dataset.v === String(settings.pomodoro.work)));
  renderKeyRec();

  // 折叠标题上的摘要：收起时也能一眼看到状态
  const h = settings.health;
  const n = [h.sit, h.water, h.eye].filter(Boolean).length;
  const briefs = {
    general: `自启 ${settingsMeta.loginItem ? '开' : '关'}`,
    appearance: `${themeLabel} · ${sizeLabel} · ${Math.round(ap.opacity * 100)}%`,
    notify: `报时 ${settings.chime.enabled ? '开' : '关'} · 健康 ${h.enabled ? n + ' 项' : '关'} · ${notifyStyleLabel()}`,
    stealth: settings.stealth.enabled ? `${apps.length} 个` : '关',
    clipboard: settings.clipboard.enabled ? `开 · ${settings.clipboard.limit} 条${settings.clipboard.filterPassword ? ' · 过滤' : ''}` : '关',
    hotkey: accelLabel(settings.hotkey.trigger),
    about: settingsMeta.version ? `v${settingsMeta.version}` : '—',
  };
  Object.keys(briefs).forEach((k) => {
    const node = el(`sgBrief-${k}`);
    if (node) node.textContent = briefs[k];
  });
}

async function loadSettings() {
  try {
    const s = await api.getSettings();
    if (s && s.chime) {
      settings = { ...settings, ...pickSettings(s) };
      settingsMeta = {
        isPackaged: !!s.isPackaged,
        loginItem: !!s.loginItem,
        stealthApps: s.stealthApps || [],
        version: s.version || '',
        userDataPath: s.userDataPath || '',
        displays: settingsMeta.displays,
        permissions: s.permissions || null,
        hotkeyRegistered: s.hotkeyRegistered !== false,
      };
    }
  } catch {}
  renderSettings();
  applyAppearance();
  fillDisplays();
  refreshClip();
  refreshTrashBtn();
}

// 只发改动的那一枝，主进程做深合并；返回的整棵树里再挑出设置键
async function patchSettings(patch, after) {
  try {
    const saved = await api.setSettings(patch);
    if (saved && saved.chime) {
      settings = { ...settings, ...pickSettings(saved) };
      if ('loginItem' in saved) settingsMeta.loginItem = !!saved.loginItem;
      if (saved.stealthApps) settingsMeta.stealthApps = saved.stealthApps;
      if ('hotkeyRegistered' in saved) settingsMeta.hotkeyRegistered = saved.hotkeyRegistered !== false;
    }
  } catch {}
  renderSettings();
  if (after) after();
}

// ['appearance','size'] + 'lg' → { appearance: { size: 'lg' } }
function buildPatch(path, value) {
  const keys = Array.isArray(path) ? path : String(path).split('.');
  const patch = {};
  let cur = patch;
  keys.forEach((k, i) => { cur = cur[k] = i === keys.length - 1 ? value : {}; });
  return patch;
}

function bindSwitch(id, path, after) {
  const node = document.getElementById(id);
  if (!node) return;
  node.addEventListener('change', async () => {
    interact();
    const on = node.checked;
    if (path === 'login') {
      const r = await api.setLoginItem(on);
      if (!r || !r.ok) {
        node.checked = !on;
        say((r && r.error) || '设置失败');
        return;
      }
      settingsMeta.loginItem = !!r.openAtLogin;
      say(r.openAtLogin ? '开机自启已开启' : '开机自启已关闭');
      renderSettings();
      return;
    }
    // ['chime','enabled'] 或 'chime.enabled' → { chime: { enabled } }
    await patchSettings(buildPatch(path, on), () => after && after(on));
  });
}

// ============ 情绪状态机 ============
const STATES = ['idle', 'happy', 'curious', 'sleepy', 'surprised', 'thinking'];
let state = 'idle';
let tempTimer = null;
let lastInteract = Date.now();
let working = false; // 番茄钟运行中

function setState(next, tempMs = 0) {
  if (state === next) return;
  state = next;
  mioEl.className = `mio interactive mio--${next}` + (working ? ' mio--working' : '');
  clearTimeout(tempTimer);
  if (tempMs > 0) {
    tempTimer = setTimeout(() => setState('idle'), tempMs);
  }
}

function interact() {
  lastInteract = Date.now();
  if (state === 'sleepy') setState('idle');
}

// ============ 生命感：眨眼 ============
function blinkLoop() {
  const delay = 2000 + Math.random() * 4000;
  setTimeout(() => {
    if (!settings.appearance.reduceMotion && (state === 'idle' || state === 'curious')) {
      eyes.forEach((e) => e.classList.add('blink'));
      setTimeout(() => eyes.forEach((e) => e.classList.remove('blink')), 120);
    }
    blinkLoop();
  }, delay);
}
blinkLoop();

// ============ 生命感：困倦 ============
setInterval(() => {
  if (settings.appearance.reduceMotion) return; // 减弱动效时不做打瞌睡演出
  const idleMs = Date.now() - lastInteract;
  if (idleMs > 5 * 60 * 1000 && state === 'idle') setState('sleepy');
  if (state === 'sleepy' && Math.random() < 0.3) {
    mioEl.classList.add('mio--nod');
    setTimeout(() => mioEl.classList.remove('mio--nod'), 1500);
  }
}, 5000);

// ============ 视线跟随（全局光标） ============
api.onCursor((pt) => {
  if (!gazeEnabled) return;
  if (state === 'sleepy' || state === 'happy') return;
  const rect = mioEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = pt.x - cx;
  const dy = pt.y - cy;
  const dist = Math.hypot(dx, dy) || 1;
  const max = 3.5;
  const ox = (dx / dist) * Math.min(max, dist / 40);
  const oy = (dy / dist) * Math.min(max, dist / 40);
  pupils.forEach((p) => (p.style.transform = `translate(${ox}px, ${oy}px)`));
});

// ============ 点击穿透管理 ============
// 光标在可交互元素上 → 关闭穿透；否则恢复穿透。
// 设置里关掉「点击穿透」后恒为可交互（球体不再抢不到鼠标）。
document.addEventListener('mousemove', (e) => {
  if (!settings.appearance.clickThrough) { api.setInteractive(true); return; }
  const hit = e.target.closest('.interactive, .btn, .card');
  api.setInteractive(!!hit);
});
document.addEventListener('mouseleave', () => api.setInteractive(false));

// ============ 拖拽 ============
let dragging = false;
let dragMoved = false;

mioEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  dragMoved = false;
  api.dragStart();
});
document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  dragMoved = true;
  api.dragMove();
});
document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  api.dragEnd();
  setTimeout(() => (dragMoved = false), 50);
});

// ============ 交互表情 ============
mioEl.addEventListener('click', () => {
  if (dragMoved) return;
  interact();
  setState('happy', 1600);
  togglePanel();
});
mioEl.addEventListener('dblclick', () => {
  interact();
  setState('surprised', 1200);
  say('哇！吓到我了');
});
mioEl.addEventListener('mouseenter', () => {
  interact();
  if (state === 'idle') setState('curious');
});
mioEl.addEventListener('mouseleave', () => {
  if (state === 'curious') setState('idle');
});
mioEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.contextMenu();
});

// ============ 气泡 ============
let bubbleTimer = null;
function say(text, ms = 2200) {
  bubble.textContent = text;
  bubble.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => (bubble.hidden = true), ms);
}

// v1.6 C9：统一的提醒出口 —— 依 settings.notify.style 决定走气泡 / 系统通知 / 两者。
// 只作用于提醒类，不影响设置页内联提示。主进程的 notify 会顺带把消息记入消息中心，
// 故只在「不发系统通知」时才手动补一条消息，避免重复。
function notifyUser(title, body, opts = {}) {
  const style = (settings.notify && settings.notify.style) || 'both';
  if (style === 'bubble' || style === 'both') say(opts.sayText || title, opts.ms || 3000);
  if (style === 'system' || style === 'both') api.notify(title, body);
  else api.logMessage(title, body);
}

// ============ 面板 ============
let panelOpen = false;
function togglePanel() {
  panelOpen = !panelOpen;
  panel.hidden = !panelOpen;
  if (panelOpen) {
    refreshStats();
    checkAdvice();
    refreshMessages();
    refreshClip();      // v1.6
    refreshTrashBtn();  // v1.6
  } else {
    // 收起面板：退出详情页、重置扫描缓存（下次展开重新扫）
    closeDetail();
    bigFilesScanned = false;
    cacheRankScanned = false;
    leftoversScanned = false;
  }
}

// ============ v1.2 双档宽度 + 钻入式详情页 ============
// 点卡片不再内联撑开（会导致面板裁切、展开项跑到视口外），而是把卡片内容搬进
// 覆盖面板的详情页里单面板显示，带返回按钮。
let expandedCard = null;
let detailHome = null; // 记录 .detail 的原始父节点，返回时搬回
const detailView = document.getElementById('detailView');
const dvBody = document.getElementById('dvBody');
const dvTitle = document.getElementById('dvTitle');
const panelEl = document.getElementById('panel');

function setPanelWide(wide) {
  panelEl.classList.add('animating');
  panelEl.classList.toggle('wide', wide);
  api.setPanelWidth(wide);
  clearTimeout(setPanelWide._t);
  setPanelWide._t = setTimeout(() => panelEl.classList.remove('animating'), 300);
}

function openDetail(card) {
  if (expandedCard === card) { closeDetail(); return; }
  if (expandedCard) closeDetail(true);
  expandedCard = card;
  const detail = card.querySelector('.detail');
  if (!detail) return;
  detailHome = detail.parentNode;
  dvBody.appendChild(detail);
  dvTitle.textContent = card.dataset.dvTitle || '详情';
  detailView.hidden = false;
  detailView.classList.remove('closing');
  setPanelWide(true);
  onCardExpanded(card.id);
}

function closeDetail(keepWide = false) {
  if (!expandedCard) return;
  const detail = dvBody.firstElementChild;
  if (detail && detailHome) detailHome.appendChild(detail);
  expandedCard = null;
  detailHome = null;
  detailView.classList.add('closing');
  const done = () => {
    if (!expandedCard) detailView.hidden = true;
    detailView.classList.remove('closing');
  };
  setTimeout(done, 190);
  if (!keepWide) setPanelWide(false);
}

document.getElementById('dvBack').addEventListener('click', () => { interact(); closeDetail(); });

// 卡片点击钻入详情（内部按钮/勾选项不触发）
document.querySelectorAll('.expandable').forEach((card) => {
  card.addEventListener('click', (e) => {
    if (e.target.closest('button, .pick-item, .p-kill, .sort-toggle, .pick-all, .switch, .clip-item, .clip-head')) return;
    interact();
    openDetail(card);
  });
});

// 展开时的数据加载（重命令只在用户主动展开时触发）
function onCardExpanded(id) {
  if (id === 'bigFilesCard' && !bigFilesScanned) scanBigFilesUI();
  if (id === 'cacheRankCard' && !cacheRankScanned) scanCacheRankUI();
  if (id === 'leftoverCard' && !leftoversScanned) scanLeftoversUI();
  if (id === 'cleanHistCard') refreshCleanHistory();
  if (id === 'clipCard') refreshClip(); // v1.6：展开时拉最新剪贴板列表
  if (id === 'msgCard') {
    // 展开即已读
    lastMsgSeen = Date.now();
    try { localStorage.setItem('mio-msg-seen', String(lastMsgSeen)); } catch {}
    document.getElementById('msgDot').hidden = true;
    refreshMessages();
  }
}

// ============ 通用确认弹层（黄队二次确认 / 结束进程确认） ============
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmTitle = document.getElementById('confirmTitle');
const confirmBody = document.getElementById('confirmBody');
const confirmOk = document.getElementById('confirmOk');
let confirmResolver = null;

function showConfirm({ title, body, okText = '确认' }) {
  confirmTitle.textContent = title;
  confirmBody.textContent = body;
  confirmOk.textContent = okText;
  confirmOverlay.hidden = false;
  return new Promise((resolve) => { confirmResolver = resolve; });
}
document.getElementById('confirmCancel').addEventListener('click', () => {
  confirmOverlay.hidden = true;
  if (confirmResolver) confirmResolver(false);
  confirmResolver = null;
});
confirmOk.addEventListener('click', () => {
  confirmOverlay.hidden = true;
  if (confirmResolver) confirmResolver(true);
  confirmResolver = null;
});

// ============ 统一清理执行（C1/C2/C3/C4 共用：确认 → 废纸篓 → 历史） ============
async function trashWithConfirm(entries, { level, title }) {
  if (!entries.length) return;
  const total = entries.reduce((a, e) => a + (e.size || 0), 0);
  // 黄队：二次确认列出完整路径；绿队：一次确认列出名称
  const body = level === 'yellow'
    ? entries.map((e) => e.path).join('\n')
    : entries.map((e) => e.name).join('、');
  const ok = await showConfirm({
    title: `${title}：共 ${entries.length} 项，合计 ${fmtBytes(total)}`,
    body,
    okText: '移入废纸篓',
  });
  if (!ok) return;
  setState('thinking');
  const report = await api.cleanPaths(entries);
  const okN = report.filter((r) => r.ok).length;
  const failN = report.length - okN;
  setState('happy', 2500);
  say(failN ? `完成 ${okN} 项，${failN} 项被占用` : `已移入废纸篓 ${okN} 项，清爽多了！`);
  refreshCleanHistory();
}

// 时钟
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
let lastChimeKey = ''; // v1.4 B：整点报时幂等键
function tickClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  document.getElementById('clock').textContent = `${hh}:${mm}`;
  document.getElementById('dateLine').textContent =
    `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
  chimeTick(d);
}

// v1.4 B：整点报时
// 用 "年-月-日-时" 作幂等键：既防同一分钟内重复触发，
// 也保证休眠唤醒后**不补报**已错过的整点（补报会连响一串，很烦）
function chimeTick(d) {
  if (d.getMinutes() !== 0) return;
  const c = settings.chime || {};
  if (!c.enabled) return;
  const h = d.getHours();
  if (!inChimeRange(h, c.from, c.to)) return;
  if (dndActive()) return; // v1.6：专注/免打扰期内不报时
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${h}`;
  if (key === lastChimeKey) return;
  lastChimeKey = key;

  const hour12 = Intl.DateTimeFormat().resolvedOptions().hour12;
  const label = hour12
    ? `现在 ${h % 12 === 0 ? 12 : h % 12} 点`
    : `现在 ${pad2(h)}:00`;
  // v1.6 C9：通道由 notify.style 与「整点报时同时发系统通知」共同决定（叠加）
  const style = settings.notify.style || 'both';
  if (style === 'bubble' || style === 'both') say(label);
  if ((style === 'system' || style === 'both') && c.notify) api.notify('Mio · 整点报时', label);
  else api.logMessage('Mio · 整点报时', label);
}
tickClock();
setInterval(tickClock, 1000);

// 系统速览（首页小卡）
async function refreshStats() {
  if (!panelOpen) return;
  const s = await api.getStats();
  document.getElementById('quickStats').textContent = `${s.cpu}% · ${s.mem}%`;
}
setInterval(refreshStats, 5000);

// ============ 标签页 ============
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    interact();
    closeDetail();
    const scroller = document.getElementById('panelScroll');
    if (scroller) scroller.scrollTop = 0;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-page').forEach((p) => (p.hidden = p.id !== 'page-' + tab.dataset.tab));
    // 设置页内容多，进来自动展开成宽面板
    setPanelWide(tab.dataset.tab === 'settings');
    if (tab.dataset.tab === 'status') pollStatus();
    if (tab.dataset.tab === 'clean') { checkAdvice(); refreshCleanHistory(); }
    if (tab.dataset.tab === 'settings') { renderSettings(); fillDisplays(); filterSettings(); }
  });
});
function switchTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

// ============ 状态中心 ============
const HISTORY_LEN = 36;
const cpuHist = [];
const memHist = [];
let hotNotified = false;

function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}
function fmtRate(b) {
  return b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB/s' : b >= 1e3 ? (b / 1e3).toFixed(0) + ' KB/s' : b + ' B/s';
}
function pressureText(level) {
  return level === 'crit' ? '紧张' : level === 'warn' ? '偏高' : '正常';
}

function setBar(id, pct) {
  const el = document.getElementById(id);
  el.style.width = pct + '%';
  el.className = 'bar-fill' + (pct >= 90 ? ' crit' : pct >= 70 ? ' warn' : '');
}

function drawSpark() {
  const cv = document.getElementById('spark');
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  const draw = (hist, color) => {
    if (hist.length < 2) return;
    ctx.beginPath();
    hist.forEach((v, i) => {
      const x = (i / (HISTORY_LEN - 1)) * w;
      const y = h - (v / 100) * (h - 4) - 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };
  draw(cpuHist, '#85B7EB');
  draw(memHist, '#1D9E75');
}

// ============ S4：进程列表（排序切换 + 结束进程） ============
let lastTop = [];
let procSort = 'cpu'; // 'cpu' | 'mem'

function renderProcs() {
  const list = [...lastTop].sort((a, b) => (procSort === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem)).slice(0, 10);
  document.getElementById('topProcs').innerHTML = list.length
    ? list.map((p) => `<div class="proc">
        <span class="p-name">${escHtml(p.name)}</span>
        <span class="p-cpu">${p.cpu.toFixed(0)}%</span>
        <span class="p-mem">${p.mem.toFixed(0)}%</span>
        <button class="p-kill" data-pid="${p.pid}" data-name="${escHtml(p.name)}" title="结束进程">✕</button>
      </div>`).join('')
    : '—';
  document.getElementById('procSortCpu').classList.toggle('active', procSort === 'cpu');
  document.getElementById('procSortMem').classList.toggle('active', procSort === 'mem');
}

document.getElementById('procSortCpu').addEventListener('click', (e) => {
  e.stopPropagation();
  procSort = 'cpu';
  renderProcs();
});
document.getElementById('procSortMem').addEventListener('click', (e) => {
  e.stopPropagation();
  procSort = 'mem';
  renderProcs();
});

// 结束进程：ⓧ → 二次确认 → SIGTERM
document.getElementById('topProcs').addEventListener('click', async (e) => {
  const btn = e.target.closest('.p-kill');
  if (!btn) return;
  e.stopPropagation();
  interact();
  const pid = Number(btn.dataset.pid);
  const name = btn.dataset.name;
  const ok = await showConfirm({
    title: `结束 ${name}？`,
    body: `PID ${pid}\n将向该进程发送 SIGTERM。\n未保存的工作将丢失！`,
    okText: '结束进程',
  });
  if (!ok) return;
  const r = await api.killProcess({ pid, name });
  if (r.ok) {
    say(`已结束 ${name}`);
    setState('happy', 1500);
    pollStatus();
  } else {
    say(r.error || '结束失败', 3000);
    setState('surprised', 1500);
  }
});

// ============ S5：24h 历史曲线 + 今日峰值 ============
function drawSpark24(points) {
  const cv = document.getElementById('spark24');
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  if (!points || points.length < 2) return;
  // 聚合到 48 点
  const BUCKETS = 48;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(t1 - t0, 1);
  const cpuAgg = new Array(BUCKETS).fill(null);
  const memAgg = new Array(BUCKETS).fill(null);
  const buckets = Array.from({ length: BUCKETS }, () => ({ cpu: [], mem: [] }));
  for (const p of points) {
    const idx = Math.min(BUCKETS - 1, Math.floor(((p.t - t0) / span) * BUCKETS));
    buckets[idx].cpu.push(p.cpu);
    buckets[idx].mem.push(p.mem);
  }
  buckets.forEach((b, i) => {
    if (b.cpu.length) {
      cpuAgg[i] = b.cpu.reduce((a, v) => a + v, 0) / b.cpu.length;
      memAgg[i] = b.mem.reduce((a, v) => a + v, 0) / b.mem.length;
    }
  });
  const draw = (agg, color) => {
    ctx.beginPath();
    let started = false;
    agg.forEach((v, i) => {
      if (v === null) return;
      const x = (i / (BUCKETS - 1)) * w;
      const y = h - (v / 100) * (h - 4) - 2;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  };
  draw(cpuAgg, '#85B7EB');
  draw(memAgg, '#1D9E75');
}

async function refreshHistory() {
  try {
    const h = await api.getHistory();
    document.getElementById('peakLine').textContent = h.peak.cpu !== null
      ? `今日峰值 CPU ${h.peak.cpu}% @${h.peak.cpuAt} · 内存 ${h.peak.mem}% @${h.peak.memAt}`
      : '今日峰值 —（采样积累中）';
    drawSpark24(h.points);
  } catch {}
}

// ============ 状态页轮询 ============
let pollTick = 0;
async function pollStatus() {
  const statusTabOpen = panelOpen && !document.getElementById('page-status').hidden;
  if (!statusTabOpen) return;
  const s = await api.getFullStats();

  setBar('barCpu', s.cpu); document.getElementById('valCpu').textContent = s.cpu + '%';
  setBar('barMem', s.mem); document.getElementById('valMem').textContent = s.mem + '%';
  setBar('barDisk', s.disk.usedPct);
  document.getElementById('valDisk').textContent = s.disk.usedPct + '%';
  document.getElementById('netDown').textContent = '↓ ' + fmtRate(s.net.down);
  document.getElementById('netUp').textContent = '↑ ' + fmtRate(s.net.up);
  document.getElementById('battVal').textContent = s.battery ? s.battery.pct + '%' : '—';
  document.getElementById('battState').textContent = s.battery ? (s.battery.charging ? '充电中' : '使用中') : '无电池';

  // v1.4 D：电池健康（无电池机器整行隐藏）
  const bh = s.batteryHealth;
  const bhCard = document.getElementById('battHealthCard');
  bhCard.hidden = !bh;
  if (bh) {
    document.getElementById('battHealthBrief').textContent = `${bh.pct}% · 循环 ${bh.cycles} 次`;
    const pctEl = document.getElementById('bhPct');
    pctEl.textContent = bh.pct + '%';
    pctEl.className = 'big-num ' + bh.level;
    const condGood = /normal|正常/i.test(bh.condition);
    document.getElementById('bhCond').textContent = bh.condition;
    document.getElementById('bhCycles').textContent = bh.cycles + ' 次';
    document.getElementById('bhWatt').textContent = bh.adapterWatt
      ? `${bh.adapterWatt} W${bh.charging ? ' · 充电中' : ''}`
      : '未接电源';
    document.getElementById('bhHint').textContent = condGood
      ? (bh.pct >= 80 ? '电池状态良好，无需处理' : '容量已下降，可留意续航变化')
      : '系统建议检修这块电池，建议联系 Apple 售后';
  }

  // S2：开机时长
  if (s.boot) {
    document.getElementById('bootLine').textContent = s.boot.bootText
      ? `已开机 ${s.boot.uptimeText} · 上次重启 ${s.boot.bootText}`
      : `已开机 ${s.boot.uptimeText}`;
  }
  // S1：内存细分
  if (s.memDetail) {
    const md = s.memDetail;
    document.getElementById('memBrief').textContent = `占用 ${s.mem}% · 压力${pressureText(md.pressure.level)}`;
    const t = md.total || 1;
    document.getElementById('segApp').style.width = (md.app / t * 100) + '%';
    document.getElementById('segWired').style.width = (md.wired / t * 100) + '%';
    document.getElementById('segComp').style.width = (md.compressed / t * 100) + '%';
    document.getElementById('segAvail').style.width = Math.max(0, (md.avail / t * 100)) + '%';
    document.getElementById('lgApp').textContent = fmtBytes(md.app);
    document.getElementById('lgWired').textContent = fmtBytes(md.wired);
    document.getElementById('lgComp').textContent = fmtBytes(md.compressed);
    document.getElementById('lgAvail').textContent = fmtBytes(md.avail);
    document.getElementById('memPressure').textContent =
      `压力等级：${pressureText(md.pressure.level)}（空闲 ${md.pressure.freePct}%）`;
  }
  // S3：网络详情
  if (s.netDetail) {
    document.getElementById('netIp').textContent = s.netDetail.ip || '未连接';
    document.getElementById('netSsid').textContent = s.netDetail.ssid || '—';
    document.getElementById('netConns').textContent = s.netDetail.conns;
  }
  // S4：进程 Top10
  lastTop = s.top || [];
  renderProcs();

  cpuHist.push(s.cpu); if (cpuHist.length > HISTORY_LEN) cpuHist.shift();
  memHist.push(s.mem); if (memHist.length > HISTORY_LEN) memHist.shift();
  drawSpark();

  // S5：每 60s 刷新一次 24h 曲线（2.5s × 24）
  pollTick++;
  if (pollTick % 24 === 1) refreshHistory();

  // Mio 高温联动：CPU 持续过载 → 大汗表情 + 一次性提醒
  if (s.cpu >= 90 && state !== 'happy' && state !== 'surprised') {
    if (state !== 'hot') setState('hot');
    if (!hotNotified) {
      hotNotified = true;
      say('CPU 快烧起来了，歇一下吧', 3500);
    }
  } else if (state === 'hot' && s.cpu < 75) {
    setState('idle');
    hotNotified = false;
  }
}
setInterval(pollStatus, 2500);

// 磁盘告警（每次开机提醒一次）
let diskWarned = false;
setInterval(async () => {
  if (diskWarned || !bridge) return;
  const s = await api.getFullStats();
  if (s.disk.usedPct >= 90) {
    if (dndActive()) return; // v1.6：专注/免打扰期不弹；不置 diskWarned，退出免打扰后再判
    diskWarned = true;
    notifyUser('Mio · 磁盘告警', `磁盘已用 ${s.disk.usedPct}%，建议清理`, { sayText: '磁盘快满了，点我清理一下', ms: 5000 });
  }
}, 60000);

// ============ S6：消息中心 ============
let lastMsgSeen = 0;
try { lastMsgSeen = Number(localStorage.getItem('mio-msg-seen') || 0); } catch {}

async function refreshMessages() {
  try {
    const msgs = await api.getMessages();
    document.getElementById('msgCount').textContent = msgs.length ? `${msgs.length} 条` : '';
    document.getElementById('msgDot').hidden = !msgs.some((m) => m.t > lastMsgSeen);
    document.getElementById('msgList').innerHTML = msgs.length
      ? msgs.map((m) => {
          const d = new Date(m.t);
          const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          return `<div class="msg-item">
            <div class="msg-title">${escHtml(m.title)}</div>
            <div class="msg-body">${escHtml(m.body)}</div>
            <div class="msg-time">${time}</div>
          </div>`;
        }).join('')
      : '暂无消息';
  } catch {}
}
document.getElementById('msgClearBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  await api.clearMessages();
  refreshMessages();
  say('消息已清空');
});
// 未读红点轮询（30s）
setInterval(refreshMessages, 30000);

// ============ 系统清理（v1.1 六类） ============
let scanResults = [];
const checkedIds = new Set();
let cleanArmed = false;

document.getElementById('scanBtn').addEventListener('click', async () => {
  interact();
  const btn = document.getElementById('scanBtn');
  btn.textContent = '扫描中…';
  btn.disabled = true;
  setState('thinking');
  document.getElementById('cleanList').innerHTML = '';
  document.getElementById('cleanActions').hidden = true;

  scanResults = await api.cleanScan();
  checkedIds.clear();
  scanResults.filter((r) => r.level === 'green' && r.size > 0).forEach((r) => checkedIds.add(r.id));

  const total = scanResults.reduce((a, r) => a + r.size, 0);
  document.getElementById('cleanSummary').textContent =
    total > 0 ? `共发现 ${fmtBytes(total)} 可评估空间` : '很干净，没有可清理项';

  const rows = scanResults
    .filter((r) => r.size > 0)
    .map((r) => `
      <div class="clean-item ${checkedIds.has(r.id) ? 'checked' : ''}" data-id="${r.id}">
        <span class="level-dot level-${r.level}"></span>
        <div class="c-info">
          <div class="c-name">${r.name}</div>
          <div class="c-note">${r.note}</div>
        </div>
        <span class="c-size">${fmtBytes(r.size)}</span>
        <span class="c-check">${checkedIds.has(r.id) ? '✓' : ''}</span>
      </div>`).join('');

  const cleanList = document.getElementById('cleanList');
  cleanList.innerHTML = (rows ? `<div class="clean-all" id="cleanAll">
      <span class="c-check"></span>
      <span class="pa-label">全选</span>
      <span class="pa-count"></span>
    </div>` : '') + rows;

  const allRow = document.getElementById('cleanAll');
  const syncAll = () => {
    if (!allRow) return;
    const selectable = scanResults.filter((r) => r.size > 0);
    const total = selectable.length;
    const sel = checkedIds.size;
    const size = selectable.filter((r) => checkedIds.has(r.id)).reduce((a, r) => a + r.size, 0);
    const full = total > 0 && sel === total;
    allRow.classList.toggle('all-checked', full);
    allRow.querySelector('.c-check').textContent = full ? '✓' : '';
    allRow.querySelector('.pa-label').textContent = full ? '取消全选' : '全选';
    allRow.querySelector('.pa-count').textContent = sel ? `已选 ${sel}/${total} · ${fmtBytes(size)}` : `共 ${total} 项`;
  };
  syncAll._sync = syncAll;

  if (allRow) {
    allRow.addEventListener('click', () => {
      const selectable = scanResults.filter((r) => r.size > 0);
      const full = checkedIds.size === selectable.length && selectable.length > 0;
      checkedIds.clear();
      if (!full) selectable.forEach((r) => checkedIds.add(r.id));
      document.querySelectorAll('.clean-item').forEach((el) => {
        const on = checkedIds.has(el.dataset.id);
        el.classList.toggle('checked', on);
        el.querySelector('.c-check').textContent = on ? '✓' : '';
      });
      syncAll();
      updateCleanBtn();
    });
  }

  document.querySelectorAll('.clean-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const on = !checkedIds.has(id);
      on ? checkedIds.add(id) : checkedIds.delete(id);
      el.classList.toggle('checked', on);
      el.querySelector('.c-check').textContent = on ? '✓' : '';
      if (syncAll._sync) syncAll._sync();
      updateCleanBtn();
    });
  });

  btn.textContent = '重新扫描';
  btn.disabled = false;
  setState('idle');
  updateCleanBtn();
  if (total > 0) say(`扫出 ${fmtBytes(total)}，勾选后我帮你清`);
});

function updateCleanBtn() {
  const has = checkedIds.size > 0;
  document.getElementById('cleanActions').hidden = !has;
  const btn = document.getElementById('cleanBtn');
  btn.textContent = '清理选中（移入废纸篓）';
  cleanArmed = false;
}

document.getElementById('cleanBtn').addEventListener('click', async () => {
  interact();
  const btn = document.getElementById('cleanBtn');
  // 二次确认防误触
  if (!cleanArmed) {
    cleanArmed = true;
    btn.textContent = `确认清理 ${checkedIds.size} 项？再点一次执行`;
    return;
  }
  btn.disabled = true;
  btn.textContent = '清理中…';
  setState('thinking');
  // 附带扫描时的大小，供 C5 记录释放量
  const sizes = {};
  scanResults.forEach((r) => { sizes[r.id] = r.size; });
  const report = await api.cleanExecute([...checkedIds], sizes);
  const moved = report.reduce((a, r) => a + r.moved, 0);
  const failed = report.reduce((a, r) => a + r.failed, 0);
  document.getElementById('cleanResult').textContent =
    `已移入废纸篓 ${moved} 项${failed ? `，${failed} 项失败（被占用）` : ''}`;
  btn.disabled = false;
  updateCleanBtn();
  setState('happy', 2500);
  say(failed ? '大部分清好了，有些被占用' : '清理完成，清爽多了！');
  refreshCleanHistory();
  // 清完自动重新扫描刷新列表
  document.getElementById('scanBtn').click();
});

// ============ C1/C2/C3 通用勾选清单渲染（含全选行） ============
function renderPickList(container, items, checked, mapFn, onChange) {
  const rows = items.map((it, i) => {
    const v = mapFn(it);
    return `<div class="pick-item ${checked.has(i) ? 'checked' : ''}" data-idx="${i}">
      <span class="p-check">${checked.has(i) ? '✓' : ''}</span>
      <div class="p-info">
        <div class="p-name">${escHtml(v.name)}</div>
        <div class="p-note">${escHtml(v.note || '')}</div>
        ${v.barPct ? `<div class="rank-bar" style="width:${v.barPct}%"></div>` : ''}
      </div>
      ${v.running ? '<span class="running-tag">运行中</span>' : ''}
      <span class="p-size">${fmtBytes(v.size || 0)}</span>
    </div>`;
  }).join('');

  // 全选行：一键全选/全不选，右侧显示已选数量与合计大小
  container.innerHTML = `<div class="pick-all" data-all="1">
    <span class="p-check"></span>
    <span class="pa-label">全选</span>
    <span class="pa-count"></span>
  </div>` + rows;

  const allRow = container.querySelector('.pick-all');
  const syncAll = () => {
    const total = items.length;
    const sel = checked.size;
    const size = [...checked].reduce((a, i) => a + (mapFn(items[i]).size || 0), 0);
    allRow.classList.toggle('all-checked', total > 0 && sel === total);
    allRow.querySelector('.p-check').textContent = (total > 0 && sel === total) ? '✓' : '';
    allRow.querySelector('.pa-label').textContent = (total > 0 && sel === total) ? '取消全选' : '全选';
    allRow.querySelector('.pa-count').textContent = sel ? `已选 ${sel}/${total} · ${fmtBytes(size)}` : `共 ${total} 项`;
  };

  allRow.addEventListener('click', (e) => {
    e.stopPropagation();
    const allOn = items.length > 0 && checked.size === items.length;
    checked.clear();
    if (!allOn) items.forEach((_, i) => checked.add(i));
    container.querySelectorAll('.pick-item').forEach((el) => {
      const i = Number(el.dataset.idx);
      el.classList.toggle('checked', checked.has(i));
      el.querySelector('.p-check').textContent = checked.has(i) ? '✓' : '';
    });
    syncAll();
    onChange();
  });

  container.querySelectorAll('.pick-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(el.dataset.idx);
      const on = !checked.has(idx);
      on ? checked.add(idx) : checked.delete(idx);
      el.classList.toggle('checked', on);
      el.querySelector('.p-check').textContent = on ? '✓' : '';
      syncAll();
      onChange();
    });
  });
  syncAll();
}

// ============ C1：大文件猎人 ============
let bigFiles = [];
let bigFilesScanned = false;
const bigFilesChecked = new Set();

async function scanBigFilesUI() {
  bigFilesScanned = true;
  document.getElementById('bigFilesSummary').textContent = '扫描中…（Spotlight 索引查询）';
  document.getElementById('bigFilesList').innerHTML = '';
  document.getElementById('bigFilesBtn').hidden = true;
  bigFiles = await api.scanBigFiles();
  bigFilesChecked.clear();
  if (!bigFiles.length) {
    document.getElementById('bigFilesSummary').textContent = '没有发现 >500MB 的大文件';
    return;
  }
  document.getElementById('bigFilesSummary').textContent = `发现 ${bigFiles.length} 个大文件（黄队：勾选后二次确认）`;
  renderPickList(
    document.getElementById('bigFilesList'), bigFiles, bigFilesChecked,
    (f) => ({ name: f.name, note: (f.lastUsed ? `最后打开 ${f.lastUsed}` : '很久没打开') + ` · ${f.path}`, size: f.size }),
    updateBigFilesBtn
  );
  updateBigFilesBtn();
}
function updateBigFilesBtn() {
  const btn = document.getElementById('bigFilesBtn');
  btn.hidden = bigFilesChecked.size === 0;
  btn.textContent = `清理选中 ${bigFilesChecked.size} 项`;
}
document.getElementById('bigFilesBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const entries = [...bigFilesChecked].map((i) => ({ path: bigFiles[i].path, name: bigFiles[i].name, size: bigFiles[i].size }));
  await trashWithConfirm(entries, { level: 'yellow', title: '清理大文件' });
  bigFilesScanned = false;
  scanBigFilesUI();
});

// ============ C2：按 App 缓存排行 ============
let cacheRank = [];
let cacheRankScanned = false;
const cacheRankChecked = new Set();

async function scanCacheRankUI() {
  cacheRankScanned = true;
  document.getElementById('cacheRankSummary').textContent = '统计中…（du 计算目录大小）';
  document.getElementById('cacheRankList').innerHTML = '';
  document.getElementById('cacheRankBtn').hidden = true;
  cacheRank = await api.getCacheRanking();
  cacheRankChecked.clear();
  if (!cacheRank.length) {
    document.getElementById('cacheRankSummary').textContent = '缓存目录是空的';
    return;
  }
  const total = cacheRank.reduce((a, r) => a + r.size, 0);
  document.getElementById('cacheRankSummary').textContent = `Top${cacheRank.length} 共 ${fmtBytes(total)}`;
  const max = cacheRank[0].size || 1;
  renderPickList(
    document.getElementById('cacheRankList'), cacheRank, cacheRankChecked,
    (r) => ({ name: r.name, note: r.path, size: r.size, running: r.running, barPct: Math.round((r.size / max) * 100) }),
    updateCacheRankBtn
  );
  updateCacheRankBtn();
}
function updateCacheRankBtn() {
  const btn = document.getElementById('cacheRankBtn');
  btn.hidden = cacheRankChecked.size === 0;
  btn.textContent = `清理选中 ${cacheRankChecked.size} 项`;
}
document.getElementById('cacheRankBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const entries = [...cacheRankChecked].map((i) => ({ path: cacheRank[i].path, name: cacheRank[i].name, size: cacheRank[i].size }));
  await trashWithConfirm(entries, { level: 'green', title: '清理应用缓存' });
  cacheRankScanned = false;
  scanCacheRankUI();
});

// ============ C3：应用残留 ============
let leftovers = [];
let leftoversScanned = false;
const leftoverChecked = new Set();

async function scanLeftoversUI() {
  leftoversScanned = true;
  document.getElementById('leftoverSummary').textContent = '比对中…（已安装 App × 支持目录）';
  document.getElementById('leftoverList').innerHTML = '';
  document.getElementById('leftoverBtn').hidden = true;
  leftovers = await api.scanLeftovers();
  leftoverChecked.clear();
  if (!leftovers.length) {
    document.getElementById('leftoverSummary').textContent = '没有发现疑似残留，很干净';
    return;
  }
  document.getElementById('leftoverSummary').textContent = `发现 ${leftovers.length} 个疑似孤儿目录（请确认后再清）`;
  renderPickList(
    document.getElementById('leftoverList'), leftovers, leftoverChecked,
    (o) => ({ name: o.name, note: o.note, size: o.size }),
    updateLeftoverBtn
  );
  updateLeftoverBtn();
}
function updateLeftoverBtn() {
  const btn = document.getElementById('leftoverBtn');
  btn.hidden = leftoverChecked.size === 0;
  btn.textContent = `清理选中 ${leftoverChecked.size} 项`;
}
document.getElementById('leftoverBtn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const picked = [...leftoverChecked].map((i) => leftovers[i]);
  // 任一为黄队则整体按黄队确认（列完整路径）
  const level = picked.some((o) => o.level === 'yellow') ? 'yellow' : 'green';
  const entries = picked.map((o) => ({ path: o.path, name: o.name, size: o.size }));
  await trashWithConfirm(entries, { level, title: '清理应用残留' });
  leftoversScanned = false;
  scanLeftoversUI();
});

// ============ C5：清理历史 & 释放统计 ============
async function refreshCleanHistory() {
  try {
    const h = await api.getCleanHistory();
    document.getElementById('cleanHistSummary').textContent = h.totalFreed > 0
      ? `已释放 ${fmtBytes(h.totalFreed)}（近 30 天 ${fmtBytes(h.freed30d)}）`
      : '还没有清理记录';
    document.getElementById('cleanHistList').innerHTML = h.records.length
      ? h.records.slice(0, 30).map((r) => {
          const d = new Date(r.t);
          const time = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          const names = r.items.map((i) => escHtml(i.name)).slice(0, 3).join('、');
          return `<div class="msg-item">
            <div class="msg-title">${names}${r.items.length > 3 ? ` 等 ${r.items.length} 项` : ''}</div>
            <div class="msg-time">${time} · 释放 ${fmtBytes(r.total)}</div>
          </div>`;
        }).join('')
      : '暂无记录';
  } catch {}
}

// ============ C4 + A1：智能建议 ============
let currentAdvice = null;
let dismissedAdviceId = null;
const seenAdviceIds = new Set();

async function checkAdvice() {
  try {
    const list = await api.getAdvice();
    renderCleanAdvice(list);
    // A1：首页最多 1 条
    const top = list.find((a) => a.id !== dismissedAdviceId);
    if (!top) {
      document.getElementById('adviceCard').hidden = true;
      currentAdvice = null;
      return;
    }
    currentAdvice = top;
    document.getElementById('adviceCard').hidden = false;
    document.getElementById('adviceText').textContent = `${top.icon} ${top.title}`;
    document.getElementById('adviceDetail').textContent = top.detail;
    document.getElementById('adviceBtn').textContent = top.action === 'clean-paths' ? '去清理' : '去看看';
    // A2：新建议出现时 Mio 表情联动（每个 id 每会话只提示一次）
    if (!seenAdviceIds.has(top.id)) {
      seenAdviceIds.add(top.id);
      api.logMessage('Mio · 建议', `${top.title} — ${top.detail}`);
      if (top.id === 'disk-low') {
        setState('surprised', 1800);
      } else if (state === 'idle' || state === 'sleepy') {
        setState('curious', 4000);
      }
      if (!panelOpen && !dndActive()) say(top.title, 4000); // v1.6：专注/免打扰期不冒泡（卡片仍可在面板看到）
    }
  } catch {}
}

// 清理页建议列表（可多条）
function renderCleanAdvice(list) {
  const box = document.getElementById('cleanAdvice');
  box.innerHTML = list.map((a, i) => `
    <div class="advice-item" data-idx="${i}">
      <span class="a-icon">${a.icon}</span>
      <div class="a-info">
        <div class="a-title">${escHtml(a.title)}</div>
        <div class="a-detail">${escHtml(a.detail)}</div>
      </div>
      <button class="a-btn" data-idx="${i}">${a.action === 'clean-paths' ? '清理' : '定位'}</button>
    </div>`).join('');
  box.querySelectorAll('.a-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleAdviceAction(list[Number(btn.dataset.idx)]);
    });
  });
}

// 建议动作分发
async function handleAdviceAction(a) {
  if (!a) return;
  interact();
  if (a.action === 'bigfiles') {
    switchTab('clean');
    expandCard(document.getElementById('bigFilesCard'));
  } else if (a.action === 'open-clean') {
    switchTab('clean');
    document.getElementById('scanBtn').click();
  } else if (a.action === 'open-status') {
    switchTab('status');
    expandCard(document.getElementById('procCard'));
  } else if (a.action === 'clean-paths') {
    switchTab('clean');
    await trashWithConfirm(a.paths || [], { level: 'yellow', title: '清理建议项' });
    checkAdvice();
  }
}

document.getElementById('adviceBtn').addEventListener('click', () => handleAdviceAction(currentAdvice));
document.getElementById('adviceClose').addEventListener('click', () => {
  if (currentAdvice) dismissedAdviceId = currentAdvice.id;
  document.getElementById('adviceCard').hidden = true;
});
// 建议每 2 分钟刷新一次（主进程侧有 10 分钟缓存，重命令不会频繁跑）
setInterval(checkAdvice, 120000);

// ============ 番茄钟 ============
// v1.6 C10：默认时长走 settings.pomodoro.work（25/45/60）；休息固定 5 分钟
const POMO_REST = 5 * 60;
const workSeconds = () => (Number(settings.pomodoro && settings.pomodoro.work) || 25) * 60;
let pomoLeft = workSeconds();
let pomoRunning = false;
let pomoPhase = 'work';
let pomoTimer = null;

const pomoTimeEl = document.getElementById('pomoTime');
const pomoStateEl = document.getElementById('pomoState');
const pomoDot = document.getElementById('pomoDot');

function fmt(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function renderPomo() {
  pomoTimeEl.textContent = fmt(pomoLeft);
  pomoDot.classList.toggle('on', pomoRunning);
  working = pomoRunning && pomoPhase === 'work';
  focusMode = working; // v1.6 FOCUS-1/2：仅「运行中的工作阶段」才算专注
  mioEl.classList.toggle('mio--working', working);
  if (pomoRunning && pomoPhase === 'work') pomoStateEl.textContent = '专注中 · 已开启免打扰';
  else if (pomoRunning && pomoPhase === 'rest') pomoStateEl.textContent = '休息中…';
}

document.getElementById('pomodoroCard').addEventListener('click', () => {
  interact();
  if (pomoRunning) {
    clearInterval(pomoTimer);
    pomoRunning = false;
    pomoLeft = pomoPhase === 'work' ? workSeconds() : POMO_REST;
    pomoStateEl.textContent = '已停止，点击重新开始';
    setState('idle');
  } else {
    pomoRunning = true;
    pomoLeft = pomoPhase === 'work' ? workSeconds() : POMO_REST; // 每轮开始取最新配置（C10：下一轮生效）
    pomoStateEl.textContent = pomoPhase === 'work' ? '专注中 · 已开启免打扰' : '休息中…';
    setState('thinking');
    say(pomoPhase === 'work' ? '开始专注，我陪着你' : '休息一下吧');
    pomoTimer = setInterval(() => {
      pomoLeft--;
      renderPomo();
      if (pomoLeft <= 0) {
        if (pomoPhase === 'work') {
          pomoPhase = 'rest';
          pomoLeft = POMO_REST;
          // 番茄钟自身阶段切换通知不受专注抑制（FOCUS-1），照常发
          notifyUser('Mio · 番茄钟', '专注结束，休息 5 分钟吧', { sayText: '干得漂亮！休息一下' });
          setState('happy', 3000);
        } else {
          pomoPhase = 'work';
          pomoLeft = workSeconds();
          notifyUser('Mio · 番茄钟', '休息结束，开始下一轮专注', { sayText: '继续加油！' });
        }
        pomoStateEl.textContent = pomoPhase === 'work' ? '专注中 · 已开启免打扰' : '休息中…';
      }
    }, 1000);
  }
  renderPomo();
});
renderPomo();

// ============ 快捷提醒 ============
document.querySelectorAll('.btn.reminder').forEach((btn) => {
  btn.addEventListener('click', () => {
    interact();
    const min = Number(btn.dataset.min);
    document.getElementById('reminderInfo').textContent = `已设定：${min} 分钟后提醒`;
    say(`好的，${min} 分钟后叫你`);
    setTimeout(() => {
      if (dndActive()) return; // v1.6：专注/免打扰期内到点的快捷提醒直接跳过
      notifyUser('Mio · 提醒', `${min} 分钟到了！`, { sayText: '时间到啦！', ms: 4000 });
      setState('surprised', 2000);
    }, min * 60 * 1000);
  });
});

// ============ v1.4 C：健康提醒中心 ============
// 三个独立定时器会变成通知轰炸（久坐 + 喝水 + 护眼 + 番茄钟 + 建议 + 磁盘告警），
// 这里统一调度：单一 1 分钟 tick + 任意两次提醒最小间隔 3 分钟
const HEALTH_ITEMS = [
  { key: 'sit',   period: 45 * 60 * 1000, title: 'Mio · 久坐提醒', body: '已经坐了很久啦，起来活动一下', say: '起来走走吧～' },
  { key: 'water', period: 45 * 60 * 1000, title: 'Mio · 喝水提醒', body: '喝点水吧，顺便伸个懒腰', say: '该喝水啦～' },
  { key: 'eye',   period: 20 * 60 * 1000, title: 'Mio · 护眼提醒', body: '看看 20 英尺外，让眼睛歇 20 秒', say: '让眼睛歇一会儿' },
];
const HEALTH_MIN_GAP = 3 * 60 * 1000;
const healthLast = { sit: 0, water: 0, eye: 0 };
let healthLastAny = 0;

function healthTick() {
  const h = settings.health;
  if (!h.enabled) return;
  const now = Date.now();
  const silenced = dndActive(); // v1.6：专注/免打扰期内静默
  if (!silenced && now - healthLastAny < HEALTH_MIN_GAP) return; // 最小间隔：避免扎堆轰炸
  // 到点的多项里只发「最久没提醒」的那一条，其余顺延到下一个 tick
  const due = HEALTH_ITEMS
    .filter((it) => h[it.key] && now - (healthLast[it.key] || 0) >= it.period)
    .sort((a, b) => (healthLast[a.key] || 0) - (healthLast[b.key] || 0))[0];
  if (!due) return;
  // 静默期：推进计时戳但不发（跳过、不补发），避免专注/免打扰结束后连响一串（Q7）
  healthLast[due.key] = now;
  healthLastAny = now;
  if (silenced) return;
  notifyUser(due.title, due.body, { sayText: due.say, ms: 3500 });
  setState('curious', 3000);
}

// 启动/开关变更后重置计时起点，避免刚开机就立刻提醒
function resetHealthTimers() {
  const now = Date.now();
  HEALTH_ITEMS.forEach((it) => { healthLast[it.key] = now; });
  healthLastAny = now;
}
resetHealthTimers();
setInterval(healthTick, 60 * 1000);

// ============ v1.5 设置中心 —— 控件绑定 ============
// 球体尺寸走 zoom：表情各状态里写死了大量 px，zoom 能整体等比缩放且仍参与布局
const ORB_ZOOM = { sm: 0.8, md: 1, lg: 1.13 };

// 主题：深色 / 浅色 / 跟随系统。matchMedia 直接反映系统外观，不需要走 IPC。
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = settings.appearance.theme;
  const light = t === 'light' || (t === 'auto' && !darkQuery.matches);
  document.body.classList.toggle('theme-light', light);
}
darkQuery.addEventListener('change', () => {
  if (settings.appearance.theme === 'auto') applyTheme();
});

function applyAppearance() {
  const a = settings.appearance;
  const size = ORB_ZOOM[a.size] ? a.size : 'md';
  document.body.classList.toggle('reduce-motion', !!a.reduceMotion);
  applyTheme();
  // 球体等比缩放：zoom 会真实改变布局占位，flex 里不会错位
  mioEl.style.zoom = String(ORB_ZOOM[size]);
  gazeEnabled = !!a.gaze;
  if (!a.gaze) pupils.forEach((p) => (p.style.transform = 'translate(0px, 0px)'));
  if (!a.clickThrough) api.setInteractive(true);
}

// 分段控件（球体尺寸 / 条数 / 通知方式 …）：纯数字档位自动转 Number 落盘
function bindSeg(id, path) {
  const box = document.getElementById(id);
  if (!box) return;
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (!btn) return;
    interact();
    const raw = btn.dataset.v;
    const val = /^\d+$/.test(raw) ? Number(raw) : raw;
    patchSettings(buildPatch(path, val), applyAppearance);
  });
}

// 滑块：拖动时标签跟手，IPC 写入按 80ms 节流，避免一路刷盘
// 百分数滑块（0–100）→ 单位区间浮点。不透明度的存储口径是 0–1 的小数，
// 换算只在 bindRange 的 toStore 里发生一次，避免「滑块 ×100、存储又 ×100」这类量纲错乱。
const pctToUnit = (lo, hi) => (pct) => Math.min(hi, Math.max(lo, Math.round(Number(pct)) / 100));

function bindRange(id, path, fmt, after, toStore) {
  const el = document.getElementById(id);
  if (!el) return;
  let timer = null;
  const push = () => {
    const raw = Number(el.value);
    const v = toStore ? toStore(raw) : raw;
    patchSettings(buildPatch(path, v), () => { applyAppearance(); if (after) after(raw); });
  };
  el.addEventListener('input', () => {
    interact();
    if (fmt) fmt(Number(el.value));
    clearTimeout(timer);
    timer = setTimeout(push, 80);
  });
  el.addEventListener('change', () => { clearTimeout(timer); push(); });
}

// 隐身名单
function renderStealthList() {
  const box = document.getElementById('stealthList');
  if (!box) return;
  const apps = settingsMeta.stealthApps || [];
  if (!apps.length) { box.innerHTML = ''; return; }
  box.innerHTML = apps.map((a) => `
    <div class="sl-item">
      <span class="sl-name">${escHtml(a.name)}</span>
      <span class="sl-id">${escHtml(a.id)}</span>
      <button class="sl-del" data-id="${escHtml(a.id)}" title="移除">✕</button>
    </div>`).join('');
}

async function fillDisplays() {
  const sel = document.getElementById('selDisplay');
  if (!sel) return;
  let list = [];
  try { list = await api.getDisplays(); } catch {}
  if (!list || !list.length) list = [{ id: '0', label: '主屏' }];
  settingsMeta.displays = list;
  const cur = settings.appearance.displayId == null ? '' : String(settings.appearance.displayId);
  sel.innerHTML = '<option value="">跟随鼠标所在屏幕</option>'
    + list.map((d) => `<option value="${escHtml(d.id)}">${escHtml(d.label)}</option>`).join('');
  sel.value = list.some((d) => String(d.id) === cur) ? cur : '';
}

bindSwitch('swLogin', 'login');
bindSwitch('swAutoOpen', ['general', 'autoOpen']);
bindSwitch('swChime', ['chime', 'enabled']);
bindSwitch('swChimeNotify', ['chime', 'notify']);
bindSwitch('swHealth', ['health', 'enabled']);
bindSwitch('swSit', ['health', 'sit'], resetHealthTimers);
bindSwitch('swWater', ['health', 'water'], resetHealthTimers);
bindSwitch('swEye', ['health', 'eye'], resetHealthTimers);
bindSwitch('swStealth', ['stealth', 'enabled']);
// 外观
bindSwitch('swOnTop', ['appearance', 'onTop'], applyAppearance);
bindSwitch('swGaze', ['appearance', 'gaze'], applyAppearance);
bindSwitch('swClickThrough', ['appearance', 'clickThrough'], applyAppearance);
bindSwitch('swReduceMotion', ['appearance', 'reduceMotion'], applyAppearance);
bindSeg('segSize', ['appearance', 'size']);
bindSeg('segTheme', ['appearance', 'theme']);
bindRange('rngOpacity', ['appearance', 'opacity'],
  (v) => { const n = document.getElementById('opacityVal'); if (n) n.textContent = `${v}%`; },
  null, pctToUnit(0.3, 1));
bindRange('rngStealthOpacity', ['stealth', 'opacity'],
  (v) => { const n = document.getElementById('stealthOpacityVal'); if (n) n.textContent = `${v}%`; },
  null, pctToUnit(0.05, 0.9));

const selDisplay = document.getElementById('selDisplay');
if (selDisplay) {
  selDisplay.addEventListener('change', () => {
    interact();
    const v = selDisplay.value;
    patchSettings({ appearance: { displayId: v || null } });
  });
}

const stealthListEl = document.getElementById('stealthList');
if (stealthListEl) {
  stealthListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.sl-del');
    if (!btn) return;
    interact();
    const id = btn.dataset.id;
    const apps = (settingsMeta.stealthApps || []).filter((a) => a.id !== id);
    const hint = document.getElementById('stealthHint');
    if (hint) hint.textContent = `已移除，剩 ${apps.length} 个`;
    patchSettings({ stealth: { apps } });
  });
}

const stealthAddBtn = document.getElementById('stealthAdd');
if (stealthAddBtn) {
  stealthAddBtn.addEventListener('click', async () => {
    interact();
    const hint = document.getElementById('stealthHint');
    const r = await api.stealthCapture();
    if (!r || !r.ok) {
      if (hint) hint.textContent = (r && r.error) || '没识别到其他应用';
      say((r && r.error) || '没识别到');
      return;
    }
    settingsMeta.stealthApps = r.apps;
    if (hint) hint.textContent = `已添加 ${r.app.name}`;
    renderSettings();
  });
}

const stealthResetBtn = document.getElementById('stealthReset');
if (stealthResetBtn) {
  stealthResetBtn.addEventListener('click', () => {
    interact();
    const hint = document.getElementById('stealthHint');
    if (hint) hint.textContent = '已恢复内置名单';
    patchSettings({ stealth: { apps: null } });
  });
}

// 首页的「打开设置」入口
const homeToSettings = document.getElementById('homeToSettings');
if (homeToSettings) homeToSettings.addEventListener('click', () => { interact(); switchTab('settings'); });

// 设置搜索：按行匹配，命中行所在的整组自动展开，无命中则整组隐藏
function filterSettings() {
  const box = document.getElementById('setSearch');
  const q = (box ? box.value : '').trim().toLowerCase();
  const groups = [...document.querySelectorAll('#page-settings .sgroup')];
  let hits = 0;
  groups.forEach((g) => {
    const rows = [...g.querySelectorAll('.set-row, .set-note')];
    if (!q) {
      rows.forEach((r) => (r.hidden = false));
      g.hidden = false;
      g.dataset.autoOpen = '';
      return;
    }
    let local = 0;
    rows.forEach((r) => {
      const hit = r.textContent.toLowerCase().includes(q);
      r.hidden = !hit;
      if (hit) local++;
    });
    g.hidden = local === 0;
    if (local > 0) { hits += local; if (!g.open) g.open = true; }
  });
  const more = document.getElementById('setMore');
  if (more) more.textContent = q && !hits
    ? `没有匹配「${box.value.trim()}」的设置项`
    : (q ? `匹配 ${hits} 项` : '外观与主题 · 剪贴板 · 天气 · AI 助手 · 权限，将随后续版本陆续加入');
}
const setSearch = document.getElementById('setSearch');
if (setSearch) setSearch.addEventListener('input', filterSettings);

// ==================================================================
// v1.6 B2-1：剪贴板历史（卡片/详情渲染与交互）
// ==================================================================
let clipState = { items: [], paused: false, enabled: true, limit: 10, pinnedCount: 0 };

async function refreshClip() {
  let r = null;
  try { r = await api.clipList(); } catch {}
  if (r && r.ok) clipState = r;
  renderClipCard();
}

function renderClipCard() {
  const brief = document.getElementById('clipBrief');
  const badge = document.getElementById('clipBadge');
  const hint = document.getElementById('clipHint');
  const count = document.getElementById('clipCount');
  const pauseBtn = document.getElementById('clipPauseBtn');
  const limit = clipState.limit || 10;
  if (brief) brief.textContent = clipState.enabled ? `最近 ${clipState.items.length} / ${limit} 条` : '采集已关闭';
  if (badge) badge.textContent = clipState.paused ? '⏸ 已暂停' : '';
  if (hint) hint.textContent = `最近 ${limit} 条`;
  if (count) count.textContent = clipState.items.length ? `${clipState.items.length} 条 · 钉 ${clipState.pinnedCount}/3` : '暂无记录';
  if (pauseBtn) pauseBtn.textContent = clipState.paused ? '继续' : '暂停';
  const list = document.getElementById('clipList');
  if (!list) return;
  list.innerHTML = clipState.items.length
    ? clipState.items.map((it) => `
      <div class="clip-item" data-id="${escHtml(it.id)}">
        <span class="clip-text" title="${escHtml(it.preview)}">${escHtml(it.preview)}</span>
        <button class="clip-pin ${it.pinned ? 'on' : ''}" data-id="${escHtml(it.id)}" title="${it.pinned ? '取消钉住' : '钉住（最多 3 条）'}">📌</button>
        <button class="clip-del" data-id="${escHtml(it.id)}" title="删除">✕</button>
      </div>`).join('')
    : '<div class="clip-empty">还没有记录，复制点文本试试</div>';
}

const clipListEl = document.getElementById('clipList');
if (clipListEl) {
  clipListEl.addEventListener('click', async (e) => {
    const del = e.target.closest('.clip-del');
    const pin = e.target.closest('.clip-pin');
    const row = e.target.closest('.clip-item');
    interact();
    if (del) {
      await api.clipDelete(del.dataset.id);
      await refreshClip();
      return;
    }
    if (pin && row) {
      const id = pin.dataset.id;
      const item = clipState.items.find((i) => i.id === id);
      const r = item && item.pinned ? await api.clipUnpin(id) : await api.clipPin(id);
      if (r && !r.ok) say(r.error || '操作失败');
      await refreshClip();
      return;
    }
    if (row) {
      const r = await api.clipCopy(row.dataset.id);
      if (!r || !r.ok) { say((r && r.error) || '取回失败'); return; }
      row.classList.add('copied');
      say('已复制到剪贴板', 1600);
      setTimeout(() => row.classList.remove('copied'), 700);
      await refreshClip();
    }
  });
}

const clipPauseBtn = document.getElementById('clipPauseBtn');
if (clipPauseBtn) clipPauseBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  interact();
  const r = await api.clipPause(!clipState.paused);
  if (r && r.ok) say(r.paused ? '已暂停记录' : '已恢复记录');
  await refreshClip();
});

const clipClearBtn = document.getElementById('clipClearBtn');
if (clipClearBtn) clipClearBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  interact();
  if (!clipState.items.length) { say('已经是空的'); return; }
  const ok = await showConfirm({
    title: '清除全部剪贴板记录？',
    body: `将清空 ${clipState.items.length} 条记录（只删内存副本，不影响系统剪贴板当前内容）。`,
    okText: '全部清除',
  });
  if (!ok) return;
  await api.clipClear();
  await refreshClip();
  say('已清空剪贴板记录');
});

// 主进程推来变更/提示
api.onClipChanged(() => { refreshClip(); });
api.onClipNotice(() => { say('刚才那条像密码，已跳过收录', 3200); });

// ==================================================================
// v1.6 B2-2：快捷操作三件套 + 权限引导
// ==================================================================
const qaNoticeEl = document.getElementById('qaNotice');

// 失败态双通道之一：面板内一行可点提示（含「去系统设置」深链）
function notice(which, text) {
  if (!qaNoticeEl) return;
  qaNoticeEl.hidden = false;
  qaNoticeEl.innerHTML = `${escHtml(text)} <span class="qa-link" data-which="${which}">去系统设置 →</span>`;
}
function clearNotice() { if (qaNoticeEl) qaNoticeEl.hidden = true; }

if (qaNoticeEl) qaNoticeEl.addEventListener('click', (e) => {
  const link = e.target.closest('.qa-link');
  if (!link) return;
  interact();
  api.permOpen(link.dataset.which);
  say('已打开系统设置，改完回到 Mio 再试一次', 3500);
});

async function refreshTrashBtn() {
  const btn = document.getElementById('qaTrash');
  if (!btn) return;
  let t = null;
  try { t = await api.trashSize(); } catch {}
  if (!t || !t.bytes) { btn.disabled = true; btn.textContent = '废纸篓已是空的'; }
  else { btn.disabled = false; btn.textContent = `清空废纸篓 · ${fmtBytes(t.bytes)}`; }
}

// 统一说明弹层：三项权限一次讲清，只弹一次（标志跨重启保存在 settings.consent）
const introOverlay = document.getElementById('introOverlay');
function showIntro() {
  return new Promise((resolve) => {
    if (!introOverlay) return resolve(true);
    const go = document.getElementById('introGo');
    const later = document.getElementById('introLater');
    const cleanup = () => { go.removeEventListener('click', onGo); later.removeEventListener('click', onLater); };
    const onGo = () => { cleanup(); introOverlay.hidden = true; resolve(true); };
    const onLater = () => { cleanup(); introOverlay.hidden = true; resolve(false); };
    go.addEventListener('click', onGo);
    later.addEventListener('click', onLater);
    introOverlay.hidden = false;
  });
}
async function ensurePermIntro() {
  if (settings.consent && settings.consent.permsIntroSeen) return true;
  const ok = await showIntro();
  if (ok) await patchSettings(buildPatch(['consent', 'permsIntroSeen'], true));
  return ok; // 点「稍后」→ 本次不执行、不改标志（下次仍会讲一次）
}

const qaLock = document.getElementById('qaLock');
if (qaLock) qaLock.addEventListener('click', async (e) => {
  e.stopPropagation();
  interact();
  if (!(await ensurePermIntro())) return;
  // 探测用 (false) 不弹窗；用户点过「继续」后才用 (true) 触发系统辅助功能弹窗
  await api.permRequest('accessibility');
  const r = await api.actLock();
  if (r && r.locked) { clearNotice(); say('已锁屏', 2000); }
  else {
    notice('accessibility', '已熄屏但没有锁定。要真锁屏，去开启辅助功能。');
    say('已让屏幕睡下，但没有锁定', 3500);
  }
});

const qaShot = document.getElementById('qaShot');
if (qaShot) qaShot.addEventListener('click', async (e) => {
  e.stopPropagation();
  interact();
  if (!(await ensurePermIntro())) return;
  const snap = await api.permStatus();
  if (snap && (snap.screen === 'denied' || snap.screen === 'restricted')) {
    notice('screen', '没有屏幕录制权限，截图会是空白。');
    say('没有屏幕录制权限，截图会是空白', 3600);
    return;
  }
  const r = await api.actScreenshot({ mode: settings.capture.mode });
  if (r && r.canceled) return; // Esc 取消 → 静默，不报错、不写历史
  if (!r || !r.ok) {
    if (r && r.need === 'screen') { notice('screen', '没有屏幕录制权限，截图会是空白。'); say('没有屏幕录制权限，截图会是空白', 3600); }
    else say((r && r.error) || '截图没有完成');
    return;
  }
  if (r.blank) {
    notice('screen', '若截图是空白，请重启 Mio 后重试（屏幕录制授权后需重启生效）。');
    say('已截图。若为空白，请重启 Mio 后再试', 4200);
  } else {
    clearNotice();
    say('已复制到剪贴板', 2000);
  }
});

const qaTrash = document.getElementById('qaTrash');
if (qaTrash) qaTrash.addEventListener('click', async (e) => {
  e.stopPropagation();
  interact();
  const t = await api.trashSize();
  if (!t || !t.bytes) { say('废纸篓已经是空的'); refreshTrashBtn(); return; }
  // 硬约束 2：清空废纸篓是本产品唯一不可逆操作，强制二次确认且先亮释放量
  const ok = await showConfirm({
    title: `清空废纸篓？可释放 ${fmtBytes(t.bytes)}`,
    body: `将永久删除废纸篓内约 ${t.count} 项，共 ${fmtBytes(t.bytes)}。\n这是不可恢复的操作。\n（Mio 只调用系统原生「清空废纸篓」，绝不使用 rm）`,
    okText: '永久清空',
  });
  if (!ok) return;
  if (!(await ensurePermIntro())) return;
  const r = await api.trashEmpty();
  if (!r || !r.ok) {
    if (r && r.need === 'automation') { notice('automation', '需要「自动化 · 控制 Finder」权限才能清空废纸篓。'); say('清空废纸篓需要先授权', 3500); }
    else { notice('automation', (r && r.error) || '清空失败，请稍后再试。'); say((r && r.error) || '清空失败', 3000); }
    return;
  }
  clearNotice();
  say(r.failed ? `已清空 ${r.removed} 项，${r.failed} 项被占用跳过` : `已清空废纸篓，释放 ${fmtBytes(t.bytes)}`, 3500);
  refreshTrashBtn();
});

// ==================================================================
// v1.6 B2-3：快捷键录制器（code → accelerator 映射 + 回滚提示）
// ==================================================================
const ACCEL_MOD_ORDER = ['Command', 'Control', 'Alt', 'Shift'];
const MODIFIER_CODES = new Set(['MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'CapsLock']);
const MAIN_KEY_CODE = {
  Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Escape: 'Escape',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
};
// e.code（物理键位，与输入法无关）→ Electron accelerator 主键
function keyFromCode(code) {
  if (!code) return '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  return MAIN_KEY_CODE[code] || '';
}
function isModifierOnly(code) {
  if (!code) return false;
  if (MODIFIER_CODES.has(code)) return true;
  return /^(Meta|Control|Alt|Shift|OS)(Left|Right)$/.test(code);
}
function canonical(mods, key) {
  return [...ACCEL_MOD_ORDER.filter((m) => mods.includes(m)), key].join('+');
}
// 只按修饰键 / 无 Cmd|Ctrl|Alt / 认不出的键（多媒体等）→ 返回空串，调用方据此提示
function accelFromEvent(e) {
  const code = (e && e.code) || '';
  if (!code || isModifierOnly(code)) return '';
  const key = keyFromCode(code);
  if (!key) return '';
  const mods = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!(mods.includes('Command') || mods.includes('Control') || mods.includes('Alt'))) return '';
  return canonical(mods, key);
}
function accelLabel(acc) {
  if (!acc) return '—';
  return String(acc).replace(/Command/g, '⌘').replace(/Control/g, '⌃').replace(/Alt/g, '⌥').replace(/Shift/g, '⇧').replace(/\+/g, '');
}
function notifyStyleLabel() {
  return { bubble: '只气泡', system: '只系统通知', both: '气泡+系统' }[settings.notify.style] || '气泡+系统';
}

let recordingKey = false;
const keyRecEl = document.getElementById('keyRec');
const keyRecBtnEl = document.getElementById('keyRecBtn');
const keyHintEl = document.getElementById('keyHint');

function renderKeyRec() {
  if (keyRecEl && !recordingKey) keyRecEl.textContent = accelLabel(settings.hotkey.trigger);
}
function setKeyHint(text, color) {
  if (!keyHintEl) return;
  keyHintEl.textContent = text;
  keyHintEl.style.color = color || '';
}
function startKeyRecord() {
  if (recordingKey) { stopKeyRecord(); return; }
  recordingKey = true;
  if (keyRecEl) { keyRecEl.classList.add('recording'); keyRecEl.textContent = '按下新快捷键…'; }
  if (keyRecBtnEl) keyRecBtnEl.textContent = '取消';
  setKeyHint('请按下新的组合键（Esc 取消）');
}
function stopKeyRecord() {
  recordingKey = false;
  if (keyRecEl) keyRecEl.classList.remove('recording');
  if (keyRecBtnEl) keyRecBtnEl.textContent = '录制';
  renderKeyRec();
}

document.addEventListener('keydown', async (e) => {
  if (!recordingKey) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    stopKeyRecord();
    setKeyHint('已取消录制');
    return;
  }
  if (isModifierOnly(e.code)) { setKeyHint('请再按一个字母 / 数字 / 功能键'); return; }
  const acc = accelFromEvent(e);
  if (!acc) { setKeyHint('这个键 Mio 认不出来，换个组合'); return; }
  if (acc === 'Alt+H') { setKeyHint('与手动隐藏键冲突'); return; }
  const r = await api.hotkeyRecord(acc);
  stopKeyRecord();
  if (r && r.ok) {
    settings.hotkey.trigger = r.trigger;
    renderSettings();
    setKeyHint(`已设为 ${accelLabel(r.trigger)}，立即生效`, 'var(--mi-accent)');
  } else {
    setKeyHint((r && r.error) || '这个组合注册失败，已还原');
  }
});
if (keyRecBtnEl) keyRecBtnEl.addEventListener('click', (e) => { e.stopPropagation(); interact(); startKeyRecord(); });
if (keyRecEl) keyRecEl.addEventListener('click', (e) => { e.stopPropagation(); interact(); startKeyRecord(); });

const keyResetEl = document.getElementById('keyReset');
if (keyResetEl) keyResetEl.addEventListener('click', async (e) => {
  e.stopPropagation();
  interact();
  const r = await api.hotkeyReset();
  if (r && r.ok) {
    settings.hotkey.trigger = r.trigger;
    stopKeyRecord();
    renderSettings();
    setKeyHint(`已恢复为 ${accelLabel(r.trigger)}`, 'var(--mi-accent)');
  } else {
    setKeyHint((r && r.error) || '恢复失败');
  }
});

// ============ v1.6：设置绑定 ============
bindSwitch('swClip', ['clipboard', 'enabled'], refreshClip);
bindSwitch('swClipPwd', ['clipboard', 'filterPassword']);
bindSeg('segClipLimit', ['clipboard', 'limit']);
bindSeg('segCapture', ['capture', 'mode']);
bindSeg('segNotifyStyle', ['notify', 'style']);
bindSeg('segPomoWork', ['pomodoro', 'work']);

loadSettings();

// 启动问候
setTimeout(() => say('嗨，我是 Mio'), 800);
