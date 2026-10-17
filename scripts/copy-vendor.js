// Copies the pinned browser builds of pdf-lib and PDF.js into public/vendor/.
// Vendor directories embed the library version so they can be served with
// long-lived immutable cache headers and never mix across upgrades.
import { cp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modules = path.join(root, 'node_modules');
const vendorRoot = path.join(root, 'public', 'vendor');

async function versionOf(pkg) {
  const json = JSON.parse(await readFile(path.join(modules, pkg, 'package.json'), 'utf8'));
  return json.version;
}

async function copyFiles(from, to, files) {
  await mkdir(to, { recursive: true });
  for (const file of files) await cp(path.join(from, file), path.join(to, file), { recursive: true });
}

const pdfLibVersion = await versionOf('pdf-lib');
const pdfjsVersion = await versionOf('pdfjs-dist');

for (const entry of await readdir(vendorRoot).catch(() => [])) {
  await rm(path.join(vendorRoot, entry), { recursive: true, force: true });
}

const pdfLibDir = path.join(vendorRoot, `pdf-lib@${pdfLibVersion}`);
await copyFiles(path.join(modules, 'pdf-lib', 'dist'), pdfLibDir, ['pdf-lib.esm.min.js']);
await copyFiles(path.join(modules, 'pdf-lib'), pdfLibDir, ['LICENSE.md']);
// The source map is not shipped, so drop the reference to avoid a 404 in DevTools.
const pdfLibFile = path.join(pdfLibDir, 'pdf-lib.esm.min.js');
const pdfLibSource = await readFile(pdfLibFile, 'utf8');
await writeFile(pdfLibFile, pdfLibSource.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n'));

const pdfjsSrc = path.join(modules, 'pdfjs-dist');
const pdfjsDir = path.join(vendorRoot, `pdfjs@${pdfjsVersion}`);
// The legacy build bundles polyfills for newer built-ins (e.g.
// Map.prototype.getOrInsertComputed, Math.sumPrecise) that the modern build
// assumes, so it runs on current Safari/iOS and older Chromium too.
await copyFiles(path.join(pdfjsSrc, 'legacy', 'build'), pdfjsDir, ['pdf.min.mjs', 'pdf.worker.min.mjs']);
await copyFiles(pdfjsSrc, pdfjsDir, ['LICENSE', 'cmaps', 'standard_fonts', 'iccs']);
// Image decoders (JPEG 2000, JBIG2) and colour management. The scripting
// sandbox (quickjs) is intentionally omitted: Foldr never runs PDF JavaScript.
await copyFiles(path.join(pdfjsSrc, 'wasm'), path.join(pdfjsDir, 'wasm'), [
  'openjpeg.wasm', 'openjpeg_nowasm_fallback.js',
  'jbig2.wasm', 'jbig2_nowasm_fallback.js',
  'qcms_bg.wasm',
  'LICENSE_OPENJPEG', 'LICENSE_PDFJS_OPENJPEG', 'LICENSE_JBIG2', 'LICENSE_PDFJS_JBIG2',
  'LICENSE_QCMS', 'LICENSE_PDFJS_QCMS',
]);

// Inter (variable: weight + optical size), self-hosted so no font service is
// ever contacted. Latin is precached; Latin Extended loads only when a page
// contains those characters (via unicode-range).
const interVersion = await versionOf('@fontsource-variable/inter');
const interSrc = path.join(modules, '@fontsource-variable', 'inter');
const interDir = path.join(vendorRoot, `inter@${interVersion}`);
await copyFiles(path.join(interSrc, 'files'), interDir, ['inter-latin-opsz-normal.woff2', 'inter-latin-ext-opsz-normal.woff2']);
await copyFiles(interSrc, interDir, ['LICENSE']);

console.log(`Vendored pdf-lib@${pdfLibVersion}, pdfjs@${pdfjsVersion} and inter@${interVersion} into public/vendor/`);
