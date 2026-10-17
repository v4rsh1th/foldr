import { cpSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, addFiles, download, inspectPdf } from './fixtures.js';
import { createApp } from '../../server.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

async function waitForOfflineReady(page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return Boolean(registration.active?.state === 'activated' && navigator.serviceWorker.controller);
  }, null, { timeout: 30_000 });
}

test('installs a service worker, then starts and processes PDFs offline', async ({ page, context, problems }) => {
  await page.goto('/');
  await waitForOfflineReady(page);
  await expect(page.getByText('Foldr is ready to work offline.')).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: /Private PDF tools/ })).toBeVisible();
  await expect(page.locator('#network-status')).toHaveText(/Offline · ready/);

  await page.getByRole('link', { name: /Merge PDFs/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Merge PDFs' })).toBeVisible();
  await addFiles(page, ['letter-3.pdf', 'a4-landscape-2.pdf']);
  await page.getByRole('button', { name: 'Merge PDFs' }).click();
  const { bytes } = await download(page, page.getByRole('button', { name: 'Download' }));
  expect((await inspectPdf(bytes)).labels).toHaveLength(5);

  await page.goto('/#/organize');
  await addFiles(page, 'mixed-sizes-4.pdf');
  await expect(page.locator('.page-grid canvas')).toHaveCount(4);

  // Unknown pages fall back to the offline page instead of a browser error.
  await page.goto('/some/other/page');
  await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible();
  await context.setOffline(false);

  // Only the versioned app shell and library files are cached — never documents.
  const cached = await page.evaluate(async () => {
    const result = [];
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) result.push({ cache: key, url: request.url });
    }
    return result;
  });
  expect(new Set(cached.map((entry) => entry.cache.replace(/-[0-9a-f]{16}$/, '')))).toEqual(new Set(['foldr-shell', 'foldr-runtime'].filter((name) => cached.some((e) => e.cache.startsWith(name)))));
  expect(cached.some((entry) => entry.url.endsWith('/js/app.js'))).toBe(true);
  expect(cached.filter((entry) => /\.pdf($|\?)|^blob:/.test(entry.url))).toEqual([]);
  expect(problems.filter((p) => !p.includes('net::ERR_INTERNET_DISCONNECTED'))).toEqual([]);
});

test('a new version installs side by side and replaces the old cache after reload', async ({ browser }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'foldr-pwa-'));
  const root = path.join(dir, 'public');
  cpSync(publicDir, root, { recursive: true });
  const server = createApp({ publicDir: root, production: false }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await waitForOfflineReady(page);
    const before = await page.evaluate(() => caches.keys());

    // Ship a change: the service worker's content hash changes.
    appendFileSync(path.join(root, 'css', 'utilities.css'), '\n/* v2 */\n');
    await page.evaluate(async () => (await navigator.serviceWorker.ready).update());
    const toast = page.getByText('A new version of Foldr is available.');
    await expect(toast).toBeVisible({ timeout: 30_000 });
    // Until the user reloads, the old version keeps serving its own files.
    expect(await page.evaluate(() => caches.keys())).toEqual(expect.arrayContaining(before));

    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload' }).click()]);
    await expect(async () => {
      const after = await page.evaluate(() => caches.keys());
      expect(after.some((key) => before.includes(key))).toBe(false);
      expect(after.some((key) => key.startsWith('foldr-shell-'))).toBe(true);
    }).toPass({ timeout: 15_000 });
    const css = await page.evaluate(async () => (await fetch('css/utilities.css')).text());
    expect(css).toContain('/* v2 */');
  } finally {
    await context.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest is valid and installable metadata is present', async ({ page }) => {
  await page.goto('/');
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel=manifest]');
    return (await fetch(link.href)).json();
  });
  expect(manifest).toMatchObject({ name: 'Foldr', short_name: 'Foldr', display: 'standalone', start_url: './', scope: './' });
  for (const icon of manifest.icons) {
    const status = await page.evaluate(async (src) => (await fetch(src)).status, icon.src);
    expect(status).toBe(200);
  }
});

test.describe('mobile layout @mobile', () => {
  test('no horizontal scrolling and touch-sized controls', async ({ page, problems }) => {
    for (const route of ['/', '/#/merge', '/#/split', '/#/compress']) {
      await page.goto(route);
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, route).toBeLessThanOrEqual(0);
    }
    await page.goto('/#/organize');
    await addFiles(page, 'mixed-sizes-4.pdf');
    await expect(page.locator('.page-grid canvas')).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const small = await page.evaluate(() => [...document.querySelectorAll('.page-toolbar button, .file-item button, .action-bar button')]
      .filter((el) => el.offsetParent)
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => rect.width < 44 || rect.height < 44).length);
    expect(small).toBe(0);
    // Tapping selects a page.
    await page.getByRole('option', { name: /^Page 2 of/ }).tap();
    await expect(page.getByRole('option', { name: /^Page 2 of/ })).toHaveAttribute('aria-selected', 'true');
    expect(problems).toEqual([]);
  });
});

test.describe('accessibility basics', () => {
  test('every control has an accessible name and the grid is keyboard operable', async ({ page, problems }) => {
    await page.goto('/#/organize');
    await addFiles(page, 'letter-3.pdf');
    await expect(page.locator('.page-grid canvas')).toHaveCount(3);
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, a, input, [role=option]')]
      .filter((el) => el.offsetParent && el.getAttribute('aria-hidden') !== 'true')
      .filter((el) => {
        const labelled = el.getAttribute('aria-label') || el.textContent.trim() || el.labels?.length || el.getAttribute('title');
        return !labelled;
      })
      .map((el) => el.outerHTML.slice(0, 80)));
    expect(unnamed).toEqual([]);

    // Only one grid item is in the tab order (roving tabindex).
    expect(await page.locator('[role=option][tabindex="0"]').count()).toBe(1);
    await page.getByRole('option', { name: /^Page 1 of/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('option', { name: /^Page 2 of/ })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('option', { name: /^Page 2 of/ })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.getByRole('option', { name: /^Page 3 of/ })).toHaveAttribute('aria-label', /originally page 2/);
    await expect(page.locator('#sr-announcer')).toHaveText(/Moved|moved/);

    // The confirmation dialog traps nothing: Escape closes it and focus returns.
    await page.getByRole('link', { name: 'All tools' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'All tools' })).toBeFocused();
    expect(problems).toEqual([]);
  });

  test('filenames are shown as text, never as HTML', async ({ page }) => {
    await page.goto('/#/split');
    await page.locator('input[type=file]').first().setInputFiles({
      name: '<img src=x onerror="window.__xss=1">.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 not really'),
    });
    await expect(page.getByText('<img src=x onerror="window.__xss=1">.pdf')).toBeVisible();
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    expect(await page.locator('.file-item img').count()).toBe(0);
  });
});
