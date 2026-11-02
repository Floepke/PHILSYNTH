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

// Desktop app: the main process shows the dialogs (and stores the folders per kind).
{
  const calls = [];
  const win = {
    modsynthFiles: {
      saveFile: async (...args) => { calls.push(['save', ...args]); return { name: 'x.clip' }; },
      openFile: async (...args) => { calls.push(['open', ...args]); return { name: 'y.phmod', text: 't' }; },
    },
    showSaveFilePicker() { throw new Error('not used'); },
  };
  assert.deepEqual(await saveTextFile('clip', 'x.clip', 'data', win), { name: 'x.clip' });
  assert.deepEqual(await openTextFile('module', win), { name: 'y.phmod', text: 't' });
  assert.deepEqual(calls, [['save', 'clip', 'x.clip', 'data'], ['open', 'module']]);
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
