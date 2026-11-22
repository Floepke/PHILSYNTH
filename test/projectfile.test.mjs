import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectFile, hashText, suggestName, downloadBackend, fsaBackend, UNTITLED } from '../src/projectfile.js';
import { unsavedDialog } from '../src/dialogs.js';
import { Engine } from '../src/engine.js';
import { PatchRuntime } from '../src/patch.js';
import { addAudioClip, addAutoClip, addClip, cloneClip, emptySong, setSig } from '../src/song.js';
import { addImage, addSample, getSample, importSamples, withSamples } from '../src/samples.js';
import { prepareCurrentProjectArchive, prepareProjectArchive, readProjectArchive, readStreamedProjectArchive } from '../src/projectarchive.js';
import { crc32, readZip, writeZip } from '../src/projectzip.js';
import { copyZipEntry, readZipStream, writeZipStream } from '../src/projectzipstream.js';
import { createHistory } from '../src/history.js';
import { jsonFileText } from '../src/fileformat.js';
import { dspTestHost } from './dsphost.mjs';
import { createProjectStreamWriter, openProjectStreamReader } from '../electron/projectstream.mjs';

// a fake project and storage backend
const encode = (text) => new TextEncoder().encode(text);
const makeProject = (marker) => ({ format: 'philsynth', version: 1, patch: { modules: [], marker } });
let project = { patch: 1 };
const files = new Map(); // ref -> text
const calls = [];
let nextOpen = null;
let saveAsAnswer = 'file.phproject'; // name chosen in the dialog, null = cancelled
let saveWritable = true;
const backend = {
  async open() { calls.push('open'); return nextOpen; },
  async save(ref, serialize) {
    calls.push(`save:${ref}`);
    if (!saveWritable) return null;
    files.set(ref, await serialize());
    return { name: ref.split('/').pop(), ref };
  },
  async saveAs(name, serialize) {
    calls.push(`saveAs:${name}`);
    if (!saveAsAnswer) return null;
    const ref = `/docs/${saveAsAnswer}`;
    files.set(ref, await serialize());
    return { name: saveAsAnswer, ref };
  },
};
const changes = [];
const doc = createProjectFile({
  fingerprint: () => project,
  serialize: () => prepareProjectArchive(makeProject(project.patch)),
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
assert.equal((await readProjectArchive(files.get('/docs/song.phproject'))).data.patch.marker, 3);
assert.equal(doc.isDirty(), false);
assert.equal(doc.name, 'song.phproject');

// Save writes to the same file without a dialog
project = { patch: 4 };
assert.equal(await doc.save(), 'song.phproject');
assert.deepEqual(calls.splice(0), ['save:/docs/song.phproject']);
assert.equal((await readProjectArchive(files.get('/docs/song.phproject'))).data.patch.marker, 4);
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
  serialize: () => prepareProjectArchive(makeProject(project.patch)),
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
nextOpen = { name: 'loaded.phproject', ref: '/docs/loaded.phproject', bytes: await prepareProjectArchive(makeProject(8))() };
let loaded = null;
assert.equal(await doc.open(async (data) => { loaded = data; project = { patch: data.patch.marker }; }), 'loaded.phproject');
assert.equal(loaded.patch.marker, 8);
assert.equal(doc.isDirty(), false);
assert.equal(doc.ref, '/docs/loaded.phproject');
calls.splice(0);

// older .mds / .json projects are not overwritten: Save asks for a new .phproject file
for (const name of ['old.phproject', 'old.mds']) {
  nextOpen = { name, ref: `/docs/${name}`, bytes: encode(JSON.stringify({ ...makeProject(9), format: 'modsynth', version: undefined })) };
  await doc.open(async (data) => { project = { patch: data.patch.marker }; });
  assert.equal(doc.ref, null);
  if (name === 'old.phproject') {
    calls.splice(0);
    saveAsAnswer = null;
    assert.equal(await doc.save(), null);
    assert.deepEqual(calls.splice(0), ['saveAs:old (v3).phproject']);
  }
}
assert.equal(doc.ref, null);
saveAsAnswer = 'old.phproject';
calls.splice(0);
await doc.save();
assert.deepEqual(calls.splice(0), ['saveAs:old.phproject']);

// invalid files do not change the document
const corrupted = files.get('/docs/old.phproject').slice();
corrupted[42] ^= 1;
nextOpen = { name: 'bad.phproject', ref: '/bad.phproject', bytes: corrupted };
await assert.rejects(doc.open(async () => assert.fail('damaged projects must not reach the engine')), /Corrupt project entry/);
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
again.restore({ name: 'legacy.phproject', ref: '/docs/legacy.phproject', savedHash: stored.savedHash });
assert.equal(again.ref, null, 'a pre-v2 autosave must not overwrite its original file');

// fallback: a download for every save
{
  const clicks = [];
  const blobs = [];
  globalThis.URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:x'; };
  globalThis.URL.revokeObjectURL = () => {};
  const fakeDoc = { createElement: () => ({ click() { clicks.push(this.download); } }) };
  const dl = downloadBackend({}, fakeDoc);
  const archive = prepareProjectArchive(makeProject(10));
  assert.deepEqual(await dl.saveAs('a.phproject', archive), { name: 'a.phproject', ref: 'download:a.phproject' });
  assert.deepEqual(await dl.save('download:a.phproject', archive), { name: 'a.phproject', ref: 'download:a.phproject' });
  assert.deepEqual(clicks, ['a.phproject', 'a.phproject']);
  assert.equal((await readProjectArchive(new Uint8Array(await blobs[0].arrayBuffer()))).data.patch.marker, 10);
  const input = Object.assign(new EventTarget(), {
    files: [new File([blobs[0]], 'a.phproject')], click() { this.dispatchEvent(new Event('change')); },
  });
  assert.equal((await readProjectArchive((await downloadBackend(input, fakeDoc).open()).bytes)).version, 2);
}

// Current audio-free projects use v3, including in browsers with download-only saves.
{
  const project = makeProject(42);
  const archive = prepareCurrentProjectArchive(project);
  assert.equal(archive.diskVersion, 3);
  const blob = await archive();
  const entries = await readZipStream(blob);
  const chunks = [];
  await copyZipEntry(entries.get('project.json'), (part) => chunks.push(part.slice()));
  const manifest = JSON.parse(await new Blob(chunks).text());
  assert.equal(manifest.version, 3);
  assert.deepEqual(manifest.audioFiles, {});
  assert.equal('recordings' in manifest, false);
  assert.equal((await readStreamedProjectArchive(blob)).data.patch.marker, 42);
  const fakeDoc = { createElement: () => ({ click() {} }) };
  const dl = downloadBackend({}, fakeDoc);
  assert.equal((await dl.saveAs('v3.phproject', archive)).name, 'v3.phproject');
  const input = Object.assign(new EventTarget(), {
    files: [new File([blob], 'v3.phproject')], click() { this.dispatchEvent(new Event('change')); },
  });
  const opened = await downloadBackend(input, fakeDoc).open();
  assert.equal((await readStreamedProjectArchive(opened.blob)).version, 3);
  const oldManifest = { ...manifest, recordings: manifest.audioFiles };
  delete oldManifest.audioFiles;
  const legacyChunks = [];
  await writeZipStream([{ path: 'project.json', blob: new Blob([JSON.stringify(oldManifest)]) }],
    (part) => legacyChunks.push(part.slice()));
  await assert.rejects(readStreamedProjectArchive(new Blob(legacyChunks)), /Invalid PHILSYNTH ZIP manifest/);
  let saved, loaded;
  const document = createProjectFile({
    fingerprint: () => project,
    serialize: () => prepareCurrentProjectArchive(project),
    backend: {
      async saveAs(_name, encoder) {
        const parts = [];
        await encoder.writeTo((part) => parts.push(part.slice()));
        saved = new Blob(parts);
        return { name: 'v3.phproject', ref: '/v3.phproject' };
      },
      async open() { return { name: 'v3.phproject', ref: '/v3.phproject', blob: saved }; },
    },
  });
  await document.saveAs();
  assert.equal(document.toJSON().diskVersion, 3);
  await document.open((data) => { loaded = data; });
  assert.equal(loaded.patch.marker, 42);
  assert.equal(document.ref, '/v3.phproject');
}

// File System Access opens bytes, writes ZIP, and will not replace a legacy project.
{
  const legacy = new File([JSON.stringify(makeProject(8))], 'legacy.phproject');
  let file = legacy, written;
  const handle = {
    name: file.name,
    async getFile() { return file; },
    async createWritable() {
      return {
        async write(bytes) { written = bytes; },
        async close() { file = new File([written], handle.name); },
      };
    },
    async queryPermission() { return 'granted'; },
  };
  const fsa = fsaBackend({ showOpenFilePicker: async () => [handle], showSaveFilePicker: async () => handle });
  assert.equal((await readProjectArchive((await fsa.open()).bytes)).version, 1);
  await assert.rejects(fsa.saveAs(handle.name, prepareProjectArchive(makeProject(9))), /preserve the existing project/);
  assert.equal(file, legacy);
  file = new File([], handle.name);
  const { ref } = await fsa.saveAs(handle.name, prepareProjectArchive(makeProject(10)));
  assert.equal((await readProjectArchive((await fsa.open()).bytes)).data.patch.marker, 10);
  await fsa.save(ref, prepareProjectArchive(makeProject(11)));
  assert.equal((await readProjectArchive(written)).data.patch.marker, 11);
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
    const sampleId = addSample({ rate: 48000.25, channels: [Float32Array.of(0, 0.25, -0.5), Float32Array.of(-1, 0.5, 1)] });
    const sampler = await source.root.addModule('SAMPLER');
    source.root.setState(sampler.id, { sampleId, name: 'Test' });
    const patch = await source.root.addModule('PATCH');
    const inner = patch.inst.patch;
    const shared = await inner.addModule('SAMPLER');
    inner.setState(shared.id, { sampleId, name: 'Shared' });
    const imageId = addImage({ width: 2, height: 2, rgb: Uint8Array.of(1, 2, 3, 4, 5, 6, 250, 128, 0, 255, 0, 128) });
    const image = await inner.addModule('IMAGESAMPLER');
    inner.setState(image.id, { imageId, name: 'Pixels' });
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
    const archive = await prepareProjectArchive({ ...source.saveProject(), view: { path: [patch.id] } })();
    const entries = readZip(archive);
    assert.equal(entries.size, 3, 'shared media is written once');
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('project.json')));
    assert.equal(manifest.version, 2);
    assert.equal('samples' in manifest, false, 'no Base64 data in the manifest');
    const reopened = (await readProjectArchive(archive)).data;
    assert.deepEqual(reopened.view, { path: [patch.id] });
    assert.equal(reopened.samples.get(sampleId).rate, 48000.25);
    assert.deepEqual(reopened.samples.get(sampleId).pcm, getSample(sampleId).pcm);
    assert.deepEqual(reopened.samples.get(imageId).rgb, getSample(imageId).rgb);
    importSamples(new Map([['archive-test-audio', reopened.samples.get(sampleId)], ['archive-test-image', reopened.samples.get(imageId)]]));
    assert.deepEqual(getSample('archive-test-audio').channels, getSample(sampleId).channels);
    assert.deepEqual(getSample('archive-test-image').rgb, getSample(imageId).rgb);
    await target.loadProject(reopened);
    assert.deepEqual(withSamples(target.saveProject()), saved);
    const history = createHistory({ capture: () => target.saveProject(), restore: (state) => target.loadProject(state) });
    history.reset();
    target.root.setState(sampler.id, { sampleId: null, name: '' });
    history.record();
    assert.equal(await history.travel(-1), true);
    assert.deepEqual(target.root.modules.get(sampler.id).state, { sampleId, name: 'Test' });
    assert.equal(await history.travel(1), true);
    assert.equal(target.root.modules.get(sampler.id).state.sampleId, null);
    assert.equal(await history.travel(-1), true);
    const imagePath = manifest.assets[imageId].path;
    const badPng = entries.get(imagePath).slice();
    badPng[0] = 0;
    entries.set(imagePath, badPng);
    await assert.rejects(readProjectArchive(writeZip(entries)), /Invalid project PNG/);
    entries.delete(imagePath);
    await assert.rejects(readProjectArchive(writeZip(entries)), /Project media is missing/);
    entries.set('project.json', encode(JSON.stringify({ ...manifest, version: 3 })));
    await assert.rejects(readProjectArchive(writeZip(entries)), /Unsupported PHILSYNTH project version: 3/);
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

// Batch conversion preserves paths and reads samples from each individual project.
{
  const dir = await mkdtemp(join(tmpdir(), 'philsynth-convert-test-'));
  try {
    const source = join(dir, 'Old Projects'), output = join(dir, 'New Projects');
    await mkdir(join(source, 'Nested'), { recursive: true });
    await mkdir(output);
    const legacy = (pcm) => JSON.stringify({
      format: 'modsynth',
      patch: { modules: [{ state: { sampleId: 'shared-id', imageId: 'picture' } }] },
      samples: {
        'shared-id': { rate: 48000, channels: 2, length: 1, data: Buffer.from(new Int16Array(pcm).buffer).toString('base64') },
        picture: { kind: 'image', width: 1, height: 1, data: Buffer.from([8, 193, 21]).toString('base64') },
      },
    });
    const first = legacy([-32768, 32767]), second = legacy([12, -42]);
    await writeFile(join(source, 'First.phproject'), first);
    await writeFile(join(source, 'Nested', 'Second.PHPROJECT'), second);
    await writeFile(join(source, 'Already.phproject'), await prepareProjectArchive(makeProject(1))());
    await writeFile(join(source, 'AlreadyV3.phproject'), new Uint8Array(await (await prepareCurrentProjectArchive(makeProject(1))()).arrayBuffer()));
    await writeFile(join(source, 'Blocked.phproject'), first);
    await writeFile(join(output, 'Blocked.phproject'), 'do not overwrite');
    await writeFile(join(source, 'Broken.phproject'), JSON.stringify({
      ...makeProject(1), patch: { modules: [{ state: { sampleId: 'absent' } }] },
    }));

    const script = fileURLToPath(new URL('../convert-projects.mjs', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [script, ...args, source, output], { encoding: 'utf8' });
    const preview = run('--dry-run');
    assert.match(preview.stdout, /2 would convert, 3 skipped, 1 failed/);
    assert.deepEqual(await readdir(output), ['Blocked.phproject']);
    const result = run();
    assert.equal(result.status, 1, 'a failed project is reported without stopping the others');
    assert.match(result.stderr, /Broken\.phproject.*Project media is missing: absent/);
    assert.match(result.stdout, /2 converted, 3 skipped, 1 failed/);
    assert.equal(await readFile(join(source, 'First.phproject'), 'utf8'), first);
    assert.equal(await readFile(join(source, 'Nested', 'Second.PHPROJECT'), 'utf8'), second);
    assert.equal(await readFile(join(output, 'Blocked.phproject'), 'utf8'), 'do not overwrite');
    assert.deepEqual((await readdir(output)).sort(), ['Blocked.phproject', 'First.phproject', 'Nested']);
    for (const [path, pcm] of [['First.phproject', [-32768, 32767]], ['Nested/Second.PHPROJECT', [12, -42]]]) {
      const { version, data } = await readStreamedProjectArchive(new Blob([await readFile(join(output, path))]));
      assert.equal(version, 3);
      assert.deepEqual([...data.samples.get('shared-id').pcm], pcm);
      assert.deepEqual([...data.samples.get('picture').rgb], [8, 193, 21]);
    }
    assert.match(run().stdout, /0 converted, 5 skipped, 1 failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// Large media can be written incrementally without buffering the archive.
{
  const media = new Uint8Array(2 * 1024 * 1024 + 7);
  for (let i = 0; i < media.length; i++) media[i] = i % 251;
  const chunks = [];
  await writeZipStream([
    { path: 'project.json', blob: new Blob(['{"version":3}']) },
    { path: 'media/audio/1.wav', blob: new Blob([media]) },
  ], async (bytes) => { chunks.push(bytes.slice()); });
  assert.ok(chunks.every((bytes) => bytes.length <= 1024 * 1024), 'writes have bounded size');
  const archive = new Uint8Array(await new Blob(chunks).arrayBuffer());
  const v = new DataView(archive.buffer);
  const zip64Offset = Number(v.getBigUint64(archive.length - 34, true));
  assert.equal(v.getUint32(zip64Offset, true), 0x06064b50);
  const directory = Number(v.getBigUint64(zip64Offset + 48, true));
  assert.equal(v.getUint32(directory, true), 0x02014b50);
  const second = directory + 46 + v.getUint16(directory + 28, true) + v.getUint16(directory + 30, true);
  assert.equal(v.getUint32(second + 16, true), crc32(media), 'streamed CRC covers the full asset');
  const entries = await readZipStream(new Blob([archive]));
  const copied = [];
  await copyZipEntry(entries.get('media/audio/1.wav'), async (bytes) => { copied.push(bytes.slice()); });
  assert.deepEqual(new Uint8Array(await new Blob(copied).arrayBuffer()), media);
  assert.ok(copied.every((bytes) => bytes.length <= 1024 * 1024));
  const corrupt = archive.slice();
  const firstHeader = 30 + 'project.json'.length + 20;
  corrupt[firstHeader] ^= 1;
  const corruptEntries = await readZipStream(new Blob([corrupt]));
  await assert.rejects(copyZipEntry(corruptEntries.get('project.json'), () => {}), /Corrupt project archive entry/);
  const malformed = archive.slice();
  new DataView(malformed.buffer).setBigUint64(second + 46 + 'media/audio/1.wav'.length + 20, 0n, true);
  await assert.rejects(readZipStream(new Blob([malformed])), /Corrupt or unsupported/);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(writeZipStream([{ path: 'x', blob: new Blob(['x']) }], () => {}, { signal: stop.signal }), /abort/i);
  await assert.rejects(writeZipStream([{ path: '../x', blob: new Blob() }], () => {}), /Invalid project archive path/);
  await assert.rejects(writeZipStream([{ path: 'x', blob: new Blob() }, { path: 'x', blob: new Blob() }], () => {}), /Invalid project archive path/);
  await assert.rejects(writeZipStream([{ path: 'x', blob: new Blob(['x']) }], () => { throw new Error('disk full'); }), /disk full/);
}

{
  const song = emptySong();
  addAudioClip(song, { audio: { id: '11111111-1111-4111-8111-111111111111', sampleRate: 48000, channels: 1, frames: 48000, span: 2 } });
  assert.throws(() => prepareProjectArchive({ ...makeProject(1), song }), /Audio clips cannot yet/);
  assert.throws(() => prepareCurrentProjectArchive({ ...makeProject(1), song }), /Audio storage is unavailable/);
  const archive = prepareCurrentProjectArchive({ ...makeProject(1), song }, { file() {} });
  await assert.rejects(archive(), /file system access or the desktop app/);
  await assert.rejects(downloadBackend({}, { createElement() {} }).saveAs('audio.phproject', archive), /file system access or the desktop app/);
}

// Stream writes replace the destination only after a complete archive has been written.
{
  const dir = await mkdtemp(join(tmpdir(), 'philsynth-stream-'));
  const path = join(dir, 'song.phproject');
  try {
    await writeFile(path, 'original');
    const failed = await createProjectStreamWriter(path);
    await assert.rejects(failed.write(new Uint8Array([0, 0, 0, 0])), /Invalid project stream/);
    await failed.abort();
    assert.equal(await readFile(path, 'utf8'), 'original');
    assert.deepEqual(await readdir(dir), ['song.phproject']);
    const writer = await createProjectStreamWriter(path);
    await writeZipStream([{ path: 'project.json', blob: new Blob(['{}']) }], part => writer.write(part));
    assert.equal(await readFile(path, 'utf8'), 'original');
    await writer.finish();
    const reader = await openProjectStreamReader(path);
    const bytes = await reader.read(0, reader.size);
    assert.deepEqual([...((await readZipStream(new Blob([bytes]))).keys())], ['project.json']);
    await assert.rejects(reader.read(0, reader.size + 1), /Invalid project read range/);
    await reader.close();
    assert.deepEqual(await readdir(dir), ['song.phproject']);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

console.log('project file tests passed');
