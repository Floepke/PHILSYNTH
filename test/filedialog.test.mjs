import assert from 'node:assert/strict';
import { saveTextFile, openTextFile } from '../src/filedialog.js';
import { fsaBackend } from '../src/projectfile.js';

const abort = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });

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
  assert.deepEqual(await openTextFile('module', win), { name: 'Lead.phmod', text: '{"x":1}' });
  await saveTextFile('module', 'Lead.phmod', '', win);
  await openTextFile('clip', win);
  assert.deepEqual(calls.map(([k, o]) => [k, o.id, ...Object.values(o.types[0].accept)[0]]), [
    ['save', 'clip', '.clip'], ['open', 'module', '.phmod', '.synth'], ['save', 'module', '.phmod'], ['open', 'clip', '.clip'],
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
      openFile: async (...args) => { calls.push(['open', ...args]); return { name: 'y.phmod', text: 't' }; },
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
  chosen = { path: '/music/y.phmod', name: 'y.phmod' };
  assert.deepEqual(await openTextFile('module', win, pick), { name: 'y.phmod', text: 't' });
  assert.deepEqual(calls, [['save', 'clip', '/music/x.clip', 'data'], ['open', 'module', '/music/y.phmod']]);
  assert.deepEqual(picks.map((o) => [o.mode, o.dialog, o.exts, o.saveExt]), [
    ['save', 'clip', ['.clip'], '.clip'], ['open', 'module', ['.phmod', '.synth'], undefined],
  ]);
  assert.equal(picks[0].suggestedName, 'x.clip');
  // cancelled in the dialog: nothing is read or written
  chosen = null;
  assert.equal(await saveTextFile('clip', 'x.clip', 'data', win, pick), null);
  assert.equal(await openTextFile('module', win, pick), null);
  assert.equal(calls.length, 2);
}

// Desktop app projects: the dialog's path goes to the main process; Save writes without a dialog.
{
  const { electronBackend } = await import('../src/projectfile.js');
  const calls = [];
  const files = {
    open: async (path) => { calls.push(['open', path]); return { name: 'a.phproject', ref: path, text: '{}' }; },
    save: async (ref, text) => { calls.push(['save', ref, text]); return { name: 'a.phproject', ref }; },
    saveAs: async (path, text) => { calls.push(['saveAs', path, text]); return { name: 'b.phproject', ref: path }; },
  };
  const picks = [];
  let chosen = { path: '/p/a.phproject', name: 'a.phproject' };
  const b = electronBackend(files, async (_f, opts) => { picks.push(opts); return chosen; });
  assert.equal((await b.open()).ref, '/p/a.phproject');
  chosen = { path: '/p/b.phproject', name: 'b.phproject' };
  assert.equal((await b.saveAs('Song.phproject', 'T')).ref, '/p/b.phproject');
  await b.save('/p/b.phproject', 'U');
  assert.deepEqual(calls, [['open', '/p/a.phproject'], ['saveAs', '/p/b.phproject', 'T'], ['save', '/p/b.phproject', 'U']]);
  assert.deepEqual(picks.map((o) => [o.mode, o.dialog, o.suggestedName]), [['open', 'project-open', undefined], ['save', 'project-save', 'Song.phproject']]);
  assert.ok(picks[0].exts.includes('.mds'), 'older projects open too');
  chosen = null;
  assert.equal(await b.open(), null);
  assert.equal(await b.saveAs('x', 'y'), null);
  assert.equal(calls.length, 3);
}

// Projects: opening and saving remember their own folders.
{
  const ids = [];
  const win = {
    async showOpenFilePicker(opts) {
      ids.push(opts.id);
      return [{ getFile: async () => ({ name: 'a.phproject', text: async () => '{}' }) }];
    },
    async showSaveFilePicker(opts) {
      ids.push(opts.id);
      return { name: 'b.phproject', async createWritable() { return { write: async () => {}, close: async () => {} }; } };
    },
  };
  const backend = fsaBackend(win);
  assert.equal((await backend.open()).name, 'a.phproject');
  assert.equal((await backend.saveAs('b.phproject', '{}')).name, 'b.phproject');
  assert.deepEqual(ids, ['project-open', 'project-save']);
}

console.log('filedialog tests passed');
