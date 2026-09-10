// Mio 渲染层：表情状态机 + 生命感动画 + 快捷面板
// 同时兼容 Electron（window.mio 存在）与纯浏览器预览（降级运行）
// 注意：id="mio" 的元素会作为命名属性挂到 window.mio，
// 所以必须通过方法签名来甄别真正的 Electron 桥接对象
const bridge = (window.mio && typeof window.mio.getStats === 'function') ? window.mio : null;
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
    if (state === 'idle' || state === 'curious') {
      eyes.forEach((e) => e.classList.add('blink'));
      setTimeout(() => eyes.forEach((e) => e.classList.remove('blink')), 120);
    }
    blinkLoop();
  }, delay);
}
blinkLoop();

// ============ 生命感：困倦 ============
setInterval(() => {
  const idleMs = Date.now() - lastInteract;
  if (idleMs > 5 * 60 * 1000 && state === 'idle') setState('sleepy');
  if (state === 'sleepy' && Math.random() < 0.3) {
    mioEl.classList.add('mio--nod');
    setTimeout(() => mioEl.classList.remove('mio--nod'), 1500);
  }
}, 5000);

// ============ 视线跟随（全局光标） ============
api.onCursor((pt) => {
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
// 光标在可交互元素上 → 关闭穿透；否则恢复穿透
document.addEventListener('mousemove', (e) => {
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

// ============ 面板 ============
let panelOpen = false;
function togglePanel() {
  panelOpen = !panelOpen;
  panel.hidden = !panelOpen;
  if (panelOpen) {
    refreshStats();
    checkAdvice();
    refreshMessages();
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
    if (e.target.closest('button, .pick-item, .p-kill, .sort-toggle, .pick-all')) return;
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
function tickClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  document.getElementById('clock').textContent = `${hh}:${mm}`;
  document.getElementById('dateLine').textContent =
    `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
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
    if (tab.dataset.tab === 'status') pollStatus();
    if (tab.dataset.tab === 'clean') { checkAdvice(); refreshCleanHistory(); }
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
    diskWarned = true;
    say('磁盘快满了，点我清理一下', 5000);
    api.notify('Mio · 磁盘告警', `磁盘已用 ${s.disk.usedPct}%，建议清理`);
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
      if (!panelOpen) say(top.title, 4000);
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
const POMO_WORK = 25 * 60;
const POMO_REST = 5 * 60;
let pomoLeft = POMO_WORK;
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
  mioEl.classList.toggle('mio--working', working);
}

document.getElementById('pomodoroCard').addEventListener('click', () => {
  interact();
  if (pomoRunning) {
    clearInterval(pomoTimer);
    pomoRunning = false;
    pomoLeft = pomoPhase === 'work' ? POMO_WORK : POMO_REST;
    pomoStateEl.textContent = '已停止，点击重新开始';
    setState('idle');
  } else {
    pomoRunning = true;
    pomoStateEl.textContent = pomoPhase === 'work' ? '专注中…' : '休息中…';
    setState('thinking');
    say(pomoPhase === 'work' ? '开始专注，我陪着你' : '休息一下吧');
    pomoTimer = setInterval(() => {
      pomoLeft--;
      renderPomo();
      if (pomoLeft <= 0) {
        if (pomoPhase === 'work') {
          pomoPhase = 'rest';
          pomoLeft = POMO_REST;
          api.notify('Mio · 番茄钟', '专注结束，休息 5 分钟吧');
          say('干得漂亮！休息一下');
          setState('happy', 3000);
        } else {
          pomoPhase = 'work';
          pomoLeft = POMO_WORK;
          api.notify('Mio · 番茄钟', '休息结束，开始下一轮专注');
          say('继续加油！');
        }
        pomoStateEl.textContent = pomoPhase === 'work' ? '专注中…' : '休息中…';
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
      api.notify('Mio · 提醒', `${min} 分钟到了！`);
      say('时间到啦！', 4000);
      setState('surprised', 2000);
    }, min * 60 * 1000);
  });
});

// 久坐提醒：每 45 分钟
setInterval(() => {
  api.notify('Mio · 久坐提醒', '已经坐了很久啦，起来活动一下');
  say('起来走走吧～', 3500);
}, 45 * 60 * 1000);

// 启动问候
setTimeout(() => say('嗨，我是 Mio'), 800);
