// Mio - v2.6.1 中转站拖出规则回归守卫（node:test，零第三方）
// 作用：锁死「卡片必须 -webkit-user-drag: element」这条经最小 Electron 探针实证的拖出铁律，
//       防止有人把 element 改回 auto（dragstart 永不触发、拖出彻底失效）或误改 none 的作用域。
// 运行：npm test（= node --test test/*.test.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '..', 'renderer', 'stash.css');
const rawCss = fs.readFileSync(CSS_PATH, 'utf8');

// 去掉 /* */ 注释，只对「真正的声明」做断言（注释里的散文提到 auto 不算数）
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

// 极简 CSS 规则切分：selector { 声明体 } —— 足够覆盖本文件的扁平规则
function rules(source) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

const allRules = rules(css);

// v2.6.1 回归守卫：实证证明 -webkit-user-drag: auto 会覆盖 draggable="true"，导致 dragstart 不触发
test('stash.css 拖出规则：绝不出现 -webkit-user-drag: auto', () => {
  const hit = allRules.filter((r) => /-\s*webkit-user-drag\s*:\s*auto\b/i.test(r.body));
  assert.equal(hit.length, 0, `发现 -webkit-user-drag: auto（会杀死拖出）：${hit.map((r) => r.selector).join(' | ')}`);
});

test('stash.css 拖出规则：卡片选择器 #stRoot .st-item 必须为 -webkit-user-drag: element', () => {
  const cardRules = allRules.filter((r) => r.body.includes('-webkit-user-drag')
    && /-\s*webkit-user-drag\s*:\s*element\b/i.test(r.body));
  assert.ok(cardRules.length > 0, '没有任何规则给 -webkit-user-drag: element —— 拖出必然失效');
  const coversCard = cardRules.some((r) => r.selector.includes('#stRoot .st-item'));
  assert.ok(coversCard, `-webkit-user-drag: element 未覆盖 #stRoot .st-item，实际选择器：${cardRules.map((r) => r.selector).join(' | ')}`);
});

test('stash.css 拖出规则：-webkit-user-drag: none 只允许作用于 .st-item-acts', () => {
  const noneRules = allRules.filter((r) => /-\s*webkit-user-drag\s*:\s*none\b/i.test(r.body));
  for (const r of noneRules) {
    assert.ok(r.selector.includes('.st-item-acts'), `-webkit-user-drag: none 越界到非按钮区：${r.selector}`);
  }
});

// ============ v2.8 浮窗弹出/收起动画守卫 ============

test('stash.css 动画：存在 stDrawerOut 收起动画', () => {
  assert.ok(/@keyframes\s+stDrawerOut\b/.test(css), '缺少 @keyframes stDrawerOut —— 收起动画未定义');
});

test('stash.css 动画：存在 .st--closing .st-panel 收起规则', () => {
  const closingRules = allRules.filter((r) => r.selector.includes('.st--closing'));
  assert.ok(closingRules.length > 0, '没有任何 .st--closing 规则 —— 收起动画无法触发');
  const panelRule = closingRules.find((r) => r.selector.includes('.st-panel'));
  assert.ok(panelRule, `.st--closing 规则未覆盖 .st-panel，实际：${closingRules.map((r) => r.selector).join(' | ')}`);
  assert.ok(panelRule.body.includes('stDrawerOut'), '.st--closing .st-panel 未引用 stDrawerOut');
});

test('stash.css 动画：stDrawerIn 的 from 帧包含 filter: blur(（材质跟随）', () => {
  // 注意：非贪婪 + \n} 才能跨过 from/to 两个帧块取到整个 @keyframes 体（否则停在第一个 }）
  const m = /@keyframes\s+stDrawerIn\b\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(m, '找不到 @keyframes stDrawerIn');
  const fromBody = /from\s*\{([\s\S]*?)\}/.exec(m[1]) || /0%\s*\{([\s\S]*?)\}/.exec(m[1]);
  assert.ok(fromBody, 'stDrawerIn 缺少 from/0% 帧');
  assert.match(fromBody[1], /filter\s*:\s*blur\(/, 'stDrawerIn 的 from 帧缺少 filter: blur( —— 玻璃材质未跟随动画');
});

test('stash.css 动画: stDrawerInH 的 from 帧包含 blur(（材质跟随）', () => {
  const m = /@keyframes\s+stDrawerInH\b\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(m, '缺少 @keyframes stDrawerInH');
  const from = /from\s*\{([\s\S]*?)\}/.exec(m[1]) || [];
  assert.ok(from, 'stDrawerInH 缺少 from 帧');
  assert.match(from[1], /blur\(/, 'stDrawerInH 的 from 帧缺少 blur( —— 水平抽屉未做材质跟随');
});

test('stash.css 动画：打开动画时长 0.26s', () => {
  const openRules = allRules.filter((r) => r.selector.includes('.st--open') && r.body.includes('animation:'));
  assert.ok(openRules.length > 0, '未找到 .st--open 打开动画规则');
  for (const r of openRules) {
    assert.ok(r.body.includes('0.26s'), `打开动画时长不是 0.26s：${r.selector} → ${r.body.trim()}`);
  }
});

test('stash.css 动画：.st--closing 特异性覆盖成立（须在 .st--open 之后声明）', () => {
  const openIdx = allRules.findIndex((r) => r.selector.includes('.st--open') && r.body.includes('animation:'));
  const closeIdx = allRules.findIndex((r) => r.selector.includes('.st--closing') && r.body.includes('animation:'));
  assert.ok(openIdx >= 0, '未找到 .st--open 打开动画规则');
  assert.ok(closeIdx >= 0, '未找到 .st--closing 收起动画规则');
  assert.ok(closeIdx > openIdx, `.st--closing(${closeIdx}) 必须声明在 .st--open(${openIdx}) 之后，否则同特异性无法覆盖`);
});

// ============ v2.9 抽屉列表布局守卫（单列平铺 / 2行无滚动 / 展开3行可滚动）============

const HTML_PATH = path.join(__dirname, '..', 'renderer', 'stash.html');
const rawHtml = fs.readFileSync(HTML_PATH, 'utf8');

test('stash.css v2.13：.st-list（抽屉态）默认 overflow-y auto + max-height none —— 填满面板、不留下方空白', () => {
  // v2.13 需求：左/右抽屉下方不能留大片空白。抽屉面板本身很高，列表应 flex:1 填满到页脚，
  //   max-height: none + overflow-y: auto 让全部内容在区域内滚动查看。
  const drawerListRules = allRules.filter((r) => r.selector.includes('.st-list'));
  const scoped = drawerListRules.filter((r) => /\.st--(left|right)\s+\.st-list/.test(r.selector));
  assert.ok(scoped.length > 0, '缺少 .st--left/.st--right .st-list 抽屉态规则');
  for (const r of scoped) {
    assert.match(r.body, /overflow-y\s*:\s*auto/, `${r.selector} 默认必须是 overflow-y: auto（内容超出可直接滚动）`);
    assert.match(r.body, /max-height\s*:\s*none/, `${r.selector} 必须 max-height: none（填满面板高度，不留下方空白）`);
  }
});

test('stash.css v2.9：存在 .st--expanded 规则，且展开后 overflow-y: auto（可滚动）', () => {
  const expandedRules = allRules.filter((r) => r.selector.includes('.st--expanded') && r.selector.includes('.st-list'));
  assert.ok(expandedRules.length > 0, '缺少 .st--expanded .st-list 规则');
  for (const r of expandedRules) {
    assert.match(r.body, /overflow-y\s*:\s*auto/, `${r.selector} 展开后必须是 overflow-y: auto（出现滚动条）`);
  }
});

test('stash.css v2.9：抽屉态 .st-group-items 不是 2 列 grid（改为单列平铺）', () => {
  // 全局 .st-group-items 仍保留 2 列 grid（货架态/兜底可能用到），但抽屉态必须覆盖为单列 flex
  const drawerGroupRules = allRules.filter((r) => /\.st--(left|right)\s+\.st-group-items/.test(r.selector));
  assert.ok(drawerGroupRules.length > 0, '缺少 .st--left/.st--right .st-group-items 单列规则');
  for (const r of drawerGroupRules) {
    assert.ok(!/grid-template-columns/.test(r.body), `${r.selector} 不得是 grid 网格（应为单列 flex）`);
    assert.match(r.body, /flex-direction\s*:\s*column/, `${r.selector} 必须是 flex-direction: column（单列平铺）`);
  }
});

test('stash.css v2.12：货架态（.st--top/.st--bottom）默认 overflow-y auto + max-height none（默认即可滚动）', () => {
  // v2.12 需求：默认 2 行内直接上下滚动查看其余文件，无需点「展开」。故货架态 .st-list 必须 overflow-y: auto。
  // 面板高度已由主进程按行数 setBounds（2行=144/3行=204），列表 flex:1 填满面板，靠 overflow-y: auto 滚动。
  const shelfListRules = allRules.filter((r) => /\.st--(top|bottom)(\.st--expanded)?\s+\.st-list/.test(r.selector));
  assert.ok(shelfListRules.length > 0, '缺少 .st--top/.st--bottom .st-list 货架规则');
  const collapsed = shelfListRules.find((r) => !r.selector.includes('.st--expanded'));
  assert.ok(collapsed, '缺少货架默认（未展开）列表规则');
  assert.match(collapsed.body, /overflow-y\s*:\s*auto/, `${collapsed.selector} 默认必须 overflow-y: auto（可直接滚动）`);
  assert.match(collapsed.body, /max-height\s*:\s*none/, `${collapsed.selector} 默认必须 max-height: none（高度交给面板，不独立限高）`);
});

test('stash.css v2.12：货架态展开后 overflow-y auto + max-height none（3行可滚动）', () => {
  const shelfListRules = allRules.filter((r) => /\.st--(top|bottom)(\.st--expanded)?\s+\.st-list/.test(r.selector));
  const expanded = shelfListRules.filter((r) => r.selector.includes('.st--expanded'));
  assert.ok(expanded.length > 0, '缺少 .st--top.st--expanded/.st--bottom.st--expanded .st-list 展开规则');
  for (const r of expanded) {
    assert.match(r.body, /overflow-y\s*:\s*auto/, `${r.selector} 展开后必须 overflow-y: auto（可滚动）`);
    assert.match(r.body, /max-height\s*:\s*none/, `${r.selector} 展开后必须 max-height: none（高度交给面板高度）`);
  }
});

test('stash.css v2.12：抽屉态（.st--left/.st--right）默认也 overflow-y auto（默认可滚动）', () => {
  const drawerListRules = allRules.filter((r) => /\.st--(left|right)\s+\.st-list/.test(r.selector));
  assert.ok(drawerListRules.length > 0, '缺少 .st--left/.st--right .st-list 抽屉规则');
  const collapsed = drawerListRules.find((r) => !r.selector.includes('.st--expanded'));
  assert.ok(collapsed, '缺少抽屉默认列表规则');
  assert.match(collapsed.body, /overflow-y\s*:\s*auto/, `${collapsed.selector} 默认必须 overflow-y: auto（默认可滚动）`);
});

test('stash.css v2.12：货架态隐藏页脚 .st-foot（避免横向挤占列表宽度）', () => {
  // 货架态是横向布局，.st-foot 若保留会成为横向 flex 子项占据近半宽、把列表挤到 254px 制造大片空白。
  const shelfFootRules = allRules.filter((r) => /\.st--(top|bottom)\s+\.st-foot/.test(r.selector));
  assert.ok(shelfFootRules.length > 0, '缺少 .st--top/.st--bottom .st-foot 隐藏规则');
  for (const r of shelfFootRules) {
    assert.match(r.body, /display\s*:\s*none/, `${r.selector} 货架态必须 display: none（隐藏页脚，列表撑满宽度）`);
  }
});

test('stash.css v2.12：货架态 .st-list 横向并排分组（flex-direction: row + wrap）', () => {
  // 多个类型分组（如图片/文档）横向并排铺满宽度，避免纵向堆叠、后一组被挤到滚动区外。
  const shelfListRules = allRules.filter((r) => /\.st--(top|bottom)\s+\.st-list/.test(r.selector));
  assert.ok(shelfListRules.length > 0, '缺少 .st--top/.st--bottom .st-list 货架规则');
  const target = shelfListRules.find((r) => /flex-direction\s*:\s*row/.test(r.body));
  assert.ok(target, '货架 .st-list 未横向排列（flex-direction: row）——分组无法并排');
  assert.match(target.body, /flex-wrap\s*:\s*wrap/, '货架 .st-list 需 flex-wrap: wrap（超宽自动换行）');
});

test('stash.css v2.12：货架态 .st-group 并排占宽（flex: 1 1 40%，均衡铺满）', () => {
  // 注意：.st-group 选择器要排除 .st-group-items（用 , 或 { 结尾区分）
  const shelfGroupRules = allRules.filter((r) => /\.st--(top|bottom)\s+\.st-group(?:\s*,|\s*\{)/.test(r.selector));
  assert.ok(shelfGroupRules.length > 0, '缺少 .st--top/.st--bottom .st-group 货架规则');
  for (const r of shelfGroupRules) {
    assert.match(r.body, /flex\s*:\s*1\s+1\s+40%/, `${r.selector} 必须 flex: 1 1 40%（两分组各占约半宽并排）`);
  }
});

test('stash.css v2.10：货架态 .st-group-items 单列平铺（flex-direction: column）', () => {
  const shelfGroupRules = allRules.filter((r) => /\.st--(top|bottom)\s+\.st-group-items/.test(r.selector));
  assert.ok(shelfGroupRules.length > 0, '缺少 .st--top/.st--bottom .st-group-items 货架规则');
  for (const r of shelfGroupRules) {
    assert.ok(!/grid-template-columns/.test(r.body), `${r.selector} 不得是 grid 网格（应为单列 flex）`);
    assert.match(r.body, /flex-direction\s*:\s*column/, `${r.selector} 必须是 flex-direction: column（单列平铺）`);
  }
});

test('stash.css v2.11.1：货架态 .st-item 按内容高度排列（flex: 0 0 auto，不拉伸）', () => {
  // v2.11.1 修复：.st-item 必须 flex: 0 0 auto（按内容高度排列），
  // 不能 flex: 1 1 auto —— 否则条目在 flex column 容器里被拉伸填满，条目间出现大空白、列表显得"空"。
  const shelfItemRules = allRules.filter((r) => /\.st--(top|bottom)\s+\.st-item/.test(r.selector));
  assert.ok(shelfItemRules.length > 0, '缺少 .st--top/.st--bottom .st-item 货架规则');
  for (const r of shelfItemRules) {
    assert.match(r.body, /flex\s*:\s*0\s+0\s+auto/, `${r.selector} 必须 flex: 0 0 auto（按内容高度排列，避免拉伸空白）`);
  }
});

test('stash.html v2.9：存在展开按钮 #stExpandBtn', () => {
  assert.match(rawHtml, /id=["']stExpandBtn["']/, 'stash.html 缺少 id="stExpandBtn" 展开按钮');
});

// ============ v2.14 一键清空中转站守卫 ============

test('stash.html v2.14：存在清空按钮 #stClearBtn（一键清空中转站）', () => {
  assert.match(rawHtml, /id=["']stClearBtn["']/, 'stash.html 缺少 id="stClearBtn" 清空按钮');
});

test('stash.html v2.14：#stClearBtn 默认 hidden（无条目时隐藏，避免空态误触）', () => {
  const btnRe = /<button[^>]*id=["']stClearBtn["'][^>]*>/;
  const m = btnRe.exec(rawHtml);
  assert.ok(m, '找不到 #stClearBtn 按钮标签');
  assert.match(m[0], /hidden/, '#stClearBtn 必须带 hidden 属性（默认隐藏，有条目时由 stash.js 显示）');
});

test('stash.css v2.14：清空按钮有危险色 hover 态（.st-ic--clear:hover 用 --mi-danger）', () => {
  const clearRules = allRules.filter((r) => r.selector.includes('.st-ic--clear'));
  assert.ok(clearRules.length > 0, '缺少 .st-ic--clear 清空按钮规则');
  const hover = clearRules.find((r) => r.selector.includes(':hover'));
  assert.ok(hover, '缺少 .st-ic--clear:hover 悬停态');
  assert.match(hover.body, /--mi-danger/, '.st-ic--clear:hover 必须用危险色 --mi-danger（警示不可逆操作）');
});

test('stash.css v2.14：清空按钮有待确认 armed 态（.st-ic--clear.armed 引用 --mi-danger）', () => {
  const armedRules = allRules.filter((r) => r.selector.includes('.st-ic--clear.armed'));
  assert.ok(armedRules.length > 0, '缺少 .st-ic--clear.armed 待确认态规则');
  for (const r of armedRules) {
    assert.match(r.body, /var\(--mi-danger\)/, `${r.selector} 必须引用 --mi-danger（armed 态高亮警示）`);
  }
});
