// Mio - 核心层：真正的闹钟 / 倒计时（alarm.json 持久化）
// v1.9：解决「快捷提醒用 renderer setTimeout，面板收起/重启后丢失或漂移」的痛点。
// 主进程用「绝对结束时间戳」驱动，剩余时间由 Date.now() 计算 —— 不依赖 renderer 定时器，
// 即使面板收起、renderer 被节流、应用重启，倒计时依然准确且不丢。
//
// 数据：{ endTs, minutes, label, createdAt }
// 到点行为由调用方注入 onFire（main.js 里发系统通知 + 广播给 renderer 弹气泡 + 声音）。

const path = require('path');
const fs = require('fs');

// 惰性取 electron：纯函数层在 node --test 下也能加载
function electron() {
  try { return require('electron'); } catch { return {}; }
}

const alarmFile = () => path.join(electron().app.getPath('userData'), 'alarm.json');
const _onFire = []; // 到点回调列表，由 main.js / recurring.js 注入（v2.0：支持多订阅者）

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(alarmFile(), 'utf8'));
    // 只认「还在未来」的闹钟；过期的直接清掉（重启后不补响）
    if (d && typeof d.endTs === 'number' && d.endTs > Date.now()) return d;
  } catch {}
  return null;
}
function save(a) {
  try { fs.writeFileSync(alarmFile(), JSON.stringify(a)); } catch {}
}

// 启动一个倒计时。minutes = 分钟数（>0）；label 用于提醒文案。
function start(minutes, label) {
  const mins = Math.max(0.1, Number(minutes) || 25); // 至少 6 秒，防误触 0
  const alarm = { endTs: Date.now() + mins * 60 * 1000, minutes: mins, label: label || '', running: true };
  save(alarm);
  return state();
}
function cancel() {
  try { fs.unlinkSync(alarmFile()); } catch {}
  return { running: false };
}
// 当前状态（含剩余秒数）。返回 null 表示没有进行中的倒计时。
function state() {
  const a = load();
  if (!a) return { running: false };
  const remaining = Math.max(0, Math.round((a.endTs - Date.now()) / 1000));
  return { running: true, endTs: a.endTs, minutes: a.minutes, label: a.label, remaining };
}

// 由 main.js 每 1 秒调用：到点触发 _onFire 并清除持久化。
// 注意：必须读原始文件判断（不能走 load()，因为它会过滤掉「已过期」的闹钟，
// 那样到点的闹钟就永远触发不了了）。
function tick() {
  let a = null;
  try { a = JSON.parse(fs.readFileSync(alarmFile(), 'utf8')); } catch { return; }
  if (!a || typeof a.endTs !== 'number') return;
  if (Date.now() >= a.endTs) {
    cancel();
    for (const cb of _onFire) { try { cb(a); } catch {} }
  }
}
// 注册到点回调（返回取消订阅函数）。v2.0：多订阅者复用同一通道，
// recurring.js 通过它发「循环提醒到点」通知，互不覆盖。
function onFire(cb) {
  if (typeof cb !== 'function') return () => {};
  _onFire.push(cb);
  return () => {
    const i = _onFire.indexOf(cb);
    if (i >= 0) _onFire.splice(i, 1);
  };
}

module.exports = { alarmFile, start, cancel, state, tick, onFire };