// Promise-based client for the PDF worker. Each request gets an id; progress
// and results are routed back to it. `cancel()` terminates the worker (the
// only reliable way to stop pdf-lib mid-operation) and rejects everything
// in flight; the next request starts a fresh worker. `generation` changes
// whenever the worker is replaced, so callers know cached parses are gone.

export class CancelledError extends Error {
  constructor() {
    super('The operation was cancelled.');
    this.name = 'CancelledError';
    this.code = 'cancelled';
  }
}

export class WorkerFailedError extends Error {
  constructor() {
    super('Foldr’s PDF engine couldn’t start. If you’re offline, connect once so Foldr can finish downloading, then reload the page.');
    this.name = 'WorkerFailedError';
    this.code = 'worker-failed';
  }
}

export class OperationError extends Error {
  constructor({ code, message }) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
  }
}

export class PdfWorkerClient {
  constructor(url = new URL('./workers/pdf-worker.js', import.meta.url), { name = 'foldr-pdf' } = {}) {
    this.url = url;
    this.name = name;
    this.worker = null;
    this.generation = 0;
    this.pending = new Map();
    this.nextId = 1;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(this.url, { type: 'module', name: this.name });
    worker.addEventListener('message', (event) => this.onMessage(event.data));
    worker.addEventListener('error', (event) => {
      event.preventDefault?.();
      console.error('Foldr: PDF worker error:', event.message);
      this.reset(new WorkerFailedError());
    });
    worker.addEventListener('messageerror', () => this.reset(new WorkerFailedError()));
    this.worker = worker;
    this.generation += 1;
    return worker;
  }

  onMessage({ id, type, progress, result, error }) {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (type === 'progress') {
      entry.onProgress?.(progress);
      return;
    }
    this.pending.delete(id);
    if (type === 'result') entry.resolve(result);
    else entry.reject(new OperationError(error));
  }

  request(type, payload = {}, { transfer = [], onProgress } = {}) {
    const worker = this.ensureWorker();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      try {
        worker.postMessage({ id, type, payload }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  reset(reason) {
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.pending.values()) entry.reject(reason);
    this.pending.clear();
  }

  cancel() {
    this.reset(new CancelledError());
  }

  get busy() {
    return this.pending.size > 0;
  }
}
