import { crc32 } from './projectzip.js';
import { MAX_IMAGE } from './samples.js';

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = (text) => new TextEncoder().encode(text);
const tag = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const badImage = () => new Error('Invalid project PNG');
const badAudio = () => new Error('Invalid project PCM WAV');

function pngChunk(type, bytes) {
  const chunk = new Uint8Array(bytes.length + 12), v = view(chunk);
  v.setUint32(0, bytes.length);
  chunk.set(ascii(type), 4);
  chunk.set(bytes, 8);
  v.setUint32(bytes.length + 8, crc32(chunk.subarray(4, bytes.length + 8)));
  return chunk;
}

export async function encodeProjectImage({ width, height, rgb }) {
  const header = new Uint8Array(13), v = view(header);
  v.setUint32(0, width);
  v.setUint32(4, height);
  header.set([8, 2], 8);
  const stride = width * 3, rows = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) rows.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const compressed = new Uint8Array(await new Response(
    new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer());
  return new Uint8Array(await new Blob([Uint8Array.from(pngSignature), pngChunk('IHDR', header),
    pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array())]).arrayBuffer());
}

export async function decodeProjectImage(bytes) {
  if (bytes.length < 57 || pngSignature.some((b, i) => bytes[i] !== b)) throw badImage();
  const v = view(bytes);
  const chunk = (at, type) => {
    if (at + 12 > bytes.length || tag(bytes, at + 4) !== type) throw badImage();
    const end = at + 8 + v.getUint32(at);
    if (end + 4 > bytes.length || crc32(bytes.subarray(at + 4, end)) !== v.getUint32(end)) throw badImage();
    return bytes.subarray(at + 8, end);
  };
  const h = chunk(8, 'IHDR');
  if (h.length !== 13 || h[8] !== 8 || h[9] !== 2 || h[10] || h[11] || h[12]) throw badImage();
  const width = view(h).getUint32(0), height = view(h).getUint32(4);
  if (!width || !height || width > MAX_IMAGE || height > MAX_IMAGE) throw badImage();
  const compressed = chunk(33, 'IDAT'), end = 45 + compressed.length;
  if (chunk(end, 'IEND').length || end + 12 !== bytes.length) throw badImage();
  const stride = width * 3, rows = new Uint8Array((stride + 1) * height);
  if (compressed.length > rows.length + 1024) throw badImage();
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  let at = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.length > rows.length) throw badImage();
      rows.set(value, at);
      at += value.length;
    }
  } finally { await reader.cancel(); }
  if (at !== rows.length) throw badImage();
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    if (rows[start]) throw badImage(); // the project profile writes only filter 0
    rgb.set(rows.subarray(start + 1, start + 1 + stride), y * stride);
  }
  return { kind: 'image', width, height, rgb };
}

export function encodeProjectAudio({ rate, channels, count = channels.length, length, pcm }) {
  const hz = Math.round(rate);
  if (!Number.isFinite(rate) || hz < 1 || hz * count * 2 > 0xffffffff) throw badAudio();
  const bytes = new Uint8Array(44 + pcm.byteLength), v = view(bytes);
  bytes.set(ascii('RIFF'), 0);
  bytes.set(ascii('WAVEfmt '), 8);
  bytes.set(ascii('data'), 36);
  v.setUint32(4, bytes.length - 8, true);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, count, true);
  v.setUint32(24, hz, true);
  v.setUint32(28, hz * count * 2, true);
  v.setUint16(32, count * 2, true);
  v.setUint16(34, 16, true);
  v.setUint32(40, pcm.byteLength, true);
  for (let i = 0, at = 44; i < length; i++) {
    for (let c = 0; c < count; c++, at += 2) v.setInt16(at, pcm[c * length + i], true);
  }
  return bytes;
}

export function decodeProjectAudio(bytes, rate) {
  const v = view(bytes);
  if (bytes.length < 46 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE' ||
      tag(bytes, 12) !== 'fmt ' || tag(bytes, 36) !== 'data' || v.getUint32(4, true) !== bytes.length - 8 ||
      v.getUint32(16, true) !== 16 || v.getUint16(20, true) !== 1 || v.getUint16(34, true) !== 16) throw badAudio();
  const count = v.getUint16(22, true), hz = v.getUint32(24, true), size = bytes.length - 44;
  if (!hz || !Number.isFinite(rate) || Math.round(rate) !== hz || ![1, 2].includes(count) ||
      v.getUint32(28, true) !== hz * count * 2 || v.getUint16(32, true) !== count * 2 ||
      v.getUint32(40, true) !== size || size % (count * 2)) throw badAudio();
  const length = size / (count * 2), pcm = new Int16Array(length * count);
  for (let i = 0, at = 44; i < length; i++) {
    for (let c = 0; c < count; c++, at += 2) pcm[c * length + i] = v.getInt16(at, true);
  }
  return { rate, count, length, pcm };
}
