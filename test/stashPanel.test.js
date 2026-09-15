// Mio - v2.1 中转站浮窗纯函数层单元测试（node:test，零第三方）
// 覆盖：几何（capsuleRect / panelRect / edgeZone）、命中（hitEdge / clampRect）、
//       状态机（resolvePanelState 各事件转移）、自动收起（shouldAutoCollapse）。
// 边界：多显示器（带偏移的 workArea）/ 屏幕缩放（等比例小数）/ 越界坐标 / 无热区 / 空输入。
// 运行：npm test（= node --test test/*.test.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const sp = require('../main/core/stashPanel.js');

// 常见 workArea：主屏 1440×900（无偏移）、副屏在左侧（负偏移）、HiDPI 缩放到 1.5x 的等效逻辑区
const WA_MAIN = { x: 0, y: 0, width: 1440, height: 900 };
const WA_LEFT = { x: -1920, y: 0, width: 1920, height: 1080 };
const WA_RETINA = { x: 0, y: 25, width: 1512, height: 945 }; // 顶部菜单栏 25px

const S_DEFAULT = { stash: { edgeSide: 'right', edgeThreshold: 6, autoHideDelay: 1200, panelEnabled: true, edgeHot: true } };

// ===== v2.2 dragAutoShow 配置出口 =====
test('stashCfg.dragAutoShow：缺省开、可经设置关', () => {
  assert.equal(sp.stashCfg({ stash: {} }).dragAutoShow, true, '缺省开启华为式触发');
  assert.equal(sp.stashCfg({ stash: { dragAutoShow: false } }).dragAutoShow, false, '设置可关');
  assert.equal(sp.stashCfg({ stash: { dragAutoShow: 'x' } }).dragAutoShow, true, '脏值回退开');
});

// ===== 常量 =====
test('stashPanel 导出常量与关键函数', () => {
  assert.deepEqual(sp.CAPSULE, { w: 6, h: 104 });
  assert.equal(sp.PANEL.w, 260);
  assert.equal(sp.EDGE_MARGIN, 10);
  for (const fn of ['capsuleRect', 'panelRect', 'hitEdge', 'edgeZone', 'resolvePanelState', 'shouldAutoCollapse', 'clampRect']) {
    assert.equal(typeof sp[fn], 'function', `缺少函数 ${fn}`);
  }
});

// ===== capsuleRect =====
test('capsuleRect 贴右缘、垂直居中', () => {
  const r = sp.capsuleRect(WA_MAIN, S_DEFAULT);
  assert.equal(r.width, 6);
  assert.equal(r.height, 104);
  assert.equal(r.x, 1440 - 6);                       // 紧贴右缘
  assert.equal(r.y, Math.round((900 - 104) / 2));    // 垂直居中
});

test('capsuleRect 尊重 workArea 偏移（副屏在左）', () => {
  const r = sp.capsuleRect(WA_LEFT, S_DEFAULT);
  assert.equal(r.x, -1920 + 1920 - 6); // = -6 → 该屏右缘
  assert.equal(r.y, Math.round((1080 - 104) / 2));
});

test('capsuleRect edgeSide=left 贴左缘', () => {
  const r = sp.capsuleRect(WA_MAIN, { stash: { edgeSide: 'left' } });
  assert.equal(r.x, 0);
});

test('capsuleRect 非法 workArea 回退默认屏（不抛错）', () => {
  for (const bad of [null, undefined, {}, { width: 0, height: 0 }, { x: NaN, y: 0, width: 100, height: 100 }]) {
    const r = sp.capsuleRect(bad, S_DEFAULT);
    assert.equal(r.width, 6);
    assert.equal(r.height, 104);
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
  }
});

test('capsuleRect 小屏幕收敛（高度不超过 workArea）', () => {
  const r = sp.capsuleRect({ x: 0, y: 0, width: 40, height: 60 }, S_DEFAULT);
  assert.equal(r.height, 60);      // 收敛到 workArea 高
  assert.equal(r.width, 6);
  assert.ok(r.y >= 0);
});

// ===== panelRect =====
test('panelRect 宽度 260、纵向内缩、贴右缘', () => {
  const r = sp.panelRect(WA_MAIN, S_DEFAULT);
  assert.equal(r.width, 260);
  assert.equal(r.x, 1440 - 260);
  assert.ok(r.height < 900 && r.height > 500); // v2.2：限高（≤66% 屏高）后显著小于屏高
  assert.ok(r.y > 0);
});

test('panelRect 高分辨率屏（菜单栏偏移）仍居中于 workArea', () => {
  const r = sp.panelRect(WA_RETINA, S_DEFAULT);
  assert.equal(r.x, 1512 - 260);
  assert.equal(r.y, 25 + Math.round((945 - r.height) / 2));
});

test('panelRect 超窄屏宽度收敛', () => {
  const r = sp.panelRect({ x: 0, y: 0, width: 200, height: 600 }, S_DEFAULT);
  assert.equal(r.width, 200);
  assert.ok(r.x >= 0);
});

// ===== edgeZone / hitEdge =====
test('edgeZone 厚度 = edgeThreshold，覆盖整屏高、贴右缘', () => {
  const z = sp.edgeZone(WA_MAIN, { stash: { edgeThreshold: 10 } });
  assert.equal(z.width, 10);
  assert.equal(z.x, 1440 - 10);
  assert.equal(z.height, 900);
});

test('hitEdge 命中右缘、屏中央不命中', () => {
  assert.equal(sp.hitEdge({ x: 1439, y: 400 }, WA_MAIN, S_DEFAULT), true);
  assert.equal(sp.hitEdge({ x: 720, y: 450 }, WA_MAIN, S_DEFAULT), false);
});

test('hitEdge 受 edgeThreshold 灵敏度影响', () => {
  const pt = { x: 1415, y: 400 }; // 距右缘 25px，明显超出 EDGE_MARGIN(10) 容差带
  assert.equal(sp.hitEdge(pt, WA_MAIN, { stash: { edgeThreshold: 24 } }), true);
  assert.equal(sp.hitEdge(pt, WA_MAIN, { stash: { edgeThreshold: 1 } }), false);
});

test('hitEdge 关闭 edgeHot 时永不命中（无热区）', () => {
  assert.equal(sp.hitEdge({ x: 1439, y: 400 }, WA_MAIN, { stash: { edgeHot: false } }), false);
});

test('hitEdge 越界/非法光标坐标返回 false', () => {
  assert.equal(sp.hitEdge({ x: -5, y: -5 }, WA_MAIN, S_DEFAULT), false);
  assert.equal(sp.hitEdge(null, WA_MAIN, S_DEFAULT), false);
  assert.equal(sp.hitEdge({ x: NaN, y: 400 }, WA_MAIN, S_DEFAULT), false);
});

test('hitEdge 左侧边缘模式（edgeSide=left）', () => {
  assert.equal(sp.hitEdge({ x: 1, y: 400 }, WA_MAIN, { stash: { edgeSide: 'left', edgeThreshold: 6 } }), true);
  assert.equal(sp.hitEdge({ x: 1439, y: 400 }, WA_MAIN, { stash: { edgeSide: 'left', edgeThreshold: 6 } }), false);
});

// ===== v2.3 四向触发（top/bottom 水平货架）=====
test('capsuleRect top：贴顶部、水平居中的横条', () => {
  const r = sp.capsuleRect(WA_MAIN, { stash: { edgeSide: 'top' } });
  assert.equal(r.height, 6);
  assert.equal(r.y, WA_MAIN.y);
  assert.ok(r.width > 6 && r.width <= 104);
  assert.ok(Math.abs((r.x + r.width / 2) - (WA_MAIN.x + WA_MAIN.width / 2)) < 2); // 水平居中
});

test('panelRect top：贴顶部横向货架（默认 2 行高，宽受 PANEL_MAX_W 限制）', () => {
  const r = sp.panelRect(WA_MAIN, { stash: { edgeSide: 'top' } });
  assert.equal(r.y, WA_MAIN.y);
  assert.equal(r.height, 2 * sp.SHELF_ROW_H + sp.SHELF_PAD_H); // 默认 2 行 = 144
  // v2.15 货架加宽：PANEL_MAX_W 640→980，1440 屏下货架宽从 640 提到 980（屏宽-112 仍大于 980）
  assert.ok(r.width >= 200 && r.width <= 980);
  assert.equal(r.width, 980, '1440 屏下 top 货架应取到 PANEL_MAX_W=980（不再被 640 卡死）');
});

test('panelRect top：超宽屏货架宽收敛到 PANEL_MAX_W（不随屏无限加宽）', () => {
  const r = sp.panelRect({ x: 0, y: 0, width: 2560, height: 1440 }, { stash: { edgeSide: 'top' } });
  assert.equal(r.width, 980, '2560 宽屏下货架也应收敛到 980，不铺满全屏');
});

test('panelRect top：shelfExpanded=true 时高度变为 3 行（444）', () => {
  const r = sp.panelRect(WA_MAIN, { stash: { edgeSide: 'top', shelfExpanded: true } });
  assert.equal(r.y, WA_MAIN.y);
  assert.equal(r.height, 3 * sp.SHELF_ROW_H + sp.SHELF_PAD_H); // 展开 3 行 = 204
});

test('panelRect bottom：默认 2 行、展开 3 行、贴底部', () => {
  const collapsed = sp.panelRect(WA_MAIN, { stash: { edgeSide: 'bottom' } });
  assert.equal(collapsed.height, 2 * sp.SHELF_ROW_H + sp.SHELF_PAD_H);
  assert.equal(collapsed.y, WA_MAIN.y + WA_MAIN.height - collapsed.height);
  const expanded = sp.panelRect(WA_MAIN, { stash: { edgeSide: 'bottom', shelfExpanded: true } });
  assert.equal(expanded.height, 3 * sp.SHELF_ROW_H + sp.SHELF_PAD_H);
  assert.equal(expanded.y, WA_MAIN.y + WA_MAIN.height - expanded.height);
});

test('panelRect top：货架高度受 workArea 高度钳制（小屏）', () => {
  // v2.11 行高 140→60 后，2行=144 / 3行=204。用 height:150 可让 3 行(204) 触发钳制、2 行(144) 不触发。
  const wa = { x: 0, y: 0, width: 800, height: 150 };
  const collapsed = sp.panelRect(wa, { stash: { edgeSide: 'top' } });
  assert.equal(collapsed.height, 2 * sp.SHELF_ROW_H + sp.SHELF_PAD_H); // 2行 144 < 150 → 不钳，正常 2 行高
  const expanded = sp.panelRect(wa, { stash: { edgeSide: 'top', shelfExpanded: true } });
  assert.equal(expanded.height, wa.height); // 3行 204 > 150 → 钳到屏高 150
});

test('stashCfg.shelfExpanded：缺省 false、true 生效、脏值回退 false', () => {
  assert.equal(sp.stashCfg({ stash: {} }).shelfExpanded, false);
  assert.equal(sp.stashCfg({ stash: { shelfExpanded: true } }).shelfExpanded, true);
  assert.equal(sp.stashCfg({ stash: { shelfExpanded: 'yes' } }).shelfExpanded, false);
});

test('edgeZone / hitEdge top：光标贴顶部命中、贴底部不命中', () => {
  const s = { stash: { edgeSide: 'top', edgeThreshold: 6, edgeHot: true } };
  assert.equal(sp.hitEdge({ x: 700, y: WA_MAIN.y + 2 }, WA_MAIN, s), true);
  assert.equal(sp.hitEdge({ x: 700, y: WA_MAIN.y + 400 }, WA_MAIN, s), false);
});

test('edgeZone / hitEdge bottom：光标贴底部命中、贴顶部不命中', () => {
  const s = { stash: { edgeSide: 'bottom', edgeThreshold: 6, edgeHot: true } };
  assert.equal(sp.hitEdge({ x: 700, y: WA_MAIN.y + WA_MAIN.height - 2 }, WA_MAIN, s), true);
  assert.equal(sp.hitEdge({ x: 700, y: WA_MAIN.y + 10 }, WA_MAIN, s), false);
});

test('stashCfg edgeSide：四向合法、非法回退 right', () => {
  assert.equal(sp.stashCfg({ stash: { edgeSide: 'top' } }).side, 'top');
  assert.equal(sp.stashCfg({ stash: { edgeSide: 'bottom' } }).side, 'bottom');
  assert.equal(sp.stashCfg({ stash: { edgeSide: 'diagonal' } }).side, 'right');
  assert.equal(sp.stashCfg({ stash: {} }).side, 'right');
});

test('resolvePanelState SHOW top：面板矩形为顶部横向货架（默认 2 行）', () => {
  const ctx = { workArea: WA_MAIN, settings: { stash: { edgeSide: 'top' } }, now: 1000 };
  const open = sp.resolvePanelState(sp.resolvePanelState(null, 'INIT', ctx), 'SHOW', ctx);
  assert.equal(open.mode, 'open');
  assert.equal(open.rect.y, WA_MAIN.y);
  assert.equal(open.rect.height, 2 * sp.SHELF_ROW_H + sp.SHELF_PAD_H);
});

test('resolvePanelState SHOW top：shelfExpanded=true 时货架 3 行高', () => {
  const ctx = { workArea: WA_MAIN, settings: { stash: { edgeSide: 'top', shelfExpanded: true } }, now: 1000 };
  const open = sp.resolvePanelState(sp.resolvePanelState(null, 'INIT', ctx), 'SHOW', ctx);
  assert.equal(open.mode, 'open');
  assert.equal(open.rect.y, WA_MAIN.y);
  assert.equal(open.rect.height, 3 * sp.SHELF_ROW_H + sp.SHELF_PAD_H);
});

// ===== clampRect =====
test('clampRect 把越界矩形夹回 workArea', () => {
  const r = sp.clampRect({ x: -500, y: -500, width: 260, height: 600 }, WA_MAIN);
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
  assert.equal(r.width, 260);
  assert.equal(r.height, 600);
});

test('clampRect 右下越界夹取 + 尺寸收敛到屏内', () => {
  const r = sp.clampRect({ x: 5000, y: 5000, width: 260, height: 2000 }, WA_MAIN);
  assert.equal(r.x, 1440 - 260);
  assert.equal(r.y, 900 - 900); // height 收敛到 900
  assert.equal(r.height, 900);
});

test('clampRect 空/非法输入安全（回退胶囊尺寸并夹进 workArea）', () => {
  const r = sp.clampRect(null, WA_MAIN);
  assert.equal(r.width, sp.CAPSULE.w);
  assert.equal(r.height, sp.CAPSULE.h);
  assert.equal(r.x, 0);   // 缺省 x=0 → 夹到 workArea 左缘
  assert.equal(r.y, 0);
});

// ===== resolvePanelState =====
test('resolvePanelState INIT：panelEnabled 决定初始形态', () => {
  const on = sp.resolvePanelState(null, 'INIT', { workArea: WA_MAIN, settings: S_DEFAULT, now: 1000 });
  assert.equal(on.mode, 'capsule');
  assert.equal(on.rect.width, 6);
  assert.equal(on.interactive, true);

  const off = sp.resolvePanelState(null, 'INIT', { workArea: WA_MAIN, settings: { stash: { panelEnabled: false } }, now: 1000 });
  assert.equal(off.mode, 'hidden');
  assert.equal(off.interactive, false);
});

test('resolvePanelState SHOW / TOGGLE / HIDE 转移', () => {
  const ctx = { workArea: WA_MAIN, settings: S_DEFAULT, now: 1000 };
  let st = sp.resolvePanelState(null, 'INIT', ctx);
  st = sp.resolvePanelState(st, 'SHOW', ctx);
  assert.equal(st.mode, 'open');
  assert.equal(st.rect.width, 260);
  st = sp.resolvePanelState(st, 'TOGGLE', ctx);
  assert.equal(st.mode, 'capsule');
  st = sp.resolvePanelState(st, 'TOGGLE', ctx);
  assert.equal(st.mode, 'open');
  st = sp.resolvePanelState(st, 'HIDE', ctx);
  assert.equal(st.mode, 'hidden');
});

test('resolvePanelState HOVER_IN：capsule→open；hidden 且开热区也展开', () => {
  const ctx = { workArea: WA_MAIN, settings: S_DEFAULT, now: 1000 };
  const cap = sp.resolvePanelState(null, 'INIT', ctx); // capsule
  assert.equal(sp.resolvePanelState(cap, 'HOVER_IN', ctx).mode, 'open');
  const hid = sp.resolvePanelState(null, 'INIT', { ...ctx, settings: { stash: { panelEnabled: false, edgeHot: true } } });
  assert.equal(sp.resolvePanelState(hid, 'HOVER_IN', ctx).mode, 'open'); // edgeHot 开 → 可展开
});

test('resolvePanelState HOVER_IN：hidden 且关热区保持 hidden', () => {
  const ctx = { workArea: WA_MAIN, settings: { stash: { panelEnabled: false, edgeHot: false } }, now: 1000 };
  const hid = sp.resolvePanelState(null, 'INIT', ctx);
  assert.equal(hid.mode, 'hidden');
  assert.equal(sp.resolvePanelState(hid, 'HOVER_IN', ctx).mode, 'hidden');
});

test('resolvePanelState DRAG_ENTER 展开并锁 dragging；DRAG_LEAVE 复位', () => {
  const ctx = { workArea: WA_MAIN, settings: S_DEFAULT, now: 1000 };
  let st = sp.resolvePanelState(null, 'INIT', ctx);
  st = sp.resolvePanelState(st, 'DRAG_ENTER', ctx);
  assert.equal(st.mode, 'open');
  assert.equal(st.dragging, true);
  st = sp.resolvePanelState(st, 'DRAG_LEAVE', ctx);
  assert.equal(st.dragging, false);
});

test('resolvePanelState PIN_TOGGLE：钉住即展开；再点取消', () => {
  const ctx = { workArea: WA_MAIN, settings: S_DEFAULT, now: 1000 };
  let st = sp.resolvePanelState(null, 'INIT', ctx); // capsule
  st = sp.resolvePanelState(st, 'PIN_TOGGLE', ctx);
  assert.equal(st.pinned, true);
  assert.equal(st.mode, 'open');
  st = sp.resolvePanelState(st, 'PIN_TOGGLE', ctx);
  assert.equal(st.pinned, false);
});

test('resolvePanelState TICK：超时自动收起（capsule）', () => {
  const ctx = { workArea: WA_MAIN, settings: S_DEFAULT, now: 1000, cursor: { x: 10, y: 10 } };
  let st = sp.resolvePanelState(null, 'INIT', ctx);
  st = sp.resolvePanelState(st, 'SHOW', ctx); // open, lastActivity=1000
  // 未到 autoHideDelay（1200）
  let tick = sp.resolvePanelState(st, 'TICK', { ...ctx, now: 1500, cursor: { x: 10, y: 10 } });
  assert.equal(tick.mode, 'open');
  // 超过 autoHideDelay，且光标远离面板
  tick = sp.resolvePanelState(st, 'TICK', { ...ctx, now: 2600, cursor: { x: 10, y: 10 } });
  assert.equal(tick.mode, 'capsule');
});

test('resolvePanelState TICK：pinned / dragging / 光标在面板内均不收起', () => {
  const base = { workArea: WA_MAIN, settings: S_DEFAULT, now: 1000 };
  // pinned
  let st = sp.resolvePanelState(null, 'SHOW', base); // open
  st = { ...st, pinned: true, lastActivity: 0 };
  let tick = sp.resolvePanelState(st, 'TICK', { ...base, now: 99999, cursor: { x: 10, y: 10 } });
  assert.equal(tick.mode, 'open');
  // dragging
  st = { ...st, pinned: false, dragging: true, lastActivity: 0 };
  tick = sp.resolvePanelState(st, 'TICK', { ...base, now: 99999, cursor: { x: 10, y: 10 } });
  assert.equal(tick.mode, 'open');
  // 光标在面板矩形内
  st = { ...st, dragging: false, lastActivity: 0, rect: sp.panelRect(WA_MAIN, S_DEFAULT) };
  tick = sp.resolvePanelState(st, 'TICK', { ...base, now: 99999, cursor: { x: 1400, y: 400 } });
  assert.equal(tick.mode, 'open');
});

test('resolvePanelState RESYNC：仅重算矩形，不改 mode/pinned', () => {
  const ctx = { workArea: WA_MAIN, settings: S_DEFAULT, now: 1000 };
  let st = sp.resolvePanelState(null, 'INIT', ctx);
  st = sp.resolvePanelState(st, 'SHOW', ctx);
  st = sp.resolvePanelState(st, 'PIN_TOGGLE', ctx); // pinned true, open
  const resynced = sp.resolvePanelState(st, 'RESYNC', { workArea: WA_LEFT, settings: S_DEFAULT, now: 2000 });
  assert.equal(resynced.mode, 'open');
  assert.equal(resynced.pinned, true);
  assert.equal(resynced.rect.x, -1920 + 1920 - 260); // 移到副屏右缘
});

// ===== shouldAutoCollapse =====
test('shouldAutoCollapse 非 open 一律 false', () => {
  assert.equal(sp.shouldAutoCollapse({ mode: 'capsule', lastActivity: 0 }, { x: 10, y: 10 }, 99999, S_DEFAULT), false);
  assert.equal(sp.shouldAutoCollapse(null, { x: 10, y: 10 }, 99999, S_DEFAULT), false);
});

test('shouldAutoCollapse 延时内 false、超时且光标在外 true', () => {
  const prev = { mode: 'open', pinned: false, dragging: false, lastActivity: 1000, rect: sp.panelRect(WA_MAIN, S_DEFAULT) };
  assert.equal(sp.shouldAutoCollapse(prev, { x: 10, y: 10 }, 1500, S_DEFAULT), false);
  assert.equal(sp.shouldAutoCollapse(prev, { x: 10, y: 10 }, 3000, S_DEFAULT), true);
});

test('shouldAutoCollapse 光标在面板（含容差）内不收起', () => {
  const rect = sp.panelRect(WA_MAIN, S_DEFAULT);
  const prev = { mode: 'open', lastActivity: 0, rect };
  const inside = { x: rect.x + 5, y: rect.y + 5 };
  assert.equal(sp.shouldAutoCollapse(prev, inside, 99999, S_DEFAULT), false);
});

test('shouldAutoCollapse 非法时间戳返回 false（不误收）', () => {
  const prev = { mode: 'open', pinned: false, dragging: false, lastActivity: NaN, rect: null };
  assert.equal(sp.shouldAutoCollapse(prev, null, 99999, S_DEFAULT), false);
});

// ===== trayIcon：菜单栏模板图纯函数（v2.1 P2-1）=====
const trayIcon = require('../main/core/trayIcon.js');

test('trayIcon.makeTemplateBitmap 输出纯黑 BGRA + alpha 形状', () => {
  const r = trayIcon.makeTemplateBitmap(16);
  assert.equal(r.width, 16);
  assert.equal(r.height, 16);
  assert.equal(r.buffer.length, 16 * 16 * 4);
  // 颜色通道全为 0（纯黑），仅 alpha 承载形状 —— 由系统模板着色
  for (let i = 0; i < r.buffer.length; i += 4) {
    assert.equal(r.buffer[i], 0);
    assert.equal(r.buffer[i + 1], 0);
    assert.equal(r.buffer[i + 2], 0);
  }
  const alpha = [];
  for (let i = 3; i < r.buffer.length; i += 4) alpha.push(r.buffer[i]);
  const visible = alpha.filter((a) => a > 0).length;
  assert.ok(visible > 0, '应有非透明像素');
  assert.ok(visible < 16 * 16, '不应整块填满');
  // 四角透明（模板图四周留白）
  assert.equal(alpha[0], 0);
  assert.equal(alpha[15], 0);
  assert.equal(alpha[15 * 16], 0);
  assert.equal(alpha[16 * 16 - 1], 0);
});

test('trayIcon.makeTemplateBitmap 非法/过小尺寸收敛', () => {
  const r = trayIcon.makeTemplateBitmap(NaN);
  assert.equal(r.width, 16);
  assert.equal(r.buffer.length, 16 * 16 * 4);
  assert.ok(trayIcon.makeTemplateBitmap(4).width >= 8, '最小边长收敛到 8');
});
