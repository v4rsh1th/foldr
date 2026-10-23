// Central configuration. Library versions here must match public/vendor/.
export const APP_VERSION = '1.0.0';

export const PDFJS_VERSION = '5.7.284';
export const PDF_LIB_VERSION = '1.17.1';
export const LIBHEIF_VERSION = '1.23.5';

const MB = 1024 * 1024;

// Resource safeguards. "warn" limits ask the user to confirm before
// continuing; "max" limits refuse the file because processing it in a browser
// tab is very likely to exhaust memory. Nothing is ever silently truncated.
export const LIMITS = Object.freeze({
  warnFileBytes: 200 * MB,
  maxFileBytes: 1536 * MB,
  warnTotalBytes: 400 * MB,
  maxTotalBytes: 2048 * MB,
  warnTotalPages: 2000,
  maxTotalPages: 20000,
  maxFiles: 200,
});

// Thumbnail rendering budget: the grid keeps at most this many rendered
// pixels alive and releases canvases that are far off-screen first.
export const THUMBNAILS = Object.freeze({
  cssWidth: 150,
  maxDevicePixelRatio: 2,
  pixelBudget: 18_000_000,
  concurrency: 2,
  rootMargin: '600px 0px',
});

// Document scanning. Photos are kept as captured; pages are rendered from
// them only when the PDF is made, at the chosen resolution.
export const SCAN = Object.freeze({
  maxPages: 100,
  // Working copy used for previews and the crop editor.
  proxySide: 1600,
  previewSide: 480,
  detectSide: 480,
  liveDetectSide: 320,
  liveDetectIntervalMs: 220,
  quality: {
    high: { ppi: 300, jpegQuality: 0.86 },
    standard: { ppi: 200, jpegQuality: 0.8 },
  },
});
