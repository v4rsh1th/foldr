import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pdf');

export async function fixture(name) {
  return new Uint8Array(await readFile(path.join(fixtureDir, name)));
}

/**
 * Opens bytes with PDF.js (independent of pdf-lib, which produced them) and
 * returns per-page { text, rotation, width, height } plus document metadata.
 */
export async function readWithPdfjs(bytes) {
  const task = getDocument({ data: bytes.slice(), verbosity: VerbosityLevel.ERRORS, isEvalSupported: false });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const [x0, y0, x1, y1] = page.view;
      pages.push({
        text: content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim(),
        rotation: page.rotate,
        width: Math.round(x1 - x0),
        height: Math.round(y1 - y0),
      });
    }
    const { info } = await doc.getMetadata();
    const outline = await doc.getOutline();
    const fields = await doc.getFieldObjects();
    return { pages, info, outline, fields };
  } finally {
    await task.destroy();
  }
}

/** The big label each fixture page carries, e.g. "Alpha 2". */
export function labels(result) {
  return result.pages.map((page) => page.text.replace(/\s*TOP\s*/, ' ').trim());
}
