export const AUDIO_FORMATS = [
  { ext: '.wav', label: 'WAV audio (.wav)', mime: 'audio/wav' },
  { ext: '.mp3', label: 'MP3 audio (.mp3)', mime: 'audio/mpeg' },
  { ext: '.ogg', label: 'Ogg Vorbis audio (.ogg)', mime: 'audio/ogg' },
];

export function audioFormat(name) {
  const ext = /\.[^.\\/]+$/.exec(name)?.[0].toLowerCase();
  const format = AUDIO_FORMATS.find(format => format.ext === ext);
  if (!format) throw new Error('Choose a .wav, .mp3 or .ogg audio file name.');
  return format;
}

export async function encodeAudio(left, right, sampleRate, format = '.wav') {
  if (format === '.wav') {
    const { encodeWav } = await import('./render.js');
    return encodeWav(left, right, sampleRate);
  }
  if (!['.mp3', '.ogg'].includes(format)) throw new Error(`Unsupported audio format "${format}"`);
  const { createMp3Encoder, createOggEncoder } = await import('../node_modules/wasm-media-encoders/dist/esnext/index.mjs');
  const encoder = await (format === '.mp3' ? createMp3Encoder() : createOggEncoder());
  encoder.configure(format === '.mp3'
    ? { channels: 2, sampleRate, bitrate: 320, outputSampleRate: sampleRate >= 48000 ? 48000 : 44100 }
    : { channels: 2, sampleRate, vbrQuality: 10 });
  const chunks = [];
  let size = 0;
  const append = data => {
    if (!data.length) return;
    const copy = data.slice();
    chunks.push(copy);
    size += copy.length;
  };
  for (let offset = 0; offset < left.length; offset += 16384) {
    const channels = [left, right].map(channel => {
      const block = channel.slice(offset, offset + 16384);
      for (let i = 0; i < block.length; i++) block[i] = Math.max(-1, Math.min(1, block[i]));
      return block;
    });
    append(encoder.encode(channels));
  }
  append(encoder.finalize());
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}
