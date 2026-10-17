# Foldr

Foldr is a free, privacy-first PDF toolbox that runs entirely in the browser. It merges, splits, organizes, rotates and compresses PDFs on the user's own device: there are no uploads, accounts, watermarks, ads or tracking. It installs as a Progressive Web App (PWA) and keeps working offline.

| Tool | What it does |
| --- | --- |
| **Merge PDFs** | Combines files in a chosen order. Real pages are copied, never rasterised. |
| **Split PDF** | Extracts selected pages (`1, 3, 5-8`), saves every page as its own file, or splits by ranges (`1-5, 6-10`). Several outputs can be downloaded as a ZIP. |
| **Organize PDF** | Visual thumbnail grid: reorder (drag and drop, keyboard or toolbar), rotate, delete with undo/redo. |
| **Rotate Pages** | Rotates the whole document, selected pages or single pages. Writes `/Rotate` into the file. |
| **Compress PDF** | Lossless clean-up, plus two image re-encoding levels. Reports the real size change, including when the file gets larger. |

## Quick start

Requirements: Node.js 22.13 or newer, npm 10+.

```bash
npm install            # install pinned dependencies
npm start              # production mode on http://127.0.0.1:3000
npm run dev            # development mode (service worker re-stamped on every request)
```

Configuration (environment variables):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listening port |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` to test from a phone on your network |
| `NODE_ENV` | — | `development` is the same as `--dev` |

Resource limits (file size, total pages, number of files) and the thumbnail memory budget are in [public/js/config.js](public/js/config.js).

### Tests

```bash
npm test               # unit + integration tests (Node's built-in runner)
npx playwright install chromium   # once, for browser tests
npm run test:browser   # end-to-end tests in headless Chromium (desktop + mobile emulation)
npm run test:all       # everything
```

See [tests/README.md](tests/README.md) for what each suite covers and a manual checklist.

### Deploying to Vercel

Foldr deploys to Vercel as a **static site**: all PDF work happens in the browser, so no server function is needed. Everything is configured in [vercel.json](vercel.json).

1. Push the repository to GitHub and choose **Add New → Project** in Vercel, then import it. No settings need changing: `vercel.json` sets the install command (`npm ci`), build command (`npm run build`) and output directory (`dist`).
2. Deploy. Vercel serves over HTTPS, which the service worker needs for offline use and installation.

Or deploy from the CLI with `npx vercel` (preview) or `npx vercel --prod`.

Notes:
- `vercel.json` sets `"framework": null` on purpose. Without it, Vercel detects `server.js` as an Express app and deploys it as a serverless function. The static deployment is faster and keeps the guarantee that no server code ever sees a request carrying a document.
- `vercel.json` sends the same CSP, security headers and cache policy as the Express server. A test (`tests/integration/server.test.js`) fails if the two drift apart.
- Each build stamps `sw.js` with a content hash of `public/`, so every deployment that changes a file triggers the in-app "new version available" prompt, and unchanged files keep the same hash.
- `npm run test:dist` builds `dist/` and runs the full browser suite against it, which is exactly what Vercel serves.
- `.vercelignore` keeps test fixtures out of the upload.

### Self-hosting with Express

The bundled Express server is the alternative to static hosting:

```bash
npm ci --omit=dev
npm start
```

Run it behind a TLS-terminating proxy: service workers (offline support and installation) require HTTPS on any origin other than `localhost`. Enable HSTS at the proxy. The server compresses responses with gzip.

To host the files on a static host instead (nginx, Netlify, GitHub Pages…), run `npm run build` and deploy `dist/`. The build stamps `sw.js` with a content hash, which the service worker uses to version its cache. Serving `public/` directly from a static host would leave the placeholder in place and break updates. Configure the host to send the security headers listed under [Server security](#server-security).

Other scripts: `npm run size` (asset sizes), `npm run vendor` (re-copy pinned libraries into `public/vendor/`), `npm run fixtures` (regenerate test PDFs), `npm run icons` (regenerate PNG icons).

## Architecture

```
Main thread (UI)                          PDF worker (module Worker)
──────────────────                        ──────────────────────────
app.js / router.js  (hash routes)         workers/pdf-worker.js
tools/*.js          (one view per tool)     ├─ operations/common.js   load, inspect, prune, verify
file-manager.js     (selection+validation)  ├─ operations/merge.js
export-manager.js   (Blobs, downloads, ZIP) ├─ operations/split.js
pdf-renderer.js ── PDF.js (previews only)   ├─ operations/organize.js  (Organize + Rotate)
ui/page-grid.js     (lazy thumbnails)       └─ operations/compress.js
core/*.js           (pure logic, unit-tested in Node)   all via pdf-lib
```

- **Two libraries, two jobs.** [PDF.js](https://mozilla.github.io/pdf.js/) 5.7.284 renders previews only (in its own worker). [pdf-lib](https://pdf-lib.js.org/) 1.17.1 does every modification, inside Foldr's PDF worker. Both are self-hosted in `public/vendor/<name>@<version>/`. Foldr ships the PDF.js *legacy* build: the modern build relies on very new built-ins (`Map.prototype.getOrInsertComputed`, `Math.sumPrecise`) that current Safari/iOS lack. The legacy build adds about 60 KB of polyfills.
- **Why a worker.** pdf-lib parses and saves synchronously in large chunks. On big files this would freeze the UI for seconds. In the worker the UI stays responsive (measured: zero main-thread tasks over 200 ms during a 146 MB merge). Terminating the worker is also the only reliable way to cancel pdf-lib mid-operation. Buffers are *transferred*, not copied.
- **Parsing once.** Each file is parsed once during validation, and the worker keeps that parsed document for Merge and Split. Organize, Rotate and Compress change a document in place, so they parse a fresh copy. If the worker is restarted after a cancel, files are re-registered automatically.
- **Pure core.** Page-range parsing, page order, rotation maths, filenames, validation and ZIP writing live in `public/js/core/`. They have no DOM or pdf-lib dependencies and are unit-tested directly.
- **State.** Each tool view owns its state. Page arrangements are immutable arrays kept in an undo history. An operation token ([state.js](public/js/state.js)) ensures that a cancelled or superseded operation can never overwrite a newer result.
- **Typography.** Foldr uses Inter (SIL OFL) as a variable font with weight and optical-size axes, self-hosted in `public/vendor/inter@5.3.0/`. Headings automatically get Inter's tighter Display design. The Latin subset (71 KB) is preloaded and precached; Latin Extended loads only for pages that need those characters. A metric-matched local fallback keeps text from shifting while the font loads.
- **No framework, no bundler.** Native ES modules, about 187 KB of app source (67 KB gzipped). Every file is precached, so no build step is needed.

### Notable PDF decisions

- **Rotation is applied exactly once.** Each page stores its original `/Rotate` (`baseRotation`, including values inherited from parent page-tree nodes) plus the user's change. Previews render at `base + change`, and export writes that value as the absolute `/Rotate`. Tests cover pages with existing and inherited rotation.
- **Organize and Rotate edit in place.** Pages are re-linked under a new flat page tree after copying inheritable attributes (Resources, MediaBox, CropBox, Rotate) onto each page. This keeps bookmarks, forms, attachments and metadata. Unreachable objects are then pruned, so deleted pages really leave the file.
- **Merge and Split copy pages** into new documents. Each source is copied with one `copyPages` call, so shared fonts and images are copied once. Descriptive metadata comes from the first (or source) document.
- **Every output is verified** before it is offered for download. Foldr re-parses it and checks the page count; Rotate also checks rotations and Compress also checks page sizes.

### Compression strategy

All three levels do real work. None of them "just re-saves" the file.

| Level | What happens |
| --- | --- |
| Lossless | Removes unreachable objects, merges byte-identical streams (common after merging), Flate-compresses uncompressed streams (except XMP metadata) and writes object streams. |
| Balanced | Lossless, plus re-encodes **JPEG** images at quality 0.80 and downsamples any image above about 150 ppi for the largest page it appears on. |
| Smaller file | Lossless, plus re-encodes JPEG **and** large lossless 8-bit RGB/grey images as JPEG at quality 0.60, about 100 ppi. Shows an explicit quality warning. |

An image is only replaced if the new encoding is at least 10% smaller. Images whose structure can't be re-encoded safely are left untouched: colour-key masks, `/Decode` arrays, image masks, CMYK/indexed/Lab colour, 16-bit samples and `/Matte` soft masks. The result screen shows the original size, new size, absolute and percentage change, and what was changed. If the file did not shrink, it says so ("This file couldn't be made smaller") and labels the button "Download anyway".

Measured on the test fixtures: a text PDF with uncompressed streams went from 92 KB to 7.5 KB losslessly; a PDF with a duplicated image went from 988 KB to 495 KB losslessly; an image-heavy 6.1 MB PDF shrank 32% with Balanced. An already-compact 1,006-byte file came out at 1,015 bytes and is reported as "couldn’	 be made smaller".

## Privacy model

- PDFs are read from the local file picker or drag and drop as `File` objects. They are processed in the page and its workers and saved as `Blob` downloads (`blob:` URLs, revoked once the result is discarded).
- The server is a static file server. It has **no upload endpoints and no body parsers**, and it answers every method other than GET/HEAD with `405`. A test checks this.
- No analytics, telemetry, ads, third-party scripts, font services or CDNs. The Inter typeface is self-hosted. The CSP is `connect-src 'self'` and all assets, including the font, are same-origin. The browser tests fail if any request leaves the origin or uses a method other than GET/HEAD while documents are processed.
- Nothing is persisted. The client never uses `localStorage`, IndexedDB or cookies, and a test checks the client source for this. The service worker caches only versioned app files; a test confirms no PDFs or `blob:` URLs end up in Cache Storage.
- Filenames are treated as untrusted. They are shown only via `textContent` (a test uses an HTML-injection filename) and sanitised before they become download names. They never appear in URLs or logs.
- Logs contain error names and codes only, never document contents or names.

## PWA and offline

- `manifest.webmanifest` includes name, icons (192/512 and a maskable icon), theme colour, `standalone` display, scope and start URL, plus shortcuts.
- **Service worker** ([public/sw.js](public/sw.js)):
  - **Atomic, versioned app shell.** All app files, both PDF libraries and the image decoders (about 1.31 MB gzipped) are precached into a cache named after a content hash of `public/`. A new version installs side by side; the old one keeps serving its own files until the user clicks **Reload** in the update notice. Old caches are then deleted. This prevents mixing new JavaScript with old libraries.
  - **Navigation.** App navigations are answered from the cached shell, so it is always consistent and works offline. Other URLs go to the network and fall back to `offline.html`.
  - **Static assets.** Same-origin assets are cache-first. Optional PDF.js data (CJK CMaps, standard-font substitutes, about 2.6 MB) is cached the first time it is used.
  - **Never cached:** user files and outputs, non-GET requests, cross-origin requests.
- The **first visit needs a network connection** to download the app. After that, startup, navigation, file selection, every operation and downloads all work offline. This is verified by a browser test.

## Server security

Express 5 with Helmet 8, using an explicit policy:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
  img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self';
  manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none';
  frame-ancestors 'none'; frame-src 'none'
```

`'wasm-unsafe-eval'` lets PDF.js compile its bundled image decoders (JPEG 2000, JBIG2) and colour-management WASM. It does not allow `eval`. PDF.js runs with `isEvalSupported: false`. There are no inline scripts or styles.

Other headers: `nosniff`, `no-referrer`, COOP/CORP `same-origin`, `X-Frame-Options`, and a restrictive `Permissions-Policy`. There is no CORS, no `X-Powered-By`, no directory listings and no dotfiles, and production errors are generic. Cache policy: versioned `vendor/*@*/` files are `immutable` for one year; HTML, JS, CSS and `sw.js` use `no-cache` (revalidated with ETags).

## Measured results

### Asset sizes (`npm run size`)

| | Raw | Gzip |
| --- | ---: | ---: |
| Foldr JavaScript (36 files) | 187 KB | 67 KB |
| CSS (6 files) | 36 KB | 8 KB |
| Inter font (Latin, variable) | 71 KB | 71 KB |
| pdf-lib | 511 KB | 201 KB |
| PDF.js (library, worker, 3 WASM decoders) | 2,177 KB | 948 KB |
| **Total first visit (precached)** | **3.0 MB** | **1.31 MB** |
| Needed to render the home screen (including the font) | | 132 KB |

The PDF.js worker (1.26 MB raw) is by far the largest dependency. PDF libraries load lazily when first needed.

### Performance (headless Chromium, Apple Silicon)

| Scenario | Result |
| --- | --- |
| Organize, 1,000-page PDF | Grid and first thumbnails in 0.67 s; JS heap 4 MB on the main thread. Only visible thumbnails render. |
| Scroll the 1,000-page grid to the end | Canvases stay within the pixel budget (167 alive, not 1,000); heap 8 MB; 0 long tasks over 200 ms |
| Rotate all 1,000 pages, export and verify | 1.0 s |
| Merge 24 × 6.1 MB (146 MB, 72 pages) and verify | 0.23 s; 0 main-thread long tasks over 200 ms |

Phones and low-memory devices will be slower. Files are held in memory while processed, so very large jobs show a confirmation first (see `LIMITS`).

## Known limitations

- **Encrypted PDFs aren't supported**, including owner-password-only "permissions" encryption. pdf-lib can't decrypt, so these files are rejected with an explanation.
- **Merge and Split** carry pages, their content, annotations and links. They do **not** carry bookmarks, interactive form definitions (field appearances remain visible but may not be editable), attachments, tagged-PDF structure or document JavaScript. Foldr shows a notice when a source file has bookmarks, forms or attachments.
- **Digital signatures** are invalidated by any change, and Foldr warns about this. Organize/Rotate keep bookmarks, but bookmarks that point at deleted pages stop working.
- **Compression** cannot subset fonts, optimise content streams, or re-encode CMYK, JPEG 2000, JBIG2, indexed or 16-bit images. The ppi target uses the largest page that shows an image, not its exact placement, so some images stay larger than necessary (a deliberately conservative choice). Greyscale images become RGB JPEGs, which have identical channels. Lossy modes need `OffscreenCanvas` in workers (Chrome 69+, Firefox 105+, Safari 16.4+); otherwise only Lossless is offered.
- pdf-lib is lenient with damaged files. A truncated file may load with missing content; Foldr warns when the end-of-file marker is missing, and output verification catches structural failures.
- The browser holds whole files in memory. Hard limits: 1.5 GB per file, 2 GB / 20,000 pages per job, and a confirmation above 200 MB / 2,000 pages.
- Previews use PDF.js, which may render rare files differently from other viewers. XFA forms aren't rendered.
- Drag-and-drop on touch screens starts from the grip handle (so scrolling still works); toolbar buttons and keyboard shortcuts are alternatives. Multi-page drag isn't supported: select pages and use the move buttons instead.
- On iOS Safari, blob downloads may open in the built-in viewer rather than saving directly, depending on the iOS version.
- Automated browser tests run in Chromium only. Firefox and Safari are covered by the manual checklist.

## Future improvements

- Firefox and WebKit Playwright projects in CI.
- Insert pages from another PDF in Organize; split by bookmarks; reorder pages in Merge.
- Password-protected PDFs (would need a client-side decryption library).
- Font subsetting and lossless image recompression (re-deflating images with poor Flate settings).
- Streaming saves through the File System Access API for multi-gigabyte jobs.
- Localisation.

## License

MIT. See [LICENSE](LICENSE). pdf-lib (MIT), PDF.js (Apache-2.0) and Inter (SIL Open Font License 1.1) are distributed with their own licenses in `public/vendor/`.
