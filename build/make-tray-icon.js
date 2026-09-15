// 生成 macOS 菜单栏单色模板图：build/trayTemplate.png（22×22）与 build/trayTemplate@2x.png（44×44）
// v2.1 P2-1：避免用彩色应用图标当模板图（会被压成实心剪影）。
// 零第三方依赖：用 Node 内置 zlib 手动编码 PNG。运行：node build/make-tray-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { makeTemplateBitmap } = require('../main/core/trayIcon.js');

// ---- 最小 PNG 编码器（RGBA / 8bit）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width, height, bgra) {
  const stride = width * 4 + 1; // 每行前置 1 字节 filter(type 0)
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * stride + 1 + x * 4;
      raw[d] = bgra[s + 2];     // R
      raw[d + 1] = bgra[s + 1]; // G
      raw[d + 2] = bgra[s];     // B
      raw[d + 3] = bgra[s + 3]; // A
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeIcon(size, file) {
  const { width, height, buffer } = makeTemplateBitmap(size);
  fs.writeFileSync(path.join(__dirname, file), encodePng(width, height, buffer));
  console.log(`✅ ${file} (${width}×${height})`);
}

writeIcon(22, 'trayTemplate.png');
writeIcon(44, 'trayTemplate@2x.png');
console.log('TRAY_ICON_OK');
