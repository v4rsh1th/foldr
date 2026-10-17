// Compression strategy. Every step is real; none of them just re-saves.
//
// Lossless (all modes):
//  1. Remove unreachable objects (leftovers from incremental saves, orphaned
//     pages and resources).
//  2. Merge byte-identical streams (fonts/images duplicated by earlier merges).
//  3. Flate-compress streams that are stored uncompressed (not XMP metadata,
//     which must stay readable by non-PDF tools).
//  4. Write with cross-reference/object streams, which pack small objects.
//
// Lossy (Balanced and Smaller only):
//  - Re-encode eligible images as JPEG at a lower quality and downsample any
//    image whose pixel size exceeds the target resolution for the largest
//    page it appears on. Balanced: JPEG images only, 150 ppi, quality 0.80.
//    Smaller: also converts large lossless (Flate) RGB/greyscale images,
//    100 ppi, quality 0.60.
//  - An image is only replaced if the new encoding is at least 10% smaller.
//  - Images with transparency keyed by colour (/Mask arrays), custom /Decode
//    arrays, image masks, CMYK/indexed/Lab colour, 16-bit samples or
//    pre-multiplied soft masks (/Matte) are left untouched, because
//    re-encoding them correctly needs a full PDF imaging model.
//
// Text and vector graphics are never rasterised.

import {
  PDFName,
  PDFNumber,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFRawStream,
  decodePDFRawStream,
} from '../../vendor/pdf-lib@1.17.1/pdf-lib.esm.min.js';
import { pruneUnreachableObjects, savePdf, stampModified, verifyOutput } from './common.js';

export const COMPRESSION_MODES = Object.freeze({
  lossless: { lossy: false },
  balanced: { lossy: true, maxPpi: 150, quality: 0.8, includeFlateImages: false },
  smaller: { lossy: true, maxPpi: 100, quality: 0.6, includeFlateImages: true },
});

const N = (name) => PDFName.of(name);
const MIN_IMAGE_PIXELS = 128 * 128;
const MIN_IMAGE_BYTES = 16 * 1024;
const MIN_SAVING_RATIO = 0.9;

// ---------------------------------------------------------------------------
// Lossless helpers

export async function deflateBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function compressionStreamSupported() {
  return typeof CompressionStream === 'function';
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function replaceRefs(object, replacements) {
  const swap = (value) => (value instanceof PDFRef && replacements.has(value) ? replacements.get(value) : value);
  const stack = [object];
  while (stack.length) {
    const current = stack.pop();
    if (current instanceof PDFRawStream) {
      stack.push(current.dict);
    } else if (current instanceof PDFDict) {
      for (const [key, value] of current.entries()) {
        const next = swap(value);
        if (next !== value) current.set(key, next);
        else if (value instanceof PDFDict || value instanceof PDFArray) stack.push(value);
      }
    } else if (current instanceof PDFArray) {
      for (let i = 0; i < current.size(); i += 1) {
        const value = current.get(i);
        const next = swap(value);
        if (next !== value) current.set(i, next);
        else if (value instanceof PDFDict || value instanceof PDFArray) stack.push(value);
      }
    }
  }
}

/** Points every reference to a duplicate stream at one canonical copy. */
export async function deduplicateStreams(context) {
  const canonical = new Map();
  const replacements = new Map();
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || object.contents.length < 256) continue;
    const key = `${await sha256Hex(object.contents)}|${object.dict.toString()}`;
    if (canonical.has(key)) replacements.set(ref, canonical.get(key));
    else canonical.set(key, ref);
  }
  if (!replacements.size) return 0;
  for (const [, object] of context.enumerateIndirectObjects()) replaceRefs(object, replacements);
  const { Root, Info } = context.trailerInfo;
  if (Root) replaceRefs(context.lookup(Root), replacements);
  if (Info) replaceRefs(context.lookup(Info), replacements);
  for (const ref of replacements.keys()) context.delete(ref);
  return replacements.size;
}

/** Flate-compresses streams that have no filter. */
export async function compressPlainStreams(context) {
  if (!compressionStreamSupported()) return 0;
  let count = 0;
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || object.dict.has(N('Filter'))) continue;
    if (object.contents.length < 64 || object.dict.lookup(N('Type')) === N('Metadata')) continue;
    const compressed = await deflateBytes(object.contents);
    if (compressed.length >= object.contents.length * 0.95) continue;
    const dict = object.dict.clone(context);
    dict.set(N('Filter'), N('FlateDecode'));
    dict.delete(N('DecodeParms'));
    context.assign(ref, PDFRawStream.of(dict, compressed));
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Image analysis

// Returns the stream's only filter as a PDFName, null if unfiltered, or
// 'multiple' for filter chains (which are left alone).
function singleFilter(dict) {
  const filter = dict.lookup(N('Filter'));
  if (filter instanceof PDFName) return filter;
  if (filter instanceof PDFArray && filter.size() === 1) return filter.lookup(0);
  return filter ? 'multiple' : null;
}

function colorComponents(context, colorSpace) {
  const space = colorSpace instanceof PDFRef ? context.lookup(colorSpace) : colorSpace;
  if (space === N('DeviceRGB')) return { components: 3, keep: true };
  if (space === N('DeviceGray')) return { components: 1, keep: false };
  if (space instanceof PDFArray && space.lookup(0) === N('ICCBased')) {
    const profile = space.lookup(1);
    const n = profile?.dict?.lookup(N('N'));
    const count = n instanceof PDFNumber ? n.asNumber() : 0;
    if (count === 3) return { components: 3, keep: true };
    if (count === 1) return { components: 1, keep: false };
  }
  return null;
}

/** Decides whether an image XObject can be re-encoded safely. Returns a description or a skip reason. */
export function analyzeImage(context, stream, settings) {
  const { dict } = stream;
  if (dict.lookup(N('Subtype')) !== N('Image')) return { skip: 'not-image' };
  const width = dict.lookup(N('Width'))?.asNumber?.();
  const height = dict.lookup(N('Height'))?.asNumber?.();
  if (!width || !height) return { skip: 'invalid' };
  if (dict.lookup(N('ImageMask'))?.asBoolean?.()) return { skip: 'mask' };
  if (dict.has(N('Mask')) || dict.has(N('Decode'))) return { skip: 'unsupported-structure' };
  const bpc = dict.lookup(N('BitsPerComponent'))?.asNumber?.();
  if (bpc !== 8) return { skip: 'unsupported-depth' };
  const color = colorComponents(context, dict.get(N('ColorSpace')));
  if (!color) return { skip: 'unsupported-color' };
  const smask = dict.lookup(N('SMask'));
  if (smask?.dict?.has(N('Matte'))) return { skip: 'unsupported-structure' };
  if (width * height < MIN_IMAGE_PIXELS || stream.contents.length < MIN_IMAGE_BYTES) return { skip: 'small' };

  const filter = singleFilter(dict);
  if (filter === N('DCTDecode')) return { kind: 'jpeg', width, height, color };
  if (filter === N('FlateDecode') && settings.includeFlateImages) return { kind: 'flate', width, height, color };
  return { skip: filter === N('FlateDecode') ? 'lossless-kept' : 'unsupported-filter' };
}

/**
 * Maps each image ref to the largest page side (in points) of any page that
 * shows it, following nested form XObjects.
 */
export function collectImagePlacements(doc) {
  const { context } = doc;
  const placements = new Map();
  const walkResources = (resources, pageSide, visited) => {
    const xobjects = resources?.lookup?.(N('XObject'));
    if (!(xobjects instanceof PDFDict)) return;
    for (const [, value] of xobjects.entries()) {
      if (!(value instanceof PDFRef) || visited.has(value)) continue;
      visited.add(value);
      const object = context.lookup(value);
      const subtype = object?.dict?.lookup(N('Subtype'));
      if (subtype === N('Image')) {
        placements.set(value, Math.max(placements.get(value) ?? 0, pageSide));
      } else if (subtype === N('Form')) {
        walkResources(object.dict.lookup(N('Resources')), pageSide, visited);
      }
    }
  };
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    walkResources(page.node.Resources(), Math.max(width, height), new Set());
  }
  return placements;
}

export function targetDimensions(width, height, pageSidePoints, maxPpi) {
  const limit = Math.max(1, Math.ceil((pageSidePoints / 72) * maxPpi));
  const longest = Math.max(width, height);
  if (longest <= limit) return { width, height, scaled: false };
  const scale = limit / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: true,
  };
}

// ---------------------------------------------------------------------------
// Flate image decoding (PNG predictors)

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Undoes PNG (10-15) or TIFF (2) predictors for 8-bit samples. */
export function unpredict(data, { predictor, colors, columns }) {
  if (!predictor || predictor === 1) return data;
  const rowLength = colors * columns;
  if (predictor === 2) {
    const out = data.slice();
    for (let row = 0; row < out.length; row += rowLength) {
      for (let i = colors; i < rowLength; i += 1) out[row + i] = (out[row + i] + out[row + i - colors]) & 0xff;
    }
    return out;
  }
  if (predictor < 10) throw new Error(`Unsupported predictor ${predictor}`);
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  for (let row = 0; row < rows; row += 1) {
    const type = data[row * (rowLength + 1)];
    const src = row * (rowLength + 1) + 1;
    const dst = row * rowLength;
    for (let i = 0; i < rowLength; i += 1) {
      const raw = data[src + i];
      const left = i >= colors ? out[dst + i - colors] : 0;
      const up = row > 0 ? out[dst - rowLength + i] : 0;
      const upLeft = row > 0 && i >= colors ? out[dst - rowLength + i - colors] : 0;
      let value;
      switch (type) {
        case 0: value = raw; break;
        case 1: value = raw + left; break;
        case 2: value = raw + up; break;
        case 3: value = raw + ((left + up) >> 1); break;
        case 4: value = raw + paeth(left, up, upLeft); break;
        default: throw new Error(`Bad PNG filter type ${type}`);
      }
      out[dst + i] = value & 0xff;
    }
  }
  return out;
}

export function decodeFlateImage(stream, info) {
  const raw = decodePDFRawStream(stream).decode();
  const parms = stream.dict.lookup(N('DecodeParms'));
  const parmsDict = parms instanceof PDFArray ? parms.lookup(0) : parms;
  const predictor = parmsDict?.lookup?.(N('Predictor'))?.asNumber?.() ?? 1;
  const samples = unpredict(raw, {
    predictor,
    colors: parmsDict?.lookup?.(N('Colors'))?.asNumber?.() ?? info.color.components,
    columns: parmsDict?.lookup?.(N('Columns'))?.asNumber?.() ?? info.width,
  });
  const pixels = info.width * info.height;
  if (samples.length < pixels * info.color.components) throw new Error('Image data is shorter than expected');
  const rgba = new Uint8ClampedArray(pixels * 4);
  for (let p = 0; p < pixels; p += 1) {
    if (info.color.components === 3) {
      rgba[p * 4] = samples[p * 3];
      rgba[p * 4 + 1] = samples[p * 3 + 1];
      rgba[p * 4 + 2] = samples[p * 3 + 2];
    } else {
      const gray = samples[p];
      rgba[p * 4] = gray;
      rgba[p * 4 + 1] = gray;
      rgba[p * 4 + 2] = gray;
    }
    rgba[p * 4 + 3] = 255;
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// Image recompression

function replacementImage(context, stream, info, size, jpegBytes) {
  const dict = stream.dict.clone(context);
  dict.delete(N('DecodeParms'));
  dict.delete(N('Length'));
  dict.set(N('Filter'), N('DCTDecode'));
  dict.set(N('Width'), PDFNumber.of(size.width));
  dict.set(N('Height'), PDFNumber.of(size.height));
  dict.set(N('BitsPerComponent'), PDFNumber.of(8));
  // The browser encoder always writes 3-component JPEGs, so greyscale sources
  // are declared as RGB (pixel values are identical across the channels).
  if (!info.color.keep) dict.set(N('ColorSpace'), N('DeviceRGB'));
  return PDFRawStream.of(dict, jpegBytes);
}

/**
 * `codec` provides { decodeJpeg(bytes), fromPixels(rgba, w, h), encodeJpeg(image, w, h, quality), release(image) }.
 */
export async function recompressImages(doc, settings, codec, { onProgress = () => {} } = {}) {
  const { context } = doc;
  const placements = collectImagePlacements(doc);
  const stats = { images: 0, recompressed: 0, downsampled: 0, skipped: {}, failed: 0, savedBytes: 0 };
  const candidates = [];
  const largestPage = Math.max(...doc.getPages().map((page) => Math.max(...Object.values(page.getSize()))));

  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || object.dict.lookup(N('Subtype')) !== N('Image')) continue;
    stats.images += 1;
    const info = analyzeImage(context, object, settings);
    if (info.skip) {
      stats.skipped[info.skip] = (stats.skipped[info.skip] ?? 0) + 1;
      continue;
    }
    candidates.push({ ref, object, info });
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const { ref, object, info } = candidates[index];
    onProgress({ phase: 'process', label: `Optimizing image ${index + 1} of ${candidates.length}`, done: index, total: candidates.length });
    const size = targetDimensions(info.width, info.height, placements.get(ref) ?? largestPage, settings.maxPpi);
    let image;
    try {
      image = info.kind === 'jpeg'
        ? await codec.decodeJpeg(object.contents)
        : await codec.fromPixels(decodeFlateImage(object, info), info.width, info.height);
      const jpeg = await codec.encodeJpeg(image, size.width, size.height, settings.quality);
      if (jpeg.length < object.contents.length * MIN_SAVING_RATIO) {
        stats.savedBytes += object.contents.length - jpeg.length;
        context.assign(ref, replacementImage(context, object, info, size, jpeg));
        stats.recompressed += 1;
        if (size.scaled) stats.downsampled += 1;
      } else {
        stats.skipped['no-gain'] = (stats.skipped['no-gain'] ?? 0) + 1;
      }
    } catch (error) {
      // An image the browser can't decode is left exactly as it was.
      stats.failed += 1;
      console.warn('Foldr: image left unchanged:', error?.message);
    } finally {
      if (image) codec.release?.(image);
    }
  }
  if (candidates.length) onProgress({ phase: 'process', label: 'Optimizing images', done: candidates.length, total: candidates.length });
  return stats;
}

// ---------------------------------------------------------------------------

export async function compressDocument(doc, { mode, codec, onProgress = () => {} }) {
  const settings = COMPRESSION_MODES[mode];
  if (!settings) throw new RangeError(`Unknown compression mode ${mode}`);
  const pageSizes = doc.getPages().map((page) => page.getSize());
  const stats = { mode, images: null };

  if (settings.lossy) {
    if (!codec) throw new Error('Image re-encoding is not available in this browser.');
    stats.images = await recompressImages(doc, settings, codec, { onProgress });
  }
  onProgress({ phase: 'process', label: 'Removing unused and duplicate data' });
  stats.removedObjects = pruneUnreachableObjects(doc.context);
  stats.mergedDuplicates = await deduplicateStreams(doc.context);
  stats.removedObjects += pruneUnreachableObjects(doc.context);
  onProgress({ phase: 'process', label: 'Compressing uncompressed data' });
  stats.compressedStreams = await compressPlainStreams(doc.context);

  stampModified(doc);
  onProgress({ phase: 'write', label: 'Writing the optimized PDF' });
  const bytes = await savePdf(doc);
  onProgress({ phase: 'verify', label: 'Checking the result' });
  await verifyOutput(bytes, { pageCount: pageSizes.length, pageSizes });
  return { bytes, pageCount: pageSizes.length, stats };
}
