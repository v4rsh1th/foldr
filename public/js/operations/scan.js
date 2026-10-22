// Builds a PDF from scanned pages. Each page is one image filling the page:
// colour and greyscale pages are JPEGs embedded as-is (no re-encoding), and
// black-and-white pages are 1-bit images with Flate compression, which keeps
// text razor-sharp at a fraction of a JPEG's size.

import {
  PDFDocument,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  drawObject,
} from '../../vendor/pdf-lib@1.17.1/pdf-lib.esm.min.js';
import { PdfOperationError, savePdf, verifyOutput } from './common.js';

// Points (1/72 inch), portrait.
export const SCAN_PAGE_SIZES = Object.freeze({
  auto: [595.28, 841.89],
  a4: [595.28, 841.89],
  letter: [612, 792],
});

/**
 * Page size and image placement for an image of `width` × `height` pixels.
 * "auto" makes the page the image's shape, as large as fits on A4; fixed
 * sizes centre the whole image on the page. Orientation follows the image.
 */
export function layoutScanPage(width, height, pageSize = 'auto') {
  const base = SCAN_PAGE_SIZES[pageSize];
  if (!base) throw new RangeError(`Unknown page size ${pageSize}`);
  const [short, long] = base;
  const [boxWidth, boxHeight] = width > height ? [long, short] : [short, long];
  const scale = Math.min(boxWidth / width, boxHeight / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  if (pageSize === 'auto') {
    return { pageWidth: drawWidth, pageHeight: drawHeight, x: 0, y: 0, width: drawWidth, height: drawHeight };
  }
  return {
    pageWidth: boxWidth,
    pageHeight: boxHeight,
    x: (boxWidth - drawWidth) / 2,
    y: (boxHeight - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  };
}

function embedBitonal(doc, page, { bytes, width, height }, placement) {
  const stream = doc.context.flateStream(new Uint8Array(bytes), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 1,
  });
  const name = page.node.newXObject('Scan', doc.context.register(stream));
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(placement.width, 0, 0, placement.height, placement.x, placement.y),
    drawObject(name),
    popGraphicsState(),
  );
}

/**
 * `pages`: [{ kind: 'jpeg' | 'bitonal', bytes, width, height }] in order.
 * Returns { bytes, pageCount }.
 */
export async function buildScanDocument(pages, { pageSize = 'auto', title, onProgress = () => {} } = {}) {
  if (!pages.length) throw new PdfOperationError('no-pages', 'Add at least one page to create a PDF.');
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pageSizes = [];
  for (const [index, image] of pages.entries()) {
    onProgress({ phase: 'write', label: 'Adding pages to the PDF', done: index, total: pages.length });
    const placement = layoutScanPage(image.width, image.height, pageSize);
    const page = doc.addPage([placement.pageWidth, placement.pageHeight]);
    pageSizes.push({ width: placement.pageWidth, height: placement.pageHeight });
    if (image.kind === 'bitonal') {
      embedBitonal(doc, page, image, placement);
    } else {
      let embedded;
      try {
        embedded = await doc.embedJpg(new Uint8Array(image.bytes));
      } catch (error) {
        throw new PdfOperationError('invalid-image', 'One of the pages couldn’t be added to the PDF. Remove it or retake it, then try again.', error);
      }
      page.drawImage(embedded, placement);
    }
  }
  const now = new Date();
  if (title) doc.setTitle(title);
  doc.setCreator('Foldr Scan');
  doc.setProducer('Foldr (pdf-lib)');
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  onProgress({ phase: 'write', label: 'Writing the PDF' });
  const bytes = await savePdf(doc);
  onProgress({ phase: 'verify', label: 'Checking the result' });
  await verifyOutput(bytes, { pageCount: pages.length, pageSizes });
  return { bytes, pageCount: pages.length };
}
