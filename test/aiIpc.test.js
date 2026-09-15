// Mio - AI 助手主进程接线层单测（node:test，零第三方）
//
// 目标：独立验证 main/ai/ipc.js 的 installAi(deps) 子系统「真的能跑通」——
//   不起真 Electron、不起真 opencode 进程、不碰真 userData / 真设置文件、无真网络 / 真计时器。
//
// 做法：把一个足够诚实的假世界注入进去 ——
//   · 假 ipcMain（handle/on 收口 + 重复 channel 检测）
//   · 假 BrowserWindow（记录每次调用 / 每次 webContents.send）
//   · 假 screen / app / globalShortcut
//   · 真 settings.js 的 sanitizeSettings(deepMerge(...)) 做全内存设置往返（诚实，不落盘）
//   · 假引擎：假 spawn 子进程 + 按 URL/method 路由的假 fetch + 可控 SSE Web ReadableStream
//
// ⚠️ 两个必须记住的坑（否则会得到假阴性）：
//   1) ipc.js 所有渲染层推送都被 rendererReady.done 挡住，只由 webContents 的
//      'did-finish-load' 置位 —— 任何断言 webContents.send 的用例必须先 fire 它。
//   2) runEventLoop 只要 shouldRun() 为真就会立刻重连；假 fetch 必须让 /global/event
//      在 AbortSignal 触发时使流报错，否则停止 SSE 时循环不会退出。
//
// 运行：npm test（= node --test test/*.test.js）

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const settings = require('../main/core/settings.js');
const state = require('../main/ai/state.js');
const { installAi } = require('../main/ai/ipc.js');

// ─────────────────────────────────────────────────────────────────────────────
// 常量（与测试期望一一对应）
// ─────────────────────────────────────────────────────────────────────────────
const WORK_AREA = { x: 0, y: 0, width: 1512, height: 945 };
const FAKE_EXE = '/opt/fake/opencode';
const FAKE_PORT = 54321;

/** 确定性推进事件循环：不等待真实时间，只让 microtask / setImmediate 队列排空。 */
async function flush(n = 8) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

/** 造一帧标准 SSE（引擎实测形状：{ payload: { type, properties } }）。 */
function sseFrame(type, properties) {
  return `data: ${JSON.stringify({ payload: { type, properties: properties || {} } })}\n\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 假件工厂
// ─────────────────────────────────────────────────────────────────────────────

/** 假 ipcMain：Map 收口 + 重复 channel 记录。 */
function makeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  const dupHandlers = [];
  const dupListeners = [];
  const api = {
    handlers,
    listeners,
    dupHandlers,
    dupListeners,
    handle(ch, fn) {
      if (handlers.has(ch)) dupHandlers.push(ch);
      handlers.set(ch, fn);
      return api;
    },
    on(ch, fn) {
      if (listeners.has(ch)) dupListeners.push(ch);
      listeners.set(ch, fn);
      return api;
    },
  };
  return api;
}

/**
 * 假 BrowserWindow：class，实例记入 instances。
 * 每次方法调用进 calls；webContents.send 进 sent；鼠标穿透参数单独留存用于断言。
 */
function makeBrowserWindow() {
  const instances = [];
  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts || {};
      this.destroyed = false;
      this.visible = false;
      this.bounds = {
        x: Number(this.opts.x) || 0,
        y: Number(this.opts.y) || 0,
        width: Number(this.opts.width) || 0,
        height: Number(this.opts.height) || 0,
      };
      this.calls = [];
      this.sent = [];
      this.ignoreMouseArgs = [];
      this.winListeners = new Map();
      this.webListeners = new Map();
      const self = this;
      this.webContents = {
        on(evt, cb) {
          if (!self.webListeners.has(evt)) self.webListeners.set(evt, []);
          self.webListeners.get(evt).push(cb);
          return this;
        },
        send(ch, payload) {
          self.sent.push({ channel: ch, payload });
        },
      };
      instances.push(this);
    }

    _rec(method, args) {
      this.calls.push({ method, args: Array.from(args) });
    }

    setAlwaysOnTop(...a) { this._rec('setAlwaysOnTop', a); }
    setVisibleOnAllWorkspaces(...a) { this._rec('setVisibleOnAllWorkspaces', a); }
    setIgnoreMouseEvents(...a) { this._rec('setIgnoreMouseEvents', a); this.ignoreMouseArgs.push(a[0]); }
    loadFile(...a) { this._rec('loadFile', a); }

    on(evt, cb) {
      if (!this.winListeners.has(evt)) this.winListeners.set(evt, []);
      this.winListeners.get(evt).push(cb);
      return this;
    }

    setBounds(rect, animate) {
      this._rec('setBounds', [rect, animate]);
      this.bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    show() { this._rec('show', []); this.visible = true; }
    showInactive() { this._rec('showInactive', []); this.visible = true; }
    hide() { this._rec('hide', []); this.visible = false; }
    focus() { this._rec('focus', []); }
    isDestroyed() { return this.destroyed; }
    destroy() { this._rec('destroy', []); this.destroyed = true; }
    getBounds() { return { ...this.bounds }; }

    // ── 断言便捷方法 ──
    callNames() { return this.calls.map((c) => c.method); }
    lastCall(method) {
      const arr = this.calls.filter((c) => c.method === method);
      return arr.length ? arr[arr.length - 1] : null;
    }
    sentOf(channel) { return this.sent.filter((s) => s.channel === channel); }
    fireWin(evt, ...args) { for (const cb of (this.winListeners.get(evt) || [])) cb(...args); }
    fireWeb(evt, ...args) { for (const cb of (this.webListeners.get(evt) || [])) cb(...args); }
  }
  return { FakeBrowserWindow, instances };
}

/** 假 screen：固定 workArea，所有查询都返回它。 */
function makeScreen() {
  const wa = { ...WORK_AREA };
  return {
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    getDisplayNearestPoint: () => ({ workArea: { ...wa } }),
    getPrimaryDisplay: () => ({ workArea: { ...wa } }),
    getDisplayMatching: () => ({ workArea: { ...wa } }),
    on() {},
  };
}

/** 假 app：记录监听器，可手动 emit（用于验证 before-quit 回收）。 */
function makeApp() {
  const listeners = new Map();
  return {
    listeners,
    on(evt, cb) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(cb);
      return this;
    },
    emit(evt, ...args) {
      for (const cb of (listeners.get(evt) || [])) cb(...args);
    },
  };
}

/** 假 globalShortcut：可注册/注销，fail 集合用于模拟「被别的程序占用」。 */
function makeGlobalShortcut() {
  const registered = new Map();
  const fail = new Set();
  return {
    registered,
    fail,
    register(acc, cb) {
      if (fail.has(acc)) return false;
      registered.set(acc, cb);
      return true;
    },
    unregister(acc) { registered.delete(acc); },
    unregisterAll() { registered.clear(); },
    isRegistered(acc) { return registered.has(acc); },
  };
}

/**
 * 全内存设置仓库：用真 settings.js 的 deepMerge + sanitizeSettings 做诚实往返。
 * getSettings / patchSettings 均返回同一个内存对象，绝不落盘。
 */
function makeSettingsStore(ai) {
  let cur = settings.sanitizeSettings(
    settings.deepMerge(settings.DEFAULT_SETTINGS, { ai: ai || {} }),
  );
  return {
    getSettings: () => cur,
    patchSettings: (patch) => {
      cur = settings.sanitizeSettings(settings.deepMerge(cur, patch));
      return cur;
    },
    peek: () => cur,
  };
}

/** 假引擎子进程：EventEmitter + stdout/stderr + 真实建模 exitCode/signalCode。 */
function makeFakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.exitCode = null;
  c.signalCode = null;
  c.killed = false;
  c.signals = [];
  c.kill = (sig) => {
    c.signals.push(sig);
    c.killed = true;
    // 模拟「信号立刻生效」：engine.alive() 判据是 exitCode/signalCode 均为 null
    setImmediate(() => {
      c.signalCode = sig;
      c.emit('exit', null, sig);
    });
    return true;
  };
  return c;
}

/**
 * 可控 SSE 流中心：每次 /global/event 连接开一条新 Web ReadableStream；
 * signal abort 时使当前流报错，令 client.subscribeEvents 抛错并让 runEventLoop 退出
 * （否则空 sleep 下会无限重连）。
 */
function makeSseHub() {
  const enc = new TextEncoder();
  let current = null;
  function open(signal) {
    let controller;
    const stream = new ReadableStream({
      start(c) { controller = c; },
    });
    const ctrl = {
      push(text) { try { controller.enqueue(enc.encode(text)); } catch {} },
      close() { try { controller.close(); } catch {} },
      fail(err) { try { controller.error(err); } catch {} },
    };
    current = ctrl;
    if (signal) {
      if (signal.aborted) {
        ctrl.fail(new Error('aborted'));
      } else {
        try { signal.addEventListener('abort', () => ctrl.fail(new Error('aborted')), { once: true }); } catch {}
      }
    }
    return stream;
  }
  return {
    open,
    push(text) { if (current) { current.push(text); return true; } return false; },
    close() { if (current) current.close(); },
    fail(err) { if (current) current.fail(err); },
    get current() { return current; },
  };
}

/** 按 URL + method 路由的假 fetch，记录每个请求（含解析后的 body）。 */
function makeFetchRouter(sse) {
  const requests = [];
  const fetchFn = async (url, opt = {}) => {
    const method = String(opt.method || 'GET').toUpperCase();
    let parsedBody;
    if (typeof opt.body === 'string') {
      try { parsedBody = JSON.parse(opt.body); } catch { parsedBody = opt.body; }
    }
    requests.push({ url, method, body: parsedBody, headers: opt.headers || {} });

    const p = new URL(url).pathname;
    const resp = (status, json) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => (json === undefined ? '' : JSON.stringify(json)),
    });

    // 健康检查：engine.probe 用 res.ok + res.json()
    if (p === '/global/health') return resp(200, { healthy: true, version: '1.17.9' });

    // SSE：给一条可被 abort 打断的流
    if (p === '/global/event') {
      return {
        ok: true,
        status: 200,
        body: sse.open(opt.signal),
        json: async () => ({}),
        text: async () => '',
      };
    }

    if (method === 'POST' && p === '/session') return resp(200, { id: 'ses_test1' });
    if (method === 'POST' && /^\/session\/[^/]+\/prompt_async$/.test(p)) return resp(204, undefined);
    if (method === 'POST' && /^\/session\/[^/]+\/abort$/.test(p)) return resp(200, {});
    if (method === 'POST' && /^\/permission\/[^/]+\/reply$/.test(p)) return resp(200, {});
    if (method === 'POST' && /^\/question\/[^/]+\/reply$/.test(p)) return resp(200, {});

    if (method === 'GET' && p === '/session') return resp(200, []);
    if (method === 'GET' && p === '/agent') return resp(200, []);
    if (method === 'GET' && p === '/command') return resp(200, []);

    // 其余（如 /session/<id>/diff）一律空对象 200
    return resp(200, {});
  };
  return { fetchFn, requests };
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────
const active = [];

function buildHarness(opts = {}) {
  const store = makeSettingsStore(opts.ai);
  const ipcMain = makeIpcMain();
  const screen = makeScreen();
  const globalShortcut = opts.noShortcut ? null : makeGlobalShortcut();
  const app = makeApp();
  const child = makeFakeChild();
  const sse = makeSseHub();
  const router = makeFetchRouter(sse);
  const bw = makeBrowserWindow();
  const notifications = [];
  const logs = [];

  const h = installAi({
    ipcMain,
    BrowserWindow: bw.FakeBrowserWindow,
    screen,
    dialog: opts.dialog || null,
    app,
    getSettings: store.getSettings,
    patchSettings: store.patchSettings,
    globalShortcut,
    notify: (title, body) => notifications.push({ title, body }),
    homedir: () => '', // 空 home → workspacePath() 返回 '' → 不 mkdir，零磁盘副作用
    log: (m) => logs.push(String(m)),
    spawnFn: () => child,
    fetchFn: router.fetchFn,
    findExecutableFn: opts.findExecutableFn || (() => FAKE_EXE),
    pickPortFn: async () => FAKE_PORT,
    sleepFn: async () => {},
  });

  const harness = {
    h, ipcMain, store, screen, globalShortcut, app, child, sse, router, bw, notifications, logs,
  };
  harness.invoke = (ch, payload, evt = { sender: null }) => {
    const fn = ipcMain.handlers.get(ch);
    if (!fn) throw new Error('未注册 handler: ' + ch);
    return fn(evt, payload);
  };
  harness.emitCh = (ch, payload, evt = {}) => {
    const fn = ipcMain.listeners.get(ch);
    if (!fn) throw new Error('未注册 listener: ' + ch);
    return fn(evt, payload);
  };
  harness.win = () => bw.instances[bw.instances.length - 1];
  active.push(harness);
  return harness;
}

afterEach(async () => {
  for (const h of active.splice(0)) {
    try { h.h.dispose(); } catch {}
  }
  await flush(2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. 依赖校验
// ─────────────────────────────────────────────────────────────────────────────

test('installAi：缺少必要依赖（ipcMain / BrowserWindow / getSettings）时抛错', () => {
  assert.throws(() => installAi({}), /缺少必要依赖/);
  assert.throws(() => installAi(), /缺少必要依赖/);
  assert.throws(() => installAi({ ipcMain: {} }), /缺少必要依赖/);
  assert.throws(() => installAi({ ipcMain: {}, BrowserWindow: function () {} }), /缺少必要依赖/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. IPC 面完整性
// ─────────────────────────────────────────────────────────────────────────────

test('IPC 面：19 个 handle + 7 个 on，且无重复 channel', () => {
  const H = buildHarness();
  assert.deepEqual(H.ipcMain.dupHandlers, [], '存在重复注册的 handle channel');
  assert.deepEqual(H.ipcMain.dupListeners, [], '存在重复注册的 on channel');
  assert.equal(H.ipcMain.handlers.size, 19, 'handle channel 数变了');
  assert.equal(H.ipcMain.listeners.size, 7, 'on channel 数变了');

  const handles = [
    'ai-engine-status', 'ai-engine-start', 'ai-engine-stop', 'ai-engine-log',
    'ai-session-new', 'ai-session-list', 'ai-send', 'ai-abort',
    'ai-permission-reply', 'ai-question-reply', 'ai-diff', 'ai-agents',
    'ai-commands', 'ai-recent', 'ai-clear-recent', 'ai-pick-workspace',
    'ai-window-state', 'ai-hotkey-record', 'ai-hotkey-reset',
  ];
  for (const ch of handles) assert.ok(H.ipcMain.handlers.has(ch), '缺少 handler: ' + ch);

  const listeners = [
    'ai-push-recent', 'ai-window-show', 'ai-window-expand', 'ai-window-collapse',
    'ai-window-hide', 'ai-window-toggle', 'ai-window-wake',
  ];
  for (const ch of listeners) assert.ok(H.ipcMain.listeners.has(ch), '缺少 listener: ' + ch);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 开关语义
// ─────────────────────────────────────────────────────────────────────────────

test('enabled=false：bootstrap 完全不动（不建窗、不注册热键）', () => {
  const H = buildHarness({ ai: { enabled: false } });
  assert.deepEqual(H.h.bootstrap(), { ok: true, skipped: 'disabled' });
  assert.equal(H.bw.instances.length, 0, '未启用不该建窗口');
  assert.equal(H.globalShortcut.registered.size, 0, '未启用不该注册热键');
  assert.equal(H.h.getWindow(), null);
});

test('enabled=true：bootstrap 建窗口（透明/无边框/置顶/跳过任务栏）+ 注册默认热键 Alt+A', () => {
  const H = buildHarness({ ai: { enabled: true } });
  const r = H.h.bootstrap();
  assert.equal(r.ok, true);
  assert.equal(H.bw.instances.length, 1, '应建 1 个窗口');

  const w = H.win();
  assert.equal(w.opts.transparent, true);
  assert.equal(w.opts.frame, false);
  assert.equal(w.opts.resizable, false);
  assert.equal(w.opts.movable, false);
  assert.equal(w.opts.alwaysOnTop, true);
  assert.equal(w.opts.skipTaskbar, true);
  assert.equal(w.opts.show, false, '首帧应隐藏，等 load 完成再由 applyMode 显示');
  assert.equal(w.opts.webPreferences.contextIsolation, true);
  assert.equal(w.opts.webPreferences.nodeIntegration, false);

  assert.ok(H.globalShortcut.isRegistered('Alt+A'), '默认热键应为 Alt+A');

  assert.ok(H.globalShortcut.isRegistered('Alt+A'));
  assert.ok(w.callNames().includes('setAlwaysOnTop'));
  assert.ok(w.callNames().includes('setVisibleOnAllWorkspaces'));
  assert.ok(w.callNames().includes('loadFile'));
});

test('鼠标穿透铁律：setIgnoreMouseEvents 只允许 false（否则 OS 拖放投递不到）', () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  const w = H.win();
  // 多触发几次形态切换，确认没有任何路径会开穿透
  H.h.wake();
  H.h.expand();
  H.h.collapse();
  assert.ok(w.ignoreMouseArgs.length >= 1, '必须显式关闭穿透');
  assert.ok(
    w.ignoreMouseArgs.every((v) => v === false),
    '出现 setIgnoreMouseEvents(true) —— 会毁掉拖文件进来：' + JSON.stringify(w.ignoreMouseArgs),
  );
});

test('渲染层推送门：did-finish-load 之前被挡住，之后放行，render-process-gone 后再挡住', () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  const w = H.win();

  H.h.wake();
  assert.equal(w.sentOf('ai-window-mode').length, 0, '未 did-finish-load 前不该推送（否则渲染层收不到）');

  w.fireWeb('did-finish-load');
  assert.ok(w.sentOf('ai-window-mode').length >= 1, 'did-finish-load 后应开始推送');
  const afterLoad = w.sentOf('ai-window-mode').length;

  w.fireWeb('render-process-gone');
  H.h.wake();
  assert.equal(w.sentOf('ai-window-mode').length, afterLoad, 'render-process-gone 后应重新挡住推送');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 状态与安全铁律
// ─────────────────────────────────────────────────────────────────────────────

test('ai-engine-status：形状正确、enabled 跟随设置、且不含鉴权字段', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  const res = await H.invoke('ai-engine-status');
  assert.equal(res.ok, true);
  assert.equal(typeof res.status, 'object');
  assert.equal(res.status.enabled, true);
  assert.equal('auth' in res.status, false, 'status 不该含 auth');
  assert.equal(JSON.stringify(res.status).includes('Basic '), false, 'status 泄漏了鉴权串');

  H.store.patchSettings({ ai: { enabled: false } });
  const res2 = await H.invoke('ai-engine-status');
  assert.equal(res2.status.enabled, false, 'enabled 应跟随设置');
});

test('§7.3 铁律：引擎随机密码绝不进渲染层（send 载荷 + 所有 invoke 结果全检）', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  const w = H.win();
  w.fireWeb('did-finish-load');

  const startRes = await H.invoke('ai-engine-start');
  assert.equal(startRes.ok, true, '引擎应能起（假件齐全）');

  const conn = H.h.engine.conn();
  assert.ok(conn && conn.auth, '主进程侧应有含鉴权的连接信息');
  const decoded = Buffer.from(conn.auth.slice('Basic '.length), 'base64').toString('utf8');
  const pass = decoded.slice('opencode:'.length);
  assert.ok(pass.length >= 20, '密码应为随机长串');

  // 尽可能多触发渲染层可见的数据
  await H.invoke('ai-send', { text: 'ping' });
  await flush();
  H.sse.push(sseFrame('session.next.text.delta', { delta: 'x' }));
  await flush();

  const blobs = [];
  for (const s of w.sent) blobs.push(JSON.stringify(s.payload));
  for (const ch of ['ai-engine-status', 'ai-window-state', 'ai-recent', 'ai-engine-log',
    'ai-session-list', 'ai-commands', 'ai-agents']) {
    blobs.push(JSON.stringify(await H.invoke(ch)));
  }
  blobs.push(JSON.stringify(H.h.status()));
  blobs.push(JSON.stringify(H.h.getState()));

  const all = blobs.join('\n');
  assert.equal(all.includes(pass), false, '渲染层可见数据里出现了引擎密码！');
  assert.equal(all.includes('Basic '), false, '渲染层可见数据里出现了鉴权串！');
  assert.equal(all.toLowerCase().includes('authorization'), false, '渲染层可见数据里出现了 Authorization！');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 发消息全链路
// ─────────────────────────────────────────────────────────────────────────────

test('ai-send 全链路：先建会话再异步发提示；body 形状正确；model 为空时缺席', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');

  const res = await H.invoke('ai-send', { text: 'hi' });
  assert.deepEqual(res, { ok: true, sessionID: 'ses_test1' });

  const posts = H.router.requests
    .filter((r) => r.method === 'POST')
    .map((r) => new URL(r.url).pathname);
  assert.deepEqual(posts, ['/session', '/session/ses_test1/prompt_async'], '请求顺序应为 建会话 → 发提示');

  const prompt = H.router.requests.find((r) => r.url.endsWith('/prompt_async'));
  assert.deepEqual(prompt.body.parts, [{ type: 'text', text: 'hi' }]);
  assert.equal(prompt.body.agent, 'build', '默认 agent 应为 build');
  assert.equal('model' in prompt.body, false, 'settings.ai.model 为空时 model 必须缺席（防引擎 400）');
  assert.match(prompt.headers.Authorization || '', /^Basic /, '请求应带 Basic 鉴权');

  // 本地历史
  assert.deepEqual(H.store.peek().ai.recent, ['hi']);
});

test('ai-send：model 解析出 provider/model 两段齐全时才带上', async () => {
  const H = buildHarness({ ai: { enabled: true, model: 'anthropic/claude-3' } });
  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');
  await H.invoke('ai-send', { text: 'hi' });
  const prompt = H.router.requests.find((r) => r.url.endsWith('/prompt_async'));
  assert.deepEqual(prompt.body.model, { providerID: 'anthropic', modelID: 'claude-3' });
});

test('ai-send：空输入直接拒绝，不发任何请求', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  const res = await H.invoke('ai-send', {});
  assert.deepEqual(res, { ok: false, error: '空输入' });
  assert.equal(H.router.requests.length, 0);
});

test('ai-send：引擎起不来时友好失败（不是异常）', async () => {
  const H = buildHarness({ ai: { enabled: true }, findExecutableFn: () => '' });
  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');
  const res = await H.invoke('ai-send', { text: 'hi' });
  assert.equal(res.ok, false);
  assert.match(res.error, /未检测到/);
});

test('ai-engine-start：找不到可执行文件时如实报错', async () => {
  const H = buildHarness({ ai: { enabled: true }, findExecutableFn: () => '' });
  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');
  const res = await H.invoke('ai-engine-start');
  assert.equal(res.ok, false);
  assert.match(res.error, /未检测到/);
});

test('autoStart=false 语义：显式「启动引擎」能拉起（force 后门），但发消息不隐式拉起', async () => {
  // autoStart 的语义是「不要**自动**拉起」，不是「禁止启动」。
  //   · 设置页「启动引擎」按钮 → ai-engine-start 必须能起（ipc.js:404 的 force 后门）。
  //   · 渲染层直接发消息 → ai-send 尊重 autoStart，不偷偷把引擎拉起来。
  const H = buildHarness({ ai: { enabled: true, autoStart: false } });
  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');

  // 1) 未显式启动前，ai-send 不该隐式拉起引擎
  const blocked = await H.invoke('ai-send', { text: 'hi' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /自动启动/);
  assert.equal(H.router.requests.length, 0, 'ai-send 不该隐式拉起引擎');
  assert.equal(H.h.engine.isRunning(), false);

  // 2) 用户明确点「启动引擎」→ 必须能拉起（否则 autoStart=false 是死路）
  const started = await H.invoke('ai-engine-start');
  assert.equal(started.ok, true, 'autoStart=false 时「启动引擎」也必须能起');
  assert.equal(started.version, '1.17.9');
  assert.equal(started.port, FAKE_PORT);
  assert.equal(H.h.engine.isRunning(), true);
  assert.ok(H.router.requests.some((r) => r.url.endsWith('/global/health')), '应发出健康检查');

  // 3) 引擎起后，发消息恢复正常
  const send = await H.invoke('ai-send', { text: 'hi' });
  assert.deepEqual(send, { ok: true, sessionID: 'ses_test1' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. SSE 转发
// ─────────────────────────────────────────────────────────────────────────────

test('SSE 帧 → 渲染层：四类事件各自到达；畸形帧不打断循环；session.idle 触发完成通知', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  const w = H.win();
  w.fireWeb('did-finish-load');

  await H.invoke('ai-engine-start');
  await flush(); // 等 SSE 循环拿到流

  H.sse.push(sseFrame('session.next.text.delta', { delta: 'a' }));
  await flush();
  H.sse.push('data: {oops\n\n'); // 畸形帧：必须被吞掉，不影响后续
  await flush();
  H.sse.push(sseFrame('session.next.tool.called', { tool: 'bash' }));
  H.sse.push(sseFrame('session.next.tool.success', { tool: 'bash', ok: true }));
  await flush();
  H.sse.push(sseFrame('session.idle', {}));
  await flush();

  const types = w.sentOf('ai-event').map((s) => s.payload.type);
  for (const t of [
    'session.next.text.delta',
    'session.next.tool.called',
    'session.next.tool.success',
    'session.idle',
  ]) {
    assert.ok(types.includes(t), `未转发事件 ${t}（实际：${types.join(', ') || '空'}）`);
  }

  // 运行态：running → idle
  const runs = w.sentOf('ai-run').map((s) => s.payload.run);
  assert.ok(runs.includes('running'), '应推送 running 运行态');
  assert.ok(runs.includes('idle'), 'session.idle 后应回到 idle');

  assert.ok(H.notifications.some((n) => String(n.body).includes('做完了')), '一轮结束应发完成通知');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 中止 / 人类在手环
// ─────────────────────────────────────────────────────────────────────────────

test('ai-abort：无会话时拒绝；有会话时打到 /abort', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  const no = await H.invoke('ai-abort');
  assert.equal(no.ok, false);

  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');
  await H.invoke('ai-send', { text: 'hi' });

  const r = await H.invoke('ai-abort');
  assert.deepEqual(r, { ok: true });
  assert.ok(
    H.router.requests.some((x) => x.url.endsWith('/session/ses_test1/abort')),
    '应打到 /session/ses_test1/abort',
  );
});

test('ai-permission-reply：非法 reply / 缺 requestID 拒绝；合法值打到引擎；reject 带人类可读说明', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');
  await H.invoke('ai-engine-start');

  // 非法 reply
  assert.deepEqual(
    await H.invoke('ai-permission-reply', { requestID: 'p1', reply: 'nope' }),
    { ok: false, error: '参数不完整' },
  );
  // 缺 requestID
  assert.deepEqual(
    await H.invoke('ai-permission-reply', { reply: 'once' }),
    { ok: false, error: '参数不完整' },
  );

  // 合法 once
  assert.deepEqual(await H.invoke('ai-permission-reply', { requestID: 'p1', reply: 'once' }), { ok: true });
  const once = H.router.requests.find((x) => x.url.endsWith('/permission/p1/reply'));
  assert.deepEqual(once.body, { reply: 'once' });

  // reject 必须带非空人类可读说明（阻止 Agent 原地重试同一动作）
  assert.deepEqual(await H.invoke('ai-permission-reply', { requestID: 'p2', reply: 'reject' }), { ok: true });
  const rej = H.router.requests.find((x) => x.url.endsWith('/permission/p2/reply'));
  assert.equal(rej.body.reply, 'reject');
  assert.equal(typeof rej.body.message, 'string');
  assert.ok(rej.body.message.trim().length > 0, 'reject 说明不能为空');
});

test('ai-question-reply：缺 requestID 拒绝；合法时打到 /question/<id>/reply', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');
  await H.invoke('ai-engine-start');

  assert.deepEqual(await H.invoke('ai-question-reply', {}), { ok: false, error: '参数不完整' });
  assert.deepEqual(await H.invoke('ai-question-reply', { requestID: 'q1', answer: 'yes' }), { ok: true });
  const req = H.router.requests.find((x) => x.url.endsWith('/question/q1/reply'));
  assert.deepEqual(req.body, { answer: 'yes' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. 窗口形态
// ─────────────────────────────────────────────────────────────────────────────

test('窗口形态：expand→panelRect / collapse→barRect / hide→capsuleRect，且每次都推 ai-window-mode', () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  const w = H.win();
  w.fireWeb('did-finish-load');

  const wa = WORK_AREA;
  const s = H.store.peek();

  H.emitCh('ai-window-expand');
  assert.deepEqual(w.lastCall('setBounds').args[0], state.panelRect(wa, s), 'EXPAND 应为面板矩形');
  assert.equal(w.sentOf('ai-window-mode').pop().payload.mode, 'open');

  H.emitCh('ai-window-collapse');
  assert.deepEqual(w.lastCall('setBounds').args[0], state.barRect(wa, s), 'COLLAPSE 应为输入条矩形');
  assert.equal(w.sentOf('ai-window-mode').pop().payload.mode, 'bar');

  H.emitCh('ai-window-hide');
  assert.deepEqual(w.lastCall('setBounds').args[0], state.capsuleRect(wa, s), 'HIDE 应为胶囊矩形');
  assert.equal(w.sentOf('ai-window-mode').pop().payload.mode, 'capsule');
});

test('窗口形态：showCapsule=false 时 hide → 完全隐藏并调用 win.hide()', () => {
  const H = buildHarness({ ai: { enabled: true, showCapsule: false } });
  H.h.bootstrap();
  const w = H.win();
  w.fireWeb('did-finish-load');

  H.emitCh('ai-window-expand');
  assert.equal(w.sentOf('ai-window-mode').pop().payload.mode, 'open');

  H.emitCh('ai-window-hide');
  assert.equal(w.sentOf('ai-window-mode').pop().payload.mode, 'hidden');
  assert.ok(w.callNames().includes('hide'), 'hidden 态应调用 win.hide()');
});

test('close 事件被拦截为 hide，绝不 destroy', () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  const w = H.win();
  let prevented = false;
  w.fireWin('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'close 应 preventDefault');
  assert.equal(w.isDestroyed(), false, 'close 不该 destroy 窗口');
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. 设置变更与热键
// ─────────────────────────────────────────────────────────────────────────────

test('设置变更：enabled true→false → 隐藏窗口 + 注销热键', () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  const w = H.win();
  w.fireWeb('did-finish-load');
  assert.ok(H.globalShortcut.isRegistered('Alt+A'));

  H.store.patchSettings({ ai: { enabled: false } });
  H.h.onSettingsChanged();

  assert.equal(H.globalShortcut.registered.size, 0, '应注销热键');
  assert.ok(w.callNames().includes('hide'), '应隐藏窗口');
  assert.equal(w.sentOf('ai-window-mode').pop().payload.mode, 'hidden');
});

test('热键重录：被别的程序占用 → 失败且回滚，旧热键仍在注册态', () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  assert.ok(H.globalShortcut.isRegistered('Alt+A'));

  H.globalShortcut.fail.add('Alt+B'); // 模拟被占用
  const r = H.h.applyAiHotkey('Alt+B');
  assert.equal(r.ok, false);
  assert.equal(r.restored, true, '应回滚旧值');
  assert.ok(H.globalShortcut.isRegistered('Alt+A'), '回滚后旧热键必须仍在注册态');
  assert.equal(H.globalShortcut.isRegistered('Alt+B'), false);
});

test('热键重录：与主窗口召唤键冲突 → 拒绝且不动现有注册', () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  const r = H.h.applyAiHotkey('Alt+Space'); // 主窗口召唤键
  assert.equal(r.ok, false);
  assert.match(r.error, /冲突/);
  assert.ok(H.globalShortcut.isRegistered('Alt+A'), '被拒时不该动现有热键');
});

test('热键重录：命中 macOS 系统保留组合 → 允许但如实告警', () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  const r = H.h.applyAiHotkey('Cmd+Space');
  assert.equal(r.ok, true, '系统保留组合允许强用');
  assert.ok(r.warn && r.warn.length > 0, '应带 warn 告知用户');
  assert.ok(H.globalShortcut.isRegistered('Cmd+Space'));
});

test('globalShortcut=null：installHotkey 优雅降级，bootstrap 不炸', () => {
  const H = buildHarness({ ai: { enabled: true }, noShortcut: true });
  const r = H.h.installHotkey();
  assert.equal(r.ok, false);
  assert.match(r.error, /不支持/);
  assert.equal(H.h.bootstrap().ok, true, '无热键环境仍应能 bootstrap');
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. 生命周期 / 进程回收
// ─────────────────────────────────────────────────────────────────────────────

test('退出回收：before-quit 让引擎子进程收到 kill（不留孤儿）', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');
  await H.invoke('ai-engine-start');
  assert.equal(H.h.engine.isRunning(), true, '引擎应已运行');

  H.app.emit('before-quit');
  await flush();
  assert.ok(H.child.signals.length > 0, 'before-quit 必须回收引擎进程（否则留孤儿）');
  assert.ok(H.child.signals.includes('SIGTERM'));
});

test('stopEngine：幂等（第二次 alreadyStopped）', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');
  await H.invoke('ai-engine-start');

  const r1 = await H.h.stopEngine();
  assert.equal(r1.ok, true);
  const r2 = await H.h.stopEngine();
  assert.equal(r2.alreadyStopped, true, '重复 stop 应报 alreadyStopped');
});

test('dispose：停引擎 + 摘热键 + 销毁窗口', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  const w = H.win();
  await H.invoke('ai-engine-start');
  assert.ok(H.globalShortcut.isRegistered('Alt+A'));

  H.h.dispose();
  assert.equal(H.globalShortcut.registered.size, 0);
  assert.equal(w.isDestroyed(), true);
  assert.equal(H.h.getWindow(), null);
  await flush();
  assert.ok(H.child.signals.includes('SIGTERM'));
});

test('ai-engine-stop：停引擎、清会话、复位运行态', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');
  await H.invoke('ai-engine-start');
  await H.invoke('ai-send', { text: 'hi' });

  const r = await H.invoke('ai-engine-stop');
  assert.equal(r.ok, true);
  assert.equal(H.h.engine.isRunning(), false);
  assert.equal(H.h.getState().sessionID, '', '应清空当前会话');
});

test('重复 installAi：两个独立 ipcMain 互不干扰（无模块级状态泄漏）', () => {
  const A = buildHarness({ ai: { enabled: true } });
  const B = buildHarness({ ai: { enabled: true } });
  A.h.bootstrap();
  B.h.bootstrap();

  assert.equal(A.bw.instances.length, 1);
  assert.equal(B.bw.instances.length, 1);
  assert.notEqual(A.win(), B.win());
  assert.ok(A.globalShortcut.isRegistered('Alt+A'));
  assert.ok(B.globalShortcut.isRegistered('Alt+A'));

  A.h.dispose();
  assert.equal(A.h.getWindow(), null);
  assert.ok(B.h.getWindow() && !B.h.getWindow().isDestroyed(), 'A 的 dispose 不该影响 B');
  assert.ok(B.globalShortcut.isRegistered('Alt+A'), 'A 的 dispose 不该注销 B 的热键');
  assert.equal(A.ipcMain.handlers.size, B.ipcMain.handlers.size);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. 本地历史 / 工作区 / 内部工具
// ─────────────────────────────────────────────────────────────────────────────

test('ai-recent / ai-clear-recent / ai-push-recent：本地历史往返', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.emitCh('ai-push-recent', { text: 'hello' });
  assert.deepEqual((await H.invoke('ai-recent')).recent, ['hello']);

  assert.deepEqual(H.invoke('ai-clear-recent'), { ok: true });
  assert.deepEqual((await H.invoke('ai-recent')).recent, []);
});

test('ai-pick-workspace：无 dialog 报不支持；取消返回 canceled；选中写回设置', async () => {
  // 无 dialog
  const H0 = buildHarness({ ai: { enabled: true } });
  const r0 = await H0.invoke('ai-pick-workspace');
  assert.equal(r0.ok, false);
  assert.match(r0.error, /不支持/);

  // 有 dialog：先取消后选中
  let answer = { canceled: true, filePaths: [] };
  const H = buildHarness({ ai: { enabled: true }, dialog: { showOpenDialog: async () => answer } });
  H.h.bootstrap();
  assert.deepEqual(await H.invoke('ai-pick-workspace'), { ok: false, canceled: true });

  const dir = path.resolve('.');
  answer = { canceled: false, filePaths: [dir] };
  const r = await H.invoke('ai-pick-workspace');
  assert.equal(r.ok, true);
  assert.equal(r.path, dir);
  assert.equal(H.store.peek().ai.workspace, dir, '应写回设置');
});

test('ai-diff：无会话拒绝；有会话返回 diff', async () => {
  const H = buildHarness({ ai: { enabled: true } });
  H.h.bootstrap();
  H.win().fireWeb('did-finish-load');

  const no = await H.invoke('ai-diff');
  assert.equal(no.ok, false);
  assert.match(no.error, /没有会话/);

  await H.invoke('ai-send', { text: 'hi' });
  const yes = await H.invoke('ai-diff');
  assert.equal(yes.ok, true);
  assert.ok(H.router.requests.some((x) => x.url.endsWith('/session/ses_test1/diff')));
});

test('_internals.sanitizeParts：白名单（text 截断 / 非 file:// 丢弃 / 不存在路径丢弃 / 真实文件保留）', () => {
  const H = buildHarness({ ai: { enabled: true } });
  const sp = H.h._internals.sanitizeParts;
  const real = path.resolve('package.json');

  const out = sp([
    { type: 'text', text: 'hi' },
    { type: 'text', text: '   ' },                          // 空白 → 丢
    { type: 'text', text: 'x'.repeat(25000) },              // → 截断到 20000
    { type: 'file', url: 'https://evil.example/x' },        // 非 file:// → 丢
    { type: 'file', url: 'file:///no/such/path/xyz-123' },  // 不存在 → 丢
    { type: 'file', url: 'file://' + real },                // 真实存在 → 留
    null,
    'garbage',
  ]);

  const texts = out.filter((p) => p.type === 'text');
  assert.equal(texts.length, 2);
  assert.equal(texts[0].text, 'hi');
  assert.equal(texts[1].text.length, 20000, 'text 必须截断到 20000');

  const files = out.filter((p) => p.type === 'file');
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'package.json');
  assert.ok(files[0].url.startsWith('file://'));
});

test('_internals.pushRecent：去重置顶 + 上限 50', () => {
  const H = buildHarness({ ai: { enabled: true } });
  const pr = H.h._internals.pushRecent;
  for (let i = 0; i < 55; i += 1) pr('m' + i);
  assert.equal(H.store.peek().ai.recent.length, 50, '应截断到最近 50');
  assert.equal(H.store.peek().ai.recent[0], 'm54');

  pr('m54'); // 重复 → 置顶且不重复
  const recent = H.store.peek().ai.recent;
  assert.equal(recent[0], 'm54');
  assert.equal(recent.filter((x) => x === 'm54').length, 1, '重复项应被去重');
});
