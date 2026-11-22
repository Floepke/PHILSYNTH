// A recording writer for a FileSystemSyncAccessHandle, intended to run in a worker.
// The caller owns the handle and must supply a new, empty file.
const HEADER_SIZE = 44;
const MAX_DATA_BYTES = 0xffffffff - 36;
export const MAX_RECORDING_CHUNK_FRAMES = 65536;

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const tag = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));
const text = (bytes, at, value) => {
  for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
};

export function writeAll(file, bytes, at) {
  let written = 0;
  while (written < bytes.length) {
    const n = file.write(bytes.subarray(written), { at: at + written });
    if (!Number.isInteger(n) || n <= 0 || n > bytes.length - written) throw new Error('Could not write recording data');
    written += n;
  }
}

function header(rate, channels) {
  const bytes = new Uint8Array(HEADER_SIZE);
  const v = view(bytes);
  text(bytes, 0, 'RIFF');
  v.setUint32(4, 36, true);
  text(bytes, 8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * 3, true);
  v.setUint16(32, channels * 3, true);
  v.setUint16(34, 24, true);
  text(bytes, 36, 'data');
  return bytes;
}

function updateSizes(file, size, padding = 0) {
  const bytes = new Uint8Array(4);
  const v = view(bytes);
  v.setUint32(0, 36 + size + padding, true);
  writeAll(file, bytes, 4);
  v.setUint32(0, size, true);
  writeAll(file, bytes, 40);
}

export function validateRecordingFormat({ sampleRate, channels }) {
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || ![1, 2].includes(channels) ||
      sampleRate * channels * 3 > 0xffffffff) throw new Error('Invalid recording format');
}

export function createRecordingFile(file, { sampleRate, channels }) {
  validateRecordingFormat({ sampleRate, channels });
  if (file.getSize() !== 0) throw new Error('Recording file must be empty');
  writeAll(file, header(sampleRate, channels), 0);
  file.flush();
  let size = 0;
  let closed = false;
  let failed = false;
  const check = () => {
    if (closed) throw new Error('Recording file is closed');
    if (failed) throw new Error('Recording file failed; recover it before use');
  };
  const perform = (fn) => {
    check();
    try { return fn(); } catch (error) { failed = true; throw error; }
  };
  const appendPcm24 = (bytes) => {
    check();
    if (!(bytes instanceof Uint8Array) || bytes.length % (channels * 3) ||
        bytes.length > MAX_RECORDING_CHUNK_FRAMES * channels * 3) throw new Error('Invalid recording chunk');
    const next = size + bytes.length;
    if (next + (next & 1) > MAX_DATA_BYTES) throw new Error('Recording exceeds WAV size limit');
    perform(() => writeAll(file, bytes, HEADER_SIZE + size));
    size += bytes.length;
  };
  return {
    appendPcm24,
    append(input) {
      check();
      if (!Array.isArray(input) || input.length !== channels ||
          input.some((c) => !(c instanceof Float32Array)) ||
          input.some((c) => c.length !== input[0].length) ||
          input[0].length > MAX_RECORDING_CHUNK_FRAMES) throw new Error('Invalid recording chunk');
      const length = input[0].length;
      const bytes = new Uint8Array(length * channels * 3);
      const next = size + bytes.length;
      if (next + (next & 1) > MAX_DATA_BYTES) throw new Error('Recording exceeds WAV size limit');
      for (let i = 0, at = 0; i < length; i++) {
        for (const c of input) {
          if (!Number.isFinite(c[i])) throw new Error('Recording contains invalid audio');
          const sample = Math.max(-1, Math.min(1, c[i]));
          const n = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff);
          bytes[at++] = n & 255;
          bytes[at++] = (n >> 8) & 255;
          bytes[at++] = (n >> 16) & 255;
        }
      }
      appendPcm24(bytes);
    },
    checkpoint() {
      perform(() => { updateSizes(file, size); file.flush(); });
    },
    finish() {
      perform(() => {
        const padding = size & 1;
        if (padding) writeAll(file, new Uint8Array(1), HEADER_SIZE + size);
        updateSizes(file, size, padding);
        file.flush();
        file.close();
      });
      closed = true;
      return { sampleRate, channels, frames: size / (channels * 3) };
    },
    close() {
      if (closed) return;
      file.close();
      closed = true;
    },
  };
}

function recordingInfo(file) {
  const bytes = new Uint8Array(HEADER_SIZE);
  let read = 0;
  while (read < bytes.length) {
    const n = file.read(bytes.subarray(read), { at: read });
    if (!Number.isInteger(n) || n <= 0 || n > bytes.length - read) throw new Error('Invalid recording WAV header');
    read += n;
  }
  const v = view(bytes);
  const channels = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  if (tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE' || tag(bytes, 12) !== 'fmt ' ||
      v.getUint32(16, true) !== 16 || v.getUint16(20, true) !== 1 || ![1, 2].includes(channels) ||
      !sampleRate || v.getUint32(28, true) !== sampleRate * channels * 3 ||
      v.getUint16(32, true) !== channels * 3 || v.getUint16(34, true) !== 24 ||
      tag(bytes, 36) !== 'data') throw new Error('Invalid recording WAV header');
  const frameBytes = channels * 3;
  const physicalSize = file.getSize() - HEADER_SIZE;
  const riffSize = v.getUint32(4, true), dataSize = v.getUint32(40, true);
  if (physicalSize < 0 || physicalSize > MAX_DATA_BYTES) throw new Error('Invalid recording WAV size');
  const padded = (dataSize & 1) && dataSize % frameBytes === 0 &&
    physicalSize === dataSize + 1 && riffSize === 36 + physicalSize;
  return { sampleRate, channels, frameBytes, size: padded ? dataSize : physicalSize, riffSize, dataSize, padding: padded ? 1 : 0 };
}

export function validateRecordingFile(file) {
  const { sampleRate, channels, frameBytes, size, riffSize, dataSize, padding } = recordingInfo(file);
  if (size % frameBytes || riffSize !== size + padding + 36 || dataSize !== size) throw new Error('Invalid recording WAV size');
  return { sampleRate, channels, frames: size / frameBytes };
}

export async function inspectRecordingBlob(blob) {
  if (!(blob instanceof Blob) || !Number.isSafeInteger(blob.size)) throw new Error('Invalid recording WAV');
  const header = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer());
  return validateRecordingFile({
    getSize: () => blob.size,
    read(bytes, { at }) {
      const source = header.subarray(at, at + bytes.length);
      bytes.set(source);
      return source.length;
    },
  });
}

// Repair lengths after an interrupted write; an incomplete final frame cannot be recovered.
export function recoverRecordingFile(file) {
  const { sampleRate, channels, frameBytes, size, padding } = recordingInfo(file);
  const complete = size - size % frameBytes;
  const finalPadding = complete & 1;
  if (complete + finalPadding > MAX_DATA_BYTES) throw new Error('Recording exceeds WAV size limit');
  if (complete !== size || padding) file.truncate(HEADER_SIZE + complete);
  if (finalPadding) writeAll(file, new Uint8Array(1), HEADER_SIZE + complete);
  updateSizes(file, complete, finalPadding);
  file.flush();
  return { sampleRate, channels, frames: complete / frameBytes };
}

// Read only the requested range, in bounded chunks. This runs on the storage worker.
export function readRecordingPeaks(file, start, end, bins) {
  const { channels, frameBytes, size, riffSize, dataSize, padding } = recordingInfo(file);
  if (size % frameBytes || riffSize !== size + padding + 36 || dataSize !== size) throw new Error('Recording WAV needs recovery');
  const frames = size / frameBytes;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > frames ||
      !Number.isInteger(bins) || bins < 1 || bins > 2048) throw new Error('Invalid waveform range');
  const peaks = Array.from({ length: channels }, () => {
    const values = new Float32Array(bins * 2);
    for (let i = 0; i < bins; i++) { values[2 * i] = Infinity; values[2 * i + 1] = -Infinity; }
    return values;
  });
  const count = end - start;
  const buffer = new Uint8Array(Math.min(count, MAX_RECORDING_CHUNK_FRAMES) * frameBytes);
  for (let offset = 0; offset < count;) {
    const take = Math.min(MAX_RECORDING_CHUNK_FRAMES, count - offset);
    const bytes = buffer.subarray(0, take * frameBytes);
    let read = 0;
    while (read < bytes.length) {
      const n = file.read(bytes.subarray(read), { at: HEADER_SIZE + (start + offset) * frameBytes + read });
      if (!Number.isInteger(n) || n <= 0 || n > bytes.length - read) throw new Error('Could not read recording data');
      read += n;
    }
    for (let i = 0; i < take; i++) {
      const first = Math.floor((offset + i) * bins / count);
      const last = Math.ceil((offset + i + 1) * bins / count) - 1;
      for (let channel = 0; channel < channels; channel++) {
        const at = i * frameBytes + channel * 3;
        const bits = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
        const value = (bits & 0x800000 ? bits - 0x1000000 : bits) / 0x800000;
        const out = peaks[channel];
        for (let bin = first; bin <= last; bin++) {
          out[2 * bin] = Math.min(out[2 * bin], value);
          out[2 * bin + 1] = Math.max(out[2 * bin + 1], value);
        }
      }
    }
    offset += take;
  }
  return peaks;
}

// Copy an immutable recording while applying a stroke; unchanged PCM bytes are preserved.
export function copyEditedRecording(source, destination, channel, points) {
  const { sampleRate, channels, frameBytes, size, riffSize, dataSize, padding } = recordingInfo(source);
  if (size % frameBytes || riffSize !== size + padding + 36 || dataSize !== size) throw new Error('Recording WAV needs recovery');
  if (destination.getSize() !== 0) throw new Error('Edited recording file must be empty');
  const frames = size / frameBytes;
  if (!Number.isInteger(channel) || channel < 0 || channel >= channels || !Array.isArray(points) || !points.length ||
      points.some((p) => !Number.isInteger(p?.frame) || p.frame < 0 || p.frame >= frames ||
        !Number.isFinite(p.value) || p.value < -1 || p.value > 1)) throw new Error('Invalid audio drawing stroke');
  const segments = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((point, i) => [points[i], point]);
  const header = new Uint8Array(HEADER_SIZE);
  let at = 0;
  while (at < header.length) {
    const n = source.read(header.subarray(at), { at });
    if (!Number.isInteger(n) || n <= 0 || n > header.length - at) throw new Error('Could not read recording data');
    at += n;
  }
  writeAll(destination, header, 0);
  const buffer = new Uint8Array(Math.min(frames, MAX_RECORDING_CHUNK_FRAMES) * frameBytes);
  for (let offset = 0; offset < frames;) {
    const count = Math.min(MAX_RECORDING_CHUNK_FRAMES, frames - offset);
    const bytes = buffer.subarray(0, count * frameBytes);
    let read = 0;
    while (read < bytes.length) {
      const n = source.read(bytes.subarray(read), { at: HEADER_SIZE + offset * frameBytes + read });
      if (!Number.isInteger(n) || n <= 0 || n > bytes.length - read) throw new Error('Could not read recording data');
      read += n;
    }
    for (const [a, b] of segments) {
      const first = Math.max(offset, Math.min(a.frame, b.frame));
      const last = Math.min(offset + count - 1, Math.max(a.frame, b.frame));
      for (let frame = first; frame <= last; frame++) {
        const value = a.frame === b.frame ? b.value : a.value + (b.value - a.value) * (frame - a.frame) / (b.frame - a.frame);
        const sample = Math.round(value < 0 ? value * 0x800000 : value * 0x7fffff);
        const i = (frame - offset) * frameBytes + channel * 3;
        bytes[i] = sample & 255;
        bytes[i + 1] = (sample >> 8) & 255;
        bytes[i + 2] = (sample >> 16) & 255;
      }
    }
    writeAll(destination, bytes, HEADER_SIZE + offset * frameBytes);
    offset += count;
  }
  if (padding) writeAll(destination, new Uint8Array(1), HEADER_SIZE + size);
  destination.flush();
  return { sampleRate, channels, frames };
}
