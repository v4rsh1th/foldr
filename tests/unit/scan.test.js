import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDocument,
  luminance,
  orderQuad,
  quadSize,
  rotateQuad,
  squareToQuad,
  warpPerspective,
  isConvexQuad,
} from '../../public/js/core/scan-geometry.js';
import { applyScanFilter, packBits, normalizedLuma } from '../../public/js/core/scan-enhance.js';

function insideQuad(quad, x, y) {
  for (let i = 0; i < 4; i += 1) {
    const [ax, ay] = quad[i];
    const [bx, by] = quad[(i + 1) % 4];
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
  }
  return true;
}

/**
 * A synthetic photo: a dark desk with a tilted sheet of paper carrying
 * "text" bars, lit from the left so the right side is in shadow.
 */
function photo(width, height, quad, { shadow = 0.45 } = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const light = 1 - shadow * (x / width);
      let value = 70;
      if (insideQuad(quad, x + 0.5, y + 0.5)) {
        // Text bars: horizontal bands across 70% of the page width.
        value = 235;
        const v = (y - quad[0][1]) / (quad[3][1] - quad[0][1]);
        if (v > 0.2 && v < 0.8 && Math.floor(v * 40) % 2 === 0 && (x - quad[0][0]) / (quad[1][0] - quad[0][0]) % 1 < 0.7) value = 40;
      }
      rgba[p] = value * light * 1.02;
      rgba[p + 1] = value * light;
      rgba[p + 2] = value * light * 0.9;
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

test('squareToQuad maps the unit square corners onto the quad', () => {
  const quad = [[10, 20], [200, 5], [220, 300], [0, 280]];
  const [a, b, c, d, e, f, g, h] = squareToQuad(quad);
  const map = (u, v) => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  };
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const [x, y] = map(u, v);
    assert.ok(Math.abs(x - quad[i][0]) < 1e-6 && Math.abs(y - quad[i][1]) < 1e-6, `corner ${i}`);
  });
});

test('orderQuad returns top-left, top-right, bottom-right, bottom-left from any order', () => {
  const ordered = [[1, 1], [9, 2], [10, 12], [0, 11]];
  assert.deepEqual(orderQuad([ordered[2], ordered[0], ordered[3], ordered[1]]), ordered);
  assert.ok(isConvexQuad(ordered));
  assert.ok(!isConvexQuad([[0, 0], [10, 10], [10, 0], [0, 10]]));
});

test('rotateQuad turns the output by quarter turns', () => {
  const quad = ['tl', 'tr', 'br', 'bl'];
  assert.deepEqual(rotateQuad(quad, 0), quad);
  assert.deepEqual(rotateQuad(quad, 90), ['bl', 'tl', 'tr', 'br']);
  assert.deepEqual(rotateQuad(quad, 180), ['br', 'bl', 'tl', 'tr']);
  assert.deepEqual(rotateQuad(quad, -90), rotateQuad(quad, 270));
});

test('quadSize uses the longest opposite edges', () => {
  assert.deepEqual(quadSize([[0, 0], [100, 0], [100, 50], [0, 50]]), { width: 100, height: 50 });
  assert.deepEqual(quadSize([[0, 0], [80, 0], [100, 60], [0, 40]]), { width: Math.hypot(100, 20), height: Math.hypot(20, 60) });
});

test('detectDocument finds a tilted page on a darker background', () => {
  const width = 400;
  const height = 300;
  const quad = [[90, 40], [330, 60], [310, 270], [70, 250]];
  const gray = luminance(photo(width, height, quad), width, height);
  const found = detectDocument(gray, width, height);
  assert.ok(found, 'a page should be found');
  found.forEach(([x, y], i) => {
    const error = Math.hypot(x * width - quad[i][0], y * height - quad[i][1]);
    assert.ok(error < 6, `corner ${i} off by ${error.toFixed(1)} px`);
  });
});

test('detectDocument returns null when there is no distinct page', () => {
  const width = 200;
  const height = 150;
  const flat = new Uint8Array(width * height).fill(128);
  assert.equal(detectDocument(flat, width, height), null);
  const noise = Uint8Array.from({ length: width * height }, (_, i) => ((i * 2654435761) >>> 24));
  assert.equal(detectDocument(noise, width, height), null);
});

test('warpPerspective flattens the quad into the output rectangle', () => {
  const width = 400;
  const height = 300;
  const quad = [[90, 40], [330, 60], [310, 270], [70, 250]];
  const rgba = photo(width, height, quad, { shadow: 0 });
  const out = warpPerspective(rgba, width, height, quad, 120, 100);
  // Every output corner lies just inside the page, so none of the dark desk shows.
  for (const [x, y] of [[1, 1], [118, 1], [118, 98], [1, 98]]) {
    assert.ok(out[(y * 120 + x) * 4 + 1] > 150, `corner ${x},${y} is paper`);
  }
});

test('normalizedLuma removes uneven lighting from the paper', () => {
  const width = 300;
  const height = 200;
  const full = [[0, 0], [width, 0], [width, height], [0, height]];
  const rgba = photo(width, height, full, { shadow: 0.5 });
  const luma = normalizedLuma(rgba, width, height);
  // Paper in the lit and the shadowed corner ends up within a few levels.
  const lit = luma[5 * width + 5];
  const shaded = luma[5 * width + width - 6];
  assert.ok(Math.abs(lit - shaded) < 12, `lit ${lit} vs shaded ${shaded}`);
});

test('black & white output makes paper white and text black despite shadows', () => {
  const width = 300;
  const height = 200;
  const full = [[0, 0], [width, 0], [width, height], [0, height]];
  const rgba = photo(width, height, full, { shadow: 0.5 });
  const { rgba: out, gray, threshold } = applyScanFilter(rgba, width, height, 'bw');
  assert.ok(gray && threshold > 0);
  const at = (x, y) => out[(y * width + x) * 4];
  assert.equal(at(10, 10), 255, 'lit paper is white');
  assert.equal(at(width - 10, 10), 255, 'shaded paper is white');
  // Row 0.2–0.225 of the page height is a text band (even stripe index).
  const textRow = Math.round(height * 0.21);
  assert.equal(at(20, textRow), 0, 'lit text is black');
  assert.equal(at(Math.round(width * 0.6), textRow), 0, 'shaded text is black');
});

test('the document filter whitens the paper and keeps text dark', () => {
  const width = 300;
  const height = 200;
  const full = [[0, 0], [width, 0], [width, height], [0, height]];
  const rgba = photo(width, height, full, { shadow: 0.5 });
  const { rgba: out } = applyScanFilter(rgba, width, height, 'auto');
  const pixel = (x, y) => [...out.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
  for (const value of [...pixel(10, 10), ...pixel(width - 10, 10)]) assert.ok(value >= 245, `paper ${value}`);
  const textRow = Math.round(height * 0.21);
  for (const value of pixel(Math.round(width * 0.6), textRow)) assert.ok(value < 90, `text ${value}`);
});

test('packBits writes 1 bit per pixel, white as 1, rows padded to bytes', () => {
  const gray = Uint8Array.from([255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255]);
  const bits = packBits(gray, 10, 2, 128);
  assert.deepEqual([...bits], [0b10101010, 0b11000000, 0b00000000, 0b01000000]);
});
