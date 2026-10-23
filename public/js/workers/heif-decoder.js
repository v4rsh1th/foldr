// HEIC/HEIF decoding for browsers that can't open these photos themselves
// (iPhones save them by default; only Safari decodes them natively). Used by
// the image workers as a fallback after createImageBitmap fails. libheif
// (about 2 MB) is loaded the first time it's needed, then kept for the
// worker's lifetime.

import { LIBHEIF_VERSION } from '../config.js';

// Major brands of HEIF files (ISO/IEC 23008-12). AVIF uses its own brand
// and is decoded natively by current browsers.
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

let library = null;
let decoder = null;

/** True if the file starts with an ISO-BMFF "ftyp" box naming a HEIF brand. */
export async function isHeif(blob) {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const text = String.fromCharCode(...head);
  return text.slice(4, 8) === 'ftyp' && HEIF_BRANDS.has(text.slice(8, 12));
}

/** Decodes the primary image of a HEIF file into an ImageBitmap, upright. */
export async function decodeHeif(blob) {
  if (!library) {
    const { default: create } = await import(`../../vendor/libheif@${LIBHEIF_VERSION}/libheif-bundle.mjs`);
    library = create();
    decoder = new library.HeifDecoder();
  }
  const images = decoder.decode(new Uint8Array(await blob.arrayBuffer()));
  try {
    if (!images.length) throw new Error('No image in HEIF file');
    const image = images[0];
    const pixels = new ImageData(image.get_width(), image.get_height());
    // libheif applies the file's rotation and mirroring while decoding.
    await new Promise((resolve, reject) => {
      image.display(pixels, (result) => (result ? resolve() : reject(new Error('HEIF decoding failed'))));
    });
    return await createImageBitmap(pixels);
  } finally {
    images.forEach((image) => image.free());
    // Release the file's bytes now rather than on the next decode.
    library.heif_context_free(decoder.decoder);
    decoder.decoder = null;
  }
}

/**
 * Decodes any photo the browser can open, falling back to libheif for
 * HEIC/HEIF. Rejects if neither can.
 */
export async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob);
  } catch (error) {
    if (!(await isHeif(blob))) throw error;
    return decodeHeif(blob);
  }
}
