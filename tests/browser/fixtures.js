import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readWithPdfjs, labels } from '../integration/helpers.js';

export const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'pdf');
export const fixturePath = (name) => path.join(fixtureDir, name);

/**
 * Extends the base test with:
 *  - `problems`: console errors, page errors and any request that leaves the
 *    origin or isn't a GET (i.e. anything that could upload a document).
 *    Each test asserts it is empty at the end.
 */
export const test = base.extend({
  problems: async ({ page, baseURL }, use) => {
    const problems = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
    });
    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
    page.on('requestfailed', (request) => {
      if (!request.url().startsWith('blob:')) problems.push(`request failed: ${request.url().replace(baseURL, '')} (${request.failure()?.errorText})`);
    });
    page.context().on('request', (request) => {
      const url = request.url();
      if (url.startsWith('blob:') || url.startsWith('data:')) return;
      if (!url.startsWith(baseURL)) problems.push(`external request: ${url}`);
      if (request.method() !== 'GET' && request.method() !== 'HEAD') problems.push(`non-GET request: ${request.method()} ${url}`);
    });
    await use(problems);
  },
});

export { expect };

export async function addFiles(page, names) {
  await page.locator('input[type=file]').first().setInputFiles((Array.isArray(names) ? names : [names]).map(fixturePath));
}

/** Clicks the download button and returns the downloaded bytes and filename. */
export async function download(page, button) {
  const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const filePath = await file.path();
  return { name: file.suggestedFilename(), bytes: new Uint8Array(await readFile(filePath)) };
}

export async function inspectPdf(bytes) {
  const result = await readWithPdfjs(bytes);
  return { ...result, labels: labels(result) };
}

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return ~crc >>> 0;
}

/** An 8-bit RGB PNG; `pixel(x, y)` returns [r, g, b]. */
export function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const [r, g, b] = pixel(x, y);
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
