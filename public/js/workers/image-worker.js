// Image worker for Compress Images: decodes each photo, scales it down if
// asked and re-encodes it with the browser's own encoders, off the main
// thread. It speaks the same message protocol as the PDF worker, so
// PdfWorkerClient drives it too.
//
// Re-encoding writes pixels only, so camera metadata (EXIF, including GPS
// location) is never carried over. Photos are turned upright first, because
// createImageBitmap (and libheif, for HEIC) applies the stored orientation.

import { IMAGE_LEVELS, MIN_SAVING_RATIO, fitWithin, outputTypeFor } from '../core/image-compress.js';
import { decodeImage } from './heif-decoder.js';

class ImageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let webpSupport = null;

async function canEncodeWebp() {
  if (webpSupport === null) {
    try {
      // convertToBlob throws on a canvas without a rendering context.
      const probe = new OffscreenCanvas(1, 1);
      probe.getContext('2d');
      const blob = await probe.convertToBlob({ type: 'image/webp', quality: 0.8 });
      webpSupport = blob.type === 'image/webp';
    } catch {
      webpSupport = false;
    }
  }
  return webpSupport;
}

function hasTransparency(context, width, height) {
  const data = context.getImageData(0, 0, width, height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

const handlers = {
  async capabilities() {
    return { supported: typeof OffscreenCanvas === 'function', webp: await canEncodeWebp() };
  },

  /**
   * Returns the re-encoded image, or `kept: true` when it wouldn't be
   * smaller than the original (or, when only the quality changed, not
   * enough smaller to be worth another generation of compression) and no
   * new format was asked for.
   */
  async compress({ blob, inputType, level, maxSide, format }) {
    const settings = IMAGE_LEVELS[level];
    if (!settings) throw new RangeError(`Unknown level ${level}`);
    let image;
    try {
      image = await decodeImage(blob);
    } catch {
      throw new ImageError('decode', 'This image couldn’t be opened. It may be damaged, or in a format this browser doesn’t support.');
    }
    try {
      const size = fitWithin(image.width, image.height, maxSide);
      const webp = await canEncodeWebp();
      const element = new OffscreenCanvas(size.width, size.height);
      const context = element.getContext('2d', { willReadFrequently: true });
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, size.width, size.height);

      // Only look for transparency when it changes the output format.
      const mayHaveAlpha = inputType !== 'image/jpeg';
      const dependsOnAlpha = mayHaveAlpha
        && outputTypeFor({ inputType, format, hasAlpha: false, webp }) !== outputTypeFor({ inputType, format, hasAlpha: true, webp });
      const hasAlpha = dependsOnAlpha && hasTransparency(context, size.width, size.height);
      const type = outputTypeFor({ inputType, format, hasAlpha, webp });

      if (type === 'image/jpeg' && mayHaveAlpha) {
        // JPEG has no transparency: put transparent areas on white rather than black.
        context.globalCompositeOperation = 'destination-over';
        context.fillStyle = '#fff';
        context.fillRect(0, 0, size.width, size.height);
      }
      const result = await element.convertToBlob({ type, quality: settings.quality });
      element.width = 0;
      if (result.type !== type) throw new ImageError('encode', 'This browser can’t write this image format. Choose another format.');

      const dimensions = { width: size.width, height: size.height, sourceWidth: image.width, sourceHeight: image.height };
      // A format the user asked for is always delivered (HEIC to JPEG is
      // often larger, but opens everywhere); otherwise the original is kept
      // unless the result is smaller.
      const requested = format !== 'keep' && type !== inputType;
      const converted = size.scaled || type !== inputType;
      if (!requested && result.size >= blob.size * (converted ? 1 : MIN_SAVING_RATIO)) return { kept: true, ...dimensions };
      return { kept: false, blob: result, type, ...dimensions };
    } finally {
      image.close();
    }
  },
};

function serializeError(error) {
  if (error instanceof ImageError) return { code: error.code, message: error.message };
  if (/allocation failed|out of memory|invalid array length|invalid typed array length/i.test(error?.message ?? '')) {
    return { code: 'memory', message: 'Your browser ran out of memory with this image. Close other tabs, or choose smaller dimensions.' };
  }
  return { code: 'internal', message: 'Something went wrong while compressing this image.' };
}

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data;
  const handler = handlers[type];
  try {
    if (!handler) throw new Error(`Unknown request ${type}`);
    self.postMessage({ id, type: 'result', result: await handler(payload) });
  } catch (error) {
    const log = error instanceof ImageError ? console.info : console.error;
    log(`Foldr image worker: ${type} failed:`, error?.name, error?.code ?? '', error?.message);
    self.postMessage({ id, type: 'error', error: serializeError(error) });
  }
});
