// Generates the PDF fixtures used by the integration and browser tests.
// Run with `npm run fixtures`. Output files are committed so tests don't
// depend on this script, but it documents exactly how each fixture is built.

import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PDFDocument, PDFName, PDFNumber, PDFHexString, PDFString, StandardFonts, PageSizes, degrees, rgb,
} from 'pdf-lib';
import { chromium } from '@playwright/test';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pdf');
await mkdir(dir, { recursive: true });

async function save(name, doc, options = {}) {
  const bytes = await doc.save(options);
  await writeFile(path.join(dir, name), bytes);
  return bytes;
}

async function labelledDoc(prefix, sizes, { title } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  sizes.forEach((size, index) => {
    const page = doc.addPage(size);
    const { width, height } = page.getSize();
    const label = `${prefix} ${index + 1}`;
    page.drawRectangle({ x: 20, y: 20, width: width - 40, height: height - 40, borderColor: rgb(0.3, 0.3, 0.8), borderWidth: 3 });
    page.drawText(label, { x: 50, y: height - 110, size: 64, font, color: rgb(0.1, 0.1, 0.3) });
    page.drawText('TOP', { x: width / 2 - 30, y: height - 60, size: 28, font, color: rgb(0.8, 0.1, 0.1) });
  });
  if (title) doc.setTitle(title);
  doc.setAuthor('Foldr fixtures');
  return doc;
}

// ---------------------------------------------------------------------------
// Minimal RGB PNG encoder (filter type 0) for lossless image fixtures.

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Deterministic photo-like content: smooth gradients plus pseudo-random noise.
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function photoPixel(seed) {
  const random = seeded(seed);
  return (x, y) => {
    const noise = random() * 40;
    return [
      Math.min(255, (x * 0.2 + noise) & 255),
      Math.min(255, (y * 0.25 + noise) & 255),
      Math.min(255, ((x + y) * 0.1 + 80 + noise) & 255),
    ];
  };
}

async function renderJpeg(width, height, quality) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const dataUrl = await page.evaluate(({ width, height, quality }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#1d4ed8');
      gradient.addColorStop(0.5, '#f59e0b');
      gradient.addColorStop(1, '#10b981');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      let seed = 7;
      const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 4000; i += 1) {
        ctx.fillStyle = `hsla(${random() * 360}, 70%, ${30 + random() * 50}%, 0.5)`;
        ctx.beginPath();
        ctx.arc(random() * width, random() * height, 4 + random() * 40, 0, Math.PI * 2);
        ctx.fill();
      }
      const image = ctx.getImageData(0, 0, width, height);
      for (let i = 0; i < image.data.length; i += 4) {
        const n = (random() - 0.5) * 30;
        image.data[i] += n; image.data[i + 1] += n; image.data[i + 2] += n;
      }
      ctx.putImageData(image, 0, 0);
      return canvas.toDataURL('image/jpeg', quality);
    }, { width, height, quality });
    return Buffer.from(dataUrl.split(',')[1], 'base64');
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------

await save('letter-3.pdf', await labelledDoc('Alpha', [PageSizes.Letter, PageSizes.Letter, PageSizes.Letter], { title: 'Alpha document' }));
await save('a4-landscape-2.pdf', await labelledDoc('Bravo', [[841.89, 595.28], [841.89, 595.28]]));
await save('mixed-sizes-4.pdf', await labelledDoc('Mixed', [PageSizes.Letter, [841.89, 595.28], PageSizes.A5, PageSizes.Legal]));

// Pages with existing rotation, including rotation and MediaBox inherited
// from an intermediate page-tree node (pages 3 and 4).
{
  const doc = await labelledDoc('Rot', [PageSizes.Letter, PageSizes.Letter, PageSizes.A4, PageSizes.A4]);
  const pages = doc.getPages();
  pages[1].setRotation(degrees(90));
  const { context } = doc;
  const root = doc.catalog.Pages();
  const rootRef = doc.catalog.get(PDFName.of('Pages'));
  const inner = context.obj({
    Type: 'Pages', Parent: rootRef, Count: 2,
    Kids: [pages[2].ref, pages[3].ref], Rotate: 270, MediaBox: [0, 0, 595.28, 841.89],
  });
  const innerRef = context.register(inner);
  for (const page of [pages[2], pages[3]]) {
    page.node.set(PDFName.of('Parent'), innerRef);
    page.node.delete(PDFName.of('Rotate'));
    page.node.delete(PDFName.of('MediaBox'));
  }
  root.set(PDFName.of('Kids'), context.obj([pages[0].ref, pages[1].ref, innerRef]));
  await save('rotated-4.pdf', doc);
}

// Image-heavy: a high-resolution JPEG and a large lossless (Flate) image.
const jpeg = await renderJpeg(2400, 1800, 0.95);
const png = encodePng(1400, 1000, photoPixel(42));
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const jpgImage = await doc.embedJpg(jpeg);
  const pngImage = await doc.embedPng(png);
  let page = doc.addPage(PageSizes.Letter);
  page.drawImage(jpgImage, { x: 36, y: 200, width: 540, height: 405 });
  page.drawText('JPEG photo page', { x: 36, y: 700, size: 24, font });
  page = doc.addPage(PageSizes.Letter);
  page.drawImage(pngImage, { x: 36, y: 200, width: 540, height: 386 });
  page.drawText('Lossless image page', { x: 36, y: 700, size: 24, font });
  page = doc.addPage(PageSizes.Letter);
  page.drawText('Text page', { x: 36, y: 700, size: 24, font });
  await save('images.pdf', doc);
}

// The same image embedded twice as separate objects (typical after merging).
{
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i += 1) {
    const image = await doc.embedPng(encodePng(500, 400, photoPixel(9)));
    doc.addPage(PageSizes.Letter).drawImage(image, { x: 50, y: 300, width: 500, height: 400 });
  }
  await save('duplicate-images.pdf', doc);
}

// Text-heavy with uncompressed content streams.
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const sentence = 'Foldr fixture text. The quick brown fox jumps over the lazy dog. ';
  for (let p = 0; p < 20; p += 1) {
    const page = doc.addPage(PageSizes.Letter);
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    let ops = 'BT /F1 10 Tf 12 TL 50 740 Td\n';
    for (let line = 0; line < 55; line += 1) ops += `(${p + 1}.${line + 1} ${sentence}) Tj T*\n`;
    ops += 'ET\n';
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(ops)));
  }
  await save('text-heavy.pdf', doc, { useObjectStreams: false });
}

// Already compact: small, compressed, written with object streams.
await save('compact.pdf', await labelledDoc('Compact', [PageSizes.A5]));

// Many pages for lazy-thumbnail and performance checks.
{
  const sizes = Array.from({ length: 200 }, () => PageSizes.Letter);
  await save('many-200.pdf', await labelledDoc('Page', sizes));
}

// Bookmarks and a form field, to check Organize keeps document structures.
{
  const doc = await labelledDoc('Struct', [PageSizes.Letter, PageSizes.Letter, PageSizes.Letter]);
  const form = doc.getForm();
  const field = form.createTextField('name');
  field.setText('Ada');
  field.addToPage(doc.getPage(0), { x: 50, y: 400, width: 200, height: 30 });
  const { context } = doc;
  const outlinesRef = context.nextRef();
  const itemRef = context.nextRef();
  context.assign(itemRef, context.obj({
    Title: PDFString.of('Chapter 1'), Parent: outlinesRef, Dest: [doc.getPage(0).ref, 'Fit'],
  }));
  context.assign(outlinesRef, context.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 }));
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  await save('structure-3.pdf', doc);
}

// Encrypted: a trailer /Encrypt dictionary (pdf-lib can't encrypt, but this is
// exactly what readers detect). Readers will ask for a password.
{
  const doc = await labelledDoc('Secret', [PageSizes.Letter]);
  const { context } = doc;
  context.trailerInfo.Encrypt = context.register(context.obj({
    Filter: 'Standard', V: 1, R: 2, Length: 40, P: PDFNumber.of(-3904),
    O: PDFHexString.of('a'.repeat(64)), U: PDFHexString.of('b'.repeat(64)),
  }));
  context.trailerInfo.ID = context.obj([PDFHexString.of('c'.repeat(32)), PDFHexString.of('c'.repeat(32))]);
  await save('encrypted.pdf', doc, { useObjectStreams: false });
}

// Invalid inputs.
await writeFile(path.join(dir, 'empty.pdf'), Buffer.alloc(0));
await writeFile(path.join(dir, 'not-a-pdf.pdf'), 'This is a plain text file pretending to be a PDF.\n');
{
  const full = await (await labelledDoc('Cut', [PageSizes.Letter, PageSizes.Letter])).save({ useObjectStreams: false });
  await writeFile(path.join(dir, 'truncated.pdf'), full.subarray(0, Math.floor(full.length * 0.35)));
}
// A garbage body behind a valid header.
await writeFile(path.join(dir, 'corrupt.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 0x41), Buffer.from('\n%%EOF\n')]));

console.log(`Fixtures written to ${dir}`);
