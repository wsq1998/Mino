// Mio - 核心层：网络 IP（ipnet）
// v2.0 F6：内网 IP（ipconfig getifaddr，回退 en1/utun）+ 公网 IP（api.ip.sb/geoip）。
// 纯函数 + 副作用分离；公网 IP 复用 geoCache 24h 缓存语义（模块内部持有）。
// 依赖：child_process、electron clipboard（仅 copy）、exec.js（runCmd/fetchJson）。
const { runCmd, fetchJson } = require('./exec.js');

// 惰性取 electron：纯函数层在 node --test 下也能加载
function electron() {
  try { return require('electron'); } catch { return {}; }
}

const GEO_TTL_MS = 24 * 3600 * 1000; // 公网 IP 缓存 24h（设计 §1.1 F6 复用 geoCache）
let geoCache = null;
let geoCacheAt = 0;

// ---- 内网 IP ----
// 依次尝试 en0 / en1 / utun0…，返回第一个有值的 IPv4 地址；全部失败返回 ''。
async function lanIp() {
  const ifaces = ['en0', 'en1', 'utun0', 'utun1', 'utun2', 'utun3'];
  for (const iface of ifaces) {
    const r = await runCmd('/usr/sbin/ipconfig', ['getifaddr', iface], 3000);
    const v = String(r.stdout || '').trim();
    if (v && /^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v;
  }
  return '';
}

// ---- 公网 IP ----
// api.ip.sb/geoip 返回 { ip, ... }；失败或断网返回 ''（渲染层显示「—」）。
async function publicIp() {
  if (geoCache && Date.now() - geoCacheAt < GEO_TTL_MS) return geoCache;
  try {
    const data = await fetchJson('https://api.ip.sb/geoip', 8000);
    const ip = data && typeof data.ip === 'string' ? data.ip.trim() : '';
    if (ip) {
      geoCache = ip;
      geoCacheAt = Date.now();
    }
    return ip;
  } catch {
    return '';
  }
}

// 复制 IP 到剪贴板
function copy(ip) {
  try {
    electron().clipboard.writeText(String(ip || ''));
    return true;
  } catch {
    return false;
  }
}

// 清公网缓存（测试用）
function reset() {
  geoCache = null;
  geoCacheAt = 0;
}

module.exports = { GEO_TTL_MS, lanIp, publicIp, copy, reset };