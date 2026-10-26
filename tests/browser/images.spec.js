import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import path from 'node:path';
import { test, expect, download, fixtureDir, png } from './fixtures.js';

test.afterEach(async ({ problems }) => {
  expect(problems).toEqual([]);
});

/** A photo-like PNG: smooth gradients plus sensor-style noise, which PNG stores poorly and JPEG/WebP well. */
function noisyPhoto(width = 1600, height = 1200) {
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 24) - 12;
  };
  return png(width, height, (x, y) => [
    120 + 80 * Math.sin(x / 90) + noise(),
    110 + 70 * Math.cos(y / 70) + noise(),
    90 + 60 * Math.sin((x + y) / 120) + noise(),
  ].map((value) => Math.max(0, Math.min(255, Math.round(value)))));
}

const imagePath = (name) => path.join(fixtureDir, '..', 'images', name);
const tinyJpeg = () => readFile(imagePath('photo-16x12.jpg'));

async function chooseImages(page, files) {
  await page.locator('input[type=file]').first().setInputFiles(files);
}

test.describe('compress images', () => {
  test('resizes a PNG and converts it to WebP', async ({ page }) => {
    await page.goto('/#/compress-images');
    await expect(page.getByRole('heading', { level: 1, name: 'Compress Images' })).toBeVisible();
    const original = noisyPhoto();
    await chooseImages(page, [{ name: 'Holiday.png', mimeType: 'image/png', buffer: original }]);
    await expect(page.getByText('Holiday.png')).toBeVisible();
    // PNGs ignore the level, which the page points out until another option applies.
    await expect(page.getByText(/PNG is a lossless format/)).toBeVisible();
    await page.getByLabel('Dimensions').selectOption('1280');
    await page.getByLabel('Format').selectOption('webp');
    await expect(page.getByText(/PNG is a lossless format/)).toBeHidden();

    await page.getByRole('button', { name: 'Compress image' }).click();
    await expect(page.getByRole('heading', { name: /^Reduced by \d+%$/ })).toBeVisible();
    await expect(page.getByText('1600 × 1200 → 1280 × 960', { exact: false })).toBeVisible();
    const result = await download(page, page.getByRole('button', { name: 'Download' }));
    expect(result.name).toBe('Holiday-compressed.webp');
    expect(Buffer.from(result.bytes.subarray(0, 4)).toString()).toBe('RIFF');
    expect(Buffer.from(result.bytes.subarray(8, 12)).toString()).toBe('WEBP');
    expect(result.bytes.length).toBeLessThan(original.length / 4);
  });

  test('keeps images that would not get smaller, and zips several results', async ({ page }) => {
    await page.goto('/#/compress-images');
    await chooseImages(page, [
      { name: 'big.png', mimeType: 'image/png', buffer: noisyPhoto(800, 600) },
      { name: 'tiny.jpg', mimeType: 'image/jpeg', buffer: await tinyJpeg() },
    ]);
    await page.getByLabel('Format').selectOption('jpeg');
    await expect(page.getByText(/transparent areas will become white/)).toBeVisible();
    await page.getByRole('button', { name: 'Compress images' }).click();
    await expect(page.getByText(/1 image wouldn’t get any smaller/)).toBeVisible();
    await expect(page.getByText(/Already compact, kept as it was/)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'File name for output 1' })).toHaveValue('big-compressed');
    await expect(page.getByRole('textbox', { name: 'File name for output 2' })).toHaveValue('tiny');

    const zip = await download(page, page.getByRole('button', { name: /Download all as ZIP/ }));
    expect(zip.name).toBe('compressed-images.zip');
    const text = Buffer.from(zip.bytes).toString('latin1');
    expect(text).toContain('big-compressed.jpg');
    expect(text).toContain('tiny.jpg');
    // The kept JPEG is stored byte for byte.
    expect(Buffer.from(zip.bytes).includes(await tinyJpeg())).toBe(true);
  });

  test('opens HEIC photos in browsers without native support', async ({ page }) => {
    await page.goto('/#/compress-images');
    await chooseImages(page, [imagePath('desk-600x680.heic')]);
    // HEIC is efficient, so same-format compression hands the original back…
    await page.getByRole('button', { name: 'Compress image' }).click();
    await expect(page.getByText(/600 × 680 · .* · Already compact, kept as it was/)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'File name' })).toHaveValue('desk-600x680');

    // …but a format the user asks for is always delivered, even if larger.
    await page.getByRole('button', { name: 'Try other settings' }).click();
    await page.getByLabel('Format').selectOption('jpeg');
    await page.getByRole('button', { name: 'Compress image' }).click();
    await expect(page.getByRole('heading', { name: /^(Converted to JPEG|Reduced by \d+%)$/ })).toBeVisible();
    const result = await download(page, page.getByRole('button', { name: 'Download' }));
    expect(result.name).toBe('desk-600x680-compressed.jpg');
    expect([...result.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  test('refuses files that are not images', async ({ page }) => {
    await page.goto('/#/compress-images');
    await chooseImages(page, [{ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }]);
    await expect(page.getByText(/To make a PDF smaller, use Compress PDF/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Selected images' })).toHaveCount(0);
  });
});

/** `png` with a tEXt chunk after IHDR, as image editors write one. */
function pngWithText(keyword, value) {
  const plain = png(40, 30, (x, y) => [x * 6, y * 8, 120]);
  const data = Buffer.from(`${keyword}\0${value}`, 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from('tEXt'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([plain.subarray(0, 33), length, body, crc, plain.subarray(33)]);
}

test.describe('remove metadata', () => {
  test('strips EXIF and IPTC from a JPEG, leaving the image decodable', async ({ page }) => {
    await page.goto('/#/remove-metadata');
    await expect(page.getByRole('heading', { level: 1, name: 'Remove Metadata' })).toBeVisible();
    const original = await tinyJpeg();
    await chooseImages(page, [{ name: 'IMG_0042.jpg', mimeType: 'image/jpeg', buffer: original }]);
    await page.getByRole('button', { name: 'Remove metadata' }).click();
    await expect(page.getByRole('heading', { name: 'Metadata removed from 1 image' })).toBeVisible();
    await expect(page.getByText(/Removed: EXIF, IPTC/)).toBeVisible();

    const result = await download(page, page.getByRole('button', { name: 'Download' }));
    expect(result.name).toBe('IMG_0042.jpg');
    const bytes = Buffer.from(result.bytes);
    expect(bytes.includes(Buffer.from('Exif'))).toBe(false);
    expect(bytes.includes(Buffer.from('Photoshop'))).toBe(false);
    expect(bytes.length).toBeLessThan(original.length);
    const size = await page.evaluate(async (data) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/jpeg' }));
      return [bitmap.width, bitmap.height];
    }, [...bytes]);
    expect(size).toEqual([16, 12]);
  });

  test('cleans PNGs, keeps ones without metadata, and refuses HEIC', async ({ page }) => {
    await page.goto('/#/remove-metadata');
    await chooseImages(page, [imagePath('desk-600x680.heic')]);
    await expect(page.getByText(/For HEIC photos, use Compress Images/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Selected images' })).toHaveCount(0);

    const clean = png(20, 20, () => [10, 200, 30]);
    await chooseImages(page, [
      { name: 'diagram.png', mimeType: 'image/png', buffer: pngWithText('Author', 'Jane Example') },
      { name: 'clean.png', mimeType: 'image/png', buffer: clean },
    ]);
    await page.getByRole('button', { name: 'Remove metadata' }).click();
    await expect(page.getByRole('heading', { name: 'Metadata removed from 1 image' })).toBeVisible();
    await expect(page.getByText(/Removed: Text and comments/)).toBeVisible();
    await expect(page.getByText(/No metadata found, kept as it was/)).toBeVisible();

    const zip = await download(page, page.getByRole('button', { name: /Download all as ZIP/ }));
    expect(zip.name).toBe('images-without-metadata.zip');
    const archive = Buffer.from(zip.bytes);
    expect(archive.includes(Buffer.from('Jane Example'))).toBe(false);
    expect(archive.includes(clean)).toBe(true);
  });
});
