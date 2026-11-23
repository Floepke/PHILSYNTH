import { crc32Update, zipTimestamp } from './projectzip.js';

const MAX_ENTRIES = 10000;
const MAX_CHUNK = 1024 * 1024;
const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, DESCRIPTOR = 0x08074b50;
const ZIP64_END = 0x06064b50, ZIP64_LOCATOR = 0x07064b50, END = 0x06054b50;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const validPath = (path) => /^[a-zA-Z0-9._/-]+$/.test(path) && path.split('/').every((part) => part && part !== '.' && part !== '..');

async function streamBlob(blob, write, signal) {
  let crc = -1, actual = 0;
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid project archive data');
      for (let at = 0; at < value.length; at += MAX_CHUNK) {
        const part = value.subarray(at, Math.min(value.length, at + MAX_CHUNK));
        actual += part.length;
        if (actual > blob.size) throw new Error('Project archive entry changed while reading');
        crc = crc32Update(crc, part);
        signal?.throwIfAborted();
        await write(part);
      }
    }
  } catch (error) {
    try { await reader.cancel(error); }
    catch (cancelError) { throw new AggregateError([error, cancelError], 'Project archive read and cancellation failed'); }
    throw error;
  } finally { reader.releaseLock(); }
  if (actual !== blob.size) throw new Error('Project archive entry changed while reading');
  return (crc ^ -1) >>> 0;
}

// Stored ZIP64 entries; media is streamed and only the small directory stays in memory.
export async function writeZipStream(entries, write, { signal } = {}) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_ENTRIES) throw new Error('Invalid project archive entry count');
  if (typeof write !== 'function') throw new Error('Invalid project archive writer');
  const paths = new Set();
  for (const { path, blob } of entries) {
    if (typeof path !== 'string' || path.length > 255 || !validPath(path) || paths.has(path)) throw new Error('Invalid project archive path');
    if (!(blob instanceof Blob) || !Number.isSafeInteger(blob.size)) throw new Error('Invalid project archive entry');
    paths.add(path);
  }
  const timestamp = zipTimestamp();
  const central = [];
  let position = 0n;
  const send = async (bytes) => {
    signal?.throwIfAborted();
    if (position + BigInt(bytes.length) > 0xffffffffffffffffn) throw new Error('Project archive exceeds ZIP64 size limit');
    await write(bytes);
    position += BigInt(bytes.length);
  };
  for (const { path, blob } of entries) {
    const name = encoder.encode(path);
    const size = BigInt(blob.size);
    const offset = position;
    const local = new Uint8Array(30 + name.length + 20), l = view(local);
    l.setUint32(0, LOCAL, true);
    l.setUint16(4, 45, true);
    l.setUint16(6, 8, true);
    l.setUint16(10, timestamp.time, true);
    l.setUint16(12, timestamp.date, true);
    l.setUint32(18, 0xffffffff, true);
    l.setUint32(22, 0xffffffff, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 20, true);
    local.set(name, 30);
    const extra = 30 + name.length;
    l.setUint16(extra, 1, true);
    l.setUint16(extra + 2, 16, true);
    l.setBigUint64(extra + 4, size, true);
    l.setBigUint64(extra + 12, size, true);
    await send(local);

    const crc = await streamBlob(blob, send, signal);
    const descriptor = new Uint8Array(24), d = view(descriptor);
    d.setUint32(0, DESCRIPTOR, true);
    d.setUint32(4, crc, true);
    d.setBigUint64(8, size, true);
    d.setBigUint64(16, size, true);
    await send(descriptor);

    const item = new Uint8Array(46 + name.length + 28), c = view(item);
    c.setUint32(0, CENTRAL, true);
    c.setUint16(4, 45, true);
    c.setUint16(6, 45, true);
    c.setUint16(8, 8, true);
    c.setUint16(12, timestamp.time, true);
    c.setUint16(14, timestamp.date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, 0xffffffff, true);
    c.setUint32(24, 0xffffffff, true);
    c.setUint16(28, name.length, true);
    c.setUint16(30, 28, true);
    c.setUint32(42, 0xffffffff, true);
    item.set(name, 46);
    const at = 46 + name.length;
    c.setUint16(at, 1, true);
    c.setUint16(at + 2, 24, true);
    c.setBigUint64(at + 4, size, true);
    c.setBigUint64(at + 12, size, true);
    c.setBigUint64(at + 20, offset, true);
    central.push(item);
  }
  const directoryOffset = position;
  for (const item of central) await send(item);
  const directorySize = position - directoryOffset;
  const zip64Offset = position;
  const zip64 = new Uint8Array(56), z = view(zip64);
  z.setUint32(0, ZIP64_END, true);
  z.setBigUint64(4, 44n, true);
  z.setUint16(12, 45, true);
  z.setUint16(14, 45, true);
  z.setBigUint64(24, BigInt(entries.length), true);
  z.setBigUint64(32, BigInt(entries.length), true);
  z.setBigUint64(40, directorySize, true);
  z.setBigUint64(48, directoryOffset, true);
  await send(zip64);
  const locator = new Uint8Array(20), loc = view(locator);
  loc.setUint32(0, ZIP64_LOCATOR, true);
  loc.setBigUint64(8, zip64Offset, true);
  loc.setUint32(16, 1, true);
  await send(locator);
  const end = new Uint8Array(22), e = view(end);
  e.setUint32(0, END, true);
  e.setUint16(8, 0xffff, true);
  e.setUint16(10, 0xffff, true);
  e.setUint32(12, 0xffffffff, true);
  e.setUint32(16, 0xffffffff, true);
  await send(end);
}

// Index only the ZIP64 profile written above; validate each payload while copying it.
export async function readZipStream(file) {
  const fail = () => { throw new Error('Corrupt or unsupported PHILSYNTH ZIP64 archive'); };
  if (!(file instanceof Blob) || !Number.isSafeInteger(file.size) || file.size < 98) fail();
  const range = async (start, length) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > file.size) fail();
    return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  };
  const number = (value) => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    return Number(value);
  };
  const tail = view(await range(file.size - 98, 98));
  if (tail.getUint32(0, true) !== ZIP64_END || tail.getBigUint64(4, true) !== 44n ||
      tail.getUint16(14, true) !== 45 || tail.getUint32(16, true) || tail.getUint32(20, true) ||
      tail.getUint32(56, true) !== ZIP64_LOCATOR || tail.getUint32(60, true) ||
      tail.getBigUint64(64, true) !== BigInt(file.size - 98) || tail.getUint32(72, true) !== 1 ||
      tail.getUint32(76, true) !== END || tail.getUint32(80, true) ||
      tail.getUint16(84, true) !== 0xffff || tail.getUint16(86, true) !== 0xffff ||
      tail.getUint32(88, true) !== 0xffffffff || tail.getUint32(92, true) !== 0xffffffff ||
      tail.getUint16(96, true)) fail();
  const count = number(tail.getBigUint64(32, true));
  const directorySize = number(tail.getBigUint64(40, true));
  const directoryStart = number(tail.getBigUint64(48, true));
  if (!count || count > MAX_ENTRIES || tail.getBigUint64(24, true) !== BigInt(count) ||
      directorySize > count * (46 + 255 + 28) || directoryStart + directorySize !== file.size - 98) fail();
  const directory = await range(directoryStart, directorySize), v = view(directory);
  const entries = new Map();
  let at = 0, expectedLocal = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > directory.length || v.getUint32(at, true) !== CENTRAL ||
        v.getUint16(at + 6, true) !== 45 || v.getUint16(at + 8, true) !== 8 ||
        v.getUint16(at + 10, true) || v.getUint32(at + 20, true) !== 0xffffffff ||
        v.getUint32(at + 24, true) !== 0xffffffff || v.getUint16(at + 30, true) !== 28 ||
        v.getUint16(at + 32, true) || v.getUint16(at + 34, true) ||
        v.getUint32(at + 42, true) !== 0xffffffff) fail();
    const nameLength = v.getUint16(at + 28, true), extra = at + 46 + nameLength, next = extra + 28;
    if (!nameLength || nameLength > 255 || next > directory.length ||
        v.getUint16(extra, true) !== 1 || v.getUint16(extra + 2, true) !== 24) fail();
    const name = directory.subarray(at + 46, extra), path = decoder.decode(name);
    if (!validPath(path) || entries.has(path)) fail();
    const size = number(v.getBigUint64(extra + 4, true));
    const local = number(v.getBigUint64(extra + 20, true));
    const crc = v.getUint32(at + 16, true);
    if (v.getBigUint64(extra + 12, true) !== BigInt(size) || local !== expectedLocal) fail();
    const headerLength = 30 + nameLength + 20;
    if (local + headerLength + size + 24 > directoryStart) fail();
    const header = await range(local, headerLength), h = view(header);
    const hx = 30 + nameLength;
    if (h.getUint32(0, true) !== LOCAL || h.getUint16(4, true) !== 45 ||
        h.getUint16(6, true) !== 8 || h.getUint16(8, true) || h.getUint32(14, true) ||
        h.getUint32(18, true) !== 0xffffffff || h.getUint32(22, true) !== 0xffffffff ||
        h.getUint16(26, true) !== nameLength || h.getUint16(28, true) !== 20 ||
        name.some((b, j) => header[30 + j] !== b) ||
        h.getUint16(hx, true) !== 1 || h.getUint16(hx + 2, true) !== 16 ||
        h.getBigUint64(hx + 4, true) !== BigInt(size) || h.getBigUint64(hx + 12, true) !== BigInt(size)) fail();
    const body = local + headerLength, descriptor = view(await range(body + size, 24));
    if (descriptor.getUint32(0, true) !== DESCRIPTOR || descriptor.getUint32(4, true) !== crc ||
        descriptor.getBigUint64(8, true) !== BigInt(size) || descriptor.getBigUint64(16, true) !== BigInt(size)) fail();
    entries.set(path, { blob: file.slice(body, body + size), crc });
    expectedLocal = body + size + 24;
    at = next;
  }
  if (at !== directory.length || expectedLocal !== directoryStart) fail();
  return entries;
}

export async function copyZipEntry(entry, write, { signal } = {}) {
  if (!(entry?.blob instanceof Blob) || !Number.isInteger(entry.crc) || entry.crc < 0 ||
      entry.crc > 0xffffffff || typeof write !== 'function') throw new Error('Invalid project archive entry');
  const crc = await streamBlob(entry.blob, write, signal);
  if (crc !== entry.crc) throw new Error('Corrupt project archive entry');
}
