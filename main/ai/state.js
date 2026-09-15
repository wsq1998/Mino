// Mio - AI 助手：窗口几何 / 状态机 / 运行态（纯函数，零副作用，不 require electron）
//
// 与 main/core/stashPanel.js 同构（同一套「一个窗口多形态」范式，见 docs/16 §6.1）：
//   capsule（贴边细条，常驻）⇄ bar（输入条，唤醒后默认态）⇄ open（面板，看执行流）
//   一切屏幕坐标以「显示器 workArea 逻辑像素」为输入，同一输入必得同一输出 → 可 node --test 单测。
//
// 与中转站的关键差异
//   · 多一个中间态 bar（输入条）：中转站是「胶囊 ⇄ 抽屉」两态，助手是三态。
//     输入条存在的唯一理由是「让你打字」：唤醒即弹、只干一件事。
//   · 面板尺寸不同（侧抽屉 420 宽 / 顶底货架 980 宽，后者沿用 v2.15 的货架宽度上限）。
//   · 触发边独立于中转站（settings.ai.edgeSide ≠ settings.stash.edgeSide），两者可各占一边。
//
// 依赖：无（仅内置 Math / Date / Array）。

'use strict';

const DIRS = ['top', 'bottom', 'left', 'right'];
const isVert = (side) => side === 'left' || side === 'right';

const CAPSULE_T = 6;               // 胶囊厚度（垂直边=宽，水平边=高）
const CAPSULE_LEN = 104;           // 胶囊沿边长度
const BAR = { w: 560, h: 64 };     // 输入条：宽 560 / 高 64（§6.1）
const PANEL_W = 420;               // 侧抽屉宽度
const SHELF_H = 360;               // 顶/底货架高度
const PANEL_MAX_W = 980;           // 货架最大宽度（与中转站 v2.15 对齐）
const PANEL_MARGIN_X = 56;
const PANEL_MARGIN_Y = 56;
const PANEL_MAX_RATIO = 0.72;      // 侧抽屉最大占屏比例
const EDGE_INSET = 6;              // 输入条离屏幕边缘的内缩

const DEFAULT_WORKAREA = { x: 0, y: 0, width: 1440, height: 900 };
const MODES = ['hidden', 'capsule', 'bar', 'open'];

// 运行态：驱动状态点与托盘提示（§6.1 状态点语义）
const RUN_STATES = ['idle', 'running', 'waiting', 'error'];

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 归一化 workArea；非法输入回退默认屏。 */
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

/** 从 settings 抽出与助手窗口相关的收口配置（容错，缺失即用默认）。 */
function aiCfg(settings) {
  const s = settings && typeof settings.ai === 'object' && settings.ai ? settings.ai : {};
  return {
    side: DIRS.includes(s.edgeSide) ? s.edgeSide : 'right',
    showCapsule: s.showCapsule !== false, // 缺省开常驻胶囊
    enabled: s.enabled === true,          // 缺省关：未启用时不显示任何入口
  };
}

/** 贴边锚定：沿边方向居中，垂直于边的方向贴到指定边缘。 */
function anchoredRect(wa, width, height, side, inset) {
  const m = Number.isFinite(inset) ? inset : 0;
  const centeredX = wa.x + Math.round((wa.width - width) / 2);
  const centeredY = wa.y + Math.round((wa.height - height) / 2);
  if (side === 'left') return { x: wa.x + m, y: centeredY, width, height };
  if (side === 'right') return { x: wa.x + wa.width - width - m, y: centeredY, width, height };
  if (side === 'top') return { x: centeredX, y: wa.y + m, width, height };
  return { x: centeredX, y: wa.y + wa.height - height - m, width, height }; // bottom
}

/** 胶囊矩形：贴指定屏缘的细条。 */
function capsuleRect(workArea, settings) {
  const wa = normWorkArea(workArea);
  const { side } = aiCfg(settings);
  const t = Math.min(CAPSULE_T, isVert(side) ? wa.width : wa.height);
  const len = Math.min(CAPSULE_LEN, isVert(side) ? wa.height : wa.width);
  const width = isVert(side) ? t : len;
  const height = isVert(side) ? len : t;
  return anchoredRect(wa, width, height, side, 0);
}

/**
 * 输入条矩形：唤醒后的默认态。始终贴触发边（略内缩），便于「按热键就在那一侧弹出」。
 * 小屏自适应：宽高都不超过屏宽/屏高减 2×内缩。
 */
function barRect(workArea, settings) {
  const wa = normWorkArea(workArea);
  const { side } = aiCfg(settings);
  const width = Math.min(BAR.w, Math.max(200, wa.width - EDGE_INSET * 2));
  const height = Math.min(BAR.h, Math.max(48, wa.height - EDGE_INSET * 2));
  // 输入条离边的内缩比胶囊大一点，否则贴着屏幕边缘打字会碰到菜单栏/Dock
  const inset = isVert(side) ? Math.min(PANEL_MARGIN_X, Math.round(wa.width * 0.06)) : 12;
  return anchoredRect(wa, width, height, side, inset);
}

/**
 * 面板矩形：垂直边=侧抽屉（宽固定 420、高随屏），水平边=顶/底货架（宽随屏≤980、高固定）。
 */
function panelRect(workArea, settings) {
  const wa = normWorkArea(workArea);
  const { side } = aiCfg(settings);
  if (isVert(side)) {
    const width = Math.min(PANEL_W, wa.width);
    const marginY = Math.min(PANEL_MARGIN_Y, Math.round(wa.height * 0.1));
    const maxH = Math.max(240, Math.round(wa.height * PANEL_MAX_RATIO));
    const height = Math.min(Math.max(240, wa.height - marginY * 2), maxH);
    return anchoredRect(wa, width, height, side, 0);
  }
  const height = Math.min(SHELF_H, wa.height);
  const marginX = Math.min(PANEL_MARGIN_X, Math.round(wa.width * 0.1));
  const maxW = Math.max(320, Math.min(PANEL_MAX_W, wa.width));
  const width = Math.min(Math.max(320, wa.width - marginX * 2), maxW);
  return anchoredRect(wa, width, height, side, 0);
}

/** 越界兜底：把矩形夹回 workArea 内（多屏 / 拔屏后防丢）。 */
function clampRect(rect, workArea) {
  const wa = normWorkArea(workArea);
  const r = rect && typeof rect === 'object' ? rect : {};
  const width = clamp(Math.round(Number(r.width) || BAR.w), 1, wa.width);
  const height = clamp(Math.round(Number(r.height) || BAR.h), 1, wa.height);
  const x = clamp(Math.round(Number(r.x) || 0), wa.x, wa.x + wa.width - width);
  const y = clamp(Math.round(Number(r.y) || 0), wa.y, wa.y + wa.height - height);
  return { x, y, width, height };
}

/**
 * 运行态 reducer：把 opencode 的 SSE 事件名收成 4 个运行态（§6.1 状态点）。
 * 只认事件名，不碰事件体 —— 保证纯函数、可单测。
 * @param {string} prev 上一运行态（非法则视为 'idle'）
 * @param {string} eventType SSE 事件 type，如 'session.next.tool.called'
 * @returns {string} RUN_STATES 之一
 */
function deriveRunState(prev, eventType) {
  const cur = RUN_STATES.includes(prev) ? prev : 'idle';
  const t = String(eventType || '');
  if (!t) return cur;
  // 需要人 → 优先于运行中（状态点亮红比转圈更该被看到）
  if (t.startsWith('permission.') || t.startsWith('question.')) {
    if (t.endsWith('.replied') || t.endsWith('.rejected')) return 'running';
    return 'waiting';
  }
  if (t === 'session.idle') return 'idle';
  if (t === 'session.error') return 'error';
  if (
    t.startsWith('session.next.') ||
    t === 'session.status' ||
    t === 'message.updated' ||
    t === 'message.part.updated' ||
    t === 'message.part.delta'
  ) {
    return 'running';
  }
  return cur;
}

/**
 * 窗口状态机 reducer。
 *
 * 事件：
 *   INIT      —— 初始化（形态由「常驻胶囊」开关决定）
 *   WAKE      —— 热键/入口唤起 → 输入条态（并聚焦输入框）
 *   EXPAND    —— 输入条 → 面板（↑ 或点「展开」）
 *   COLLAPSE  —— 面板 → 输入条（Esc）
 *   SHOW      —— 直接展开到面板（Tray / 恢复）
 *   TOGGLE    —— 面板 ⇄ 输入条
 *   HIDE      —— 收起到胶囊（无胶囊则 hidden）
 *   DISABLE   —— 总开关关闭 / 引擎不可用 → 完全隐藏
 *   RESYNC    —— 显示器/设置变化，仅重算矩形
 *
 * @param {object|null} prev
 * @param {string} event
 * @param {object} ctx { workArea, settings }
 * @returns {{mode:string, rect:object, interactive:boolean}}
 */
function resolveWindowState(prev, event, ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const settings = c.settings || {};
  const cfg = aiCfg(settings);
  const wa = normWorkArea(c.workArea);

  const prevMode = prev && MODES.includes(prev.mode) ? prev.mode : null;
  let mode = prevMode || (cfg.enabled ? (cfg.showCapsule ? 'capsule' : 'hidden') : 'hidden');

  switch (String(event || 'TICK')) {
    case 'INIT':
      mode = !cfg.enabled ? 'hidden' : (cfg.showCapsule ? 'capsule' : 'hidden');
      break;
    case 'WAKE':
      // 唤起永远到输入条态 —— 这条路径是「一个键 → 打字 → 回车」的主干，不能被动摇
      mode = cfg.enabled ? 'bar' : 'hidden';
      break;
    case 'EXPAND':
    case 'SHOW':
      mode = cfg.enabled ? 'open' : 'hidden';
      break;
    case 'COLLAPSE':
      mode = cfg.enabled ? 'bar' : 'hidden';
      break;
    case 'TOGGLE':
      mode = !cfg.enabled ? 'hidden' : (mode === 'open' ? 'bar' : 'open');
      break;
    case 'HIDE':
      mode = !cfg.enabled ? 'hidden' : (cfg.showCapsule ? 'capsule' : 'hidden');
      break;
    case 'DISABLE':
      mode = 'hidden';
      break;
    case 'RESYNC':
    default:
      break;
  }

  let raw;
  if (mode === 'open') raw = panelRect(wa, settings);
  else if (mode === 'bar') raw = barRect(wa, settings);
  else raw = capsuleRect(wa, settings);

  const rect = clampRect(raw, wa);
  // ⚠️ 与中转站同一铁律：胶囊态也必须保持可交互（拖文件进来要能接住），绝不开鼠标穿透
  const interactive = mode !== 'hidden';
  return { mode, rect, interactive };
}

module.exports = {
  BAR,
  PANEL_W,
  SHELF_H,
  PANEL_MAX_W,
  MODES,
  RUN_STATES,
  DIRS,
  aiCfg,
  capsuleRect,
  barRect,
  panelRect,
  clampRect,
  deriveRunState,
  resolveWindowState,
};
