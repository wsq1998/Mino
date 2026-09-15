'use strict';
// QA 独立补充测试（v2.1 中转站浮窗）—— 严过关
// 目的：用与工程师测试文件**独立**的断言，主攻边界：
//   多显示器负坐标 / 屏幕缩放 / 越界 clamp / 无热区 / 非法时间戳 / 脏 settings / 状态机穷举。
// 不改动任何源码，只新增本测试文件。运行：node --test test/stashPanel.qa.test.js

const test = require('node:test');
const assert = require('node:assert');

const sp = require('../main/core/stashPanel.js');
const settings = require('../main/core/settings.js');

const WA_PRIMARY = { x: 0, y: 25, width: 1440, height: 875 };          // 主屏（顶部菜单栏 25px）
const WA_LEFT = { x: -1920, y: 25, width: 1920, height: 1055 };        // 左侧副屏（负坐标）
const WA_SMALL = { x: 0, y: 0, width: 4, height: 40 };                 // 比胶囊还小的极端屏

// ---------- 几何：capsuleRect ----------
test('QA capsuleRect: 右缘贴边 + 垂直居中', () => {
  const r = sp.capsuleRect(WA_PRIMARY, { stash: { edgeSide: 'right' } });
  assert.equal(r.width, 6);
  assert.equal(r.height, 104);
  assert.equal(r.x, WA_PRIMARY.x + WA_PRIMARY.width - 6);   // 贴右缘
  assert.equal(r.y, WA_PRIMARY.y + Math.round((WA_PRIMARY.height - 104) / 2));
});

test('QA capsuleRect: 左缘（负坐标副屏）贴左缘且不越界', () => {
  const r = sp.capsuleRect(WA_LEFT, { stash: { edgeSide: 'left' } });
  assert.equal(r.x, WA_LEFT.x);                              // -1920
  assert.ok(r.x >= WA_LEFT.x && r.x + r.width <= WA_LEFT.x + WA_LEFT.width);
});

test('QA capsuleRect: 屏幕比胶囊还小 → 尺寸被夹到屏内', () => {
  const r = sp.capsuleRect(WA_SMALL, {});
  assert.ok(r.width <= WA_SMALL.width, `width ${r.width} 应 <= ${WA_SMALL.width}`);
  assert.ok(r.height <= WA_SMALL.height, `height ${r.height} 应 <= ${WA_SMALL.height}`);
  assert.ok(r.x >= WA_SMALL.x && r.x + r.width <= WA_SMALL.x + WA_SMALL.width);
});

test('QA capsuleRect: 非法 workArea 回退默认且不抛', () => {
  for (const bad of [null, undefined, {}, { width: 0, height: 0 }, { x: NaN, y: 0, width: 100, height: 100 }, 'nope', 42]) {
    const r = sp.capsuleRect(bad, {});
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 0 && r.height > 0);
  }
});

// ---------- 几何：panelRect ----------
test('QA panelRect: 高度随屏幕变化且始终在 workArea 内', () => {
  const r = sp.panelRect(WA_PRIMARY, { stash: { edgeSide: 'right' } });
  assert.equal(r.width, 260);
  assert.ok(r.height >= 120);
  assert.ok(r.height <= WA_PRIMARY.height);
  assert.ok(r.y >= WA_PRIMARY.y && r.y + r.height <= WA_PRIMARY.y + WA_PRIMARY.height);
});

test('QA panelRect: 极小屏 —— 裸 helper 不保证夹取，但经 resolvePanelState 后必定落在屏内', () => {
  const wa = { x: 0, y: 0, width: 200, height: 100 };
  // panelRect 是裸几何 helper（高度下限 120），夹取由 clampRect / resolvePanelState 负责
  const raw = sp.panelRect(wa, {});
  assert.ok(raw.height >= 120, '裸 helper 高度下限应为 120');
  // 真正驱动 setBounds 的是 resolvePanelState 的输出 —— 这里必须被夹回屏内
  const st = sp.resolvePanelState(null, 'SHOW', { workArea: wa, settings: { stash: {} } });
  assert.equal(st.mode, 'open');
  assert.ok(st.rect.height <= wa.height, `resolvePanelState.rect.height ${st.rect.height} 应 <= ${wa.height}`);
  assert.ok(st.rect.y >= wa.y && st.rect.y + st.rect.height <= wa.y + wa.height);
});

// ---------- 几何：clampRect ----------
test('QA clampRect: 完全在屏外的矩形被拉回屏内', () => {
  const r = sp.clampRect({ x: 99999, y: -99999, width: 260, height: 500 }, WA_PRIMARY);
  assert.ok(r.x >= WA_PRIMARY.x && r.x + r.width <= WA_PRIMARY.x + WA_PRIMARY.width);
  assert.ok(r.y >= WA_PRIMARY.y && r.y + r.height <= WA_PRIMARY.y + WA_PRIMARY.height);
});

test('QA clampRect: 脏输入（字符串/NaN/缺字段）不抛且输出合法', () => {
  for (const bad of [null, undefined, 'x', {}, { width: 'a', height: null }, { x: NaN, y: NaN, width: -5, height: 0 }]) {
    const r = sp.clampRect(bad, WA_PRIMARY);
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
    assert.ok(r.width >= 1 && r.height >= 1);
  }
});

test('QA clampRect: 宽度大于屏宽 → 夹到屏宽', () => {
  const r = sp.clampRect({ x: 0, y: 0, width: 99999, height: 50 }, WA_PRIMARY);
  assert.equal(r.width, WA_PRIMARY.width);
});

// ---------- 热区：hitEdge / edgeZone ----------
test('QA hitEdge: 右缘 6px 内命中，远离不命中', () => {
  const s = { stash: { edgeHot: true, edgeSide: 'right', edgeThreshold: 6 } };
  const right = WA_PRIMARY.x + WA_PRIMARY.width - 1;
  assert.equal(sp.hitEdge({ x: right, y: 400 }, WA_PRIMARY, s), true);
  assert.equal(sp.hitEdge({ x: WA_PRIMARY.x + 100, y: 400 }, WA_PRIMARY, s), false);
});

test('QA hitEdge: edgeHot=false 永不命中（即使光标就贴在屏缘）', () => {
  const s = { stash: { edgeHot: false, edgeSide: 'right', edgeThreshold: 6 } };
  const right = WA_PRIMARY.x + WA_PRIMARY.width - 1;
  assert.equal(sp.hitEdge({ x: right, y: 400 }, WA_PRIMARY, s), false);
});

test('QA hitEdge: 左缘模式命中区在左侧', () => {
  const s = { stash: { edgeHot: true, edgeSide: 'left', edgeThreshold: 6 } };
  assert.equal(sp.hitEdge({ x: WA_LEFT.x, y: 400 }, WA_LEFT, s), true);
  assert.equal(sp.hitEdge({ x: WA_LEFT.x + WA_LEFT.width - 1, y: 400 }, WA_LEFT, s), false);
});

test('QA hitEdge: 非法光标 / 空 settings 不抛', () => {
  assert.equal(sp.hitEdge(null, WA_PRIMARY, {}), false);
  assert.equal(sp.hitEdge({ x: NaN, y: 0 }, WA_PRIMARY, {}), false);
  assert.doesNotThrow(() => sp.hitEdge({ x: 0, y: 0 }, null, null));
});

test('QA edgeZone: 厚度 = edgeThreshold 且覆盖全高', () => {
  const z = sp.edgeZone(WA_PRIMARY, { stash: { edgeThreshold: 10, edgeSide: 'right' } });
  assert.equal(z.width, 10);
  assert.equal(z.height, WA_PRIMARY.height);
  assert.equal(z.x, WA_PRIMARY.x + WA_PRIMARY.width - 10);
});

// ---------- 状态机：resolvePanelState ----------
test('QA resolvePanelState INIT: panelEnabled 决定 capsule / hidden', () => {
  const on = sp.resolvePanelState(null, 'INIT', { workArea: WA_PRIMARY, settings: { stash: { panelEnabled: true } } });
  assert.equal(on.mode, 'capsule');
  assert.equal(on.interactive, true);
  const off = sp.resolvePanelState(null, 'INIT', { workArea: WA_PRIMARY, settings: { stash: { panelEnabled: false } } });
  assert.equal(off.mode, 'hidden');
  assert.equal(off.interactive, false); // hidden 才不可交互
});

test('QA resolvePanelState TOGGLE: open→capsule→open，且 capsule 仍可交互（拖入关键）', () => {
  let st = sp.resolvePanelState(null, 'INIT', { workArea: WA_PRIMARY, settings: { stash: {} } }); // capsule
  st = sp.resolvePanelState(st, 'TOGGLE', { workArea: WA_PRIMARY, settings: { stash: {} } });
  assert.equal(st.mode, 'open');
  assert.equal(st.interactive, true);
  st = sp.resolvePanelState(st, 'TOGGLE', { workArea: WA_PRIMARY, settings: { stash: {} } });
  assert.equal(st.mode, 'capsule');
  assert.equal(st.interactive, true, '胶囊态必须可交互，否则 OS 拖放事件收不到');
});

test('QA resolvePanelState PIN: 钉住后 TICK 永不自动收起', () => {
  let st = { mode: 'open', pinned: false, dragging: false, lastActivity: 1000, rect: { x: 0, y: 0, width: 260, height: 600 } };
  st = sp.resolvePanelState(st, 'PIN_TOGGLE', { workArea: WA_PRIMARY, settings: { stash: {} }, now: 2000 });
  assert.equal(st.pinned, true);
  const after = sp.resolvePanelState(st, 'TICK', { workArea: WA_PRIMARY, settings: { stash: {} }, now: 999999, cursor: { x: 10, y: 10 } });
  assert.equal(after.mode, 'open', '钉住后不该被 TICK 收起');
});

test('QA resolvePanelState DRAG: 拖拽期间 TICK 不收起', () => {
  let st = { mode: 'open', pinned: false, dragging: false, lastActivity: 1000, rect: { x: 0, y: 0, width: 260, height: 600 } };
  st = sp.resolvePanelState(st, 'DRAG_ENTER', { workArea: WA_PRIMARY, settings: { stash: {} }, now: 2000 });
  assert.equal(st.dragging, true);
  const after = sp.resolvePanelState(st, 'TICK', { workArea: WA_PRIMARY, settings: { stash: {} }, now: 999999, cursor: { x: 10, y: 10 } });
  assert.equal(after.mode, 'open');
  const left = sp.resolvePanelState(after, 'DRAG_LEAVE', { workArea: WA_PRIMARY, settings: { stash: {} }, now: 1000000 });
  assert.equal(left.dragging, false);
});

test('QA resolvePanelState TICK: 超时且光标在面板外 → 收起为胶囊', () => {
  const st = { mode: 'open', pinned: false, dragging: false, lastActivity: 1000, rect: { x: 1000, y: 100, width: 260, height: 600 } };
  const next = sp.resolvePanelState(st, 'TICK', { workArea: WA_PRIMARY, settings: { stash: { autoHideDelay: 1200 } }, now: 5000, cursor: { x: 5, y: 5 } });
  assert.equal(next.mode, 'capsule');
});

test('QA resolvePanelState RESYNC: 只重算矩形，不改 mode/pinned', () => {
  const st = { mode: 'open', pinned: true, dragging: false, lastActivity: 1, rect: { x: 0, y: 0, width: 260, height: 600 } };
  const next = sp.resolvePanelState(st, 'RESYNC', { workArea: WA_LEFT, settings: { stash: { edgeSide: 'right' } } });
  assert.equal(next.mode, 'open');
  assert.equal(next.pinned, true);
  assert.equal(next.rect.x, WA_LEFT.x + WA_LEFT.width - 260); // 吸附到新屏右缘
});

test('QA resolvePanelState: 脏 settings / 空 ctx / 未知事件都不抛', () => {
  for (const evt of [undefined, null, 'WHAT', 'TICK', 'INIT']) {
    assert.doesNotThrow(() => sp.resolvePanelState(null, evt, {}));
    assert.doesNotThrow(() => sp.resolvePanelState(null, evt, { settings: null, workArea: 'bad' }));
    assert.doesNotThrow(() => sp.resolvePanelState({ mode: 'weird' }, evt, { settings: { stash: 42 } }));
  }
});

// ---------- 自动收起判定 ----------
test('QA shouldAutoCollapse: 非法时间戳 / 非法 now 一律 false（不误收）', () => {
  const base = { mode: 'open', pinned: false, dragging: false, rect: { x: 500, y: 0, width: 260, height: 600 } };
  assert.equal(sp.shouldAutoCollapse({ ...base, lastActivity: NaN }, { x: 0, y: 0 }, 999999, {}), false);
  assert.equal(sp.shouldAutoCollapse({ ...base, lastActivity: 1 }, { x: 0, y: 0 }, NaN, {}), false);
  assert.equal(sp.shouldAutoCollapse({ ...base, lastActivity: undefined }, { x: 0, y: 0 }, 999999, {}), false);
});

test('QA shouldAutoCollapse: mode 非 open / pinned / dragging 一律 false', () => {
  const r = { x: 500, y: 0, width: 260, height: 600 };
  assert.equal(sp.shouldAutoCollapse({ mode: 'capsule', lastActivity: 1, rect: r }, { x: 0, y: 0 }, 9e9, {}), false);
  assert.equal(sp.shouldAutoCollapse({ mode: 'open', pinned: true, lastActivity: 1, rect: r }, { x: 0, y: 0 }, 9e9, {}), false);
  assert.equal(sp.shouldAutoCollapse({ mode: 'open', dragging: true, lastActivity: 1, rect: r }, { x: 0, y: 0 }, 9e9, {}), false);
});

test('QA shouldAutoCollapse: 光标仍在面板内（含容差）→ false；离开且超时 → true', () => {
  const st = { mode: 'open', pinned: false, dragging: false, lastActivity: 1000, rect: { x: 1000, y: 100, width: 260, height: 600 } };
  const inside = { x: 1100, y: 300 };
  const outside = { x: 10, y: 10 };
  assert.equal(sp.shouldAutoCollapse(st, inside, 1000 + 5000, {}), false);
  assert.equal(sp.shouldAutoCollapse(st, outside, 1000 + 5000, { stash: { autoHideDelay: 1200 } }), true);
  assert.equal(sp.shouldAutoCollapse(st, outside, 1000 + 100, { stash: { autoHideDelay: 1200 } }), false, '未超时不该收');
});

// ---------- settings 收口：脏数据不抛且收敛 ----------
test('QA settings.stash 脏数据：字符串/null/数组/越界/非法枚举全部收敛', () => {
  const dirty = {
    _v: 8,
    stash: {
      enabled: 'yes',
      persist: 0,
      items: 'not-an-array',
      panelEnabled: 'x',
      edgeHot: null,
      edgeSide: 'diagonal',
      edgeThreshold: -100,
      autoHideDelay: 999999,
      pinned: 1,
      hotkey: 12345,
      trayEnabled: undefined,
      capsuleOpacity: 'abc',
    },
  };
  const s = settings.sanitizeSettings(settings.deepMerge(settings.DEFAULT_SETTINGS, dirty));
  assert.equal(typeof s.stash.enabled, 'boolean');
  assert.equal(typeof s.stash.persist, 'boolean');
  assert.ok(Array.isArray(s.stash.items));
  assert.equal(typeof s.stash.panelEnabled, 'boolean');
  assert.equal(typeof s.stash.edgeHot, 'boolean');
  assert.equal(typeof s.stash.dragAutoShow, 'boolean');
  assert.equal(s.stash.edgeSide, 'right');                 // 非法枚举 → right
  assert.ok(s.stash.edgeThreshold >= 1 && s.stash.edgeThreshold <= 24);
  assert.ok(s.stash.autoHideDelay >= 300 && s.stash.autoHideDelay <= 6000);
  assert.equal(typeof s.stash.pinned, 'boolean');
  assert.equal(s.stash.hotkey, null);                      // 非字符串 → null
  assert.equal(typeof s.stash.trayEnabled, 'boolean');
  assert.ok(s.stash.capsuleOpacity >= 0.3 && s.stash.capsuleOpacity <= 1);
});

test('QA settings.stash：老 v8 配置 hotkey 默认值不被冲成 null（回归关键）', () => {
  const old = { _v: 8, stash: { enabled: true, persist: true, items: [] } };
  const s = settings.sanitizeSettings(settings.deepMerge(settings.DEFAULT_SETTINGS, old));
  assert.equal(s.stash.hotkey, 'Alt+Shift+Space', 'deepMerge 补的默认快捷键不能被 sanitize 冲成 null');
  assert.equal(s.stash.panelEnabled, true);
  assert.equal(s.stash.capsuleOpacity, 0.6);
});

test('QA settings.stash：items 每条缺 path 的脏条目被剔除、上限 100', () => {
  const items = Array.from({ length: 130 }, (_, i) => (i % 7 === 0 ? { id: 'x' + i } : { id: 'x' + i, path: '/tmp/f' + i }));
  const s = settings.sanitizeSettings(settings.deepMerge(settings.DEFAULT_SETTINGS, { stash: { items } }));
  assert.ok(s.stash.items.length <= 100);
  assert.ok(s.stash.items.every((it) => typeof it.path === 'string' && it.path.trim() !== ''));
});

test('QA settings.stash：capsuleOpacity 百分数误存（60）→ 收敛到 0.6', () => {
  const s = settings.sanitizeSettings(settings.deepMerge(settings.DEFAULT_SETTINGS, { stash: { capsuleOpacity: 60 } }));
  assert.equal(s.stash.capsuleOpacity, 0.6);
});

// ---------- 导出契约 ----------
test('QA stashPanel 导出契约完整', () => {
  for (const k of ['CAPSULE', 'PANEL', 'EDGE_MARGIN', 'capsuleRect', 'panelRect', 'hitEdge', 'edgeZone', 'stashCfg', 'resolvePanelState', 'shouldAutoCollapse', 'clampRect']) {
    assert.ok(k in sp, `缺少导出 ${k}`);
  }
  assert.equal(sp.CAPSULE.w, 6);
  assert.equal(sp.PANEL.w, 260);
});
