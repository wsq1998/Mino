// Mio - 核心层：菜单栏模板图（纯函数、零副作用、不 require electron）
// v2.1 P2-1：为 macOS 菜单栏生成「单色模板图」所需的 BGRA 像素缓冲。
//
// 原理：macOS 的 template image 只看 alpha 通道（非透明像素由系统按菜单栏深浅自动着色），
// 所以这里输出「纯黑 + alpha」即可；彩色应用图标直接当模板图会被压成实心剪影，观感差。
// 图案：向下箭头 + 底座横杠（表示「收进中转站」）。用 4×4 超采样做抗锯齿。
//
// 依赖：无（仅内置 Math/Buffer）—— 便于 node --test 直接单测，也便于 build 脚本复用。

/**
 * 生成菜单栏模板图的 BGRA 像素缓冲。
 * @param {number} [size=16] 目标像素边长（正方形）
 * @returns {{width:number, height:number, buffer:Buffer}} BGRA 顺序、黑色、alpha 承载形状
 */
function makeTemplateBitmap(size = 16) {
  const W = Math.max(8, Math.round(Number(size) || 16));
  const H = W;
  const SS = 4; // 每像素 4×4 超采样，用于抗锯齿

  // 设计坐标系固定为 16×16，再按归一化映射到目标分辨率
  const inShape = (ux, uy) => {
    const x = ux * 16;
    const y = uy * 16;
    // 箭杆
    if (x >= 7 && x <= 9 && y >= 1.5 && y <= 9) return true;
    // 箭头（倒三角：y=8.5 处最宽 ±4.5，收敛到 y=12.5 的顶点）
    if (y >= 8.5 && y <= 12.5) {
      const t = (12.5 - y) / 4;
      if (Math.abs(x - 8) <= 4.5 * t) return true;
    }
    // 底座横杠
    if (y >= 13 && y <= 14.5 && x >= 3 && x <= 13) return true;
    return false;
  };

  const buffer = Buffer.alloc(W * H * 4);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (px + (sx + 0.5) / SS) / W;
          const uy = (py + (sy + 0.5) / SS) / H;
          if (inShape(ux, uy)) hit++;
        }
      }
      const a = Math.round((255 * hit) / (SS * SS));
      const i = (py * W + px) * 4;
      buffer[i] = 0;     // B
      buffer[i + 1] = 0; // G
      buffer[i + 2] = 0; // R
      buffer[i + 3] = a; // A
    }
  }
  return { width: W, height: H, buffer };
}

module.exports = { makeTemplateBitmap };
