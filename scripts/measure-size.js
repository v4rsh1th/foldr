// Reports the size of what a first visit downloads (the service worker's
// precache list), raw and gzip-compressed, grouped by category.
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const publicDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public');
const sw = readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
const pdfjs = /const PDFJS = '([^']+)'/.exec(sw)[1];
const pdfLib = /const PDF_LIB = '([^']+)'/.exec(sw)[1];
const block = sw.slice(sw.indexOf('const PRECACHE = ['), sw.indexOf('];', sw.indexOf('const PRECACHE = [')));
const files = [...block.matchAll(/['`]([^'`]+)['`]/g)]
  .map((m) => m[1].replace('${PDFJS}', pdfjs).replace('${PDF_LIB}', pdfLib))
  .filter((file) => file !== './');
files.push('sw.js');

const kb = (n) => `${(n / 1024).toFixed(1)} KB`.padStart(10);
const groups = new Map();
const rows = [];
for (const file of files) {
  const data = readFileSync(path.join(publicDir, file));
  const gz = /\.(png|wasm)$/.test(file) ? data.length : gzipSync(data, { level: 9 }).length;
  const group = file.startsWith('vendor/pdfjs') ? 'PDF.js (preview)' : file.startsWith('vendor/pdf-lib') ? 'pdf-lib (processing)'
    : file.startsWith('js/') || file === 'sw.js' ? 'Foldr JavaScript' : file.startsWith('css/') ? 'CSS' : 'HTML, manifest, icons';
  const g = groups.get(group) ?? { raw: 0, gz: 0, count: 0 };
  groups.set(group, { raw: g.raw + data.length, gz: g.gz + gz, count: g.count + 1 });
  rows.push({ file, raw: data.length, gz });
}
console.log('Largest files (raw / gzip):');
for (const row of rows.sort((a, b) => b.raw - a.raw).slice(0, 6)) console.log(`${kb(row.raw)} ${kb(row.gz)}  ${row.file}`);
console.log('\nBy category (raw / gzip):');
let raw = 0;
let gz = 0;
for (const [name, g] of groups) {
  console.log(`${kb(g.raw)} ${kb(g.gz)}  ${name} (${g.count} files)`);
  raw += g.raw;
  gz += g.gz;
}
console.log(`${kb(raw)} ${kb(gz)}  TOTAL first visit (precached for offline)`);
const home = ['index.html', 'css/tokens.css', 'css/base.css', 'css/layout.css', 'css/components.css', 'css/utilities.css']
  .concat(files.filter((f) => f.startsWith('js/') && !f.startsWith('js/operations') && !f.startsWith('js/workers')));
const homeGz = home.reduce((sum, f) => sum + gzipSync(readFileSync(path.join(publicDir, f))).length, 0);
console.log(`\nNeeded to render the home screen: ${kb(homeGz).trim()} gzip (PDF libraries load later, in the background or on demand).`);
const lazy = statSync(path.join(publicDir, pdfjs, 'cmaps')).isDirectory();
if (lazy) console.log('Not precached (fetched on demand, then cached): PDF.js CJK CMaps and standard font substitutes (~2.6 MB).');
