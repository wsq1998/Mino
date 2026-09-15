// Mio - 核心层：全局热键注册表（纯数据 + 纯函数，零副作用）
//
// 用途
//   把「谁占了哪个全局热键」收口到唯一来源（HOTKEYS），并提供一致化的比较 / 归属查询 /
//   注册前校验。目标是根治「多个功能各自注册快捷键、事后才发现撞车」的问题 —— 以后新增
//   任何全局热键，都必须先经 validate() 查表，冲突即拒绝（配合 main.js 的失败回滚）。
//
// 为什么需要它
//   历史上 Mio 的三处热键散落在 main.js 各处，靠在各自注册函数里硬编码 equals 判断互斥
//   （见 main.js applyHotkey / applyStashHotkey）。新增 AI 助手热键时，设计文档一度把默认键
//   写成 `⌥ Space`（= `Alt+Space`），与主窗口召唤键**正面冲突**且自相矛盾。本模块用表驱动
//   取代散落判断：`Alt+Shift+Space` 与 `Shift+Alt+Space` 视为同一个键（Electron accelerator
//   修饰键顺序无意义），从机制上杜绝这类漏网。
//
// 依赖：无（不 require electron，仅内置 String/Array/Set），可被 `node --test` 直接加载，
//       与 main/core/stashPanel.js、main/core/battery.js 同风格。
//
// 接线说明（P1）
//   本模块当前是**纯函数层**，尚未改变任何运行时行为。main.js 现有三处常量
//   （DEFAULT_HOTKEY / RESERVED_HOTKEY / DEFAULT_STASH_HOTKEY）已改为从 HOTKEYS 取值，
//   行为完全等价；`validate()` 的接入（把 applyHotkey / applyStashHotkey 里的硬编码互斥
//   判断收敛到本注册表）留待 P1 实现 AI 助手热键时一并完成，届时 ai owner 已在表中预置。

// ─────────────────────────────────────────────────────────────────────────────
// 1. 所有权表 —— 唯一来源
//    key 为「归属」标识，value 为 Electron accelerator 字符串。
//    ⚠️ 这里列出的组合两两之间必须互不相同（normalize 后比较），test/hotkeys.test.js 有守卫。
// ─────────────────────────────────────────────────────────────────────────────
const HOTKEYS = {
  mainWindow: 'Alt+Space',      // 主窗口召唤键（main.js DEFAULT_HOTKEY，可配）
  reserved: 'Alt+H',            // 恒定兜底键（main.js RESERVED_HOTKEY，不可覆盖）
  stash: 'Alt+Shift+Space',     // 中转站浮窗键（main.js DEFAULT_STASH_HOTKEY，可配）
  ai: 'Alt+A',                  // AI 助手唤起键（A = Assistant/Agent；P1 启用，可配）
};

// 归属的可读中文名（用于生成错误文案，避免调用方各自拼字符串）。
const OWNER_LABELS = {
  mainWindow: '主窗口召唤键',
  reserved: '手动隐藏键',
  stash: '中转站浮窗键',
  ai: 'AI 助手唤起键',
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. 需避开的 macOS 系统 / 高概率被占用组合
//    这些不是 Mio 自有的键，而是「注册了也多半抢不到或被系统吃掉」的组合。
//    每条含 accelerator 与人类可读说明；validate() 命中时给出「系统保留建议」级别的结果。
// ─────────────────────────────────────────────────────────────────────────────
const MACOS_RESERVED = [
  { accel: 'Cmd+Space', desc: 'Spotlight 聚焦搜索' },
  { accel: 'Ctrl+Space', desc: '输入法切换（几乎必冲突）' },
  { accel: 'Cmd+Option+Space', desc: 'Finder 搜索窗口' },
  { accel: 'Cmd+Shift+Space', desc: '部分 App 的全局搜索 / 字符检视' },
  { accel: 'Cmd+Tab', desc: '切换应用' },
  { accel: 'Cmd+Shift+3', desc: '整屏截图' },
  { accel: 'Cmd+Shift+4', desc: '区域截图' },
  { accel: 'Cmd+Shift+5', desc: '截图 / 录屏工具' },
  { accel: 'Ctrl+Up', desc: 'Mission Control（调度中心）' },
  { accel: 'Ctrl+Down', desc: 'App 窗口（Exposé）' },
  { accel: 'Ctrl+Left', desc: '切换到左侧全屏空间' },
  { accel: 'Ctrl+Right', desc: '切换到右侧全屏空间' },
  { accel: 'Cmd+Option+Esc', desc: '强制退出应用' },
  { accel: 'Ctrl+Cmd+Q', desc: '锁定屏幕' },
  { accel: 'Cmd+H', desc: '隐藏当前应用' },
  { accel: 'Cmd+M', desc: '最小化窗口' },
  { accel: 'Cmd+W', desc: '关闭窗口' },
  { accel: 'Cmd+Q', desc: '退出应用' },
  { accel: 'Cmd+Option+H', desc: '隐藏其他应用' },
  { accel: 'Cmd+Option+D', desc: '显示 / 隐藏 Dock' },
];

// ─────────────────────────────────────────────────────────────────────────────
// 3. normalize —— 规范化 accelerator，供一切比较使用
//    规则：修饰键排序（Alt → Ctrl → Cmd → Shift 固定顺序）+ 名称归一 + 大小写归一 +
//          去空格；非法输入返回空串 ''。使 `Shift+Alt+Space` 与 `Alt+Shift+Space` 判等。
// ─────────────────────────────────────────────────────────────────────────────

// 修饰键别名 → 规范名（小写 key 便于大小写不敏感匹配）
const MOD_ALIAS = {
  alt: 'Alt', option: 'Alt',
  ctrl: 'Ctrl', control: 'Ctrl',
  cmd: 'Cmd', command: 'Cmd', cmdorctrl: 'Cmd', super: 'Cmd', meta: 'Cmd',
  shift: 'Shift',
};
// 输出排序：固定为 Alt / Ctrl / Cmd / Shift
const MOD_ORDER = ['Alt', 'Ctrl', 'Cmd', 'Shift'];

// 具名键别名 → 规范名（小写 key）
const KEY_ALIAS = {
  space: 'Space', spacebar: 'Space',
  tab: 'Tab',
  enter: 'Enter', return: 'Enter',
  esc: 'Esc', escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Delete', del: 'Delete',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown',
  plus: 'Plus', minus: 'Minus',
  comma: 'Comma', period: 'Period', slash: 'Slash',
};

// 单个主键的规范名。无法识别返回 ''。
function normalizeKey(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  const lower = t.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KEY_ALIAS, lower)) return KEY_ALIAS[lower];
  // 功能键 F1–F24
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  // 单字符（字母 / 数字）→ 大写
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase();
  // 其余具名键（如 PageUp 的非常规写法）：首字母大写、其余小写，保证确定性
  if (/^[a-z0-9]+$/.test(lower)) return lower.charAt(0).toUpperCase() + lower.slice(1);
  return ''; // 含非法字符（如 '+'、空格、符号）→ 非法
}

/**
 * 规范化一个 Electron accelerator 字符串。
 * @param {string} accel 原始组合，如 'Shift+Alt+Space' / 'alt+space'
 * @returns {string} 规范化结果（如 'Alt+Shift+Space'）；非法输入返回 ''
 */
function normalize(accel) {
  if (typeof accel !== 'string') return '';
  const raw = accel.trim();
  if (!raw) return '';
  const tokens = raw.split('+').map((s) => s.trim());
  if (tokens.length < 2) return ''; // 至少要「一个修饰键 + 一个主键」
  if (tokens.some((t) => !t)) return ''; // 出现空段（如 'Alt+' / '+Space'）→ 非法

  const key = tokens[tokens.length - 1];
  const modsRaw = tokens.slice(0, -1);

  const mods = new Set();
  for (const m of modsRaw) {
    const canon = MOD_ALIAS[m.toLowerCase()];
    if (!canon) return ''; // 未知修饰键 → 非法
    mods.add(canon);
  }
  if (mods.size === 0) return ''; // 无修饰键（tokens.length>=2 时不该发生，兜底）

  const keyCanon = normalizeKey(key);
  if (!keyCanon) return '';

  const sorted = MOD_ORDER.filter((m) => mods.has(m));
  return [...sorted, keyCanon].join('+');
}

// 预构建「规范化值 → owner」索引与「规范化值 → 保留项」索引（模块加载时一次性，纯计算）。
const OWNER_BY_ACCEL = (() => {
  const map = new Map();
  for (const owner of Object.keys(HOTKEYS)) {
    const n = normalize(HOTKEYS[owner]);
    if (n) map.set(n, owner);
  }
  return map;
})();

const RESERVED_BY_ACCEL = (() => {
  const map = new Map();
  for (const item of MACOS_RESERVED) {
    const n = normalize(item.accel);
    if (n) map.set(n, item);
  }
  return map;
})();

/**
 * 查询某组合当前被哪个（Mio 自有）hotkey owner 占用。
 * @param {string} accel
 * @returns {string|null} owner key（'mainWindow' | 'reserved' | 'stash' | 'ai'）；无人占用返回 null
 */
function ownerOf(accel) {
  const n = normalize(accel);
  if (!n) return null;
  return OWNER_BY_ACCEL.has(n) ? OWNER_BY_ACCEL.get(n) : null;
}

/**
 * 注册前校验：判断某组合能否被指定 owner 使用。
 * 判定顺序：非法 → 被其他 owner 硬占用 → 命中 macOS 保留组合 → 通过。
 *
 * 返回结构（区分「硬冲突」与「系统保留建议」）：
 *   { ok, kind, severity, error?, conflictWith?, reservedWith?, overridable }
 *   - kind === 'ok'        → ok:true，可注册
 *   - kind === 'invalid'   → 空 / 非法输入，severity:'block'，不可覆盖
 *   - kind === 'conflict'  → 被其他 Mio owner 占用（硬冲突），severity:'block'，
 *                            conflictWith = 占用方 owner key，不可覆盖
 *   - kind === 'reserved'  → 命中 macOS 系统保留组合，severity:'warn'，
 *                            reservedWith = { accel, desc }，overridable:true（调用方可自行决定是否强用）
 *
 * @param {string} accel 待校验的 accelerator
 * @param {string} [forOwner] 发起注册的 owner key（自身重复注册不算冲突）
 * @returns {{ok:boolean, kind:string, severity:string, error?:string, conflictWith?:string, reservedWith?:{accel:string,desc:string}, overridable:boolean}}
 */
function validate(accel, forOwner) {
  const n = normalize(accel);
  if (!n) {
    return { ok: false, kind: 'invalid', severity: 'block', error: '快捷键为空或格式非法', overridable: false };
  }

  const owner = OWNER_BY_ACCEL.get(n);
  if (owner && owner !== forOwner) {
    const label = OWNER_LABELS[owner] || owner;
    return {
      ok: false,
      kind: 'conflict',
      severity: 'block',
      error: `与${label}（${HOTKEYS[owner]}）冲突`,
      conflictWith: owner,
      overridable: false,
    };
  }

  const reserved = RESERVED_BY_ACCEL.get(n);
  if (reserved) {
    return {
      ok: false,
      kind: 'reserved',
      severity: 'warn',
      error: `命中 macOS 系统保留组合：${reserved.accel}（${reserved.desc}），建议换一个`,
      reservedWith: { accel: reserved.accel, desc: reserved.desc },
      overridable: true,
    };
  }

  return { ok: true, kind: 'ok', severity: 'none', overridable: false };
}

module.exports = {
  HOTKEYS,
  OWNER_LABELS,
  MACOS_RESERVED,
  normalize,
  ownerOf,
  validate,
};
