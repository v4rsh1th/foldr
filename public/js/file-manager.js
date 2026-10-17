// Reusable file manager. Holds the user's selected File objects (which are
// disk-backed; their bytes are only read when needed) and validates each one:
//   1. size limits, 2. "%PDF-" signature and end-of-file marker,
//   3. a real parse in the PDF worker (page count, encryption, structure).
// Entries removed while validating are ignored when their result arrives.

import { LIMITS } from './config.js';
import { formatBytes } from './core/format.js';
import {
  checkFileSize, checkSignature, FileValidationError, SIGNATURE_SEARCH_BYTES, TAIL_SEARCH_BYTES,
} from './core/validation.js';

let nextFileId = 1;

function readErrorMessage(error) {
  if (error?.name === 'NotReadableError' || error?.name === 'NotFoundError') {
    return 'Foldr couldn’t read this file. It may have been moved, deleted or be stored in the cloud only. Choose it again.';
  }
  return error?.message || 'Foldr couldn’t check this file.';
}

export function createFileManager({ client, multiple = true, onChange = () => {} }) {
  let entries = [];

  const emit = () => onChange(entries);
  const find = (id) => entries.find((entry) => entry.id === id);
  const patch = (id, changes) => {
    let changed = false;
    entries = entries.map((entry) => {
      if (entry.id !== id) return entry;
      changed = true;
      return { ...entry, ...changes };
    });
    if (changed) emit();
  };

  function release(ids) {
    const live = ids.filter(Boolean);
    if (live.length && client.worker) client.request('release', { fileIds: live }).catch(() => {});
  }

  async function inspect(entry) {
    const bytes = await entry.file.arrayBuffer();
    const generation = (client.ensureWorker(), client.generation);
    const info = await client.request('inspect', { fileId: entry.id, bytes }, { transfer: [bytes] });
    return { info, generation };
  }

  async function validate(entry) {
    const warnings = [];
    try {
      if (checkFileSize(entry.size) === 'warn') {
        warnings.push(`This is a large file (${formatBytes(entry.size)}). Processing may be slow and use a lot of memory.`);
      }
      const head = new Uint8Array(await entry.file.slice(0, SIGNATURE_SEARCH_BYTES).arrayBuffer());
      const tail = new Uint8Array(await entry.file.slice(Math.max(0, entry.size - TAIL_SEARCH_BYTES)).arrayBuffer());
      warnings.push(...checkSignature(entry.file, head, tail).warnings);
      if (!find(entry.id)) return;
      const { info, generation } = await inspect(entry);
      if (!find(entry.id)) {
        release([entry.id]);
        return;
      }
      if (info.features.hasSignatures) {
        warnings.push('This PDF is digitally signed. Any change made by Foldr will invalidate the signature.');
      }
      patch(entry.id, {
        status: 'ready', pageCount: info.pageCount, pages: info.pages, features: info.features, warnings, generation,
      });
    } catch (error) {
      if (!find(entry.id)) return;
      const message = error instanceof FileValidationError || error?.code ? error.message : readErrorMessage(error);
      if (!(error instanceof FileValidationError) && !error?.code) console.warn('Foldr: validation failed:', error?.name);
      patch(entry.id, { status: 'error', error: message, errorCode: error?.code ?? 'read-failed', warnings });
    }
  }

  function makeEntry(file) {
    const entry = {
      id: `f${nextFileId}`,
      file,
      name: file.name || 'Untitled.pdf',
      size: file.size,
      status: 'validating',
      pageCount: null,
      pages: null,
      features: null,
      warnings: [],
      error: null,
      generation: null,
    };
    nextFileId += 1;
    return entry;
  }

  return {
    get entries() { return entries; },
    get readyEntries() { return entries.filter((entry) => entry.status === 'ready'); },
    get isValidating() { return entries.some((entry) => entry.status === 'validating'); },
    get hasErrors() { return entries.some((entry) => entry.status === 'error'); },
    get totals() {
      return entries.reduce((sum, entry) => ({
        fileCount: sum.fileCount + 1,
        totalBytes: sum.totalBytes + entry.size,
        totalPages: sum.totalPages + (entry.pageCount ?? 0),
      }), { fileCount: 0, totalBytes: 0, totalPages: 0 });
    },

    /** Adds files. Single-file managers replace the current file. Returns the number of files ignored. */
    add(fileList) {
      let files = [...fileList];
      let ignored = 0;
      if (!multiple) {
        ignored = Math.max(0, files.length - 1);
        files = files.slice(0, 1);
        if (files.length) {
          release(entries.map((entry) => entry.id));
          entries = [];
        }
      } else if (entries.length + files.length > LIMITS.maxFiles) {
        ignored = entries.length + files.length - LIMITS.maxFiles;
        files = files.slice(0, Math.max(0, LIMITS.maxFiles - entries.length));
      }
      const added = files.map(makeEntry);
      entries = [...entries, ...added];
      emit();
      added.forEach(validate);
      return ignored;
    },

    replace(id, file) {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      release([id]);
      const entry = makeEntry(file);
      entries = entries.map((existing, i) => (i === index ? entry : existing));
      emit();
      validate(entry);
    },

    remove(id) {
      if (!find(id)) return;
      release([id]);
      entries = entries.filter((entry) => entry.id !== id);
      emit();
    },

    move(id, delta) {
      const from = entries.findIndex((entry) => entry.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= entries.length) return;
      const next = entries.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      entries = next;
      emit();
    },

    retry(id) {
      const entry = find(id);
      if (!entry) return;
      patch(id, { status: 'validating', error: null });
      validate(find(id));
    },

    /**
     * Makes sure the worker still holds parsed copies of these files. A
     * cancelled operation restarts the worker, dropping its cache.
     */
    async ensureRegistered(ids) {
      client.ensureWorker();
      for (const id of ids) {
        const entry = find(id);
        if (!entry || entry.generation === client.generation) continue;
        const { generation } = await inspect(entry);
        patch(id, { generation });
      }
    },

    clear() {
      release(entries.map((entry) => entry.id));
      entries = [];
      emit();
    },
  };
}
