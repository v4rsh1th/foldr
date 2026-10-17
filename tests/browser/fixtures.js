import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
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
