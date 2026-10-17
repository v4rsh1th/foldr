import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadPdf, inspectDocument, pruneUnreachableObjects } from '../../public/js/operations/common.js';
import { mergeDocuments } from '../../public/js/operations/merge.js';
import { splitDocument } from '../../public/js/operations/split.js';
import { editDocument } from '../../public/js/operations/organize.js';
import { createPages, movePage, deletePages, rotatePages, toExportPlan } from '../../public/js/core/page-order.js';
import { parsePageList, parseRangeGroups } from '../../public/js/core/page-ranges.js';
import { fixture, readWithPdfjs, labels } from './helpers.js';

async function open(name) {
  return loadPdf(await fixture(name));
}

describe('loading and validation', () => {
  test('inspects page count, sizes and existing rotation (including inherited)', async () => {
    const info = inspectDocument(await open('rotated-4.pdf'));
    assert.equal(info.pageCount, 4);
    assert.deepEqual(info.pages.map((p) => p.rotation), [0, 90, 270, 270]);
    assert.equal(Math.round(info.pages[2].width), 595);
  });

  test('detects document features', async () => {
    const { features } = inspectDocument(await open('structure-3.pdf'));
    assert.equal(features.hasForm, true);
    assert.equal(features.hasOutline, true);
    assert.equal(features.hasSignatures, false);
  });

  test('rejects encrypted documents with a clear code', async () => {
    await assert.rejects(open('encrypted.pdf'), { code: 'encrypted', message: /password-protected/ });
  });

  test('rejects corrupt and non-PDF bytes', async () => {
    await assert.rejects(open('corrupt.pdf'), { code: /invalid|no-pages/ });
    await assert.rejects(open('not-a-pdf.pdf'), { code: 'invalid' });
    await assert.rejects(open('empty.pdf'), { code: 'invalid' });
  });

  test('a truncated document is either rejected or loads without crashing', async () => {
    // pdf-lib is lenient with truncated files; the UI additionally warns when
    // the %%EOF marker is missing. This test pins down that behaviour.
    try {
      const doc = await open('truncated.pdf');
      assert.ok(doc.getPageCount() >= 0);
    } catch (error) {
      assert.match(error.code, /invalid|no-pages/);
    }
  });
});

describe('merge', () => {
  test('merges two documents in the chosen order', async () => {
    const { bytes, pageCount } = await mergeDocuments([await open('letter-3.pdf'), await open('a4-landscape-2.pdf')]);
    assert.equal(pageCount, 5);
    const result = await readWithPdfjs(bytes);
    assert.deepEqual(labels(result), ['Alpha 1', 'Alpha 2', 'Alpha 3', 'Bravo 1', 'Bravo 2']);
  });

  test('respects reversed file order and preserves sizes and orientation', async () => {
    const { bytes } = await mergeDocuments([
      await open('a4-landscape-2.pdf'), await open('mixed-sizes-4.pdf'), await open('letter-3.pdf'),
    ]);
    const result = await readWithPdfjs(bytes);
    assert.deepEqual(labels(result).slice(0, 3), ['Bravo 1', 'Bravo 2', 'Mixed 1']);
    assert.deepEqual(result.pages.map((p) => [p.width, p.height]), [
      [842, 595], [842, 595], [612, 792], [842, 595], [420, 595], [612, 1008], [612, 792], [612, 792], [612, 792],
    ]);
  });

  test('preserves existing page rotation', async () => {
    const { bytes } = await mergeDocuments([await open('letter-3.pdf'), await open('rotated-4.pdf')]);
    const result = await readWithPdfjs(bytes);
    assert.deepEqual(result.pages.map((p) => p.rotation), [0, 0, 0, 0, 90, 270, 270]);
  });

  test('keeps images as images (no rasterisation) and metadata from the first file', async () => {
    const images = await fixture('images.pdf');
    const { bytes } = await mergeDocuments([await open('letter-3.pdf'), await loadPdf(images)]);
    // Embedded image data is copied, not re-encoded: output is at least as big as the image file.
    assert.ok(bytes.length > images.length * 0.95);
    const result = await readWithPdfjs(bytes);
    assert.equal(result.pages.length, 6);
    assert.equal(result.info.Title, 'Alpha document');
    assert.match(result.pages[3].text, /JPEG photo page/);
  });

  test('merges many documents', async () => {
    const docs = await Promise.all(Array.from({ length: 6 }, () => open('letter-3.pdf')));
    const progress = [];
    const { pageCount } = await mergeDocuments(docs, { onProgress: (p) => progress.push(p.phase) });
    assert.equal(pageCount, 18);
    assert.ok(progress.includes('write') && progress.includes('verify'));
  });

  test('requires at least two documents', async () => {
    await assert.rejects(mergeDocuments([await open('letter-3.pdf')]), RangeError);
  });

  test('source documents are not modified', async () => {
    const original = await fixture('letter-3.pdf');
    const copy = original.slice();
    await mergeDocuments([await loadPdf(original), await open('compact.pdf')]);
    assert.deepEqual(original, copy);
  });
});

describe('split', () => {
  test('extracts selected pages in the requested order', async () => {
    const source = await open('mixed-sizes-4.pdf');
    const [output] = await splitDocument(source, [{ pages: parsePageList('4, 1-2', 4) }]);
    assert.deepEqual(labels(await readWithPdfjs(output.bytes)), ['Mixed 4', 'Mixed 1', 'Mixed 2']);
  });

  test('extracts a single page', async () => {
    const [output] = await splitDocument(await open('letter-3.pdf'), [{ pages: [2] }]);
    const result = await readWithPdfjs(output.bytes);
    assert.deepEqual(labels(result), ['Alpha 2']);
    assert.equal(result.info.Title, 'Alpha document');
  });

  test('splits into individual pages', async () => {
    const outputs = await splitDocument(await open('letter-3.pdf'), [{ pages: [1] }, { pages: [2] }, { pages: [3] }]);
    assert.equal(outputs.length, 3);
    for (const [index, output] of outputs.entries()) {
      assert.deepEqual(labels(await readWithPdfjs(output.bytes)), [`Alpha ${index + 1}`]);
    }
  });

  test('splits by ranges, including overlapping ranges', async () => {
    const groups = parseRangeGroups('1-2, 2-4, 3', 4);
    const outputs = await splitDocument(await open('mixed-sizes-4.pdf'), groups);
    const results = await Promise.all(outputs.map((o) => readWithPdfjs(o.bytes)));
    assert.deepEqual(results.map(labels), [['Mixed 1', 'Mixed 2'], ['Mixed 2', 'Mixed 3', 'Mixed 4'], ['Mixed 3']]);
  });

  test('duplicate pages (when explicitly allowed) are copied as separate pages', async () => {
    const [output] = await splitDocument(await open('letter-3.pdf'), [{ pages: [1, 2, 1] }]);
    const result = await readWithPdfjs(output.bytes);
    assert.deepEqual(labels(result), ['Alpha 1', 'Alpha 2', 'Alpha 1']);
  });

  test('keeps rotation of extracted pages', async () => {
    const [output] = await splitDocument(await open('rotated-4.pdf'), [{ pages: [2, 3] }]);
    assert.deepEqual((await readWithPdfjs(output.bytes)).pages.map((p) => p.rotation), [90, 270]);
  });

  test('rejects out-of-range pages instead of skipping them', async () => {
    await assert.rejects(splitDocument(await open('letter-3.pdf'), [{ pages: [1, 4] }]), { code: 'invalid-range' });
    await assert.rejects(splitDocument(await open('letter-3.pdf'), [{ pages: [] }]), RangeError);
  });
});

describe('organize and rotate', () => {
  async function runPlan(name, transform) {
    const bytes = await fixture(name);
    const info = inspectDocument(await loadPdf(bytes));
    const pages = transform(createPages(info.pages));
    const output = await editDocument(await loadPdf(bytes), toExportPlan(pages));
    return readWithPdfjs(output.bytes);
  }

  test('reorders pages to exactly 3, 1, 4, 2', async () => {
    const result = await runPlan('mixed-sizes-4.pdf', (pages) => movePage(movePage(pages, 2, 0), 3, 2));
    assert.deepEqual(labels(result), ['Mixed 3', 'Mixed 1', 'Mixed 4', 'Mixed 2']);
  });

  test('deletes pages', async () => {
    const result = await runPlan('letter-3.pdf', (pages) => deletePages(pages, [pages[1].key]));
    assert.deepEqual(labels(result), ['Alpha 1', 'Alpha 3']);
  });

  test('combined reorder and delete', async () => {
    const result = await runPlan('mixed-sizes-4.pdf', (pages) => {
      const moved = movePage(pages, 3, 0);
      return deletePages(moved, [moved[1].key]);
    });
    assert.deepEqual(labels(result), ['Mixed 4', 'Mixed 2', 'Mixed 3']);
  });

  test('rotates clockwise and counter-clockwise, persisted in the file', async () => {
    const result = await runPlan('letter-3.pdf', (pages) => rotatePages(rotatePages(pages, [pages[0].key], 90), [pages[2].key], -90));
    assert.deepEqual(result.pages.map((p) => p.rotation), [90, 0, 270]);
  });

  test('rotation adds to existing and inherited rotation exactly once', async () => {
    const result = await runPlan('rotated-4.pdf', (pages) => rotatePages(pages, null, 90));
    assert.deepEqual(result.pages.map((p) => p.rotation), [90, 180, 0, 0]);
    // Inherited MediaBox survives re-parenting.
    assert.deepEqual([result.pages[2].width, result.pages[2].height], [595, 842]);
  });

  test('reordering keeps bookmarks, form fields and metadata (in-place edit)', async () => {
    const result = await runPlan('structure-3.pdf', (pages) => movePage(pages, 0, 2));
    assert.deepEqual(labels(result), ['Struct 2', 'Struct 3', 'Struct 1']);
    assert.equal(result.outline?.[0]?.title, 'Chapter 1');
    assert.ok(result.fields?.name, 'form field "name" should still exist');
  });

  test('deleted pages are removed from the file, not just the page tree', async () => {
    const bytes = await fixture('many-200.pdf');
    const plan = [{ sourceIndex: 0, rotation: 0 }];
    const output = await editDocument(await loadPdf(bytes), plan);
    assert.ok(output.bytes.length < bytes.length / 20, `${output.bytes.length} should be far smaller than ${bytes.length}`);
  });

  test('refuses an empty page plan', async () => {
    await assert.rejects(editDocument(await open('letter-3.pdf'), []), { code: 'empty-output' });
  });

  test('refuses an invalid plan', async () => {
    await assert.rejects(editDocument(await open('letter-3.pdf'), [{ sourceIndex: 0, rotation: 0 }, { sourceIndex: 0, rotation: 0 }]), RangeError);
    await assert.rejects(editDocument(await open('letter-3.pdf'), [{ sourceIndex: 5, rotation: 0 }]), RangeError);
  });
});

test('pruneUnreachableObjects keeps everything reachable', async () => {
  const doc = await open('structure-3.pdf');
  const removed = pruneUnreachableObjects(doc.context);
  assert.ok(removed >= 0);
  const output = await doc.save();
  const result = await readWithPdfjs(output);
  assert.equal(result.pages.length, 3);
  assert.equal(result.outline?.[0]?.title, 'Chapter 1');
});
