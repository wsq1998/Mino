// Mio - 核心层：文件暂存区 / 中转站（stash）
// v2.5 临时目录语义：中转站拥有**独立存储目录**（路径可在设置中配置）。
//   拖入 = 把源文件「复制」一份进中转站目录（源文件保留不动，绝不移动/删除源文件）；
//   拖出 = 从中转站目录原生拖出该副本；
//   移除 = 把副本移入废纸篓（只用 shell.trashItem，绝不 rm/unlink，绝不触碰源文件）。
// 索引落盘：mio-stash.json（只存元数据，不含文件本体）。
// 依赖：electron app/shell（userData 路径 + 废纸篓）、fs、path、os。
const path = require('path');
const fs = require('fs');
const os = require('os');

function electron() {
  try { return require('electron'); } catch { return {}; }
}

const stashFile = () => path.join(electron().app.getPath('userData'), 'mio-stash.json');
const MAX_ITEMS = 100;
const DEFAULT_DIR_NAME = 'Mio中转站';

// 当前生效的中转站目录（由主进程在设置载入/变更时注入；空串 = 用默认位置）
let currentDir = '';

/** 主进程注入设置里的 stash.dir（空串表示用默认目录）。 */
function setDir(dir) { currentDir = String(dir || '').trim(); }

/** 默认目录：下载目录下的 Mio中转站（拿不到 downloads 时退回临时目录）。 */
function defaultDir() {
  try { return path.join(electron().app.getPath('downloads'), DEFAULT_DIR_NAME); }
  catch { return path.join(os.tmpdir(), DEFAULT_DIR_NAME); }
}

/** 解析实际生效的中转站目录（显式入参 > 注入值 > 默认）。 */
function stashDir(explicit) {
  const d = String(explicit || currentDir || '').trim();
  return d || defaultDir();
}

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

/** 生成不冲突的目标文件名：name / name (2).ext / name (3).ext … */
function uniqueTarget(dir, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let target = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(target)) {
    i += 1;
    target = path.join(dir, `${stem} (${i})${ext}`);
  }
  return target;
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(stashFile(), 'utf-8'));
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

function persist(items) {
  try {
    fs.writeFileSync(stashFile(), JSON.stringify({ items: Array.isArray(items) ? items : [] }));
    return true;
  } catch {
    return false;
  }
}

// 列表：exists 以「中转站目录内副本」是否存在为准
function list() {
  const items = load();
  return items.map((it) => {
    let exists = false;
    let size = it.size || 0;
    try {
      const st = fs.statSync(it.path);
      exists = true;
      size = it.isDir ? 0 : st.size;
    } catch {}
    return { ...it, exists, size };
  });
}

// 加入中转站：{ path } → 把源文件复制进中转站目录（源文件保留不动）。
// 返回 { ok, item?, items?, error? }。dirOverride 可显式指定目录，否则用已注入目录。
function add(p, dirOverride) {
  const raw = String((p && p.path) || p || '').trim();
  if (!raw) return { ok: false, error: '路径为空' };
  const abs = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { ok: false, error: '文件不存在' };
  }
  const items = load();
  if (items.length >= MAX_ITEMS) return { ok: false, error: `最多 ${MAX_ITEMS} 项` };
  // 同「源文件」去重：同一个来源已在中转站里就不再重复复制
  if (items.some((it) => it.srcPath === abs)) return { ok: false, error: '已在暂存区' };

  const dir = stashDir(dirOverride);
  ensureDir(dir);
  const name = path.basename(abs) || `item_${Date.now()}`;
  const target = uniqueTarget(dir, name);
  try {
    if (st.isDirectory()) fs.cpSync(abs, target, { recursive: true });
    else fs.copyFileSync(abs, target);
  } catch (err) {
    return { ok: false, error: `复制失败：${String((err && err.message) || err).slice(0, 80)}` };
  }

  let size = 0;
  const isDir = st.isDirectory();
  try { const tst = fs.statSync(target); size = isDir ? 0 : tst.size; } catch {}

  const item = {
    id: `stash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    path: target,      // 中转站目录内的副本（真正的「持有物」，拖出/打开/显示都指向它）
    srcPath: abs,      // 源文件位置（仅作参考展示）
    name,
    size,
    isDir,
    addedAt: Date.now(),
  };
  items.unshift(item);
  persist(items);
  return { ok: true, item, items };
}

// 把某个条目的「副本」移入废纸篓（绝不 rm/unlink，绝不触碰源文件）。
// legacy 条目（无 srcPath，来自旧「路径引用」版本）只删索引，不回收任何文件。
async function trashCopy(it) {
  if (!it || !it.srcPath) return false;
  try {
    const sh = electron().shell;
    if (sh && typeof sh.trashItem === 'function') { await sh.trashItem(it.path); return true; }
  } catch {}
  return false;
}

// 移除一项：副本进废纸篓 + 删索引
async function remove(id) {
  const items = load();
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return { ok: false, error: '未找到' };
  const it = items[idx];
  await trashCopy(it);
  items.splice(idx, 1);
  persist(items);
  return { ok: true, items };
}

// 清空：所有副本进废纸篓（绝不触碰源文件）
async function clear() {
  const items = load();
  for (const it of items) { await trashCopy(it); }
  persist([]);
  return { ok: true, items: [] };
}

module.exports = {
  stashFile,
  MAX_ITEMS,
  DEFAULT_DIR_NAME,
  setDir,
  stashDir,
  defaultDir,
  load,
  persist,
  list,
  add,
  remove,
  clear,
};
