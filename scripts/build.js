// Optional: prepares dist/ for static hosting (Netlify, GitHub Pages, nginx…).
// The bundled Express server stamps sw.js itself, so this is only needed
// when serving the files with something else. It copies public/ and writes
// the service worker with its content-hash build id.
import { cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { computeBuildId } from '../server.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, 'public');
const dist = path.join(root, 'dist');
const buildId = computeBuildId(publicDir);

rmSync(dist, { recursive: true, force: true });
cpSync(publicDir, dist, { recursive: true });
const sw = readFileSync(path.join(publicDir, 'sw.js'), 'utf8').replace('__FOLDR_BUILD_ID__', buildId);
writeFileSync(path.join(dist, 'sw.js'), sw);
console.log(`Built dist/ (build ${buildId}). Serve it over HTTPS with the headers described in README.md.`);
