// Filenames come from the user's file system and are untrusted. They are only
// ever displayed through textContent and are sanitised before being used as a
// download name.

const MAX_BASE_LENGTH = 120;
// Path separators, characters reserved on Windows/macOS, and control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*‪-‮⁦-⁩]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Removes a trailing ".pdf" (any case). */
export function stripPdfExtension(name) {
  return String(name ?? '').replace(/\.pdf$/i, '');
}

/** Produces a filename safe for downloading. Always returns a non-empty name ending in .pdf unless another extension is given. */
export function sanitizeFilename(name, { extension = '.pdf', fallback = 'document' } = {}) {
  let base = String(name ?? '')
    .normalize('NFC')
    .replace(UNSAFE_CHARS, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const extensionPattern = new RegExp(`${extension.replace('.', '\\.')}$`, 'i');
  base = base.replace(extensionPattern, '');
  base = base.replace(/^[.\s-]+|[.\s]+$/g, '');
  if (base.length > MAX_BASE_LENGTH) base = base.slice(0, MAX_BASE_LENGTH).trim();
  if (!base || WINDOWS_RESERVED.test(base)) base = base ? `${base}-file` : fallback;
  return `${base}${extension}`;
}

/** Base name used to derive output names: "Report Q3.pdf" -> "Report Q3". */
export function baseNameOf(name, fallback = 'document') {
  const safe = sanitizeFilename(stripPdfExtension(name), { fallback });
  return stripPdfExtension(safe);
}

/**
 * Makes every name in the list unique (case-insensitive) by appending
 * " (2)", " (3)", … before the extension. Order is preserved.
 */
export function uniqueFilenames(names) {
  const used = new Set();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    let counter = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${stem} (${counter})${ext}`;
      counter += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

const OUTPUT_SUFFIX = {
  organize: 'organized',
  rotate: 'rotated',
  compress: 'compressed',
};

/** Default output filename for each tool. */
export function defaultOutputName(tool, sourceName, detail) {
  if (tool === 'merge') return 'merged-document.pdf';
  const base = baseNameOf(sourceName);
  if (tool === 'split') return sanitizeFilename(`${base}-pages-${detail}`);
  const suffix = OUTPUT_SUFFIX[tool];
  if (!suffix) throw new Error(`Unknown tool ${tool}`);
  return sanitizeFilename(`${base}-${suffix}`);
}
