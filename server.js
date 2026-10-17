// Foldr's server only delivers static files. It has no upload endpoints, no
// body parsers and rejects every method except GET/HEAD, so it cannot
// receive documents. All PDF processing happens in the browser.

import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const BUILD_PLACEHOLDER = '__FOLDR_BUILD_ID__';

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

/**
 * A content hash of everything in public/. It versions the service worker's
 * cache, so any change to any asset produces a new, atomically-installed
 * cache and old JavaScript is never mixed with new libraries.
 */
export function computeBuildId(dir = PUBLIC_DIR) {
  const hash = createHash('sha256');
  for (const file of listFiles(dir).sort()) {
    if (file.endsWith(`${path.sep}sw.js`) && path.dirname(file) === dir) continue;
    hash.update(path.relative(dir, file));
    hash.update(readFileSync(file));
  }
  hash.update(readFileSync(path.join(dir, 'sw.js')));
  return hash.digest('hex').slice(0, 16);
}

function stampServiceWorker(dir) {
  return readFileSync(path.join(dir, 'sw.js'), 'utf8').replace(BUILD_PLACEHOLDER, computeBuildId(dir));
}

export const CONTENT_SECURITY_POLICY = {
  defaultSrc: ["'self'"],
  // 'wasm-unsafe-eval' lets PDF.js compile its bundled image decoders
  // (JPEG 2000, JBIG2) and colour management. It does not allow eval().
  scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  workerSrc: ["'self'"],
  manifestSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
  frameSrc: ["'none'"],
};

function cacheControlFor(urlPath) {
  // Library directories embed their version, so their contents never change.
  if (/^\/vendor\/[^/]+@[^/]+\//.test(urlPath)) return 'public, max-age=31536000, immutable';
  if (urlPath.startsWith('/icons/')) return 'public, max-age=86400';
  // App code and HTML: always revalidate (cheap with ETags). The service
  // worker provides offline caching.
  return 'no-cache';
}

// Production unless explicitly started in development mode (`npm run dev`).
const DEFAULT_PRODUCTION = process.env.NODE_ENV !== 'development' && !process.argv.includes('--dev');

export function createApp({ publicDir = PUBLIC_DIR, production = DEFAULT_PRODUCTION } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'strong');

  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: CONTENT_SECURITY_POLICY },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      // HSTS only makes sense behind HTTPS; enable it at your TLS terminator.
      strictTransportSecurity: false,
    }),
  );
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    next();
  });

  // Static file server only: refuse anything that could carry a request body.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).type('text/plain').send('Method Not Allowed');
  });

  // WASM and PNG are already compressed; compression's default filter skips them.
  app.use(compression());

  app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

  // The service worker is stamped with a content hash. In development it is
  // recomputed per request so edits are picked up without a restart.
  let stamped = production ? stampServiceWorker(publicDir) : null;
  app.get('/sw.js', (req, res) => {
    const body = stamped ?? stampServiceWorker(publicDir);
    res.setHeader('Cache-Control', 'no-cache, max-age=0');
    res.type('application/javascript').send(body);
  });

  app.use(
    express.static(publicDir, {
      dotfiles: 'ignore',
      index: 'index.html',
      redirect: false,
      fallthrough: true,
      setHeaders(res, filePath) {
        const urlPath = `/${path.relative(publicDir, filePath).split(path.sep).join('/')}`;
        res.setHeader('Cache-Control', cacheControlFor(urlPath));
        if (filePath.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        if (filePath.endsWith('.bcmap') || filePath.endsWith('.pfb')) res.setHeader('Content-Type', 'application/octet-stream');
      },
    }),
  );

  app.use((req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    console.error('Request failed:', req.method, req.path, production ? error.message : error);
    if (res.headersSent) return;
    res.status(error.status && error.status < 500 ? error.status : 500).type('text/plain').send(
      error.status && error.status < 500 ? 'Bad request' : 'Internal server error',
    );
  });

  // Allow tests to force a re-stamp.
  app.locals.restamp = () => { stamped = stampServiceWorker(publicDir); };
  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '127.0.0.1';
  const production = DEFAULT_PRODUCTION;
  // FOLDR_PUBLIC_DIR lets you serve (and test) the built dist/ folder.
  const publicDir = process.env.FOLDR_PUBLIC_DIR ? path.resolve(process.env.FOLDR_PUBLIC_DIR) : PUBLIC_DIR;
  statSync(path.join(publicDir, 'index.html'));
  createApp({ production, publicDir }).listen(port, host, () => {
    console.log(`Foldr is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (${production ? 'production' : 'development'})`);
  });
}
