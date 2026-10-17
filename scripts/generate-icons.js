// Renders the PNG app icons from the SVG mark using headless Chromium.
// Run with `node scripts/generate-icons.js` (dev dependency: @playwright/test).
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const icons = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public', 'icons');
const svg = await readFile(path.join(icons, 'favicon.svg'), 'utf8');
const square = svg.replace('rx="8"', 'rx="0"');
const targets = [
  { file: 'icon-192.png', size: 192, markup: svg, inset: 0 },
  { file: 'icon-512.png', size: 512, markup: svg, inset: 0 },
  { file: 'apple-touch-icon.png', size: 180, markup: square, inset: 0 },
  // Maskable icons keep the mark inside the central 80% safe zone.
  { file: 'icon-maskable-512.png', size: 512, markup: square, inset: 0.1, background: '#4f46e5' },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { file, size, markup, inset, background } of targets) {
  await page.setViewportSize({ width: size, height: size });
  const pad = Math.round(size * inset);
  await page.setContent(`<html><body style="margin:0;background:${background ?? 'transparent'}">
    <div style="width:${size}px;height:${size}px;display:grid;place-items:center">
      <div style="width:${size - 2 * pad}px;height:${size - 2 * pad}px">${markup.replace('<svg', '<svg width="100%" height="100%"')}</div>
    </div></body></html>`);
  await page.screenshot({ path: path.join(icons, file), omitBackground: !background });
}
await browser.close();
console.log('Icons written to public/icons/');
