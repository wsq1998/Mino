// Mio - 核心层：中转站浮窗几何 / 状态机（v2.1）
// 屏幕贴边「胶囊 ⇄ 抽屉」的矩形计算 + 边缘热区判定 + 展开/收起状态机。
//
// 设计约束（见 docs/15-增量设计-中转站浮窗.md §4）：
//   - 纯函数、零副作用、不 require electron；所有屏幕坐标以「显示器 workArea 逻辑像素」为输入；
//   - 同一输入必得同一输出 → 可被 node --test 完整单测（test/stashPanel.test.js）；
//   - 状态机 resolvePanelState 不改入参、不读全局。
// 依赖：无（仅内置 Math / Date）。
//
// 术语：
//   workArea —— 显示器可用区 { x, y, width, height }（逻辑像素，已剔除菜单栏/Dock）
//   capsule  —— 贴边的细条常驻形态
//   open     —— 抽屉展开形态
//   hidden   —— 完全隐藏（设置里关闭常驻胶囊时）

const DIRS = ['top', 'bottom', 'left', 'right'];
const isVert = (side) => side === 'left' || side === 'right'; // 垂直边（侧边抽屉）vs 水平边（顶/底货架）
const CAPSULE_T = 6;              // 胶囊厚度（垂直边=宽，水平边=高）
const CAPSULE_LEN = 104;          // 胶囊沿边长度（水平边=宽，垂直边=高）
const CAPSULE = { w: CAPSULE_T, h: CAPSULE_LEN };
const PANEL_W = 260;              // 垂直抽屉（左/右）宽度
// v2.10/v2.11 货架高度不再固定 144px：默认 2 行、展开 3 行（行高与 renderer/stash.css --st-list-row-h 一致）。
// v2.11 行高 140 → 60（条目由竖排大卡片改为紧凑横排，面板高度大幅缩小）。
const SHELF_ROW_H = 60;           // 货架单行高度（px）
const SHELF_PAD_H = 24;           // 货架高度余量（头部/内边距，px）
const PANEL = { w: PANEL_W, h: 0 };
const PANEL_MARGIN_Y = 56;        // 垂直抽屉纵向内缩基准（px）
const PANEL_MARGIN_X = 56;        // 水平抽屉横向内缩基准（px）
// v2.15 顶/底货架最大宽度：640 → 980。货架是贴边的横向条，不遮挡屏中内容，
// 更宽能让多个类型分组（row+wrap）并排展示更多文件、减少纵向滚动。980 ≈ 常见 1080p/1440p
// 屏宽的 2/3，既明显加宽又不至于像全屏横条那样突兀。小屏（< 屏宽-112）仍按屏宽自动收敛。
const PANEL_MAX_W = 980;          // 水平货架最大宽度（避免随屏过宽）
const PANEL_MAX_RATIO = 0.66;     // 垂直抽屉最大占屏比例（限高，避免接近全屏）
const EDGE_MARGIN = 10;           // 触边容差（v2.2 由 8 → 10，让「拖到 Mio」更易命中）

const DEFAULT_WORKAREA = { x: 0, y: 0, width: 1440, height: 900 };
const MODES = ['hidden', 'capsule', 'open'];

/** 数值夹取到 [lo, hi]。 */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 把任意输入归一化成合法 workArea；非法输入回退默认屏。 */
function normWorkArea(wa) {
  if (!wa || typeof wa !== 'object') return { ...DEFAULT_WORKAREA };
  const x = Number(wa.x);
  const y = Number(wa.y);
  const width = Number(wa.width);
  const height = Number(wa.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n)) || width <= 0 || height <= 0) {
    return { ...DEFAULT_WORKAREA };
  }
  return { x, y, width, height };
}

/** 从 settings 抽出与浮窗几何相关的收口配置（容错，缺失即用默认）。 */
function stashCfg(settings) {
  const s = settings && typeof settings.stash === 'object' && settings.stash ? settings.stash : {};
  return {
    side: DIRS.includes(s.edgeSide) ? s.edgeSide : 'right', // v2.3：触发边支持 top/bottom/left/right
    edgeThreshold: clamp(Math.round(Number(s.edgeThreshold) || 6), 1, 24),
    autoHideDelay: clamp(Math.round(Number(s.autoHideDelay) || 1200), 300, 6000),
    panelEnabled: s.panelEnabled !== false, // 缺省开启常驻胶囊
    edgeHot: s.edgeHot !== false,           // 缺省开启边缘热区（悬停屏缘即展开）
    // v2.2 华为式触发：拖文件进入 Mio 浮窗时自动弹出（与 edgeHot 互补：
    // edgeHot 管「光标靠近屏缘」，dragAutoShow 管「确有文件拖入浮窗」）。两者默认都开。
    dragAutoShow: s.dragAutoShow !== false,
    // v2.10 货架展开标志：运行时状态（主进程每次 resolve 前注入 settings.stash），
    // 缺省收起 = 2 行；true = 展开 3 行。仅影响 top/bottom 货架高度。
    shelfExpanded: s.shelfExpanded === true,
  };
}

/** 贴边锚定的 x / y 坐标：左/右贴左右缘并垂直居中；上/下贴上下缘并水平居中。 */
function anchoredX(wa, width, side) {
  if (side === 'left') return wa.x;
  if (side === 'right') return wa.x + wa.width - width;
  return wa.x + Math.round((wa.width - width) / 2); // top/bottom 水平居中
}
function anchoredY(wa, height, side) {
  if (side === 'top') return wa.y;
  if (side === 'bottom') return wa.y + wa.height - height;
  return wa.y + Math.round((wa.height - height) / 2); // left/right 垂直居中
}

/**
 * 胶囊矩形：贴指定屏缘的细条（垂直边=竖条，水平边=横条）。
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function capsuleRect(workArea, settings) {
  const wa = normWorkArea(workArea);
  const { side } = stashCfg(settings);
  const t = Math.min(CAPSULE_T, isVert(side) ? wa.width : wa.height);
  const len = Math.min(CAPSULE_LEN, isVert(side) ? wa.height : wa.width);
  const width = isVert(side) ? t : len;
  const height = isVert(side) ? len : t;
  return { x: anchoredX(wa, width, side), y: anchoredY(wa, height, side), width, height };
}

/**
 * 抽屉矩形：贴指定屏缘；垂直边=侧边抽屉（宽固定、高随屏），水平边=顶/底货架（高随展开态，宽随屏）。
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function panelRect(workArea, settings) {
  const wa = normWorkArea(workArea);
  const cfg = stashCfg(settings);
  const { side } = cfg;
  if (isVert(side)) {
    const width = Math.min(PANEL_W, wa.width);
    const marginY = Math.min(PANEL_MARGIN_Y, Math.round(wa.height * 0.1));
    const maxH = Math.max(120, Math.round(wa.height * PANEL_MAX_RATIO));
    const height = Math.min(Math.max(120, wa.height - marginY * 2), maxH);
    return { x: anchoredX(wa, width, side), y: anchoredY(wa, height, side), width, height };
  }
  // v2.10 货架高度随展开态动态变化：默认 2 行（SHELF_ROW_H*2+SHELF_PAD_H），展开 3 行。
  const shelfH = (cfg.shelfExpanded ? 3 : 2) * SHELF_ROW_H + SHELF_PAD_H;
  const height = Math.min(shelfH, wa.height);
  const marginX = Math.min(PANEL_MARGIN_X, Math.round(wa.width * 0.1));
  const maxW = Math.max(200, Math.min(PANEL_MAX_W, wa.width));
  const width = Math.min(Math.max(200, wa.width - marginX * 2), maxW);
  return { x: anchoredX(wa, width, side), y: anchoredY(wa, height, side), width, height };
}

/**
 * 边缘热区矩形（厚度 = edgeThreshold），沿触发边铺满另一维度，用于主进程命中判定。
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function edgeZone(workArea, settings) {
  const wa = normWorkArea(workArea);
  const { side, edgeThreshold } = stashCfg(settings);
  const t = Math.min(edgeThreshold, isVert(side) ? wa.width : wa.height);
  if (isVert(side)) {
    const width = t;
    const x = side === 'left' ? wa.x : wa.x + wa.width - width;
    return { x, y: wa.y, width, height: wa.height };
  }
  const height = t;
  const y = side === 'top' ? wa.y : wa.y + wa.height - height;
  return { x: wa.x, y, width: wa.width, height };
}

/** 点是否落在矩形内（半开区间 [x, x+width) × [y, y+height)）。 */
function pointInRect(pt, r) {
  if (!pt || !r) return false;
  const x = Number(pt.x);
  const y = Number(pt.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

/**
 * 光标是否命中边缘热区（在 edgeZone 基础上向内扩 EDGE_MARGIN 触边容差）。
 * @returns {boolean}
 */
function hitEdge(cursor, workArea, settings) {
  const cfg = stashCfg(settings);
  if (!cfg.edgeHot) return false; // 热区关闭 → 永不命中
  const zone = edgeZone(workArea, settings);
  // 容差只向屏内扩：垂直边左右扩、水平边上下扩
  let expanded;
  if (cfg.side === 'left') expanded = { x: zone.x, y: zone.y, width: zone.width + EDGE_MARGIN, height: zone.height };
  else if (cfg.side === 'right') expanded = { x: zone.x - EDGE_MARGIN, y: zone.y, width: zone.width + EDGE_MARGIN, height: zone.height };
  else if (cfg.side === 'top') expanded = { x: zone.x, y: zone.y, width: zone.width, height: zone.height + EDGE_MARGIN };
  else expanded = { x: zone.x, y: zone.y - EDGE_MARGIN, width: zone.width, height: zone.height + EDGE_MARGIN }; // bottom
  return pointInRect(cursor, expanded);
}

/**
 * 越界兜底：把矩形夹回 workArea 内（多屏 / 拔屏后防丢）。
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function clampRect(rect, workArea) {
  const wa = normWorkArea(workArea);
  const r = rect && typeof rect === 'object' ? rect : {};
  const width = clamp(Math.round(Number(r.width) || CAPSULE.w), 1, wa.width);
  const height = clamp(Math.round(Number(r.height) || CAPSULE.h), 1, wa.height);
  const x = clamp(Math.round(Number(r.x) || 0), wa.x, wa.x + wa.width - width);
  const y = clamp(Math.round(Number(r.y) || 0), wa.y, wa.y + wa.height - height);
  return { x, y, width, height };
}

/**
 * 是否应自动收起（纯判定，供主进程 300ms tick 调用）。
 * 条件：处于 open、非 pinned、非 dragging、距上次活动已超过 autoHideDelay，
 *       且光标不在（带容差的）面板矩形内。
 * @param {object} prev 上一状态（须含 mode/pinned/dragging/lastActivity/rect）
 * @param {{x:number,y:number}|null} cursor 光标逻辑坐标
 * @param {number} now 当前时间戳（ms）
 * @param {object} settings
 * @returns {boolean}
 */
function shouldAutoCollapse(prev, cursor, now, settings) {
  if (!prev || prev.mode !== 'open') return false;
  if (prev.pinned || prev.dragging) return false;
  const cfg = stashCfg(settings);
  const last = Number(prev.lastActivity);
  const t = Number(now);
  if (!Number.isFinite(last) || !Number.isFinite(t)) return false;
  if (t - last < cfg.autoHideDelay) return false;
  // 光标仍在面板内（留 EDGE_MARGIN 容差）→ 不收起，避免刚展开就被鼠标判定误收
  const rect = prev.rect;
  if (rect) {
    const expanded = {
      x: rect.x - EDGE_MARGIN,
      y: rect.y - EDGE_MARGIN,
      width: rect.width + EDGE_MARGIN * 2,
      height: rect.height + EDGE_MARGIN * 2,
    };
    if (pointInRect(cursor, expanded)) return false;
  }
  return true;
}

/**
 * 状态机 reducer：上一状态 + 事件 + 上下文 → 下一状态 + 目标矩形 + 是否可交互。
 *
 * 事件：INIT / SHOW / TOGGLE / HIDE / HOVER_IN / HOVER_OUT /
 *       DRAG_ENTER / DRAG_LEAVE / PIN_TOGGLE / TICK / RESYNC
 * @param {object|null} prev 上一状态（可为 null）
 * @param {string} event
 * @param {object} ctx { workArea, settings, cursor, now, lastActivity }
 * @returns {{mode:string,pinned:boolean,dragging:boolean,rect:object,interactive:boolean,lastActivity:number}}
 */
function resolvePanelState(prev, event, ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const settings = c.settings || {};
  const cfg = stashCfg(settings);
  const wa = normWorkArea(c.workArea);
  const nowNum = Number(c.now);
  const now = Number.isFinite(nowNum) ? nowNum : Date.now();

  const prevMode = prev && MODES.includes(prev.mode) ? prev.mode : null;
  let mode = prevMode || (cfg.panelEnabled ? 'capsule' : 'hidden');
  let pinned = !!(prev && prev.pinned);
  let dragging = !!(prev && prev.dragging);
  let lastActivity = prev && Number.isFinite(Number(prev.lastActivity))
    ? Number(prev.lastActivity)
    : now;

  const ev = String(event || 'TICK');

  switch (ev) {
    case 'INIT':
      // 初始形态由「常驻胶囊」开关决定
      mode = cfg.panelEnabled ? 'capsule' : 'hidden';
      lastActivity = now;
      break;

    case 'SHOW':
      // 强制展开（热键 / Tray 路径）
      mode = 'open';
      lastActivity = now;
      break;

    case 'TOGGLE':
      // 展开态 → 收起为胶囊；其余 → 展开为抽屉
      mode = mode === 'open' ? 'capsule' : 'open';
      lastActivity = now;
      break;

    case 'HIDE':
      // 设置里关闭常驻胶囊：完全隐藏
      mode = 'hidden';
      break;

    case 'HOVER_IN':
      // hidden 态下只有开启「边缘热区」才允许撞边展开
      if (mode === 'hidden' && !cfg.edgeHot) break;
      mode = 'open';
      lastActivity = now;
      break;

    case 'HOVER_OUT':
      // 只刷新活动时间；真正收起交给 TICK + shouldAutoCollapse（保证延时可配）
      lastActivity = now;
      break;

    case 'DRAG_ENTER':
      // 拖拽悬停即展开，并锁定展开（拖拽期间禁止自动收起）
      mode = 'open';
      dragging = true;
      lastActivity = now;
      break;

    case 'DRAG_LEAVE':
      dragging = false;
      lastActivity = now;
      break;

    case 'PIN_TOGGLE':
      pinned = !pinned;
      if (pinned) mode = 'open'; // 钉住 = 展开且永不自动收起
      lastActivity = now;
      break;

    case 'TICK': {
      const snapshot = { mode, pinned, dragging, lastActivity, rect: prev && prev.rect };
      if (shouldAutoCollapse(snapshot, c.cursor, now, settings)) mode = 'capsule';
      break;
    }

    case 'RESYNC':
    default:
      // 仅按当前 mode 重算矩形（显示器变化 / 设置变更时用）
      break;
  }

  const rawRect = mode === 'open' ? panelRect(wa, settings) : capsuleRect(wa, settings);
  const rect = clampRect(rawRect, wa);
  const interactive = mode !== 'hidden'; // §2.5：胶囊与抽屉均保持可交互（拖入需要）

  return { mode, pinned, dragging, rect, interactive, lastActivity };
}

module.exports = {
  CAPSULE,
  PANEL,
  SHELF_ROW_H,
  SHELF_PAD_H,
  EDGE_MARGIN,
  capsuleRect,
  panelRect,
  hitEdge,
  edgeZone,
  stashCfg,
  resolvePanelState,
  shouldAutoCollapse,
  clampRect,
};
