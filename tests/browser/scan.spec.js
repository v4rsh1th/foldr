import { test, expect, download, inspectPdf, png, fixturePath } from './fixtures.js';

test.afterEach(async ({ problems }) => {
  expect(problems).toEqual([]);
});

/** A dark desk with a slightly tilted portrait sheet (about 3:4) carrying lines of "text", shaded on one side. */
function documentPhoto() {
  const width = 900;
  const height = 1000;
  const quad = [[180, 120], [740, 150], [720, 880], [160, 860]];
  const inside = (x, y) => quad.every((a, i) => {
    const b = quad[(i + 1) % 4];
    return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) >= 0;
  });
  return png(width, height, (x, y) => {
    const light = 1 - 0.35 * (x / width);
    let value = 60;
    if (inside(x, y)) {
      value = 228;
      if (y > 260 && y < 760 && Math.floor(y / 14) % 3 === 0 && x > 230 && x < 640) value = 45;
    }
    return [value * light, value * light * 0.98, value * light * 0.9];
  });
}

async function importPhotos(page, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import photos' }).click()]);
  await chooser.setFiles(files);
}

test.describe('scan document', () => {
  test('imports a photo, finds the page and creates a PDF in each look', async ({ page }) => {
    await page.goto('/#/scan');
    await expect(page.getByRole('heading', { level: 1, name: 'Scan Document' })).toBeVisible();
    await importPhotos(page, [{ name: 'desk.png', mimeType: 'image/png', buffer: documentPhoto() }]);
    const card = page.getByRole('listitem').filter({ hasText: 'Page 1' });
    await expect(card.getByRole('img', { name: 'Page 1 preview' })).toBeVisible();
    // The page edges were found, so there's nothing to check.
    await expect(card.getByText('Check crop')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '1 page' })).toBeVisible();

    await page.getByRole('button', { name: 'Create PDF' }).click();
    await expect(page.getByRole('heading', { name: 'Your scan is ready' })).toBeVisible();
    const colour = await download(page, page.getByRole('button', { name: 'Download' }));
    expect(colour.name).toMatch(/^scan-\d{4}-\d{2}-\d{2}-\d{4}\.pdf$/);
    const { pages, info } = await inspectPdf(colour.bytes);
    expect(pages).toHaveLength(1);
    // Cropped to the sheet (about 560 × 740 px), not the whole 900 × 1000 photo.
    expect(pages[0].width / pages[0].height).toBeGreaterThan(0.7);
    expect(pages[0].width / pages[0].height).toBeLessThan(0.8);
    expect(info.Creator).toBe('Foldr Scan');

    await page.getByRole('button', { name: 'Back to pages' }).click();
    await page.getByText('Black & white', { exact: true }).click();
    await page.getByRole('button', { name: 'Create PDF' }).click();
    const bw = await download(page, page.getByRole('button', { name: 'Download' }));
    expect((await inspectPdf(bw.bytes)).pages).toHaveLength(1);
    expect(bw.bytes.length).toBeLessThan(colour.bytes.length);
  });

  test('scans a HEIC photo', async ({ page }) => {
    await page.goto('/#/scan');
    await importPhotos(page, [fixturePath('../images/desk-600x680.heic')]);
    const card = page.getByRole('listitem').filter({ hasText: 'Page 1' });
    await expect(card.getByRole('img', { name: 'Page 1 preview' })).toBeVisible();
    await expect(card.getByText('Check crop')).toHaveCount(0);
  });

  test('edits, rotates, reorders and deletes pages', async ({ page }) => {
    await page.goto('/#/scan');
    const photo = { mimeType: 'image/png', buffer: documentPhoto() };
    await importPhotos(page, [{ name: 'a.png', ...photo }, { name: 'b.png', ...photo }]);
    await expect(page.getByRole('img', { name: /Page \d preview/ })).toHaveCount(2);

    // Corner editor: keyboard nudges, then "Whole photo", then cancel keeps the old crop.
    await page.getByRole('button', { name: 'Adjust corners (Page 1)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Adjust corners of page 1' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Shift+ArrowRight');
    await dialog.getByRole('button', { name: 'Whole photo' }).click();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Rotate clockwise (Page 1)' }).click();
    await page.getByRole('button', { name: 'Move later (Page 1)' }).click();
    await expect(page.getByRole('button', { name: 'Move later (Page 2)' })).toBeDisabled();
    await page.getByRole('button', { name: 'Delete page (Page 1)' }).click();
    await expect(page.getByRole('heading', { name: '1 page' })).toBeVisible();

    // The remaining page is the edited one: whole photo, rotated to landscape.
    await page.getByRole('button', { name: 'Create PDF' }).click();
    const { bytes } = await download(page, page.getByRole('button', { name: 'Download' }));
    const { pages } = await inspectPdf(bytes);
    expect(pages[0].width / pages[0].height).toBeCloseTo(1000 / 900, 1);
  });

  test('warns before leaving unsaved pages, and refuses non-images', async ({ page }) => {
    await page.goto('/#/scan');
    await importPhotos(page, [{ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }]);
    await expect(page.getByText(/Only photos .* can be scanned/)).toBeVisible();
    await importPhotos(page, [{ name: 'desk.png', mimeType: 'image/png', buffer: documentPhoto() }]);
    await expect(page.getByRole('img', { name: 'Page 1 preview' })).toBeVisible();
    await page.getByRole('link', { name: 'All tools' }).click();
    await expect(page.getByRole('dialog', { name: 'Leave this tool?' })).toBeVisible();
    await page.getByRole('button', { name: 'Stay' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Scan Document' })).toBeVisible();
  });

  test('captures pages with the camera', async ({ page }) => {
    await page.goto('/#/scan');
    await page.getByRole('button', { name: 'Open camera' }).click();
    const camera = page.getByRole('dialog', { name: 'Camera' });
    await expect(camera).toBeVisible();
    const shutter = camera.getByRole('button', { name: 'Take photo' });
    await expect(shutter).toBeEnabled();
    await shutter.click();
    await expect(camera.getByText('1 page')).toBeVisible();
    await expect(shutter).toBeEnabled();
    await shutter.click();
    await expect(camera.getByText('2 pages')).toBeVisible();
    await camera.getByRole('button', { name: 'Done' }).click();
    await expect(camera).toBeHidden();
    // The camera is released when the dialog closes.
    expect(await page.evaluate(() => document.querySelector('video'))).toBeNull();
    await expect(page.getByRole('img', { name: /Page \d preview/ })).toHaveCount(2);
  });

  test('photos dropped on the home screen are offered to the image tools only', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type=file]').first().setInputFiles([{ name: 'desk.png', mimeType: 'image/png', buffer: documentPhoto() }]);
    const chooser = page.locator('section.panel');
    await expect(chooser.getByRole('link')).toHaveCount(2);
    await expect(chooser.getByRole('link', { name: /Compress Images/ })).toBeVisible();
    await chooser.getByRole('link', { name: /Scan Document/ }).click();
    await expect(page.getByRole('img', { name: 'Page 1 preview' })).toBeVisible();
  });
});
