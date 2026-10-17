// Shared pdf-lib helpers: loading, inspection, metadata, garbage collection,
// and output verification. Everything here runs inside the PDF worker (and in
// Node for tests); nothing touches the DOM.

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFStream,
  ParseSpeeds,
} from '../../vendor/pdf-lib@1.17.1/pdf-lib.esm.min.js';

export class PdfOperationError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'PdfOperationError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export const MESSAGES = {
  encrypted:
    'This PDF is encrypted or password-protected, so Foldr can’t modify it. Remove the protection in the app that created it (or use “Print to PDF”), then try again.',
  invalid:
    'Foldr couldn’t open this PDF. It may be corrupted, encrypted, or use a feature that this browser-based processor doesn’t support.',
  noPages: 'This PDF doesn’t contain any pages.',
  outputInvalid:
    'Foldr created a file but it didn’t pass verification, so it wasn’t offered for download. Your original file is unchanged. Please try again.',
};

const LOAD_OPTIONS = { updateMetadata: false, parseSpeed: ParseSpeeds.Fastest };

/** Parses PDF bytes, translating library errors into user-facing codes. */
export async function loadPdf(bytes) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, LOAD_OPTIONS);
  } catch (error) {
    if (error?.name === 'EncryptedPDFError' || /encrypted/i.test(error?.message ?? '')) {
      throw new PdfOperationError('encrypted', MESSAGES.encrypted, error);
    }
    throw new PdfOperationError('invalid', MESSAGES.invalid, error);
  }
  let pageCount;
  try {
    pageCount = doc.getPages().length;
  } catch (error) {
    throw new PdfOperationError('invalid', MESSAGES.invalid, error);
  }
  if (pageCount === 0) throw new PdfOperationError('no-pages', MESSAGES.noPages);
  return doc;
}

export function normalizeAngle(angle) {
  const quarter = Math.round((Number(angle) || 0) / 90) * 90;
  return ((quarter % 360) + 360) % 360;
}

function lookupDict(context, value) {
  const resolved = value instanceof PDFRef ? context.lookup(value) : value;
  return resolved instanceof PDFDict ? resolved : undefined;
}

function hasSignatureField(context, fields, depth = 0) {
  if (!(fields instanceof PDFArray) || depth > 8) return false;
  for (let i = 0; i < fields.size(); i += 1) {
    const field = lookupDict(context, fields.get(i));
    if (!field) continue;
    if (field.lookup(PDFName.of('FT')) === PDFName.of('Sig')) return true;
    if (hasSignatureField(context, field.lookup(PDFName.of('Kids')), depth + 1)) return true;
  }
  return false;
}

/** Features that may not survive every operation; used to warn the user. */
export function detectFeatures(doc) {
  const { context, catalog } = doc;
  const acroForm = lookupDict(context, catalog.get(PDFName.of('AcroForm')));
  const fields = acroForm?.lookup(PDFName.of('Fields'));
  const outlines = lookupDict(context, catalog.get(PDFName.of('Outlines')));
  const names = lookupDict(context, catalog.get(PDFName.of('Names')));
  return {
    hasForm: fields instanceof PDFArray && fields.size() > 0,
    hasSignatures: hasSignatureField(context, fields),
    hasOutline: Boolean(outlines?.get(PDFName.of('First'))),
    hasAttachments: Boolean(names?.get(PDFName.of('EmbeddedFiles'))),
  };
}

export function inspectDocument(doc) {
  const pages = doc.getPages().map((page) => {
    const { width, height } = page.getSize();
    return { width, height, rotation: normalizeAngle(page.getRotation().angle) };
  });
  return { pageCount: pages.length, pages, features: detectFeatures(doc) };
}

const METADATA_FIELDS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator'];

/** Copies descriptive metadata from `source` to `target` and stamps fresh dates. */
export function copyMetadata(source, target) {
  const info = lookupDict(source.context, source.context.trailerInfo.Info);
  if (info) {
    const targetInfo = target.getInfoDict();
    for (const field of METADATA_FIELDS) {
      const value = info.lookup(PDFName.of(field));
      // Strings are direct objects, so they can be moved between documents as-is.
      if (value && !(value instanceof PDFRef)) targetInfo.set(PDFName.of(field), value);
    }
  }
  const lang = source.catalog.lookup(PDFName.of('Lang'));
  if (lang) target.catalog.set(PDFName.of('Lang'), lang);
  stampModified(target);
}

export function stampModified(doc) {
  const now = new Date();
  doc.setProducer('Foldr (pdf-lib)');
  doc.setModificationDate(now);
  if (!doc.getCreationDate()) doc.setCreationDate(now);
}

/**
 * Deletes indirect objects that cannot be reached from the trailer.
 * pdf-lib writes every object in its context, so without this, pages removed
 * from the page tree (and superseded objects from incremental updates) would
 * still be written to the output file.
 */
export function pruneUnreachableObjects(context) {
  const reachable = new Set();
  const stack = [];
  const visit = (value) => {
    if (value instanceof PDFRef) {
      if (reachable.has(value)) return;
      reachable.add(value);
      const target = context.lookup(value);
      if (target) stack.push(target);
    } else if (value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream) {
      stack.push(value);
    }
  };
  const { Root, Info, Encrypt, ID } = context.trailerInfo;
  [Root, Info, Encrypt, ID].forEach(visit);
  while (stack.length) {
    const object = stack.pop();
    if (object instanceof PDFStream) {
      visit(object.dict);
    } else if (object instanceof PDFDict) {
      for (const [, value] of object.entries()) visit(value);
    } else if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i += 1) visit(object.get(i));
    }
  }
  let removed = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) {
      context.delete(ref);
      removed += 1;
    }
  }
  return removed;
}

export const SAVE_OPTIONS = Object.freeze({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 5000 });

export async function savePdf(doc) {
  try {
    return await doc.save(SAVE_OPTIONS);
  } catch (error) {
    throw new PdfOperationError('save-failed', 'Foldr couldn’t write the new PDF. The document may use a structure this processor can’t rewrite.', error);
  }
}

/**
 * Re-parses generated bytes and checks the page count (and optionally page
 * sizes). Output is only offered for download after this passes.
 */
export async function verifyOutput(bytes, { pageCount, pageSizes } = {}) {
  const header = String.fromCharCode(...bytes.subarray(0, 5));
  if (bytes.length < 64 || header !== '%PDF-') {
    throw new PdfOperationError('output-invalid', MESSAGES.outputInvalid);
  }
  let doc;
  try {
    doc = await PDFDocument.load(bytes, LOAD_OPTIONS);
  } catch (error) {
    throw new PdfOperationError('output-invalid', MESSAGES.outputInvalid, error);
  }
  const pages = doc.getPages();
  if (pageCount !== undefined && pages.length !== pageCount) {
    throw new PdfOperationError('output-invalid', MESSAGES.outputInvalid);
  }
  if (pageSizes) {
    pages.forEach((page, index) => {
      const { width, height } = page.getSize();
      const expected = pageSizes[index];
      if (Math.abs(width - expected.width) > 0.01 || Math.abs(height - expected.height) > 0.01) {
        throw new PdfOperationError('output-invalid', MESSAGES.outputInvalid);
      }
    });
  }
  return doc;
}

