// Geometry for document scanning: finding the page in a photo and mapping
// its four corners onto a flat rectangle. Pure functions on plain arrays, so
// they run in the scan worker, on the main thread (live camera outline) and
// in Node for tests.
//
// A quad is four [x, y] points in the order top-left, top-right,
// bottom-right, bottom-left. Detection returns them normalised to 0–1 of the
// image size, so the same crop applies to a photo at any resolution.

/** Rec. 601 luma of RGBA pixels, as 0–255. */
export function luminance(rgba, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return out;
}

/** Separable box blur, in place. Two passes approximate a Gaussian. */
export function boxBlur(values, width, height, radius) {
  const temp = new Float32Array(values.length);
  const size = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) sum += values[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x += 1) {
      temp[row + x] = sum / size;
      sum += values[row + Math.min(width - 1, x + radius + 1)] - values[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) sum += temp[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y += 1) {
      values[y * width + x] = sum / size;
      sum += temp[Math.min(height - 1, y + radius + 1) * width + x] - temp[Math.max(0, y - radius) * width + x];
    }
  }
  return values;
}

/** Separable max (dilate) or min (erode) filter, returning a new array. */
function rankFilter(values, width, height, radius, pick) {
  const temp = new Float32Array(values.length);
  const out = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let best = values[row + x];
      for (let dx = Math.max(0, x - radius); dx <= Math.min(width - 1, x + radius); dx += 1) best = pick(best, values[row + dx]);
      temp[row + x] = best;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let best = temp[y * width + x];
      for (let dy = Math.max(0, y - radius); dy <= Math.min(height - 1, y + radius); dy += 1) best = pick(best, temp[dy * width + x]);
      out[y * width + x] = best;
    }
  }
  return out;
}

/** Otsu's threshold for 0–255 values. */
export function otsuThreshold(values) {
  const histogram = new Float64Array(256);
  for (let i = 0; i < values.length; i += 1) histogram[values[i] | 0] += 1;
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i += 1) sumAll += i * histogram[i];
  let sumBelow = 0;
  let countBelow = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t += 1) {
    countBelow += histogram[t];
    if (!countBelow) continue;
    const countAbove = total - countBelow;
    if (!countAbove) break;
    sumBelow += t * histogram[t];
    const meanBelow = sumBelow / countBelow;
    const meanAbove = (sumAll - sumBelow) / countAbove;
    const between = countBelow * countAbove * (meanBelow - meanAbove) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (Andrew's monotone chain), counter-clockwise in y-down space. */
export function convexHull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

/** Drops the hull vertices that contribute least area until `max` remain. */
function simplifyHull(hull, max) {
  const points = [...hull];
  while (points.length > max) {
    let weakest = 0;
    let smallest = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      const area = Math.abs(cross(points[(i - 1 + points.length) % points.length], points[i], points[(i + 1) % points.length]));
      if (area < smallest) {
        smallest = area;
        weakest = i;
      }
    }
    points.splice(weakest, 1);
  }
  return points;
}

/** The four hull vertices enclosing the largest area. */
function largestQuad(hull) {
  const n = hull.length;
  if (n < 4) return null;
  const triangle = (a, b, c) => Math.abs(cross(hull[a], hull[b], hull[c])) / 2;
  let best = null;
  let bestArea = 0;
  // Fix the diagonal (i, k); the best j and l on either side are independent.
  for (let i = 0; i < n; i += 1) {
    for (let k = i + 2; k < n; k += 1) {
      if (i === 0 && k === n - 1) continue;
      let j = -1;
      let jArea = 0;
      for (let t = i + 1; t < k; t += 1) {
        const area = triangle(i, t, k);
        if (area > jArea) { jArea = area; j = t; }
      }
      let l = -1;
      let lArea = 0;
      for (let t = k + 1; t < n + i; t += 1) {
        const area = triangle(k, t % n, i);
        if (area > lArea) { lArea = area; l = t % n; }
      }
      if (j >= 0 && l >= 0 && jArea + lArea > bestArea) {
        bestArea = jArea + lArea;
        best = [i, j, k, l];
      }
    }
  }
  return best && best.sort((a, b) => a - b).map((index) => hull[index]);
}

/** Orders four points as top-left, top-right, bottom-right, bottom-left. */
export function orderQuad(points) {
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  const around = [...points].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // Sorted by angle in y-down space: clockwise on screen. Start at top-left.
  let start = 0;
  for (let i = 1; i < 4; i += 1) {
    if (around[i][0] + around[i][1] < around[start][0] + around[start][1]) start = i;
  }
  return [0, 1, 2, 3].map((offset) => around[(start + offset) % 4]);
}

export function isConvexQuad(quad) {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const value = cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]);
    if (Math.abs(value) < 1e-9) return false;
    if (sign === 0) sign = Math.sign(value);
    else if (Math.sign(value) !== sign) return false;
  }
  return true;
}

export const FULL_QUAD = Object.freeze([[0, 0], [1, 0], [1, 1], [0, 1]].map(Object.freeze));

/**
 * Finds a document in a greyscale image (ideally 300–500 px on the long
 * side). The page is assumed to be lighter than what surrounds it, which
 * holds for paper on a desk, table or floor. Returns a normalised quad, or
 * null when no convincing page outline is found.
 */
export function detectDocument(gray, width, height) {
  const radius = Math.max(1, Math.round(Math.max(width, height) / 160));
  // A greyscale closing erases text, rules and table lines, which would
  // otherwise cut the page into separate regions.
  const closeRadius = Math.max(2, Math.round(Math.max(width, height) / 100));
  const blurred = rankFilter(rankFilter(gray, width, height, closeRadius, Math.max), width, height, closeRadius, Math.min);
  boxBlur(blurred, width, height, radius);
  boxBlur(blurred, width, height, radius);
  const threshold = otsuThreshold(blurred);

  // Largest bright connected region (4-connected flood fill).
  const labels = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  let bestLabel = 0;
  let bestSize = 0;
  let label = 0;
  for (let start = 0; start < labels.length; start += 1) {
    if (labels[start] || blurred[start] <= threshold) continue;
    label += 1;
    let size = 0;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top) {
      const index = stack[--top];
      size += 1;
      const x = index % width;
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        index - width,
        index + width,
      ];
      for (const next of neighbours) {
        if (next < 0 || next >= labels.length || labels[next] || blurred[next] <= threshold) continue;
        labels[next] = label;
        stack[top++] = next;
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = label;
    }
  }
  const frame = width * height;
  if (bestSize < frame * 0.12 || bestSize > frame * 0.985) return null;

  // The leftmost and rightmost pixel of each row are enough for the hull.
  const edge = [];
  for (let y = 0; y < height; y += 1) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x += 1) {
      if (labels[y * width + x] !== bestLabel) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first >= 0) edge.push([first, y], [last + 1, y], [first, y + 1], [last + 1, y + 1]);
  }
  const hull = simplifyHull(convexHull(edge), 48);
  const corners = largestQuad(hull);
  if (!corners) return null;
  const quad = orderQuad(corners);
  const area = polygonArea(quad);
  // A real page fills most of its outline; a blob of light background doesn't.
  if (!isConvexQuad(quad) || area < frame * 0.12 || bestSize / area < 0.8) return null;
  // Pull the corners in slightly: the outline is found on a small, blurred
  // copy, and a sliver of desk along an edge looks worse than losing a
  // millimetre of margin.
  const cx = quad.reduce((sum, p) => sum + p[0], 0) / 4;
  const cy = quad.reduce((sum, p) => sum + p[1], 0) / 4;
  return quad.map(([x, y]) => [(cx + (x - cx) * 0.99) / width, (cy + (y - cy) * 0.99) / height]);
}

/** Rotates a quad's corner order so the output is turned by `rotation` (multiple of 90, clockwise). */
export function rotateQuad(quad, rotation) {
  const steps = ((Math.round(rotation / 90) % 4) + 4) % 4;
  return [0, 1, 2, 3].map((i) => quad[(i - steps + 4) % 4]);
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Natural output size of a pixel-space quad: its longest opposite edges. */
export function quadSize(quad) {
  const [tl, tr, br, bl] = quad;
  return {
    width: Math.max(distance(tl, tr), distance(bl, br)),
    height: Math.max(distance(tl, bl), distance(tr, br)),
  };
}

/**
 * Projective transform taking the unit square (u, v) onto `quad`
 * (Heckbert's square-to-quad mapping). Returns [a, b, c, d, e, f, g, h]:
 * x = (a·u + b·v + c) / (g·u + h·v + 1), y = (d·u + e·v + f) / (same).
 */
export function squareToQuad(quad) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const dx3 = x0 - x1 + x2 - x3;
  const dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0];
  }
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

/**
 * Flattens the `quad` region of an RGBA image into a width × height
 * rectangle with bilinear sampling. The source should be at roughly the
 * output scale (downscale it first); bilinear sampling doesn't average.
 */
export function warpPerspective(source, sourceWidth, sourceHeight, quad, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  const [a, b, c, d, e, f, g, h] = squareToQuad(quad);
  const maxX = sourceWidth - 1;
  const maxY = sourceHeight - 1;
  let o = 0;
  for (let row = 0; row < height; row += 1) {
    const v = (row + 0.5) / height;
    const du = 1 / width;
    let u = 0.5 / width;
    let nx = a * u + b * v + c;
    let ny = d * u + e * v + f;
    let w = g * u + h * v + 1;
    const stepX = a * du;
    const stepY = d * du;
    const stepW = g * du;
    for (let col = 0; col < width; col += 1) {
      // Sample at pixel centres: image coordinate x maps to pixel x − 0.5.
      let x = nx / w - 0.5;
      let y = ny / w - 0.5;
      x = x < 0 ? 0 : x > maxX ? maxX : x;
      y = y < 0 ? 0 : y > maxY ? maxY : y;
      const x0 = x | 0;
      const y0 = y | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = x - x0;
      const fy = y - y0;
      const p00 = (y0 * sourceWidth + x0) * 4;
      const p10 = (y0 * sourceWidth + x1) * 4;
      const p01 = (y1 * sourceWidth + x0) * 4;
      const p11 = (y1 * sourceWidth + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      out[o] = source[p00] * w00 + source[p10] * w10 + source[p01] * w01 + source[p11] * w11;
      out[o + 1] = source[p00 + 1] * w00 + source[p10 + 1] * w10 + source[p01 + 1] * w01 + source[p11 + 1] * w11;
      out[o + 2] = source[p00 + 2] * w00 + source[p10 + 2] * w10 + source[p01 + 2] * w01 + source[p11 + 2] * w11;
      out[o + 3] = 255;
      o += 4;
      nx += stepX;
      ny += stepY;
      w += stepW;
    }
  }
  return out;
}
