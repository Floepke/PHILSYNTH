import assert from 'node:assert/strict';
import { createProjectFile, hashText, suggestName, downloadBackend, UNTITLED } from '../src/projectfile.js';
import { unsavedDialog } from '../src/dialogs.js';

// a fake project and storage backend
let project = { patch: 1 };
const files = new Map(); // ref -> text
const calls = [];
let nextOpen = null; // { name, ref, text } | null
let saveAsAnswer = 'file.phproject'; // name chosen in the dialog, null = cancelled
let saveWritable = true;
const backend = {
  async open() { calls.push('open'); return nextOpen; },
  async save(ref, text) {
    calls.push(`save:${ref}`);
    if (!saveWritable) return null;
    files.set(ref, text);
    return { name: ref.split('/').pop(), ref };
  },
  async saveAs(name, text) {
    calls.push(`saveAs:${name}`);
    if (!saveAsAnswer) return null;
    const ref = `/docs/${saveAsAnswer}`;
    files.set(ref, text);
    return { name: saveAsAnswer, ref };
  },
};
const changes = [];
const doc = createProjectFile({
  fingerprint: () => project,
  serialize: () => JSON.stringify(project),
  backend,
  onChange: (info) => changes.push(info),
});

assert.equal(hashText('abc'), hashText('abc'));
assert.notEqual(hashText('abc'), hashText('abd'));
assert.equal(suggestName('song.json'), 'song.phproject');
assert.equal(suggestName('song.phproject'), 'song.phproject');
assert.equal(suggestName('song.mds'), 'song.phproject');
assert.equal(suggestName(''), `${UNTITLED}.phproject`);

// before anything is known the project counts as unsaved; New makes it clean
assert.equal(doc.isDirty(), true);
doc.reset();
assert.equal(doc.isDirty(), false);
assert.deepEqual(changes.pop(), { name: UNTITLED, ref: null, dirty: false });
project = { patch: 2 };
assert.equal(doc.isDirty(), true, 'edits make it dirty');
project = { patch: 1 };
assert.equal(doc.isDirty(), false, 'undoing back to the saved state is clean again');

// Save without a file is Save As; cancelling keeps everything
project = { patch: 3 };
saveAsAnswer = null;
assert.equal(await doc.save(), null);
assert.deepEqual(calls.splice(0), [`saveAs:${UNTITLED}.phproject`]);
assert.equal(doc.isDirty(), true);
saveAsAnswer = 'song.phproject';
assert.equal(await doc.save(), 'song.phproject');
assert.deepEqual(calls.splice(0), [`saveAs:${UNTITLED}.phproject`]);
assert.equal(files.get('/docs/song.phproject'), '{"patch":3}');
assert.equal(doc.isDirty(), false);
assert.equal(doc.name, 'song.phproject');

// Save writes to the same file without a dialog
project = { patch: 4 };
assert.equal(await doc.save(), 'song.phproject');
assert.deepEqual(calls.splice(0), ['save:/docs/song.phproject']);
assert.equal(files.get('/docs/song.phproject'), '{"patch":4}');
assert.equal(doc.isDirty(), false);

// a file that can no longer be written falls back to Save As
project = { patch: 5 };
saveWritable = false;
saveAsAnswer = 'other.phproject';
assert.equal(await doc.save(), 'other.phproject');
assert.deepEqual(calls.splice(0), ['save:/docs/song.phproject', 'saveAs:song.phproject']);
saveWritable = true;

// Save As always asks, suggesting the current name
assert.equal(await doc.saveAs(), 'other.phproject');
assert.deepEqual(calls.splice(0), ['saveAs:other.phproject']);

// edits made while the save dialog is open stay unsaved
let finish;
const slow = createProjectFile({
  fingerprint: () => project,
  serialize: () => JSON.stringify(project),
  backend: { saveAs: () => new Promise((resolve) => { finish = resolve; }) },
});
project = { patch: 6 };
const pending = slow.saveAs();
project = { patch: 7 };
finish({ name: 'x.phproject', ref: '/x.phproject' });
await pending;
assert.equal(slow.isDirty(), true);

// Open: loads the data and is clean; a cancelled dialog changes nothing
nextOpen = null;
assert.equal(await doc.open(() => assert.fail('nothing to load')), null);
nextOpen = { name: 'loaded.phproject', ref: '/docs/loaded.phproject', text: '{"patch":8}' };
let loaded = null;
assert.equal(await doc.open(async (data) => { loaded = data; project = data; }), 'loaded.phproject');
assert.deepEqual(loaded, { patch: 8 });
assert.equal(doc.isDirty(), false);
assert.equal(doc.ref, '/docs/loaded.phproject');
calls.splice(0);

// older .mds / .json projects are not overwritten: Save asks for a new .phproject file
nextOpen = { name: 'old.mds', ref: '/docs/old.mds', text: '{"patch":9}' };
await doc.open(async (data) => { project = data; });
assert.equal(doc.ref, null);
saveAsAnswer = 'old.phproject';
calls.splice(0);
await doc.save();
assert.deepEqual(calls.splice(0), ['saveAs:old.phproject']);

// invalid files do not change the document
nextOpen = { name: 'bad.phproject', ref: '/bad.phproject', text: 'not json' };
await assert.rejects(doc.open(async () => {}));
assert.equal(doc.name, 'old.phproject');

// the autosave keeps name, file and saved state; old autosaves without it count as unsaved
project = { patch: 10 };
const stored = JSON.parse(JSON.stringify(doc.toJSON()));
const again = createProjectFile({ fingerprint: () => project, serialize: () => '', backend });
again.restore(stored);
assert.equal(again.name, 'old.phproject');
assert.equal(again.ref, '/docs/old.phproject');
assert.equal(again.isDirty(), true);
project = { patch: 9 };
assert.equal(again.isDirty(), false);
again.restore(undefined);
assert.equal(again.name, UNTITLED);
assert.equal(again.ref, null);
assert.equal(again.isDirty(), true);

// fallback: a download for every save
{
  const clicks = [];
  globalThis.URL.createObjectURL = () => 'blob:x';
  globalThis.URL.revokeObjectURL = () => {};
  const fakeDoc = { createElement: () => ({ click() { clicks.push(this.download); } }) };
  const dl = downloadBackend({}, fakeDoc);
  assert.deepEqual(await dl.saveAs('a.phproject', '{}'), { name: 'a.phproject', ref: 'download:a.phproject' });
  assert.deepEqual(await dl.save('download:a.phproject', '{}'), { name: 'a.phproject', ref: 'download:a.phproject' });
  assert.deepEqual(clicks, ['a.phproject', 'a.phproject']);
}

// Yes / No / Cancel dialog: Escape cancels; Enter = Yes, Backspace = No
{
  class Dialog extends EventTarget {
    showModal() {}
    close(value = '') { this.returnValue = value; this.dispatchEvent(new Event('close')); }
  }
  const dialog = new Dialog();
  const els = new Map(['unsaved-title', 'unsaved-text'].map((id) => [id, { textContent: '' }]));
  els.set('unsaved-dialog', dialog);
  globalThis.document = { getElementById: (id) => els.get(id) };
  for (const [value, answer] of [['yes', 'yes'], ['no', 'no'], ['cancel', 'cancel'], ['', 'cancel']]) {
    const r = unsavedDialog('song.phproject', { action: 'starting a new project' });
    assert.equal(els.get('unsaved-title').textContent, 'Save changes to "song.phproject"?');
    assert.match(els.get('unsaved-text').textContent, /starting a new project/);
    dialog.close(value);
    assert.equal(await r, answer);
  }
  // keys answer whichever button has focus: Enter = Yes, Backspace = No (Escape is the native cancel)
  for (const [key, answer] of [['Enter', 'yes'], ['Backspace', 'no']]) {
    const r = unsavedDialog('song.phproject');
    const e = Object.assign(new Event('keydown', { cancelable: true }), { key });
    dialog.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true);
    assert.equal(await r, answer);
  }
  const r = unsavedDialog('song.phproject');
  dialog.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Backspace', metaKey: true }));
  dialog.close('');
  assert.equal(await r, 'cancel', 'a key with a modifier is not an answer');
}
console.log('project file tests passed');
