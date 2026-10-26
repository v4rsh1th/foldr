import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PDFDocument, StandardFonts } from '../../public/vendor/pdf-lib@1.17.1/pdf-lib.esm.min.js';
import { buildScanDocument, layoutScanPage } from '../../public/js/operations/scan.js';
import { packBits } from '../../public/js/core/scan-enhance.js';
import { readWithPdfjs } from './helpers.js';

const imageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'images');

test('layoutScanPage: auto pages take the image shape; fixed sizes centre it', () => {
  const auto = layoutScanPage(1000, 2000, 'auto');
  assert.ok(Math.abs(auto.pageWidth / auto.pageHeight - 0.5) < 1e-9);
  assert.ok(auto.pageHeight <= 841.9 && auto.pageWidth <= 595.3);
  const a4 = layoutScanPage(2000, 1000, 'a4');
  assert.deepEqual([Math.round(a4.pageWidth), Math.round(a4.pageHeight)], [842, 595], 'landscape image gets a landscape page');
  assert.ok(Math.abs(a4.x - (a4.pageWidth - a4.width) / 2) < 1e-9 && a4.y >= 0);
  const letter = layoutScanPage(850, 1100, 'letter');
  assert.deepEqual([letter.pageWidth, letter.pageHeight], [612, 792]);
  assert.throws(() => layoutScanPage(1, 1, 'tabloid'), RangeError);
});

test('buildScanDocument embeds JPEG and 1-bit pages in order with the right sizes', async () => {
  const jpeg = await readFile(path.join(imageDir, 'photo-16x12.jpg'));
  const width = 200;
  const height = 280;
  const gray = new Uint8Array(width * height).fill(255);
  for (let y = 100; y < 110; y += 1) gray.fill(0, y * width + 20, y * width + 180);
  const bits = packBits(gray, width, height, 128);
  const progress = [];
  const { bytes, pageCount } = await buildScanDocument([
    { kind: 'jpeg', bytes: jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength), width: 16, height: 12 },
    { kind: 'bitonal', bytes: bits.buffer, width, height },
  ], { pageSize: 'auto', title: 'Receipt', onProgress: (info) => progress.push(info.phase) });
  assert.equal(pageCount, 2);
  const { pages, info } = await readWithPdfjs(bytes);
  assert.equal(pages.length, 2);
  // Each page has its image's shape, as large as fits on A4 in its orientation.
  assert.deepEqual([pages[0].width, pages[0].height], [794, 595], '4:3 landscape photo');
  assert.deepEqual([pages[1].width, pages[1].height], [595, 833], '5:7 portrait page');
  assert.equal(info.Title, 'Receipt');
  assert.equal(info.Creator, 'Foldr Scan');
  assert.ok(progress.includes('verify'));
  // The 1-bit page is tiny compared with its raw pixel count.
  assert.ok(bytes.length < 16 * 1024, `${bytes.length} bytes`);
});

test('buildScanDocument refuses an empty scan and a broken image', async () => {
  await assert.rejects(buildScanDocument([]), { code: 'no-pages' });
  await assert.rejects(buildScanDocument([{ kind: 'jpeg', bytes: new Uint8Array([1, 2, 3]).buffer, width: 1, height: 1 }]), { code: 'invalid-image' });
});

test('buildScanDocument lays a text layer over the page, scaled to the image', async () => {
  // Stands in for Tesseract's text-only page, which is sized from the
  // image's resolution, not the PDF page's.
  const layerDoc = await PDFDocument.create();
  const layerPage = layerDoc.addPage([1200, 1600]);
  const font = await layerDoc.embedFont(StandardFonts.Helvetica);
  layerPage.drawText('Invoice 2041', { x: 100, y: 1400, size: 60, font });
  const layer = await layerDoc.save();
  const width = 300;
  const height = 400;
  const bits = packBits(new Uint8Array(width * height).fill(255), width, height, 128);
  const { bytes } = await buildScanDocument([
    { kind: 'bitonal', bytes: bits.buffer, width, height, textLayer: layer.buffer.slice(layer.byteOffset, layer.byteOffset + layer.byteLength) },
    { kind: 'bitonal', bytes: bits.buffer.slice(0), width, height },
  ], { pageSize: 'a4' });
  const { pages } = await readWithPdfjs(bytes);
  assert.deepEqual([pages[0].width, pages[0].height], [595, 842], 'the layer does not change the page size');
  assert.equal(pages[0].text, 'Invoice 2041');
  assert.equal(pages[1].text, '');
});

test('buildScanDocument refuses a broken text layer', async () => {
  const bits = packBits(new Uint8Array(64).fill(255), 8, 8, 128);
  await assert.rejects(
    buildScanDocument([{ kind: 'bitonal', bytes: bits.buffer, width: 8, height: 8, textLayer: new Uint8Array([1, 2, 3]).buffer }]),
    { code: 'invalid-text-layer' },
  );
});
