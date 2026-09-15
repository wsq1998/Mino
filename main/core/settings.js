// Mio - 核心层：设置骨架 / 深合并 / 数值收口（纯函数，无副作用，跨域复用）
// B4-4 拆分：从 main.js 抽出。零行为变化 —— 只搬定义，不动逻辑。
// 依赖：无（不 require electron/app/win），保证纯函数可单测。

const SETTINGS_VERSION = 10;

// v2.16 迁移标记：只属于「v2.15 及以前的单轮 LLM 聊天」的 ai 键。
// 只要出现任意一个，就说明这份 ai 块是旧特性，整块按默认重建（详见 sanitizeSettings 里的说明）。
// 注意不含 enabled / model —— 这两个键新旧同名，判据必须靠独有键才可靠。
const AI_LEGACY_KEYS = ['provider', 'baseUrl', 'monthlyCap', 'maxTokens', 'persona'];

const DEFAULT_SETTINGS = {
  _v: 10,
  general: { autoOpen: false, lang: 'auto' }, // v2.0 ENG-2：zh | en | auto（默认跟随系统）
  appearance: {
    theme: 'dark',        // dark | light —— 跟随系统在 S3 接入
    size: 'md',           // sm | md | lg
    opacity: 1,           // 0.3 ~ 1
    onTop: true,
    gaze: true,           // 视线跟随
    clickThrough: true,   // 点击穿透（关闭后球体始终接收鼠标事件）
    reduceMotion: false,  // 减弱动效
    displayId: null,      // null = 跟随光标所在屏
    material: 'glass',    // glass | solid —— 球体与面板质感：液态玻璃 / 实心（液态玻璃主题）
  },
  chime: { enabled: true, from: 9, to: 22, notify: false },
  health: { enabled: true, sit: true, water: false, eye: false, quietFrom: 22, quietTo: 9 },
  // v1.6 C9：通知方式默认「两者」，保持 v1.5「系统通知 + 气泡」的既有行为，
  // 避免升级后默认通道变了让老用户以为提醒消失（PRD Q8）
  notify: { style: 'both' }, // bubble | system | both
  pomodoro: { work: 25, enabled: true },    // v1.6 C10：25 | 45 | 60（分钟）；v1.9 新增 enabled：主面板番茄钟统计卡片开关
  // v1.9 主面板功能开关：倒计时 / 快捷启动（launcher.items 是启动项数据源，点击用 open -a 启动）
  countdown: { enabled: true },
  launcher: {
    enabled: true,
    items: [
      { id: 'safari', label: 'Safari', app: 'Safari' },
      { id: 'chrome', label: 'Chrome', app: 'Google Chrome' },
      { id: 'wechat', label: '微信', app: 'WeChat' },
      { id: 'qq', label: 'QQ', app: 'QQ' },
      { id: 'finder', label: '访达', app: 'Finder' },
      { id: 'terminal', label: '终端', app: 'Terminal' },
      { id: 'vscode', label: 'VS Code', app: 'Visual Studio Code' },
      { id: 'mail', label: '邮件', app: 'Mail' },
    ],
  },
  stealth: { enabled: true, opacity: 0.12, apps: null }, // apps=null → 用内置名单
  // ===== v1.6 新增分组 =====
  clipboard: { enabled: true, limit: 10, filterPassword: false, imageHistory: false, imagePersist: 0 }, // E1/E2/E3 + v2.0 F9 图片历史（默认不落盘）
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
  // v2.16 AI 助手（本地 Agent，opencode serve 引擎）。Key 由 opencode 自己管，Mio 不再碰钥匙串。
  ai: {
    enabled: false,              // 总开关；关 → 不启引擎、不显示任何入口
    enginePath: '',              // 空 = 自动探测
    autoStart: true,             // 首次需要时自动拉起引擎
    workspace: '',               // 空 = ~/Mio Workspace
    agent: 'build',              // 默认 agent（角色）
    model: '',                   // 空 = 用 opencode 配置里的默认模型
    edgeSide: 'right',           // top|bottom|left|right（独立于中转站）
    showCapsule: true,           // 常驻边缘胶囊
    hotkey: 'Alt+A',             // 默认 ⌥A；注册前经 main/core/hotkeys.js 的 validate() 校验
    notifyOnDone: true,          // 完成后发系统通知
    recent: [],                  // 最近提交文本（≤50，本地，可清空）
  },
  // v1.8 B4-2：首次启动引导标记。done=true 表示已引导过（老用户不弹）
  onboarding: { done: false },
  // ===== v2.0 新增分组（F1–F13 底座，只增不改、老键名不动）=====
  // F1 电量 / 满电充电提醒：默认关（避免打扰）；low/full 为百分比阈值
  battery: { enabled: false, low: 20, full: 80 },
  // F2 摄像头 / 麦克风占用警示：monitor 开关 + 忽略名单（App 进程名）
  privacy: { monitor: true, ignoreApps: [] },
  // F3 蓝牙设备电量：默认开；interval 秒（60s 缓存）
  bluetooth: { enabled: true, interval: 60 },
  // F6 网络 IP 卡片：enabled 开关
  network: { enabled: true },
  // F7 应用卸载：二次确认强制开启（不可关）
  uninstall: { confirmAlways: true },
  // F8 窗口分屏：enabled 开关 + hotkey 快捷键（null = 未录制）
  split: { enabled: true, hotkey: null },
  // F10 文件暂存区 / 中转站：只记路径引用，不移动/复制/删除源文件
  // v2.1：新增浮窗（贴边胶囊 ⇄ 抽屉）相关配置（见 15-增量设计-中转站浮窗.md §8）
  stash: {
    // ===== 既有（不动）=====
    enabled: true,
    persist: true,
    items: [],
    // ===== v2.1 浮窗新增 =====
    panelEnabled: true,         // 贴边胶囊是否常驻显示（false → 仅热键/Tray 呼出）
    edgeHot: true,              // 鼠标撞屏边自动展开
    dragAutoShow: true,         // v2.2 华为式触发：拖文件进入 Mio 浮窗时自动弹出（与 edgeHot 互补）
    edgeSide: 'top',            // v2.3 触发边：'top' | 'bottom' | 'left' | 'right'（默认顶部，拖到屏幕上方触发）
    edgeThreshold: 6,           // px，撞边灵敏度（1–24）
    autoHideDelay: 1200,        // ms，离开后自动收起延迟（300–6000）
    pinned: false,              // 抽屉是否钉住（钉住则永不自动收起）
    hotkey: 'Alt+Shift+Space',  // 独立全局键；null = 未注册
    trayEnabled: true,          // 菜单栏图标
    capsuleOpacity: 0.6,        // 胶囊半透明度（0.3–1）
    dir: '',                    // v2.5 中转站存储目录（空 = 默认：下载/Mio中转站）
  },
  // F12 磁盘空间太阳图：默认开启
  sunburst: { enabled: true },
};

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

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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

function sanitizeSettings(s) {
  s.appearance.opacity = normUnit(s.appearance.opacity, 0.3, 1, 1);
  s.appearance.material = ['glass', 'solid'].includes(s.appearance.material)
    ? s.appearance.material : 'glass';
  s.stealth.opacity = normUnit(s.stealth.opacity, 0.05, 0.9, 0.12);
  // v1.7.5 autoClean：脏数据收口 —— lastRun 只许对象或 null，pausedUntil 只许未过期的正数毫秒或 null
  if (s.autoClean && typeof s.autoClean === 'object') {
    s.autoClean.enabled = !!s.autoClean.enabled;
    const pu = Number(s.autoClean.pausedUntil);
    s.autoClean.pausedUntil = Number.isFinite(pu) && pu > Date.now() ? pu : null;
    if (!s.autoClean.lastRun || typeof s.autoClean.lastRun !== 'object') s.autoClean.lastRun = null;
  }
  // v2.16 ai：脏数据收口（本地 Agent schema）—— 布尔 !! / 字符串空回退 / 枚举白名单 / 数组截断到最近 50
  if (s.ai && typeof s.ai === 'object') {
    // ── v9 → v10 迁移 ──────────────────────────────────────────────
    // v2.15 及以前的 ai 组是「单轮 LLM 聊天」（provider / baseUrl / monthlyCap / maxTokens / persona），
    // 和 v2.16 的「本地 Agent 助手」不是同一个东西，只是共用了 ai 这个键名。
    // deepMerge 不会删旧键，所以不主动清就会在 settings.json 里留下永久幽灵字段；
    // 更危险的是被复用的 model：旧值 'deepseek-chat' 是个裸模型名，而 opencode 的
    // prompt.model 要求 providerID + modelID 同时存在，照发出去每次都会 400。
    // 因此判据不是「有没有旧键」而是「这份 ai 块属于旧特性」→ 整块回默认（enabled:false）。
    // 语义上也是对的：新助手默认关，用户去设置页看到引擎状态再自己开。
    if (AI_LEGACY_KEYS.some((k) => Object.prototype.hasOwnProperty.call(s.ai, k))) {
      s.ai = { ...DEFAULT_SETTINGS.ai };
    }
    s.ai.enabled = !!s.ai.enabled;
    s.ai.autoStart = !!s.ai.autoStart;
    s.ai.showCapsule = !!s.ai.showCapsule;
    s.ai.notifyOnDone = !!s.ai.notifyOnDone;
    s.ai.enginePath = (typeof s.ai.enginePath === 'string' && s.ai.enginePath.trim()) ? s.ai.enginePath.trim() : '';
    s.ai.workspace = (typeof s.ai.workspace === 'string' && s.ai.workspace.trim()) ? s.ai.workspace.trim() : '';
    // model 只接受「provider/model」两段式 —— 与 main/ai/ruleset.js 的 parseModel 同构，
    // 且只有两段齐全时才会真的塞进 prompt body（见 main/ai/ipc.js 的 ai-send）。
    // 裸模型名一律丢弃：与其发出去被引擎 400，不如老实回落到引擎默认模型。
    const aiModel = typeof s.ai.model === 'string' ? s.ai.model.trim() : '';
    s.ai.model = /^[^/\s]+\/[^/\s]+$/.test(aiModel) ? aiModel : '';
    s.ai.agent = (typeof s.ai.agent === 'string' && s.ai.agent.trim()) ? s.ai.agent.trim() : 'build';
    s.ai.edgeSide = ['top', 'bottom', 'left', 'right'].includes(s.ai.edgeSide) ? s.ai.edgeSide : 'right';
    s.ai.hotkey = (typeof s.ai.hotkey === 'string' && s.ai.hotkey.trim()) ? s.ai.hotkey.trim() : DEFAULT_SETTINGS.ai.hotkey;
    s.ai.recent = Array.isArray(s.ai.recent)
      ? s.ai.recent.filter((x) => typeof x === 'string' && x.trim() !== '').slice(-50)
      : [];
  }
  // v1.9 主面板功能开关：倒计时 / 快捷启动 / 番茄钟统计 —— 布尔收口
  s.countdown.enabled = !!s.countdown.enabled;
  s.launcher.enabled = !!s.launcher.enabled;
  s.pomodoro.enabled = !!s.pomodoro.enabled;
  // v1.9 launcher.items：数组收口 —— 只保留合法条目（id/app 非空字符串），空数组也合法（用户删光了）
  if (!Array.isArray(s.launcher.items)) {
    s.launcher.items = DEFAULT_SETTINGS.launcher.items.map((it) => ({ ...it }));
  } else {
    s.launcher.items = s.launcher.items
      .filter((it) => it && typeof it === 'object' && String(it.app || '').trim() !== '')
      .map((it) => ({
        id: String(it.id || '').trim() || `app_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        label: String(it.label || '').trim() || it.app,
        app: String(it.app).trim(),
      }));
  }
  // ===== v2.0 收口（F1–F13 底座）=====
  // ENG-2 语言：只许 zh | en | auto
  if (!s.general || typeof s.general !== 'object') s.general = {};
  s.general.lang = ['zh', 'en', 'auto'].includes(s.general.lang) ? s.general.lang : 'auto';
  // F1 battery：布尔 + 数值 clamp（low 5–95 / full 20–100，且 low < full）
  if (!s.battery || typeof s.battery !== 'object') s.battery = {};
  s.battery.enabled = !!s.battery.enabled;
  const low = clamp(Number(s.battery.low) || 20, 5, 95);
  const full = clamp(Number(s.battery.full) || 80, 20, 100);
  s.battery.low = Math.min(low, full - 5);
  s.battery.full = Math.max(full, s.battery.low + 5);
  // F2 privacy：monitor 布尔 + ignoreApps 数组白名单（非空字符串进程名）
  if (!s.privacy || typeof s.privacy !== 'object') s.privacy = {};
  s.privacy.monitor = !!s.privacy.monitor;
  s.privacy.ignoreApps = Array.isArray(s.privacy.ignoreApps)
    ? s.privacy.ignoreApps.filter((x) => typeof x === 'string' && x.trim() !== '').slice(0, 50)
    : [];
  // F3 bluetooth：enabled 布尔 + interval 数值（30–3600s）
  if (!s.bluetooth || typeof s.bluetooth !== 'object') s.bluetooth = {};
  s.bluetooth.enabled = !!s.bluetooth.enabled;
  const btInt = Number(s.bluetooth.interval);
  s.bluetooth.interval = Number.isFinite(btInt) ? clamp(Math.round(btInt), 30, 3600) : 60;
  // F6 network：enabled 布尔
  if (!s.network || typeof s.network !== 'object') s.network = {};
  s.network.enabled = !!s.network.enabled;
  // F7 uninstall：confirmAlways 强制 true（不可关）
  if (!s.uninstall || typeof s.uninstall !== 'object') s.uninstall = {};
  s.uninstall.confirmAlways = true;
  // F8 split：enabled 布尔 + hotkey 字符串或 null
  if (!s.split || typeof s.split !== 'object') s.split = {};
  s.split.enabled = !!s.split.enabled;
  s.split.hotkey = (typeof s.split.hotkey === 'string' && s.split.hotkey.trim()) ? s.split.hotkey.trim() : null;
  // F9 clipboard 扩展：imageHistory 布尔 + imagePersist 数值（0 = 关，1–200 张）
  if (!s.clipboard || typeof s.clipboard !== 'object') s.clipboard = {};
  s.clipboard.imageHistory = !!s.clipboard.imageHistory;
  const ip = Number(s.clipboard.imagePersist);
  s.clipboard.imagePersist = Number.isFinite(ip) ? clamp(Math.round(ip), 0, 200) : 0;
  // F10 stash：enabled/persist 布尔 + items 数组（v2.5：每条 { id, path(中转站副本), srcPath(源), name, size, isDir, addedAt }）
  if (!s.stash || typeof s.stash !== 'object') s.stash = {};
  s.stash.enabled = !!s.stash.enabled;
  s.stash.persist = !!s.stash.persist;
  s.stash.items = Array.isArray(s.stash.items)
    ? s.stash.items.filter((it) => it && typeof it === 'object' && typeof it.path === 'string' && it.path.trim() !== '').slice(0, 100)
    : [];
  // ===== v2.1 中转站浮窗收口（布尔 / 枚举 / 数值 / 不透明度 / 快捷键）=====
  s.stash.panelEnabled = !!s.stash.panelEnabled;
  s.stash.edgeHot = !!s.stash.edgeHot;
  s.stash.dragAutoShow = !!s.stash.dragAutoShow;
  s.stash.pinned = !!s.stash.pinned;
  s.stash.trayEnabled = !!s.stash.trayEnabled;
  s.stash.edgeSide = ['top', 'bottom', 'left', 'right'].includes(s.stash.edgeSide) ? s.stash.edgeSide : 'right';
  s.stash.edgeThreshold = clamp(Math.round(Number(s.stash.edgeThreshold) || 6), 1, 24);
  s.stash.autoHideDelay = clamp(Math.round(Number(s.stash.autoHideDelay) || 1200), 300, 6000);
  // 不透明度走唯一口径 normUnit（与 appearance/stealth 一致）
  s.stash.capsuleOpacity = normUnit(s.stash.capsuleOpacity, 0.3, 1, 0.6);
  // 快捷键：字符串或 null（沿用 F8 split.hotkey 的收口写法）
  s.stash.hotkey = (typeof s.stash.hotkey === 'string' && s.stash.hotkey.trim()) ? s.stash.hotkey.trim() : null;
  // v2.5 中转站存储目录：绝对路径字符串，空串 = 用默认（下载/Mio中转站）
  s.stash.dir = (typeof s.stash.dir === 'string' && s.stash.dir.trim()) ? s.stash.dir.trim() : '';
  // F12 sunburst：enabled 布尔
  if (!s.sunburst || typeof s.sunburst !== 'object') s.sunburst = {};
  s.sunburst.enabled = !!s.sunburst.enabled;
  return s;
}

module.exports = {
  SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  deepMerge,
  normUnit,
  clamp,
  sanitizeSettings,
};