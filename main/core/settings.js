// Mio - 核心层：设置骨架 / 深合并 / 数值收口（纯函数，无副作用，跨域复用）
// B4-4 拆分：从 main.js 抽出。零行为变化 —— 只搬定义，不动逻辑。
// 依赖：无（不 require electron/app/win），保证纯函数可单测。

const SETTINGS_VERSION = 7;

const DEFAULT_SETTINGS = {
  _v: 7,
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
  // v1.8 ai：脏数据收口 —— maxTokens 夹到 64–2048，monthlyCap 非负数字，persona 空回退默认
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