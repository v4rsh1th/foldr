import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compressedImageName, extensionForType, fitWithin, imageTypeOf, isCompressibleImage, outputTypeFor,
} from '../../public/js/core/image-compress.js';
import { stripExtension } from '../../public/js/core/filenames.js';
import { isHeif } from '../../public/js/workers/heif-decoder.js';
import { readFile } from 'node:fs/promises';

test('imageTypeOf trusts the MIME type, then the extension', () => {
  assert.equal(imageTypeOf({ name: 'a.bin', type: 'image/PNG' }), 'image/png');
  assert.equal(imageTypeOf({ name: 'IMG_0001.JPEG', type: '' }), 'image/jpeg');
  assert.equal(imageTypeOf({ name: 'photo.heic', type: '' }), 'image/heic');
  assert.equal(imageTypeOf({ name: 'notes.txt', type: 'text/plain' }), '');
});

test('isCompressibleImage refuses GIFs, SVGs and non-images', () => {
  assert.equal(isCompressibleImage({ name: 'a.jpg', type: 'image/jpeg' }), true);
  assert.equal(isCompressibleImage({ name: 'a.webp', type: '' }), true);
  assert.equal(isCompressibleImage({ name: 'a.gif', type: 'image/gif' }), false);
  assert.equal(isCompressibleImage({ name: 'logo.svg', type: '' }), false);
  assert.equal(isCompressibleImage({ name: 'doc.pdf', type: 'application/pdf' }), false);
});

test('outputTypeFor keeps writable formats and converts the rest', () => {
  const keep = (inputType, extra = {}) => outputTypeFor({ inputType, format: 'keep', ...extra });
  assert.equal(keep('image/jpeg'), 'image/jpeg');
  assert.equal(keep('image/png', { hasAlpha: true }), 'image/png');
  assert.equal(keep('image/webp'), 'image/webp');
  assert.equal(keep('image/webp', { webp: false }), 'image/jpeg');
  assert.equal(keep('image/webp', { webp: false, hasAlpha: true }), 'image/png');
  assert.equal(keep('image/heic'), 'image/jpeg');
  assert.equal(keep('image/avif', { hasAlpha: true }), 'image/png');
  assert.equal(outputTypeFor({ inputType: 'image/png', format: 'jpeg', hasAlpha: true }), 'image/jpeg');
  assert.equal(outputTypeFor({ inputType: 'image/jpeg', format: 'webp' }), 'image/webp');
  assert.equal(outputTypeFor({ inputType: 'image/jpeg', format: 'webp', webp: false }), 'image/jpeg');
  assert.throws(() => outputTypeFor({ inputType: 'image/jpeg', format: 'gif' }), RangeError);
});

test('fitWithin only ever scales down, keeping the aspect ratio', () => {
  assert.deepEqual(fitWithin(4032, 3024, 1920), { width: 1920, height: 1440, scaled: true });
  assert.deepEqual(fitWithin(3024, 4032, 1920), { width: 1440, height: 1920, scaled: true });
  assert.deepEqual(fitWithin(800, 600, 1920), { width: 800, height: 600, scaled: false });
  assert.deepEqual(fitWithin(4032, 3024, 0), { width: 4032, height: 3024, scaled: false });
  assert.deepEqual(fitWithin(10000, 1, 800), { width: 800, height: 1, scaled: true });
});

test('compressed image names get the new extension', () => {
  assert.equal(compressedImageName('Holiday 01.jpeg', 'image/jpeg'), 'Holiday 01-compressed.jpg');
  assert.equal(compressedImageName('scan.PNG', 'image/webp'), 'scan-compressed.webp');
  assert.equal(compressedImageName('', 'image/png'), 'image-compressed.png');
  assert.equal(extensionForType('image/heic'), '');
});

test('stripExtension removes only the given extension, in any case', () => {
  assert.equal(stripExtension('photo.JPG', '.jpg'), 'photo');
  assert.equal(stripExtension('photo.jpg.webp', '.webp'), 'photo.jpg');
  assert.equal(stripExtension('photo.png', '.jpg'), 'photo.png');
});

test('isHeif recognises HEIC files by their contents, not their name', async () => {
  const heic = await readFile(new URL('../fixtures/images/desk-600x680.heic', import.meta.url));
  const jpeg = await readFile(new URL('../fixtures/images/photo-16x12.jpg', import.meta.url));
  assert.equal(await isHeif(new Blob([heic])), true);
  assert.equal(await isHeif(new Blob([jpeg])), false);
  assert.equal(await isHeif(new Blob([])), false);
  const avif = new Uint8Array([0, 0, 0, 28, ...new TextEncoder().encode('ftypavif')]);
  assert.equal(await isHeif(new Blob([avif])), false);
});
