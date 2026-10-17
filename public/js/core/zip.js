// Minimal ZIP writer using the "stored" method (no compression). PDFs are
// already compressed internally, so deflating them again saves little and
// would cost a dependency plus CPU time. The archive is assembled as a Blob
// from parts, so file data is never copied into one large buffer.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const CHUNK = 1 << 20;
const MAX_ZIP32 = 0xffffffff;

export class ZipTooLargeError extends Error {
  constructor() {
    super('These files are too large to combine into one ZIP. Download them individually instead.');
    this.name = 'ZipTooLargeError';
  }
}

/** CRC-32 of a Uint8Array, yielding to the event loop between 1 MB chunks. */
export async function crc32(bytes, { yieldEvery = CHUNK } = {}) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < bytes.length; offset += yieldEvery) {
    const end = Math.min(offset + yieldEvery, bytes.length);
    for (let i = offset; i < end; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    if (end < bytes.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Builds a ZIP Blob. `entries` is [{ name, bytes: Uint8Array }]; names must be unique.
 */
export async function createZip(entries, { date = new Date() } = {}) {
  const encoder = new TextEncoder();
  const { time, date: day } = dosDateTime(date);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const size = entry.bytes.length;
    const crc = await crc32(entry.bytes);
    if (size > MAX_ZIP32 || offset + 30 + nameBytes.length + size > MAX_ZIP32) throw new ZipTooLargeError();

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, nameBytes, entry.bytes);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true); // version made by
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, time, true);
    header.setUint16(14, day, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, size, true);
    header.setUint32(24, size, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint32(42, offset, true);
    central.push(header.buffer, nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  if (entries.length > 0xffff || offset + centralSize > MAX_ZIP32) throw new ZipTooLargeError();
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
