import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, computeBuildId } from '../../server.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
let server;
let base;

before(async () => {
  server = createApp({ production: true }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('serves the app shell with security headers', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
});

test('rejects every method that could upload data', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(`${base}/`, { method, body: method === 'DELETE' ? undefined : 'x' });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
});

test('stamps the service worker with a content hash and never caches it', async () => {
  const response = await fetch(`${base}/sw.js`);
  const body = await response.text();
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(response.headers.get('cache-control'), /no-cache/);
  assert.doesNotMatch(body, /__FOLDR_BUILD_ID__/);
  assert.ok(body.includes(`'${computeBuildId()}'`));
});

test('versioned vendor files are immutable; manifest has the right type', async () => {
  const vendor = await fetch(`${base}/vendor/pdf-lib@1.17.1/pdf-lib.esm.min.js`);
  assert.equal(vendor.status, 200);
  assert.match(vendor.headers.get('cache-control'), /immutable/);
  assert.match(vendor.headers.get('content-type'), /javascript/);
  const worker = await fetch(`${base}/vendor/pdfjs@5.7.284/pdf.worker.min.mjs`);
  assert.match(worker.headers.get('content-type'), /javascript/);
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
  const json = await manifest.json();
  assert.equal(json.name, 'Foldr');
  assert.equal(json.short_name, 'Foldr');
  assert.ok(json.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'));
});

test('no directory listings, dotfiles or path traversal', async () => {
  assert.equal((await fetch(`${base}/js/`)).status, 404);
  assert.equal((await fetch(`${base}/vendor/`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  const text = await (await fetch(`${base}/does-not-exist`)).text();
  assert.equal(text, 'Not found');
});

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

test('service worker precache list matches the app files exactly', () => {
  const sw = readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
  const list = sw.slice(sw.indexOf('const PRECACHE = ['), sw.indexOf('];', sw.indexOf('const PRECACHE = [')));
  const vendor = { '${PDFJS}': 'vendor/pdfjs@5.7.284/', '${PDF_LIB}': 'vendor/pdf-lib@1.17.1/' };
  const entries = [...list.matchAll(/['`]([^'`]+)['`]/g)]
    .map((match) => match[1].replace(/\$\{(PDFJS|PDF_LIB)\}/, (token) => vendor[token]))
    .filter((entry) => entry !== './');
  for (const entry of entries) assert.ok(existsSync(path.join(publicDir, entry)), `precached file missing: ${entry}`);
  const appFiles = listFiles(publicDir)
    .map((file) => path.relative(publicDir, file).split(path.sep).join('/'))
    .filter((file) => /^(js|css|icons)\//.test(file) || /^[^/]+\.(html|webmanifest)$/.test(file));
  for (const file of appFiles) assert.ok(entries.includes(file), `app file not precached: ${file}`);
});

test('the client never posts documents anywhere', () => {
  const sources = listFiles(path.join(publicDir, 'js')).map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(sources, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|indexedDB/);
  assert.doesNotMatch(sources, /\beval\(|new Function\(|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('vercel.json sends the same security and cache headers as the Express server', async () => {
  const vercel = JSON.parse(readFileSync(path.join(publicDir, '..', 'vercel.json'), 'utf8'));
  assert.equal(vercel.framework, null, 'must deploy as a static site, not an Express function');
  assert.equal(vercel.outputDirectory, 'dist');
  assert.equal(vercel.buildCommand, 'npm run build');
  const rule = (source) => Object.fromEntries(vercel.headers.find((h) => h.source === source).headers.map((x) => [x.key.toLowerCase(), x.value]));
  const all = rule('/(.*)');
  const response = await fetch(`${base}/`);
  const security = ['content-security-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'origin-agent-cluster',
    'referrer-policy', 'x-content-type-options', 'x-dns-prefetch-control', 'x-frame-options', 'x-permitted-cross-domain-policies',
    'permissions-policy', 'cache-control'];
  for (const name of security) assert.equal(all[name], response.headers.get(name), name);
  const vendor = await fetch(`${base}/vendor/pdf-lib@1.17.1/pdf-lib.esm.min.js`);
  assert.equal(rule('/vendor/(.*)')['cache-control'], vendor.headers.get('cache-control'));
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(rule('/sw.js')['cache-control'], sw.headers.get('cache-control'));
});
