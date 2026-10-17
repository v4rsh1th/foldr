// Merging copies real page objects (content streams, fonts, images) into a new
// document with pdf-lib. Nothing is rasterised: vector content and embedded
// images are carried over byte-for-byte. Each source is copied with a single
// copyPages call so resources shared between its pages are copied only once.
//
// Document-level structures (bookmarks, interactive form definitions,
// attachments, tagged structure) belong to a source's catalog rather than its
// pages and are not merged; pages and their annotations are.

import { PDFDocument } from '../../vendor/pdf-lib@1.17.1/pdf-lib.esm.min.js';
import { copyMetadata, savePdf, verifyOutput } from './common.js';

export async function mergeDocuments(sources, { onProgress = () => {} } = {}) {
  if (sources.length < 2) throw new RangeError('Merging needs at least two documents.');
  const output = await PDFDocument.create({ updateMetadata: false });
  const totalPages = sources.reduce((sum, doc) => sum + doc.getPageCount(), 0);
  let copied = 0;

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    onProgress({ phase: 'process', label: `Copying pages from file ${index + 1} of ${sources.length}`, done: copied, total: totalPages });
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
    copied += pages.length;
  }
  onProgress({ phase: 'process', label: 'Copying pages', done: copied, total: totalPages });

  copyMetadata(sources[0], output);
  onProgress({ phase: 'write', label: 'Writing the merged PDF' });
  const bytes = await savePdf(output);
  onProgress({ phase: 'verify', label: 'Checking the result' });
  await verifyOutput(bytes, { pageCount: totalPages });
  return { bytes, pageCount: totalPages };
}
