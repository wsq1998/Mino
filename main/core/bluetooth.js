// Mio - 核心层：蓝牙设备电量（bluetooth）
// v2.0 F3：`system_profiler SPBluetoothDataType` 输出解析（纯函数）+ 主进程 60s 缓存。
// 输出格式多版本兼容：Apple Silicon / Intel、macOS 12–15 的缩进与字段名差异。
//
// 分层：
//   - 纯函数：parseProfiler(out) —— 输入 system_profiler 原始 stdout，输出 Device[]
//   - 副作用：scan() —— 执行命令 + 60s 缓存；reset() 清缓存（测试用）
// 依赖：child_process（Node 内置）、exec.js 的 runCmd（复用零第三方）。
const { runCmd } = require('./exec.js');

const TTL_MS = 60000; // 缓存 60s（命令本身 2–5s，必须缓存）

// ---- 纯函数：解析 system_profiler 输出 ----
// 输出结构（缩进敏感）：
//   Bluetooth:
//       Connected:
//           AirPods Pro:
//               Address: xx:xx:xx:xx:xx:xx
//               ...
//               Battery Level: 80
//   （Not Connected 同理）
// 兼容：有些版本 Battery Level 写作 "Battery Level: 80"（0-100），
//       有些版本写作 "Battery Level: 0x64"（十六进制），或 "Battery: 80%"。
function parseProfiler(out) {
  const text = String(out || '');
  const lines = text.split('\n');
  const devices = [];
  let section = null;      // 'Connected' | 'Not Connected' | null
  let current = null;      // 正在解析的设备
  let indent = 0;

  const flush = () => {
    if (current) devices.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const lead = line.match(/^(\s*)/)[1].length;
    const content = line.trim();

    if (content === 'Connected:') { section = 'Connected'; flush(); continue; }
    if (content === 'Not Connected:') { section = 'Not Connected'; flush(); continue; }
    if (content === 'Bluetooth:' || content === 'Bluetooth') { section = null; flush(); continue; }
    // 顶层其它大节（如 "Paired Devices:"）不在这版解析范围
    if (section === null) continue;

    // 设备名：以冒号结尾且不是已知字段 → 新设备块。
    // 注意：设备块内可能还有子节（如 Services: / Connected: / Minor Type:），
    // 用「缩进与设备名相同」来区分 —— 子节缩进更深，不当作新设备。
    if (/:\s*$/.test(content) && !/^Address:/.test(content) && !/^Battery Level:/.test(content) && !/^Connected:/.test(content) && !/^Not Connected:/.test(content)) {
      if (!current || lead <= indent) {
        flush();
        current = { name: content.replace(/:$/, '').trim(), connected: section === 'Connected', battery: null };
        indent = lead;
      }
      continue;
    }

    if (!current) continue;

    // 字段解析（只认当前设备块内、缩进 ≥ 设备缩进的字段）
    if (lead > indent || lead === indent) {
      const addr = content.match(/^Address:\s*(.+)$/);
      if (addr) { current.address = addr[1].trim(); continue; }
      const batt = content.match(/^Battery Level:\s*(.+)$/);
      if (batt) {
        current.battery = parseBattery(batt[1]);
        continue;
      }
    }
  }
  flush();
  return devices;
}

// Battery Level 字段多版本兼容：
//   "42" / "42%" → 42
//   "0x64" / "0x64%" → 100（system_profiler 用 0x00–0x64 表示 0–100%）
//   "100%" → 100；无法解析 → null
function parseBattery(v) {
  const s = String(v || '').trim().replace(/%$/, '');
  if (/^0x[0-9a-fA-F]+$/.test(s)) {
    const n = parseInt(s, 16);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// ---- 副作用：扫描 + 缓存 ----

let cache = null;
let cacheAt = 0;

async function scan() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  const r = await runCmd('/usr/sbin/system_profiler', ['SPBluetoothDataType', '-json'], 15000);
  if (!r.ok) {
    // 有的系统不支持 -json，回退纯文本
    const r2 = await runCmd('/usr/sbin/system_profiler', ['SPBluetoothDataType'], 15000);
    const devices = parseProfiler(r2.stdout);
    cache = devices;
    cacheAt = Date.now();
    return devices;
  }
  let devices = [];
  try {
    const data = JSON.parse(r.stdout);
    const bt = data && data.SPBluetoothDataType && data.SPBluetoothDataType[0];
    const connected = (bt && bt.device_connected) || [];
    const notConnected = (bt && bt.device_not_connected) || [];
    const items = [
      ...(Array.isArray(connected) ? connected : []).map((d) => ({ d, connected: true })),
      ...(Array.isArray(notConnected) ? notConnected : []).map((d) => ({ d, connected: false })),
    ];
    devices = items.map(({ d, connected }) => {
      const info = d && (connected ? d.device_connected : d.device_not_connected);
      const key = Object.keys(info || {})[0];
      const meta = key ? info[key] : {};
      return {
        name: key || '',
        connected,
        address: (meta && meta.device_address) || '',
        battery: parseBattery(meta && meta.device_batteryLevel),
      };
    });
  } catch {
    // JSON 解析失败 → 回退纯文本
    const r2 = await runCmd('/usr/sbin/system_profiler', ['SPBluetoothDataType'], 15000);
    devices = parseProfiler(r2.stdout);
  }
  cache = devices;
  cacheAt = Date.now();
  return devices;
}

// 清缓存（测试 / 设置变更后强制刷新）
function reset() {
  cache = null;
  cacheAt = 0;
}

module.exports = { TTL_MS, parseProfiler, parseBattery, scan, reset };