// Foldr service worker.
//
// Strategy:
//  - The whole app shell (HTML, CSS, JS, worker, PDF libraries) is precached
//    into one cache named after a content hash of the build. A new version is
//    installed side by side and only takes over when every file has been
//    downloaded, so the page never runs new JavaScript against old libraries.
//  - Navigations to the app are answered from that cache (so the shell is
//    always consistent and works offline); updates are picked up by the
//    service worker update check and applied when the user reloads.
//  - Other same-origin static files are cache-first. Large optional PDF.js
//    data (CJK CMaps, standard font substitutes) is cached the first time
//    it is used, rather than downloading ~2.6 MB up front. The same goes
//    for the HEIC decoder (libheif, ~2 MB), fetched on the first HEIC photo.
//  - Nothing user-generated is ever cached: documents are opened from local
//    files and outputs are blob: URLs, which never pass through here.

const BUILD_ID = '__FOLDR_BUILD_ID__';
const CACHE_PREFIX = 'foldr-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${BUILD_ID}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${BUILD_ID}`;

const PDFJS = 'vendor/pdfjs@5.7.284/';
const PDF_LIB = 'vendor/pdf-lib@1.17.1/';

const PRECACHE = [
  './',
  'index.html',
  'offline.html',
  'manifest.webmanifest',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'css/fonts.css',
  'css/tokens.css',
  'css/base.css',
  'css/layout.css',
  'css/components.css',
  'css/utilities.css',
  'js/app.js',
  'js/config.js',
  'js/router.js',
  'js/state.js',
  'js/file-manager.js',
  'js/pdf-renderer.js',
  'js/export-manager.js',
  'js/worker-client.js',
  'js/core/filenames.js',
  'js/core/format.js',
  'js/core/page-order.js',
  'js/core/page-ranges.js',
  'js/core/validation.js',
  'js/core/zip.js',
  'js/core/scan-geometry.js',
  'js/core/scan-enhance.js',
  'js/core/image-compress.js',
  'js/core/image-metadata.js',
  'js/ui/dom.js',
  'js/ui/icons.js',
  'js/ui/dialogs.js',
  'js/ui/notifications.js',
  'js/ui/progress.js',
  'js/ui/page-grid.js',
  'js/ui/file-list.js',
  'js/ui/drop-zone.js',
  'js/ui/result-panel.js',
  'js/ui/camera.js',
  'js/ui/crop-editor.js',
  'js/tools/home.js',
  'js/tools/tool-shell.js',
  'js/tools/merge.js',
  'js/tools/split.js',
  'js/tools/page-editor.js',
  'js/tools/compress.js',
  'js/tools/scan.js',
  'js/tools/compress-images.js',
  'js/tools/remove-metadata.js',
  'js/operations/common.js',
  'js/operations/merge.js',
  'js/operations/split.js',
  'js/operations/organize.js',
  'js/operations/compress.js',
  'js/operations/scan.js',
  'js/workers/pdf-worker.js',
  'js/workers/scan-worker.js',
  'js/workers/image-worker.js',
  'js/workers/heif-decoder.js',
  `${PDF_LIB}pdf-lib.esm.min.js`,
  `${PDFJS}pdf.min.mjs`,
  `${PDFJS}pdf.worker.min.mjs`,
  // Decoders for JPEG 2000 / JBIG2 images (common in scans) and colour
  // management, so previews of scanned documents also work offline.
  `${PDFJS}wasm/openjpeg.wasm`,
  `${PDFJS}wasm/jbig2.wasm`,
  `${PDFJS}wasm/qcms_bg.wasm`,
  'vendor/inter@5.3.0/inter-latin-opsz-normal.woff2',
];

const scopeUrl = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // `cache: 'reload'` bypasses the HTTP cache so a new build never
      // precaches a stale file.
      await cache.addAll(PRECACHE.map((path) => new Request(scopeUrl(path), { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && !keep.has(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function isAppNavigation(url) {
  const scope = new URL(self.registration.scope);
  return url.pathname === scope.pathname || url.pathname === `${scope.pathname}index.html`;
}

// The offline page can be shown for any URL, so give it a <base> pointing at
// the app scope; otherwise its relative stylesheet links would break.
async function offlineResponse() {
  const cached = await caches.match(scopeUrl('offline.html'), { cacheName: SHELL_CACHE });
  if (!cached) return new Response('Foldr is offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  const html = (await cached.text()).replace('<head>', `<head>\n  <base href="${self.registration.scope}">`);
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleNavigation(request) {
  const url = new URL(request.url);
  if (isAppNavigation(url)) {
    const cached = await caches.match(scopeUrl('index.html'), { cacheName: SHELL_CACHE });
    if (cached) return cached;
  }
  try {
    return await fetch(request);
  } catch {
    return offlineResponse();
  }
}

async function handleAsset(request) {
  // Only this build's caches: while a new version is installing, the old one
  // must keep serving its own files.
  const cached = (await caches.match(request, { cacheName: SHELL_CACHE }))
    ?? (await caches.match(request, { cacheName: RUNTIME_CACHE }));
  if (cached) return cached;
  const response = await fetch(request);
  const path = new URL(request.url).pathname;
  // Only cache successful, complete responses for versioned library data.
  if (response.ok && response.status === 200 && path.includes('/vendor/')) {
    const copy = response.clone();
    caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js') || url.pathname.endsWith('/healthz')) return;
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
  } else {
    event.respondWith(handleAsset(request));
  }
});
