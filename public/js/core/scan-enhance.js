// Image clean-up for scanned pages. Pure functions on RGBA pixel arrays.
//
// Photos of paper are lit unevenly: shadows from the phone, a gradient from
// the window, a warm cast from a lamp. The "document" filters estimate that
// lighting as a smooth background map (the brightest values in coarse
// blocks, spread and blurred so text and thin lines don't count), divide it
// out so paper becomes evenly white, then stretch the contrast and sharpen
// edges so text reads crisply.

import { boxBlur, otsuThreshold } from './scan-geometry.js';

export const SCAN_FILTERS = Object.freeze(['auto', 'gray', 'bw', 'original']);

const clamp255 = (value) => (value < 0 ? 0 : value > 255 ? 255 : value);

/**
 * Low-resolution map of the paper's brightness for one channel.
 * Returns { map, cols, rows, block }.
 */
function backgroundMap(channelAt, width, height) {
  const block = Math.max(4, Math.round(Math.max(width, height) / 90));
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  let map = new Float32Array(cols * rows);
  for (let by = 0; by < rows; by += 1) {
    const yEnd = Math.min(height, (by + 1) * block);
    for (let bx = 0; bx < cols; bx += 1) {
      const xEnd = Math.min(width, (bx + 1) * block);
      let max = 0;
      // Every other pixel is plenty for a block maximum and halves the cost.
      for (let y = by * block; y < yEnd; y += 2) {
        for (let x = bx * block; x < xEnd; x += 2) {
          const value = channelAt(y * width + x);
          if (value > max) max = value;
        }
      }
      map[by * cols + bx] = max;
    }
  }
  // Spread the brightest blocks over dark areas (bold headings, dark
  // boxes) so they keep their tone instead of being lifted to white.
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Float32Array(map.length);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        let max = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = Math.min(rows - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx += 1) {
            const value = map[yy * cols + Math.min(cols - 1, Math.max(0, x + dx))];
            if (value > max) max = value;
          }
        }
        next[y * cols + x] = max;
      }
    }
    map = next;
  }
  boxBlur(map, cols, rows, 2);
  boxBlur(map, cols, rows, 2);
  for (let i = 0; i < map.length; i += 1) map[i] = Math.max(map[i], 24);
  return { map, cols, rows, block };
}

/** Calls `visit(index, scale)` with 255 / background for every pixel (bilinear upsampling of the map). */
function forEachNormalized({ map, cols, rows, block }, width, height, visit) {
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(rows - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = gy | 0;
    const y1 = Math.min(rows - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(cols - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = gx | 0;
      const x1 = Math.min(cols - 1, x0 + 1);
      const fx = gx - x0;
      const top = map[y0 * cols + x0] * (1 - fx) + map[y0 * cols + x1] * fx;
      const bottom = map[y1 * cols + x0] * (1 - fx) + map[y1 * cols + x1] * fx;
      visit(y * width + x, 255 / (top * (1 - fy) + bottom * fy));
    }
  }
}

/** Percentile of 0–255 values, sampling every 7th value. */
function percentile(values, fraction) {
  const histogram = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < values.length; i += 7) {
    histogram[values[i] | 0] += 1;
    count += 1;
  }
  const target = count * fraction;
  let seen = 0;
  for (let v = 0; v < 256; v += 1) {
    seen += histogram[v];
    if (seen >= target) return v;
  }
  return 255;
}

/** Tone curve: black point → 0, white point → 255, with a slight darkening of mid-tones for bolder text. */
function levelsTable(black, white, gamma) {
  const table = new Uint8ClampedArray(256);
  const range = Math.max(1, white - black);
  for (let v = 0; v < 256; v += 1) {
    const t = Math.min(1, Math.max(0, (v - black) / range));
    table[v] = Math.round(255 * t ** gamma);
  }
  return table;
}

/** Unsharp mask with a 4-neighbour kernel, on one channel (stride 1) or RGBA (stride 4). */
function sharpen(values, width, height, stride, channels, amount) {
  const source = values.slice();
  const rowStride = width * stride;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * rowStride + x * stride;
      for (let c = 0; c < channels; c += 1) {
        const i = p + c;
        const neighbours = source[i - stride] + source[i + stride] + source[i - rowStride] + source[i + rowStride];
        values[i] = clamp255(source[i] * (1 + 4 * amount) - amount * neighbours);
      }
    }
  }
  return values;
}

/** Lighting-normalised luma: paper ≈ 255 regardless of shadows. */
export function normalizedLuma(rgba, width, height) {
  const luma = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < luma.length; i += 1, p += 4) {
    luma[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  const background = backgroundMap((i) => luma[i], width, height);
  forEachNormalized(background, width, height, (i, scale) => {
    luma[i] = luma[i] * scale;
  });
  return luma;
}

function grayToRgba(gray, rgba) {
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    rgba[p] = gray[i];
    rgba[p + 1] = gray[i];
    rgba[p + 2] = gray[i];
    rgba[p + 3] = 255;
  }
  return rgba;
}

/** Packs greyscale into 1 bit per pixel (1 = white), rows padded to whole bytes, as PDF expects. */
export function packBits(gray, width, height, threshold) {
  const rowBytes = Math.ceil(width / 8);
  const bits = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (gray[y * width + x] > threshold) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return bits;
}

/** Threshold for black-and-white output, kept in a safe range so faint text survives. */
export function bwThreshold(gray) {
  return Math.min(205, Math.max(150, otsuThreshold(gray) + 10));
}

/**
 * Applies a scan filter in place to an RGBA image and returns
 * { rgba, gray?, threshold? }. For "bw", `gray` holds the cleaned luma and
 * `threshold` the cut-off; `rgba` is the thresholded preview.
 */
export function applyScanFilter(rgba, width, height, filter) {
  if (filter === 'original') return { rgba };

  if (filter === 'gray' || filter === 'bw') {
    const luma = normalizedLuma(rgba, width, height);
    const black = Math.min(90, percentile(luma, 0.005));
    const table = levelsTable(black, 238, filter === 'bw' ? 1 : 1.15);
    for (let i = 0; i < luma.length; i += 1) luma[i] = table[luma[i]];
    sharpen(luma, width, height, 1, 1, filter === 'bw' ? 0.35 : 0.25);
    if (filter === 'gray') return { rgba: grayToRgba(luma, rgba) };
    const threshold = bwThreshold(luma);
    for (let i = 0, p = 0; i < luma.length; i += 1, p += 4) {
      const value = luma[i] > threshold ? 255 : 0;
      rgba[p] = value;
      rgba[p + 1] = value;
      rgba[p + 2] = value;
    }
    return { rgba, gray: luma, threshold };
  }

  // "auto": colour document. Each channel is normalised by its own
  // background, which also neutralises a colour cast on the paper.
  for (let c = 0; c < 3; c += 1) {
    const background = backgroundMap((i) => rgba[i * 4 + c], width, height);
    forEachNormalized(background, width, height, (i, scale) => {
      rgba[i * 4 + c] = rgba[i * 4 + c] * scale;
    });
  }
  const luma = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i += 1, p += 4) luma[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  const black = Math.min(80, percentile(luma, 0.005));
  const table = levelsTable(black, 240, 1.1);
  const saturation = 1.2;
  for (let p = 0; p < rgba.length; p += 4) {
    const r = table[rgba[p]];
    const g = table[rgba[p + 1]];
    const b = table[rgba[p + 2]];
    const y = (r * 77 + g * 150 + b * 29) >> 8;
    rgba[p] = y + (r - y) * saturation;
    rgba[p + 1] = y + (g - y) * saturation;
    rgba[p + 2] = y + (b - y) * saturation;
  }
  sharpen(rgba, width, height, 4, 3, 0.25);
  return { rgba };
}
