import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect, addFiles, download, inspectPdf, fixturePath } from './fixtures.js';

test.afterEach(async ({ problems }) => {
  expect(problems).toEqual([]);
});

test.describe('navigation', () => {
  test('home lists every tool and switches tools without reloading', async ({ page }) => {
    await page.goto('/');
    for (const name of ['Merge PDFs', 'Split PDF', 'Organize PDF', 'Rotate Pages', 'Compress PDF']) {
      await expect(page.getByRole('link', { name: new RegExp(name) }).first()).toBeVisible();
    }
    await page.evaluate(() => { window.__noReload = true; });
    await page.getByRole('link', { name: /Split PDF/ }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Split PDF' })).toBeVisible();
    await page.getByRole('link', { name: 'All tools' }).click();
    await page.getByRole('link', { name: /Compress PDF/ }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Compress PDF' })).toBeVisible();
    await page.goBack();
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Split PDF' })).toBeVisible();
    expect(await page.evaluate(() => window.__noReload)).toBe(true);
  });

  test('files chosen on the home screen are handed to the chosen tool', async ({ page }) => {
    await page.goto('/');
    await addFiles(page, 'letter-3.pdf');
    await expect(page.getByRole('heading', { name: /What would you like to do/ })).toBeVisible();
    // Conditional content must never leak through as literal text.
    await expect(page.locator('section.panel')).not.toContainText(/\b(false|null|undefined)\b/);
    // The chooser replaces the main grid, so each tool appears exactly once.
    await expect(page.getByRole('link', { name: /Split PDF/ })).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByRole('heading', { name: /What would you like to do/ })).toBeHidden();
    await expect(page.getByRole('link', { name: /Split PDF/ })).toHaveCount(1);
    await addFiles(page, 'letter-3.pdf');
    await page.locator('section.panel').getByRole('link', { name: /Split PDF/ }).click();
    await expect(page.getByText('letter-3.pdf')).toBeVisible();
    await expect(page.locator('.file-item__meta').getByText('3 pages', { exact: true })).toBeVisible();
  });

  test('warns before discarding unsaved work, and can stay', async ({ page }) => {
    await page.goto('/#/organize');
    await addFiles(page, 'letter-3.pdf');
    await page.getByRole('option', { name: /Page 1 of 3/ }).click();
    await page.getByRole('button', { name: 'Rotate selected pages clockwise' }).click();
    await page.getByRole('link', { name: 'All tools' }).click();
    const dialog = page.getByRole('dialog', { name: 'Leave this tool?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Stay' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Organize PDF' })).toBeVisible();
    await expect(page.getByText('1 rotated')).toBeVisible();
    await page.getByRole('link', { name: 'All tools' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Leave' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /Private PDF tools/ })).toBeVisible();
  });
});

test.describe('validation', () => {
  test('rejects invalid, empty and encrypted files with useful messages', async ({ page }) => {
    await page.goto('/#/merge');
    await addFiles(page, ['not-a-pdf.pdf', 'empty.pdf', 'encrypted.pdf', 'corrupt.pdf', 'letter-3.pdf']);
    await expect(page.getByText(/This isn’t a PDF file/)).toBeVisible();
    await expect(page.getByText(/This file is empty/)).toBeVisible();
    await expect(page.getByText(/encrypted or password-protected/)).toBeVisible();
    await expect(page.getByText(/couldn’t open this PDF/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Merge PDFs' })).toBeDisabled();
    await expect(page.getByText('Remove the files that can’t be used')).toBeVisible();
  });
});

test.describe('merge', () => {
  test('merges files in the chosen order and downloads a valid PDF', async ({ page }) => {
    await page.goto('/#/merge');
    await addFiles(page, ['letter-3.pdf', 'a4-landscape-2.pdf', 'mixed-sizes-4.pdf']);
    await expect(page.getByText('3 files · 9 pages')).toBeVisible();
    // Move the landscape file to the top.
    await page.getByRole('button', { name: 'Move up' }).nth(1).click();
    await page.getByRole('button', { name: 'Merge PDFs' }).click();
    await expect(page.getByRole('heading', { name: 'Your PDF is ready' })).toBeVisible();
    await expect(page.getByLabel('File name')).toHaveValue('merged-document');
    await page.getByLabel('File name').fill('combined report');
    const { name, bytes } = await download(page, page.getByRole('button', { name: 'Download' }));
    expect(name).toBe('combined report.pdf');
    const pdf = await inspectPdf(bytes);
    expect(pdf.labels).toEqual(['Bravo 1', 'Bravo 2', 'Alpha 1', 'Alpha 2', 'Alpha 3', 'Mixed 1', 'Mixed 2', 'Mixed 3', 'Mixed 4']);
    // Preview thumbnails of the result are rendered.
    await expect(page.locator('.page-grid canvas').first()).toBeVisible();
    // Start over clears everything without a reload.
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(page.getByRole('list', { name: 'Selected files' })).toHaveCount(0);
  });
});

test.describe('split', () => {
  test('extracts selected pages in the typed order', async ({ page }) => {
    await page.goto('/#/split');
    await addFiles(page, 'mixed-sizes-4.pdf');
    const input = page.getByLabel('Pages to extract');
    await input.fill('4, 1-2');
    await expect(page.getByText('Creates 1 file with 3 pages.')).toBeVisible();
    await page.getByRole('button', { name: 'Split PDF' }).click();
    const { name, bytes } = await download(page, page.getByRole('button', { name: 'Download' }));
    expect(name).toBe('mixed-sizes-4-pages-4_1-2.pdf');
    expect((await inspectPdf(bytes)).labels).toEqual(['Mixed 4', 'Mixed 1', 'Mixed 2']);
  });

  test('explains invalid ranges and keeps the button disabled', async ({ page }) => {
    await page.goto('/#/split');
    await addFiles(page, 'letter-3.pdf');
    const input = page.getByLabel('Pages to extract');
    const button = page.getByRole('button', { name: 'Split PDF' });
    for (const [value, message] of [['0', /start at 1/], ['5', /Page 5 doesn’t exist/], ['1-', /isn’t a page number/], ['1, 1', /more than once/], ['-2', /negative/]]) {
      await input.fill(value);
      await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
      await expect(button).toBeDisabled();
      await expect(input).toHaveAttribute('aria-invalid', 'true');
    }
  });

  test('splits by ranges into separate files and a valid ZIP', async ({ page }) => {
    await page.goto('/#/split');
    await addFiles(page, 'mixed-sizes-4.pdf');
    await page.getByText('Split by ranges', { exact: true }).click();
    await page.getByLabel('Or split every N pages').fill('2');
    await page.getByRole('button', { name: 'Fill in ranges' }).click();
    await expect(page.getByLabel('Page ranges')).toHaveValue('1-2, 3-4');
    await page.getByRole('button', { name: 'Split PDF' }).click();
    await expect(page.getByRole('heading', { name: '2 PDFs are ready' })).toBeVisible();
    const first = await download(page, page.getByRole('button', { name: 'Download', exact: true }).first());
    expect(first.name).toBe('mixed-sizes-4-pages-1-2.pdf');
    expect((await inspectPdf(first.bytes)).labels).toEqual(['Mixed 1', 'Mixed 2']);
    const zip = await download(page, page.getByRole('button', { name: /Download all as ZIP/ }));
    expect(zip.name).toBe('mixed-sizes-4-split.zip');
    const dir = mkdtempSync(path.join(tmpdir(), 'foldr-zip-'));
    try {
      writeFileSync(path.join(dir, 'a.zip'), zip.bytes);
      const listing = execFileSync('unzip', ['-l', path.join(dir, 'a.zip')], { encoding: 'utf8' });
      expect(listing).toContain('mixed-sizes-4-pages-1-2.pdf');
      expect(listing).toContain('mixed-sizes-4-pages-3-4.pdf');
      execFileSync('unzip', ['-q', path.join(dir, 'a.zip'), '-d', dir]);
      const second = new Uint8Array(await readFile(path.join(dir, 'mixed-sizes-4-pages-3-4.pdf')));
      expect((await inspectPdf(second)).labels).toEqual(['Mixed 3', 'Mixed 4']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every-page mode creates one file per page', async ({ page }) => {
    await page.goto('/#/split');
    await addFiles(page, 'letter-3.pdf');
    await page.getByText('Every page', { exact: true }).click();
    await page.getByRole('button', { name: 'Split PDF' }).click();
    await expect(page.getByRole('heading', { name: '3 PDFs are ready' })).toBeVisible();
    await expect(page.getByLabel('File name for output 3')).toHaveValue('letter-3-page-3');
  });
});

test.describe('organize', () => {
  test('reorders with toolbar, keyboard and drag-and-drop, deletes with undo, and exports exactly what is shown', async ({ page }) => {
    await page.goto('/#/organize');
    await addFiles(page, 'mixed-sizes-4.pdf');
    const option = (n) => page.getByRole('option', { name: new RegExp(`^Page ${n} of`) });
    await expect(page.locator('.page-grid canvas')).toHaveCount(4);

    // Toolbar: move original page 3 to the beginning -> 3 1 2 4
    await option(3).click();
    await page.getByRole('button', { name: 'Move selected pages to the beginning' }).click();
    await page.getByRole('button', { name: 'Clear selection' }).click();

    // Keyboard: focus position 4 (original page 4), Alt+ArrowLeft -> 3 1 4 2
    await option(4).focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(option(3)).toHaveAttribute('aria-label', /originally page 4/);

    // Drag and drop with the mouse: drag position 1 (original 3) after position 2 -> 1 3 4 2
    const first = await option(1).boundingBox();
    const second = await option(2).boundingBox();
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + first.width / 2 + 20, first.y + first.height / 2, { steps: 4 });
    await page.mouse.move(second.x + second.width * 0.85, second.y + second.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(option(2)).toHaveAttribute('aria-label', /originally page 3/);

    // Delete original page 2 (now last), then undo and delete again.
    await option(4).click();
    await page.getByRole('button', { name: 'Delete selected pages' }).click();
    await expect(page.getByRole('option')).toHaveCount(3);
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await expect(page.getByRole('option')).toHaveCount(4);
    await option(4).click();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('option')).toHaveCount(3);

    // Rotate original page 1 clockwise.
    await option(1).click();
    await page.keyboard.press('r');
    await expect(page.getByText('1 deleted · 1 rotated')).toBeVisible();

    await page.getByRole('button', { name: 'Save organized PDF' }).click();
    const { name, bytes } = await download(page, page.getByRole('button', { name: 'Download' }));
    expect(name).toBe('mixed-sizes-4-organized.pdf');
    const pdf = await inspectPdf(bytes);
    expect(pdf.labels).toEqual(['Mixed 1', 'Mixed 3', 'Mixed 4']);
    expect(pdf.pages.map((p) => p.rotation)).toEqual([90, 0, 0]);
  });

  test('cannot delete every page', async ({ page }) => {
    await page.goto('/#/organize');
    await addFiles(page, 'letter-3.pdf');
    await page.getByRole('button', { name: 'Select all pages' }).click();
    await expect(page.getByRole('button', { name: 'Delete selected pages' })).toBeDisabled();
    await page.getByRole('option').first().focus();
    await page.keyboard.press('Delete');
    await expect(page.getByText('A PDF needs at least one page')).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(3);
  });

  test('renders only nearby thumbnails for a 200-page document', async ({ page }) => {
    await page.goto('/#/organize');
    await addFiles(page, 'many-200.pdf');
    await expect(page.getByRole('option')).toHaveCount(200);
    await expect(page.locator('.page-grid canvas').first()).toBeVisible();
    await page.waitForTimeout(500);
    const rendered = await page.locator('.page-grid canvas').count();
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(80);
    // Scrolling to the end renders the last pages.
    await page.getByRole('option', { name: /^Page 200 of/ }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('option', { name: /^Page 200 of/ }).locator('canvas')).toBeVisible();
  });
});

test.describe('rotate', () => {
  test('rotation is written into the PDF on top of existing rotation', async ({ page }) => {
    await page.goto('/#/rotate');
    await addFiles(page, 'rotated-4.pdf');
    await expect(page.getByRole('button', { name: 'Save rotated PDF' })).toBeDisabled();
    await page.getByRole('button', { name: 'Rotate all pages clockwise' }).click();
    // Rotate page 2 back using its quick button on the thumbnail.
    await page.getByRole('option', { name: /^Page 2 of/ }).click();
    await page.getByRole('button', { name: 'Rotate selected pages counter-clockwise' }).click();
    await page.getByRole('button', { name: 'Save rotated PDF' }).click();
    const { bytes } = await download(page, page.getByRole('button', { name: 'Download' }));
    const pdf = await inspectPdf(bytes);
    // Original rotations: 0, 90, 270 (inherited), 270 (inherited).
    expect(pdf.pages.map((p) => p.rotation)).toEqual([90, 90, 0, 0]);
    expect(pdf.labels).toEqual(['Rot 1', 'Rot 2', 'Rot 3', 'Rot 4']);
  });

  test('reset clears rotation changes', async ({ page }) => {
    await page.goto('/#/rotate');
    await addFiles(page, 'letter-3.pdf');
    await page.getByRole('button', { name: 'Rotate all pages counter-clockwise' }).click();
    await expect(page.getByText('3 rotated')).toBeVisible();
    await page.getByRole('button', { name: 'Reset rotation' }).click();
    await expect(page.getByText('No pages rotated yet.')).toBeVisible();
  });
});

test.describe('compress', () => {
  test('balanced mode really shrinks an image-heavy PDF and reports sizes honestly', async ({ page }) => {
    await page.goto('/#/compress');
    await addFiles(page, 'images.pdf');
    await page.getByText('Balanced', { exact: true }).click();
    await page.getByRole('button', { name: 'Compress PDF' }).click();
    await expect(page.getByRole('heading', { name: /Reduced by/ })).toBeVisible({ timeout: 30_000 });
    const original = (await readFile(fixturePath('images.pdf'))).length;
    const { bytes } = await download(page, page.getByRole('button', { name: 'Download', exact: true }));
    expect(bytes.length).toBeLessThan(original * 0.8);
    const pdf = await inspectPdf(bytes);
    expect(pdf.pages).toHaveLength(3);
    expect(pdf.pages[0].text).toContain('JPEG photo page');
    await page.getByText('What Foldr changed').click();
    await expect(page.getByText(/1 image re-encoded \(1 downsampled\)/)).toBeVisible();
  });

  test('smaller mode warns about quality and also converts lossless images', async ({ page }) => {
    await page.goto('/#/compress');
    await addFiles(page, 'images.pdf');
    await page.getByText('Smaller file', { exact: true }).click();
    await expect(page.getByText('Visible quality loss is likely')).toBeVisible();
    await page.getByRole('button', { name: 'Compress PDF' }).click();
    await expect(page.getByRole('heading', { name: /Reduced by/ })).toBeVisible({ timeout: 30_000 });
    await page.getByText('What Foldr changed').click();
    await expect(page.getByText(/2 images re-encoded/)).toBeVisible();
  });

  test('a file that cannot shrink is never reported as compressed', async ({ page }) => {
    await page.goto('/#/compress');
    await addFiles(page, 'compact.pdf');
    await page.getByRole('button', { name: 'Compress PDF' }).click();
    const heading = page.getByRole('heading', { level: 2 }).filter({ hasText: /Reduced by|couldn’t be made smaller/ });
    await expect(heading).toBeVisible();
    const original = (await readFile(fixturePath('compact.pdf'))).length;
    const label = page.getByRole('button', { name: /Download/ });
    const { bytes } = await download(page, label);
    if (bytes.length >= original) {
      await expect(heading).toHaveText('This file couldn’t be made smaller');
      await expect(label).toHaveText(/Download anyway/);
    } else {
      await expect(heading).toHaveText(/Reduced by/);
    }
  });
});

test.describe('cancellation', () => {
  test('a cancelled merge leaves files selected and can be retried', async ({ page }) => {
    await page.goto('/#/merge');
    // A heavy job (~75 MB) so there is time to cancel it.
    await addFiles(page, [...Array(12).fill('images.pdf'), 'many-200.pdf']);
    await expect(page.getByText(/13 files/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Merge PDFs' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Nothing was changed. Your files are still selected.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Merge PDFs' })).toBeEnabled();
    // The worker was restarted; merging again re-registers the files and works.
    await page.getByRole('button', { name: 'Merge PDFs' }).click();
    await expect(page.getByRole('heading', { name: 'Your PDF is ready' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/merged into 236 pages/)).toBeVisible();
  });
});
