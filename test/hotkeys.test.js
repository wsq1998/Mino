// Mio - 全局热键注册表单元测试（node:test，零第三方）
// 覆盖：自有键两两互斥、normalize 的修饰键排序/大小写归一、ownerOf 归属识别、
//       validate 的冲突/放行/非法输入、以及「无任何保留组合与自有键撞车」。
// 运行：npm test（= node --test test/*.test.js）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const hk = require('../main/core/hotkeys.js');

// 4 个 Mio 自有热键的 owner key（与 main/core/hotkeys.js 的 HOTKEYS 对应）
const OWNER_KEYS = ['mainWindow', 'reserved', 'stash', 'ai'];

// ===== 常量表结构 =====
test('HOTKEYS：包含 4 个自有 owner 且值均为非空字符串', () => {
  for (const owner of OWNER_KEYS) {
    assert.equal(typeof hk.HOTKEYS[owner], 'string', `缺少 owner ${owner}`);
    assert.ok(hk.HOTKEYS[owner].length > 0, `owner ${owner} 的键为空`);
  }
  // 与运行时现状保持一致（防止有人改注册表却没同步 main.js 的接线）
  assert.equal(hk.HOTKEYS.mainWindow, 'Alt+Space');
  assert.equal(hk.HOTKEYS.reserved, 'Alt+H');
  assert.equal(hk.HOTKEYS.stash, 'Alt+Shift+Space');
});

// ===== ① 4 个自有键两两不冲突 =====
test('4 个自有热键两两不冲突（normalize 后互不相同）', () => {
  // 防回归：任何两个 owner 的键被写成同一个（normalize 后相等），都必须在这里暴露
  const normed = OWNER_KEYS.map((o) => hk.normalize(hk.HOTKEYS[o]));
  for (let i = 0; i < normed.length; i++) {
    for (let j = i + 1; j < normed.length; j++) {
      assert.notEqual(
        normed[i], normed[j],
        `${OWNER_KEYS[i]}(${hk.HOTKEYS[OWNER_KEYS[i]]}) 与 ${OWNER_KEYS[j]}(${hk.HOTKEYS[OWNER_KEYS[j]]}) 冲突`,
      );
    }
  }
});

// ===== ② normalize 修饰键顺序 / 大小写归一 =====
test('normalize：修饰键顺序无关（Shift+Alt+Space === Alt+Shift+Space）', () => {
  // 防回归：Electron accelerator 修饰键顺序无意义，两者是同一个键
  assert.equal(hk.normalize('Shift+Alt+Space'), hk.normalize('Alt+Shift+Space'));
  assert.equal(hk.normalize('Shift+Alt+Space'), 'Alt+Shift+Space');
});

test('normalize：大小写与别名归一、去空格', () => {
  // 防回归：用户/文档可能写 alt / OPTION / cmd，须与规范串判等
  assert.equal(hk.normalize('alt+space'), 'Alt+Space');
  assert.equal(hk.normalize('  alt  +  space  '), 'Alt+Space');
  assert.equal(hk.normalize('OPTION+A'), 'Alt+A');
  assert.equal(hk.normalize('cmd+space'), 'Cmd+Space');
  assert.equal(hk.normalize('command+h'), 'Cmd+H');
  assert.equal(hk.normalize('ctrl+space'), 'Ctrl+Space');
  assert.equal(hk.normalize('f1'), ''); // 无修饰键 → 非法（至少一个修饰键 + 一个主键）
  assert.equal(hk.normalize('Cmd+Shift+3'), 'Cmd+Shift+3'); // 功能/数字键保留
});

test('normalize：非法输入返回空串', () => {
  // 防回归：null / undefined / 非字符串 / 空 / 缺主键 / 未知修饰键
  for (const bad of [null, undefined, '', '   ', 123, {}, [], 'Space', 'Alt', 'Alt+', '+Space', 'Foo+Space', 'Alt+@@@']) {
    assert.equal(hk.normalize(bad), '', `应判为非法：${JSON.stringify(bad)}`);
  }
});

// ===== ③ ownerOf 归属识别 =====
test('ownerOf：正确识别各 owner 且未知键返回 null', () => {
  // 防回归：归属查询必须对等值（含顺序/大小写变体）成立
  assert.equal(hk.ownerOf('Alt+Space'), 'mainWindow');
  assert.equal(hk.ownerOf('alt+space'), 'mainWindow');       // 大小写变体
  assert.equal(hk.ownerOf('Alt+H'), 'reserved');
  assert.equal(hk.ownerOf('Alt+Shift+Space'), 'stash');
  assert.equal(hk.ownerOf('Shift+Alt+Space'), 'stash');      // 顺序变体 → 同一 owner
  assert.equal(hk.ownerOf(hk.HOTKEYS.ai), 'ai');
  // 未占用 / 非法 → null
  assert.equal(hk.ownerOf('Alt+Z'), null);
  assert.equal(hk.ownerOf(''), null);
  assert.equal(hk.ownerOf(null), null);
  assert.equal(hk.ownerOf('Cmd+Space'), null); // 系统保留 ≠ Mio 自有 owner
});

// ===== ④ validate 冲突 / 放行 / 非法 =====
test('validate：拒绝对其他 owner 的重复占用（硬冲突，不可覆盖）', () => {
  // 防回归：AI 助手想抢主窗口的 Alt+Space 必须被硬拒
  const r = hk.validate('Alt+Space', 'ai');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'conflict');
  assert.equal(r.severity, 'block');
  assert.equal(r.conflictWith, 'mainWindow');
  assert.equal(r.overridable, false);
  assert.ok(r.error && r.error.length > 0, '应给出可读错误文案');

  // 顺序 / 大小写变体同样应被拒（通过 normalize 判等）
  assert.equal(hk.validate('Shift+Alt+Space', 'mainWindow').conflictWith, 'stash');
  assert.equal(hk.validate('alt+h', 'stash').conflictWith, 'reserved');
});

test('validate：放行未占用键', () => {
  // 防回归：全新组合应可用
  const r = hk.validate('Alt+A', 'ai');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'ok');
  assert.equal(r.severity, 'none');
  assert.equal(hk.validate('Ctrl+Alt+Y', 'ai').ok, true);
});

test('validate：自身重复注册不算冲突', () => {
  // 防回归：重置主窗口键为当前值时不应被自己是 mainWindow 而误拒
  const r = hk.validate('Alt+Space', 'mainWindow');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'ok');
});

test('validate：空 / 非法输入被拒（invalid）', () => {
  // 防回归：空串、缺主键等必须短路为 invalid，而不是被当成合法新键放行
  for (const bad of ['', '   ', null, undefined, 'Alt', 'Alt+', 'Foo+Space']) {
    const r = hk.validate(bad, 'ai');
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(bad)}`);
    assert.equal(r.kind, 'invalid');
    assert.equal(r.severity, 'block');
  }
});

test('validate：命中 macOS 保留组合 → 标记为 reserved（可覆盖的系统建议）', () => {
  // 防回归：Cmd+Space 等系统键应被识别为「系统保留建议」而非普通放行
  const r = hk.validate('Cmd+Space', 'ai');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'reserved');
  assert.equal(r.severity, 'warn');
  assert.equal(r.overridable, true);
  assert.ok(r.reservedWith && r.reservedWith.accel, '应回传命中的保留项');
});

// ===== ⑤ 保留组合与自有键无交集 =====
test('MACOS_RESERVED：每项都不与 4 个自有键相同', () => {
  // 防回归：避免把 Mio 自有键（如 Alt+Space）误列进「系统保留」而语义自相矛盾
  assert.ok(Array.isArray(hk.MACOS_RESERVED) && hk.MACOS_RESERVED.length > 0);
  const ownNormed = new Set(OWNER_KEYS.map((o) => hk.normalize(hk.HOTKEYS[o])));
  for (const item of hk.MACOS_RESERVED) {
    assert.equal(typeof item.accel, 'string', '保留项缺 accel');
    assert.equal(typeof item.desc, 'string', '保留项缺人类可读说明');
    const n = hk.normalize(item.accel);
    assert.notEqual(n, '', `保留项 accel 非法：${item.accel}`);
    assert.ok(!ownNormed.has(n), `保留项 ${item.accel} 与自有键撞车`);
  }
});

test('MACOS_RESERVED：保留项自身两两不重复', () => {
  // 防回归：表内不应出现重复条目
  const seen = new Set();
  for (const item of hk.MACOS_RESERVED) {
    const n = hk.normalize(item.accel);
    assert.ok(!seen.has(n), `保留项重复：${item.accel}`);
    seen.add(n);
  }
});
