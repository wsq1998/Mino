// Mio - AI 助手：opencode serve 引擎生命周期（零依赖，不 require electron）
//
// 职责
//   探测可执行文件 → 选一个空闲端口 → spawn 子进程 → 轮询健康 → 交出连接信息 → 退出时回收。
//
// 三条安全铁律（与 docs/16 §7.4 对应）
//   1. 只监听 127.0.0.1（绝不 0.0.0.0）。
//   2. 端口随机、密码随机；**端口与密码只存在于主进程内存，永不进渲染层**（见 conn()）。
//   3. 不 `which` 探测（避免 PATH 污染），改用 fs.accessSync(X_OK) 直接验可执行。
//
// 依赖：仅 Node 内置（child_process / fs / net / os / path / crypto / 全局 fetch）。
//   不 require electron → 纯逻辑可被 `node --test` 直接加载，与 main/core/*.js 同风格。

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// 1. 可执行文件探测
//    ~/.opencode/bin/opencode 是官方 installer 的落点（本机实测 1.17.9 就在这）。
// ─────────────────────────────────────────────────────────────────────────────
const CANDIDATE_PATHS = [
  '~/.opencode/bin/opencode',
  '/opt/homebrew/bin/opencode', // Apple Silicon Homebrew
  '/usr/local/bin/opencode',    // Intel Homebrew / 手动安装
  '~/.bun/bin/opencode',
  '~/.local/bin/opencode',
];

/** 展开 `~`；非字符串返回空串。 */
function expandHome(p) {
  if (typeof p !== 'string') return '';
  const t = p.trim();
  if (!t) return '';
  if (t === '~') return os.homedir();
  if (t.startsWith('~/')) return path.join(os.homedir(), t.slice(2));
  return t;
}

/**
 * 候选路径清单：**用户指定优先**，其后是常见安装位置。
 * @param {string} [enginePath] settings.ai.enginePath（空 = 只走常见路径）
 * @returns {string[]} 去重后的绝对路径数组
 */
function candidatePaths(enginePath) {
  const out = [];
  const push = (p) => {
    const v = expandHome(p);
    if (v && !out.includes(v)) out.push(v);
  };
  push(enginePath); // 用户显式指定的排第一：他说了算
  for (const c of CANDIDATE_PATHS) push(c);
  return out;
}

/** 默认「存在且可执行」判定。 */
function isExecutableFile(p) {
  try {
    return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true);
  } catch {
    return false;
  }
}

/**
 * 返回第一个「存在且可执行」的文件路径；都没有则返回 ''。
 * @param {string} [enginePath]
 * @param {(p:string)=>boolean} [check] 注入判定函数（供单测替换 fs）
 */
function findExecutable(enginePath, check) {
  const verify = typeof check === 'function' ? check : isExecutableFile;
  for (const p of candidatePaths(enginePath)) {
    if (verify(p)) return p;
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 空闲端口
//    为什么不能让 opencode 自己选（--port 0）：系统随机分配的端口 Mio 拿不到，
//    必须先自己占一个、读到号、再释放，然后把号传给引擎。
// ─────────────────────────────────────────────────────────────────────────────
function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 凭据与鉴权（HTTP Basic）
//    opencode serve 未设密码时会在日志里警告 "server is unsecured"，所以永远设。
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_USER = 'opencode';

/** 生成一次性凭据。密码 24 字节随机 → base64url（无 +// 字符，进 URL/header 都安全）。 */
function makeCredentials() {
  return { user: DEFAULT_USER, pass: crypto.randomBytes(24).toString('base64url') };
}

/** Basic 鉴权头。 */
function basicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 健康检查
// ─────────────────────────────────────────────────────────────────────────────
/** 解析 /global/health 的响应体；非健康返回 null。 */
function parseHealth(obj) {
  if (!obj || typeof obj !== 'object' || obj.healthy !== true) return null;
  return { healthy: true, version: typeof obj.version === 'string' ? obj.version : '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 引擎实例
// ─────────────────────────────────────────────────────────────────────────────
const LOG_KEEP = 200;         // 保留最近 200 行引擎日志（供设置页「查看日志」）
const HEALTH_INTERVAL = 300;  // 轮询间隔
const STOP_GRACE = 3000;      // SIGTERM → SIGKILL 的宽限期

/**
 * 创建引擎控制器。所有副作用都可通过 opts 注入，便于单测。
 * @param {object} [opts]
 * @param {Function} [opts.spawnFn] 默认 child_process.spawn
 * @param {Function} [opts.fetchFn] 默认全局 fetch
 * @param {Function} [opts.findExecutableFn] 默认 findExecutable
 * @param {Function} [opts.pickPortFn] 默认 pickPort
 * @param {Function} [opts.sleepFn] 默认 setTimeout Promise
 */
function createEngine(opts = {}) {
  const spawnFn = opts.spawnFn || spawn;
  const fetchFn = opts.fetchFn || ((...a) => globalThis.fetch(...a));
  const findExe = opts.findExecutableFn || findExecutable;
  const getPort = opts.pickPortFn || pickPort;
  const sleep = opts.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let child = null;      // 当前子进程（null = 没起）
  let port = 0;
  let creds = null;
  let version = '';
  let exePath = '';
  let lastError = '';
  let triedPaths = [];
  let logs = [];
  let unexpectedExit = false;

  function pushLog(chunk) {
    const text = String(chunk || '');
    if (!text) return;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      logs.push(line);
    }
    if (logs.length > LOG_KEEP) logs = logs.slice(-LOG_KEEP);
  }

  /** 进程是否还活着。⚠️ 不能用 child.killed —— 它只表示「kill() 被调用过」。 */
  function alive() {
    return !!(child && child.exitCode === null && child.signalCode === null);
  }

  function url(p) {
    return `http://127.0.0.1:${port}${p}`;
  }

  function authHeader() {
    return creds ? { Authorization: basicAuth(creds.user, creds.pass) } : {};
  }

  /** 打一次健康检查；失败返回 null（不抛）。 */
  async function probe() {
    if (!port) return null;
    try {
      const res = await fetchFn(url('/global/health'), {
        headers: authHeader(),
        signal: AbortSignal.timeout(2000),
      });
      if (!res || !res.ok) return null;
      return parseHealth(await res.json());
    } catch {
      return null;
    }
  }

  /** 轮询到健康或超时。返回 version 字符串，失败返回 ''。 */
  async function waitHealthy(timeoutMs = 8000) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    for (;;) {
      const h = await probe();
      if (h) return h.version;
      if (!alive()) return ''; // 进程已死，不必等满超时
      if (Date.now() >= deadline) return '';
      await sleep(HEALTH_INTERVAL);
    }
  }

  /**
   * 拉起引擎。已在运行则直接复用（**空闲不杀** —— 保住会话上下文）。
   * @param {{enginePath?:string, workspace?:string, timeoutMs?:number}} [o]
   * @returns {Promise<{ok:boolean, version?:string, port?:number, reused?:boolean, error?:string, tried?:string[]}>}
   */
  async function start(o = {}) {
    if (alive()) return { ok: true, version, port, reused: true };

    lastError = '';
    unexpectedExit = false;

    const exe = findExe(o.enginePath);
    triedPaths = candidatePaths(o.enginePath);
    if (!exe) {
      lastError = '未检测到 opencode 引擎';
      return { ok: false, error: lastError, tried: triedPaths };
    }
    exePath = exe;

    const p = await getPort();
    const c = makeCredentials();
    port = p;
    creds = c;

    // 工作目录必须真实存在，否则 spawn 直接 ENOENT。兜底回家目录。
    const wanted = expandHome(o.workspace);
    const cwd = wanted && fs.existsSync(wanted) ? wanted : os.homedir();

    let proc;
    try {
      proc = spawnFn(exe, ['serve', '--port', String(p), '--hostname', '127.0.0.1'], {
        cwd,
        env: {
          ...process.env,
          OPENCODE_SERVER_USERNAME: c.user,
          OPENCODE_SERVER_PASSWORD: c.pass,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      lastError = `启动失败：${String((err && err.message) || err)}`;
      port = 0;
      creds = null;
      return { ok: false, error: lastError };
    }

    child = proc;
    try { proc.stdout && proc.stdout.on('data', pushLog); } catch {}
    try { proc.stderr && proc.stderr.on('data', pushLog); } catch {}
    proc.on('error', (err) => {
      lastError = String((err && err.message) || err);
      pushLog(`[spawn error] ${lastError}`);
    });
    proc.on('exit', (code, signal) => {
      pushLog(`[engine exited] code=${code} signal=${signal}`);
      if (child === proc) {
        // 非 stop() 主动杀 → 记为意外退出，好让 UI 能解释「为什么断了」
        if (!unexpectedExit && code !== 0) lastError = `引擎进程退出（code=${code}）`;
        child = null;
        port = 0;
        creds = null;
      }
    });

    const v = await waitHealthy(o.timeoutMs);
    if (!v) {
      lastError = alive() ? '引擎启动超时' : (lastError || '引擎进程未能启动');
      // 起不来就别留半死不活的进程
      await stop();
      return { ok: false, error: lastError };
    }
    version = v;
    return { ok: true, version, port };
  }

  /** 确保可用：可用则直接返回，否则尝试拉起。 */
  async function ensure(o = {}) {
    if (alive()) return { ok: true, version, port, reused: true };
    return start(o);
  }

  /** SIGTERM → 宽限 3s → SIGKILL。幂等，可重复调（App 退出必调）。 */
  async function stop() {
    const proc = child;
    if (!proc) {
      port = 0;
      creds = null;
      return { ok: true, alreadyStopped: true };
    }
    unexpectedExit = true; // 主动停，不算「意外退出」
    const exited = new Promise((resolve) => {
      try { proc.once('exit', () => resolve(true)); } catch { resolve(true); }
    });
    try { proc.kill('SIGTERM'); } catch {}
    const done = await Promise.race([exited, sleep(STOP_GRACE).then(() => false)]);
    if (!done) {
      try { proc.kill('SIGKILL'); } catch {}
    }
    if (child === proc) child = null;
    port = 0;
    creds = null;
    return { ok: true, forced: !done };
  }

  /**
   * 给设置页/首启引导看的状态。**不含密码**。
   * @param {{enginePath?:string}} [o] 带上设置里的自定义路径，否则只探常见安装位置。
   *
   * 为什么不缓存 exePath：设置页在引擎**启动前**就要显示「检测到在哪」，
   * 而路径完全可能在会话中途被改（用户重装/换目录）。缓存了就会显示一个已经不成立的路径；
   * 每次 fs.accessSync 最多探 5 条路径，成本可忽略，准确性更重要。
   */
  function status(o = {}) {
    let exe = exePath;
    if (!exe) {
      try { exe = findExe(o.enginePath || '') || ''; } catch { exe = ''; }
    }
    const running = alive();
    return {
      available: !!exe,
      path: exe,
      version,
      running,
      port: running ? port : 0,
      error: lastError,
      // 没起过进程时 triedPaths 是空的 —— 那就现算候选清单，
      // 好让「未检测到引擎」时能告诉用户到底找过哪些位置
      tried: triedPaths.length ? triedPaths : candidatePaths(o.enginePath),
    };
  }

  /**
   * 给 client 的连接信息。⚠️ **严禁把本对象整体交给渲染层** —— 它含密码。
   */
  function conn() {
    if (!alive() || !creds) return null;
    return { baseUrl: url(''), port, auth: basicAuth(creds.user, creds.pass) };
  }

  return {
    start,
    ensure,
    stop,
    status,
    conn,
    probe,
    logTail: (n = 50) => logs.slice(-n),
    isRunning: alive,
  };
}

module.exports = {
  CANDIDATE_PATHS,
  DEFAULT_USER,
  expandHome,
  candidatePaths,
  isExecutableFile,
  findExecutable,
  pickPort,
  makeCredentials,
  basicAuth,
  parseHealth,
  createEngine,
};
