// Mio - 核心层：自定义循环提醒（recurring）—— 纯函数 + CRUD
// v2.0 F4：规则文本 → 下次触发时间戳；周期 ≥15min（防轰炸）；最多 20 条；重启不补跑。
//
// 规则语法（parseRule）：
//   "every 2 hours"            → { freq:'hourly', every:2 }
//   "daily 09:30" / "every day at 09:30" → { freq:'daily', at:'09:30' }
//   "weekly mon 09:00"        → { freq:'weekly', weekday:1, at:'09:00' }
//   "monthly 15 10:00"        → { freq:'monthly', day:15, at:'10:00' }
// 中文别名同样支持：每天/每周/每月、周几（一~日）、"每 N 小时"。
//
// 纯函数层不碰 fs/child_process；CRUD 列表由调用方（main.js IPC）持有并落盘 settings。

const MIN_PERIOD_MS = 15 * 60 * 1000; // 周期下限 15 分钟

// ---- 规则解析（纯函数）----

const WEEKDAY_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const WEEKDAY_EN = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
const WEEKDAY_FULL = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };

function parseTime(text) {
  const m = String(text || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { hour: h, minute: min };
}

function parseEvery(text) {
  // 匹配 "every 2h" / "每 2 小时" / "每30分钟" / "every 90m"
  const m = String(text || '').toLowerCase().match(/(?:every|每)\s*(\d+)\s*(h|hr|hour|hours|m|min|minute|minutes|小时|分钟|分)/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const minutes = /^(h|hr|hour|hours|小时)$/.test(unit) ? n * 60 : n;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  // 周期 <15min 也返回规则，由 validateRule 给出具体错误（「周期不能小于 15 分钟」）
  const everyHours = minutes % 60 === 0 ? minutes / 60 : minutes / 60;
  return { freq: 'hourly', every: everyHours, minutes };
}

function parseWeekday(text) {
  const low = String(text || '').toLowerCase();
  for (const [cn, v] of Object.entries(WEEKDAY_CN)) {
    if (low.includes(cn)) return v;
  }
  for (const [en, v] of Object.entries(WEEKDAY_EN)) {
    if (low.includes(en)) return v;
  }
  for (const [en, v] of Object.entries(WEEKDAY_FULL)) {
    if (low.includes(en)) return v;
  }
  return null;
}

// 解析规则文本 → Rule 对象；无法识别返回 null。
// Rule: { freq:'hourly'|'daily'|'weekly'|'monthly', every?, minutes?, at?, weekday?, day?, raw }
function parseRule(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const low = raw.toLowerCase();

  // 每小时/每 N 小时（周期型）
  const every = parseEvery(low);
  if (every) return { ...every, raw };

  const time = parseTime(low);

  // 每日
  if (low.includes('daily') || low.includes('每天') || low.includes('每日') || /^every day/.test(low)) {
    if (!time) return null;
    return { freq: 'daily', at: `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`, raw };
  }

  // 每周：weekly mon 09:00 / 每周一 09:00
  if (low.includes('weekly') || low.includes('每周') || low.includes('周')) {
    const wd = parseWeekday(low);
    if (wd === null || !time) return null;
    return {
      freq: 'weekly', weekday: wd,
      at: `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
      raw,
    };
  }

  // 每月：monthly 15 09:00 / 每月15号 09:00
  if (low.includes('monthly') || low.includes('每月')) {
    if (!time) return null;
    const dm = raw.match(/(\d{1,2})\s*(号|日|th|st|nd|rd)?/);
    const day = dm ? Number(dm[1]) : 1;
    if (!Number.isFinite(day) || day < 1 || day > 31) return null;
    return {
      freq: 'monthly', day,
      at: `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
      raw,
    };
  }

  // 兜底：只有时间 → 每日
  if (time) {
    return { freq: 'daily', at: `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`, raw };
  }
  return null;
}

// 规则校验：可解析 + 周期 ≥ 15min。返回 { ok, error? }
function validateRule(rule) {
  if (!rule || typeof rule !== 'object') return { ok: false, error: '规则为空' };
  if (!['hourly', 'daily', 'weekly', 'monthly'].includes(rule.freq)) return { ok: false, error: '不支持的频率' };
  if (rule.freq === 'hourly') {
    if (!Number.isFinite(rule.minutes) || rule.minutes < 15) return { ok: false, error: '周期不能小于 15 分钟' };
  }
  if (rule.freq === 'daily' || rule.freq === 'weekly' || rule.freq === 'monthly') {
    if (!rule.at || !/^\d{2}:\d{2}$/.test(rule.at)) return { ok: false, error: '缺少时间' };
  }
  if (rule.freq === 'weekly' && (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6)) {
    return { ok: false, error: '星期无效' };
  }
  if (rule.freq === 'monthly' && (!Number.isInteger(rule.day) || rule.day < 1 || rule.day > 31)) {
    return { ok: false, error: '日期无效' };
  }
  return { ok: true };
}

// 计算下一次触发时间戳（纯函数）
// now：毫秒时间戳（默认 Date.now()）；返回 > now 的下一个触发点。
function nextTs(rule, now = Date.now()) {
  const v = validateRule(rule);
  if (!v.ok) return 0;
  const base = new Date(now);
  const MIN = 60 * 1000;

  if (rule.freq === 'hourly') {
    const periodMs = Math.max(MIN_PERIOD_MS, (rule.minutes || 60) * MIN);
    return now + periodMs;
  }

  // 时分型规则：构造目标时刻
  const [hh, mm] = rule.at.split(':').map(Number);
  const target = (d) => {
    const t = new Date(d);
    t.setHours(hh, mm, 0, 0);
    return t;
  };

  if (rule.freq === 'daily') {
    let t = target(base);
    if (t.getTime() <= now) t = new Date(t.getTime() + 86400000);
    return t.getTime();
  }

  if (rule.freq === 'weekly') {
    // rule.weekday: 0=周日 … 6=周六；js getDay() 同口径
    let t = target(base);
    let diff = (rule.weekday - t.getDay() + 7) % 7;
    if (diff === 0 && t.getTime() <= now) diff = 7;
    t = new Date(t.getTime() + diff * 86400000);
    return t.getTime();
  }

  if (rule.freq === 'monthly') {
    // 目标日：若当月没有该日（如 31 号）则顺延到下月
    let t = target(base);
    if (t.getDate() !== rule.day) {
      // 从当月 1 号开始找
      const first = new Date(t.getFullYear(), t.getMonth(), 1, hh, mm, 0, 0);
      const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
      const day = Math.min(rule.day, lastDay);
      t = new Date(first.getFullYear(), first.getMonth(), day, hh, mm, 0, 0);
    }
    if (t.getTime() <= now) {
      const nextMonth = new Date(t.getFullYear(), t.getMonth() + 1, 1);
      const lastDay = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate();
      const day = Math.min(rule.day, lastDay);
      t = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), day, hh, mm, 0, 0);
    }
    return t.getTime();
  }
  return 0;
}

// ---- CRUD 列表管理（纯函数：传入数组，返回新数组）----

const MAX_ITEMS = 20;

function listItems(items) {
  return Array.isArray(items) ? items.slice() : [];
}

function addItem(items, item) {
  const arr = Array.isArray(items) ? items.slice() : [];
  if (arr.length >= MAX_ITEMS) return { ok: false, error: `最多 ${MAX_ITEMS} 条` };
  const rule = parseRule(item && item.rule);
  const v = rule ? validateRule(rule) : { ok: false, error: '规则无法解析' };
  if (!v.ok) return { ok: false, error: v.error };
  const id = String((item && item.id) || '').trim() || `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const next = {
    id,
    name: String((item && item.name) || '').trim().slice(0, 60) || '循环提醒',
    rule: String((item && item.rule) || '').trim(),
    enabled: item && item.enabled !== false,
    nextTs: nextTs(rule, Date.now()),
    createdAt: Date.now(),
  };
  arr.push(next);
  return { ok: true, item: next, items: arr };
}

function updateItem(items, id, patch) {
  const arr = Array.isArray(items) ? items.slice() : [];
  const idx = arr.findIndex((it) => it && it.id === id);
  if (idx < 0) return { ok: false, error: '未找到' };
  const cur = arr[idx];
  const nextRuleText = String((patch && patch.rule) || cur.rule || '').trim();
  const rule = parseRule(nextRuleText);
  if (!rule) return { ok: false, error: '规则无法解析' };
  const v = validateRule(rule);
  if (!v.ok) return { ok: false, error: v.error };
  const merged = { ...cur, ...(patch || {}) };
  merged.name = String(merged.name || '').trim().slice(0, 60) || '循环提醒';
  merged.rule = nextRuleText;
  merged.ruleObj = rule;
  merged.nextTs = nextTs(rule, Date.now());
  arr[idx] = merged;
  return { ok: true, item: merged, items: arr };
}

function removeItem(items, id) {
  const arr = Array.isArray(items) ? items.slice() : [];
  const idx = arr.findIndex((it) => it && it.id === id);
  if (idx < 0) return { ok: false, error: '未找到' };
  arr.splice(idx, 1);
  return { ok: true, items: arr };
}

// 找出所有「已到点」的条目并推进 nextTs（供主进程轮询调用）
function dueItems(items, now = Date.now()) {
  const arr = Array.isArray(items) ? items : [];
  const due = [];
  const next = arr.map((it) => {
    if (!it || !it.enabled) return it;
    if (Number(it.nextTs) > 0 && Number(it.nextTs) <= now) {
      due.push({ id: it.id, name: it.name, rule: it.rule });
      const rule = parseRule(it.rule);
      return { ...it, nextTs: rule ? nextTs(rule, now) : 0 };
    }
    return it;
  });
  return { due, items: next };
}

module.exports = {
  MAX_PERIOD_MS: MIN_PERIOD_MS,
  MAX_ITEMS,
  parseRule,
  validateRule,
  nextTs,
  listItems,
  addItem,
  updateItem,
  removeItem,
  dueItems,
};