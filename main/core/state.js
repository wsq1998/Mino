// Mio - 核心层：状态持久化（mio-state.json 的读/写）
// B4-4 拆分：从 main.js 抽出。零行为变化。
// 依赖：electron app（仅用于 userData 路径）、fs、path。

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const stateFile = path.join(app.getPath('userData'), 'mio-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}
function saveState(patch) {
  const next = { ...loadState(), ...patch };
  try { fs.writeFileSync(stateFile, JSON.stringify(next)); } catch {}
}

module.exports = { stateFile, loadState, saveState };