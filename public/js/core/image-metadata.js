// Remove Metadata: strips EXIF (including GPS location), XMP, IPTC, comments
// and other hidden data from JPEG, PNG and WebP files by rewriting their
// containers. The compressed image data is copied byte for byte, so the
// picture is exactly the same; nothing is decoded or re-encoded.
//
// Kept: what's needed to display the image as before, i.e. colour profiles,
// transparency, animation, pixel density and the EXIF orientation. A photo
// taken in portrait is often stored sideways with an orientation tag, so that
// one tag is written back on its own, without any other EXIF.

import { crc32 } from './zip.js';
import { imageTypeOf } from './image-compress.js';

export class MetadataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MetadataError';
    this.code = code;
  }
}

const damaged = () => new MetadataError('damaged', 'This image seems to be damaged, so its metadata couldn’t be removed safely.');

export const METADATA_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

export function canStripMetadata(file) {
  return METADATA_TYPES.includes(imageTypeOf(file));
}

/**
 * What was removed, in the order shown to the user. `location` is reported
 * on top of `exif` when the EXIF held GPS coordinates.
 */
export const METADATA_LABELS = Object.freeze({
  location: 'GPS location',
  exif: 'EXIF',
  xmp: 'XMP',
  iptc: 'IPTC',
  text: 'Text and comments',
  other: 'Other data',
});

const ascii = (bytes, start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
const startsWith = (bytes, text) => bytes.length >= text.length && ascii(bytes, 0, text.length) === text;

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---- EXIF ----------------------------------------------------------------------

const ORIENTATION_TAG = 0x0112;
const GPS_IFD_TAG = 0x8825;

/**
 * Reads the orientation (1–8, 1 = upright) and whether there's a GPS block
 * from a TIFF-structured EXIF payload. Anything unreadable counts as upright
 * with no GPS; the payload is dropped either way.
 */
export function readExif(tiff) {
  const result = { orientation: 1, gps: false };
  if (tiff.length < 8) return result;
  const order = ascii(tiff, 0, 2);
  if (order !== 'II' && order !== 'MM') return result;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = order === 'II';
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return result;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    const tag = view.getUint16(entry, little);
    if (tag === ORIENTATION_TAG) {
      const value = view.getUint16(entry + 8, little);
      if (value >= 1 && value <= 8) result.orientation = value;
    } else if (tag === GPS_IFD_TAG) {
      result.gps = true;
    }
  }
  return result;
}

/** A TIFF structure holding only the orientation tag. */
export function orientationOnlyExif(orientation) {
  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // "MM", 42, first IFD at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, orientation >> 8, orientation & 0xff, 0x00, 0x00, // Orientation, SHORT ×1
    0x00, 0x00, 0x00, 0x00, // no further IFDs
  ]);
}

/** Notes what an EXIF payload held and returns the orientation-only replacement, or null if none is needed. */
function replaceExif(tiff, removed) {
  const { orientation, gps } = readExif(tiff);
  const replacement = orientation === 1 ? null : orientationOnlyExif(orientation);
  // An image this tool already cleaned isn't reported as having EXIF again.
  const unchanged = replacement && replacement.length === tiff.length && replacement.every((byte, index) => byte === tiff[index]);
  if (!unchanged) removed.add('exif');
  if (gps) removed.add('location');
  return replacement;
}

// ---- JPEG ----------------------------------------------------------------------

const EXIF_HEADER = 'Exif\0\0';
const XMP_HEADERS = ['http://ns.adobe.com/xap/1.0/\0', 'http://ns.adobe.com/xmp/extension/\0'];

const isRestart = (marker) => marker >= 0xd0 && marker <= 0xd7;

/** 'keep', or the kind of metadata an APPn/COM segment holds. */
function jpegSegmentKind(marker, payload) {
  if (marker === 0xfe) return 'text';
  if (marker < 0xe0 || marker > 0xef) return 'keep';
  if (marker === 0xe0 && startsWith(payload, 'JFIF\0')) return 'keep';
  if (marker === 0xe1 && startsWith(payload, EXIF_HEADER)) return 'exif';
  if (marker === 0xe1 && XMP_HEADERS.some((header) => startsWith(payload, header))) return 'xmp';
  // Colour profile, and Adobe's colour transform flag (needed to show CMYK/YCCK JPEGs correctly).
  if (marker === 0xe2 && startsWith(payload, 'ICC_PROFILE\0')) return 'keep';
  if (marker === 0xee && startsWith(payload, 'Adobe')) return 'keep';
  if (marker === 0xed && startsWith(payload, 'Photoshop 3.0\0')) return 'iptc';
  return 'other';
}

function stripJpeg(bytes, removed) {
  const parts = [bytes.subarray(0, 2)];
  let exifWritten = false;
  let pos = 2;
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) throw damaged();
    const start = pos;
    while (bytes[pos] === 0xff) pos += 1; // fill bytes
    const marker = bytes[pos];
    pos += 1;
    if (marker === undefined) break;
    if (marker === 0xd9) {
      parts.push(new Uint8Array([0xff, 0xd9]));
      // Anything after the end of the image: extra MPF images (each with its
      // own EXIF), motion photo videos, vendor trailers.
      if (pos < bytes.length) removed.add('other');
      break;
    }
    if (isRestart(marker) || marker === 0x01) {
      parts.push(bytes.subarray(start, pos));
      continue;
    }
    if (pos + 2 > bytes.length) throw damaged();
    const end = pos + ((bytes[pos] << 8) | bytes[pos + 1]);
    if (end < pos + 2 || end > bytes.length) throw damaged();
    const payload = bytes.subarray(pos + 2, end);
    const kind = jpegSegmentKind(marker, payload);
    pos = end;
    if (kind === 'keep') {
      parts.push(bytes.subarray(start, end));
    } else if (kind === 'exif') {
      const tiff = replaceExif(payload.subarray(EXIF_HEADER.length), removed);
      if (tiff && !exifWritten) {
        const length = 2 + EXIF_HEADER.length + tiff.length;
        parts.push(new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff]), new TextEncoder().encode(EXIF_HEADER), tiff);
        exifWritten = true;
      }
    } else {
      removed.add(kind);
    }
    if (marker === 0xda) {
      // Entropy-coded scan data runs until the next marker that isn't a
      // stuffed 0xFF00 or a restart marker.
      let scan = pos;
      while (scan < bytes.length - 1 && !(bytes[scan] === 0xff && bytes[scan + 1] !== 0 && !isRestart(bytes[scan + 1]))) scan += 1;
      if (scan >= bytes.length - 1) scan = bytes.length;
      parts.push(bytes.subarray(pos, scan));
      pos = scan;
    }
  }
  return concat(parts);
}

// ---- PNG -----------------------------------------------------------------------

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

// Chunks that affect how the image looks (plus APNG animation); everything
// else is dropped.
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI',
  'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT',
]);

async function pngChunk(type, data) {
  const body = concat([new TextEncoder().encode(type), data]);
  const header = new Uint8Array(4);
  const trailer = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, data.length);
  new DataView(trailer.buffer).setUint32(0, await crc32(body));
  return concat([header, body, trailer]);
}

async function stripPng(bytes, removed) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)];
  let pos = 8;
  for (;;) {
    if (pos + 12 > bytes.length) throw damaged();
    const end = pos + 12 + view.getUint32(pos);
    if (end > bytes.length) throw damaged();
    const type = ascii(bytes, pos + 4, 4);
    const data = bytes.subarray(pos + 8, end - 4);
    if (PNG_KEEP.has(type)) {
      parts.push(bytes.subarray(pos, end));
    } else if (type === 'eXIf') {
      const tiff = replaceExif(data, removed);
      if (tiff) parts.push(await pngChunk('eXIf', tiff));
    } else if (type === 'iTXt' && startsWith(data, 'XML:com.adobe.xmp\0')) {
      removed.add('xmp');
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      removed.add('text');
    } else {
      removed.add('other');
    }
    pos = end;
    if (type === 'IEND') break;
  }
  if (pos < bytes.length) removed.add('other');
  return concat(parts);
}

// ---- WebP ----------------------------------------------------------------------

const WEBP_KEEP = new Set(['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function stripWebp(bytes, removed) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [];
  let vp8x = null;
  let hasExif = false;
  let pos = 12;
  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) throw damaged();
    const type = ascii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const end = pos + 8 + size + (size & 1);
    if (pos + 8 + size > bytes.length) throw damaged();
    const chunk = bytes.subarray(pos, Math.min(end, bytes.length));
    const data = bytes.subarray(pos + 8, pos + 8 + size);
    if (type === 'VP8X') {
      vp8x = chunk.slice();
      parts.push(vp8x);
    } else if (WEBP_KEEP.has(type)) {
      parts.push(chunk);
    } else if (type === 'EXIF') {
      // Some writers keep JPEG's "Exif\0\0" prefix here.
      const tiff = replaceExif(startsWith(data, EXIF_HEADER) ? data.subarray(EXIF_HEADER.length) : data, removed);
      if (tiff && !hasExif) {
        const header = new Uint8Array(8);
        header.set(new TextEncoder().encode('EXIF'));
        new DataView(header.buffer).setUint32(4, tiff.length, true);
        parts.push(header, tiff);
        hasExif = true;
      }
    } else if (type === 'XMP ') {
      removed.add('xmp');
    } else {
      removed.add('other');
    }
    pos = end;
  }
  if (vp8x && vp8x.length > 8) vp8x[8] = (vp8x[8] & ~(VP8X_EXIF | VP8X_XMP)) | (hasExif ? VP8X_EXIF : 0);
  const header = bytes.slice(0, 12);
  const body = concat(parts);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return concat([header, body]);
}

// ---- Entry point -----------------------------------------------------------------

function formatOf(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Returns the image without its metadata, its type (from the contents, not
 * the name) and what was removed (keys of METADATA_LABELS, in that order).
 * When nothing was removed, `bytes` is the input unchanged.
 */
export async function stripMetadata(bytes) {
  const type = formatOf(bytes);
  if (!type) throw new MetadataError('unsupported', 'Metadata can only be removed from JPEG, PNG and WebP images.');
  const removed = new Set();
  let result;
  if (type === 'image/jpeg') result = stripJpeg(bytes, removed);
  else if (type === 'image/png') result = await stripPng(bytes, removed);
  else result = stripWebp(bytes, removed);
  const order = Object.keys(METADATA_LABELS);
  return {
    type,
    bytes: removed.size ? result : bytes,
    removed: order.filter((key) => removed.has(key)),
  };
}
