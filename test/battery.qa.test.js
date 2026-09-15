// Mio - F1 电量提醒：QA 独立验证套件（node:test，零第三方）
// 由 QA（严过关）独立编写，不复用工程师 test/core.test.js 的用例。
// 目标：证明三档判定 + 各档独立去重状态机在正常与边界输入下均收敛、不抛异常，
//       且 nextLevel 契约足以支撑 batteryTick 的「不重复轰炸」。
// 运行：node --test test/battery.qa.test.js（或 npm test 一并执行）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const battery = require('../main/core/battery.js');

// 小工具：用 decideAlert 串起一个「像 batteryTick 一样」的状态机，收集实际发出的提醒。
// 与 main.js batteryTick 的用法完全一致：notify 才提醒，nextLevel 回填 lastLevel。
function runSequence(seq, { low = 20, full = 80 } = {}) {
  let lastLevel = null;
  const fired = [];
  for (const s of seq) {
    const r = battery.decideAlert({ pct: s.pct, charging: s.charging, low, full, lastLevel });
    lastLevel = r.nextLevel; // batteryTick 的落地方式
    if (r.notify) fired.push({ tag: s.tag, level: r.level });
  }
  return fired;
}

// ===== 1. 常量导出 =====
test('QA: 常量导出三位档位名', () => {
  assert.equal(battery.LOW_LEVEL, 'low');
  assert.equal(battery.FULL_LEVEL, 'full');
  assert.equal(battery.CHARGED_LEVEL, 'charged');
  assert.equal(typeof battery.currentLevel, 'function');
  assert.equal(typeof battery.decideAlert, 'function');
});

// ===== 2. 三档正常触发各一次 =====
test('QA: 三档各触发一次（low / full / charged）', () => {
  const fired = runSequence([
    { pct: 15, charging: false, tag: 'low' },
    { pct: 50, charging: true, tag: 'mid' },   // 离开低电量档，重置
    { pct: 80, charging: true, tag: 'full' },
    { pct: 100, charging: true, tag: 'charged' },
  ]);
  assert.deepEqual(fired, [
    { tag: 'low', level: 'low' },
    { tag: 'full', level: 'full' },
    { tag: 'charged', level: 'charged' },
  ]);
});

// ===== 3. 关键序列：full → charged 两档互不吞并 =====
test('QA: 充到阈值提醒①、继续充满提醒②，两档不互相吞并', () => {
  const fired = runSequence([
    { pct: 60, charging: true, tag: 'pre' },
    { pct: 80, charging: true, tag: 'atFull' },
    { pct: 85, charging: true, tag: 'a' },
    { pct: 90, charging: true, tag: 'b' },
    { pct: 95, charging: true, tag: 'c' },
    { pct: 99, charging: true, tag: 'd' },
    { pct: 100, charging: true, tag: 'at100' },
  ]);
  assert.deepEqual(fired, [
    { tag: 'atFull', level: 'full' },
    { tag: 'at100', level: 'charged' },
  ]);
});

// ===== 4. 同档位连续采样只提醒一次（防 30s 轰炸）=====
test('QA: 同一档位连续 6 次采样只提醒 1 次', () => {
  const seq = [];
  for (let i = 0; i < 6; i++) seq.push({ pct: 80 + i, charging: true, tag: 't' + i });
  const fired = runSequence(seq);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].level, 'full');
});

// ===== 5. 离开档位后再进入可再次提醒（重置）=====
test('QA: 离开 full 档再回到 full 档，可再次提醒', () => {
  const fired = runSequence([
    { pct: 80, charging: true, tag: 'full1' },
    { pct: 50, charging: true, tag: 'leave' },
    { pct: 82, charging: true, tag: 'full2' },
  ]);
  assert.deepEqual(fired.map((f) => f.level), ['full', 'full']);
});

test('QA: 离开 low 档再回到 low 档，可再次提醒', () => {
  const fired = runSequence([
    { pct: 10, charging: false, tag: 'low1' },
    { pct: 60, charging: false, tag: 'leave' },
    { pct: 12, charging: false, tag: 'low2' },
  ]);
  assert.deepEqual(fired.map((f) => f.level), ['low', 'low']);
});

// ===== 6. 边界：pct 恰好等于 low / full / 100 =====
test('QA: pct 恰好等于各阈值', () => {
  assert.deepEqual(
    battery.decideAlert({ pct: 20, charging: false, low: 20, full: 80, lastLevel: null }),
    { level: 'low', notify: true, nextLevel: 'low' },
  );
  assert.deepEqual(
    battery.decideAlert({ pct: 20, charging: true, low: 20, full: 80, lastLevel: null }),
    { level: null, notify: false, nextLevel: null }, // 插着电不算低电量档
  );
  assert.deepEqual(
    battery.decideAlert({ pct: 80, charging: true, low: 20, full: 80, lastLevel: null }),
    { level: 'full', notify: true, nextLevel: 'full' },
  );
  assert.deepEqual(
    battery.decideAlert({ pct: 80, charging: false, low: 20, full: 80, lastLevel: null }),
    { level: null, notify: false, nextLevel: null }, // 未充电不算满电档
  );
  assert.deepEqual(
    battery.decideAlert({ pct: 100, charging: true, low: 20, full: 80, lastLevel: null }),
    { level: 'charged', notify: true, nextLevel: 'charged' },
  );
  assert.deepEqual(
    battery.decideAlert({ pct: 100, charging: false, low: 20, full: 80, lastLevel: null }),
    { level: null, notify: false, nextLevel: null }, // 100% 但未充电 → 不该提醒拔电
  );
});

// ===== 7. 充电状态与档位冲突 =====
test('QA: pct≤low 但充电中 → 不提醒充电', () => {
  const r = battery.decideAlert({ pct: 5, charging: true, low: 20, full: 80, lastLevel: null });
  assert.deepEqual(r, { level: null, notify: false, nextLevel: null });
});

test('QA: 充满后拔电（charging 变 false）→ 不误报', () => {
  const fired = runSequence([
    { pct: 100, charging: true, tag: 'chg100' },
    { pct: 100, charging: false, tag: 'unplug' },
    { pct: 99, charging: false, tag: 'drop' },
  ]);
  assert.deepEqual(fired.map((f) => f.level), ['charged']);
});

// ===== 8. 一次采样从 <F 直接跳到 ≥100（跳过 F 档）=====
test('QA: 采样跳过 full 档直达 100% → 只发 charged 一次（不误发 full）', () => {
  const fired = runSequence([
    { pct: 50, charging: true, tag: '50' },
    { pct: 100, charging: true, tag: 'jump' },
    { pct: 100, charging: true, tag: 'stay' },
  ]);
  assert.deepEqual(fired.map((f) => f.level), ['charged']);
});

// ===== 9. full 设为 100：full 与 charged 合并，只提醒一次 =====
test('QA: full=100 时 full/charged 合并为单次 charged 提醒', () => {
  const fired = runSequence([
    { pct: 60, charging: true, tag: '60' },
    { pct: 100, charging: true, tag: '100' },
    { pct: 100, charging: true, tag: '100b' },
  ], { low: 20, full: 100 });
  assert.deepEqual(fired.map((f) => f.level), ['charged']);
});

// ===== 10. 越界值收敛 =====
test('QA: pct 越界（负数 / >100）被夹取到 0..100', () => {
  assert.equal(battery.decideAlert({ pct: -5, charging: false, low: 20, full: 80, lastLevel: null }).level, 'low');
  assert.equal(battery.decideAlert({ pct: 200, charging: true, low: 20, full: 80, lastLevel: null }).level, 'charged');
  assert.equal(battery.decideAlert({ pct: 150, charging: false, low: 20, full: 80, lastLevel: null }).level, null);
});

// ===== 11. 阈值非法 / 反转 =====
test('QA: low > full（反转阈值）不抛异常且收敛', () => {
  assert.doesNotThrow(() => battery.decideAlert({ pct: 10, charging: false, low: 80, full: 20, lastLevel: null }));
  assert.equal(battery.decideAlert({ pct: 10, charging: false, low: 80, full: 20, lastLevel: null }).level, 'low');
  assert.equal(battery.decideAlert({ pct: 90, charging: true, low: 80, full: 20, lastLevel: null }).level, 'full');
});

test('QA: low === full 时不抛异常，未充电给 low、充电给 full', () => {
  assert.equal(battery.decideAlert({ pct: 50, charging: false, low: 50, full: 50, lastLevel: null }).level, 'low');
  assert.equal(battery.decideAlert({ pct: 50, charging: true, low: 50, full: 50, lastLevel: null }).level, 'full');
});

// ===== 12. 非数字 / 缺失输入收敛 =====
test('QA: 非数字 / undefined / null 输入均收敛，不抛异常', () => {
  assert.doesNotThrow(() => battery.decideAlert());
  assert.doesNotThrow(() => battery.decideAlert({}));
  assert.doesNotThrow(() => battery.decideAlert({ pct: null, charging: null, low: null, full: null }));
  assert.doesNotThrow(() => battery.decideAlert({ pct: 'abc', charging: 'yes', low: 'x', full: 'y' }));
  // 数字字符串应被当作数字
  assert.equal(battery.decideAlert({ pct: '15', charging: false, low: 20, full: 80, lastLevel: null }).level, 'low');
});

// ===== 13. lastLevel 脏值清洗 =====
test('QA: lastLevel 为非法值时按 null 处理', () => {
  assert.deepEqual(
    battery.decideAlert({ pct: 15, charging: false, low: 20, full: 80, lastLevel: 'weird' }),
    { level: 'low', notify: true, nextLevel: 'low' },
  );
});

// ===== 14. nextLevel 契约：驱动去重，防止 30s 重复轰炸 =====
test('QA: nextLevel 始终等于 level（notify 判断后状态仍前进）', () => {
  const cases = [
    { pct: 15, charging: false },
    { pct: 50, charging: false },
    { pct: 80, charging: true },
    { pct: 100, charging: true },
    { pct: 99, charging: false },
  ];
  for (const c of cases) {
    const r = battery.decideAlert({ ...c, low: 20, full: 80, lastLevel: null });
    assert.equal(r.nextLevel, r.level, `nextLevel 必须等于 level for ${JSON.stringify(c)}`);
  }
});

test('QA: 稳态下重复采样永不二次提醒（模拟连续 20 轮）', () => {
  let lastLevel = null;
  let notifications = 0;
  for (let i = 0; i < 20; i++) {
    const r = battery.decideAlert({ pct: 100, charging: true, low: 20, full: 80, lastLevel });
    lastLevel = r.nextLevel;
    if (r.notify) notifications++;
  }
  assert.equal(notifications, 1);
});

// ===== 15. 模糊测试：任意输入不得抛异常 =====
test('QA: 大量模糊输入不抛异常且 key 结构稳定', () => {
  const pcts = [undefined, null, NaN, -100, 0, 5, 19, 20, 21, 79, 80, 99, 100, 101, 1e9, '50', 'x', {}];
  const bools = [true, false, 0, 1, undefined, null];
  const levels = [null, 'low', 'full', 'charged', 'bogus', 0, {}];
  const lows = [undefined, null, NaN, 0, 20, 95, -5, 100, '30'];
  const fulls = [undefined, null, NaN, 0, 80, 100, -5, 200, '70'];
  let n = 0;
  for (const pct of pcts) {
    for (const charging of bools) {
      for (const lastLevel of levels) {
        for (const low of lows) {
          for (const full of fulls) {
            const r = battery.decideAlert({ pct, charging, low, full, lastLevel });
            assert.ok('level' in r && 'notify' in r && 'nextLevel' in r);
            assert.ok(r.notify === false || r.notify === true);
            assert.equal(r.nextLevel, r.level);
            n++;
          }
        }
      }
    }
  }
  assert.ok(n > 1000, `应覆盖大量组合，实际 ${n}`);
});
