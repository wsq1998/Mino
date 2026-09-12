// Mio - 核心层：常用文本片段（snippets）
// v2.0 F11：本地 CRUD + 明文落盘（mio-snippets.json，UI 需披露「明文存储」）。
// 上限 20 条 / 2000 字符；与剪贴板历史不共享暂停。
// 依赖：electron app（userData 路径）、fs、path。
const path = require('path');
const fs = require('fs');

function electron() {
  try { return require('electron'); } catch { return {}; }
}

const snippetsFile = () => path.join(electron().app.getPath('userData'), 'mio-snippets.json');
const MAX_ITEMS = 20;
const MAX_TEXT = 2000;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(snippetsFile(), 'utf8'));
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

function persist(items) {
  try {
    fs.writeFileSync(snippetsFile(), JSON.stringify({ items: Array.isArray(items) ? items : [] }));
    return true;
  } catch {
    return false;
  }
}

function list() {
  return load();
}

// 新增片段：{ name, text }。返回 { ok, item?, items?, error? }
function add(s) {
  const name = String((s && s.name) || '').trim().slice(0, 40);
  const text = String((s && s.text) || '');
  if (!name) return { ok: false, error: '名称不能为空' };
  if (!text) return { ok: false, error: '内容不能为空' };
  if (text.length > MAX_TEXT) return { ok: false, error: `内容不能超过 ${MAX_TEXT} 字符` };
  const items = load();
  if (items.length >= MAX_ITEMS) return { ok: false, error: `最多 ${MAX_ITEMS} 条` };
  const item = {
    id: `snip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    text,
    createdAt: Date.now(),
  };
  items.unshift(item);
  persist(items);
  return { ok: true, item, items };
}

function update(id, s) {
  const items = load();
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return { ok: false, error: '未找到' };
  const name = String((s && s.name) !== undefined ? s.name : items[idx].name || '').trim().slice(0, 40);
  const text = String((s && s.text) !== undefined ? s.text : items[idx].text);
  if (!name) return { ok: false, error: '名称不能为空' };
  if (text.length > MAX_TEXT) return { ok: false, error: `内容不能超过 ${MAX_TEXT} 字符` };
  items[idx] = { ...items[idx], name, text };
  persist(items);
  return { ok: true, item: items[idx], items };
}

function remove(id) {
  const items = load();
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return { ok: false, error: '未找到' };
  items.splice(idx, 1);
  persist(items);
  return { ok: true, items };
}

// 取片段文本：返回 { ok, text?, error? }；真正粘贴由 main.js IPC 决定写入方式
function insert(id) {
  const items = load();
  const it = items.find((x) => x.id === id);
  if (!it) return { ok: false, error: '未找到' };
  return { ok: true, text: it.text, mode: 'clipboard' };
}

module.exports = {
  snippetsFile,
  MAX_ITEMS,
  MAX_TEXT,
  load,
  persist,
  list,
  add,
  update,
  remove,
  insert,
};