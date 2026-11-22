import { validateRecordingFormat } from './recordingfile.js';
import { importPcm } from './pcmimport.js';

const decoder = new TextDecoder('ascii');
const id = (bytes, at) => decoder.decode(bytes.subarray(at, at + 4));
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export async function inspectAiff(file) {
  if (!(file instanceof Blob) || !Number.isSafeInteger(file.size) || file.size < 12) throw new Error('Invalid AIFF file');
  const read = async (at, length) => new Uint8Array(await file.slice(at, at + length).arrayBuffer());
  const header = await read(0, 12), h = view(header);
  const type = id(header, 8);
  if (id(header, 0) !== 'FORM' || !['AIFF', 'AIFC'].includes(type)) throw new Error('Invalid AIFF file');
  const end = h.getUint32(4) + 8;
  if (end < 12 || end > file.size) throw new Error('Truncated AIFF file');
  let format = null, data = null, count = 0;
  for (let at = 12; at < end;) {
    if (++count > 100000 || at + 8 > end) throw new Error('Invalid AIFF chunks');
    const chunk = await read(at, 8), v = view(chunk), size = v.getUint32(4), start = at + 8;
    if (start + size > end) throw new Error('Truncated AIFF chunk');
    const kind = id(chunk, 0);
    if (kind === 'COMM') {
      if (format || size < (type === 'AIFC' ? 22 : 18)) throw new Error('Invalid AIFF format');
      const bytes = await read(start, Math.min(size, 22)), f = view(bytes);
      const channels = f.getUint16(0), frames = f.getUint32(2), bits = f.getUint16(6);
      const exponent = f.getUint16(8);
      const rate = Number(f.getBigUint64(10)) * 2 ** (exponent - 16383 - 63);
      const sampleRate = Math.round(rate);
      if ((exponent & 0x8000) || exponent === 0x7fff || !Number.isFinite(rate) || Math.abs(rate - sampleRate) > 1e-6) {
        throw new Error('Unsupported AIFF sample rate');
      }
      validateRecordingFormat({ sampleRate, channels });
      const compression = type === 'AIFC' ? id(bytes, 18) : 'NONE';
      const tag = ['fl32', 'FL32', 'fl64', 'FL64'].includes(compression) ? 3 : 1;
      if ((!['NONE', 'twos', 'sowt'].includes(compression) && tag !== 3) ||
          !(tag === 1 ? [8, 16, 24, 32].includes(bits) : [32, 64].includes(bits)) ||
          (tag === 3 && bits !== (compression.toLowerCase() === 'fl32' ? 32 : 64))) throw new Error('Unsupported AIFF encoding');
      const align = channels * bits / 8;
      if (!frames || frames * channels * 3 > 0xffffffff - 36) throw new Error('Audio exceeds WAV size limit');
      format = { tag, channels, sampleRate, bits, align, frames, littleEndian: compression === 'sowt', unsigned8: false };
    } else if (kind === 'SSND') {
      if (data || size < 8) throw new Error('Invalid AIFF audio data');
      const bytes = await read(start, 8), d = view(bytes), offset = d.getUint32(0);
      if (d.getUint32(4) || offset > size - 8) throw new Error('Unsupported AIFF audio layout');
      data = { start: start + 8 + offset, size: size - 8 - offset };
    }
    at = start + size;
    if (size & 1 && at < end) at++;
  }
  if (!format || !data || format.frames * format.align > data.size) throw new Error('AIFF has no complete audio frames');
  return { ...format, start: data.start };
}

export async function importAiff(store, file) {
  return importPcm(store, file, await inspectAiff(file));
}
