// Mio - AI 助手：引擎事件载荷映射层单测（node:test，零第三方）
//
// 这些夹具**不是编的**：APIError 那段是从真机 opencode serve 1.17.9 的
// session.error 事件里原样抄下来的（当时引擎默认模型配错，回了 400）。
// 当时渲染层读的是 e.message —— 那个键根本不存在，于是用户只看到「引擎返回了错误」，
// 真正能救命的「invalid model: model name not found」被静默吞掉。
// 这个文件就是为了让这类「字段名猜错」永远在单测层就暴露。
//
// 运行：npm test（= node --test test/*.test.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const evmap = require('../renderer/aiEventMap.js');

// ── 真机抓包夹具：session.error.properties.error（判别联合，带 name + data）──
const REAL_API_ERROR = {
  name: 'APIError',
  data: {
    message: 'invalid model: model name not found',
    statusCode: 400,
    isRetryable: false,
    responseHeaders: { 'content-type': 'application/json', 'content-length': '70' },
    responseBody: '{"error":{"message":"invalid model: model name not found","code":400}}',
    metadata: { url: 'https://chatapi.weixin.qq.com/openai/v1/chat/completions' },
  },
};

const REAL_AUTH_ERROR = {
  name: 'ProviderAuthError',
  data: { providerID: 'minimax', message: 'Forbidden: Key expired' },
};

// ── 真机抓包夹具：message.part.* 家族（opencode serve 1.17.9，逐字抄）──
// 本机引擎只用这一族发正文/思维链/工具/用量；session.next.text.delta 一次都不出现。
const REAL_PART_TEXT = {
  id: 'prt_0a53b46600019QshFpkogn5DUG',
  messageID: 'msg_0a53b4658001b9dFJ6w1ixuvek',
  sessionID: 'ses_f5ac4c007ffeyGp3WFJM3vYFH0',
  type: 'text',
  text: '用 bash 执行 ls test | head -5，然后用一句话告诉我结果。',
};

const REAL_PART_REASONING = {
  id: 'prt_0a53b684c001tWoRgYgnlki4iW',
  messageID: 'msg_0a53b46f3001iWtOHImK2IKK6s',
  sessionID: 'ses_f5ac4c007ffeyGp3WFJM3vYFH0',
  type: 'reasoning',
  text: '',
  time: { start: 1789478529100 },
};

const REAL_PART_STEP_START = {
  id: 'prt_0a53b6805001yvyik07Pucj0hs',
  messageID: 'msg_0a53b46f3001iWtOHImK2IKK6s',
  sessionID: 'ses_f5ac4c007ffeyGp3WFJM3vYFH0',
  type: 'step-start',
};

// 工具卡：同一个 part.id 会来 5 次，state.status 从 pending 往后推进（真机实测）。逐字抄 3 个关键态。
const REAL_TOOL_PENDING = {
  id: 'prt_0a53c5c9e0014FV9ocX19Pyiis',
  messageID: 'msg_0a53c4921001FXp1K4opY6tLc8',
  sessionID: 'ses_f5ac3c0c9ffe2XLL0oyPK0Xe70',
  type: 'tool',
  tool: 'bash',
  callID: 'call_d85d9e42b4924f9d92e5af0c',
  state: { status: 'pending', input: {}, raw: '' },
};

const REAL_TOOL_RUNNING = {
  id: 'prt_0a53c5c9e0014FV9ocX19Pyiis',
  messageID: 'msg_0a53c4921001FXp1K4opY6tLc8',
  sessionID: 'ses_f5ac3c0c9ffe2XLL0oyPK0Xe70',
  type: 'tool',
  tool: 'bash',
  callID: 'call_d85d9e42b4924f9d92e5af0c',
  state: {
    status: 'running',
    input: { description: 'Echo a greeting string', command: 'echo hello-from-mio' },
    metadata: { output: 'hello-from-mio\n', description: 'Echo a greeting string' },
    time: { start: 1789478592517 },
  },
};

const REAL_TOOL_COMPLETED = {
  id: 'prt_0a53c5c9e0014FV9ocX19Pyiis',
  messageID: 'msg_0a53c4921001FXp1K4opY6tLc8',
  sessionID: 'ses_f5ac3c0c9ffe2XLL0oyPK0Xe70',
  type: 'tool',
  tool: 'bash',
  callID: 'call_d85d9e42b4924f9d92e5af0c',
  state: {
    status: 'completed',
    input: { description: 'Echo a greeting string', command: 'echo hello-from-mio' },
    output: 'hello-from-mio\n',
    metadata: { output: 'hello-from-mio\n', exit: 0, description: 'Echo a greeting string', truncated: false },
    title: 'Echo a greeting string',
    time: { start: 1789478592538, end: 1789478592544 },
  },
};

// ⚠️ 真机实测（opencode 1.17.9）：命令非 0 退出时 status 仍是 'completed'，
//    全程不出现 'error'，唯一失败信号是 state.metadata.exit。逐字抄自 /tmp/mio-fail-shape.js。
const REAL_TOOL_FAILED = {
  id: 'prt_0a53f7390001RxHJVx8OIuyPPB',
  messageID: 'msg_0a53c4921001FXp1K4opY6tLc8',
  sessionID: 'ses_f5ac3c0c9ffe2XLL0oyPK0Xe70',
  type: 'tool',
  tool: 'bash',
  callID: 'call_76c678c9056b4ae2b8bde504',
  state: {
    status: 'completed',
    input: { command: 'printf "out1\\n"; printf "err1\\n" >&2; exit 3', description: 'Run command with stdout, stderr, and exit code' },
    output: 'out1\nerr1\n',
    metadata: { output: 'out1\nerr1\n', exit: 3, description: 'Run command with stdout, stderr, and exit code', truncated: false },
    title: 'Run command with stdout, stderr, and exit code',
    time: { start: 1789478795387, end: 1789478795402 },
  },
};

const REAL_PART_STEP_FINISH = {
  id: 'prt_0a53b6faa001RzShQ6AQUvNIx0',
  reason: 'tool-calls',
  messageID: 'msg_0a53b46f3001iWtOHImK2IKK6s',
  sessionID: 'ses_f5ac4c007ffeyGp3WFJM3vYFH0',
  type: 'step-finish',
  tokens: { total: 8697, input: 42, output: 79, reasoning: 0, cache: { write: 0, read: 8576 } },
  cost: 0,
};

// 增量：⚠️ 这条 delta 的 partID 指向上面那个 **reasoning** part —— 证明 field:'text'
// 不代表正文，必须靠 partID→kind 回查（这正是最容易踩的坑）。
const REAL_DELTA_FOR_REASONING = {
  sessionID: 'ses_f5ac4c007ffeyGp3WFJM3vYFH0',
  messageID: 'msg_0a53b46f3001iWtOHImK2IKK6s',
  partID: 'prt_0a53b684c001tWoRgYgnlki4iW',
  field: 'text',
  delta: 'The user wants me to run a bash',
};

test('aiEventMap.sessionErrorMessage：真机 APIError 必须取到 data.message（而不是兜底文案）', () => {
  assert.equal(evmap.sessionErrorMessage(REAL_API_ERROR), 'invalid model: model name not found');
});

test('aiEventMap.sessionErrorMessage：ProviderAuthError 同样落在 data.message', () => {
  assert.equal(evmap.sessionErrorMessage(REAL_AUTH_ERROR), 'Forbidden: Key expired');
});

test('aiEventMap.sessionErrorMessage：覆盖联合里的另一种形状 {type,message}', () => {
  // SessionErrorUnknown / UnknownError 走的是顶层 message，与 APIError 不同
  assert.equal(evmap.sessionErrorMessage({ type: 'unknown', message: '引擎内部错误' }), '引擎内部错误');
});

test('aiEventMap.sessionErrorMessage：只有 data.name 时退回 name，不返回空', () => {
  assert.equal(evmap.sessionErrorMessage({ name: 'APIError', data: {} }), 'APIError');
});

test('aiEventMap.sessionErrorMessage：字符串 / 各种脏输入都不抛异常', () => {
  assert.equal(evmap.sessionErrorMessage('直接给字符串'), '直接给字符串');
  assert.equal(evmap.sessionErrorMessage(''), '');
  assert.equal(evmap.sessionErrorMessage(null), '');
  assert.equal(evmap.sessionErrorMessage(undefined), '');
  assert.equal(evmap.sessionErrorMessage(42), '');
  assert.equal(evmap.sessionErrorMessage({}), '');
  assert.equal(evmap.sessionErrorMessage({ data: null }), '');
  assert.equal(evmap.sessionErrorMessage({ data: '  ' }), '');
  assert.equal(evmap.sessionErrorMessage({ message: '   ' }), '', '空白串不算取到');
});

test('aiEventMap.sessionErrorMessage：data.message 优先于 name（信息量更大）', () => {
  assert.equal(evmap.sessionErrorMessage({ name: 'X', message: '顶层', data: { message: '内层' } }), '顶层');
});

test('aiEventMap.toolErrorMessage：读的是顶层 message（与 session.error 形状不同）', () => {
  assert.equal(evmap.toolErrorMessage({ type: 'unknown', message: '命令返回非零退出码' }), '命令返回非零退出码');
});

test('aiEventMap.toolErrorMessage：兼容引擎换成 data.message 的形状', () => {
  assert.equal(evmap.toolErrorMessage({ name: 'APIError', data: { message: '换形状了' } }), '换形状了');
});

test('aiEventMap.toolErrorMessage：取不到时退回工具输出文本，最后才用通用兜底', () => {
  assert.equal(evmap.toolErrorMessage(null, 'ls: no such file'), 'ls: no such file');
  assert.equal(evmap.toolErrorMessage({}, '   '), '执行失败');
  assert.equal(evmap.toolErrorMessage(undefined, undefined), '执行失败');
  // 永不为空 —— 工具卡上不能出现空白的失败原因
  for (const bad of [null, undefined, {}, '', 0, '  ']) {
    assert.ok(evmap.toolErrorMessage(bad).length > 0, `toolErrorMessage(${JSON.stringify(bad)}) 返回了空串`);
  }
});

test('aiEventMap.engineStatusOf：主进程的 {ok,status} 与预览 mock 的裸对象都要认', () => {
  const inner = { available: true, running: false, path: '/opt/homebrew/bin/opencode' };
  assert.deepEqual(evmap.engineStatusOf({ ok: true, status: inner }), inner);
  assert.deepEqual(evmap.engineStatusOf(inner), inner);
  // 这是渲染层引擎状态卡显示「未检测到」的关键：不能把包装层当成状态本身
  assert.equal(evmap.engineStatusOf({ ok: true, status: inner }).available, true);
});

test('aiEventMap.engineStatusOf：脏输入返回 null（调用方据此跳过渲染，而不是把包装层画出来）', () => {
  assert.equal(evmap.engineStatusOf(null), null);
  assert.equal(evmap.engineStatusOf(undefined), null);
  assert.equal(evmap.engineStatusOf('nope'), null);
  assert.equal(evmap.engineStatusOf(3), null);
});

test('aiEventMap.contentText：合并 content[] 的 text/output 两种键名，丢掉空项', () => {
  assert.equal(evmap.contentText([{ text: 'a' }, { output: 'b' }, { text: '' }, null, { nope: 1 }]), 'a\nb');
  assert.equal(evmap.contentText([]), '');
  assert.equal(evmap.contentText(null), '');
  assert.equal(evmap.contentText({ text: '不是数组' }), '');
});

// ============ message.part.* 家族（真机夹具） ============

test('aiEventMap.partKindOf：按 part.type 归一到语义类别', () => {
  assert.equal(evmap.partKindOf(REAL_PART_TEXT), 'text');
  assert.equal(evmap.partKindOf(REAL_PART_REASONING), 'reasoning');
  assert.equal(evmap.partKindOf(REAL_TOOL_PENDING), 'tool');
  assert.equal(evmap.partKindOf(REAL_PART_STEP_START), 'step');
  assert.equal(evmap.partKindOf(REAL_PART_STEP_FINISH), 'step');
  // 未知 / 脏输入 → other，绝不抛
  assert.equal(evmap.partKindOf({ type: 'whatever' }), 'other');
  assert.equal(evmap.partKindOf({}), 'other');
  assert.equal(evmap.partKindOf(null), 'other');
  assert.equal(evmap.partKindOf(undefined), 'other');
  assert.equal(evmap.partKindOf('text'), 'other');
});

test('aiEventMap.toolStateOf：pending 态（input 空、无 output）安全取值', () => {
  const st = evmap.toolStateOf(REAL_TOOL_PENDING);
  assert.equal(st.callID, 'call_d85d9e42b4924f9d92e5af0c');
  assert.equal(st.tool, 'bash');
  assert.equal(st.status, 'pending');
  assert.deepEqual(st.input, {});
  assert.equal(st.output, '');
  assert.equal(st.error, '');
});

test('aiEventMap.toolStateOf：running 态取到 input（供工具卡副标题）', () => {
  const st = evmap.toolStateOf(REAL_TOOL_RUNNING);
  assert.equal(st.status, 'running');
  assert.equal(st.input.command, 'echo hello-from-mio');
  assert.equal(st.input.description, 'Echo a greeting string');
});

test('aiEventMap.toolStateOf：completed 态 —— output 是 state.output（真机确认），title 也取到，exit:0 → ok:true', () => {
  // ⚠️ 真机实测：completed 的正文在 state.output；state.metadata.output 是同一份 + exit/truncated。
  const st = evmap.toolStateOf(REAL_TOOL_COMPLETED);
  assert.equal(st.status, 'completed');
  assert.equal(st.output, 'hello-from-mio\n');
  assert.equal(st.title, 'Echo a greeting string');
  assert.equal(st.tool, 'bash');
  assert.equal(st.exit, 0);
  assert.equal(st.ok, true, 'exit 0 的命令应判成功');
});

test('aiEventMap.toolStateOf：completed + exit:3 → ok:false（真机实测：非 0 退出仍是 completed！）', () => {
  // 防回归：这是把「失败画成绿色 ✓」的死穴。引擎不把非 0 退出标成 error，唯一信号是 metadata.exit。
  const st = evmap.toolStateOf(REAL_TOOL_FAILED);
  assert.equal(st.status, 'completed', '真机就是 completed —— 所以判断成功/失败不能只看 status');
  assert.equal(st.exit, 3);
  assert.equal(st.ok, false, 'exit 3 必须判失败，否则失败命令会被画成绿色 ✓');
  assert.equal(st.output, 'out1\nerr1\n');
});

test('aiEventMap.toolStateOf：没有 metadata / exit 未定义（read/grep/glob 等）→ exit:null、ok:true', () => {
  const noMeta = evmap.toolStateOf({ type: 'tool', tool: 'read', callID: 'r1', state: { status: 'completed', output: 'file contents' } });
  assert.equal(noMeta.exit, null, '无 metadata 时 exit 应为 null');
  assert.equal(noMeta.ok, true, '取不到退出码 → 不据此判失败');
  const undefExit = evmap.toolStateOf({ type: 'tool', tool: 'read', callID: 'r2', state: { status: 'completed', metadata: { output: 'x' } } });
  assert.equal(undefExit.exit, null);
  assert.equal(undefExit.ok, true);
});

test('aiEventMap.toolStateOf：exit 为脏值（abc/NaN/null/空串）→ exit:null、ok:true、永不抛', () => {
  for (const bad of ['abc', NaN, null, undefined, '', {}, []]) {
    const st = evmap.toolStateOf({ type: 'tool', tool: 'bash', callID: 'c', state: { status: 'completed', metadata: { exit: bad } } });
    assert.equal(st.exit, null, `exit=${JSON.stringify(bad)} 应归一为 null`);
    assert.equal(st.ok, true, `exit=${JSON.stringify(bad)} 不该被判失败`);
  }
});

test('aiEventMap.toolStateOf：error 态取到 error，且 ok:false', () => {
  const st = evmap.toolStateOf({ type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'error', error: '命令返回非零退出码' } });
  assert.equal(st.status, 'error');
  assert.equal(st.error, '命令返回非零退出码');
  assert.equal(st.ok, false, 'error 态必须 ok:false');
});

test('aiEventMap.toolStateOf：pending / running 未定型 → ok:false', () => {
  // 调用方只在 completed / error 两态才用 ok；未定型时给 false，避免「还没跑完就判成功」
  assert.equal(evmap.toolStateOf(REAL_TOOL_PENDING).ok, false);
  assert.equal(evmap.toolStateOf(REAL_TOOL_RUNNING).ok, false);
  assert.equal(evmap.toolStateOf(REAL_TOOL_PENDING).exit, null);
});

test('aiEventMap.toolStateOf：state/input 缺失或脏一律安全默认，永不抛', () => {
  const noState = evmap.toolStateOf({ type: 'tool', tool: 'read', callID: 'c9' });
  assert.equal(noState.status, 'pending', 'state 缺失应退化为 pending');
  assert.equal(noState.callID, 'c9');
  assert.equal(noState.input, null, 'input 非对象应归一为 null');
  // 未知 status 也退化为 pending（保证 ai.js 只会在四个已知态里分派）
  assert.equal(evmap.toolStateOf({ state: { status: 'weird' } }).status, 'pending');
  // state.callID 兜底
  assert.equal(evmap.toolStateOf({ state: { callID: 'from-state' } }).callID, 'from-state');
  for (const bad of [null, undefined, 42, 'tool', {}]) {
    const r = evmap.toolStateOf(bad);
    assert.ok(r && typeof r === 'object' && typeof r.status === 'string');
  }
});

test('aiEventMap.stepUsageOf：真机 step-finish 的 tokens/cost 取对', () => {
  assert.deepEqual(evmap.stepUsageOf(REAL_PART_STEP_FINISH), { input: 42, output: 79, reasoning: 0, cost: 0 });
});

test('aiEventMap.stepUsageOf：缺 tokens / 脏值收敛为 0，永不抛', () => {
  assert.deepEqual(evmap.stepUsageOf({ type: 'step-finish' }), { input: 0, output: 0, reasoning: 0, cost: 0 });
  assert.deepEqual(evmap.stepUsageOf({ tokens: { input: -5, output: 'x', reasoning: null } }), { input: 0, output: 0, reasoning: 0, cost: 0 });
  assert.deepEqual(evmap.stepUsageOf(null), { input: 0, output: 0, reasoning: 0, cost: 0 });
});

test('aiEventMap.mergeTextDelta：delta 追加到累计值', () => {
  assert.equal(evmap.mergeTextDelta('你好', '', '，世界'), '你好，世界');
  assert.equal(evmap.mergeTextDelta('', '', 'ab'), 'ab');
});

test('aiEventMap.mergeTextDelta：快照比累计值长 → 采用快照（补齐落后的 part.updated）', () => {
  // part.updated 往往是「权威全量」，比只靠 delta 拼出来的更全 → 采用它，避免丢字
  assert.equal(evmap.mergeTextDelta('hello', 'hello world', ''), 'hello world');
});

test('aiEventMap.mergeTextDelta：快照比累计值短 → 保留累计值（落后的快照不能截断已到文本）', () => {
  // 关键防回归：快照落后于 delta 时若盲目采用，会把已显示的正文吞掉
  assert.equal(evmap.mergeTextDelta('hello world', 'hello', ''), 'hello world');
});

test('aiEventMap.mergeTextDelta：delta 与快照混合时 —— delta 先追加，再按「更长」采用快照', () => {
  // 记录本实现的确定语义（delta 与 snapshot 正常不会同时给，但需钉死行为）：
  //   base = accumulated + delta；若 snapshot 比 base 长则整体换成 snapshot
  assert.equal(evmap.mergeTextDelta('ab', 'abcdef', 'X'), 'abcdef', '快照更长 → 整体采用快照');
  assert.equal(evmap.mergeTextDelta('abcd', 'ab', 'X'), 'abcdX', '快照更短 → 保留 累计+delta');
});

test('aiEventMap.mergeTextDelta：任一侧为空/非字符串都安全降级，永不抛', () => {
  assert.equal(evmap.mergeTextDelta(undefined, undefined, undefined), '');
  assert.equal(evmap.mergeTextDelta(null, null, null), '');
  assert.equal(evmap.mergeTextDelta(42, 7, true), '', '非字符串当空串');
  assert.equal(evmap.mergeTextDelta('abc', '', ''), 'abc');
  // 真机那条「其实是思维链」的 delta 文本也照常累积
  assert.equal(evmap.mergeTextDelta('', '', REAL_DELTA_FOR_REASONING.delta), 'The user wants me to run a bash');
});

// ============ 会话闸门 sessionGate（P2 加固） ============
// 真机上 GET /global/event 是全局流，会混进别的会话的事件；闸门决定放行/锚定/丢弃。
// 丢弃是「静默」行为（该显示的不显示），所以每一行真值表都要钉死。

test('aiEventMap.sessionGate：真值表逐行 —— 全局卡片任何会话都放行', () => {
  // permission.* / question.* 是「必须让我看到」的卡片，会话不匹配也不许丢，否则界面卡死
  assert.equal(evmap.sessionGate('permission.asked', 'ses_A', 'ses_B'), 'global');
  assert.equal(evmap.sessionGate('question.asked', 'ses_A', 'ses_B'), 'global');
  // 即便事件/当前会话都缺席，全局卡片依然放行
  assert.equal(evmap.sessionGate('permission.updated', '', ''), 'global');
  assert.equal(evmap.sessionGate('question.replied', undefined, undefined), 'global');
});

test('aiEventMap.sessionGate：事件带会话 + 当前未锚定 → adopt', () => {
  assert.equal(evmap.sessionGate('message.part.updated', 'ses_A', ''), 'adopt');
  assert.equal(evmap.sessionGate('message.updated', 'ses_A', undefined), 'adopt');
});

test('aiEventMap.sessionGate：事件会话 === 当前会话 → pass', () => {
  assert.equal(evmap.sessionGate('message.part.delta', 'ses_A', 'ses_A'), 'pass');
  assert.equal(evmap.sessionGate('session.idle', 'ses_ZZZ', 'ses_ZZZ'), 'pass');
});

test('aiEventMap.sessionGate：事件会话 ≠ 当前会话 → discard（防串台）', () => {
  assert.equal(evmap.sessionGate('message.part.updated', 'ses_A', 'ses_B'), 'discard');
  assert.equal(evmap.sessionGate('message.part.delta', 'ses_B', 'ses_A'), 'discard');
});

test('aiEventMap.sessionGate：事件未带会话 → 一律 pass（不拦截无会话信息的事件）', () => {
  assert.equal(evmap.sessionGate('session.status', '', 'ses_A'), 'pass');
  assert.equal(evmap.sessionGate('session.diff', undefined, 'ses_A'), 'pass');
  assert.equal(evmap.sessionGate('message.updated', '', ''), 'pass');
});

test('aiEventMap.sessionGate：脏 / 非字符串入参永不抛，且按「缺席」处理', () => {
  // type 非字符串不能触发 .startsWith 抛错
  for (const badType of [null, undefined, 42, {}, [], true]) {
    assert.equal(evmap.sessionGate(badType, 'ses_A', 'ses_A'), 'pass', `type=${JSON.stringify(badType)} 不该抛`);
  }
  // 会话 id 为脏值时视为缺席：事件脏 + 当前有效 → pass；事件有效 + 当前脏 → adopt
  for (const bad of [null, undefined, 42, {}, [], true, '   ']) {
    assert.equal(evmap.sessionGate('x', bad, 'ses_A'), 'pass', `evt=${JSON.stringify(bad)} 应视为缺席`);
    assert.equal(evmap.sessionGate('x', 'ses_A', bad), 'adopt', `cur=${JSON.stringify(bad)} 应视为缺席`);
  }
  // 全空也不抛
  assert.equal(evmap.sessionGate(undefined, undefined, undefined), 'pass');
});

test('aiEventMap.sessionGate：空白串会话 id 不算「present」（与 s() 归一一致）', () => {
  assert.equal(evmap.sessionGate('message.part.updated', '  ses_A  ', 'ses_A'), 'pass', '事件 id 应被 trim 后比较');
  assert.equal(evmap.sessionGate('message.part.updated', '   ', 'ses_A'), 'pass', '空白事件 id → 缺席 → pass');
  assert.equal(evmap.sessionGate('message.part.updated', 'ses_A', '   '), 'adopt', '空白当前 id → 缺席 → adopt');
});

test('aiEventMap 是 UMD：既可被 require，也会挂到全局（ai.html 以 <script> 加载）', () => {
  assert.equal(typeof evmap.sessionErrorMessage, 'function');
  assert.equal(typeof evmap.toolErrorMessage, 'function');
  assert.equal(typeof evmap.engineStatusOf, 'function');
  assert.equal(typeof evmap.contentText, 'function');
  assert.equal(typeof evmap.partKindOf, 'function');
  assert.equal(typeof evmap.toolStateOf, 'function');
  assert.equal(typeof evmap.stepUsageOf, 'function');
  assert.equal(typeof evmap.mergeTextDelta, 'function');
  assert.equal(typeof evmap.sessionGate, 'function');
  // 全局挂载路径：模拟浏览器里没有 module 的情况
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'aiEventMap.js'), 'utf8');
  assert.ok(/root\.MioAiEventMap\s*=\s*api/.test(src), '未挂载全局 MioAiEventMap —— ai.js 会拿不到映射层');
  assert.ok(/module\.exports\s*=\s*api/.test(src), '未导出 module.exports —— node --test 无法 require');
});
