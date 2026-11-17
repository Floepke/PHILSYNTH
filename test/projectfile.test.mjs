import assert from 'node:assert/strict';
import { createProjectFile, hashText, suggestName, downloadBackend, UNTITLED } from '../src/projectfile.js';
import { unsavedDialog } from '../src/dialogs.js';
import { Engine } from '../src/engine.js';
import { PatchRuntime } from '../src/patch.js';
import { addAutoClip, addClip, cloneClip, setSig } from '../src/song.js';
import { addSample, withSamples } from '../src/samples.js';
import { jsonFileText } from '../src/fileformat.js';
import { dspTestHost } from './dsphost.mjs';

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
// Exercise the real project serializer and loader together, not just the file-dialog backend.
async function projectEngine() {
  const engine = new Engine();
  const { dsp } = dspTestHost();
  engine.ctx = { currentTime: 0 };
  engine.dsp = dsp;
  engine.root = await PatchRuntime.create(engine, dsp.destination);
  return engine;
}

{
  const source = await projectEngine();
  const target = await projectEngine();
  try {
    const filter = await source.root.addModule('FILTER', { x: 120, y: 80, color: '#123456', name: 'Tone' });
    source.root.setParam(filter.id, 'cutoff', 1234);
    source.root.connect(filter.id, 0);
    const sampleId = addSample({ rate: 48000, channels: [Float32Array.of(0, 0.25, -0.5)] });
    const sampler = await source.root.addModule('SAMPLER');
    source.root.setState(sampler.id, { sampleId, name: 'Test' });
    const patch = await source.root.addModule('PATCH');
    const inner = patch.inst.patch;
    const osc = await inner.addModule('OSC');
    inner.connect(osc.id, 0);
    const innerClip = addClip(inner.song, { start: 2, length: 2, target: osc.id });
    innerClip.notes.push({ pitch: 62.25, start: 0.5, length: 1, vel: 0.7 });

    const clip = addClip(source.song, { start: 1, length: 4, target: sampler.id });
    clip.name = 'Lead';
    clip.color = '#aabbcc';
    clip.notes.push({ pitch: 60.25, start: 0.5, length: 2, vel: 0.8,
      vels: [{ t: 1, v: 0.4, r: 0 }], bends: [{ t: 1, d: 0.5, r: 0 }] });
    const clone = cloneClip(source.song, clip);
    clone.start = 8;
    const auto = addAutoClip(source.song, { start: 0, length: 4, y: 34, target: filter.id, controller: 2 });
    auto.points.push({ t: 0, v: 0.25, r: 0 }, { t: 2, v: 0.75, r: 0.5 });
    source.song.selected = clip.id;
    setSig(source.song, 0, 3, 4);

    const saved = withSamples(source.saveProject());
    assert.ok(saved.samples[sampleId], 'referenced sample is embedded in the project');
    await target.loadProject(JSON.parse(jsonFileText(saved)));
    const restored = withSamples(target.saveProject());
    assert.deepEqual(restored, saved, 'modules, nested patch, clips, automation and samples survive save/load');
    const restoredFilter = target.root.modules.get(filter.id);
    assert.equal(restoredFilter.values.cutoff, 1234);
    assert.equal(restoredFilter.name, 'Tone');
    assert.equal(restoredFilter.color, '#123456');
    assert.ok(target.root.cables.some((c) => c.from === filter.id && c.to === 0));
    assert.deepEqual(target.root.modules.get(sampler.id).state, { sampleId, name: 'Test' });
    const restoredSource = target.song.clips.find((c) => c.id === clip.id);
    const restoredClone = target.song.clips.find((c) => c.id === clone.id);
    assert.deepEqual(restoredSource.notes, clip.notes, 'note pitch, velocity and curves survive');
    assert.deepEqual(target.song.clips.find((c) => c.id === auto.id).points, auto.points, 'automation survives');
    assert.equal(restoredSource.notes, restoredClone.notes, 'loaded linked clones share their notes');
    assert.deepEqual(target.root.modules.get(patch.id).inst.patch.song.clips[0].notes, innerClip.notes);
  } finally {
    source.root.destroy();
    target.root.destroy();
  }
}

// Old-format projects without later optional fields keep their sound-relevant defaults.
{
  const engine = await projectEngine();
  try {
    const old = {
      format: 'modsynth', version: 1,
      patch: { modules: [
        { id: 0, type: 'OUT', x: 560, y: 180, values: { bpm: 137 } },
        { id: 1, type: 'FILTER', x: 0, y: 0, values: { cutoff: 2500 } },
      ], cables: [{ from: 1, to: 0 }] },
      song: { clips: [{ id: 1, start: 0, length: 4, y: 0, target: 1,
        notes: [{ pitch: 60, start: 0, length: 1, vel: 0.8 }] }] },
    };
    await engine.loadProject(old);
    assert.equal(engine.root.modules.get(0).values.bpm, 137);
    assert.equal(engine.root.modules.get(1).values.cutoff, 2500);
    assert.equal(engine.root.tempoStep, 1, 'old tempo automation keeps integer precision');
    assert.equal(engine.song.clips[0].color, null);
    assert.deepEqual(engine.song.clips[0].notes, old.song.clips[0].notes);
    const saved = engine.saveProject();
    assert.equal(saved.format, 'philsynth');
    assert.equal('tempoStep' in saved.patch, false, 'resaving does not switch legacy tempo behavior');
    await engine.loadProject(JSON.parse(jsonFileText(saved)));
    assert.equal(engine.root.tempoStep, 1);
    assert.equal(engine.root.modules.get(0).values.bpm, 137);
    assert.deepEqual(engine.song.clips[0].notes, old.song.clips[0].notes);
  } finally {
    engine.root.destroy();
  }
}

console.log('project file tests passed');
