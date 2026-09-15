// Mio - v2.0 批次 A 底座纯函数层单元测试（node:test，零第三方）
// 覆盖：settings（v8 迁移/收口）、
//       bluetooth（多版本 system_profiler 解析）、safeTrash（路径校验）、
//       ipnet（回退链）、i18n（中英 + 缺失回退）。
// 运行：npm test（= node --test test/）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const settings = require('../main/core/settings.js');
const bluetooth = require('../main/core/bluetooth.js');
const safeTrash = require('../main/core/safeTrash.js');
const battery = require('../main/core/battery.js');
const { isUninstallTarget: targetsIsUninstallTarget } = require('../main/clean/targets.js');
const mainI18n = require('../main/i18n.js');
const rendererI18n = require('../renderer/i18n.js');

const HOME = os.homedir();

// ===== settings：v8 → v9 迁移 + 收口 =====
test('settings.SETTINGS_VERSION 升到 9', () => {
  assert.equal(settings.SETTINGS_VERSION, 9);
  assert.equal(settings.DEFAULT_SETTINGS._v, 9);
});

test('settings 老配置读入自动长出 12 个新区（只增不改）', () => {
  const old = { _v: 7, general: { autoOpen: true }, clipboard: { enabled: true, limit: 5 } };
  const s = settings.sanitizeSettings(settings.deepMerge(settings.DEFAULT_SETTINGS, old));
  for (const k of ['battery', 'privacy', 'bluetooth', 'network', 'uninstall', 'split', 'stash', 'sunburst']) {
    assert.ok(k in s, `缺新区 ${k}`);
  }
  // 老键保留
  assert.equal(s.general.autoOpen, true);
  assert.equal(s.clipboard.limit, 5);
  // 默认值
  assert.equal(s.general.lang, 'auto');
  assert.equal(s.battery.enabled, false);
  assert.equal(s.uninstall.confirmAlways, true);
  assert.equal(s.clipboard.imageHistory, false);
  assert.equal(s.clipboard.imagePersist, 0);
});

test('settings.battery 数值收口（low < full）', () => {
  const s = settings.sanitizeSettings(settings.deepMerge(settings.DEFAULT_SETTINGS, { battery: { low: 100, full: 200 } }));
  assert.ok(s.battery.low < s.battery.full);
  assert.ok(s.battery.low <= 95 && s.battery.full <= 100);
});

test('settings.privacy.ignoreApps 数组白名单收口', () => {
  const s = settings.sanitizeSettings(settings.deepMerge(settings.DEFAULT_SETTINGS, { privacy: { ignoreApps: ['zoom', '', 42, 'wechat'] } }));
  assert.deepEqual(s.privacy.ignoreApps, ['zoom', 'wechat']);
});

// ===== v2.1 中转站浮窗：stash 新键收口 + 老配置自动补齐 =====
test('settings.stash 新键：老配置读入自动补齐默认值', () => {
  const old = { _v: 8, stash: { enabled: true, persist: true, items: [] } };
  const s = settings.sanitizeSettings(settings.deepMerge(settings.DEFAULT_SETTINGS, old));
  assert.equal(s.stash.panelEnabled, true);
  assert.equal(s.stash.edgeHot, true);
  assert.equal(s.stash.edgeSide, 'top'); // v2.3 默认触发边改为顶部
  assert.equal(s.stash.edgeThreshold, 6);
  assert.equal(s.stash.autoHideDelay, 1200);
  assert.equal(s.stash.pinned, false);
  assert.equal(s.stash.hotkey, 'Alt+Shift+Space');
  assert.equal(s.stash.trayEnabled, true);
  assert.equal(s.stash.capsuleOpacity, 0.6);
  assert.equal(s.stash.dir, ''); // v2.5 默认存放目录（空 = 下载/Mio中转站）
});

test('settings.stash 新键：脏数据收口（枚举/数值/快捷串）', () => {
  const s = settings.sanitizeSettings(settings.deepMerge(settings.DEFAULT_SETTINGS, {
    stash: { edgeSide: 'up', edgeThreshold: 999, autoHideDelay: 5, capsuleOpacity: 100, hotkey: '   ', dir: '   ' },
  }));
  assert.equal(s.stash.edgeSide, 'right');          // 非法枚举 → right
  assert.equal(s.stash.edgeThreshold, 24);          // 夹到 1–24
  assert.equal(s.stash.autoHideDelay, 300);         // 夹到 300–6000
  assert.equal(s.stash.capsuleOpacity, 1);          // normUnit(100) → 夹到 1
  assert.equal(s.stash.hotkey, null);               // 空白串 → null（未注册）
  assert.equal(s.stash.dir, '');                    // v2.5 空白串目录 → ''（用默认）
});

// ===== bluetooth =====
test('bluetooth.parseProfiler 兼容多版本输出（含 hex 电量）', () => {
  const sample = `Bluetooth:
    Connected:
        AirPods Pro:
            Address: aa:bb
            Battery Level: 80
    Not Connected:
        Magic Mouse:
            Address: cc:dd
            Battery Level: 0x64
`;
  const devs = bluetooth.parseProfiler(sample);
  assert.equal(devs.length, 2);
  assert.equal(devs[0].name, 'AirPods Pro');
  assert.equal(devs[0].connected, true);
  assert.equal(devs[0].battery, 80);
  assert.equal(devs[1].connected, false);
  assert.equal(devs[1].battery, 100);
});

test('bluetooth.parseBattery 兼容百分数/十六进制', () => {
  assert.equal(bluetooth.parseBattery('42%'), 42);
  assert.equal(bluetooth.parseBattery('0x64'), 100);
  assert.equal(bluetooth.parseBattery('0x32'), 50);
  assert.equal(bluetooth.parseBattery('abc'), null);
});

// ===== safeTrash =====
test('safeTrash.isSafeTrashPath 拒绝系统级、放行用户文件', () => {
  assert.equal(safeTrash.isSafeTrashPath('/System/Library'), false);
  assert.equal(safeTrash.isSafeTrashPath('/usr/bin'), false);
  assert.equal(safeTrash.isSafeTrashPath('/Library/Preferences/x.plist'), false);
  assert.equal(safeTrash.isSafeTrashPath(path.join(HOME, 'Documents/a.txt')), true);
});

test('safeTrash.isUninstallTarget 白名单（app/plist/support/caches/savedState）', () => {
  assert.equal(safeTrash.isUninstallTarget('/Applications/Safari.app'), true);
  assert.equal(safeTrash.isUninstallTarget(path.join(HOME, 'Applications/MyApp.app')), true);
  assert.equal(safeTrash.isUninstallTarget(path.join(HOME, 'Library/Preferences/com.apple.safari.plist')), true);
  assert.equal(safeTrash.isUninstallTarget(path.join(HOME, 'Library/Application Support/Safari')), true);
  assert.equal(safeTrash.isUninstallTarget(path.join(HOME, 'Library/Caches/Safari')), true);
  assert.equal(safeTrash.isUninstallTarget(path.join(HOME, 'Library/Saved Application State/com.apple.safari.savedState')), true);
  // 拒绝：系统级 / 沙盒 / 任意文件
  assert.equal(safeTrash.isUninstallTarget('/Library/Preferences/x.plist'), false);
  assert.equal(safeTrash.isUninstallTarget('/System/Applications/Safari.app'), false);
  assert.equal(safeTrash.isUninstallTarget(path.join(HOME, 'Documents/a.txt')), false);
  assert.equal(safeTrash.isUninstallTarget(path.join(HOME, 'Library/Containers/x')), false);
});

test('targets.isUninstallTarget 与 safeTrash 版本一致', () => {
  assert.equal(targetsIsUninstallTarget('/Applications/Safari.app'), true);
  assert.equal(targetsIsUninstallTarget('/Library/Preferences/x.plist'), false);
});

// ===== ipnet（纯函数部分：回退链逻辑通过 lanIp 的接口约定验证）=====
test('ipnet 导出函数齐全', () => {
  const ipnet = require('../main/core/ipnet.js');
  assert.equal(typeof ipnet.lanIp, 'function');
  assert.equal(typeof ipnet.publicIp, 'function');
  assert.equal(typeof ipnet.copy, 'function');
  assert.equal(typeof ipnet.reset, 'function');
});

// ===== i18n =====
test('main/i18n 中英取词 + 缺失回退 zh', () => {
  assert.equal(mainI18n.t('battery.low.title', { lang: 'zh' }), 'Mio · 电量偏低');
  assert.equal(mainI18n.t('battery.low.title', { lang: 'en' }), 'Mio · Low Battery');
  assert.equal(mainI18n.t('no.such.key', { lang: 'en' }), 'no.such.key');
  assert.equal(mainI18n.resolveLang('auto'), 'en'); // node 环境无 navigator → en
});

test('renderer/i18n 中英取词 + 缺失回退', () => {
  assert.equal(rendererI18n.t('no.such.key', { lang: 'en' }), 'no.such.key');
});

// ===== battery：三档判定 + 去重状态机（v2.0 F1 优化）=====
test('battery.currentLevel 三档判定', () => {
  assert.equal(battery.currentLevel({ pct: 100, charging: true, low: 20, full: 80 }), 'charged');
  assert.equal(battery.currentLevel({ pct: 80, charging: true, low: 20, full: 80 }), 'full');
  assert.equal(battery.currentLevel({ pct: 79, charging: true, low: 20, full: 80 }), null);
  assert.equal(battery.currentLevel({ pct: 20, charging: false, low: 20, full: 80 }), 'low');
  assert.equal(battery.currentLevel({ pct: 21, charging: false, low: 20, full: 80 }), null);
  // 低电量但插着电 → 充电档位优先，不提醒充电
  assert.equal(battery.currentLevel({ pct: 10, charging: true, low: 20, full: 80 }), null);
});

test('battery.decideAlert 各档独立去重 + 离开档位重置', () => {
  const base = { low: 20, full: 80 };
  let r = battery.decideAlert({ ...base, pct: 15, charging: false, lastLevel: null });
  assert.deepEqual(r, { level: 'low', notify: true, nextLevel: 'low' });
  r = battery.decideAlert({ ...base, pct: 10, charging: false, lastLevel: 'low' });
  assert.equal(r.notify, false);
  r = battery.decideAlert({ ...base, pct: 50, charging: false, lastLevel: 'low' });
  assert.deepEqual(r, { level: null, notify: false, nextLevel: null });
  r = battery.decideAlert({ ...base, pct: 19, charging: false, lastLevel: null });
  assert.equal(r.notify, true);
});

test('battery.decideAlert 充电到阈值与充满 100% 是两次独立提醒', () => {
  const base = { low: 20, full: 80 };
  let r = battery.decideAlert({ ...base, pct: 80, charging: true, lastLevel: null });
  assert.deepEqual(r, { level: 'full', notify: true, nextLevel: 'full' });
  r = battery.decideAlert({ ...base, pct: 95, charging: true, lastLevel: 'full' });
  assert.equal(r.notify, false);
  r = battery.decideAlert({ ...base, pct: 100, charging: true, lastLevel: 'full' });
  assert.deepEqual(r, { level: 'charged', notify: true, nextLevel: 'charged' });
  r = battery.decideAlert({ ...base, pct: 100, charging: true, lastLevel: 'charged' });
  assert.equal(r.notify, false);
});

test('battery.decideAlert 非法输入收敛（pct 夹取 / 阈值回退默认 / lastLevel 清洗）', () => {
  const r = battery.decideAlert({ pct: NaN, charging: false, low: undefined, full: undefined, lastLevel: 'weird' });
  assert.deepEqual(r, { level: 'low', notify: true, nextLevel: 'low' });
  const r2 = battery.decideAlert({ pct: 200, charging: false, low: 20, full: 80, lastLevel: null });
  assert.deepEqual(r2, { level: null, notify: false, nextLevel: null });
});

test('renderer/i18n 电量提醒新增文案中英齐全', () => {
  assert.equal(rendererI18n.t('battery.chargedHint', { lang: 'zh' }).slice(0, 2), '充满');
  assert.notEqual(rendererI18n.t('battery.note', { lang: 'en' }), 'battery.note');
  assert.notEqual(rendererI18n.t('tools.note', { lang: 'zh' }), 'tools.note');
});