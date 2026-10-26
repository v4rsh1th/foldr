// Image worker for the scanner. Decoding camera photos (12+ megapixels),
// flattening the page and cleaning it up take hundreds of milliseconds per
// page, so they run here, off the main thread. It speaks the same message
// protocol as the PDF worker, so PdfWorkerClient drives it too.
//
// The worker keeps nothing between requests: every request carries the
// image Blob it works on (Blobs are passed by reference, not copied).

import { SCAN } from '../config.js';
import { detectDocument, luminance, quadSize, rotateQuad, warpPerspective, FULL_QUAD } from '../core/scan-geometry.js';
import { applyScanFilter, packBits } from '../core/scan-enhance.js';
import { decodeImage } from './heif-decoder.js';

class ScanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function decode(blob) {
  try {
    return await decodeImage(blob);
  } catch {
    throw new ScanError('decode', 'This image couldn’t be opened. Use a JPEG, PNG, WebP or HEIC photo.');
  }
}

function canvas(width, height) {
  const element = new OffscreenCanvas(width, height);
  return { element, context: element.getContext('2d', { willReadFrequently: true }) };
}

/** Draws `image` (or part of it) at a new size with high-quality smoothing. */
function pixelsOf(image, width, height) {
  const { element, context } = canvas(width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  element.width = 0;
  return data;
}

async function encodeJpeg(rgba, width, height, quality) {
  const { element, context } = canvas(width, height);
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await element.convertToBlob({ type: 'image/jpeg', quality });
  element.width = 0;
  if (blob.type !== 'image/jpeg') throw new ScanError('encode', 'This browser can’t create JPEG images, so the scan can’t be saved.');
  return blob;
}

function fit(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/**
 * Flattens and filters one page. `maxSide` caps the long side; `upscale`
 * allows enlarging a small crop (used for black-and-white, where a finer
 * grid gives smoother letter edges after thresholding).
 */
async function renderPage({ blob, quad = FULL_QUAD, rotation = 0, filter, maxSide, upscale = 1 }) {
  const image = await decode(blob);
  try {
    const pixelQuad = rotateQuad(quad, rotation).map(([x, y]) => [x * image.width, y * image.height]);
    const natural = quadSize(pixelQuad);
    const scale = Math.min(upscale, maxSide / Math.max(natural.width, natural.height));
    const width = Math.max(1, Math.round(natural.width * scale));
    const height = Math.max(1, Math.round(natural.height * scale));
    // Bilinear warping doesn't average, so shrink the photo close to the
    // output scale first (with the browser's high-quality resampler).
    const sourceScale = Math.min(1, scale * 1.25);
    const sourceWidth = Math.max(1, Math.round(image.width * sourceScale));
    const sourceHeight = Math.max(1, Math.round(image.height * sourceScale));
    const source = pixelsOf(image, sourceWidth, sourceHeight);
    const flat = warpPerspective(source, sourceWidth, sourceHeight, pixelQuad.map(([x, y]) => [x * sourceScale, y * sourceScale]), width, height);
    return { width, height, ...applyScanFilter(flat, width, height, filter) };
  } finally {
    image.close();
  }
}

const handlers = {
  capabilities() {
    return { supported: true };
  },

  /** Decodes a new photo: finds the page and makes the working copy. */
  async prepare({ blob }) {
    const image = await decode(blob);
    try {
      const small = fit(image.width, image.height, SCAN.detectSide);
      const gray = luminance(pixelsOf(image, small.width, small.height), small.width, small.height);
      const quad = detectDocument(gray, small.width, small.height);
      const proxySize = fit(image.width, image.height, SCAN.proxySide);
      const { element, context } = canvas(proxySize.width, proxySize.height);
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, proxySize.width, proxySize.height);
      const proxy = await element.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      element.width = 0;
      return { width: image.width, height: image.height, quad, proxy };
    } finally {
      image.close();
    }
  },

  async preview(options) {
    const page = await renderPage(options);
    return { blob: await encodeJpeg(page.rgba, page.width, page.height, 0.82), width: page.width, height: page.height };
  },

  /**
   * Final page for the PDF: JPEG bytes, or packed 1-bit pixels for black and
   * white. With `ocr`, also an image of the page for text recognition (`ocrImage`).
   */
  async page({ jpegQuality, ocr = false, ...options }) {
    const page = await renderPage(options);
    if (page.gray) {
      const bits = packBits(page.gray, page.width, page.height, page.threshold);
      // `rgba` holds the same black-and-white pixels.
      const ocrImage = ocr ? await encodeJpeg(page.rgba, page.width, page.height, 0.9) : undefined;
      return { result: { kind: 'bitonal', bytes: bits.buffer, width: page.width, height: page.height, ocrImage }, transfer: [bits.buffer] };
    }
    const blob = await encodeJpeg(page.rgba, page.width, page.height, jpegQuality);
    const bytes = await blob.arrayBuffer();
    return { result: { kind: 'jpeg', bytes, width: page.width, height: page.height, ocrImage: ocr ? blob : undefined }, transfer: [bytes] };
  },
};

function serializeError(error) {
  if (error instanceof ScanError) return { code: error.code, message: error.message };
  if (/allocation failed|out of memory|invalid array length|invalid typed array length/i.test(error?.message ?? '')) {
    return { code: 'memory', message: 'Your browser ran out of memory while processing this photo. Close other tabs, or choose Standard quality.' };
  }
  return { code: 'internal', message: 'Something went wrong while processing this photo. Please try again.' };
}

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data;
  const handler = handlers[type];
  try {
    if (!handler) throw new Error(`Unknown request ${type}`);
    const outcome = await handler(payload);
    if (outcome && typeof outcome === 'object' && 'transfer' in outcome) {
      self.postMessage({ id, type: 'result', result: outcome.result }, outcome.transfer);
    } else {
      self.postMessage({ id, type: 'result', result: outcome });
    }
  } catch (error) {
    const log = error instanceof ScanError ? console.info : console.error;
    log(`Foldr scan worker: ${type} failed:`, error?.name, error?.code ?? '', error?.message);
    self.postMessage({ id, type: 'error', error: serializeError(error) });
  }
});
