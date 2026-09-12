// Mio - 清理域：扫描目标 / 路径黑名单（纯数据 + 纯函数，无副作用）
// B4-4 拆分：从 main.js 抽出。零行为变化。
// 依赖：os、path（Node 内置）。

const os = require('os');
const path = require('path');

const HOME = os.homedir();
const SCAN_TARGETS = [
  { id: 'user-caches', name: '用户缓存', dir: path.join(HOME, 'Library/Caches'), level: 'green', note: '应用缓存，删除后自动重建' },
  { id: 'user-logs', name: '用户日志', dir: path.join(HOME, 'Library/Logs'), level: 'green', note: '历史日志文件' },
  { id: 'npm-cache', name: 'npm 缓存', dir: path.join(HOME, '.npm/_cacache'), level: 'green', note: '包下载缓存' },
  { id: 'pip-cache', name: 'pip 缓存', dir: path.join(HOME, 'Library/Caches/pip'), level: 'green', note: '包下载缓存' },
  { id: 'xcode-derived', name: 'Xcode DerivedData', dir: path.join(HOME, 'Library/Developer/Xcode/DerivedData'), level: 'green', note: '构建产物，可安全删除' },
  { id: 'trash', name: '废纸篓', dir: path.join(HOME, '.Trash'), level: 'yellow', note: '清空后不可恢复' },
];

// 清理安全：路径黑名单（展示与执行共用）
function isBlacklistedPath(p) {
  if (typeof p !== 'string' || !p) return true;
  const norm = path.normalize(p);
  // 系统级目录永不展示/清理
  if (norm.startsWith('/System') || norm.startsWith('/usr') || norm === '/Library' || norm.startsWith('/Library/')) return true;
  // 仅限用户目录
  if (!norm.startsWith(HOME + path.sep)) return true;
  const rel = norm.slice(HOME.length);
  const badPrefixes = [
    '/Library/Containers', '/Library/Group Containers', // 沙盒数据
    '/Library/Keychains', '/Library/Mail',              // 钥匙串 / 邮件
  ];
  if (badPrefixes.some((b) => rel === b || rel.startsWith(b + path.sep))) return true;
  if (rel.includes('Photos Library')) return true;      // 照片图库
  return false;
}

// v2.0 F7 卸载白名单扩展：只对 safeTrash 放行的卸载目标路径。
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
  if (/^\/Library\/Preferences\/[^/]+\.plist$/.test(rel)) return true;
  if (/^\/Library\/Application Support\/[^/]+/.test(rel)) return true;
  if (/^\/Library\/Caches\/[^/]+/.test(rel)) return true;
  if (/^\/Library\/Saved Application State\/[^/]+\.savedState$/.test(rel)) return true;
  return false;
}

module.exports = { HOME, SCAN_TARGETS, isBlacklistedPath, isUninstallTarget };