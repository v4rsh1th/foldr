// Decisions for Compress Images that don't need a browser: which format an
// image is written in, how far it is scaled down, and what the result is
// called. The pixel work happens in workers/image-worker.js.

export const IMAGE_LEVELS = Object.freeze({
  light: { quality: 0.88 },
  balanced: { quality: 0.75 },
  strong: { quality: 0.55 },
});

// Re-encoding an image in the same format and size loses a little quality,
// so the result is only used if it saves at least 5%.
export const MIN_SAVING_RATIO = 0.95;

// Longest side in pixels; 0 keeps the original dimensions.
export const IMAGE_MAX_SIDES = Object.freeze([0, 3840, 2560, 1920, 1280, 800]);

// Formats the browser can write with OffscreenCanvas.convertToBlob.
const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const TYPES_BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
};

// Some pickers (Chrome on macOS) don't count HEIC/HEIF photos as image/*,
// so they're listed explicitly.
export const IMAGE_ACCEPT = 'image/*,.heic,.heif';

// Animated GIFs would lose their animation and SVGs are drawings, not photos.
const UNSUPPORTED = new Set(['image/gif', 'image/svg+xml']);

/** The file's image type, trusting the extension when the browser gives none. */
export function imageTypeOf({ name = '', type = '' }) {
  if (type.startsWith('image/')) return type.toLowerCase();
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (extension === 'gif') return 'image/gif';
  if (extension === 'svg') return 'image/svg+xml';
  return TYPES_BY_EXTENSION[extension] ?? '';
}

export function isCompressibleImage(file) {
  const type = imageTypeOf(file);
  return Boolean(type) && !UNSUPPORTED.has(type);
}

export function extensionForType(type) {
  return EXTENSIONS[type] ?? '';
}

/**
 * The type to write. `format` is 'keep', 'jpeg' or 'webp'. Keeping a format
 * the browser can't write (AVIF, HEIC, BMP…) gives JPEG, or PNG when the
 * image has transparency, which JPEG can't store.
 */
export function outputTypeFor({ inputType, format, hasAlpha = false, webp = true }) {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return webp ? 'image/webp' : 'image/jpeg';
  if (format !== 'keep') throw new RangeError(`Unknown format ${format}`);
  if (inputType === 'image/jpeg' || inputType === 'image/png') return inputType;
  if (inputType === 'image/webp' && webp) return 'image/webp';
  return hasAlpha ? 'image/png' : 'image/jpeg';
}

/** Scales `width` × `height` down (never up) so the longest side fits `maxSide`; 0 means no limit. */
export function fitWithin(width, height, maxSide) {
  const longest = Math.max(width, height);
  if (!maxSide || longest <= maxSide) return { width, height, scaled: false };
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: true,
  };
}

/** "Holiday 01.jpeg" written as WebP -> "Holiday 01-compressed.webp" (before sanitising). */
export function compressedImageName(name, type) {
  const stem = String(name ?? '').replace(/\.[a-z0-9]{1,5}$/i, '') || 'image';
  return `${stem}-compressed${extensionForType(type)}`;
}
