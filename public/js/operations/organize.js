// Organize and Rotate both apply a page plan — [{ sourceIndex, rotation }] —
// to the source document *in place*. Editing in place (rather than copying
// pages into a new file) keeps document-level structures such as bookmarks,
// form definitions, attachments and metadata.
//
// The page tree is rebuilt as a single flat /Pages node in plan order. Before
// re-parenting, inheritable attributes (Resources, MediaBox, CropBox, Rotate)
// are copied onto each page so nothing that was inherited from an old
// intermediate node is lost. `rotation` is written as the page's absolute
// /Rotate value; the caller has already combined the original rotation with
// the user's change, so it is applied exactly once.

import { PDFName, PDFNumber, PDFPageLeaf } from '../../vendor/pdf-lib@1.17.1/pdf-lib.esm.min.js';
import { PdfOperationError, normalizeAngle, pruneUnreachableObjects, savePdf, stampModified, verifyOutput } from './common.js';

function validatePlan(plan, pageCount) {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new PdfOperationError('empty-output', 'A PDF needs at least one page. Keep at least one page and try again.');
  }
  const seen = new Set();
  for (const entry of plan) {
    const { sourceIndex, rotation } = entry;
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= pageCount || seen.has(sourceIndex)) {
      throw new RangeError(`Invalid page plan entry ${JSON.stringify(entry)}`);
    }
    if (rotation % 90 !== 0) throw new RangeError(`Rotation must be a multiple of 90, got ${rotation}`);
    seen.add(sourceIndex);
  }
}

export function applyPagePlan(doc, plan) {
  const pages = doc.getPages();
  validatePlan(plan, pages.length);
  const { context } = doc;

  const kept = plan.map(({ sourceIndex }) => pages[sourceIndex]);
  for (const page of kept) {
    for (const key of PDFPageLeaf.InheritableEntries) {
      const name = PDFName.of(key);
      if (!page.node.has(name)) {
        const inherited = page.node.getInheritableAttribute(name);
        if (inherited) page.node.set(name, inherited);
      }
    }
  }

  const treeRef = context.register(
    context.obj({ Type: 'Pages', Kids: kept.map((page) => page.ref), Count: kept.length }),
  );
  kept.forEach((page, index) => {
    page.node.set(PDFName.of('Parent'), treeRef);
    page.node.set(PDFName.of('Rotate'), PDFNumber.of(normalizeAngle(plan[index].rotation)));
  });
  doc.catalog.set(PDFName.of('Pages'), treeRef);
  return pruneUnreachableObjects(context);
}

export async function editDocument(doc, plan, { onProgress = () => {} } = {}) {
  onProgress({ phase: 'process', label: 'Arranging pages' });
  applyPagePlan(doc, plan);
  stampModified(doc);
  onProgress({ phase: 'write', label: 'Writing the PDF' });
  const bytes = await savePdf(doc);
  onProgress({ phase: 'verify', label: 'Checking the result' });
  const check = await verifyOutput(bytes, { pageCount: plan.length });
  // Confirm the rotation actually persisted in the file, not just in the preview.
  check.getPages().forEach((page, index) => {
    if (normalizeAngle(page.getRotation().angle) !== normalizeAngle(plan[index].rotation)) {
      throw new PdfOperationError('output-invalid', 'The rotated pages didn’t verify correctly, so the file wasn’t offered for download.');
    }
  });
  return { bytes, pageCount: plan.length };
}
