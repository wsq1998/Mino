// Mio - AI 助手：主进程侧接线（窗口 + IPC + 事件转发 + 热键）
//
// 为什么单独一个模块而不是塞进 main.js
//   main.js 已经 4400+ 行。助手需要一整套自己的窗口生命周期、IPC 面、SSE 转发与热键注册，
//   全部内联会让主进程彻底失控。这里把「助手」当成一个可安装的子系统：main.js 只做三件事 ——
//   注入依赖、调用 installAi()、退出时 stopEngine()。
//
// 安全边界（docs/16 §7.3 铁律）
//   · 引擎端口与密码**永不进渲染层** —— 渲染层只能通过 ai-* IPC 间接说话。
//   · 渲染层传进来的文件路径必须校验（file:// + 真实存在）才允许塞进 parts。
//   · 窗口绝不开鼠标穿透（拖文件进来要能接住）。
//
// 依赖：本文件 require electron 传入的实例（不直接 require('electron')，便于单测与解耦）。

'use strict';

const path = require('path');
const fs = require('fs');

const state = require('./state.js');
const hotkeys = require('../core/hotkeys.js');
const { createEngine } = require('./engine.js');
const { createClient } = require('./client.js');
const { buildRuleset, resolveWorkspace, parseModel } = require('./ruleset.js');

const RECENT_MAX = 50;

// ─────────────────────────────────────────────────────────────────────────────
// 进程级退出兜底：绝不留孤儿 opencode 进程
//
// 为什么不能只靠 app 的 before-quit / will-quit：
//   那两个钩子只在**走正常退出流程**（app.quit() / ⌘Q）时触发。开发时 Ctrl-C、
//   被 kill、或崩溃退出时都不会走到，于是 opencode serve 会继续活着占着随机端口 ——
//   下次启动又拉一个新的，越攒越多，且因为是随机端口很难被发现。
//
// 两个实现要点：
//   1. 钩子**模块级只注册一次**（不是每个 installAi 各注册一遍）。
//      否则单测里反复 installAi 会堆出几十个监听器，触发 MaxListenersExceededWarning，
//      把测试输出搞脏、掩盖真信号。
//   2. process.on('exit') 里只能做同步事。这里调 engine.stop() 是有效的 ——
//      它的函数体在第一个 await 之前就同步发出了 SIGTERM；后面那 3 秒宽限等不到无所谓，
//      SIGTERM 已足以让引擎自己收摊。
const liveEngines = new Set();
let processExitGuardInstalled = false;

function registerProcessExitGuard(engine) {
  liveEngines.add(engine);
  if (processExitGuardInstalled) return;
  processExitGuardInstalled = true;
  const killAll = () => {
    for (const e of liveEngines) {
      try { e.stop(); } catch {}
    }
  };
  try {
    process.on('exit', killAll);
    // 无监听器时 Node 的默认信号处理会直接终止，'exit' 不保证触发 —— 所以显式接管
    const onSignal = (code) => () => { killAll(); process.exit(code); };
    process.on('SIGINT', onSignal(130));
    process.on('SIGTERM', onSignal(143));
    process.on('SIGHUP', onSignal(129));
  } catch {
    // 某些宿主环境禁止注册信号监听（例如非主线程）—— 不该因此让助手装配失败
  }
}

/**
 * 安装 AI 助手子系统。
 * @param {object} deps
 * @param {object} deps.ipcMain
 * @param {Function} deps.BrowserWindow
 * @param {object} deps.screen
 * @param {object} deps.dialog
 * @param {Function} deps.getSettings
 * @param {Function} deps.patchSettings
 * @param {object} [deps.globalShortcut] 传 null 则不注册热键（无头测试用）
 * @param {Function} [deps.notify] (title, body) => void 系统通知
 * @param {Function} [deps.homedir] () => string
 * @param {Function} [deps.log] (msg) => void
 */
function installAi(deps) {
  const {
    ipcMain, BrowserWindow, screen, dialog, app,
    getSettings, patchSettings,
    globalShortcut = null,
    notify = () => {},
    homedir = () => require('os').homedir(),
    log = () => {},
  } = deps || {};

  if (!ipcMain || !BrowserWindow || typeof getSettings !== 'function') {
    throw new Error('installAi 缺少必要依赖（ipcMain / BrowserWindow / getSettings）');
  }

  // ── 子系统状态 ──────────────────────────────────────────────
  let win = null;
  let winState = { mode: 'capsule', rect: null, interactive: true };
  let runState = 'idle';
  let activeSessionID = '';
  let sseAbort = null;
  let sseRunning = false;
  let disposed = false;
  let aiHotkeyRegistered = '';
  const rendererReady = { done: false };

  // 引擎与客户端。
  // 注入点（spawnFn/fetchFn/…）只为可测性而透传：单测能拿假 spawn + 假 fetch 跑完整链路，
  // 不必真起 opencode 进程；生产路径下这些键都是 undefined，各自回落到真实实现。
  const engine = createEngine({
    spawnFn: deps.spawnFn,
    fetchFn: deps.fetchFn,
    findExecutableFn: deps.findExecutableFn,
    pickPortFn: deps.pickPortFn,
    sleepFn: deps.sleepFn,
  });
  const client = createClient({
    getConn: () => engine.conn(),
    fetchFn: deps.fetchFn,
    sleepFn: deps.sleepFn,
  });

  const aiSettings = () => {
    const s = getSettings() || {};
    return (s && typeof s.ai === 'object' && s.ai) || {};
  };

  function workspacePath() {
    return resolveWorkspace(aiSettings().workspace, homedir());
  }

  // ═══════════════════════════════════════════════════════════
  // 窗口
  // ═══════════════════════════════════════════════════════════
  function workArea() {
    if (!screen) return { x: 0, y: 0, width: 1440, height: 900 };
    try {
      const pt = screen.getCursorScreenPoint();
      return screen.getDisplayNearestPoint(pt).workArea;
    } catch {
      try {
        return screen.getPrimaryDisplay().workArea;
      } catch {
        return { x: 0, y: 0, width: 1440, height: 900 };
      }
    }
  }

  function workAreaOfWin() {
    if (!screen || !win || win.isDestroyed()) return workArea();
    try {
      return screen.getDisplayMatching(win.getBounds()).workArea;
    } catch {
      return workArea();
    }
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    const settings = getSettings();
    const st = state.resolveWindowState(null, 'INIT', { workArea: workArea(), settings });
    winState = st;

    win = new BrowserWindow({
      width: st.rect.width,
      height: st.rect.height,
      x: st.rect.x,
      y: st.rect.y,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,          // 位置由贴边算法控制，不给手动拖（避免与桌宠手拖冲突）
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // ⚠️ 绝不 setIgnoreMouseEvents(true)：开了鼠标穿透，OS 拖放就投递不到，拖文件进来直接失效
    win.setIgnoreMouseEvents(false);
    win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'ai.html'));

    // 与中转站同一铁律：非退出时 close 一律拦截为 hide，绝不 destroy
    win.on('close', (e) => {
      if (!disposed) {
        e.preventDefault();
        applyMode('HIDE');
      }
    });
    win.webContents.on('did-finish-load', () => {
      rendererReady.done = true;
      pushMode();
      pushEngineStatus();
      pushRun();
    });
    win.webContents.on('render-process-gone', () => {
      rendererReady.done = false;
    });
    win.on('closed', () => {
      win = null;
      rendererReady.done = false;
    });
    return win;
  }

  function send(channel, payload) {
    if (!win || win.isDestroyed()) return;
    if (!rendererReady.done) return;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      log('ai send 失败: ' + err.message);
    }
  }

  function pushMode() {
    send('ai-window-mode', { mode: winState.mode, side: state.aiCfg(getSettings()).side });
  }
  function pushRun() {
    send('ai-run', { run: runState });
  }
  function pushEngineStatus() {
    send('ai-engine-status', engine.status({ enginePath: aiSettings().enginePath }));
  }

  /** 应用窗口形态：算矩形 → setBounds → 通知渲染层。 */
  function applyMode(event) {
    const settings = getSettings();
    const next = state.resolveWindowState({ mode: winState.mode }, event, {
      workArea: win && !win.isDestroyed() ? workAreaOfWin() : workArea(),
      settings,
    });
    winState = next;

    if (next.mode === 'hidden') {
      if (win && !win.isDestroyed()) win.hide();
      pushMode();
      return winState;
    }
    ensureWindow();
    try {
      win.setBounds(next.rect, false);
    } catch (err) {
      log('ai setBounds 失败: ' + err.message);
    }
    // 输入条/面板要能直接打字 → 必须真正获得焦点；胶囊态只是常驻指示器，不抢焦点
    if (next.mode === 'capsule') {
      win.showInactive();
    } else {
      win.show();
      win.focus();
    }
    pushMode();
    return winState;
  }

  function resync() {
    if (!win || win.isDestroyed()) {
      winState = state.resolveWindowState({ mode: winState.mode }, 'RESYNC', {
        workArea: workArea(), settings: getSettings(),
      });
      pushMode();
      return winState;
    }
    // 直接在当前形态上重算矩形（显示器/设置变了）
    return applyMode('RESYNC');
  }

  // ═══════════════════════════════════════════════════════════
  // 引擎 + SSE
  // ═══════════════════════════════════════════════════════════
  /**
   * 确保引擎可用。
   * @param {{force?:boolean}} [o] force=true 表示「用户明确点了启动」——此时无视 autoStart。
   *   ⚠️ 必须有这个后门，否则 autoStart=false 会变成死路：设置页的「启动引擎」按钮
   *   和渲染层发消息都会走 autoStart 判断，用户按了也起不来，只能改设置去解 —— 荒谬。
   *   autoStart 的语义只是「不要**自动**拉起」，不是「禁止启动」。
   */
  async function ensureEngine(o = {}) {
    const s = aiSettings();
    if (!s.enabled) return { ok: false, error: 'AI 助手未启用' };
    if (s.autoStart === false && !o.force && !engine.isRunning()) {
      return { ok: false, error: '引擎未启动（设置里已关闭自动启动，可点「启动引擎」）' };
    }
    const r = await engine.ensure({ enginePath: s.enginePath, workspace: workspacePath() });
    pushEngineStatus();
    return r;
  }

  /** 常驻订阅引擎事件流，把每一帧转发给渲染层，并维护运行态。 */
  function ensureSseLoop() {
    if (sseRunning || disposed) return;
    if (!engine.conn()) return;
    sseRunning = true;
    sseAbort = new AbortController();
    const signal = sseAbort.signal;
    client
      .runEventLoop({
        signal,
        shouldRun: () => !disposed && sseRunning && !!engine.conn(),
        onStatus: (st) => {
          if (st === 'connecting') log('ai sse connecting');
        },
        onEvent: (payload) => {
          if (!payload || typeof payload.type !== 'string') return;
          const next = state.deriveRunState(runState, payload.type);
          if (next !== runState) {
            runState = next;
            pushRun();
          }
          send('ai-event', payload);
          if (payload.type === 'session.idle') onTurnDone();
        },
      })
      .catch((err) => log('ai sse loop 退出: ' + err.message))
      .finally(() => {
        sseRunning = false;
      });
  }

  function stopSseLoop() {
    sseRunning = false;
    if (sseAbort) {
      try { sseAbort.abort(); } catch {}
      sseAbort = null;
    }
  }

  /** 一轮执行结束：读用量、发完成通知。 */
  async function onTurnDone() {
    const s = aiSettings();
    if (s.notifyOnDone !== false) {
      try {
        notify('Mio', 'AI 助手做完了');
      } catch {}
    }
  }

  async function ensureSession({ force = false } = {}) {
    if (activeSessionID && !force) return { ok: true, sessionID: activeSessionID };
    const s = aiSettings();
    const ws = workspacePath();
    try {
      if (ws) fs.mkdirSync(ws, { recursive: true });
    } catch (err) {
      log('创建 AI 工作区失败: ' + err.message);
    }
    const body = { title: 'Mio 会话' };
    if (s.agent) body.agent = s.agent;
    try {
      body.permission = buildRuleset(getSettings());
    } catch {}
    const r = await client.createSession(body);
    if (!r.ok) return { ok: false, error: r.error };
    const d = r.data || {};
    const id = d.id || (d.session && d.session.id) || (d.info && d.info.id) || '';
    if (!id) return { ok: false, error: '引擎未返回会话 ID' };
    activeSessionID = id;
    return { ok: true, sessionID: id };
  }

  /** 文件 part 白名单校验：只接受 file:// 且真实存在的路径。 */
  function sanitizeParts(raw) {
    const out = [];
    const list = Array.isArray(raw) ? raw : [];
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        out.push({ type: 'text', text: String(p.text).slice(0, 20000) });
        continue;
      }
      if (p.type === 'file' && typeof p.url === 'string' && p.url.startsWith('file://')) {
        let fp = '';
        try {
          fp = decodeURIComponent(p.url.slice('file://'.length));
        } catch {
          continue;
        }
        try {
          if (!fs.statSync(fp).isFile()) continue;
        } catch {
          continue; // 不存在的路径直接丢，别把无效 part 喂给引擎
        }
        out.push({
          type: 'file',
          mime: typeof p.mime === 'string' && p.mime ? p.mime : 'application/octet-stream',
          url: p.url,
          filename: typeof p.filename === 'string' && p.filename ? p.filename : path.basename(fp),
        });
      }
    }
    return out;
  }

  function pushRecent(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return;
    const cur = Array.isArray(aiSettings().recent) ? aiSettings().recent : [];
    const next = [t].concat(cur.filter((x) => x !== t)).slice(0, RECENT_MAX);
    try {
      patchSettings({ ai: { recent: next } });
    } catch (err) {
      log('写入 ai.recent 失败: ' + err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // IPC
  // ═══════════════════════════════════════════════════════════
  const handle = (ch, fn) => ipcMain.handle(ch, fn);
  const onCh = (ch, fn) => ipcMain.on(ch, fn);

  // ── 引擎 ──────────────────────────────────────────────────
  handle('ai-engine-status', () => {
    const s = aiSettings();
    const st = engine.status({ enginePath: s.enginePath });
    return {
      ok: true,
      status: {
        ...st,
        // available 不再跟 st.path 做 AND —— 用户把引擎装在自定义位置时，
        // 探测只有带 enginePath 才找得到，而 st.path 正是那次探测的结果，二者本就同源。
        available: st.available,
        enabled: s.enabled === true,
        workspace: workspacePath(),
        error: s.enabled ? st.error : '',
      },
    };
  });

  handle('ai-engine-start', async () => {
    // 用户明确点了「启动引擎」→ 无视 autoStart（autoStart 只是「别自动拉」，不是「禁止启动」）
    const r = await ensureEngine({ force: true });
    pushEngineStatus();
    if (r.ok) ensureSseLoop();
    return r;
  });

  handle('ai-engine-stop', async () => {
    stopSseLoop();
    const r = await engine.stop();
    activeSessionID = '';
    runState = 'idle';
    pushEngineStatus();
    pushRun();
    return { ok: r.ok };
  });

  handle('ai-engine-log', () => ({ ok: true, lines: engine.logTail(120) }));

  // ── 会话 ──────────────────────────────────────────────────
  handle('ai-session-new', async () => {
    const r = await ensureSession({ force: true });
    runState = 'idle';
    pushRun();
    return r;
  });

  handle('ai-session-list', async () => {
    const r = await client.listSessions();
    return r.ok ? { ok: true, sessions: r.data || [] } : { ok: false, error: r.error };
  });

  // ── 发消息 / 中止 ─────────────────────────────────────────
  handle('ai-send', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const text = typeof p.text === 'string' ? p.text : '';
    const parts = sanitizeParts(p.parts);
    // 纯空白不算输入：渲染层虽已 trim 过，但 IPC 谁都能调，主进程必须自己守住，
    // 否则一个空格就会真的打到引擎上去烧一次推理。
    if (text.trim()) parts.unshift({ type: 'text', text: text.slice(0, 20000) });
    if (!parts.length) return { ok: false, error: '空输入' };

    const st = await ensureEngine();
    if (!st.ok) return { ok: false, error: st.error };
    ensureSseLoop();

    const se = await ensureSession({ force: !!p.newSession });
    if (!se.ok) return { ok: false, error: se.error };

    const s = aiSettings();
    const body = { parts };
    if (s.agent) body.agent = s.agent;
    // opencode 的 prompt.model 是 { providerID, modelID } 且 additionalProperties:false —— 两个都得有，
    // 只给 modelID 会被引擎判 400 BadRequest。所以只有在 provider/model 两段都解析出来时才带上；
    // 否则整段省略，交给 opencode 配置里的默认模型（正是 settings.ai.model 为空时的语义）。
    const model = parseModel(s.model);
    if (model && model.providerID && model.modelID) {
      body.model = { providerID: model.providerID, modelID: model.modelID };
    }

    runState = 'running';
    pushRun();

    const r = await client.sendPromptAsync(se.sessionID, body);
    if (!r.ok) {
      runState = 'error';
      pushRun();
      return { ok: false, error: r.error, sessionID: se.sessionID };
    }
    pushRecent(text);
    return { ok: true, sessionID: se.sessionID };
  });

  handle('ai-abort', async () => {
    if (!activeSessionID) return { ok: false, error: '没有进行中的会话' };
    const r = await client.abort(activeSessionID);
    runState = 'idle';
    pushRun();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });

  // ── 人类在手环 ────────────────────────────────────────────
  handle('ai-permission-reply', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const reply = ['once', 'always', 'reject'].includes(p.reply) ? p.reply : '';
    if (!p.requestID || !reply) return { ok: false, error: '参数不完整' };
    // 拒绝时回写一句人类可读理由，避免 Agent 原地重试同一个动作（§6.4）
    const reason = reply === 'reject' ? '用户拒绝了这一步。请换一个不需要该操作的做法，不要重试同一动作。' : '';
    const r = await client.replyPermission(p.requestID, reply, reason);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });

  handle('ai-question-reply', async (_e, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (!p.requestID) return { ok: false, error: '参数不完整' };
    const r = await client.replyQuestion(p.requestID, p.answer ? { answer: p.answer } : {});
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });

  handle('ai-diff', async () => {
    if (!activeSessionID) return { ok: false, error: '没有会话' };
    const r = await client.getDiff(activeSessionID);
    return r.ok ? { ok: true, diff: r.data } : { ok: false, error: r.error };
  });

  handle('ai-agents', async () => {
    const r = await client.listAgents();
    if (!r.ok) return { ok: false, agents: [], error: r.error };
    const list = Array.isArray(r.data) ? r.data : [];
    return { ok: true, agents: list.map((a) => ({ name: a && a.name, mode: a && a.mode })).filter((a) => a.name) };
  });

  handle('ai-commands', async () => {
    const r = await client.listCommands();
    return r.ok ? { ok: true, commands: r.data || [] } : { ok: false, commands: [], error: r.error };
  });

  // ── 本地历史 / 设置 ───────────────────────────────────────
  handle('ai-recent', () => ({ ok: true, recent: Array.isArray(aiSettings().recent) ? aiSettings().recent : [] }));
  onCh('ai-push-recent', (_e, payload) => {
    pushRecent(payload && payload.text);
  });
  handle('ai-clear-recent', () => {
    patchSettings({ ai: { recent: [] } });
    return { ok: true };
  });

  handle('ai-pick-workspace', async () => {
    if (!dialog) return { ok: false, error: '当前环境不支持目录选择' };
    try {
      const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : null, {
        title: '选择 AI 助手的工作区',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
      patchSettings({ ai: { workspace: r.filePaths[0] } });
      return { ok: true, path: r.filePaths[0] };
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }
  });

  // ── 窗口形态 ──────────────────────────────────────────────
  onCh('ai-window-show', () => applyMode('SHOW'));
  onCh('ai-window-expand', () => applyMode('EXPAND'));
  onCh('ai-window-collapse', () => applyMode('COLLAPSE'));
  onCh('ai-window-hide', () => applyMode('HIDE'));
  onCh('ai-window-toggle', () => applyMode('TOGGLE'));
  onCh('ai-window-wake', () => applyMode('WAKE'));
  handle('ai-window-state', () => ({ ok: true, mode: winState.mode, side: state.aiCfg(getSettings()).side, run: runState }));

  // ═══════════════════════════════════════════════════════════
  // 热键（互斥判断统一走 main/core/hotkeys.js 的 validate）
  // ═══════════════════════════════════════════════════════════
  function applyAiHotkey(next) {
    if (!globalShortcut) return { ok: false, error: '当前环境不支持全局快捷键' };
    const acc = String(next == null ? '' : next).trim();
    const v = hotkeys.validate(acc, 'ai');
    if (!v.ok && v.kind === 'conflict') return { ok: false, error: v.error };
    if (!v.ok && v.kind === 'invalid') return { ok: false, error: v.error };
    // 系统保留组合：允许，但如实告知（用户可能真的想强占）
    if (!v.ok && v.kind === 'reserved') {
      log('AI 热键命中系统保留组合：' + v.error);
    }

    const prev = aiHotkeyRegistered || '';
    if (prev) {
      try { globalShortcut.unregister(prev); } catch {}
    }
    let ok = false;
    try {
      ok = globalShortcut.register(acc, () => applyMode('WAKE'));
    } catch {
      ok = false;
    }
    if (!ok) {
      // 注册失败 → 回滚旧值（与主窗口/中转站同一套范式）
      let restored = false;
      if (prev) {
        try { restored = globalShortcut.register(prev, () => applyMode('WAKE')); } catch {}
      }
      return { ok: false, error: '该快捷键已被系统或其他应用占用', restored };
    }
    aiHotkeyRegistered = acc;
    patchSettings({ ai: { hotkey: acc } });
    return { ok: true, hotkey: acc, warn: v.kind === 'reserved' ? v.error : '' };
  }

  function installHotkey() {
    const s = aiSettings();
    if (!s.enabled) {
      uninstallHotkey();
      return { ok: true, skipped: 'disabled' };
    }
    const want = s.hotkey || hotkeys.HOTKEYS.ai;
    const r = applyAiHotkey(want);
    if (r.ok) log('AI 热键已注册：' + want);
    else log('AI 热键注册失败：' + (r.error || ''));
    return r;
  }

  function uninstallHotkey() {
    if (globalShortcut && aiHotkeyRegistered) {
      try { globalShortcut.unregister(aiHotkeyRegistered); } catch {}
    }
    aiHotkeyRegistered = '';
    return { ok: true };
  }

  handle('ai-hotkey-record', (_e, payload) => {
    const acc = payload && payload.accelerator;
    return applyAiHotkey(acc);
  });
  handle('ai-hotkey-reset', () => {
    const r = applyAiHotkey(hotkeys.HOTKEYS.ai);
    return r.ok ? { ok: true, hotkey: hotkeys.HOTKEYS.ai } : r;
  });

  // ═══════════════════════════════════════════════════════════
  // 生命周期
  // ═══════════════════════════════════════════════════════════
  /** 设置变更后调用：形态/热键/入口显隐都可能需要跟着变。 */
  function onSettingsChanged() {
    const s = aiSettings();
    if (!s.enabled) {
      uninstallHotkey();
      winState = { mode: 'hidden', rect: winState.rect, interactive: false };
      if (win && !win.isDestroyed()) win.hide();
      pushMode();
      return;
    }
    if (!aiHotkeyRegistered) installHotkey();
    resync();
    pushEngineStatus();
  }

  /** 启动：启用状态下常驻胶囊 + 注册热键（懒启动引擎，这里不碰引擎）。 */
  function bootstrap() {
    const s = aiSettings();
    if (!s.enabled) return { ok: true, skipped: 'disabled' };
    ensureWindow();
    applyMode('INIT');
    installHotkey();
    pushEngineStatus();
    return { ok: true };
  }

  /** 退出：停引擎（不留孤儿进程）+ 摘热键。同步收尾，因为 quit 不放行异步等待。 */
  function dispose() {
    disposed = true;
    stopSseLoop();
    uninstallHotkey();
    try { engine.stop(); } catch {}
    if (win && !win.isDestroyed()) {
      try { win.destroy(); } catch {}
    }
    win = null;
  }

  /** App 退出前调用：确保引擎进程被回收（SIGTERM → 3s → SIGKILL）。 */
  function stopEngine() {
    stopSseLoop();
    return engine.stop();
  }

  if (app && typeof app.on === 'function') {
    app.on('before-quit', () => {
      disposed = true;
      stopSseLoop();
      try { engine.stop(); } catch {}
    });
    // will-quit 再兜一层：before-quit 有可能被别的分支 e.preventDefault() 打断，
    // will-quit 是真正放行退出的那一站。
    app.on('will-quit', () => {
      try { engine.stop(); } catch {}
    });
  }
  registerProcessExitGuard(engine);

  return {
    bootstrap,
    ensureWindow,
    applyMode,
    show: () => applyMode('SHOW'),
    wake: () => applyMode('WAKE'),
    expand: () => applyMode('EXPAND'),
    collapse: () => applyMode('COLLAPSE'),
    hide: () => applyMode('HIDE'),
    toggle: () => applyMode('TOGGLE'),
    resync,
    onSettingsChanged,
    installHotkey,
    uninstallHotkey,
    applyAiHotkey,
    stopEngine,
    dispose,
    status: () => engine.status(),
    engine,
    client,
    getState: () => ({ ...winState, run: runState, sessionID: activeSessionID, hotkey: aiHotkeyRegistered }),
    getWindow: () => win,
    _internals: { sanitizeParts, pushRecent, ensureSession, ensureSseLoop },
  };
}

module.exports = { installAi, RECENT_MAX };
