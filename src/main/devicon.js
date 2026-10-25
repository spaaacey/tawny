'use strict';
const { nativeImage } = require('electron');

// 5x7 glyphs, one string per row
const GLYPHS = {
  D: ['1111 ', '1   1', '1   1', '1   1', '1   1', '1   1', '1111 '],
  E: ['11111', '1    ', '1    ', '1111 ', '1    ', '1    ', '11111'],
  V: ['1   1', '1   1', '1   1', '1   1', '1   1', ' 1 1 ', '  1  '],
};
const YELLOW = [229, 180, 84];
const AMBER = [201, 154, 58];
const INK = [26, 19, 5];

/** The app icon with a hazard-striped "DEV" band across the bottom, matching the in-app dev banner. */
function devIcon(file) {
  const src = nativeImage.createFromPath(file);
  const { width: w, height: h } = src.getSize();
  const buf = Buffer.from(src.toBitmap());   // BGRA
  // the artwork is padded inside the canvas, so lay the band out against its opaque bounds
  let x0 = w, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (buf[(y * w + x) * 4 + 3]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y1 = y; }
  }
  const size = x1 - x0;
  const bandTop = Math.round(y1 - size * 0.28);
  const cell = Math.floor(size * 0.28 * 0.5 / 7);
  const textW = (3 * 5 + 2) * cell, textH = 7 * cell;
  const tx = Math.round((x0 + x1 - textW) / 2), ty = Math.round((bandTop + y1 - textH) / 2);
  const plate = cell * 1.2;

  const inText = (x, y) => {
    const cx = Math.floor((x - tx) / cell), cy = Math.floor((y - ty) / cell);
    if (cy < 0 || cy > 6 || cx < 0 || cx >= 17) return false;
    const g = GLYPHS['DEV'[Math.floor(cx / 6)]];
    return cx % 6 < 5 && g[cy][cx % 6] === '1';
  };

  for (let y = bandTop; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!buf[i + 3]) continue;   // keep the icon's own shape
      const onPlate = x > tx - plate && x < tx + textW + plate && y > ty - plate && y < ty + textH + plate;
      const c = inText(x, y) ? INK : onPlate ? YELLOW : ((x + y) % 80 < 40 ? YELLOW : AMBER);
      buf[i] = c[2]; buf[i + 1] = c[1]; buf[i + 2] = c[0]; buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

module.exports = { devIcon };
