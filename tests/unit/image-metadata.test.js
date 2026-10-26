import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import {
  canStripMetadata, orientationOnlyExif, readExif, stripMetadata,
} from '../../public/js/core/image-metadata.js';

const text = (value) => Buffer.from(value, 'latin1');
const fixtureJpeg = () => readFile(new URL('../fixtures/images/photo-16x12.jpg', import.meta.url));

/** A little-endian TIFF IFD0 with the given SHORT/LONG entries, as cameras write it. */
function exifTiff(entries) {
  const tiff = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(entries.length, 8);
  entries.forEach(({ tag, value }, index) => {
    const offset = 10 + index * 12;
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(tag === 0x0112 ? 3 : 4, offset + 2);
    tiff.writeUInt32LE(1, offset + 4);
    if (tag === 0x0112) tiff.writeUInt16LE(value, offset + 8);
    else tiff.writeUInt32LE(value, offset + 8);
  });
  return tiff;
}

const cameraExif = (orientation) => exifTiff([
  { tag: 0x010f, value: 0 }, // Make
  { tag: 0x0112, value: orientation },
  { tag: 0x8825, value: 0 }, // GPS IFD pointer
]);

function jpegSegment(marker, payload) {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/** Inserts segments right after the fixture's SOI marker. */
async function jpegWith(...segments) {
  const base = await fixtureJpeg();
  return new Uint8Array(Buffer.concat([base.subarray(0, 2), ...segments, base.subarray(2)]));
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([text(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function pngWith(...chunks) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...chunks,
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0, 0, 0, 4, 0, 1])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

function pngChunkTypes(bytes) {
  const buffer = Buffer.from(bytes);
  const types = [];
  for (let pos = 8; pos < buffer.length; pos += 12 + buffer.readUInt32BE(pos)) types.push(buffer.toString('latin1', pos + 4, pos + 8));
  return types;
}

function riffChunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 'latin1');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function webpWith(flags, ...chunks) {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = flags;
  const body = Buffer.concat([text('WEBP'), riffChunk('VP8X', vp8x), riffChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return new Uint8Array(Buffer.concat([header, body]));
}

test('canStripMetadata accepts JPEG, PNG and WebP only', () => {
  assert.equal(canStripMetadata({ name: 'IMG_0001.JPG', type: '' }), true);
  assert.equal(canStripMetadata({ name: 'a', type: 'image/png' }), true);
  assert.equal(canStripMetadata({ name: 'a.webp', type: '' }), true);
  assert.equal(canStripMetadata({ name: 'a.heic', type: '' }), false);
  assert.equal(canStripMetadata({ name: 'a.gif', type: 'image/gif' }), false);
});

test('readExif finds the orientation and GPS block in either byte order', () => {
  assert.deepEqual(readExif(new Uint8Array(cameraExif(6))), { orientation: 6, gps: true });
  assert.deepEqual(readExif(orientationOnlyExif(8)), { orientation: 8, gps: false });
  assert.deepEqual(readExif(new Uint8Array([1, 2, 3])), { orientation: 1, gps: false });
});

test('JPEG: removes EXIF, GPS, XMP, IPTC and comments, keeping the colour profile and pixels', async () => {
  const icc = jpegSegment(0xe2, text('ICC_PROFILE\0\x01\x01fake profile'));
  const input = await jpegWith(
    jpegSegment(0xe1, Buffer.concat([text('Exif\0\0'), cameraExif(1)])),
    jpegSegment(0xe1, text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')),
    icc,
    jpegSegment(0xfe, text('Shot on my phone')),
  );
  const result = await stripMetadata(input);
  assert.equal(result.type, 'image/jpeg');
  assert.deepEqual(result.removed, ['location', 'exif', 'xmp', 'iptc', 'text']);
  const output = Buffer.from(result.bytes);
  for (const marker of ['Exif', 'xap/1.0', 'Photoshop', 'Shot on my phone']) assert.equal(output.includes(text(marker)), false, marker);
  assert.equal(output.includes(icc), true);
  // Everything from the first quantisation table on is untouched.
  const fixture = await fixtureJpeg();
  const tables = fixture.indexOf(Buffer.from([0xff, 0xdb]));
  assert.equal(output.includes(fixture.subarray(tables)), true);
  assert.deepEqual([...output.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...output.subarray(-2)], [0xff, 0xd9]);
});

test('JPEG: keeps the orientation on its own, and a second pass finds nothing', async () => {
  const input = await jpegWith(jpegSegment(0xe1, Buffer.concat([text('Exif\0\0'), cameraExif(6)])));
  const first = await stripMetadata(input);
  assert.deepEqual(first.removed, ['location', 'exif', 'iptc']);
  const exif = Buffer.from(first.bytes).indexOf(text('Exif\0\0'));
  assert.ok(exif > 0);
  assert.deepEqual(readExif(first.bytes.subarray(exif + 6)), { orientation: 6, gps: false });

  const second = await stripMetadata(first.bytes);
  assert.deepEqual(second.removed, []);
  assert.equal(second.bytes, first.bytes);
});

test('JPEG: drops data after the end of the image', async () => {
  const input = Buffer.concat([await fixtureJpeg(), text('motion photo video')]);
  const result = await stripMetadata(new Uint8Array(input));
  assert.ok(result.removed.includes('other'));
  assert.deepEqual([...result.bytes.subarray(-2)], [0xff, 0xd9]);
});

test('JPEG: refuses a file whose segments run past its end', async () => {
  const input = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 0x45]);
  await assert.rejects(stripMetadata(input), { code: 'damaged' });
});

test('PNG: removes text, XMP, EXIF and unknown chunks, keeping rendering chunks', async () => {
  const input = pngWith(
    pngChunk('sRGB', Buffer.from([0])),
    pngChunk('eXIf', cameraExif(1)),
    pngChunk('tEXt', text('Author\0Someone')),
    pngChunk('iTXt', text('XML:com.adobe.xmp\0\0\0\0\0<x/>')),
    pngChunk('tIME', Buffer.alloc(7)),
  );
  const result = await stripMetadata(input);
  assert.equal(result.type, 'image/png');
  assert.deepEqual(result.removed, ['location', 'exif', 'xmp', 'text', 'other']);
  assert.deepEqual(pngChunkTypes(result.bytes), ['IHDR', 'sRGB', 'IDAT', 'IEND']);
});

test('PNG: keeps a rotated image upright with a valid eXIf chunk', async () => {
  const result = await stripMetadata(pngWith(pngChunk('eXIf', cameraExif(3))));
  assert.deepEqual(pngChunkTypes(result.bytes), ['IHDR', 'eXIf', 'IDAT', 'IEND']);
  const buffer = Buffer.from(result.bytes);
  const at = buffer.indexOf(text('eXIf')) - 4;
  const length = buffer.readUInt32BE(at);
  assert.equal(buffer.readUInt32BE(at + 8 + length), crc32(buffer.subarray(at + 4, at + 8 + length)));
  assert.deepEqual(readExif(buffer.subarray(at + 8, at + 8 + length)), { orientation: 3, gps: false });
});

test('PNG without metadata is returned unchanged', async () => {
  const input = pngWith();
  const result = await stripMetadata(input);
  assert.deepEqual(result.removed, []);
  assert.equal(result.bytes, input);
});

test('WebP: removes EXIF and XMP chunks and clears their flags', async () => {
  const input = webpWith(0x10 | 0x08 | 0x04, riffChunk('EXIF', cameraExif(1)), riffChunk('XMP ', text('<x/>')));
  const result = await stripMetadata(input);
  assert.equal(result.type, 'image/webp');
  assert.deepEqual(result.removed, ['location', 'exif', 'xmp']);
  const output = Buffer.from(result.bytes);
  assert.equal(output.readUInt32LE(4), output.length - 8);
  assert.equal(output[20], 0x10);
  assert.equal(output.includes(text('EXIF')), false);
  assert.equal(output.includes(text('XMP ')), false);
});

test('WebP: keeps the orientation and its flag', async () => {
  const result = await stripMetadata(webpWith(0x08, riffChunk('EXIF', Buffer.concat([text('Exif\0\0'), cameraExif(6)]))));
  const output = Buffer.from(result.bytes);
  assert.equal(output[20], 0x08);
  const at = output.indexOf(text('EXIF'));
  assert.deepEqual(readExif(output.subarray(at + 8, at + 8 + output.readUInt32LE(at + 4))), { orientation: 6, gps: false });
  assert.equal(output.readUInt32LE(4), output.length - 8);
});

test('other formats are refused', async () => {
  await assert.rejects(stripMetadata(new Uint8Array(text('GIF89a.....'))), { code: 'unsupported' });
});
