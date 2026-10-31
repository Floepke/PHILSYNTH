// Sample pool (main thread): audio loaded into SAMPLER / WAVETABLE modules.
// Module state only names a sample ({ sampleId, name, ... }), so undo snapshots, copies and Patch
// instances stay small; the audio itself lives here, keyed by a hash of its content (the same file
// loaded twice is stored once). Audio is kept as 16-bit (what is saved is what plays).
// Saved files (autosave, .mds projects, .synth modules) carry the samples they use under
// `samples: { id: { rate, channels, length, data } }` (data = base64 of the planar Int16 audio);
// withSamples() adds them, importSamples() puts them back into the pool before the modules load.
//
// File formats (decodeAudioFile):
//   .wav   PCM 8/16/24/32-bit or float 32/64, mono or multichannel (WAVE_FORMAT_EXTENSIBLE too).
//          Wavetable metadata: Serum's 'clm ' chunk ("<!>2048 ...": samples per frame) and Surge's
//          'srge' chunk (version, frame size) give the frame size.
//   .wt    Surge wavetable ('vawt' header: frame size, frame count, float32 or int16 data).
//   other  anything the browser decodes (mp3, ogg, flac, aiff, ...) through decodeAudioData.
export const MAX_SECONDS = 60; // longer samples are cut (keeps project files and memory sane)
export const MAX_TABLE = 256 * 4096; // samples of a wavetable (256 frames of 4096)

const pool = new Map(); // id -> { rate, channels: Float32Array[], length, b64? }
const listeners = new Set();

export const getSample = (id) => (id ? pool.get(id) ?? null : null);
// fn(id) when a sample arrives in the pool (e.g. a module waiting for its sample after a load)
export function onSample(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function toInt16(channels, length) {
  const out = new Int16Array(channels.length * length);
  channels.forEach((c, ch) => {
    for (let i = 0; i < length; i++) {
      const v = Math.max(-1, Math.min(1, c[i] || 0));
      out[ch * length + i] = Math.round(v * 32767);
    }
  });
  return out;
}

function fromInt16(pcm, count, length) {
  return Array.from({ length: count }, (_, ch) => {
    const c = new Float32Array(length);
    for (let i = 0; i < length; i++) c[i] = pcm[ch * length + i] / 32767;
    return c;
  });
}

function hash(pcm, rate) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9 ^ rate;
  for (let i = 0; i < pcm.length; i++) {
    a = Math.imul(a ^ (pcm[i] & 0xffff), 0x01000193);
    b = Math.imul(b ^ (pcm[i] & 0xffff), 0x85ebca6b) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// Puts audio into the pool; returns its id. channels: Float32Array[] (1 or 2 are used).
export function addSample({ rate, channels }) {
  const chs = channels.slice(0, 2);
  const length = Math.min(...chs.map((c) => c.length));
  if (!(rate > 0) || !chs.length || !(length > 0)) throw new Error('the file has no audio');
  const pcm = toInt16(chs, length);
  const id = `${chs.length}x${length}@${Math.round(rate)}-${hash(pcm, Math.round(rate))}`;
  if (!pool.has(id)) {
    pool.set(id, { rate, channels: fromInt16(pcm, chs.length, length), length, pcm });
    listeners.forEach((fn) => fn(id));
  }
  return id;
}

function sampleIds(data, ids = new Set()) {
  if (Array.isArray(data)) data.forEach((d) => sampleIds(d, ids));
  else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (k === 'sampleId' && typeof v === 'string') ids.add(v);
      else if (v && typeof v === 'object') sampleIds(v, ids);
    }
  }
  return ids;
}

// The samples used anywhere in `data` (a project, patch or copyMany result), ready to save.
export function exportSamples(data) {
  const out = {};
  for (const id of sampleIds(data)) {
    const s = pool.get(id);
    if (!s) continue;
    s.b64 ??= toBase64(new Uint8Array(s.pcm.buffer, s.pcm.byteOffset, s.pcm.byteLength));
    out[id] = { rate: s.rate, channels: s.channels.length, length: s.length, data: s.b64 };
  }
  return out;
}

export const withSamples = (data) => {
  const samples = exportSamples(data);
  return Object.keys(samples).length ? { ...data, samples } : data;
};

// Samples of a loaded file into the pool (bad entries are skipped: those modules stay silent).
export function importSamples(samples) {
  if (!samples || typeof samples !== 'object') return;
  for (const [id, s] of Object.entries(samples)) {
    if (pool.has(id)) continue;
    try {
      const count = s.channels | 0;
      const length = s.length | 0;
      const bytes = fromBase64(s.data);
      if (!(s.rate > 0) || count < 1 || count > 2 || length < 1 || bytes.length !== count * length * 2) continue;
      const pcm = new Int16Array(bytes.buffer, 0, count * length);
      pool.set(id, { rate: s.rate, channels: fromInt16(pcm, count, length), length, pcm, b64: s.data });
      listeners.forEach((fn) => fn(id));
    } catch { /* corrupt entry */ }
  }
}

// ---- decoding ----
const str = (v, at, n) => String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset + at, n));

// RIFF WAVE -> { rate, channels, frame } or null when this parser can't read it
export function parseWav(buffer) {
  const v = new DataView(buffer);
  if (v.byteLength < 12 || str(v, 0, 4) !== 'RIFF' || str(v, 8, 4) !== 'WAVE') return null;
  let fmt = null;
  let data = null;
  let frame = 0;
  for (let at = 12; at + 8 <= v.byteLength;) {
    const id = str(v, at, 4);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    const end = Math.min(v.byteLength, body + size);
    if (id === 'fmt ' && size >= 16) {
      let format = v.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true); // EXTENSIBLE sub-format
      fmt = { format, channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') data = { at: body, size: end - body };
    else if (id === 'clm ') {
      const m = /<!>\s*(\d+)/.exec(str(v, body, end - body));
      if (m) frame = +m[1];
    } else if (id === 'srge' && size >= 8) frame = v.getUint32(body + 4, true);
    at = body + size + (size & 1);
  }
  if (!fmt || !data || !fmt.channels) return null;
  const { format, bits } = fmt;
  const bytes = bits / 8;
  const reader =
    format === 1 && bits === 8 ? (o) => (v.getUint8(o) - 128) / 128
    : format === 1 && bits === 16 ? (o) => v.getInt16(o, true) / 32768
    : format === 1 && bits === 24 ? (o) => ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608)
    : format === 1 && bits === 32 ? (o) => v.getInt32(o, true) / 2147483648
    : format === 3 && bits === 32 ? (o) => v.getFloat32(o, true)
    : format === 3 && bits === 64 ? (o) => v.getFloat64(o, true)
    : null;
  if (!reader) return null;
  const stride = bytes * fmt.channels;
  const length = Math.floor(data.size / stride);
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(length));
  for (let i = 0; i < length; i++) {
    const o = data.at + i * stride;
    for (let c = 0; c < fmt.channels; c++) channels[c][i] = reader(o + c * bytes);
  }
  return { rate: fmt.rate, channels, frame };
}

// Surge .wt -> { rate, channels: [data], frame }
export function parseSurgeWt(buffer) {
  const v = new DataView(buffer);
  if (v.byteLength < 12 || str(v, 0, 4) !== 'vawt') return null;
  const size = v.getUint32(4, true);
  const count = v.getUint16(8, true);
  const flags = v.getUint16(10, true);
  const int16 = !!(flags & 4);
  const n = size * count;
  if (!size || !count || 12 + n * (int16 ? 2 : 4) > v.byteLength) throw new Error('broken .wt file');
  const data = new Float32Array(n);
  const scale = flags & 8 ? 1 / 32768 : 1 / 16384; // int16 tables peak at 2^14 unless "full range"
  for (let i = 0; i < n; i++) data[i] = int16 ? v.getInt16(12 + i * 2, true) * scale : v.getFloat32(12 + i * 4, true);
  return { rate: 48000, channels: [data], frame: size };
}

// Samples per frame of a wavetable without metadata: a short file is one single-cycle wave (e.g.
// the AKWF waves of 600 samples), else the largest standard size that divides the length.
export function guessFrame(length) {
  if (length <= 4096) return length;
  for (const s of [2048, 4096, 1024, 512, 256]) if (length % s === 0) return s;
  return 2048;
}

// ArrayBuffer of a file -> { rate, channels: Float32Array[], frame (0 = unknown) }
export async function decodeAudioFile(buffer) {
  const parsed = parseSurgeWt(buffer) ?? parseWav(buffer);
  if (parsed) return parsed;
  const Ctx = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('unsupported audio format');
  const ctx = new Ctx(1, 1, 48000);
  let audio;
  try {
    audio = await ctx.decodeAudioData(buffer.slice(0));
  } catch {
    throw new Error('not an audio file this browser can read');
  }
  return { rate: audio.sampleRate, channels: Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c)), frame: 0 };
}

// Sampler: up to 2 channels, at most MAX_SECONDS.
export function sampleFromFile(decoded) {
  const max = Math.round(decoded.rate * MAX_SECONDS);
  const channels = decoded.channels.slice(0, 2).map((c) => c.subarray(0, max));
  return { rate: decoded.rate, channels, cut: decoded.channels[0].length > max };
}

// Wavetable: mono (channels averaged), at most MAX_TABLE samples, with its frame size.
export function tableFromFile(decoded) {
  const chs = decoded.channels;
  const len = Math.min(chs[0].length, MAX_TABLE);
  if (len < 8) throw new Error('the file is too short for a wavetable');
  const mono = new Float32Array(len);
  for (const c of chs) for (let i = 0; i < len; i++) mono[i] += c[i] / chs.length;
  const frame = decoded.frame > 0 && decoded.frame <= len ? decoded.frame : guessFrame(len);
  return { rate: decoded.rate, channels: [mono], frame, cut: chs[0].length > MAX_TABLE };
}
