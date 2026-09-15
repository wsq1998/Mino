// Mio - AI 助手窗口几何 / 状态机 / 运行态单测（node:test，零第三方）
// 与 test/stashPanel.test.js 同构：几何必须「同一输入必得同一输出」，运行态必须能被事件精确驱动。
// 运行：npm test（= node --test test/*.test.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const st = require('../main/ai/state.js');

const WA_MAIN = { x: 0, y: 25, width: 1512, height: 945 };  // MacBook 14 逻辑分辨率（已扣菜单栏）
const WA_SMALL = { x: 0, y: 0, width: 800, height: 600 };
const WA_ULTRA = { x: 0, y: 0, width: 2560, height: 1440 };

const S = (ai) => ({ ai: Object.assign({ enabled: true, edgeSide: 'right', showCapsule: true }, ai || {}) });

// ============ 配置收口 ============

test('aiCfg：默认 right / 开胶囊 / 关总开关；非法边回退 right', () => {
  assert.deepEqual(st.aiCfg({}), { side: 'right', showCapsule: true, enabled: false });
  assert.equal(st.aiCfg({ ai: { edgeSide: 'left' } }).side, 'left');
  assert.equal(st.aiCfg({ ai: { edgeSide: 'diagonal' } }).side, 'right');
  assert.equal(st.aiCfg({ ai: { showCapsule: false } }).showCapsule, false);
  assert.equal(st.aiCfg({ ai: { enabled: true } }).enabled, true);
  // showCapsule 只认显式 false，缺省视为开
  assert.equal(st.aiCfg({ ai: {} }).showCapsule, true);
});

// ============ 几何 ============

test('capsuleRect：垂直边=竖细条，水平边=横细条，且各自贴对边', () => {
  const r = st.capsuleRect(WA_MAIN, S({ edgeSide: 'right' }));
  assert.equal(r.width, 6);
  assert.equal(r.x, WA_MAIN.x + WA_MAIN.width - 6);
  assert.equal(r.height, 104);

  const t = st.capsuleRect(WA_MAIN, S({ edgeSide: 'top' }));
  assert.equal(t.height, 6);
  assert.equal(t.y, WA_MAIN.y);
  assert.equal(t.width, 104);

  const l = st.capsuleRect(WA_MAIN, S({ edgeSide: 'left' }));
  assert.equal(l.x, WA_MAIN.x);
  assert.equal(l.width, 6);

  const b = st.capsuleRect(WA_MAIN, S({ edgeSide: 'bottom' }));
  assert.equal(b.y, WA_MAIN.y + WA_MAIN.height - 6);
});

test('barRect：560×64，贴触发边且留内缩（别压到菜单栏/Dock）', () => {
  const r = st.barRect(WA_MAIN, S({ edgeSide: 'right' }));
  assert.equal(r.width, 560);
  assert.equal(r.height, 64);
  assert.ok(r.x >= WA_MAIN.x && r.x + r.width <= WA_MAIN.x + WA_MAIN.width, '必须完整落在屏内');
  // 贴右缘：右边缘到屏幕右缘的距离 = 内缩量（≤60px），而不是「左边界靠右」
  const gapRight = (WA_MAIN.x + WA_MAIN.width) - (r.x + r.width);
  assert.ok(gapRight > 0 && gapRight <= 60, '右边缘应贴近屏幕右缘，实际间距 ' + gapRight);
  // 沿边方向居中
  const centeredY = WA_MAIN.y + Math.round((WA_MAIN.height - 64) / 2);
  assert.equal(r.y, centeredY, '右缘输入条应在垂直方向居中');

  const t = st.barRect(WA_MAIN, S({ edgeSide: 'top' }));
  assert.ok(t.y > WA_MAIN.y, '顶部应有内缩');
  assert.equal(t.height, 64);
  const gapTop = t.y - WA_MAIN.y;
  assert.ok(gapTop > 0 && gapTop <= 60, '上边缘应贴近屏幕上缘，实际间距 ' + gapTop);

  // 小屏自适应：宽高都不超过屏宽/屏高
  const s = st.barRect(WA_SMALL, S({ edgeSide: 'top' }));
  assert.ok(s.width <= WA_SMALL.width);
  assert.ok(s.height <= WA_SMALL.height);
});

test('panelRect：侧抽屉宽 420（高受占屏比例约束）；顶/底货架宽 ≤980 且高 360', () => {
  const r = st.panelRect(WA_MAIN, S({ edgeSide: 'right' }));
  assert.equal(r.width, 420);
  assert.ok(r.height <= Math.round(WA_MAIN.height * 0.72), '侧抽屉不能接近全屏');
  assert.ok(r.height >= 240, '不能矮到没法用');
  assert.equal(r.x, WA_MAIN.x + WA_MAIN.width - 420);

  const t = st.panelRect(WA_MAIN, S({ edgeSide: 'top' }));
  assert.equal(t.height, 360);
  assert.equal(t.width, st.PANEL_MAX_W, '常见屏宽下货架取到 980 上限（沿用 v2.15）');
  assert.equal(t.y, WA_MAIN.y);

  // 超宽屏收敛，不铺满
  const u = st.panelRect(WA_ULTRA, S({ edgeSide: 'bottom' }));
  assert.equal(u.width, st.PANEL_MAX_W);
  // 小屏按屏宽收敛
  const s = st.panelRect(WA_SMALL, S({ edgeSide: 'top' }));
  assert.ok(s.width <= WA_SMALL.width);
});

test('clampRect：越界矩形被夹回 workArea（多屏/拔屏防丢）', () => {
  const r = st.clampRect({ x: -500, y: -500, width: 560, height: 64 }, WA_MAIN);
  assert.equal(r.x, WA_MAIN.x);
  assert.equal(r.y, WA_MAIN.y);
  const r2 = st.clampRect({ x: 99999, y: 99999, width: 560, height: 64 }, WA_MAIN);
  assert.equal(r2.x, WA_MAIN.x + WA_MAIN.width - 560);
  assert.equal(r2.y, WA_MAIN.y + WA_MAIN.height - 64);
  // 比屏还大的矩形被压到屏宽
  const r3 = st.clampRect({ x: 0, y: 0, width: 99999, height: 99999 }, WA_MAIN);
  assert.equal(r3.width, WA_MAIN.width);
  assert.equal(r3.height, WA_MAIN.height);
});

// ============ 运行态（状态点语义） ============

test('deriveRunState：正文/推理/工具/步骤事件 → running', () => {
  for (const t of [
    'session.next.text.delta',
    'session.next.text.started',
    'session.next.reasoning.delta',
    'session.next.tool.called',
    'session.next.tool.success',
    'session.next.step.started',
    'message.part.updated',
  ]) {
    assert.equal(st.deriveRunState('idle', t), 'running', t + ' 应驱动为 running');
  }
});

test('deriveRunState：权限/提问 → waiting（优先于 running，红点比转圈更该被看到）', () => {
  assert.equal(st.deriveRunState('running', 'permission.asked'), 'waiting');
  assert.equal(st.deriveRunState('running', 'question.asked'), 'waiting');
  // 答复之后回到 running
  assert.equal(st.deriveRunState('waiting', 'permission.replied'), 'running');
  assert.equal(st.deriveRunState('waiting', 'question.rejected'), 'running');
});

test('deriveRunState：session.idle → idle，session.error → error', () => {
  assert.equal(st.deriveRunState('running', 'session.idle'), 'idle');
  assert.equal(st.deriveRunState('running', 'session.error'), 'error');
  // 出错后不再被无关事件拉回 running（error 需显式的新 turn 才清）
  assert.equal(st.deriveRunState('error', 'server.heartbeat'), 'error');
  // 非法/空输入保持不变
  assert.equal(st.deriveRunState('nonsense', ''), 'idle');
  assert.equal(st.deriveRunState('running', null), 'running');
});

// ============ 窗口状态机 ============

test('resolveWindowState：INIT 形态由「总开关 + 常驻胶囊」决定', () => {
  assert.equal(st.resolveWindowState(null, 'INIT', { workArea: WA_MAIN, settings: S({}) }).mode, 'capsule');
  assert.equal(st.resolveWindowState(null, 'INIT', { workArea: WA_MAIN, settings: S({ showCapsule: false }) }).mode, 'hidden');
  assert.equal(st.resolveWindowState(null, 'INIT', { workArea: WA_MAIN, settings: S({ enabled: false }) }).mode, 'hidden');
});

test('resolveWindowState：WAKE 永远到输入条态（「一个键→打字→回车」的主干）', () => {
  // 防回归：若 WAKE 直接展开面板，「按一下就打字」会被执行流抢走焦点
  for (const from of ['capsule', 'open', 'bar', 'hidden']) {
    const r = st.resolveWindowState({ mode: from }, 'WAKE', { workArea: WA_MAIN, settings: S({}) });
    assert.equal(r.mode, 'bar', '从 ' + from + ' 唤起都应到 bar');
  }
  // 总开关关闭时唤不起来
  assert.equal(st.resolveWindowState({ mode: 'capsule' }, 'WAKE', { workArea: WA_MAIN, settings: S({ enabled: false }) }).mode, 'hidden');
});

test('resolveWindowState：EXPAND/COLLAPSE/TOGGLE 三态互转（§13 Q3 手势）', () => {
  const ctx = { workArea: WA_MAIN, settings: S({}) };
  assert.equal(st.resolveWindowState({ mode: 'bar' }, 'EXPAND', ctx).mode, 'open');
  assert.equal(st.resolveWindowState({ mode: 'open' }, 'COLLAPSE', ctx).mode, 'bar');
  assert.equal(st.resolveWindowState({ mode: 'bar' }, 'TOGGLE', ctx).mode, 'open');
  assert.equal(st.resolveWindowState({ mode: 'open' }, 'TOGGLE', ctx).mode, 'bar');
  // HIDE：有胶囊回胶囊，否则彻底隐藏
  assert.equal(st.resolveWindowState({ mode: 'open' }, 'HIDE', ctx).mode, 'capsule');
  assert.equal(st.resolveWindowState({ mode: 'open' }, 'HIDE', { workArea: WA_MAIN, settings: S({ showCapsule: false }) }).mode, 'hidden');
  // DISABLE：无条件隐藏（引擎不可用 / 用户关了总开关）
  assert.equal(st.resolveWindowState({ mode: 'open' }, 'DISABLE', ctx).mode, 'hidden');
});

test('resolveWindowState：矩形随形态切换，hidden 时仍返回合法矩形', () => {
  const ctx = { workArea: WA_MAIN, settings: S({}) };
  const caps = st.resolveWindowState({ mode: 'capsule' }, 'RESYNC', ctx);
  const bar = st.resolveWindowState({ mode: 'bar' }, 'RESYNC', ctx);
  const open = st.resolveWindowState({ mode: 'open' }, 'RESYNC', ctx);
  assert.equal(bar.rect.height, 64);
  assert.ok(open.rect.height > bar.rect.height, '面板必须比输入条高');
  assert.equal(caps.rect.width, 6);
  const hid = st.resolveWindowState({ mode: 'open' }, 'DISABLE', ctx);
  assert.ok(hid.rect.width > 0 && hid.rect.height > 0, 'hidden 也要给出合法矩形（供 setBounds 用）');
});

test('resolveWindowState：interactive 只在 hidden 时为 false（胶囊也必须能接住拖入）', () => {
  // 防回归：胶囊态若被判为不可交互，就等价于开了鼠标穿透 —— 拖文件进去直接失效
  const ctx = { workArea: WA_MAIN, settings: S({}) };
  assert.equal(st.resolveWindowState({ mode: 'capsule' }, 'INIT', ctx).interactive, true);
  assert.equal(st.resolveWindowState({ mode: 'bar' }, 'WAKE', ctx).interactive, true);
  assert.equal(st.resolveWindowState({ mode: 'open' }, 'EXPAND', ctx).interactive, true);
  assert.equal(st.resolveWindowState({ mode: 'open' }, 'DISABLE', ctx).interactive, false);
});

test('resolveWindowState：非法 workArea 回退默认屏且不抛', () => {
  const r = st.resolveWindowState({ mode: 'open' }, 'EXPAND', { workArea: null, settings: S({}) });
  assert.ok(r.rect.width > 0 && r.rect.height > 0);
  const r2 = st.resolveWindowState(null, 'WAKE', { workArea: { x: NaN, y: 0, width: -5, height: 0 }, settings: S({}) });
  assert.ok(Number.isFinite(r2.rect.x) && r2.rect.width > 0);
});
