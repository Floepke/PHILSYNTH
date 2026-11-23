// The v2 ZIP profile uses stored entries. PNG carries its own compression.
export const MAX_PROJECT_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const validPath = (path) => /^[a-zA-Z0-9._/-]+$/.test(path) && path.split('/').every((part) => part && part !== '.' && part !== '..');

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n;
});
export function crc32Update(crc, bytes) {
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
  return crc;
}
export function crc32(bytes) {
  return (crc32Update(-1, bytes) ^ -1) >>> 0;
}

export const isProjectZip = (bytes) => bytes.length >= 4 && view(bytes).getUint32(0, true) === LOCAL;

// ZIP stores local time with two-second precision and years from 1980 to 2107.
export function zipTimestamp(date = new Date()) {
  const year = date.getFullYear();
  if (!Number.isInteger(year) || year < 1980 || year > 2107) throw new Error('Current date is outside the ZIP timestamp range');
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  };
}

export function writeZip(entries) {
  if (!entries.size || entries.size > MAX_ENTRIES) throw new Error('Invalid project archive entry count');
  const timestamp = zipTimestamp();
  const files = [], index = [];
  let offset = 0, indexSize = 0;
  for (const [path, bytes] of entries) {
    if (!validPath(path) || path.length > 255) throw new Error('Invalid project archive path');
    const name = encoder.encode(path);
    const local = new Uint8Array(30 + name.length);
    const central = new Uint8Array(46 + name.length);
    if (offset + indexSize + local.length + central.length + bytes.length + 22 > MAX_PROJECT_BYTES) {
      throw new Error('Project file is too large');
    }
    const l = view(local), c = view(central);
    l.setUint32(0, LOCAL, true);
    l.setUint16(4, 20, true);
    l.setUint16(10, timestamp.time, true);
    l.setUint16(12, timestamp.date, true);
    l.setUint32(14, crc32(bytes), true);
    l.setUint32(18, bytes.length, true);
    l.setUint32(22, bytes.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    c.setUint32(0, CENTRAL, true);
    c.setUint16(4, 20, true);
    central.set(local.subarray(4, 30), 6);
    c.setUint32(42, offset, true);
    central.set(name, 46);
    files.push(local, bytes);
    index.push(central);
    offset += local.length + bytes.length;
    indexSize += central.length;
  }
  const end = new Uint8Array(22), e = view(end);
  e.setUint32(0, END, true);
  e.setUint16(8, entries.size, true);
  e.setUint16(10, entries.size, true);
  e.setUint32(12, indexSize, true);
  e.setUint32(16, offset, true);
  const zip = new Uint8Array(offset + indexSize + end.length);
  let at = 0;
  for (const part of [...files, ...index, end]) {
    zip.set(part, at);
    at += part.length;
  }
  return zip;
}

export function readZip(bytes) {
  const fail = () => { throw new Error('Corrupt or unsupported PHILSYNTH ZIP archive'); };
  if (bytes.length < 22 || bytes.length > MAX_PROJECT_BYTES || !isProjectZip(bytes)) fail();
  const v = view(bytes);
  const u16 = (at) => v.getUint16(at, true), u32 = (at) => v.getUint32(at, true);
  const end = bytes.length - 22;
  if (u32(end) !== END || u32(end + 4) || u16(end + 20)) fail();
  const count = u16(end + 10), start = u32(end + 16);
  if (!count || count > MAX_ENTRIES || u16(end + 8) !== count || start + u32(end + 12) !== end) fail();
  const entries = new Map(), ranges = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || u32(at) !== CENTRAL || (u16(at + 8) & ~0x800) || u16(at + 10) || u16(at + 34)) fail();
    const size = u32(at + 24), crc = u32(at + 16), n = u16(at + 28);
    const local = u32(at + 42), next = at + 46 + n + u16(at + 30) + u16(at + 32);
    if (!n || n > 255 || next > end || u32(at + 20) !== size || local + 30 + n > start) fail();
    const body = local + 30 + n + u16(local + 28);
    if (body + size > start || u32(local) !== LOCAL || u16(local + 6) !== u16(at + 8) ||
        u16(local + 8) || u32(local + 14) !== crc || u32(local + 18) !== size ||
        u32(local + 22) !== size || u16(local + 26) !== n) fail();
    const name = bytes.subarray(at + 46, at + 46 + n);
    const path = decoder.decode(name);
    if (!validPath(path) || entries.has(path) || name.some((b, j) => bytes[local + 30 + j] !== b)) fail();
    entries.set(path, { bytes: bytes.subarray(body, body + size), crc });
    ranges.push([local, body + size]);
    at = next;
  }
  // Verify ranges before checksumming so aliased entries cannot multiply the input size.
  let nextLocal = 0;
  for (const [local, endLocal] of ranges.sort((a, b) => a[0] - b[0])) {
    if (local !== nextLocal) fail();
    nextLocal = endLocal;
  }
  if (at !== end || nextLocal !== start) fail();
  return new Map([...entries].map(([path, entry]) => {
    if (crc32(entry.bytes) !== entry.crc) throw new Error(`Corrupt project entry: ${path}`);
    return [path, entry.bytes];
  }));
}
