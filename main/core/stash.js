// Mio - 核心层：文件暂存区 / 中转站（stash）
// v2.0 F10：只记路径引用（fs.stat 只读元数据），不移动/不复制/不删除源文件。
// 源文件被删 → 显示「文件不存在」；清空只删引用（不删文件），仍走二次确认。
// 落盘：mio-stash.json。
// 依赖：electron app（userData 路径）、fs、path。
const path = require('path');
const fs = require('fs');

function electron() {
  try { return require('electron'); } catch { return {}; }
}

const stashFile = () => path.join(electron().app.getPath('userData'), 'mio-stash.json');
const MAX_ITEMS = 100;

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

function list() {
  const items = load();
  return items.map((it) => {
    let exists = false;
    let size = it.size || 0;
    try {
      const st = fs.statSync(it.path);
      exists = true;
      size = st.size;
    } catch {}
    return { ...it, exists, size };
  });
}

// 加入中转站：{ path }。只存引用，不移动/复制源文件。
// 返回 { ok, item?, items?, error? }
function add(p) {
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
  if (items.some((it) => it.path === abs)) return { ok: false, error: '已在暂存区' };
  const item = {
    id: `stash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    path: abs,
    name: path.basename(abs),
    size: st.isDirectory() ? 0 : st.size,
    isDir: st.isDirectory(),
    addedAt: Date.now(),
  };
  items.unshift(item);
  persist(items);
  return { ok: true, item, items };
}

function remove(id) {
  const items = load();
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return { ok: false, error: '未找到' };
  items.splice(idx, 1);
  persist(items);
  return { ok: true, items };
}

// 清空引用（不删任何源文件）
function clear() {
  persist([]);
  return { ok: true, items: [] };
}

module.exports = {
  stashFile,
  MAX_ITEMS,
  load,
  persist,
  list,
  add,
  remove,
  clear,
};