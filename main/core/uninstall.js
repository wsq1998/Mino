// Mio - 核心层：应用卸载器（uninstall）
// v2.0 F7：扫描 /Applications + ~/Applications；按 bundleId 匹配 4 类残留；
// 卸载执行封装 safeTrash（唯一删除入口，绝不 rm）。
//
// 分层：
//   - 纯函数：listAppsFromDirs(dirs) / scanResidualsFromInfo(app, info)
//   - 副作用：listApps() / scanResiduals(app) / uninstall(app, residuals)
// 依赖：fs、path、child_process（pgrep）、safeTrash、exec.js。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { trashWithConfirm } = require('./safeTrash.js');
const { runCmd } = require('./exec.js');

const HOME = os.homedir();
const APP_DIRS = ['/Applications', path.join(HOME, 'Applications')];

// 读取 Info.plist 的 CFBundleIdentifier（用 /usr/libexec/PlistBuddy，macOS 自带）
async function readBundleId(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return '';
  const r = await runCmd('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], 4000);
  const v = String(r.stdout || '').trim();
  return v && !v.includes('Does Not Exist') ? v : '';
}

// 扫描应用目录（副作用：fs + PlistBuddy）
async function listApps() {
  const apps = [];
  for (const dir of APPS_DIRS) {
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try { entries = await fs.promises.readdir(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.app')) continue;
      const p = path.join(dir, name);
      let st;
      try { st = await fs.promises.stat(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      const bundleId = await readBundleId(p);
      apps.push({
        name: name.replace(/\.app$/, ''),
        path: p,
        size: dirSizeQuick(p),
        bundleId,
        running: await isRunning(name.replace(/\.app$/, '')),
      });
    }
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

// 快速估算 .app 大小（只读 Contents 下若干大目录，容错；过大返回 0 由渲染层展示「—」）
function dirSizeQuick(dir, budgetMs = 800) {
  const start = Date.now();
  let total = 0;
  function walk(d) {
    if (Date.now() - start > budgetMs) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (Date.now() - start > budgetMs) return;
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch {}
    }
  }
  walk(dir);
  return total;
}

// 进程是否在运行（pgrep -x <name>）
async function isRunning(appName) {
  try {
    const r = await runCmd('/usr/bin/pgrep', ['-x', appName], 3000);
    return r.ok && String(r.stdout || '').trim() !== '';
  } catch {
    return false;
  }
}

// 扫描残留（副作用：fs + PlistBuddy）。app: { name, path, bundleId }
// 4 类残留（设计 §8.1：不扫 Containers 沙盒容器）：
//   ~/Library/Preferences/<bundleId>.plist
//   ~/Library/Application Support/<Name>
//   ~/Library/Caches/<Name>
//   ~/Library/Saved Application State/<bundleId>.savedState
async function scanResiduals(app) {
  const name = app && app.name;
  const bundleId = app && app.bundleId;
  if (!name) return [];
  const candidates = [];
  if (bundleId) {
    candidates.push(path.join(HOME, 'Library/Preferences', `${bundleId}.plist`));
    candidates.push(path.join(HOME, 'Library/Saved Application State', `${bundleId}.savedState`));
  }
  candidates.push(path.join(HOME, 'Library/Application Support', name));
  candidates.push(path.join(HOME, 'Library/Caches', name));

  const residuals = [];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    let st;
    try { st = await fs.promises.stat(p); } catch { continue; }
    residuals.push({
      path: p,
      name: path.basename(p),
      size: st.isDirectory() ? dirSizeQuick(p) : st.size,
      kind: kindOf(p, bundleId),
    });
  }
  return residuals;
}

function kindOf(p, bundleId) {
  const s = String(p);
  if (s.includes('Preferences')) return 'preferences';
  if (s.includes('Application Support')) return 'support';
  if (s.includes('Caches')) return 'caches';
  if (s.includes('Saved Application State')) return 'savedState';
  return 'other';
}

// 执行卸载：app + residuals 全部走 safeTrash（isUninstallTarget 白名单校验）
// 返回 { ok, moved, failed, report }
async function uninstall(app, residuals) {
  const entries = [
    { path: app && app.path, name: app && app.name, size: (app && app.size) || 0 },
    ...(Array.isArray(residuals) ? residuals : []).map((r) => ({ path: r.path, name: r.name, size: r.size || 0 })),
  ];
  return trashWithConfirm(entries, { allowUninstall: true });
}

module.exports = {
  APP_DIRS,
  listApps,
  scanResiduals,
  uninstall,
  readBundleId,
  dirSizeQuick,
  isRunning,
  kindOf,
};