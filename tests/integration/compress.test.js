import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFName, PDFRawStream } from '../../public/vendor/pdf-lib@1.17.1/pdf-lib.esm.min.js';
import { loadPdf } from '../../public/js/operations/common.js';
import {
  compressDocument, deduplicateStreams, analyzeImage, targetDimensions, unpredict, COMPRESSION_MODES,
} from '../../public/js/operations/compress.js';
import { describeSizeChange } from '../../public/js/core/format.js';
import { fixture, readWithPdfjs, labels } from './helpers.js';

async function compress(name, mode, codec) {
  const original = await fixture(name);
  const result = await compressDocument(await loadPdf(original), { mode, codec });
  return { original, ...result };
}

function imageStreams(doc) {
  return doc.context.enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFRawStream && object.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image'));
}

describe('lossless', () => {
  test('text-heavy PDF with uncompressed streams gets much smaller and stays identical in content', async () => {
    const { original, bytes, stats } = await compress('text-heavy.pdf', 'lossless');
    const change = describeSizeChange(original.length, bytes.length);
    assert.equal(change.direction, 'smaller');
    assert.ok(change.percent < -50, `expected >50% reduction, got ${change.label}`);
    assert.ok(stats.compressedStreams >= 20);
    const [before, after] = [await readWithPdfjs(original), await readWithPdfjs(bytes)];
    assert.deepEqual(after.pages.map((p) => p.text), before.pages.map((p) => p.text));
  });

  test('duplicate images are merged into one object', async () => {
    const { original, bytes, stats } = await compress('duplicate-images.pdf', 'lossless');
    assert.equal(stats.mergedDuplicates, 1);
    assert.ok(bytes.length < original.length * 0.6);
    const doc = await loadPdf(bytes);
    assert.equal(imageStreams(doc).length, 1);
    assert.equal((await readWithPdfjs(bytes)).pages.length, 2);
  });

  test('an already-compact PDF is reported honestly when it cannot shrink', async () => {
    const { original, bytes } = await compress('compact.pdf', 'lossless');
    const change = describeSizeChange(original.length, bytes.length);
    // The result is valid either way; the size change must simply be reported as-is.
    assert.ok(['same', 'larger', 'smaller'].includes(change.direction));
    assert.equal(change.absoluteDelta, Math.abs(bytes.length - original.length));
    assert.deepEqual(labels(await readWithPdfjs(bytes)), ['Compact 1']);
  });

  test('preserves page count, sizes and images untouched', async () => {
    const { original, bytes } = await compress('images.pdf', 'lossless');
    const [before, after] = [await readWithPdfjs(original), await readWithPdfjs(bytes)];
    assert.deepEqual(after.pages.map((p) => [p.width, p.height]), before.pages.map((p) => [p.width, p.height]));
    const originalImages = imageStreams(await loadPdf(original)).map(([, s]) => s.contents.length).sort();
    const newImages = imageStreams(await loadPdf(bytes)).map(([, s]) => s.contents.length).sort();
    assert.deepEqual(newImages, originalImages);
  });
});

describe('lossy pipeline (stub codec)', () => {
  // The stub "encodes" by returning a fixed small buffer. It lets us verify
  // which images are chosen, the dimensions requested and the dictionary that
  // is written, without a JPEG codec in Node. Real re-encoding is covered by
  // the browser tests.
  function stubCodec() {
    const calls = [];
    return {
      calls,
      async decodeJpeg(bytes) { return { kind: 'jpeg', length: bytes.length }; },
      async fromPixels(rgba, width, height) {
        assert.equal(rgba.length, width * height * 4);
        return { kind: 'pixels', width, height };
      },
      async encodeJpeg(image, width, height, quality) {
        calls.push({ kind: image.kind, width, height, quality });
        return new Uint8Array(20_000).fill(1);
      },
    };
  }

  test('balanced re-encodes JPEG images only and downsamples to 150 ppi', async () => {
    const codec = stubCodec();
    const { bytes, stats } = await compress('images.pdf', 'balanced', codec);
    assert.equal(codec.calls.length, 1);
    assert.equal(codec.calls[0].kind, 'jpeg');
    assert.equal(codec.calls[0].quality, 0.8);
    // Letter page, longest side 792 pt = 11 in, at 150 ppi = 1650 px.
    assert.deepEqual([codec.calls[0].width, codec.calls[0].height], [1650, 1238]);
    assert.equal(stats.images.recompressed, 1);
    assert.equal(stats.images.skipped['lossless-kept'], 1);
    const doc = await loadPdf(bytes);
    const jpeg = imageStreams(doc).find(([, s]) => s.dict.lookup(PDFName.of('Filter')) === PDFName.of('DCTDecode'))[1];
    assert.equal(jpeg.dict.lookup(PDFName.of('Width')).asNumber(), 1650);
    assert.equal(jpeg.contents.length, 20_000);
  });

  test('smaller also converts lossless images, at 100 ppi and lower quality', async () => {
    const codec = stubCodec();
    const { stats } = await compress('images.pdf', 'smaller', codec);
    assert.equal(codec.calls.length, 2);
    assert.deepEqual(codec.calls.map((c) => c.kind).sort(), ['jpeg', 'pixels']);
    assert.ok(codec.calls.every((c) => c.quality === 0.6 && Math.max(c.width, c.height) <= 1100));
    assert.equal(stats.images.recompressed, 2);
  });

  test('an image is kept when re-encoding would not save at least 10%', async () => {
    const codec = { ...stubCodec(), encodeJpeg: async () => new Uint8Array(50_000_000) };
    const { stats } = await compress('images.pdf', 'balanced', codec);
    assert.equal(stats.images.recompressed, 0);
    assert.equal(stats.images.skipped['no-gain'], 1);
  });

  test('a decoding failure leaves the image unchanged instead of failing the job', async () => {
    const codec = { ...stubCodec(), decodeJpeg: async () => { throw new Error('bad jpeg'); } };
    const { stats, pageCount } = await compress('images.pdf', 'balanced', codec);
    assert.equal(stats.images.failed, 1);
    assert.equal(pageCount, 3);
  });

  test('lossy modes require a codec', async () => {
    await assert.rejects(compress('images.pdf', 'balanced', null));
  });

  test('modes are genuinely different', () => {
    assert.notDeepEqual(COMPRESSION_MODES.balanced, COMPRESSION_MODES.smaller);
    assert.equal(COMPRESSION_MODES.lossless.lossy, false);
  });
});

describe('image helpers', () => {
  test('targetDimensions keeps small images and scales large ones proportionally', () => {
    assert.deepEqual(targetDimensions(800, 600, 792, 150), { width: 800, height: 600, scaled: false });
    assert.deepEqual(targetDimensions(3300, 2550, 792, 150), { width: 1650, height: 1275, scaled: true });
  });

  test('unpredict reverses PNG Sub/Up/Average/Paeth filters', () => {
    // 2x2 RGB image, rows filtered with Sub (1) then Up (2).
    const rows = new Uint8Array([
      1, 10, 20, 30, 5, 5, 5,
      2, 1, 1, 1, 1, 1, 1,
    ]);
    assert.deepEqual([...unpredict(rows, { predictor: 15, colors: 3, columns: 2 })], [10, 20, 30, 15, 25, 35, 11, 21, 31, 16, 26, 36]);
    const avg = new Uint8Array([3, 10, 4]); // single gray row: 10, 4 + floor(10/2) = 9
    assert.deepEqual([...unpredict(avg, { predictor: 10, colors: 1, columns: 2 })], [10, 9]);
    const paeth = new Uint8Array([0, 50, 60, 4, 1, 1]); // row2: paeth(0,50,0)=50 -> 51; paeth(51,60,50)=60 -> 61
    assert.deepEqual([...unpredict(paeth, { predictor: 12, colors: 1, columns: 2 })], [50, 60, 51, 61]);
  });

  test('analyzeImage skips images whose structure can’t be re-encoded safely', async () => {
    const doc = await loadPdf(await fixture('images.pdf'));
    const [[, image]] = imageStreams(doc).filter(([, s]) => s.dict.lookup(PDFName.of('Filter')) === PDFName.of('DCTDecode'));
    const settings = COMPRESSION_MODES.smaller;
    assert.equal(analyzeImage(doc.context, image, settings).kind, 'jpeg');
    const masked = PDFRawStream.of(image.dict.clone(doc.context), image.contents);
    masked.dict.set(PDFName.of('Decode'), doc.context.obj([1, 0, 1, 0, 1, 0]));
    assert.equal(analyzeImage(doc.context, masked, settings).skip, 'unsupported-structure');
    const cmyk = PDFRawStream.of(image.dict.clone(doc.context), image.contents);
    cmyk.dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceCMYK'));
    assert.equal(analyzeImage(doc.context, cmyk, settings).skip, 'unsupported-color');
  });

  test('deduplicateStreams is a no-op when nothing is duplicated', async () => {
    const doc = await loadPdf(await fixture('letter-3.pdf'));
    assert.equal(await deduplicateStreams(doc.context), 0);
  });
});
