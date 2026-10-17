import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  findPdfSignature, hasEofMarker, checkSignature, checkFileSize, assessWorkload, FileValidationError,
} from '../../public/js/core/validation.js';
import { createZip, crc32, ZipTooLargeError } from '../../public/js/core/zip.js';

const bytes = (text) => new TextEncoder().encode(text);

test('finds the PDF signature, including after leading junk', () => {
  assert.equal(findPdfSignature(bytes('%PDF-1.7\n')), 0);
  assert.equal(findPdfSignature(bytes('\r\n  %PDF-1.4')), 4);
  assert.equal(findPdfSignature(bytes('PK\u0003\u0004')), -1);
  assert.equal(findPdfSignature(new Uint8Array(0)), -1);
});

test('detects the EOF marker', () => {
  assert.equal(hasEofMarker(bytes('...trailer\n%%EOF\n')), true);
  assert.equal(hasEofMarker(bytes('...truncated')), false);
});

test('checkSignature: empty, not a PDF, valid, truncated', () => {
  const meta = { name: 'a.pdf', type: 'application/pdf', size: 10 };
  assert.throws(() => checkSignature({ ...meta, size: 0 }, new Uint8Array(), new Uint8Array()), { code: 'empty' });
  assert.throws(() => checkSignature(meta, bytes('hello'), bytes('hello')), (error) => {
    assert.ok(error instanceof FileValidationError);
    assert.equal(error.code, 'not-pdf');
    assert.match(error.message, /renamed/);
    return true;
  });
  assert.throws(() => checkSignature({ name: 'a.png', type: 'image/png', size: 5 }, bytes('PNG'), bytes('')), { message: /only works with PDF/ });
  assert.deepEqual(checkSignature(meta, bytes('%PDF-1.7'), bytes('%%EOF')).warnings, []);
  assert.equal(checkSignature(meta, bytes('%PDF-1.7'), bytes('cut')).warnings.length, 1);
});

test('a valid PDF with a misleading MIME type and extension is accepted', () => {
  const result = checkSignature({ name: 'download', type: 'application/octet-stream', size: 20 }, bytes('%PDF-1.4'), bytes('%%EOF'));
  assert.deepEqual(result.warnings, []);
});

test('size limits warn and block', () => {
  const limits = { warnFileBytes: 100, maxFileBytes: 200, warnTotalBytes: 300, maxTotalBytes: 400, warnTotalPages: 10, maxTotalPages: 20, maxFiles: 3 };
  assert.equal(checkFileSize(50, limits), 'ok');
  assert.equal(checkFileSize(150, limits), 'warn');
  assert.throws(() => checkFileSize(250, limits), { code: 'too-large' });
  assert.equal(assessWorkload({ fileCount: 1, totalBytes: 10, totalPages: 5 }, limits).level, 'ok');
  assert.equal(assessWorkload({ fileCount: 1, totalBytes: 350, totalPages: 5 }, limits).level, 'warn');
  assert.equal(assessWorkload({ fileCount: 1, totalBytes: 10, totalPages: 11 }, limits).level, 'warn');
  assert.equal(assessWorkload({ fileCount: 1, totalBytes: 10, totalPages: 21 }, limits).level, 'block');
  assert.equal(assessWorkload({ fileCount: 4, totalBytes: 10, totalPages: 1 }, limits).level, 'block');
});

test('crc32 matches the reference value', async () => {
  assert.equal(await crc32(bytes('123456789')), 0xcbf43926);
  assert.equal(await crc32(bytes('123456789'), { yieldEvery: 2 }), 0xcbf43926);
});

test('createZip produces an archive that unzip accepts', async (t) => {
  const zip = await createZip([
    { name: 'one.pdf', bytes: bytes('%PDF-1.7 first') },
    { name: 'Résumé (2).pdf', bytes: bytes('%PDF-1.7 second file') },
  ]);
  assert.equal(zip.type, 'application/zip');
  const data = new Uint8Array(await zip.arrayBuffer());
  assert.deepEqual([...data.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const dir = mkdtempSync(path.join(tmpdir(), 'foldr-zip-'));
  try {
    const file = path.join(dir, 'out.zip');
    writeFileSync(file, data);
    let output;
    try {
      output = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    } catch (error) {
      if (error.code === 'ENOENT') return t.skip('unzip is not installed');
      throw error;
    }
    assert.match(output, /No errors detected/);
    const listing = execFileSync('unzip', ['-p', file, 'one.pdf'], { encoding: 'utf8' });
    assert.equal(listing, '%PDF-1.7 first');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ZipTooLargeError has a user-facing message', () => {
  assert.match(new ZipTooLargeError().message, /individually/);
});
