// Text recognition (OCR) for scanned pages, with Tesseract.js. It runs in
// Tesseract's own worker, so it must be driven from the main thread (the
// library resolves its paths against `window.location`).
//
// Everything is self-hosted: the library, one WebAssembly core (picked by
// Tesseract for the browser's SIMD support) and the English model, about
// 4.5 MB gzipped in all. They load the first time a scan is made searchable
// and the service worker then keeps them for offline use. The model is never
// stored anywhere else (`cacheMethod: 'none'` keeps it out of IndexedDB).
//
// For each page Tesseract writes a one-page, text-only PDF: every word in an
// invisible glyphless font, positioned and stretched over the word in the
// image. The PDF worker lays that page over the scan, which makes the text
// searchable and selectable without changing how the page looks.

import { TESSERACT_VERSION, TESSERACT_CORE_VERSION, TESSERACT_ENG_VERSION } from './config.js';
import { CancelledError } from './worker-client.js';

const vendor = (dir) => new URL(`../vendor/${dir}/`, import.meta.url).href;

const START_FAILED = 'Text recognition couldn’t start. If you’re offline, connect once so Foldr can download it, or turn off “Make text searchable”.';
const PAGE_FAILED = 'Text recognition failed on one of the pages. Try again, or turn off “Make text searchable”.';

class RecognitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecognitionError';
    this.code = 'ocr';
  }
}

/** The exact ArrayBuffer for a Uint8Array, so it can be transferred without copying. */
function ownBuffer(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
}

async function startTesseract() {
  const library = vendor(`tesseract@${TESSERACT_VERSION}`);
  const { default: Tesseract } = await import(`${library}tesseract.esm.min.js`);
  // Tesseract.js reports some failures (such as a model that can't be
  // downloaded) only through `errorHandler`, leaving createWorker pending.
  let fail;
  const failed = new Promise((resolve, reject) => { fail = reject; });
  const ready = Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
    workerPath: `${library}worker.min.js`,
    corePath: vendor(`tesseract-core@${TESSERACT_CORE_VERSION}`),
    langPath: vendor(`tesseract-eng@${TESSERACT_ENG_VERSION}`),
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: true,
    errorHandler: (error) => fail(error),
  });
  return Promise.race([ready, failed]);
}

/**
 * One Tesseract worker, started on first use. `recognize(blob)` resolves to
 * the page's text-only PDF as an ArrayBuffer. `cancel()` stops the worker and
 * rejects everything in flight with a CancelledError; the next call starts a
 * fresh one.
 */
export function createTextRecognizer() {
  let worker = null;
  const pending = new Set();

  function track(promise) {
    return new Promise((resolve, reject) => {
      const entry = { reject };
      pending.add(entry);
      promise.then(resolve, reject).finally(() => pending.delete(entry));
    });
  }

  function ensureWorker() {
    if (!worker) {
      const starting = startTesseract();
      worker = starting;
      starting.catch((error) => {
        console.info('Foldr: text recognition failed to start:', error?.name ?? String(error).slice(0, 80));
        if (worker === starting) worker = null;
      });
    }
    return worker;
  }

  return {
    async recognize(image) {
      const tesseract = await track(ensureWorker().catch(() => { throw new RecognitionError(START_FAILED); }));
      const { data } = await track(tesseract.recognize(image, { pdfTextOnly: true }, { pdf: true }).catch(() => {
        throw new RecognitionError(PAGE_FAILED);
      }));
      return ownBuffer(new Uint8Array(data.pdf));
    },

    cancel() {
      const current = worker;
      worker = null;
      current?.then((tesseract) => tesseract.terminate(), () => {});
      for (const entry of pending) entry.reject(new CancelledError());
      pending.clear();
    },
  };
}
