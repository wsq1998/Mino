// Mio - 核心层：番茄钟统计（pomo-stats.json 的读/写/聚合）
// v1.9：把每次完成的「工作阶段」持久化，供「统计 + 周报」展示。
// 只记录工作阶段（休息不算一次番茄），格式：{ records: [{ t, work }] }
// 依赖：electron app（userData 路径）、fs、path。

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const pomoFile = path.join(app.getPath('userData'), 'pomo-stats.json');
const MAX_RECORDS = 2000; // 上限：约 5 年每天 1 个番茄，够用且防膨胀

function loadPomo() {
  try {
    const d = JSON.parse(fs.readFileSync(pomoFile, 'utf8'));
    return { records: Array.isArray(d && d.records) ? d.records : [] };
  } catch {
    return { records: [] };
  }
}
function savePomo(data) {
  try { fs.writeFileSync(pomoFile, JSON.stringify(data)); } catch {}
}

// 记一次完成的番茄（work = 专注分钟数）
function logPomo(work) {
  const d = loadPomo();
  d.records.push({ t: Date.now(), work: Number(work) || 25 });
  if (d.records.length > MAX_RECORDS) d.records = d.records.slice(-MAX_RECORDS);
  savePomo(d);
  return { ok: true, total: countTotal(d.records) };
}

const countTotal = (rs) => rs.reduce((acc, r) => acc + (Number(r.work) || 0), 0);

// 本周起始：周一 00:00
function weekStart(now = new Date()) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
// 今天起始
function dayStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 聚合快照：总量 / 今日 / 本周 + 近 7 天每日分布（供周报）
function pomoStats() {
  const { records } = loadPomo();
  const now = Date.now();
  const ws = weekStart();
  const ds = dayStart();
  const total = { count: records.length, mins: countTotal(records) };
  const today = { count: 0, mins: 0 };
  const week = { count: 0, mins: 0 };
  // 近 7 天分布（含今天，索引 0=今天）
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    daily.push({ _ts: d.getTime(), label: `${d.getMonth() + 1}/${d.getDate()}`, count: 0, mins: 0 });
  }
  records.forEach((r) => {
    const t = Number(r.t) || 0;
    const w = Number(r.work) || 0;
    if (t >= ds) { today.count++; today.mins += w; }
    if (t >= ws) { week.count++; week.mins += w; }
    for (let i = 0; i < 7; i++) {
      if (t >= daily[i]._ts && t < daily[i]._ts + 86400000) { daily[i].count++; daily[i].mins += w; break; }
    }
  });
  // 周报文案
  const report = week.count === 0
    ? '本周还没有完成番茄钟，从 25 分钟开始吧'
    : `本周完成 ${week.count} 个番茄 · ${week.mins} 分钟，日均 ${Math.round(week.count / weekdayIndex())} 个`;
  return { total, today, week, daily: daily.map((d) => ({ label: d.label, count: d.count, mins: d.mins })), report };
}

function weekdayIndex(now = new Date()) {
  // 本周已过天数（周一=1…今天）
  return (now.getDay() + 6) % 7 + 1;
}

module.exports = { pomoFile, loadPomo, logPomo, pomoStats, weekStart, dayStart };