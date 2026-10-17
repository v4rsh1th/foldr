// Splitting builds one new document per group of pages. Pages are copied as
// real PDF objects; each output gets its own copy of the resources it uses.

import { PDFDocument } from '../../vendor/pdf-lib@1.17.1/pdf-lib.esm.min.js';
import { PdfOperationError, copyMetadata, savePdf, verifyOutput } from './common.js';

async function buildDocument(source, pageNumbers) {
  const output = await PDFDocument.create({ updateMetadata: false });
  const indices = pageNumbers.map((page) => page - 1);
  // pdf-lib's copier caches by object, so copying the same page twice in one
  // call would insert the same page object twice. Copy repeats separately.
  const first = [];
  const seen = new Set();
  for (const index of indices) {
    if (!seen.has(index)) first.push(index);
    seen.add(index);
  }
  const copies = new Map();
  const firstPages = await output.copyPages(source, first);
  first.forEach((index, i) => copies.set(index, firstPages[i]));
  const used = new Set();
  for (const index of indices) {
    if (used.has(index)) {
      const [repeat] = await output.copyPages(source, [index]);
      output.addPage(repeat);
    } else {
      output.addPage(copies.get(index));
      used.add(index);
    }
  }
  copyMetadata(source, output);
  return output;
}

/**
 * `groups` is [{ pages: [1-based page numbers] }]. Returns one output per group,
 * in the same order. Every requested page is included; nothing is skipped.
 */
export async function splitDocument(source, groups, { onProgress = () => {} } = {}) {
  const pageCount = source.getPageCount();
  if (!groups.length) throw new RangeError('Nothing to split.');
  for (const group of groups) {
    if (!group.pages.length) throw new RangeError('Every output needs at least one page.');
    for (const page of group.pages) {
      if (!Number.isInteger(page) || page < 1 || page > pageCount) {
        throw new PdfOperationError('invalid-range', `Page ${page} doesn’t exist in this document.`);
      }
    }
  }

  const outputs = [];
  for (let index = 0; index < groups.length; index += 1) {
    onProgress({ phase: 'process', label: `Creating file ${index + 1} of ${groups.length}`, done: index, total: groups.length });
    const doc = await buildDocument(source, groups[index].pages);
    const bytes = await savePdf(doc);
    await verifyOutput(bytes, { pageCount: groups[index].pages.length });
    outputs.push({ bytes, pageCount: groups[index].pages.length });
  }
  onProgress({ phase: 'process', label: 'Creating files', done: groups.length, total: groups.length });
  return outputs;
}
