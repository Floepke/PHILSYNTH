import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAudio, writeAudio } from '../src/audioexport.js';
import { audioFormat, encodeAudio } from '../src/audioformat.js';
import { saveExtension } from '../src/filepicker.js';
import { normalizePeak, NORMALIZED_PEAK } from '../src/render.js';

for (const peak of [0.02, 0.5, 1, 2, 10]) {
  const left = Float32Array.of(peak, -peak / 2, peak / 8, 0);
  const right = Float32Array.of(-peak / 4, peak / 16, 0, 0);
  const before = [left.slice(), right.slice()];
  assert.equal(normalizePeak(left, right), NORMALIZED_PEAK);
  assert.ok(Math.abs(20 * Math.log10(Math.max(...left.map(Math.abs), ...right.map(Math.abs))) + 1) < 1e-6);
  for (const [channel, original] of [[left, before[0]], [right, before[1]]]) {
    channel.forEach((value, i) => assert.ok(Math.abs(value - original[i] * NORMALIZED_PEAK / peak) < 1e-7,
      'one gain preserves dynamics, polarity and stereo balance'));
  }
}
{
  const silent = new Float32Array(10);
  assert.equal(normalizePeak(silent, silent), 0);
  assert.ok(silent.every(value => value === 0));
  const mono = Float32Array.of(2, -1);
  normalizePeak(mono, mono);
  assert.ok(Math.abs(mono[0] - NORMALIZED_PEAK) < 1e-7, 'shared channel buffers are scaled only once');
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.throws(() => normalizePeak(Float32Array.of(invalid), silent), /invalid audio samples/);
  }
}

{
  assert.equal(audioFormat('Song.MP3').mime, 'audio/mpeg');
  assert.equal(audioFormat('Song.ogg').ext, '.ogg');
  assert.throws(() => audioFormat('Song.flac'), /Choose/);
  const formats = [{ ext: '.wav' }, { ext: '.mp3' }, { ext: '.ogg' }];
  assert.equal(saveExtension('Song.MP3', '.wav', formats), '.mp3');
  assert.equal(saveExtension('Song', '.ogg', formats), '.ogg');
  const pcm = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 48000) * 0.5);
  const original = pcm.slice();
  const mp3 = new Uint8Array(await encodeAudio(pcm, pcm, 48000, '.mp3'));
  const ogg = new Uint8Array(await encodeAudio(pcm, pcm, 48000, '.ogg'));
  assert.ok(mp3.length > 39000 && mp3.length < 45000, 'MP3 uses maximum 320 kbps encoding');
  assert.equal(mp3[0], 255);
  assert.equal(mp3[1] & 224, 224, 'MP3 frame sync');
  assert.equal(mp3[2] >>> 4, 14, 'MPEG-1 bitrate index is 320 kbps');
  assert.equal(new TextDecoder().decode(ogg.slice(0, 4)), 'OggS');
  assert.ok(new TextDecoder().decode(ogg).includes('vorbis'), 'Ogg contains Vorbis audio');
  assert.deepEqual(pcm, original, 'encoding does not alter the render buffers');
  const hot = pcm.map(value => value * 3);
  const limited = hot.map(value => Math.max(-1, Math.min(1, value)));
  assert.deepEqual(
    await encodeAudio(hot, pcm, 48000, '.mp3'),
    await encodeAudio(limited, pcm, 48000, '.mp3'),
    'compressed export clamps out-of-range PCM before encoding',
  );
  await assert.rejects(encodeAudio(pcm, pcm, 48000, '.flac'), /Unsupported/);
}

const OriginalWorker = globalThis.Worker;
let worker;
globalThis.Worker = class {
  constructor(url, options) {
    assert.match(url.href, /exportworker\.js$/);
    assert.equal(options.type, 'module');
    worker = this;
  }
  postMessage(data) { this.project = data.project; this.format = data.format; this.normalize = data.normalize; }
  terminate() { this.terminated = true; }
};
try {
  const controller = new AbortController();
  const promise = renderAudio({ song: 1 }, { signal: controller.signal, onProgress() {}, onEncoding() {} });
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.ok(worker.terminated, 'cancel immediately terminates the rendering/encoding worker');
  assert.throws(() => renderAudio({}, { signal: controller.signal }), { name: 'AbortError' });
  const events = [];
  const complete = renderAudio({}, {
    format: '.ogg',
    normalize: true,
    signal: new AbortController().signal,
    onProgress: (fraction) => events.push(fraction),
    onEncoding: () => events.push('encoding'),
  });
  assert.equal(worker.format, '.ogg', 'requested audio format reaches the encoding worker');
  assert.equal(worker.normalize, true, 'peak normalization choice reaches the encoding worker');
  worker.onmessage({ data: { type: 'progress', fraction: 0.5 } });
  worker.onmessage({ data: { type: 'encoding' } });
  worker.onmessage({ data: { type: 'complete', wav: new ArrayBuffer(44) } });
  assert.equal((await complete).wav.byteLength, 44);
  assert.deepEqual(events, [0.5, 'encoding']);
  assert.ok(worker.terminated);
  const failed = renderAudio({}, { signal: new AbortController().signal });
  assert.equal(worker.normalize, false, 'existing callers preserve original levels');
  worker.onmessage({ data: { type: 'error', message: 'Render failed' } });
  await assert.rejects(failed, /Render failed/);
  assert.ok(worker.terminated);
} finally {
  if (OriginalWorker) globalThis.Worker = OriginalWorker;
  else delete globalThis.Worker;
}

{
  const controller = new AbortController();
  let rejectWrite;
  let aborted = false, closed = false;
  const handle = { createWritable: async () => ({
    write: () => new Promise((_resolve, reject) => { rejectWrite = reject; }),
    abort: async (reason) => { aborted = true; rejectWrite(reason); },
    close: async () => { closed = true; },
  }) };
  const pending = writeAudio(handle, new Blob(['audio']), controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(aborted);
  assert.equal(closed, false, 'cancelled browser writes are not committed');
}

// Exercise the desktop IPC handlers with real files and a mocked Electron boundary.
const folder = await mkdtemp(join(tmpdir(), 'philsynth-audio-'));
const handlers = new Map();
globalThis.audioExportElectron = {
  app: { getPath: () => folder },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  BrowserWindow: { fromWebContents: () => null },
};
try {
  const url = new URL('../electron/projectfiles.mjs', import.meta.url);
  let source = await readFile(url, 'utf8');
  source = source.replace("import { app, ipcMain, BrowserWindow } from 'electron';", 'const { app, ipcMain, BrowserWindow } = globalThis.audioExportElectron;')
    .replace("import { notifyFolderChanged } from './kdirnotify.mjs';", 'const notifyFolderChanged = () => {};')
    .replace(/from '(\.\.?\/[^']+)'/g, (_match, path) => `from '${new URL(path, url).href}'`);
  const { registerProjectFiles, atomicWrite } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  registerProjectFiles(() => true);
  const path = join(folder, 'export.wav');
  const original = Buffer.from('original WAV');
  await writeFile(path, original);
  const sender = { senderFrame: { url: 'http://localhost/' }, sender: { id: 1 } };
  const pending = handlers.get('audio:save')(sender, path, new Uint8Array(32 * 1024 * 1024), 'test-export');
  handlers.get('audio:cancel')(sender, 'test-export');
  assert.deepEqual(await pending, { cancelled: true });
  assert.deepEqual(await readFile(path), original, 'cancellation preserves the original WAV');
  assert.deepEqual(await readdir(folder), ['export.wav'], 'cancelled temporary files are removed');
  await handlers.get('audio:save')(sender, path, new Uint8Array([1, 2, 3]), 'test-export');
  assert.deepEqual(await readFile(path), Buffer.from([1, 2, 3]), 'export can be retried after cancellation');
  for (const ext of ['mp3', 'ogg']) {
    const audioPath = join(folder, `export.${ext}`);
    await handlers.get('audio:save')(sender, audioPath, new Uint8Array([1, 2, 3]), `test-${ext}`);
    assert.deepEqual(await readFile(audioPath), Buffer.from([1, 2, 3]), 'compressed extension is preserved instead of appending .wav');
  }
  await assert.rejects(atomicWrite(path, new Uint8Array([4]), { signal: AbortSignal.abort() }), { name: 'AbortError' });
} finally {
  delete globalThis.audioExportElectron;
  await rm(folder, { recursive: true, force: true });
}
console.log('Audio export cancellation tests passed');
