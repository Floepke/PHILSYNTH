// Linux: xvfb-run -a node_modules/.bin/electron test/audio-storage-ui.test.mjs --no-sandbox
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worker = `
  import { openRecordingStorage } from '/src/audioeditor/storage.js';
  import { createRecordingBuffer, RecordingBuffer } from '/src/audioeditor/recordingbuffer.js';
  import { copyZipEntry, readZipStream, writeZipStream } from '/src/projectzipstream.js';
  import { crc32 } from '/src/projectzip.js';
  import { prepareStreamedProjectArchive, readStreamedProjectArchive } from '/src/projectarchive.js';
  import { emptySong, addAudioClip, cloneClip } from '/src/song.js';
  import { createProjectFile, fsaBackend } from '/src/projectfile.js';
  import { stageProjectStream } from '/src/audioeditor/projectstage.js';
  import { importWav } from '/src/audioeditor/wavimport.js';
  import { importMedia } from '/src/audioeditor/mediaimport.js';
  import { encodeAudio } from '/src/audioformat.js';
  import { AudioPageCache, createAudioPageMemory, AUDIO_PAGE_FRAMES } from '/src/audioeditor/pagecache.js';
  import { Graph } from '/src/dsp/graph.js';
  self.onmessage = async () => {
    try {
      const store = await openRecordingStorage();
      const { id, writer } = await store.create({ sampleRate: 48000, channels: 2 });
      writer.append([Float32Array.of(-1, .5), Float32Array.of(1, -.5)]);
      writer.checkpoint();
      writer.append([Float32Array.of(.25), Float32Array.of(-.25)]);
      writer.close();
      const recovered = await store.recover(id);
      const file = await store.file(id);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const wavImport = await importWav(store, file);
      const wavImportBytes = Array.from(new Uint8Array(await (await store.file(wavImport.id)).arrayBuffer()));
      const pcm16 = new Uint8Array(52);
      pcm16.set(bytes.slice(0, 44));
      const wavView = new DataView(pcm16.buffer);
      wavView.setUint32(4, 44, true);
      wavView.setUint32(28, 48000 * 4, true);
      wavView.setUint16(32, 4, true);
      wavView.setUint16(34, 16, true);
      wavView.setUint32(40, 8, true);
      wavView.setInt16(44, -32768, true);
      wavView.setInt16(46, 32767, true);
      wavView.setInt16(48, 16384, true);
      wavView.setInt16(50, -16384, true);
      const imported16 = await importWav(store, new Blob([pcm16]));
      const pcm16Peaks = (await store.peaks(imported16.id, 0, 2, 2)).map(c => Array.from(c));
      let truncatedError = '';
      try { await importWav(store, new Blob([pcm16.slice(0, 50)])); }
      catch (error) { truncatedError = error.message; }
      const aiff = new Uint8Array(60), av = new DataView(aiff.buffer);
      aiff.set(new TextEncoder().encode('FORM'), 0);
      av.setUint32(4, 52);
      aiff.set(new TextEncoder().encode('AIFFCOMM'), 8);
      av.setUint32(16, 18);
      av.setUint16(20, 1);
      av.setUint32(22, 3);
      av.setUint16(26, 16);
      aiff.set([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0], 28);
      aiff.set(new TextEncoder().encode('SSND'), 38);
      av.setUint32(42, 14);
      av.setInt16(54, -32768);
      av.setInt16(56, 16384);
      av.setInt16(58, 32767);
      const aiffImport = await importMedia(store, new Blob([aiff]));
      const aiffPeaks = Array.from((await store.peaks(aiffImport.id, 0, 3, 3))[0]);
      const aiffFile = await store.file(aiffImport.id);
      const aiffBytes = new Uint8Array(await aiffFile.arrayBuffer());
      const aiffEdited = await store.edit(aiffImport.id, 0, [{ frame: 1, value: 0 }]);
      const aiffRecovered = await store.recover(aiffImport.id);
      const memory = createAudioPageMemory(), channel = new MessageChannel();
      const reader = new Worker('/src/audioeditor/playbackworker.js', { type: 'module' });
      const cache = new AudioPageCache(memory, channel.port1);
      reader.postMessage({ memory, port: channel.port2 }, [channel.port2]);
      const audio = { ...aiffImport, span: 2, offset: 0 };
      await cache.ready(audio, 0);
      const page = cache.page(audio, 0);
      const cached = [cache.samples[page], cache.samples[page + 1], cache.samples[page + AUDIO_PAGE_FRAMES]];
      let missingPageError = '';
      try { await cache.ready({ ...audio, id: '12345678-1234-4234-8234-123456789abc' }, 0); }
      catch (error) { missingPageError = error.message; }
      reader.terminate();
      channel.port1.close();
      const left = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i * 0.1) * 0.5);
      const mp3 = await encodeAudio(left, left, 48000, '.mp3');
      const compressed = await importMedia(store, new Blob([mp3], { type: 'audio/mpeg' }));
      const compressedPeaks = Array.from((await store.peaks(compressed.id, 0, compressed.frames, 1))[0]);
      const archive = [];
      await writeZipStream([{ path: 'media/audio/take.wav', blob: file }], part => archive.push(part.slice()));
      const packed = new Blob(archive);
      const entries = await readZipStream(packed);
      const imported = await store.importEntry(entries.get('media/audio/take.wav'));
      const importedBytes = new Uint8Array(await (await store.file(imported.id)).arrayBuffer());
      const corrupt = new Uint8Array(await packed.arrayBuffer());
      corrupt[30 + 'media/audio/take.wav'.length + 20 + 44] ^= 1;
      const corruptEntries = await readZipStream(new Blob([corrupt]));
      const beforeImport = await store.list();
      let importError = '';
      try { await store.importEntry(corruptEntries.get('media/audio/take.wav')); }
      catch (error) { importError = error.message; }
      const badWav = bytes.slice();
      badWav[0] = 0;
      let formatError = '';
      try { await store.importEntry({ blob: new Blob([badWav]), crc: crc32(badWav) }); }
      catch (error) { formatError = error.message; }
      const afterImport = await store.list();
      const song = emptySong();
      const clip = addAudioClip(song, { audio: { id, sampleRate: 48000, channels: 2, frames: 3, span: 4 } });
      cloneClip(song, clip).y = 34;
      const project = { format: 'philsynth', version: 1, patch: { modules: [] }, song };
      const projectChunks = [];
      await prepareStreamedProjectArchive(project, store)(part => projectChunks.push(part.slice()));
      const saved = new Blob(projectChunks);
      const opened = await readStreamedProjectArchive(saved, store);
      const loadedClips = opened.data.song.clips;
      const restored = await store.file(loadedClips[0].audio.id);
      const projectRoundTrip = { version: opened.version, count: opened.imported.length,
        ids: loadedClips.map(c => c.audio.id), bytes: Array.from(new Uint8Array(await restored.arrayBuffer())) };
      for (const importedId of opened.imported) await store.discard(importedId);
      const beforeBrokenProject = await store.list();
      let mismatchError = '';
      try {
        await readStreamedProjectArchive(saved, { ...store, importEntry: async entry => {
          const result = await store.importEntry(entry);
          return { ...result, frames: result.frames + 1 };
        } });
      } catch (error) { mismatchError = error.message; }
      const afterBrokenProject = await store.list();
      let nativeClosed = false;
      const staged = await stageProjectStream({
        readProjectStream: async (_id, at, length) => new Uint8Array(await saved.slice(at, at + length).arrayBuffer()),
        closeProjectStream: async () => { nativeClosed = true; },
      }, { id: 'test', size: saved.size });
      const stagedEntries = await readZipStream(staged.blob);
      const manifestChunks = [];
      await copyZipEntry(stagedEntries.get('project.json'), part => manifestChunks.push(part.slice()));
      const archiveManifest = JSON.parse(await new Blob(manifestChunks).text());
      await staged.cleanup();
      let fsaFile = new File([], 'test.phproject');
      const handle = {
        name: 'test.phproject',
        async getFile() { return fsaFile; },
        async createWritable() {
          const parts = [];
          return {
            async write(part) { parts.push(part.slice()); },
            async close() { fsaFile = new File(parts, 'test.phproject'); },
            async abort() {},
          };
        },
        async queryPermission() { return 'granted'; },
      };
      const backend = fsaBackend({ showSaveFilePicker: async () => handle, showOpenFilePicker: async () => [handle] });
      let current = project, reloaded = null;
      const document = createProjectFile({
        fingerprint: () => current,
        serialize: () => Object.assign(async () => { throw new Error('buffered encoding used'); },
          { writeTo: prepareStreamedProjectArchive(current, store), diskVersion: 3 }),
        backend, getAudioAssets: () => store,
      });
      await document.saveAs();
      await document.open(async data => { reloaded = data; current = data; });
      const fsaResult = { version: document.toJSON().diskVersion, ids: reloaded.song.clips.map(c => c.audio.id) };
      await store.discard(fsaResult.ids[0]);
      const peaks = (await store.peaks(id, 0, 3, 3)).map(channel => Array.from(channel));
      const edited = await store.edit(id, 1, [{ frame: 0, value: 0 }, { frame: 2, value: 1 }, { frame: 1, value: -1 }]);
      const editedPeaks = (await store.peaks(edited.id, 0, 3, 3)).map(channel => Array.from(channel));
      const originalPeaks = (await store.peaks(id, 0, 3, 3)).map(channel => Array.from(channel));
      const buffer = createRecordingBuffer(257, 2);
      const graph = new Graph({ kernels: { constant: class {
        process(_input, output) { output[0][0].fill(0.5); output[0][1].fill(-0.5); return true; }
      } } });
      graph.add(1, 'constant');
      graph.add(2, 'bus');
      graph.connect(1, 2);
      const result = await new Promise((resolve, reject) => {
        const writer = new Worker('/src/audioeditor/recordingworker.js', { type: 'module' });
        writer.onerror = error => reject(new Error(error.message));
        writer.onmessage = ({ data }) => {
          if (data.type === 'ready') {
            graph.setRecording(2, buffer);
            graph.render(new Float32Array(128), new Float32Array(128));
            graph.setRecording(2, null);
          } else if (data.type === 'complete' || data.type === 'error') {
            writer.terminate();
            resolve(data);
          }
        };
        writer.postMessage({ buffer, sampleRate: 48000 });
      });
      const recorded = (await store.peaks(result.id, 0, 128, 2)).map(channel => Array.from(channel));
      const overrunBuffer = createRecordingBuffer(4, 1);
      const overrunRing = new RecordingBuffer(overrunBuffer);
      overrunRing.write([Float32Array.of(0.1, 0.2, 0.3)]);
      overrunRing.write([Float32Array.of(0.4)]);
      const overrun = await new Promise((resolve, reject) => {
        const writer = new Worker('/src/audioeditor/recordingworker.js', { type: 'module' });
        writer.onerror = error => reject(new Error(error.message));
        writer.onmessage = ({ data }) => {
          if (data.type === 'error' || data.type === 'complete') { writer.terminate(); resolve(data); }
        };
        writer.postMessage({ buffer: overrunBuffer, sampleRate: 48000 });
      });
      const partial = await store.file(overrun.id);
      self.postMessage({ id, recovered, imported, wavImportBytes, pcm16Peaks, truncatedError, aiffImport, aiffPeaks, aiffBytes: Array.from(aiffBytes), aiffEdited, aiffRecovered, cached, missingPageError, compressed, compressedPeaks, importedBytes: Array.from(importedBytes), originalBytes: Array.from(bytes), importError, formatError, beforeImport, afterImport, projectRoundTrip, mismatchError, beforeBrokenProject, afterBrokenProject, nativeClosed, archiveManifest, stagedPaths: Array.from(stagedEntries.keys()), fsaResult, size: bytes.length, wav: Array.from(bytes.slice(0, 12)), listed: (await store.list()).includes(id), peaks, edited, editedPeaks, originalPeaks, result, recorded, overrun, partialSize: partial.size });
    } catch (error) {
      self.postMessage({ error: error.stack || String(error) });
    }
  };
`;

app.whenReady().then(async () => {
  let server, win;
  try {
    server = http.createServer(async (req, res) => {
      try {
        const path = new URL(req.url, 'http://localhost').pathname;
        const source = resolve(root, `.${path}`);
        const allowed = source.startsWith(resolve(root, 'src') + sep) ||
          ['/style.css', '/node_modules/mediabunny/dist/bundles/mediabunny.mjs', '/node_modules/wasm-media-encoders/dist/esnext/index.mjs'].includes(path);
        let body = path === '/' ? '<!doctype html><title>Recording storage test</title>'
          : path === '/app' ? await readFile(resolve(root, 'index.html'))
          : path === '/worker.js' ? worker
          : allowed ? await readFile(source) : null;
        if (body === null) { res.writeHead(404); res.end(); return; }
        if (path === '/src/main.js') body = `${body}\nwindow.audioTest = { engine, transport, seq };\n`;
        const type = path === '/' || path === '/app' ? 'text/html' : path.endsWith('.css') ? 'text/css'
          : path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.png') ? 'image/png' : 'text/javascript';
        res.writeHead(200, {
          'Content-Type': type,
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        });
        res.end(body);
      } catch (error) {
        res.writeHead(500);
        res.end(error.message);
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: false, webPreferences: { partition: 'audio-storage-test' } });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const result = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const worker = new Worker('/worker.js', { type: 'module' });
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('Storage worker timed out')); }, 10000);
      worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
      worker.onerror = (error) => { clearTimeout(timer); worker.terminate(); reject(new Error(error.message)); };
      worker.postMessage(null);
    })`);
    assert.ok(!result.error, result.error);
    assert.deepEqual(result.recovered, { sampleRate: 48000, channels: 2, frames: 3 });
    assert.deepEqual({ sampleRate: result.imported.sampleRate, channels: result.imported.channels, frames: result.imported.frames }, result.recovered);
    assert.deepEqual(result.importedBytes, result.originalBytes);
    assert.deepEqual(result.wavImportBytes, result.originalBytes, '24-bit WAV imports preserve samples exactly');
    assert.ok(Math.abs(result.pcm16Peaks[0][0] + 1) < 2e-7);
    assert.ok(Math.abs(result.pcm16Peaks[1][0] - 32767 / 32768) < 2e-7);
    assert.match(result.truncatedError, /Truncated WAV/);
    assert.deepEqual({ sampleRate: result.aiffImport.sampleRate, channels: result.aiffImport.channels, frames: result.aiffImport.frames }, { sampleRate: 44100, channels: 1, frames: 3 });
    assert.ok(Math.abs(result.aiffPeaks[0] + 1) < 2e-7);
    assert.ok(Math.abs(result.aiffPeaks[2] - 0.5) < 2e-7);
    assert.equal(result.aiffBytes.length, 54);
    assert.equal(result.aiffBytes[53], 0);
    assert.equal(result.aiffEdited.frames, 3);
    assert.equal(result.aiffRecovered.frames, 3);
    assert.ok(Math.abs(result.cached[0] + 1) < 2e-7);
    assert.ok(Math.abs(result.cached[1] - 0.5) < 2e-7);
    assert.equal(result.cached[2], result.cached[0], 'mono playback is duplicated to stereo');
    assert.ok(result.missingPageError, 'missing recordings fail explicitly');
    assert.equal(result.compressed.sampleRate, 48000);
    assert.equal(result.compressed.channels, 2);
    assert.ok(result.compressed.frames >= 48000);
    assert.ok(result.compressedPeaks[0] < -0.3 && result.compressedPeaks[1] > 0.3);
    assert.match(result.importError, /Corrupt project archive entry/);
    assert.match(result.formatError, /Invalid recording WAV header/);
    assert.deepEqual(result.afterImport, result.beforeImport, 'failed imports remove partial files');
    assert.equal(result.projectRoundTrip.version, 3);
    assert.equal(result.projectRoundTrip.count, 1, 'linked clips save one recording');
    assert.equal(result.projectRoundTrip.ids[0], result.projectRoundTrip.ids[1]);
    assert.deepEqual(result.projectRoundTrip.bytes, result.originalBytes);
    assert.match(result.mismatchError, /does not match/);
    assert.deepEqual(result.afterBrokenProject, result.beforeBrokenProject, 'failed project loads discard imported recordings');
    assert.equal(result.nativeClosed, true);
    assert.deepEqual(result.archiveManifest.audioFiles, { [result.id]: { path: 'media/audioFiles/1.wav' } });
    assert.equal('recordings' in result.archiveManifest, false);
    assert.deepEqual(result.stagedPaths, ['project.json', 'media/audioFiles/1.wav']);
    assert.equal(result.fsaResult.version, 3);
    assert.equal(result.fsaResult.ids[0], result.fsaResult.ids[1]);
    assert.equal(result.size, 62);
    assert.equal(Buffer.from(result.wav).subarray(0, 4).toString(), 'RIFF');
    assert.equal(Buffer.from(result.wav).subarray(8, 12).toString(), 'WAVE');
    assert.equal(result.listed, true);
    for (const [actual, expected] of [
      [result.peaks[0], [-1, -1, 0.5, 0.5, 0.25, 0.25]],
      [result.peaks[1], [1, 1, -0.5, -0.5, -0.25, -0.25]],
    ]) expected.forEach((value, i) => assert.ok(Math.abs(actual[i] - value) < 2e-7));
    assert.notEqual(result.edited.id, result.id);
    assert.deepEqual(result.originalPeaks, result.peaks, 'editing leaves the original asset unchanged');
    assert.deepEqual(result.editedPeaks[0], result.peaks[0], 'editing one channel preserves the other');
    for (const [i, value] of [0, 0, -1, -1, 1, 1].entries()) {
      assert.ok(Math.abs(result.editedPeaks[1][i] - value) < 2e-7);
    }
    assert.equal(result.result.type, 'complete', result.result.message);
    assert.equal(result.result.frames, 128);
    assert.ok(Math.abs(result.recorded[0][0] - 0.5) < 2e-7);
    assert.ok(Math.abs(result.recorded[1][0] + 0.5) < 2e-7);
    assert.equal(result.overrun.type, 'error');
    assert.match(result.overrun.message, /could not keep up/);
    assert.equal(result.overrun.frames, 3);
    assert.equal(result.partialSize, 44 + 3 * 3 + 1);
    const client = await win.webContents.executeJavaScript(`(async () => {
      const { AudioAssets } = await import('/src/audioeditor/assets.js');
      const errors = [];
      const assets = new AudioAssets({ onError: error => errors.push(error.message) });
      try {
        const [peaks, file] = await Promise.all([assets.peaks(${JSON.stringify(result.id)}, 0, 3, 3), assets.file(${JSON.stringify(result.id)})]);
        const imported = await assets.importMedia(file);
        await assets.discard(imported.id);
        let invalid = '';
        try { await assets.file('../bad'); } catch (error) { invalid = error.message; }
        return { peaks: Array.from(peaks[0]), size: file.size, imported, invalid, errors };
      } finally { assets.close(); }
    })()`);
    assert.deepEqual(client.peaks, result.peaks[0]);
    assert.equal(client.size, result.size);
    assert.equal(client.imported.frames, 3);
    assert.match(client.invalid, /Invalid recording ID/);
    assert.deepEqual(client.errors, []);
    const live = await win.webContents.executeJavaScript(`(async () => {
      const { Engine } = await import('/src/engine.js');
      const { AudioTransport } = await import('/src/audiotransport.js');
      const { addAudioClip } = await import('/src/song.js');
      const { songLayers } = await import('/src/patch.js');
      const { renderSong } = await import('/src/render.js');
      const { addClip } = await import('/src/song.js');
      const { AudioRecorder } = await import('/src/audioeditor/recording.js');
      const { AudioAssets } = await import('/src/audioeditor/assets.js');
      const engine = new Engine();
      const errors = [];
      try {
        await engine.init({ buffered: false });
        engine.onError = error => errors.push(error.message ?? String(error));
        const audio = ${JSON.stringify(result.compressed)};
        addAudioClip(engine.song, { target: 0, audio: { ...audio, span: audio.frames / audio.sampleRate * 2 } });
        const transport = new AudioTransport({
          getScope: () => [], getSong: () => engine.song, getBpm: () => engine.root.bpm,
          getTarget: () => null, getLayers: () => songLayers(engine.root, engine.song, [], { nested: false }),
        }, { dsp: engine.dsp, sync: () => engine.syncSong(), audioTime: () => engine.ctx.currentTime,
          onError: error => errors.push(error.message) });
        engine.transport = transport;
        engine.dsp.onPlayback = state => transport.receive(state);
        const analyser = engine.ctx.createAnalyser();
        analyser.fftSize = 256;
        engine.node.connect(analyser);
        await engine.ctx.resume();
        transport.play({ fromStart: true });
        const data = new Float32Array(analyser.fftSize);
        let peak = 0;
        const until = performance.now() + 3000;
        while (performance.now() < until && peak < 0.1 && !errors.length) {
          await new Promise(resolve => setTimeout(resolve, 10));
          analyser.getFloatTimeDomainData(data);
          for (const value of data) peak = Math.max(peak, Math.abs(value));
        }
        transport.stop();
        const rendered = await renderSong({ patch: engine.root.toJSON(), song: engine.song }, { sampleRate: 48000 });
        const microphone = await engine.root.addModule('INPUT');
        const first = await engine.root.addModule('RECORDER');
        const second = await engine.root.addModule('RECORDER');
        engine.root.connect(microphone.id, first.id);
        engine.root.connect(microphone.id, second.id);
        for (const [entry, lane] of [[first, 2], [second, 3]]) {
          engine.root.setParam(entry.id, 'armed', 1);
          engine.root.setParam(entry.id, 'lane', lane);
        }
        engine.root.setParam(0, 'bpm', 240);
        addClip(engine.song, { start: 0.5, length: 1, y: 34 });
        const microphoneDeadline = performance.now() + 5000;
        while (engine.mics.status !== 'ok' && performance.now() < microphoneDeadline) await new Promise(resolve => setTimeout(resolve, 10));
        if (engine.mics.status !== 'ok') throw new Error('Fake microphone did not connect: ' + engine.mics.status);
        const assets = new AudioAssets({ onError: error => errors.push(error.message) });
        const recording = new AudioRecorder({ engine, transport, song: () => engine.song, patch: () => engine.root,
          assets: () => assets, onCommit() {}, onState() {}, onError: message => errors.push(message) });
        transport.seek(0);
        recording.arm();
        recording.start();
        const recordingDeadline = performance.now() + 7000;
        while (!engine.song.clips.some(clip => clip.kind === 'audio' && clip.y === 34) &&
          performance.now() < recordingDeadline && !errors.length) await new Promise(resolve => setTimeout(resolve, 10));
        await new Promise(resolve => setTimeout(resolve, 100));
        transport.stop();
        recording.finish();
        while (recording.sessions.size && performance.now() < recordingDeadline && !errors.length) await new Promise(resolve => setTimeout(resolve, 10));
        const takes = engine.song.clips.filter(clip => clip.kind === 'audio' && clip.y >= 34);
        const takePeak = takes.length ? Array.from((await assets.peaks(takes[0].audio.id, 0, takes[0].audio.frames, 1))[0]) : [];
        assets.close();
        return { peak, errors, exportPeak: rendered.peak, takes: takes.map(clip => ({ y: clip.y, audio: clip.audio })), takePeak, rate: engine.ctx.sampleRate };
      } finally { engine.root?.destroy(); await engine.ctx?.close(); }
    })()`);
    assert.deepEqual(live.errors, []);
    assert.ok(live.peak > 0.1, 'disk-backed clip plays through the actual audio worklet');
    assert.ok(live.exportPeak > 0.1, 'offline export includes the disk-backed clip');
    assert.equal(live.takes.length, 2, 'two recorders create independent takes');
    assert.deepEqual(live.takes.map(take => take.y).sort((a, b) => a - b), [34, 68]);
    const firstTake = live.takes.find(take => take.y === 34);
    const secondTake = live.takes.find(take => take.y === 68);
    assert.ok(Math.abs(firstTake.audio.frames - live.rate / 8) <= 2, 'recording stops exactly at the clip boundary');
    assert.ok(secondTake.audio.frames > firstTake.audio.frames, 'other lanes keep recording');
    assert.ok(live.takePeak.some(value => Math.abs(value) > 0.001), 'the fake microphone reaches the recorded file');
    await win.loadURL(`http://127.0.0.1:${server.address().port}/app?dsp=js`);
    const run = code => win.webContents.executeJavaScript(code);
    const waitFor = async (condition, label) => {
      const deadline = Date.now() + 10000;
      while (!(await run(condition))) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await waitFor('!!window.audioTest', 'application initialized');
    await run(`(async () => {
      const { engine, seq } = window.audioTest;
      const { emptySong } = await import('/src/song.js');
      engine.song = emptySong();
      const mic = await engine.root.addModule('INPUT');
      const recorder = await engine.root.addModule('RECORDER');
      engine.root.connect(mic.id, recorder.id);
      engine.root.setParam(recorder.id, 'armed', 1);
      engine.root.setParam(recorder.id, 'lane', 2);
      engine.root.setParam(0, 'bpm', 240);
      seq.reload();
      await engine.ctx.resume();
    })()`);
    await waitFor(`window.audioTest.engine.mics.status === 'ok'`, 'microphone connected');
    await run(`document.getElementById('seq-record').click()`);
    assert.equal(await run(`document.getElementById('seq-record').getAttribute('aria-pressed')`), 'true');
    await run(`document.getElementById('seq-play').click()`);
    await waitFor('window.audioTest.transport.playing && window.audioTest.transport.elapsed > 0.2', 'audio recording started');
    await run(`document.getElementById('seq-stop').click()`);
    await waitFor(`window.audioTest.engine.song.clips.some(c => c.kind === 'audio')`, 'recorded clip committed');
    const uiTake = await run(`window.audioTest.engine.song.clips.find(c => c.kind === 'audio')`);
    assert.equal(uiTake.y, 34, 'the record button commits to the configured lane');
    assert.ok(uiTake.audio.frames > 0);
    assert.equal(await run('window.audioTest.seq.recordArmed()'), false, 'stop disarms audio recording');
    console.log('Audio storage worker test passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win?.destroy();
    server?.close();
    app.exit(process.exitCode || 0);
  }
});
