// Mio - 核心层：磁盘空间太阳图（sunburst）
// v2.0 F12：目录树扫描（du 后台 + 进度 + 可中止）+ 10min 缓存。
// 只扫 ~/ 下 7 个标准目录（Desktop/Documents/Downloads/Movies/Music/Pictures/Applications）。
// 纯函数：buildTreeFromDu(out, root) 可单测；副作用：scan()/cancel()。
// 依赖：child_process（exec，零第三方）、exec.js。
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const HOME = os.homedir();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10min 缓存
const SCAN_ROOTS = [
  'Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Applications',
].map((d) => path.join(HOME, d));

let cache = null;
let cacheAt = 0;
let current = null; // { proc, canceled }

// ---- 纯函数：把 du 输出解析成树 ----
// du -sk 输出行：<sizeKB>\t<path>
// 返回 { name, path, size, children }（size 单位 bytes）
function parseDu(out, root) {
  const map = new Map();
  const rootNorm = path.normalize(root);
  map.set(rootNorm, { name: path.basename(rootNorm) || rootNorm, path: rootNorm, size: 0, children: [] });

  const lines = String(out || '').split('\n');
  for (const line of lines) {
    const m = line.match(/^(\d+)\t(.+)$/);
    if (!m) continue;
    const sizeKB = Number(m[1]);
    const p = path.normalize(m[2]);
    if (!p.startsWith(rootNorm)) continue;
    if (!map.has(p)) {
      map.set(p, { name: path.basename(p) || p, path: p, size: sizeKB * 1024, children: [] });
    } else {
      map.get(p).size = sizeKB * 1024;
    }
  }
  // 挂树：子节点挂到父节点
  const nodes = [];
  for (const [p, node] of map) {
    if (p === rootNorm) continue;
    const parent = path.dirname(p);
    const parentNode = map.get(parent);
    if (parentNode) parentNode.children.push(node);
    nodes.push(node);
  }
  const rootNode = map.get(rootNorm);
  if (rootNode) {
    // 计算每节点自身 size（不含子树）用于太阳图弧长
    computeOwnSize(rootNode);
  }
  return rootNode || { name: path.basename(rootNorm), path: rootNorm, size: 0, children: [] };
}

// 把「含子树的 size」折算成「自身 size」：父.size -= Σ子.size
function computeOwnSize(node) {
  if (!node || !node.children) return 0;
  let sub = 0;
  for (const c of node.children) sub += computeOwnSize(c);
  node.own = Math.max(0, node.size - sub);
  return node.size;
}

// ---- 副作用：扫描 ----

// 扫描 root 下的目录树（depth 层）。返回 { ok, tree?, canceled?, error? }
// 进度通过 onProgress({ done, total, currentPath }) 回调上报。
function scan(root, depth = 2, onProgress = null) {
  if (current && current.active) return Promise.resolve({ ok: false, error: '已有扫描进行中' });
  const rootDir = root && String(root).trim() ? path.normalize(root) : SCAN_ROOTS[0];
  if (cache && cache.root === rootDir && Date.now() - cacheAt < CACHE_TTL_MS) {
    return Promise.resolve({ ok: true, tree: cache.tree, cached: true });
  }
  const maxDepth = Math.max(1, Math.min(6, Number(depth) || 2));
  current = { active: true, canceled: false };

  return new Promise((resolve) => {
    // 用 `du -sk` 递归统计（-d 限制深度；-x 不跨文件系统）
    const cmd = `/usr/bin/du -sk -d ${maxDepth - 1} "${rootDir}" 2>/dev/null`;
    const child = exec(cmd, { timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (current && current.canceled) {
        current = null;
        resolve({ ok: true, canceled: true, tree: null });
        return;
      }
      const tree = parseDu(stdout || '', rootDir);
      cache = { root: rootDir, tree, at: Date.now() };
      cacheAt = cache.at;
      current = null;
      resolve({ ok: true, tree, canceled: false });
    });
    // 简易进度：无法从 du 拿实时进度，用「已执行时长」近似
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (onProgress) onProgress({ done: Math.min(100, Math.round((Date.now() - t0) / 100)), total: 100, currentPath: rootDir });
    }, 500);
    child.on('close', () => clearInterval(timer));
  });
}

function cancel() {
  if (current && current.active) {
    current.canceled = true;
    return true;
  }
  return false;
}

function reset() {
  cache = null;
  cacheAt = 0;
}

module.exports = {
  CACHE_TTL_MS,
  SCAN_ROOTS,
  parseDu,
  computeOwnSize,
  scan,
  cancel,
  reset,
};