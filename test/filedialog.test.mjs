import assert from 'node:assert/strict';
import { saveTextFile, openTextFile, openModuleFile, saveModuleFile, openMediaFile, openMidiFile, openAudioClipFile, hasMediaDialog } from '../src/filedialog.js';
import { prepareModuleArchive, readModuleArchive } from '../src/projectarchive.js';
import { fsaBackend } from '../src/projectfile.js';

const abort = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });

{
  let saved = new File([], 'test.phmod'), aborted = false;
  const handle = {
    name: 'test.phmod',
    getFile: async () => saved,
    createWritable: async () => {
      const chunks = [];
      return { write: async bytes => chunks.push(bytes.slice()), close: async () => { saved = new File(chunks, 'test.phmod'); }, abort: async () => { aborted = true; } };
    },
  };
  const win = { showSaveFilePicker: async () => handle, showOpenFilePicker: async () => [handle] };
  const data = { modules: [{ id: 1, type: 'OSC', x: 0, y: 0 }], cables: [] };
  assert.deepEqual(await saveModuleFile('test.phmod', prepareModuleArchive(data), win), { name: 'test.phmod' });
  const file = await openModuleFile(win);
  assert.deepEqual((await readModuleArchive(file.blob)).data.modules, data.modules);
  await assert.rejects(saveModuleFile('test.phmod', { writeTo: async () => { throw new Error('disk full'); } }, win), /disk full/);
  assert.equal(aborted, true);
  win.showOpenFilePicker = async () => { throw abort(); };
  assert.equal(await openModuleFile(win), null);
}

{
  const file = new File(['audio'], 'voice.mp4');
  let options;
  const win = { showOpenFilePicker: async (value) => { options = value; return [{ getFile: async () => file }]; } };
  const result = await openAudioClipFile(win);
  assert.equal(result.file, file);
  assert.equal(options.id, 'audio-clip');
  assert.ok(Object.values(options.types[0].accept)[0].includes('.mp4'));
  await result.cleanup();
  win.showOpenFilePicker = async () => { throw abort(); };
  assert.equal(await openAudioClipFile(win), null);
}

{
  const bytes = new Uint8Array([0, 128, 255]);
  const file = { name: 'song.mid', size: bytes.length, arrayBuffer: async () => bytes.buffer };
  let opts;
  const win = { showOpenFilePicker: async (o) => { opts = o; return [{ getFile: async () => file }]; } };
  assert.deepEqual(await openMidiFile(win), { name: file.name, data: bytes.buffer });
  assert.equal(opts.id, 'midi');
  assert.deepEqual(opts.types[0].accept['audio/midi'], ['.mid', '.midi']);
  win.showOpenFilePicker = async () => { throw abort(); };
  assert.equal(await openMidiFile(win), null);
  win.showOpenFilePicker = async () => [{ getFile: async () => ({ ...file, size: 33 * 1024 * 1024 }) }];
  await assert.rejects(openMidiFile(win), /too large/);
  win.showOpenFilePicker = async () => { throw new Error('denied'); };
  await assert.rejects(openMidiFile(win), /denied/);

  const desktop = { modsynthFiles: { openBinary: async (kind, path) => ({ kind, path, data: bytes }) } };
  assert.deepEqual(await openMidiFile(desktop, async (_files, o) => {
    assert.equal(o.dialog, 'midi');
    assert.deepEqual(o.exts, ['.mid', '.midi']);
    return { path: '/music/song.mid' };
  }), { kind: 'midi', path: '/music/song.mid', data: bytes });
  assert.equal(await openMidiFile(desktop, async () => null), null);

  let input;
  const fallback = { document: { createElement: () => (input = Object.assign(new EventTarget(), {
    files: [file], click() { queueMicrotask(() => this.dispatchEvent(new Event('change'))); },
  })) } };
  assert.deepEqual(await openMidiFile(fallback), { name: file.name, data: bytes.buffer });
  assert.equal(input.accept, '.mid,.midi');
  fallback.document.createElement = () => Object.assign(new EventTarget(), {
    click() { queueMicrotask(() => this.dispatchEvent(new Event('cancel'))); },
  });
  assert.equal(await openMidiFile(fallback), null);
}

// Chromium: each kind of file has its own picker id, so the browser reopens the folder last used for it.
{
  const calls = [];
  let written = '';
  const win = {
    async showSaveFilePicker(opts) {
      calls.push(['save', opts]);
      return { name: 'Riff.clip', async createWritable() { return { write: async (t) => { written = t; }, close: async () => {} }; } };
    },
    async showOpenFilePicker(opts) {
      calls.push(['open', opts]);
      return [{ getFile: async () => ({ name: 'Lead.phmod', text: async () => '{"x":1}' }) }];
    },
  };
  assert.deepEqual(await saveTextFile('clip', 'Riff.clip', 'clip data', win), { name: 'Riff.clip' });
  assert.equal(written, 'clip data');
  await assert.rejects(openTextFile('module', win), /module picker/);
  await assert.rejects(saveTextFile('module', 'Lead.phmod', '', win), /archives/);
  await openTextFile('clip', win);
  assert.deepEqual(calls.map(([k, o]) => [k, o.id, ...Object.values(o.types[0].accept)[0]]), [
    ['save', 'clip', '.clip'], ['open', 'clip', '.clip'],
  ]);
  assert.equal(calls[0][1].suggestedName, 'Riff.clip');

  // cancelling a dialog is not an error
  win.showSaveFilePicker = async () => { throw abort(); };
  win.showOpenFilePicker = async () => { throw abort(); };
  assert.equal(await saveTextFile('clip', 'a.clip', '', win), null);
  assert.equal(await openTextFile('clip', win), null);
}

// Desktop app: the app's own dialog picks the path (start folder per kind), the main process
// reads / writes it.
{
  const calls = [];
  const picks = [];
  const win = {
    modsynthFiles: {
      saveFile: async (...args) => { calls.push(['save', ...args]); return { name: 'x.clip' }; },
      openFile: async (...args) => { calls.push(['open', ...args]); return { name: args[1].split('/').pop(), text: 't' }; },
    },
    showSaveFilePicker() { throw new Error('not used'); },
  };
  let chosen = { path: '/music/x.clip', name: 'x.clip' };
  const pick = async (files, opts) => {
    assert.equal(files, win.modsynthFiles);
    picks.push(opts);
    return chosen;
  };
  assert.deepEqual(await saveTextFile('clip', 'x.clip', 'data', win, pick), { name: 'x.clip' });
  chosen = { path: '/music/y.clip', name: 'y.clip' };
  assert.deepEqual(await openTextFile('clip', win, pick), { name: 'y.clip', text: 't' });
  assert.deepEqual(calls, [['save', 'clip', '/music/x.clip', 'data'], ['open', 'clip', '/music/y.clip']]);
  assert.deepEqual(picks.map((o) => [o.mode, o.dialog, o.exts, o.saveExt]), [
    ['save', 'clip', ['.clip'], '.clip'], ['open', 'clip', ['.clip'], undefined],
  ]);
  assert.equal(picks[0].suggestedName, 'x.clip');
  // cancelled in the dialog: nothing is read or written
  chosen = null;
  assert.equal(await saveTextFile('clip', 'x.clip', 'data', win, pick), null);
  assert.equal(await openTextFile('clip', win, pick), null);
  assert.equal(calls.length, 2);
  // TUNING's Load Tuning: Scala files through the same dialog
  chosen = { path: '/scales/a.scl', name: 'a.scl' };
  await openTextFile('scala', win, pick);
  assert.deepEqual(calls.at(-1), ['open', 'scala', '/scales/a.scl']);
  assert.deepEqual([picks.at(-1).dialog, picks.at(-1).exts], ['scala', ['.scl', '.scala', '.txt']]);
}

// Desktop app projects: the dialog's path goes to the main process; Save writes without a dialog.
{
  const { electronBackend } = await import('../src/projectfile.js');
  const calls = [];
  const first = Uint8Array.of(1), second = Uint8Array.of(2);
  const files = {
    open: async (path) => { calls.push(['open', path]); return { name: 'a.phproject', ref: path, bytes: first }; },
    save: async (ref, bytes) => { calls.push(['save', ref, bytes]); return { name: 'a.phproject', ref }; },
    saveAs: async (path, bytes) => { calls.push(['saveAs', path, bytes]); return { name: 'b.phproject', ref: path }; },
  };
  const picks = [];
  let chosen = { path: '/p/a.phproject', name: 'a.phproject' };
  const b = electronBackend(files, async (_f, opts) => { picks.push(opts); return chosen; });
  assert.equal((await b.open()).ref, '/p/a.phproject');
  chosen = { path: '/p/b.phproject', name: 'b.phproject' };
  assert.equal((await b.saveAs('Song.phproject', async () => first)).ref, '/p/b.phproject');
  await b.save('/p/b.phproject', async () => second);
  assert.deepEqual(calls, [['open', '/p/a.phproject'], ['saveAs', '/p/b.phproject', first], ['save', '/p/b.phproject', second]]);
  assert.deepEqual(picks.map((o) => [o.mode, o.dialog, o.suggestedName]), [['open', 'project-open', undefined], ['save', 'project-save', 'Song.phproject']]);
  assert.ok(picks[0].exts.includes('.mds'), 'older projects open too');
  chosen = null;
  assert.equal(await b.open(), null);
  assert.equal(await b.saveAs('x', () => assert.fail('do not encode a cancelled save')), null);
  assert.equal(calls.length, 3);
}

// Projects: opening and saving remember their own folders.
{
  const ids = [];
  const win = {
    async showOpenFilePicker(opts) {
      ids.push(opts.id);
      return [{ getFile: async () => new File(['{}'], 'a.phproject') }];
    },
    async showSaveFilePicker(opts) {
      ids.push(opts.id);
      return { name: 'b.phproject', getFile: async () => new File([], 'b.phproject'),
        async createWritable() { return { write: async () => {}, close: async () => {} }; } };
    },
  };
  const backend = fsaBackend(win);
  assert.equal((await backend.open()).name, 'a.phproject');
  assert.equal((await backend.saveAs('b.phproject', async () => Uint8Array.of(1))).name, 'b.phproject');
  assert.deepEqual(ids, ['project-open', 'project-save']);
}

console.log('filedialog tests passed');

// Desktop app: SAMPLER / WAVETABLE / IMAGE SAMPLER load audio / pictures through the app's dialog
{
  const calls = [];
  const picks = [];
  const win = {
    File,
    modsynthFiles: { openBinary: async (...args) => { calls.push(args); return { name: 'Kick.WAV', data: new Uint8Array([1, 2, 3]) }; } },
  };
  assert.ok(hasMediaDialog(win));
  assert.ok(!hasMediaDialog({ modsynthFiles: { openFile() {} } }), 'older desktop builds / browsers: the file input');
  let chosen = { path: '/samples/Kick.WAV', name: 'Kick.WAV' };
  const pick = async (_files, opts) => { picks.push(opts); return chosen; };
  const f = await openMediaFile('sample', win, pick);
  assert.deepEqual([f.name, f.type, [...new Uint8Array(await f.arrayBuffer())]], ['Kick.WAV', 'audio/wav', [1, 2, 3]]);
  assert.deepEqual(calls, [['sample', '/samples/Kick.WAV']]);
  assert.equal(picks[0].dialog, 'sample');
  assert.ok(picks[0].exts.includes('.flac') && !picks[0].exts.includes('.wt'));
  await openMediaFile('wavetable', win, pick);
  assert.ok(picks[1].exts.includes('.wt'));
  await openMediaFile('image', win, pick);
  assert.deepEqual([picks[2].dialog, picks[2].exts.slice(0, 3)], ['image', ['.png', '.jpg', '.jpeg']]);
  chosen = null;
  assert.equal(await openMediaFile('image', win, pick), null, 'cancelled: nothing read');
  assert.equal(calls.length, 3);
}
