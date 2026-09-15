// Mio - AI 助手：opencode serve 的 HTTP / SSE 客户端（零依赖，不 require electron）
//
// 为什么手写而不用 @opencode-ai/sdk
//   硬约束 1 要求 package.json 的 dependencies 永远为空。而本设计只用到 5 个方法 + 1 个
//   SSE 解析器，规模完全可控；引 SDK 会把依赖撑破，代价远大于收益。
//
// 幂等约定：所有方法**永不抛异常**，统一返回 { ok, data?, error?, status?, kind? }，
//   让上层的错误卡有话可说（401 / 超时 / 网络 / 引擎没起）。
//
// 依赖：Node 内置（global fetch / TextDecoder）。fetchFn 与 getConn 均可注入，便于单测。

'use strict';

const REQUEST_TIMEOUT = 15000; // 普通请求超时（流式与长任务不在此列，它们走 SSE）

// ─────────────────────────────────────────────────────────────────────────────
// 1. SSE 解析（本模块最值得单测的纯逻辑）
//    帧格式：`data: {json}` 后跟空行；`:` 开头是注释/心跳；event 字段可选。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 增量式 SSE 解析器。**跨 chunk 的半行会被缓存**，这是流式解析最容易错的地方。
 * @returns {{feed:(chunk:string)=>{event:string,raw:string,data:any,parseError:boolean}[], flush:()=>any[]}}
 */
function createSseParser() {
  let buffer = '';
  let dataLines = [];
  let eventName = '';

  function emit() {
    if (!dataLines.length) {
      eventName = '';
      return null;
    }
    const raw = dataLines.join('\n');
    dataLines = [];
    const name = eventName;
    eventName = '';
    let data = null;
    let parseError = false;
    try {
      data = JSON.parse(raw);
    } catch {
      parseError = true; // 保留 raw 交上层，别让一个坏帧炸掉整条流
    }
    return { event: name, raw, data, parseError };
  }

  return {
    feed(chunk) {
      buffer += String(chunk == null ? '' : chunk);
      const frames = [];
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break; // 半行留在 buffer 里，等下一个 chunk
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          const f = emit();
          if (f) frames.push(f);
          continue;
        }
        if (line.startsWith(':')) continue; // 注释 / 心跳

        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);

        if (field === 'data') dataLines.push(value);
        else if (field === 'event') eventName = value;
        // id / retry 本设计不做断点续传，忽略
      }
      return frames;
    },
    flush() {
      const f = emit();
      return f ? [f] : [];
    },
  };
}

/** 从一帧里取出 opencode 的事件负载：实测形如 { payload: { type, properties } }。 */
function unwrapEvent(frame) {
  if (!frame || frame.parseError || !frame.data) return null;
  const p = frame.data.payload;
  if (p && typeof p === 'object') return p;
  // 容错：万一某版本不带 payload 包装，直接用原始对象
  return typeof frame.data.type === 'string' ? frame.data : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 重连退避（纯函数，可单测）
// ─────────────────────────────────────────────────────────────────────────────
const BACKOFF_BASE = 500;
const BACKOFF_MAX = 15000;

/** 指数退避：0.5s → 1s → 2s → 4s → 8s → 15s（封顶）。 */
function backoffDelay(attempt) {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  return Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** (n - 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 错误归类（给 UI 的错误卡用）
// ─────────────────────────────────────────────────────────────────────────────
/** 把 fetch 抛出的异常翻译成可展示的 kind。 */
function classifyError(err) {
  const name = (err && err.name) || '';
  const msg = String((err && err.message) || err || '');
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout/i.test(msg)) return 'timeout';
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|socket hang up/i.test(msg)) return 'engine-down';
  return 'network';
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 客户端
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {() => ({baseUrl:string, port:number, auth:string} | null)} opts.getConn 引擎连接信息（含密码，只在主进程）
 * @param {Function} [opts.fetchFn]
 */
function createClient(opts = {}) {
  const getConn = opts.getConn;
  const fetchFn = opts.fetchFn || ((...a) => globalThis.fetch(...a));
  const sleepFn = opts.sleepFn || ((ms) => new Promise((res) => setTimeout(res, ms)));

  function conn() {
    const c = typeof getConn === 'function' ? getConn() : null;
    return c && c.baseUrl ? c : null;
  }

  /**
   * 统一请求。永不抛。
   * @returns {Promise<{ok:boolean, data?:any, status?:number, error?:string, kind?:string}>}
   */
  async function req(method, apiPath, body, timeout = REQUEST_TIMEOUT) {
    const c = conn();
    if (!c) return { ok: false, kind: 'engine-down', error: '引擎未运行' };
    const headers = { Authorization: c.auth };
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    try {
      const res = await fetchFn(`${c.baseUrl}${apiPath}`, {
        method,
        headers,
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }
      if (!res.ok) {
        const detail = (data && (data.error || data.message || data.raw)) || '';
        return { ok: false, status: res.status, error: `HTTP ${res.status}${detail ? ` · ${String(detail).slice(0, 160)}` : ''}`, data };
      }
      return { ok: true, status: res.status, data };
    } catch (err) {
      const kind = classifyError(err);
      const map = { timeout: '请求超时', 'engine-down': '引擎连接失败', network: '网络错误' };
      return { ok: false, kind, error: `${map[kind]}：${String((err && err.message) || err).slice(0, 160)}` };
    }
  }

  // ── 健康 / 元信息 ──────────────────────────────────────────
  const health = () => req('GET', '/global/health', null, 3000);
  const listAgents = () => req('GET', '/agent');
  const listCommands = () => req('GET', '/command');
  const listSkills = () => req('GET', '/skill');
  const listTools = (provider, model) => {
    const qs = new URLSearchParams();
    if (provider) qs.set('provider', provider);
    if (model) qs.set('model', model);
    const q = qs.toString();
    return req('GET', `/experimental/tool${q ? `?${q}` : ''}`);
  };

  // ── 会话 ──────────────────────────────────────────────────
  const createSession = (body) => req('POST', '/session', body || {});
  const listSessions = () => req('GET', '/session');
  const getSession = (id) => req('GET', `/session/${encodeURIComponent(id)}`);
  const deleteSession = (id) => req('DELETE', `/session/${encodeURIComponent(id)}`);
  const listMessages = (id) => req('GET', `/session/${encodeURIComponent(id)}/message`);
  const getDiff = (id) => req('GET', `/session/${encodeURIComponent(id)}/diff`);

  // ── 发消息 ────────────────────────────────────────────────
  /** 等结果（P1 不用，留作测试/短任务）。 */
  const sendPrompt = (id, body) => req('POST', `/session/${encodeURIComponent(id)}/message`, body, 300000);
  /** **不等结果** —— 配合 SSE 才能「边跑边显示」，这是主路径。 */
  const sendPromptAsync = (id, body) => req('POST', `/session/${encodeURIComponent(id)}/prompt_async`, body);
  /** 中止当前执行。 */
  const abort = (id) => req('POST', `/session/${encodeURIComponent(id)}/abort`);
  /** 斜杠命令。 */
  const runCommand = (id, body) => req('POST', `/session/${encodeURIComponent(id)}/command`, body);

  // ── 权限 / 提问（人类在手环）────────────────────────────────
  const listPermissions = () => req('GET', '/permission');
  /** reply: 'once' | 'always' | 'reject' */
  const replyPermission = (requestID, reply, message) =>
    req('POST', `/permission/${encodeURIComponent(requestID)}/reply`, message ? { reply, message } : { reply });
  const listQuestions = () => req('GET', '/question');
  const replyQuestion = (requestID, body) => req('POST', `/question/${encodeURIComponent(requestID)}/reply`, body || {});
  const rejectQuestion = (requestID, body) => req('POST', `/question/${encodeURIComponent(requestID)}/reject`, body || {});

  /**
   * 订阅 SSE 事件流（单次连接，断线由调用方用 runEventLoop 重连）。
   * @param {{onFrame?:(f)=>void, onEvent?:(payload)=>void, signal?:AbortSignal}} o
   */
  async function subscribeEvents(o = {}) {
    const c = conn();
    if (!c) return { ok: false, kind: 'engine-down', error: '引擎未运行' };
    try {
      const res = await fetchFn(`${c.baseUrl}/global/event`, {
        headers: { Authorization: c.auth, Accept: 'text/event-stream' },
        signal: o.signal,
      });
      if (!res.ok || !res.body) {
        return { ok: false, status: res.status, error: `SSE 连接失败 HTTP ${res.status}` };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const frame of parser.feed(text)) {
          if (typeof o.onFrame === 'function') o.onFrame(frame);
          const payload = unwrapEvent(frame);
          if (payload && typeof o.onEvent === 'function') o.onEvent(payload);
        }
      }
      return { ok: true, ended: true };
    } catch (err) {
      if (o.signal && o.signal.aborted) return { ok: true, aborted: true };
      return { ok: false, kind: classifyError(err), error: String((err && err.message) || err) };
    }
  }

  /**
   * 带指数退避的 SSE 常驻循环。
   * @param {{onEvent, onStatus?, shouldRun?:()=>boolean, signal?:AbortSignal}} o
   *   onStatus(state) — state ∈ 'connecting' | 'open' | 'closed'
   */
  async function runEventLoop(o = {}) {
    const shouldRun = o.shouldRun || (() => true);
    let attempt = 0;
    while (shouldRun()) {
      if (o.signal && o.signal.aborted) break;
      if (typeof o.onStatus === 'function') o.onStatus('connecting');
      const r = await subscribeEvents({
        onFrame: (f) => {
          if (attempt !== 0) attempt = 0; // 一旦有帧进来，退避计数归零
          if (typeof o.onFrame === 'function') o.onFrame(f);
        },
        onEvent: o.onEvent,
        signal: o.signal,
      });
      if (r.aborted || (o.signal && o.signal.aborted)) break;
      if (r.ok && r.ended) {
        if (typeof o.onStatus === 'function') o.onStatus('closed');
      } else {
        if (typeof o.onStatus === 'function') o.onStatus('closed');
        if (typeof o.onError === 'function') o.onError(r);
      }
      if (!shouldRun()) break;
      attempt += 1;
      await sleepFn(backoffDelay(attempt));
    }
  }

  return {
    health,
    listAgents,
    listCommands,
    listSkills,
    listTools,
    createSession,
    listSessions,
    getSession,
    deleteSession,
    listMessages,
    getDiff,
    sendPrompt,
    sendPromptAsync,
    abort,
    runCommand,
    listPermissions,
    replyPermission,
    listQuestions,
    replyQuestion,
    rejectQuestion,
    subscribeEvents,
    runEventLoop,
  };
}

module.exports = {
  REQUEST_TIMEOUT,
  BACKOFF_BASE,
  BACKOFF_MAX,
  createSseParser,
  unwrapEvent,
  backoffDelay,
  classifyError,
  createClient,
};
