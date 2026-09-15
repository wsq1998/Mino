// Mio - AI 助手：preload ↔ 主进程 IPC 契约守卫（node:test，零第三方）
//
// 为什么需要这个文件
//   `preload.js` 的 mio.ai 桥、`main/ai/ipc.js` 的通道注册、`renderer/ai.js` 的调用，
//   是同一条链上的三处**纯字符串**约定。任何一处写错一个字母，都不会有任何编译期/运行期报错：
//   渲染层只会拿到 undefined，表现是「点了没反应」—— 这类 bug 只能靠真机手点才能发现。
//   而离线集成测试只覆盖主进程侧（它直接调 handler），碰不到 preload 这层。
//   所以在这里用静态交叉比对把三处对齐，一次成本换永久守卫。
//
// 覆盖三向闭合：
//   ① 桥里出现的每个 ai-* 通道，主进程必须真的注册过（否则调用石沉大海）
//   ② 主进程注册的每个 ai-* 通道，桥里必须有对应出口（否则是无人可达的死通道）
//   ③ ai.js 里调用的每个 api.xxx，桥里必须存在同名方法
//
// 运行：npm test（= node --test test/*.test.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const IPC = fs.readFileSync(path.join(ROOT, 'main', 'ai', 'ipc.js'), 'utf8');
const AI_JS = fs.readFileSync(path.join(ROOT, 'renderer', 'ai.js'), 'utf8');

/** 去掉注释，避免注释里的举例被当成真代码 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 抓 preload 里 mio.ai 桥用到的通道：ipcRenderer.invoke/send/on('ai-…') */
function bridgeChannels(src) {
  const out = new Map(); // channel → Set(kind)
  const re = /ipcRenderer\.(invoke|send|on)\(\s*'(ai-[^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const [, kind, ch] = m;
    if (!out.has(ch)) out.set(ch, new Set());
    out.get(ch).add(kind);
  }
  return out;
}

/** 抓主进程侧的通道用途：'handle'（invoke）/ 'onCh'（send）/ 'push'（主进程推给渲染层） */
function mainChannels(src) {
  const out = new Map(); // channel → Set(kind)
  const add = (ch, kind) => {
    if (!out.has(ch)) out.set(ch, new Set());
    out.get(ch).add(kind);
  };
  // 主进程侧的注册辅助函数名固定为 handle / onCh（见 ipc.js 顶部）
  const reg = /\b(handle|onCh)\(\s*'(ai-[^']+)'/g;
  let m;
  while ((m = reg.exec(src))) add(m[2], m[1]);
  // 主进程主动推给渲染层的
  const push = /\bsend\(\s*'(ai-[^']+)'/g;
  while ((m = push.exec(src))) add(m[1], 'push');
  return out;
}

/** 抓 ai.js 里实际调用的桥方法名 */
function aiJsApiCalls(src) {
  const out = new Set();
  const re = /\bapi\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

/** 抓 preload mio.ai 对象里导出的方法名（只扫 ai 块，避免把 v2 的方法算进来） */
function bridgeMethods(src) {
  const start = src.indexOf('ai: {');
  assert.ok(start >= 0, 'preload.js 里找不到 mio.ai 桥（ai: { … }）');
  // 从 ai: { 开始做花括号配对，取出整个 ai 块
  let i = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) { end = j; break; }
    }
  }
  assert.ok(end > i, 'preload.js 的 mio.ai 桥括号不配对');
  const body = src.slice(i + 1, end);
  const out = new Set();
  const re = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm;
  let m;
  while ((m = re.exec(body))) out.add(m[1]);
  return out;
}

const bridge = bridgeChannels(stripComments(PRELOAD));
const main = mainChannels(stripComments(IPC));
const mainKeys = new Set([...main.keys()]);
const bridgeKeys = new Set([...bridge.keys()]);
const apiCalls = aiJsApiCalls(stripComments(AI_JS));
const methods = bridgeMethods(stripComments(PRELOAD));

test('守卫前置：三份来源都真的解析出了东西（防止正则失效导致假绿）', () => {
  assert.ok(bridgeKeys.size >= 20, `preload 只解析出 ${bridgeKeys.size} 个通道，正则可能失效`);
  assert.ok(mainKeys.size >= 20, `ipc.js 只解析出 ${mainKeys.size} 个通道，正则可能失效`);
  assert.ok(methods.size >= 20, `preload 的 mio.ai 只解析出 ${methods.size} 个方法`);
  assert.ok(apiCalls.size >= 10, `ai.js 只解析出 ${apiCalls.size} 个 api.* 调用`);
});

test('① 桥里的每个通道，主进程都必须注册过（否则调用石沉大海）', () => {
  const missing = [...bridgeKeys].filter((ch) => !mainKeys.has(ch)).sort();
  assert.deepEqual(missing, [], `preload 用了主进程没注册的通道：${missing.join(', ')}`);
});

test('② 主进程注册的每个通道，桥里都必须有出口（否则是无人可达的死通道）', () => {
  const orphan = [...mainKeys].filter((ch) => !bridgeKeys.has(ch)).sort();
  assert.deepEqual(orphan, [], `主进程注册了但渲染层够不到的通道：${orphan.join(', ')}`);
});

test('③ ai.js 调用的每个桥方法，preload 的 mio.ai 里都必须存在（否则点了没反应）', () => {
  // boot() 里这俩是防御性探测（api.onMode && …），桥可以没有；其余必须是真方法
  const missing = [...apiCalls].filter((k) => !methods.has(k)).sort();
  assert.deepEqual(missing, [], `ai.js 调用了 mio.ai 上不存在的：${missing.join(', ')}`);
});

test('invoke/send/on 的语义必须逐个配对（写错方向的表现是「点了没反应」）', () => {
  // 对照表：主进程 handle ↔ 渲染层 invoke；主进程 onCh ↔ 渲染层 send；主进程 send ↔ 渲染层 on。
  // 同一个通道允许同时是 handle + push（即「可查询 + 会主动通知」），
  // 例如 ai-engine-status：渲染层既 invoke 一次拿当前状态，也 on 一个用于状态变化时的推送。
  // Electron 里 invoke 与 on 走的是两套内部消息，同名不冲突。
  const want = { handle: 'invoke', onCh: 'send', push: 'on' };
  const wrong = [];
  for (const [ch, kinds] of main) {
    const have = bridge.get(ch);
    if (!have) continue; // 缺失由 ①② 两条用例负责报
    for (const kind of kinds) {
      const need = want[kind];
      if (!have.has(need)) {
        wrong.push(`${ch}：主进程是 ${kind}（对应渲染层 ${need}），但桥用的是 ${[...have].join('/')}`);
      }
    }
  }
  assert.deepEqual(wrong, [], wrong.join(' | '));
});

test('主进程推给渲染层的事件，桥必须用 on 订阅', () => {
  // ipc.js 的 send('ai-window-mode' | 'ai-run' | 'ai-event') 是对渲染层的推送
  for (const ch of ['ai-window-mode', 'ai-run', 'ai-event']) {
    assert.ok(bridge.has(ch), `桥未订阅主进程推送的 ${ch}`);
    assert.ok(bridge.get(ch).has('on'), `${ch} 应该用 ipcRenderer.on 订阅`);
  }
});

test('安全铁律：桥里不得出现任何可能携带引擎凭据的通道命名', () => {
  // docs/16 §7.3 —— 端口/密码永不进渲染层。这里做命名层守卫，
  // 载荷层的守卫在 test/aiIpc.test.js（对推送载荷做 stringify 断言不含密码）。
  for (const ch of bridgeKeys) {
    assert.ok(!/password|secret|token|credential/i.test(ch), `通道名疑似暴露凭据：${ch}`);
  }
});
