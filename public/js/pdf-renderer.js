// PDF.js is used only for previews; all modifications go through pdf-lib in
// the PDF worker. PDF.js is loaded lazily the first time a preview is needed
// and is configured to use self-hosted worker, font, CMap and decoder files.

import { PDFJS_VERSION, THUMBNAILS } from './config.js';

const BASE = new URL(`../vendor/pdfjs@${PDFJS_VERSION}/`, import.meta.url);

export class PreviewUnavailableError extends Error {
  constructor(cause) {
    super('Page previews aren’t available right now. You can still process the file.');
    this.name = 'PreviewUnavailableError';
    this.cause = cause;
  }
}

let libraryPromise = null;

export function loadPdfjs() {
  libraryPromise ??= import(new URL('pdf.min.mjs', BASE).href)
    .then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', BASE).href;
      return lib;
    })
    .catch((error) => {
      libraryPromise = null; // allow a retry, e.g. once back online
      throw new PreviewUnavailableError(error);
    });
  return libraryPromise;
}

/** Limits concurrent renders; the most recently requested page renders first. */
class RenderQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.jobs = [];
  }

  push(job) {
    return new Promise((resolve, reject) => {
      this.jobs.push({ job, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.running < this.concurrency && this.jobs.length) {
      const { job, resolve, reject } = this.jobs.pop();
      this.running += 1;
      Promise.resolve()
        .then(job)
        .then(resolve, reject)
        .finally(() => {
          this.running -= 1;
          this.pump();
        });
    }
  }

  clear() {
    for (const { reject } of this.jobs.splice(0)) reject(new DOMException('Cancelled', 'AbortError'));
  }
}

class PreviewDocument {
  constructor(lib, task, doc) {
    this.lib = lib;
    this.task = task;
    this.doc = doc;
    this.numPages = doc.numPages;
    this.queue = new RenderQueue(THUMBNAILS.concurrency);
    this.destroyed = false;
  }

  /**
   * Renders page `index` (0-based) at an absolute `rotation`, scaled so its
   * longest side is `maxSide` device pixels. Resolves with a new canvas.
   */
  renderPage(index, { rotation = 0, maxSide = 300, signal } = {}) {
    return this.queue.push(async () => {
      if (signal?.aborted || this.destroyed) throw new DOMException('Cancelled', 'AbortError');
      const page = await this.doc.getPage(index + 1);
      try {
        const unscaled = page.getViewport({ scale: 1, rotation });
        const scale = maxSide / Math.max(unscaled.width, unscaled.height);
        const viewport = page.getViewport({ scale, rotation });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const task = page.render({
          canvas,
          canvasContext: canvas.getContext('2d', { alpha: false }),
          viewport,
          background: '#ffffff',
        });
        const abort = () => task.cancel();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          await task.promise;
        } finally {
          signal?.removeEventListener('abort', abort);
        }
        return canvas;
      } finally {
        page.cleanup();
      }
    });
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queue.clear();
    try {
      await this.task.destroy();
    } catch (error) {
      console.warn('Foldr: preview cleanup failed:', error?.name);
    }
  }
}

/** Opens a Blob (or File) for previewing. The caller must call destroy(). */
export async function openPreview(blob) {
  const lib = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = lib.getDocument({
    data,
    cMapUrl: new URL('cmaps/', BASE).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', BASE).href,
    wasmUrl: new URL('wasm/', BASE).href,
    iccUrl: new URL('iccs/', BASE).href,
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    verbosity: 0,
  });
  // Encrypted files are rejected before previewing; never prompt here.
  task.onPassword = () => task.destroy();
  try {
    const doc = await task.promise;
    return new PreviewDocument(lib, task, doc);
  } catch (error) {
    task.destroy().catch(() => {});
    throw new PreviewUnavailableError(error);
  }
}
