import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAudio, writeAudio } from '../src/audioexport.js';

const OriginalWorker = globalThis.Worker;
let worker;
globalThis.Worker = class {
  constructor(url, options) {
    assert.match(url.href, /exportworker\.js$/);
    assert.equal(options.type, 'module');
    worker = this;
  }
  postMessage(data) { this.project = data.project; }
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
    signal: new AbortController().signal,
    onProgress: (fraction) => events.push(fraction),
    onEncoding: () => events.push('encoding'),
  });
  worker.onmessage({ data: { type: 'progress', fraction: 0.5 } });
  worker.onmessage({ data: { type: 'encoding' } });
  worker.onmessage({ data: { type: 'complete', wav: new ArrayBuffer(44) } });
  assert.equal((await complete).wav.byteLength, 44);
  assert.deepEqual(events, [0.5, 'encoding']);
  assert.ok(worker.terminated);
  const failed = renderAudio({}, { signal: new AbortController().signal });
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
  await assert.rejects(atomicWrite(path, new Uint8Array([4]), { signal: AbortSignal.abort() }), { name: 'AbortError' });
} finally {
  delete globalThis.audioExportElectron;
  await rm(folder, { recursive: true, force: true });
}
console.log('Audio export cancellation tests passed');
