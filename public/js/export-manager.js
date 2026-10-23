// One place for turning worker output into downloadable files. Outputs are
// Blobs (never data: URLs or Base64); object URLs are created on demand and
// revoked when the result is discarded. Revocation is delayed so a download
// the user just started is never cut off.

import { sanitizeFilename, uniqueFilenames } from './core/filenames.js';
import { createZip } from './core/zip.js';

const REVOKE_DELAY_MS = 60_000;
let nextOutputId = 1;

export function createExportManager() {
  const urls = new Map();
  let disposed = false;

  function urlFor(output) {
    if (disposed) throw new Error('This result has been cleared.');
    if (!urls.has(output.id)) urls.set(output.id, URL.createObjectURL(output.blob));
    return urls.get(output.id);
  }

  function triggerDownload(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
  }

  return {
    /**
     * Wraps a result as a downloadable output: a PDF from `buffer`, or any
     * file from `blob` with its `extension` (e.g. ".jpg").
     */
    createOutput({ buffer, blob: source, name, pageCount, extension = '.pdf', extra = {} }) {
      const blob = source ?? new Blob([buffer ?? []], { type: 'application/pdf' });
      if (blob.size === 0) throw new Error('The generated file is empty.');
      const output = { id: `o${nextOutputId}`, blob, name, pageCount, extension, size: blob.size, ...extra };
      nextOutputId += 1;
      return output;
    },

    download(output, filename = output.name) {
      const name = sanitizeFilename(filename, { extension: output.extension });
      triggerDownload(urlFor(output), name);
      return name;
    },

    /** Opens the file in a new tab using the browser's own viewer. */
    open(output) {
      const opened = window.open(urlFor(output), '_blank', 'noopener');
      return Boolean(opened) || opened === null;
    },

    async downloadZip(outputs, zipName) {
      const names = uniqueFilenames(outputs.map((output) => sanitizeFilename(output.name, { extension: output.extension })));
      const entries = [];
      for (const [index, output] of outputs.entries()) {
        entries.push({ name: names[index], bytes: new Uint8Array(await output.blob.arrayBuffer()) });
      }
      const zip = await createZip(entries);
      const url = URL.createObjectURL(zip);
      const name = sanitizeFilename(zipName, { extension: '.zip' });
      triggerDownload(url, name);
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
      return name;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      const pending = [...urls.values()];
      urls.clear();
      setTimeout(() => pending.forEach((url) => URL.revokeObjectURL(url)), REVOKE_DELAY_MS);
    },
  };
}
