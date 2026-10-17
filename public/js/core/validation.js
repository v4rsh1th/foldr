// First-pass validation that runs before a file is parsed. The decisive
// check is the "%PDF-" signature: extension and MIME type are only used to
// word messages, because valid PDFs frequently arrive with a wrong or empty
// MIME type (e.g. application/octet-stream from downloads or email clients).

import { LIMITS } from '../config.js';
import { formatBytes, pluralize } from './format.js';

const PDF_MIME_TYPES = new Set(['application/pdf', 'application/x-pdf', 'application/acrobat', 'text/pdf']);
const SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
// The spec allows the header to be preceded by junk; Acrobat accepts it within the first 1024 bytes.
export const SIGNATURE_SEARCH_BYTES = 1024;
export const TAIL_SEARCH_BYTES = 2048;

export function looksLikePdfByName(name) {
  return /\.pdf$/i.test(String(name ?? ''));
}

export function looksLikePdfByType(type) {
  return PDF_MIME_TYPES.has(String(type ?? '').toLowerCase());
}

/** Returns the byte offset of "%PDF-" in the header bytes, or -1. */
export function findPdfSignature(headBytes) {
  const limit = Math.min(headBytes.length, SIGNATURE_SEARCH_BYTES) - SIGNATURE.length;
  outer: for (let i = 0; i <= limit; i += 1) {
    for (let j = 0; j < SIGNATURE.length; j += 1) {
      if (headBytes[i + j] !== SIGNATURE[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** True if "%%EOF" occurs in the trailing bytes. Missing markers suggest truncation. */
export function hasEofMarker(tailBytes) {
  const marker = [0x25, 0x25, 0x45, 0x4f, 0x46];
  outer: for (let i = tailBytes.length - marker.length; i >= 0; i -= 1) {
    for (let j = 0; j < marker.length; j += 1) {
      if (tailBytes[i + j] !== marker[j]) continue outer;
    }
    return true;
  }
  return false;
}

export class FileValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FileValidationError';
    this.code = code;
  }
}

/**
 * Checks the signature bytes of a file. `head`/`tail` are Uint8Arrays of the
 * first SIGNATURE_SEARCH_BYTES and last TAIL_SEARCH_BYTES bytes.
 * Returns { warnings } or throws FileValidationError.
 */
export function checkSignature({ name, type, size }, head, tail) {
  if (size === 0) {
    throw new FileValidationError('empty', 'This file is empty (0 bytes). Choose a different file.');
  }
  if (findPdfSignature(head) < 0) {
    const hint = looksLikePdfByName(name) || looksLikePdfByType(type)
      ? 'It has a .pdf name, but its contents aren’t a PDF. It may be damaged or a different file type renamed to .pdf.'
      : 'Foldr only works with PDF documents.';
    throw new FileValidationError('not-pdf', `This isn’t a PDF file. ${hint}`);
  }
  const warnings = [];
  if (!hasEofMarker(tail)) {
    warnings.push('The file may be incomplete: its end-of-file marker is missing. Check the result carefully.');
  }
  return { warnings };
}

/** Per-file size check. Returns 'ok' | 'warn', throws when over the hard limit. */
export function checkFileSize(size, limits = LIMITS) {
  if (size > limits.maxFileBytes) {
    throw new FileValidationError(
      'too-large',
      `This file is ${formatBytes(size)}, which is more than Foldr can safely process in a browser tab (${formatBytes(limits.maxFileBytes)}). Try splitting it with a desktop app first.`,
    );
  }
  return size > limits.warnFileBytes ? 'warn' : 'ok';
}

/**
 * Checks the combined workload of a set of files before an operation.
 * Returns { level: 'ok' | 'warn' | 'block', message }.
 */
export function assessWorkload({ fileCount, totalBytes, totalPages }, limits = LIMITS) {
  if (fileCount > limits.maxFiles) {
    return { level: 'block', message: `Foldr can combine up to ${limits.maxFiles} files at once. Remove ${fileCount - limits.maxFiles} and try again.` };
  }
  if (totalBytes > limits.maxTotalBytes || totalPages > limits.maxTotalPages) {
    return {
      level: 'block',
      message: `This job (${formatBytes(totalBytes)}, ${pluralize(totalPages, 'page')}) is larger than Foldr can safely process in a browser tab. Split the work into smaller batches.`,
    };
  }
  if (totalBytes > limits.warnTotalBytes || totalPages > limits.warnTotalPages) {
    return {
      level: 'warn',
      message: `This is a large job (${formatBytes(totalBytes)}, ${pluralize(totalPages, 'page')}). It may take a while and use a lot of memory; on phones or low-memory devices the tab could run out of memory. Nothing is uploaded, so if that happens no data is lost—just try a smaller batch.`,
    };
  }
  return { level: 'ok', message: '' };
}
