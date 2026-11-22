import { validateRecordingFormat } from './recordingfile.js';
import { importPcm } from './pcmimport.js';

const decoder = new TextDecoder('ascii');
const id = (bytes, at) => decoder.decode(bytes.subarray(at, at + 4));
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const SUBFORMAT_TAIL = [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];

export async function inspectWav(file) {
  if (!(file instanceof Blob) || !Number.isSafeInteger(file.size) || file.size < 12) throw new Error('Invalid WAV file');
  const read = async (at, length) => new Uint8Array(await file.slice(at, at + length).arrayBuffer());
  const header = await read(0, 12), h = view(header);
  if (id(header, 0) !== 'RIFF' || id(header, 8) !== 'WAVE') throw new Error('Unsupported audio file; expected a WAV');
  const end = h.getUint32(4, true) + 8;
  if (end < 12 || end > file.size) throw new Error('Truncated WAV file');
  let format = null, data = null, count = 0;
  for (let at = 12; at < end;) {
    if (++count > 100000 || at + 8 > end) throw new Error('Invalid WAV chunks');
    const chunk = await read(at, 8), v = view(chunk), size = v.getUint32(4, true), start = at + 8;
    if (start + size > end) throw new Error('Truncated WAV chunk');
    const kind = id(chunk, 0);
    if (kind === 'fmt ') {
      if (format || size < 16) throw new Error('Invalid WAV format');
      const bytes = await read(start, Math.min(size, 40)), f = view(bytes);
      let tag = f.getUint16(0, true);
      const channels = f.getUint16(2, true), sampleRate = f.getUint32(4, true);
      const align = f.getUint16(12, true), bits = f.getUint16(14, true);
      if (tag === 0xfffe) {
        if (size < 40 || f.getUint16(16, true) < 22 || f.getUint16(18, true) !== bits ||
            bytes.subarray(28, 40).some((b, i) => b !== SUBFORMAT_TAIL[i])) throw new Error('Unsupported WAV format');
        tag = f.getUint32(24, true);
      }
      validateRecordingFormat({ sampleRate, channels });
      if (!((tag === 1 && [8, 16, 24, 32].includes(bits)) || (tag === 3 && [32, 64].includes(bits))) ||
          align !== channels * bits / 8 || f.getUint32(8, true) !== sampleRate * align) throw new Error('Unsupported WAV format');
      format = { tag, channels, sampleRate, bits, align };
    } else if (kind === 'data') {
      if (data) throw new Error('WAV has multiple audio data chunks');
      data = { start, size };
    }
    at = start + size;
    if (size & 1 && at < end) at++;
  }
  if (!format || !data || !data.size || data.size % format.align) throw new Error('WAV has no complete audio frames');
  const frames = data.size / format.align;
  if (frames * format.channels * 3 > 0xffffffff - 36) throw new Error('Audio exceeds WAV size limit');
  return { ...format, ...data, frames, littleEndian: true, unsigned8: true };
}

export async function importWav(store, file) {
  return importPcm(store, file, await inspectWav(file));
}
