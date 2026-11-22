import { MAX_RECORDING_CHUNK_FRAMES, validateRecordingFormat } from './recordingfile.js';
import { importWav } from './wavimport.js';
import { importAiff } from './aiffimport.js';

export async function importMedia(store, file) {
  if (!(file instanceof Blob)) throw new Error('Invalid audio file');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (String.fromCharCode(...header.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...header.subarray(8, 12)) === 'WAVE') return importWav(store, file);
  if (String.fromCharCode(...header.subarray(0, 4)) === 'FORM' &&
      ['AIFF', 'AIFC'].includes(String.fromCharCode(...header.subarray(8, 12)))) return importAiff(store, file);
  const { Input, BlobSource, AudioSampleSink, ADTS, FLAC, MATROSKA, MP3, MP4, MPEG_TS, OGG, QTFF, WAVE, WEBM } =
    await import('../../node_modules/mediabunny/dist/bundles/mediabunny.mjs');
  const input = new Input({ source: new BlobSource(file), formats: [ADTS, FLAC, MATROSKA, MP3, MP4, MPEG_TS, OGG, QTFF, WAVE, WEBM] });
  let writer = null, asset = null;
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('The file has no audio track');
    if (!await track.canDecode()) throw new Error('This audio codec is not supported on this system');
    const sampleRate = await track.getSampleRate(), channels = await track.getNumberOfChannels();
    validateRecordingFormat({ sampleRate, channels });
    ({ id: asset, writer } = await store.create({ sampleRate, channels }));
    const sink = new AudioSampleSink(track);
    let origin = null, written = 0;
    for await (const sample of sink.samples()) {
      try {
        if (sample.sampleRate !== sampleRate || sample.numberOfChannels !== channels || !Number.isFinite(sample.timestamp)) {
          throw new Error('Audio format changes inside the file are unsupported');
        }
        origin ??= Math.max(0, sample.timestamp);
        const start = Math.round((sample.timestamp - origin) * sampleRate);
        if (!Number.isSafeInteger(start)) throw new Error('Invalid audio timestamp');
        if ((Math.max(0, start) + sample.numberOfFrames) * channels * 3 > 0xffffffff - 37) {
          throw new Error('Audio exceeds WAV size limit');
        }
        while (written < start) {
          const count = Math.min(MAX_RECORDING_CHUNK_FRAMES, start - written);
          writer.append(Array.from({ length: channels }, () => new Float32Array(count)));
          written += count;
        }
        const skip = Math.max(0, written - start);
        for (let at = skip; at < sample.numberOfFrames; at += MAX_RECORDING_CHUNK_FRAMES) {
          const count = Math.min(MAX_RECORDING_CHUNK_FRAMES, sample.numberOfFrames - at);
          const output = Array.from({ length: channels }, (_, ch) => {
            const values = new Float32Array(count);
            sample.copyTo(values, { format: 'f32-planar', planeIndex: ch, frameOffset: at, frameCount: count });
            return values;
          });
          writer.append(output);
          written += count;
        }
      } finally { sample.close(); }
    }
    if (!written) throw new Error('The file has no audio samples');
    const result = writer.finish();
    writer = null;
    return { id: asset, ...result };
  } catch (error) {
    const failures = [error];
    if (writer) {
      try { writer.close(); } catch (closeError) { failures.push(closeError); }
    }
    if (asset) {
      try { await store.discard(asset); } catch (cleanupError) { failures.push(cleanupError); }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Audio import and cleanup failed');
    throw error;
  } finally { input.dispose(); }
}
