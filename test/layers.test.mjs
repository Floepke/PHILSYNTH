// Run: node test/layers.test.mjs — every Patch has its own TimeLine and MIDI lock (saved with it),
// and the Transport plays only the TimeLine of the level it starts from.
import assert from 'node:assert/strict';

import { dspTestHost } from './dsphost.mjs';

const { dsp } = dspTestHost();
const { PatchRuntime, songLayers } = await import('../src/patch.js');
const { Transport } = await import('../src/transport.js');
const { emptySong, addClip, addAutoClip, normalizeSong, setLoop, setSig } = await import('../src/song.js');
const { paramsOf, fromNorm } = await import('../src/params.js');

const engine = {
  ctx: { currentTime: 0 },
  dsp,
  song: emptySong(),
  createPatch(sink) { return PatchRuntime.create(this, sink); },
};
const settle = () => new Promise((r) => setTimeout(r, 20));

const root = await PatchRuntime.create(engine, dsp.destination);
const mainOsc = await root.addModule('OSC');
const box = await root.addModule('PATCH');
const inner = box.inst.patch;
const osc = await inner.addModule('OSC');
assert.ok(inner.connect(osc.id, 0));

// ---- the inner song: own clips, meter and loop region ----
assert.equal(inner.song.clips.length, 0, 'a new layer has an empty TimeLine');
setSig(engine.song, 4, 3, 4);
assert.equal(inner.song.sigs.length, 1, 'meter of a layer is its own');
setLoop(inner.song, 0, 8);
assert.equal(engine.song.loop, null, 'loop region of a layer is its own');
inner.song.loop = null;
const clip = addClip(inner.song, { start: 4, length: 4, target: osc.id });
clip.notes.push({ pitch: 60, start: 0, length: 1, vel: 0.8 });
const auto = addAutoClip(inner.song, { start: 0, length: 4, target: osc.id, controller: 0 });
auto.points = [{ t: 0, v: 1, r: 0 }];
inner.song.selected = clip.id;

// ---- saved with the layer (selection and shared meter / loop are not) ----
inner.midiLock = osc.id;
const data = root.toJSON();
const saved = data.modules.find((m) => m.id === box.id).patch;
assert.equal(saved.midiLock, osc.id, 'MIDI lock saved with its layer');
assert.equal(saved.song.clips.length, 2, 'inner clips saved');
assert.ok(!('selected' in saved.song), 'clip selection is not saved');
assert.ok(!('song' in data) && !('midiLock' in data), 'an empty root layer saves nothing extra');

const root2 = await PatchRuntime.create(engine, dsp.destination);
await root2.load(data);
const inner2 = root2.modules.get(box.id).inst.patch;
assert.equal(inner2.midiLock, osc.id, 'MIDI lock loaded');
assert.deepEqual(inner2.song.clips.map((c) => c.id), [clip.id, auto.id], 'inner song loaded');
assert.equal(root2.midiLock, null);
const copy = await root2.duplicate(box.id);
assert.equal(copy.inst.patch.song.clips.length, 2, 'a duplicated Patch keeps its TimeLine');
assert.equal(copy.inst.patch.midiLock, osc.id);
root2.destroy();

// ---- layers: main first, then nested Patches with their paths ----
const layers = songLayers(root, engine.song);
assert.deepEqual(layers.map((l) => l.key), ['', String(box.id)]);
assert.equal(layers[1].song, inner.song);
assert.equal(layers[1].getTarget(osc.id), osc.inst);
assert.equal(layers[0].getTarget(osc.id), mainOsc.inst, 'module numbers resolve in their own layer');
assert.deepEqual(songLayers(root, engine.song, [], { nested: false }).map((l) => l.key), [''], 'nested: false = the level alone');

// ---- playback: inner notes reach the inner module, automation drives it ----
const played = [];
const realOn = osc.inst.noteOn.bind(osc.inst);
osc.inst.noteOn = (id, pitch, vel) => { played.push(pitch); realOn(id, pitch, vel); };
const mainPlayed = [];
mainOsc.inst.noteOn = (id, pitch) => mainPlayed.push(pitch);
mainOsc.inst.noteOff = () => {};
let now = 0;
let scope = [];
const t = new Transport({
  getScope: () => scope,
  getSong: (ids) => (ids.length ? inner.song : engine.song),
  getBpm: (ids) => (ids.length ? inner.bpm : root.bpm),
  getTarget: () => null,
  getLayers: (ids) => songLayers(root, engine.song, ids, { nested: false }),
  pitchOffset: (ids) => (ids.length ? inner : root).pitchOffset,
  now: () => now,
  ticker: () => ({ start() {}, stop() {} }),
});
// main-level play: the inner TimeLine is a sketch inside the Patch, not part of the main song
assert.equal(t.play(), false, 'main song empty: nothing to play (inner clips do not count)');
assert.deepEqual(played, [], 'inner clip not heard from the main level');
scope = [box.id];
const p = paramsOf(osc)[0];
assert.ok(t.play({ fromStart: true }));
now += 100;
t.tick(now);
assert.equal(osc.values[p.id], fromNorm(p, 1), 'inner automation drives the inner controller');
for (let i = 0; i < 30; i++) { now += 100; t.tick(now); }
assert.deepEqual(played, [60], 'inner clip note played on the inner module');
assert.deepEqual(mainPlayed, [], 'main module with the same number not played');
t.stop();
scope = [];

// / loops a clip of the inner layer
assert.ok(t.playClip(clip.id, inner.song));
assert.equal(t.loopClip(), clip);
assert.equal(t.pos, 4);
t.stop();
assert.equal(t.clipSong, null);

// ---- playing from inside the Patch: only that layer, at its own Output BPM ----
inner.setParam(0, 'bpm', 240);
root.setParam(0, 'bpm', 60);
assert.equal(inner.bpm, 240);
setLoop(engine.song, 0, 2);
const mainClip = addClip(engine.song, { start: 0, length: 4, target: mainOsc.id });
mainClip.notes.push({ pitch: 48, start: 0, length: 1, vel: 0.8 });
scope = [box.id];
played.length = 0;
mainPlayed.length = 0;
assert.deepEqual(t.songBounds(), [0, 8], 'own bounds: the main loop region does not apply');
assert.ok(t.play({ fromStart: true }));
assert.deepEqual(t.scope, [box.id]);
scope = []; // navigating while playing changes nothing
for (let i = 0; i < 11; i++) { now += 100; t.tick(now); } // 1.1 s at 240 BPM = 4.4 quarters
assert.ok(t.pos > 4 && t.pos < 5, `inner BPM drives the clock (pos ${t.pos})`);
assert.deepEqual(played, [60], 'inner clip played');
assert.deepEqual(mainPlayed, [], 'main TimeLine not played from inside the Patch');
assert.equal(t.plays(inner.song), true);
assert.equal(t.plays(engine.song), false, 'main TimeLine shows no playhead meanwhile');
t.stop();
assert.equal(t.plays(engine.song), true);
// pressing play on the main level while the Patch plays switches to the main level
scope = [box.id];
t.play();
scope = [];
t.play();
assert.deepEqual(t.scope, [], 'play from another level restarts there');
assert.deepEqual(t.songBounds(), [0, 2], 'main loop region');
t.stop();
engine.song.loop = null;
engine.song.clips = [];

// ---- Global Transpose / Cents Offset: every level's Output has them; the playing level's apply ----
assert.ok(paramsOf(root.modules.get(0)).some((q) => q.id === 'transpose'), 'main Output has Global Transpose');
assert.ok(paramsOf(inner.modules.get(0)).some((q) => q.id === 'transpose') && paramsOf(inner.modules.get(0)).some((q) => q.id === 'cents'), 'Outputs inside Patches have them too');
root.setParam(0, 'transpose', 7);
inner.setParam(0, 'transpose', -12);
inner.setParam(0, 'cents', 25);
assert.equal(inner.pitchOffset, -11.75);
inner.setParam(0, 'bpm', 240);
scope = [box.id];
played.length = 0;
assert.ok(t.play({ fromStart: true }));
for (let i = 0; i < 20; i++) { now += 100; t.tick(now); }
assert.deepEqual(played, [48.25], 'inside the Patch only its own Output transposes (the main +7 does not apply)');
t.stop();
inner.setParam(0, 'transpose', 0);
inner.setParam(0, 'cents', 0);
played.length = 0;
assert.ok(t.play({ fromStart: true }));
for (let i = 0; i < 20; i++) { now += 100; t.tick(now); }
assert.deepEqual(played, [60], 'the main level transpose does not reach the inner level');
t.stop();
root.setParam(0, 'transpose', 0);
scope = [];

// automation of an inner layer reaches every instance (Instances > 1)
root.setParam(box.id, 'inputModule', osc.id);
root.setParam(box.id, 'instances', 2);
await box.inst.patch.changed();
await settle();
assert.equal(box.inst.clones.length, 1, 'second instance exists');
const clone = box.inst.clones[0];
const lay = songLayers(root, engine.song)[1];
lay.setAuto(auto.id, auto, 0);
assert.equal(osc.values[p.id], fromNorm(p, 0));
assert.equal(clone.modules.get(osc.id).values[p.id], fromNorm(p, 0), 'clone follows inner automation');

// a song without layers still works the old way
const plain = new Transport({ getSong: () => normalizeSong(null), getBpm: () => 120, getTarget: () => null, ticker: () => ({ start() {}, stop() {} }) });
assert.equal(plain.play(), false);

root.destroy();
console.log('layer tests passed');
