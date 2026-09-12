// Mio - 核心层：通用执行 / 网络工具（纯函数，无共享可变状态）
// B4-4 拆分：从 main.js 抽出。零行为变化。
// 依赖：child_process（Node 内置，零第三方）。

const { exec, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// 通用 shell 命令：成功/失败都返回 stdout 字符串（忽略 stderr 与退出码）
function execP(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: opts.timeout || 15000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
      resolve((stdout || '').toString());
    });
  });
}

// 结构化命令执行：返回 { ok, stdout, stderr, err }，调用方自行判断
function runCmd(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err }));
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: '', err });
    }
  });
}

// JSON fetch（Node 20 内置 fetch，零依赖）；超时用 AbortSignal
const fetchJson = async (url, timeout = 8000) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// 目录体积估算：遍历（预算内），返回 { size, files }。零依赖，容错（读不到就跳过）
async function dirSize(dir, budgetMs = 8000) {
  const start = Date.now();
  let total = 0;
  let count = 0;
  async function walk(d) {
    if (Date.now() - start > budgetMs) return;
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (Date.now() - start > budgetMs) return;
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) {
          await walk(p);
        } else if (e.isFile()) {
          const st = await fs.promises.stat(p);
          total += st.size;
          count++;
        }
      } catch {}
    }
  }
  await walk(dir);
  return { size: total, files: count };
}

module.exports = { execP, runCmd, fetchJson, dirSize };