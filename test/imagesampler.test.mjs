// Run: node test/imagesampler.test.mjs   (IMAGE SAMPLER: controllers, kernel, scanner maths, image pool)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';
import def from '../src/modules/imagesampler.js';
import { pyramid } from '../src/modules/imagesampler.dsp.js';
import { SCAN, SCAN_TYPES, scanCenter, scanEnds, unit, colorWeights, ovalAxes, ovalPoint, ovalPerimeter } from '../src/modules/imagescan.js';
import { fitImage, dragEnd, dragCenter, dragOval } from '../src/modules/imageview.js';
import { curveEnv, curveStart, curveTick, curveRelease } from '../src/modules/poly.dsp.js';
import { attackLevel, decayLevel, releaseLevel } from '../src/modules/adsrcurve.js';
import { addImage, getImage, getSample, exportSamples, importSamples, withSamples, MAX_IMAGE } from '../src/samples.js';

const SR = 48000;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const Proc = await loadKernel('imagesampler.dsp.js', SR);

// ---- controllers: shared ones first, then the ones of one scanner type (numbered by order) ----
assert.deepEqual(def.params.map((p) => p.id), [
  'polyphony', 'attack', 'decay', 'sustain', 'release', 'gain', 'atkCurve', 'decCurve', 'relCurve',
  'redPan', 'greenPan', 'bluePan', 'redLevel', 'greenLevel', 'blueLevel',
  'scanType', 'x', 'y', 'length', 'rotation', 'speed', 'ovalWidth', 'ovalHeight', 'ovalRotation',
]);
assert.equal(def.params.findIndex((p) => p.id === 'redPan'), 9, 'colour pans on 9, 10, 11');
assert.deepEqual(SCAN_TYPES, ['Line', 'Propellor', 'Oval']);
const P = Object.fromEntries(def.params.map((p) => [p.id, p]));
assert.equal(P.polyphony.max, 32);
assert.ok(def.acceptsMidi && def.hasOutput && !def.hasInput);
const shown = (type) => def.params.filter((p) => !p.visible || p.visible({ scanType: type })).map((p) => p.id);
assert.ok(shown(0).includes('rotation') && !shown(0).includes('speed'), 'Line: Rotation');
assert.ok(shown(1).includes('speed') && !shown(1).includes('rotation'), 'Propellor: Propellor Speed');
assert.deepEqual(shown(2).slice(-5), ['x', 'y', 'ovalWidth', 'ovalHeight', 'ovalRotation'], 'Oval: Width / Height / Rotation, no Length');
assert.ok(shown(0).includes('length') && !shown(0).includes('ovalWidth'), 'Line: no oval controllers');
const always = def.params.filter((p) => !p.visible).map((p) => p.id);
assert.ok(def.params.findIndex((p) => p.visible) > def.params.findIndex((p) => p.id === always.at(-1)), 'type controllers below the shared ones');
assert.deepEqual(def.normalizeState({ imageId: 3 }), { imageId: null, name: '' });

// ---- geometry ----
{
  const c = scanCenter(50, 50, 100, 101, 51);
  assert.deepEqual([c.cx, c.cy], [50, 25]);
  close(c.len, Math.hypot(100, 50), 1e-9, 'length 100 % = the diagonal');
  const e = scanEnds({ cx: 10, cy: 10, len: 8 }, 90);
  close(e.x1, 10, 1e-9, 'x'); close(e.y1, 6, 1e-9, '90° points up (y down on screen)');
  close(unit(255), 1, 1e-9, 'white'); close(unit(0), -1, 1e-9, 'black');
  // dragging: an end sets Length + Rotation, the start sets the opposite angle
  const img = { width: 101, height: 101 };
  const v = { x: 50, y: 50, length: 50, rotation: 0, scanType: 0 };
  const d = Math.hypot(100, 100);
  const end = dragEnd(v, img, 1, 50, 20); // 30 px straight up
  close(end.length, (60 / d) * 100, 1e-9, 'length'); close(end.rotation, 90, 1e-9, 'end up = 90°');
  close(dragEnd(v, img, 0, 50, 20).rotation, -90, 1e-9, 'start up = end down');
  close(dragEnd(v, img, 0, 20, 50).rotation, 0, 1e-9, 'start left = 0°');
  assert.equal(dragEnd({ ...v, scanType: 1 }, img, 1, 50, 20).rotation, undefined, 'Propellor: length only');
  assert.deepEqual(dragCenter(img, 25, 100), { x: 25, y: 100 });
  const f = fitImage(100, 50, 200, 200);
  assert.deepEqual([f.sc, f.ox, f.oy], [2, 0, 50]);
  const q = f.toCanvas(10, 20);
  const back = f.toImage(q.x, q.y);
  close(back.px, 10, 1e-9, 'round trip x'); close(back.py, 20, 1e-9, 'round trip y');
}

// ---- colour -> speaker weights ----
{
  const dflt = Object.fromEntries(def.params.map((p) => [p.id, p.default]));
  const w = colorWeights(dflt);
  // the defaults: red left, green centre, blue right; each side scaled to 1 (1 + 0.5 = 1.5)
  [[w.L, [2 / 3, 1 / 3, 0]], [w.R, [0, 1 / 3, 2 / 3]]].forEach(([got, want]) => got.forEach((v, i) => close(v, want[i], 1e-9, 'default weights')));
  const one = colorWeights({ ...dflt, greenLevel: 0, blueLevel: 0, redLevel: 50 });
  close(one.L[0], 0.5, 1e-9, 'a single colour keeps its level as volume');
  const all = colorWeights({ redPan: -100, greenPan: -100, bluePan: -100, redLevel: 100, greenLevel: 100, blueLevel: -100 });
  close(Math.abs(all.L[0]) + Math.abs(all.L[1]) + Math.abs(all.L[2]), 1, 1e-9, 'all on one side: scaled to 1 (no clipping)');
  assert.ok(all.L[2] < 0, 'negative level inverts');
  assert.ok(all.R.every((v) => v === 0), 'nothing on the right');
}

// ---- image pyramid: each copy is the average of four pixels ----
{
  const rgb = new Uint8Array(3 * 3 * 3);
  for (let i = 0; i < 9; i++) rgb.fill(i * 20, i * 3, i * 3 + 3);
  const lv = pyramid(3, 3, rgb);
  assert.deepEqual(lv.map((l) => [l.w, l.h]), [[3, 3], [2, 2], [1, 1]]);
  close(lv[1].c[0], unit(40), 1e-6, 'average of 0, 20, 60, 80');
  close(lv[1].c[3 * 3 + 2], unit(160), 1e-6, 'edge copy: the one pixel (blue too)');
}

// ---- curved envelope (the OSC curves) ----
{
  const p = { attack: 0.01, decay: 0.01, sustain: 0.4, release: 0.01, atkCurve: 70, decCurve: -50, relCurve: 100 };
  const E = curveEnv(p);
  const v = { stage: 1 };
  curveStart(v);
  const n = 0.01 * SR;
  for (let i = 0; i < n / 2; i++) curveTick(v, E);
  close(v.level, attackLevel(0.5, 70), 1e-3, 'attack curve');
  for (let i = 0; i < n / 2 + n / 2; i++) curveTick(v, E);
  close(v.level, decayLevel(0.5, -50, 0.4), 1e-3, 'decay curve');
  for (let i = 0; i < n; i++) curveTick(v, E);
  assert.equal(v.stage, 3); close(v.level, 0.4, 1e-9, 'sustain');
  curveRelease(v);
  for (let i = 0; i < n / 2; i++) curveTick(v, E);
  close(v.level, releaseLevel(0.5, 100, 0.4), 1e-3, 'release curve');
}

// ---- oval geometry + editor handles ----
{
  const { a, b } = ovalAxes(50, 100, 101, 51);
  assert.deepEqual([a, b], [25, 25]);
  let q = ovalPoint(50, 25, 20, 10, 0, 0);
  close(q.x, 70, 1e-9, 'starts at the end of the width axis'); close(q.y, 25, 1e-9, 'y');
  q = ovalPoint(50, 25, 20, 10, 0, 0.25);
  close(q.x, 50, 1e-9, 'a quarter on: the top (counterclockwise)'); close(q.y, 15, 1e-9, 'height up');
  q = ovalPoint(50, 25, 20, 10, 90, 0);
  close(q.x, 50, 1e-9, 'rotation 90: the width axis points up'); close(q.y, 5, 1e-9, 'y');
  close(ovalPerimeter(10, 10), 20 * Math.PI, 1e-9, 'circle perimeter');
  const img = { width: 101, height: 51 };
  const v = { x: 50, y: 50, length: 50, ovalRotation: 90 };
  // rotated 90°: the width axis is vertical, the height axis horizontal
  close(dragOval(v, img, 'width', 50, 0).ovalWidth, 50, 1e-9, 'width along the rotated axis');
  close(dragOval(v, img, 'height', 25, 25).ovalHeight, 100, 1e-9, 'height along the rotated axis (capped)');
  close(dragOval(v, img, 'height', 40, 25).ovalHeight, 40, 1e-9, 'height');
  close(dragOval(v, img, 'rotation', 60, 15).ovalRotation, 45, 1e-9, 'rotation knob');
  close(dragOval(v, img, 'rotation', 40, 35, true).ovalRotation, 45, 1e-9, 'flipped knob (beyond the far end)');
}

// ---- kernel ----
const W = 64;
const H = 16;
// red: left -> right ramp; blue constant; green 0
const gradient = () => {
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { rgb[(y * W + x) * 3] = Math.round((x / (W - 1)) * 255); rgb[(y * W + x) * 3 + 2] = 200; }
  return rgb;
};
function make(params = {}, rgb = gradient()) {
  const k = new Proc();
  const m = (data) => k.port.onmessage({ data });
  m({ type: 'image', width: W, height: H, rgb });
  for (const [id, value] of Object.entries({ attack: 0.001, sustain: 1, length: 100 * ((W - 1) / Math.hypot(W - 1, H - 1)), ...params })) m({ type: 'param', id, value });
  return { k, m };
}
function render(k, blocks) {
  const L = [];
  const R = [];
  let live = false;
  for (let b = 0; b < blocks; b++) {
    const o = [new Float32Array(128), new Float32Array(128)];
    live = k.process([], [o]);
    L.push(...o[0]);
    R.push(...o[1]);
  }
  return { L, R, live };
}
const pitch = (hz) => 69 + 12 * Math.log2(hz / 440);

{ // no image: silent
  const k = new Proc();
  k.port.onmessage({ data: { type: 'noteOn', id: 1, pitch: 60, velocity: 1 } });
  assert.equal(render(k, 2).live, false, 'no image, no sound');
}
{ // a horizontal line across the red ramp = a rising saw on the left, the flat blue = silence on the right
  const { k, m } = make();
  const hz = 375; // 128 samples per cycle
  m({ type: 'noteOn', id: 1, pitch: pitch(hz), velocity: 1 });
  const { L, R, live } = render(k, 20);
  assert.ok(live);
  const cyc = L.slice(128 * 10, 128 * 11);
  const rises = cyc.slice(1).filter((v, i) => v > cyc[i]).length;
  assert.ok(rises > 120, `rising saw (${rises} of 127 steps up)`);
  const wraps = L.slice(128 * 5).filter((v, i, a) => i && a[i - 1] - v > 0.2).length;
  assert.ok(wraps >= 14 && wraps <= 15, `one cycle per 128 samples (the wrap back to the start): ${wraps}`);
  const mean = cyc.reduce((a, b) => a + b, 0) / cyc.length;
  assert.ok(Math.abs(mean) < 0.01, `no DC: ${mean}`);
  assert.ok(Math.max(...R.slice(128 * 2).map(Math.abs)) < 1e-4, 'constant blue: right silent');
  // Rotation 180: the line runs right -> left, a falling saw
  const r = make({ rotation: 180 });
  r.m({ type: 'noteOn', id: 1, pitch: pitch(hz), velocity: 1 });
  const L2 = render(r.k, 20).L.slice(128 * 10, 128 * 11);
  assert.ok(L2.slice(1).filter((v, i) => v < L2[i]).length > 120, 'reversed: falling saw');
  // Propellor at 0 turns/s from angle 0 = the Line at 0°
  const pr = make({ scanType: 1, speed: 0 });
  pr.m({ type: 'noteOn', id: 1, pitch: pitch(hz), velocity: 1 });
  const L3 = render(pr.k, 20).L;
  assert.ok(Math.max(...L3.map((v, i) => Math.abs(v - L[i]))) < 1e-6, 'still propellor = line');
  // spinning half a turn per 1/4 s: after 0.5 turn the saw falls
  const sp = make({ scanType: 1, speed: 2 });
  sp.m({ type: 'noteOn', id: 1, pitch: pitch(hz), velocity: 1 });
  const L4 = render(sp.k, 94).L; // 0.25 s
  const c4 = L4.slice(-128);
  assert.ok(c4.slice(1).filter((v, i) => v < c4[i]).length > 100, 'half a turn later the scan runs backwards');
}
{ // X moves the line: a vertical line (rotation 90) at x reads one red value: silent after DC removal
  const { k, m } = make({ rotation: 90, x: 25 });
  m({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  const { L } = render(k, 10);
  assert.ok(Math.max(...L.slice(256).map(Math.abs)) < 1e-4, 'one colour along the scanner = no sound');
}
{ // stereo: red on the left, blue on the right (different images per side)
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgb[(y * W + x) * 3 + 2] = x < W / 2 ? 0 : 255; // blue step
  const { k, m } = make({}, rgb);
  m({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  const { L, R } = render(k, 10);
  assert.ok(Math.max(...L.map(Math.abs)) < 1e-4, 'no red: left silent');
  assert.ok(Math.max(...R.map(Math.abs)) > 0.1, 'blue: right plays');
}
{ // pans move colours: red to the right
  const { k, m } = make({ redPan: 100, bluePan: -100 });
  m({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  const { L, R } = render(k, 10);
  assert.ok(Math.max(...L.slice(256).map(Math.abs)) < 1e-4, 'blue (flat) left: silent');
  assert.ok(Math.max(...R.map(Math.abs)) > 0.1, 'red ramp right: plays');
}
{ // levels: red - green on a grey ramp (equal r = g) cancels
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgb.fill(Math.round((x / (W - 1)) * 255), (y * W + x) * 3, (y * W + x) * 3 + 3);
  const { k, m } = make({ greenLevel: -100, greenPan: -100, blueLevel: 0 }, rgb);
  m({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  const { L, R } = render(k, 10);
  assert.ok(Math.max(...L.slice(256).map(Math.abs)) < 1e-4, 'red - green of grey = silence');
  assert.ok(Math.max(...R.map(Math.abs)) < 1e-4, 'nothing on the right');
  // changing a level while playing glides (no jump)
  const g = make({}, rgb);
  g.m({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  const a = render(g.k, 10).L;
  g.m({ type: 'param', id: 'redLevel', value: -100 });
  const b = render(g.k, 10).L;
  const all = [...a, ...b];
  const step = Math.max(...all.slice(1).map((v, i) => Math.abs(v - all[i])));
  const wrap = Math.max(...a.slice(1).map((v, i) => Math.abs(v - a[i])));
  assert.ok(step <= wrap + 1e-6, `level change: no bigger jump than the cycle wrap (${step} vs ${wrap})`);
}
{ // polyphony up to 32, release ends the voices
  const { k, m } = make({ polyphony: 32, release: 0.01 });
  for (let i = 0; i < 40; i++) m({ type: 'noteOn', id: i + 1, pitch: 40 + i, velocity: 0.5 });
  render(k, 1);
  assert.equal(k.voices.filter((v) => v.stage).length, 32);
  for (let i = 0; i < 40; i++) m({ type: 'noteOff', id: i + 1 });
  assert.equal(render(k, 10).live, false, 'released');
}
{ // high notes read a smoothed copy: a pixel-noise image gets quieter instead of aliasing
  let s = 1;
  const rgb = Uint8Array.from({ length: W * H * 3 }, () => ((s = (s * 1103515245 + 12345) >>> 0) >>> 24));
  const rms = (hz) => {
    const { k, m } = make({}, rgb);
    m({ type: 'noteOn', id: 1, pitch: pitch(hz), velocity: 1 });
    const { L } = render(k, 20);
    const t = L.slice(128 * 4);
    return Math.sqrt(t.reduce((a, b) => a + b * b, 0) / t.length);
  };
  assert.ok(rms(6000) < rms(100) * 0.7, `smoothed at high pitch: ${rms(6000)} vs ${rms(100)}`);
}

{ // Oval: once around per cycle, no jump at the wrap (a Line over the same ramp is a sawtooth)
  const hz = 187.5; // 256 samples per cycle
  const run = (params) => {
    const { k, m } = make({ redPan: -100, blueLevel: 0, ...params });
    m({ type: 'noteOn', id: 1, pitch: pitch(hz), velocity: 1 });
    const { L } = render(k, 24);
    const s = L.slice(1024);
    const pp = Math.max(...s) - Math.min(...s);
    let step = 0;
    for (let i = 1; i < s.length; i++) step = Math.max(step, Math.abs(s[i] - s[i - 1]));
    let best = 0; // the strongest repeat: one cycle per note
    let lag = 0;
    for (let d = 200; d < 320; d++) { let c = 0; for (let i = 0; i < 1024; i++) c += s[i] * s[i + d]; if (c > best) { best = c; lag = d; } }
    return { pp, step, lag };
  };
  const oval = run({ scanType: SCAN.OVAL, ovalWidth: 90, ovalHeight: 60 });
  assert.ok(oval.pp > 0.2, `oval sounds (${oval.pp})`);
  assert.ok(oval.step < oval.pp * 0.06, `oval: smooth all round (${oval.step} of ${oval.pp})`);
  close(oval.lag, 256, 2, 'oval: one turn per cycle');
  const line = run({ scanType: SCAN.LINE });
  assert.ok(line.step > line.pp * 0.5, 'line over the ramp jumps at the wrap');
  // rotated 90° with no height: the oval is a vertical line on one column of the ramp -> quiet
  const flat = run({ scanType: SCAN.OVAL, ovalWidth: 20, ovalHeight: 0, ovalRotation: 90 });
  assert.ok(flat.pp < oval.pp * 0.1, `oval along a constant column: quiet (${flat.pp})`);
}

// ---- image pool: saved with the project ----
{
  assert.throws(() => addImage({ width: MAX_IMAGE + 1, height: 1, rgb: new Uint8Array((MAX_IMAGE + 1) * 3) }));
  const rgb = Uint8Array.from({ length: 2 * 3 * 3 }, (_, i) => i * 7);
  const id = addImage({ width: 2, height: 3, rgb });
  assert.equal(addImage({ width: 2, height: 3, rgb }), id, 'same image, same id');
  assert.deepEqual([...getImage(id).rgb], [...rgb]);
  const project = { modules: [{ type: 'IMAGESAMPLER', state: { imageId: id, name: 'x' } }] };
  const saved = withSamples(project).samples;
  assert.deepEqual(Object.keys(saved), [id]);
  assert.equal(saved[id].kind, 'image');
  assert.deepEqual(exportSamples(project), saved);
  // into a fresh pool (other id spelling to skip the existing entry)
  importSamples({ other: saved[id], bad: { kind: 'image', width: 2, height: 3, data: 'AAAA' } });
  assert.deepEqual([...getImage('other').rgb], [...rgb]);
  assert.equal(getSample('bad'), null, 'corrupt image skipped');
}

console.log('imagesampler tests passed');
