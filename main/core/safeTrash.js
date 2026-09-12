// Mio - 核心层：公共删除模块（safeTrash）
// v2.0 硬约束 2 的唯一落地：所有删除类操作只进废纸篓（shell.trashItem），绝不 rm/unlink。
// 设计 §1.2①：路径验证 → 二次确认 → shell.trashItem → 清理历史，四段合一。
//
// 分层：
//   - 纯函数（可单测）：isSafeTrashPath / isUninstallTarget / buildTrashReport
//   - 副作用：trashWithConfirm（shell.trashItem 逐项执行）/ recordClean（清理历史落盘）
// 依赖：electron shell（仅副作用函数）、fs、path、os。
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOME = os.homedir();

// 惰性取 electron：纯函数层在 node --test 下也能加载（electron 在 node 里是字符串路径，
// 只有真正调用副作用时才需要 electron API）。
function electron() {
  try { return require('electron'); } catch { return {}; }
}

// ---- 路径校验（纯函数，无副作用）----

// 三级校验第一级：黑名单（沿用 main/clean/targets.js 语义，内部独立实现避免循环依赖）
// 系统级顶层（/System、/usr、/Library）一律拒绝；只放行用户目录。
function isBlacklistedPath(p) {
  if (typeof p !== 'string' || !p) return true;
  const norm = path.normalize(p);
  if (norm.startsWith('/System') || norm.startsWith('/usr') || norm === '/Library' || norm.startsWith('/Library/')) return true;
  if (!norm.startsWith(HOME + path.sep)) return true;
  const rel = norm.slice(HOME.length);
  const badPrefixes = [
    '/Library/Containers', '/Library/Group Containers',
    '/Library/Keychains', '/Library/Mail',
  ];
  if (badPrefixes.some((b) => rel === b || rel.startsWith(b + path.sep))) return true;
  if (rel.includes('Photos Library')) return true;
  return false;
}

// 白名单 + allowApps：允许删除「用户目录下的普通文件/目录」。
// opts.allowApps=true 时额外放行 /Applications 与 ~/Applications 下的 *.app（供 F7 卸载）。
// 其余路径（系统级、沙盒、钥匙串等）一律拒绝。
function isSafeTrashPath(p, opts = {}) {
  if (typeof p !== 'string' || !p) return false;
  const norm = path.normalize(p);
  if (isBlacklistedPath(norm)) return false;
  if (opts.allowApps) {
    const appsRoots = [path.join(HOME, 'Applications'), '/Applications'];
    for (const root of appsRoots) {
      const prefix = root + path.sep;
      if (norm.startsWith(prefix) && norm.endsWith('.app')) return true;
    }
  }
  return true;
}

// F7 专用扩展：只对 safeTrash 放行的卸载目标路径。
// 允许：
//   /Applications/<Name>.app、~/Applications/<Name>.app
//   ~/Library/Preferences/<bundleId>.plist
//   ~/Library/Application Support/<Name>/{...}
//   ~/Library/Caches/<Name>
//   ~/Library/Saved Application State/<bundleId>.savedState
// 系统级（/System、/usr、/Library 顶层）一律拒绝。
function isUninstallTarget(p) {
  if (typeof p !== 'string' || !p) return false;
  const norm = path.normalize(p);
  if (norm.startsWith('/System') || norm.startsWith('/usr') || norm === '/Library' || norm.startsWith('/Library/')) return false;

  const appsRoots = ['/Applications', path.join(HOME, 'Applications')];
  for (const root of appsRoots) {
    if (norm.startsWith(root + path.sep) && norm.endsWith('.app')) return true;
  }
  if (!norm.startsWith(HOME + path.sep)) return false;
  const rel = norm.slice(HOME.length);
  // 偏好 plist：~/Library/Preferences/<bundleId>.plist
  if (/^\/Library\/Preferences\/[^/]+\.plist$/.test(rel)) return true;
  // Application Support / Caches / Saved Application State：<Name> 或 <bundleId>.savedState
  if (/^\/Library\/Application Support\/[^/]+/.test(rel)) return true;
  if (/^\/Library\/Caches\/[^/]+/.test(rel)) return true;
  if (/^\/Library\/Saved Application State\/[^/]+\.savedState$/.test(rel)) return true;
  return false;
}

// ---- 报告构造（纯函数）----

// 把 entries 归一化并逐项校验，返回预备清单（不含任何副作用）。
// entries: [{ path, name?, size? }] 或 [path]
// opts: { allowApps, onReject? } —— onReject(path, reason) 供调用方记录拒绝原因
function prepareTrashEntries(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const prepared = [];
  for (const e of list) {
    const p = typeof e === 'string' ? e : (e && e.path);
    if (typeof p !== 'string' || !p.trim()) continue;
    const norm = path.normalize(p);
    const name = typeof e === 'string' ? path.basename(e) : (e.name || path.basename(e));
    const size = typeof e === 'object' && e && Number(e.size) > 0 ? Number(e.size) : 0;
    let ok = false;
    let reason = '';
    if (opts.allowUninstall) {
      ok = isUninstallTarget(norm);
      reason = ok ? '' : '路径不在卸载白名单，已拒绝';
    } else {
      ok = isSafeTrashPath(norm, { allowApps: !!opts.allowApps });
      reason = ok ? '' : '路径不在安全范围，已拒绝';
    }
    prepared.push({ path: norm, name, size, ok, reason });
  }
  return prepared;
}

// ---- 副作用：执行 + 记录 ----

// 执行删除（唯一入口）。约定：主进程不弹窗，二次确认由渲染层 showConfirm 完成；
// 这里只负责「校验 → shell.trashItem → 统计」。
// 返回 { ok, moved, failed, report }；report 每项 { path, name, size, ok, error? }
async function trashWithConfirm(entries, opts = {}) {
  const prepared = prepareTrashEntries(entries, opts);
  const report = [];
  let moved = 0;
  let failed = 0;
  for (const it of prepared) {
    if (!it.ok) {
      report.push({ path: it.path, name: it.name, size: it.size, ok: false, error: it.reason });
      failed++;
      continue;
    }
    try {
      await electron().shell.trashItem(it.path);
      report.push({ path: it.path, name: it.name, size: it.size, ok: true });
      moved++;
    } catch (err) {
      report.push({ path: it.path, name: it.name, size: it.size, ok: false, error: String((err && err.message) || err) });
      failed++;
    }
  }
  const ok = failed === 0;
  return { ok, moved, failed, report };
}

// 清理历史记录（复用 main.js C5 语义，独立实现避免循环依赖）。
// items: [{ name, size, path? }]；写入 userData/mio-clean-history.json
const cleanHistoryFile = () => path.join(electron().app.getPath('userData'), 'mio-clean-history.json');

function readCleanHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(cleanHistoryFile(), 'utf8'));
    return { records: Array.isArray(data.records) ? data.records : [], totalFreed: Number(data.totalFreed) || 0 };
  } catch {
    return { records: [], totalFreed: 0 };
  }
}

function recordClean(items) {
  try {
    const data = readCleanHistory();
    const total = (Array.isArray(items) ? items : []).reduce((a, i) => a + (i.size || 0), 0);
    data.records.unshift({ t: Date.now(), items: Array.isArray(items) ? items : [], total });
    if (data.records.length > 100) data.records.length = 100;
    data.totalFreed += total;
    fs.writeFileSync(cleanHistoryFile(), JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  HOME,
  isBlacklistedPath,
  isSafeTrashPath,
  isUninstallTarget,
  prepareTrashEntries,
  trashWithConfirm,
  recordClean,
};