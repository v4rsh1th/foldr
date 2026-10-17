import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeFilename, baseNameOf, uniqueFilenames, defaultOutputName, stripPdfExtension,
} from '../../public/js/core/filenames.js';
import { formatBytes, describeSizeChange, formatPercent, pluralize } from '../../public/js/core/format.js';

test('sanitizeFilename strips paths, reserved and control characters', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'etc-passwd.pdf');
  assert.equal(sanitizeFilename('a<b>c:d"e|f?g*h.pdf'), 'a-b-c-d-e-f-g-h.pdf');
  assert.equal(sanitizeFilename('bad\u0000name‮.PDF'), 'bad-name-.pdf');
  assert.equal(sanitizeFilename('   '), 'document.pdf');
  assert.equal(sanitizeFilename('...'), 'document.pdf');
  assert.equal(sanitizeFilename('CON'), 'CON-file.pdf');
  assert.equal(sanitizeFilename('report'), 'report.pdf');
  assert.equal(sanitizeFilename('x'.repeat(300)).length, 124);
});

test('sanitizeFilename keeps unicode names', () => {
  assert.equal(sanitizeFilename('Résumé 2024 — 日本.pdf'), 'Résumé 2024 — 日本.pdf');
});

test('HTML in names is kept as plain text (escaped by textContent when shown)', () => {
  assert.equal(sanitizeFilename('<img src=x onerror=alert(1)>.pdf'), 'img src=x onerror=alert(1)-.pdf');
});

test('baseNameOf and stripPdfExtension', () => {
  assert.equal(stripPdfExtension('Report.Q3.PDF'), 'Report.Q3');
  assert.equal(baseNameOf('Report Q3.pdf'), 'Report Q3');
  assert.equal(baseNameOf(''), 'document');
});

test('uniqueFilenames adds counters case-insensitively', () => {
  assert.deepEqual(uniqueFilenames(['a.pdf', 'A.pdf', 'a.pdf', 'b.pdf']), ['a.pdf', 'A (2).pdf', 'a (3).pdf', 'b.pdf']);
});

test('defaultOutputName per tool', () => {
  assert.equal(defaultOutputName('merge'), 'merged-document.pdf');
  assert.equal(defaultOutputName('split', 'document.pdf', '1-5'), 'document-pages-1-5.pdf');
  assert.equal(defaultOutputName('organize', 'scan.pdf'), 'scan-organized.pdf');
  assert.equal(defaultOutputName('rotate', 'scan.pdf'), 'scan-rotated.pdf');
  assert.equal(defaultOutputName('compress', 'scan.pdf'), 'scan-compressed.pdf');
  assert.throws(() => defaultOutputName('nope', 'x.pdf'));
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(10 * 1024 * 1024), '10 MB');
  assert.equal(formatBytes(1.25 * 1024 ** 3), '1.25 GB');
  assert.equal(formatBytes(-1), '—');
});

test('describeSizeChange reports direction honestly', () => {
  const smaller = describeSizeChange(1000, 600);
  assert.equal(smaller.direction, 'smaller');
  assert.equal(smaller.absoluteDelta, 400);
  assert.equal(smaller.label, '−40%');
  const larger = describeSizeChange(1000, 1050);
  assert.equal(larger.direction, 'larger');
  assert.equal(larger.label, '+5.0%');
  assert.equal(describeSizeChange(1000, 1000).direction, 'same');
  assert.equal(formatPercent(0.01), '+0.1%');
});

test('pluralize', () => {
  assert.equal(pluralize(1, 'page'), '1 page');
  assert.equal(pluralize(1200, 'page'), '1,200 pages');
});
