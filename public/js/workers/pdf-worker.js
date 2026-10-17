// PDF processing worker. pdf-lib parsing and saving are synchronous-heavy and
// can block for seconds on large files, so they run here to keep the UI
// responsive. Cancelling terminates the whole worker, which is the only way
// to stop pdf-lib mid-operation; the client then starts a fresh one.
//
// Documents parsed by "inspect" are kept by file id so Merge and Split don't
// parse each file twice. Operations that modify a document in place
// (Organize, Rotate, Compress) parse a fresh copy from bytes instead.

import { PdfOperationError, inspectDocument, loadPdf } from '../operations/common.js';
import { mergeDocuments } from '../operations/merge.js';
import { splitDocument } from '../operations/split.js';
import { editDocument } from '../operations/organize.js';
import { compressDocument, compressionStreamSupported } from '../operations/compress.js';

const documents = new Map();

const imageCodec = (() => {
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return null;
  return {
    async decodeJpeg(bytes) {
      return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
    },
    async fromPixels(rgba, width, height) {
      return createImageBitmap(new ImageData(rgba, width, height));
    },
    async encodeJpeg(image, width, height, quality) {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      canvas.width = 0;
      canvas.height = 0;
      if (blob.type !== 'image/jpeg') throw new Error('JPEG encoding is not supported');
      return new Uint8Array(await blob.arrayBuffer());
    },
    release(image) {
      image.close?.();
    },
  };
})();

function requireDocument(fileId) {
  const doc = documents.get(fileId);
  if (!doc) throw new PdfOperationError('stale', 'This file needs to be reloaded. Please try again.');
  return doc;
}

const toUint8 = (buffer) => new Uint8Array(buffer);

/** The exact ArrayBuffer for a Uint8Array, so it can be transferred without copying. */
function ownBuffer(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
}

const handlers = {
  capabilities() {
    return { lossyCompression: Boolean(imageCodec), losslessStreams: compressionStreamSupported() };
  },

  async inspect({ fileId, bytes }) {
    const doc = await loadPdf(toUint8(bytes));
    documents.set(fileId, doc);
    return inspectDocument(doc);
  },

  release({ fileIds }) {
    for (const id of fileIds) documents.delete(id);
    return true;
  },

  async merge({ fileIds }, progress) {
    const sources = fileIds.map(requireDocument);
    const { bytes, pageCount } = await mergeDocuments(sources, { onProgress: progress });
    const buffer = ownBuffer(bytes);
    return { result: { buffer, pageCount }, transfer: [buffer] };
  },

  async split({ fileId, groups }, progress) {
    const outputs = await splitDocument(requireDocument(fileId), groups, { onProgress: progress });
    const result = outputs.map(({ bytes, pageCount }) => ({ buffer: ownBuffer(bytes), pageCount }));
    return { result, transfer: result.map((output) => output.buffer) };
  },

  async edit({ bytes, plan }, progress) {
    progress({ phase: 'load', label: 'Reading the document' });
    const doc = await loadPdf(toUint8(bytes));
    const output = await editDocument(doc, plan, { onProgress: progress });
    const buffer = ownBuffer(output.bytes);
    return { result: { buffer, pageCount: output.pageCount }, transfer: [buffer] };
  },

  async compress({ bytes, mode }, progress) {
    progress({ phase: 'load', label: 'Reading the document' });
    const doc = await loadPdf(toUint8(bytes));
    const output = await compressDocument(doc, { mode, codec: imageCodec, onProgress: progress });
    const buffer = ownBuffer(output.bytes);
    return { result: { buffer, pageCount: output.pageCount, stats: output.stats }, transfer: [buffer] };
  },
};

function serializeError(error) {
  if (error instanceof PdfOperationError) return { code: error.code, message: error.message };
  // V8 reports failed buffer allocations as RangeErrors, so check this first.
  if (/allocation failed|out of memory|invalid array length|invalid typed array length/i.test(error?.message ?? '')) {
    return { code: 'memory', message: 'Your browser ran out of memory while processing this file. Try a smaller file or close other tabs.' };
  }
  return { code: 'internal', message: 'Something went wrong while processing the PDF. Your files are unchanged; please try again.' };
}

self.addEventListener('message', async (event) => {
  const { id, type, payload } = event.data;
  const handler = handlers[type];
  const progress = (info) => self.postMessage({ id, type: 'progress', progress: info });
  try {
    if (!handler) throw new Error(`Unknown request ${type}`);
    const outcome = await handler(payload, progress);
    if (outcome && typeof outcome === 'object' && 'transfer' in outcome) {
      self.postMessage({ id, type: 'result', result: outcome.result }, outcome.transfer);
    } else {
      self.postMessage({ id, type: 'result', result: outcome });
    }
  } catch (error) {
    // Expected failures (invalid or encrypted files) are normal states, not
    // bugs. Log only the technical cause, never document contents or names.
    const log = error instanceof PdfOperationError ? console.info : console.error;
    log(`Foldr worker: ${type} failed:`, error?.name, error?.code ?? '', error?.cause?.message ?? error?.message);
    self.postMessage({ id, type: 'error', error: serializeError(error) });
  }
});
