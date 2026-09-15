// Mio - AI 助手窗口资源与样式守卫（node:test，零第三方）
// 作用：把「打包后白屏」「鼠标穿透导致拖入失效」「另造色值」「输入框无限高」这几类
//       只在真机上才暴露、代价却很高的坑，全部拦在单测层。
// 运行：npm test（= node --test test/*.test.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const AI_CSS = path.join(ROOT, 'renderer', 'ai.css');
const AI_HTML = path.join(ROOT, 'renderer', 'ai.html');
const THEME_CSS = path.join(ROOT, 'renderer', 'theme.css');
const PACK_SH = path.join(ROOT, 'pack.sh');

const rawCss = fs.readFileSync(AI_CSS, 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, ''); // 注释里的散文不算声明
const html = fs.readFileSync(AI_HTML, 'utf8');
const themeCss = fs.readFileSync(THEME_CSS, 'utf8');
const packSh = fs.readFileSync(PACK_SH, 'utf8');

/** 极简规则切分：selector { body } */
function rules(source) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}
const allRules = rules(css);

// ============ 打包注入（防白屏） ============

test('pack.sh 必须注入 renderer/ai.{html,js,EventMap.js,css}（否则打包后助手窗口白屏）', () => {
  // 防回归：与 v2.1 中转站浮窗踩过的是同一个坑 —— 源码跑得好好的，打包后一片空白
  for (const f of ['renderer/ai.html', 'renderer/ai.js', 'renderer/aiEventMap.js', 'renderer/ai.css']) {
    assert.ok(packSh.includes(f), `pack.sh 未注入 ${f} —— 打包后助手窗口会白屏`);
  }
});

test('ai.html 必须加载 ai.css 与 ai.js，且带 CSP（禁止渲染层直接联网）', () => {
  assert.ok(/<link[^>]+href="ai\.css"/.test(html), '未引入 ai.css');
  assert.ok(/<script[^>]+src="ai\.js"/.test(html), '未引入 ai.js');
  // ai.js 依赖 MioAiEventMap；漏引入会在运行时才炸（TypeError），必须在此拦住
  assert.ok(/<script[^>]+src="aiEventMap\.js"/.test(html), '未引入 aiEventMap.js（ai.js 的事件映射依赖它）');
  const mapIdx = html.indexOf('aiEventMap.js');
  const jsIdx = html.indexOf('src="ai.js"');
  assert.ok(mapIdx >= 0 && jsIdx >= 0 && mapIdx < jsIdx, 'aiEventMap.js 必须排在 ai.js 之前加载');
  assert.ok(/<link[^>]+href="theme\.css"/.test(html), '未引入 theme.css（会丢 --mi-* 令牌）');
  assert.ok(/Content-Security-Policy/.test(html), 'ai.html 缺少 CSP：渲染层可能直连引擎端口');
  assert.ok(/connect-src\s+'none'/.test(html), "CSP 应把 connect-src 设为 'none'（渲染层不得直接 fetch 引擎）");
});

test('ai.html 的脚本内联量为零：逻辑必须放在 ai.js（CSP script-src \'self\'）', () => {
  // 防回归：一旦有人塞内联 <script>，CSP 会直接把它拦掉，表现为「界面能看但完全没反应」
  const inline = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi.test(html);
  assert.equal(inline, false, 'ai.html 出现了内联脚本，会被 CSP 拦截');
});

// ============ 输入框高度（「空药丸」故障的回归守卫） ============

test('ai.css：输入框必须有 1 行下限高度（防「空药丸」——胶囊态量到 scrollHeight=0 被钉死）', () => {
  // 曾经的真实故障：boot() 在胶囊态（shell display:none）里调 autoGrow()，
  // scrollHeight 得 0 → 内联 height:0px 钉死 → 切到输入条态是一个没有 placeholder 的空药丸。
  // JS 侧已加下限；这里再锁 CSS 兜底，两条都要在。
  const block = css.match(/\.ai-input\s*\{[^}]*\}/);
  assert.ok(block, '找不到 .ai-input 规则');
  const m = block[0].match(/min-height\s*:\s*([0-9.]+)px/);
  assert.ok(m, '.ai-input 未声明 min-height —— 输入框会在胶囊态被钉成 0 高');
  assert.ok(Number(m[1]) >= 20, `min-height 只有 ${m[1]}px，不足 1 行（20px）`);
  // 上限仍须保留（1~5 行）
  assert.ok(/max-height\s*:\s*100px/.test(block[0]), '.ai-input 丢了 max-height:100px（1~5 行上限）');
});

// ============ 鼠标可达性（拖入的命门） ============

test('ai.css：根与胶囊绝不开鼠标穿透（否则拖文件进来直接失效）', () => {
  // 防回归：与中转站同一条铁律 —— setIgnoreMouseEvents / pointer-events:none 会让 OS 拖放投递不到
  const bad = allRules.filter((r) => /pointer-events\s*:\s*none/i.test(r.body)
    && (r.selector.includes('#aiRoot') || r.selector.includes('.ai-capsule')));
  assert.equal(bad.length, 0, `根或胶囊被设为不可交互：${bad.map((r) => r.selector).join(' | ')}`);
});

test('ai.css：不出现 -webkit-user-drag: auto', () => {
  const hit = allRules.filter((r) => /-\s*webkit-user-drag\s*:\s*auto\b/i.test(r.body));
  assert.equal(hit.length, 0, `发现 -webkit-user-drag: auto（会杀死拖拽）：${hit.map((r) => r.selector).join(' | ')}`);
});

// ============ 三态 ============

test('ai.css：胶囊态隐藏 shell、输入条态只留输入行（三态必须互斥）', () => {
  const hidesShell = allRules.some((r) => r.selector.includes('.ai--capsule')
    && r.selector.includes('.ai-shell') && /display\s*:\s*none/.test(r.body));
  assert.ok(hidesShell, '胶囊态未隐藏 .ai-shell —— 会出现细条与大面板同时可见');

  const showsCapsule = allRules.some((r) => r.selector.includes('.ai--capsule')
    && r.selector.includes('.ai-capsule') && /display\s*:\s*flex/.test(r.body));
  assert.ok(showsCapsule, '胶囊态未显示 .ai-capsule');

  // 输入条态：头部与执行流都要收掉，只剩输入行（高度才可能压到 64px）
  for (const target of ['.ai-head', '.ai-stream']) {
    const hidden = allRules.some((r) => /\.ai--bar/.test(r.selector) && r.selector.includes(target) && /display\s*:\s*none/.test(r.body));
    assert.ok(hidden, `输入条态未隐藏 ${target} —— 输入条态的高度会失控`);
  }
});

test('ai.css：四个运行态都有对应规则（状态点语义不能缺档）', () => {
  for (const run of ['idle', 'running', 'waiting', 'error']) {
    const hit = allRules.some((r) => r.selector.includes(`data-run="${run}"`));
    assert.ok(hit, `缺少 [data-run="${run}"] 的状态点样式`);
  }
});

test('ai.css：待确认态用危险色（常亮红），出错态用警示色', () => {
  // 防回归：「有权限卡等你」是唯一必须抢注意力的状态，颜色不能被改成普通蓝
  const waiting = allRules.filter((r) => r.selector.includes('data-run="waiting"') && r.body.includes('--mi-danger'));
  assert.ok(waiting.length > 0, 'waiting 态未使用 --mi-danger');
  const err = allRules.filter((r) => r.selector.includes('data-run="error"') && r.body.includes('--mi-warn'));
  assert.ok(err.length > 0, 'error 态未使用 --mi-warn');
});

// ============ 色值与令牌纪律 ============

test('ai.css：禁止另造 --mi-* 令牌（只能引用 theme.css 里的）', () => {
  // 防回归：与中转站同一条纪律 —— 色值唯一来源是 theme.css
  const defined = new Set((themeCss.match(/--mi-[a-z0-9-]+/g) || []));
  const mine = new Set((css.match(/--mi-[a-z0-9-]+\s*:/g) || []).map((s) => s.replace(/\s*:$/, '')));
  const invented = [...mine].filter((v) => !defined.has(v));
  assert.deepEqual(invented, [], `ai.css 自定义了 theme.css 里不存在的 --mi-* 令牌：${invented.join(', ')}`);
});

test('ai.css：引用的每个 --mi-* 都真实存在于 theme.css（防拼错导致色值静默失效）', () => {
  // 防回归：var(--mi-accent3) 这类拼写错误不会报错，只会静默变黑/变透明
  const defined = new Set((themeCss.match(/--mi-[a-z0-9-]+/g) || []));
  const used = new Set((css.match(/var\(--mi-[a-z0-9-]+/g) || []).map((s) => s.replace('var(', '')));
  const missing = [...used].filter((v) => !defined.has(v));
  assert.deepEqual(missing, [], `引用了 theme.css 未定义的令牌：${missing.join(', ')}`);
});

// ============ 输入框与动效 ============

test('ai.css：输入框有高度上限（1~5 行），不会无限撑高窗口', () => {
  const inputRule = allRules.filter((r) => /\.ai-input\b/.test(r.selector));
  assert.ok(inputRule.length > 0, '找不到 .ai-input 规则');
  const hasMax = inputRule.some((r) => /max-height\s*:/.test(r.body));
  assert.ok(hasMax, '.ai-input 缺少 max-height —— 长指令会把窗口撑爆');
  const hasResizeNone = inputRule.some((r) => /resize\s*:\s*none/.test(r.body));
  assert.ok(hasResizeNone, '.ai-input 必须 resize: none（窗口尺寸由主进程管）');
});

test('ai.css：存在减弱动效开关（沿用中转站同款做法）', () => {
  const hit = allRules.some((r) => r.selector.includes('.ai--reduce-motion') && /animation\s*:\s*none/.test(r.body));
  assert.ok(hit, '缺少 .ai--reduce-motion 规则');
});

test('ai.css：执行流区域可选中文本（工具输出要能复制）', () => {
  // 防回归：全局 user-select:none 会让「复制 Agent 给出的答案」变成不可能
  const hit = allRules.some((r) => /\.ai-stream\b/.test(r.selector) && /user-select\s*:\s*text/.test(r.body));
  assert.ok(hit, '.ai-stream 未开启 user-select: text');
});
