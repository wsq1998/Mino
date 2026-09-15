// Mio - main.js 主进程装配守卫（node:test，零第三方）
//
// 为什么需要这个文件
//   `node --check` 只查语法，**查不出未定义标识符**；而 main.js 太大、又只有一条
//   `app.whenReady()` 主链，任何一处抛错都会把它后面的启动步骤（多显示器钩子、剪贴板、
//   天气、磁盘采样、自检）整段跳过 —— 表现是「App 起来了但一半功能是哑的」。
//
//   这个坑是真机 GUI 启动时才暴露的，且非常容易再踩，因为它反直觉：
//   main.js **没有模块级的 log 函数**。`const log = …` 只存在于自检块内部（局部作用域），
//   从模块级写 `log(...)` 会 ReferenceError；更狠的是在 try/catch 的 catch 里写 `log(...)`，
//   异常会在 catch 中被二次抛出、逃逸出 whenReady() 的 promise，导致后续启动步骤全部静默丢失。
//
// 运行：npm test（= node --test test/*.test.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

/** 去掉注释（块注释 + 行注释），避免注释里的举例被当成真代码 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const code = stripComments(MAIN);

test('main.js 不存在模块级 log()：裸 log( 只允许出现在自检块内部', () => {
  // 自检块里 `const log = (s) => {...}` 是局部定义的，那是它唯一定义处
  const defIdx = code.search(/^[ \t]*const log = /m);
  assert.ok(defIdx > 0, 'main.js 里找不到 `const log = ` 的局部定义，守卫前提不成立');
  const defLine = code.slice(0, defIdx).split('\n').length;

  const bad = [];
  const re = /(?<![A-Za-z0-9_.$])log\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const line = code.slice(0, m.index).split('\n').length;
    // 允许：自检块内（定义之后）。禁止：定义之前（模块级拼错/臆造 logger）
    if (line < defLine) bad.push(`main.js:${line}`);
  }
  assert.deepEqual(bad, [],
    `在模块级引用了不存在的 log()（它只是自检块的局部函数，会 ReferenceError 并中断 whenReady 主链）：${bad.join(', ')}`);
});

test('AI 助手装配必须包在 try/catch 里，且兜底只能用 console', () => {
  const i = code.indexOf('installAi({');
  assert.ok(i > 0, 'main.js 没有调用 installAi —— AI 助手根本没被装配');
  const before = code.slice(Math.max(0, i - 400), i);
  assert.ok(/try\s*\{/.test(before), 'installAi 未包在 try 内：装配失败会直接中断 whenReady 主链');

  const after = code.slice(i, i + 1400);
  // catch 体内不得使用可能在 catch 中二次抛出的自定义 logger
  const catchBlock = after.slice(after.indexOf('catch'));
  assert.ok(/console\.(error|log)/.test(catchBlock), 'AI 装配的 catch 未使用 console 兜底（异常可能二次抛出并逃逸）');
  assert.ok(!/(?<![A-Za-z0-9_.$])(aiLog|log)\s*\(/.test(catchBlock.slice(catchBlock.indexOf('{'), catchBlock.indexOf('}') + 1)),
    'AI 装配的 catch 里用了 log/aiLog —— 一旦它自身抛错，异常会逃逸出 whenReady()，把后续启动步骤全部跳过');
});

test('AI 助手三处装配点齐备：require / installAi / bootstrap', () => {
  assert.ok(/require\(['"]\.\/main\/ai\/ipc\.js['"]\)/.test(code), '未 require main/ai/ipc.js');
  assert.ok(/ai\s*=\s*installAi\(/.test(code), '未调用 installAi 或未保存返回值 —— 就没法在设置变更/退出时回调它');
  assert.ok(/\.bootstrap\(\)/.test(code), '未调用 bootstrap()');
});

test('引擎回收必须覆盖「非正常退出」路径（否则 Ctrl-C / kill 会留孤儿 opencode 进程）', () => {
  // 回收逻辑归属子系统自身（main/ai/ipc.js），不依赖 main.js 记得调用 ——
  // 这里断言的是契约本身，不是某一个文件的写法。
  const ipc = fs.readFileSync(path.join(ROOT, 'main', 'ai', 'ipc.js'), 'utf8');
  for (const hook of ["on('before-quit'", "on('will-quit'", "on('exit'", "on('SIGINT'", "on('SIGTERM'"]) {
    assert.ok(ipc.includes(hook), `main/ai/ipc.js 未挂 ${hook} —— 该退出路径下引擎不会被回收`);
  }
  // 进程级钩子必须模块级只注册一次：否则反复 installAi 会堆出大量监听器
  assert.ok(/processExitGuardInstalled/.test(ipc), '进程级退出钩子没有「只注册一次」的保护');
});

test('window-all-closed / 关键启动步骤未被 AI 装配块挤掉（顺序回归）', () => {
  // AI 装配块插在 whenReady 里；这里锁定它之后仍存在「显示器变化重算」这类必须保留的启动步骤
  const i = code.indexOf('installAi({');
  const after = code.slice(i);
  assert.ok(/display-added/.test(after), 'installAi 之后的启动步骤丢失了（display-added 钩子）');
  assert.ok(/sampleDiskIO|scheduleWeather|stealthTick/.test(after), 'installAi 之后的启动步骤丢失（采样/天气/隐身）');
});
