// Mio - AI 助手 HTTP/SSE 客户端单测（node:test，零第三方）
// 重点锁死 SSE 解析器：它是「边跑边显示」的命门，跨 chunk 半行 / 多帧粘连 / 坏帧都极易出错。
// 运行：npm test（= node --test test/*.test.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const client = require('../main/ai/client.js');

// ============ SSE 解析 ============

test('SSE：单帧解析（data: 前缀 + 空行结尾）', () => {
  const p = client.createSseParser();
  const frames = p.feed('data: {"payload":{"type":"server.connected","properties":{}}}\n\n');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].data, { payload: { type: 'server.connected', properties: {} } });
  assert.equal(frames[0].parseError, false);
});

test('SSE：跨 chunk 的半行必须被缓存（流式最容易错的地方）', () => {
  // 防回归：若每来一个 chunk 就当完整行解析，稍大的事件被切碎后必然 JSON 解析失败 → 内容丢失
  const p = client.createSseParser();
  assert.deepEqual(p.feed('data: {"payl'), [], '半行不该产出帧');
  assert.deepEqual(p.feed('oad":{"type":"session.next.text.delta"'), [], '仍是半行');
  const frames = p.feed('}}\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.payload.type, 'session.next.text.delta');
});

test('SSE：一个 chunk 里粘多个帧', () => {
  const p = client.createSseParser();
  const frames = p.feed(
    'data: {"n":1}\n\n' +
    'data: {"n":2}\n\n' +
    'data: {"n":3}\n\n',
  );
  assert.deepEqual(frames.map((f) => f.data.n), [1, 2, 3]);
});

test('SSE：兼容 \\r\\n 行尾', () => {
  const p = client.createSseParser();
  const frames = p.feed('data: {"n":1}\r\n\r\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.n, 1);
});

test('SSE：注释行（心跳）被忽略，且不污染后续帧', () => {
  const p = client.createSseParser();
  const frames = p.feed(':keep-alive\n\ndata: {"n":1}\n\n');
  assert.equal(frames.length, 1, '注释行不该产出帧');
  assert.equal(frames[0].data.n, 1);
});

test('SSE：多行 data 以 \\n 拼接后再解析', () => {
  const p = client.createSseParser();
  const frames = p.feed('data: {"a":\ndata: 1}\n\n');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].data, { a: 1 });
});

test('SSE：坏 JSON 不抛异常，标记 parseError 并保留原文', () => {
  // 防回归：一个坏帧不能炸掉整条流，否则用户看到的是「突然不动了」
  const p = client.createSseParser();
  const frames = p.feed('data: {oops\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].parseError, true);
  assert.equal(frames[0].raw, '{oops');
  assert.equal(frames[0].data, null);
});

test('SSE：event: 字段被记录；只有空 data 不产帧', () => {
  const p = client.createSseParser();
  const f1 = p.feed('event: ping\ndata: {"n":1}\n\n');
  assert.equal(f1[0].event, 'ping');
  assert.deepEqual(p.feed('\n\n'), [], '空帧不产出');
  assert.deepEqual(p.feed('event: x\n\n'), [], '只有 event 字段、没有 data 也不产出');
});

test('SSE：流结束前的不完整帧由 flush() 兜底', () => {
  const p = client.createSseParser();
  assert.deepEqual(p.feed('data: {"n":9}\n'), [], '没有空行 → 尚未成帧');
  const rest = p.flush();
  assert.equal(rest.length, 1);
  assert.equal(rest[0].data.n, 9);
});

test('SSE：非字符串/空输入不炸', () => {
  const p = client.createSseParser();
  assert.deepEqual(p.feed(null), []);
  assert.deepEqual(p.feed(undefined), []);
  assert.deepEqual(p.feed(''), []);
});

// ============ 事件解包 ============

test('unwrapEvent：取出 payload 包装；容错无包装形态；坏帧返回 null', () => {
  assert.deepEqual(
    client.unwrapEvent({ data: { payload: { type: 'a', properties: { x: 1 } } }, parseError: false }),
    { type: 'a', properties: { x: 1 } },
  );
  // 容错：万一某版本不带 payload 包装
  assert.deepEqual(
    client.unwrapEvent({ data: { type: 'b' }, parseError: false }),
    { type: 'b' },
  );
  assert.equal(client.unwrapEvent({ data: { n: 1 }, parseError: false }), null);
  assert.equal(client.unwrapEvent({ data: { payload: { type: 'a' } }, parseError: true }), null);
  assert.equal(client.unwrapEvent(null), null);
});

// ============ 退避与错误归类 ============

test('backoffDelay：指数退避 0.5s→1s→2s→4s→8s，封顶 15s', () => {
  assert.equal(client.backoffDelay(1), 500);
  assert.equal(client.backoffDelay(2), 1000);
  assert.equal(client.backoffDelay(3), 2000);
  assert.equal(client.backoffDelay(4), 4000);
  assert.equal(client.backoffDelay(5), 8000);
  assert.equal(client.backoffDelay(6), 15000);
  assert.equal(client.backoffDelay(99), client.BACKOFF_MAX, '必须封顶，否则会退避到天文数字');
  // 非法输入退化为第一档，不能 NaN
  assert.equal(client.backoffDelay(0), 500);
  assert.equal(client.backoffDelay(-3), 500);
  assert.equal(client.backoffDelay(NaN), 500);
});

test('classifyError：超时 / 引擎未起 / 其它网络错误分类正确', () => {
  // 防回归：错误卡要说人话，分类错了提示就错了
  assert.equal(client.classifyError({ name: 'TimeoutError', message: 'x' }), 'timeout');
  assert.equal(client.classifyError(new Error('fetch failed')), 'engine-down');
  assert.equal(client.classifyError(new Error('connect ECONNREFUSED 127.0.0.1:1')), 'engine-down');
  assert.equal(client.classifyError(new Error('socket hang up')), 'engine-down');
  assert.equal(client.classifyError(new Error('something odd')), 'network');
});

// ============ 请求层 ============

test('client：没有连接信息时一律 engine-down，不发请求', async () => {
  let called = 0;
  const c = client.createClient({ getConn: () => null, fetchFn: async () => { called += 1; return { ok: true }; } });
  const r = await c.health();
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'engine-down');
  assert.equal(called, 0, '引擎没起就不该发请求');
});

test('client：请求带 Basic 鉴权与 JSON 头，2xx 返回 data', async () => {
  let seen = null;
  const c = client.createClient({
    getConn: () => ({ baseUrl: 'http://127.0.0.1:9999', port: 9999, auth: 'Basic abc' }),
    fetchFn: async (url, opt) => {
      seen = { url, opt };
      return { ok: true, status: 200, text: async () => '{"ok":1}' };
    },
  });
  const r = await c.createSession({ title: 't' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { ok: 1 });
  assert.equal(seen.url, 'http://127.0.0.1:9999/session');
  assert.equal(seen.opt.method, 'POST');
  assert.equal(seen.opt.headers.Authorization, 'Basic abc');
  assert.equal(seen.opt.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.opt.body), { title: 't' });
});

test('client：非 2xx 不抛异常，返回可展示的错误文本', async () => {
  // 防回归：401/500 必须变成「内联错误卡」，不是未捕获异常
  const c = client.createClient({
    getConn: () => ({ baseUrl: 'http://127.0.0.1:1', port: 1, auth: 'Basic x' }),
    fetchFn: async () => ({ ok: false, status: 401, text: async () => '{"error":"unauthorized"}' }),
  });
  const r = await c.health();
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.ok(r.error.includes('401'));
  assert.ok(r.error.includes('unauthorized'));
});

test('client：网络异常被归类，绝不冒泡成未捕获异常', async () => {
  const c = client.createClient({
    getConn: () => ({ baseUrl: 'http://127.0.0.1:1', port: 1, auth: 'Basic x' }),
    fetchFn: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1'); },
  });
  const r = await c.listAgents();
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'engine-down');
  assert.ok(r.error.includes('引擎连接失败'));
});

test('client：abort / permission reply 打到正确的路径与载荷', async () => {
  const seen = [];
  const c = client.createClient({
    getConn: () => ({ baseUrl: 'http://127.0.0.1:1', port: 1, auth: 'Basic x' }),
    fetchFn: async (url, opt) => { seen.push({ url, body: opt.body }); return { ok: true, status: 200, text: async () => 'true' }; },
  });
  await c.abort('ses_1');
  await c.replyPermission('per_2', 'once');
  assert.equal(seen[0].url, 'http://127.0.0.1:1/session/ses_1/abort');
  assert.equal(seen[1].url, 'http://127.0.0.1:1/permission/per_2/reply');
  assert.deepEqual(JSON.parse(seen[1].body), { reply: 'once' });
});

test('client：会话与请求 ID 会被 URL 编码（防路径注入）', async () => {
  // 防回归：ID 来自引擎，但拼进路径前仍必须编码，别给「../」留缝
  const seen = [];
  const c = client.createClient({
    getConn: () => ({ baseUrl: 'http://127.0.0.1:1', port: 1, auth: 'Basic x' }),
    fetchFn: async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => '{}' }; },
  });
  await c.getSession('a/../b');
  assert.ok(seen[0].endsWith('/session/a%2F..%2Fb'), '实际：' + seen[0]);
});

test('client：runEventLoop 在 shouldRun 变 false 后退出，不会无限重连', async () => {
  let attempt = 0;
  const c = client.createClient({
    getConn: () => ({ baseUrl: 'http://127.0.0.1:1', port: 1, auth: 'Basic x' }),
    fetchFn: async () => { attempt += 1; throw new Error('fetch failed'); },
    sleepFn: async () => {}, // 注入空 sleep：测的是重连逻辑，不该真等退避
  });
  const statuses = [];
  await c.runEventLoop({ shouldRun: () => attempt < 3, onEvent: () => {}, onStatus: (s) => statuses.push(s) });
  assert.ok(attempt >= 1 && attempt <= 4, '应在 shouldRun 变 false 后停止，实际尝试 ' + attempt + ' 次');
  assert.ok(statuses.includes('connecting'), '应上报 connecting 状态');
  assert.ok(statuses.includes('closed'), '每次断开都应上报 closed，UI 才能显示「已断线」');
});
