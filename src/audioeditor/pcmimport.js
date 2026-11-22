import { MAX_RECORDING_CHUNK_FRAMES } from './recordingfile.js';

// Converts in bounded chunks; 24-bit PCM is copied without requantization.
export async function importPcm(store, file, info) {
  const { id: asset, writer } = await store.create(info);
  try {
    for (let frame = 0; frame < info.frames; frame += MAX_RECORDING_CHUNK_FRAMES) {
      const count = Math.min(MAX_RECORDING_CHUNK_FRAMES, info.frames - frame);
      const bytes = new Uint8Array(await file.slice(info.start + frame * info.align, info.start + (frame + count) * info.align).arrayBuffer());
      if (bytes.length !== count * info.align) throw new Error('Audio file changed while importing');
      if (info.tag === 1 && info.bits === 24) {
        if (!info.littleEndian) for (let at = 0; at < bytes.length; at += 3) {
          const first = bytes[at];
          bytes[at] = bytes[at + 2];
          bytes[at + 2] = first;
        }
        writer.appendPcm24(bytes);
        continue;
      }
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const output = Array.from({ length: info.channels }, () => new Float32Array(count));
      const width = info.bits / 8;
      for (let i = 0; i < count; i++) for (let ch = 0; ch < info.channels; ch++) {
        const at = i * info.align + ch * width;
        const value = info.tag === 3 ? (info.bits === 32 ? data.getFloat32(at, info.littleEndian) : data.getFloat64(at, info.littleEndian))
          : info.bits === 8 ? (info.unsigned8 ? (data.getUint8(at) - 128) / 128 : data.getInt8(at) / 128)
            : info.bits === 16 ? data.getInt16(at, info.littleEndian) / 32768 : data.getInt32(at, info.littleEndian) / 2147483648;
        if (!Number.isFinite(value)) throw new Error('Audio file contains invalid samples');
        output[ch][i] = value;
      }
      writer.append(output);
    }
    return { id: asset, ...writer.finish() };
  } catch (error) {
    const failures = [error];
    try { writer.close(); } catch (closeError) { failures.push(closeError); }
    try { await store.discard(asset); } catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length > 1) throw new AggregateError(failures, 'Audio import and cleanup failed');
    throw error;
  }
}
