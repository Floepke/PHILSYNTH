// Run: node test/imagesampler.test.mjs   (IMAGE SAMPLER: controllers, kernel, scanner maths, image pool)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';
import def from '../src/modules/imagesampler.js';
import { pyramid, tableLevels } from '../src/modules/imagesampler.dsp.js';
import { SCAN, SCAN_TYPES, TRI, scanCenter, scanEnds, unit, colorWeights, ovalAxes, ovalPoint, ovalPerimeter, rectCorners, triCorners, polyPath, resPoints } from '../src/modules/imagescan.js';
import { fitImage, dragEnd, dragCenter, dragOval, dragCorner, moveTriangle } from '../src/modules/imageview.js';
import { curveEnv, curveStart, curveTick, curveRelease } from '../src/modules/poly.dsp.js';
import { attackLevel, decayLevel, releaseLevel } from '../src/modules/adsrcurve.js';
import { addImage, getImage, getSample, exportSamples, importSamples, withSamples, MAX_IMAGE } from '../src/samples.js';
import { imageCache } from '../src/dsp/imagecache.js';
import { PatchRuntime } from '../src/patch.js';
import { dspTestHost } from './dsphost.mjs';

const SR = 48000;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const Proc = await loadKernel('imagesampler.dsp.js', SR);

// ---- controllers: scanner, colour mix, envelope, gain last ----
assert.deepEqual(def.params.map((p) => p.id), [
  'polyphony', 'scanType', 'x', 'y', 'length', 'rotation', 'speed', 'ovalWidth', 'ovalHeight', 'ovalRotation',
  'triX1', 'triY1', 'triX2', 'triY2', 'triX3', 'triY3', 'resolution',
  'redLeft', 'greenLeft', 'blueLeft', 'redRight', 'greenRight', 'blueRight',
  'attack', 'decay', 'sustain', 'release', 'atkCurve', 'decCurve', 'relCurve', 'gain',
]);
assert.deepEqual(SCAN_TYPES, ['Line', 'Propellor', 'Oval', 'Triangle', 'Rectangle']);
const P = Object.fromEntries(def.params.map((p) => [p.id, p]));
assert.equal(P.polyphony.max, 32);
assert.ok(def.acceptsMidi && def.hasOutput && !def.hasInput);
const shown = (type) => def.params.filter((p) => !p.visible || p.visible({ scanType: type })).map((p) => p.id);
assert.ok(shown(0).includes('rotation') && !shown(0).includes('speed'), 'Line: Rotation');
assert.ok(shown(1).includes('speed') && !shown(1).includes('rotation'), 'Propellor: Propellor Speed');
assert.deepEqual(shown(2).slice(2, 7), ['x', 'y', 'ovalWidth', 'ovalHeight', 'ovalRotation'], 'Oval: Width / Height / Rotation, no Length');
assert.ok(shown(0).includes('length') && !shown(0).includes('ovalWidth'), 'Line: no oval controllers');
assert.deepEqual(shown(SCAN.RECTANGLE).slice(2, 7), ['x', 'y', 'ovalWidth', 'ovalHeight', 'ovalRotation'], 'Rectangle: X / Y / Width / Height / Rotation');
assert.deepEqual(shown(SCAN.TRIANGLE).slice(2, 8), TRI, 'Triangle: its 6 corners only (no X / Y / Length)');
assert.deepEqual(TRI.map((id) => P[id].label), ['X1', 'Y1', 'X2', 'Y2', 'X3', 'Y3']);
assert.ok(!shown(SCAN.OVAL).some((id) => TRI.includes(id)), 'Oval: no corners');
const typed = def.params.map((p, i) => (p.visible ? i : -1)).filter((i) => i >= 0);
assert.deepEqual(typed, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 'scanner type controllers grouped right after Scanner Type');
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
  const one = colorWeights({ redLeft: 50 });
  close(one.L[0], 0.5, 1e-9, 'a single colour keeps its amount as volume');
  assert.ok(one.R.every((v) => v === 0), 'nothing on the right');
  const all = colorWeights({ redLeft: 100, greenLeft: 100, blueLeft: -100, redRight: -100 });
  close(Math.abs(all.L[0]) + Math.abs(all.L[1]) + Math.abs(all.L[2]), 1, 1e-9, 'all on one side: scaled to 1 (no clipping)');
  assert.ok(all.L[2] < 0, 'negative amount inverts');
  assert.deepEqual(all.R, [-1, 0, 0], 'each speaker on its own: red inverted on the right');
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

// ---- rectangle / triangle geometry + editor helpers ----
{
  // rectangle: from the middle of the Width side, counterclockwise on screen (up first)
  let r = rectCorners(50, 25, 20, 10, 0);
  assert.deepEqual([r.xs, r.ys], [[70, 70, 30, 30, 70], [25, 15, 15, 35, 35]]);
  r = rectCorners(50, 25, 20, 10, 90); // rotated: the width side points up
  close(r.xs[0], 50, 1e-9, 'rotated start x'); close(r.ys[0], 5, 1e-9, 'rotated start y');
  const path = polyPath([0, 10, 10, 0], [0, 0, 10, 10]);
  close(path.length, 40, 1e-9, 'square perimeter');
  const q = [0, 0];
  path.at(0.125, q); assert.deepEqual(q, [5, 0], 'even speed: an eighth = half the first side');
  path.at(0.5, q); assert.deepEqual(q, [10, 10]);
  path.at(-0.125, q); assert.deepEqual(q, [0, 5], 'wraps (negative progress)');
  polyPath([3, 3, 3], [4, 4, 4]).at(0.7, q); assert.deepEqual(q, [3, 4], 'a point-sized triangle');
  const t = triCorners({ triX1: 0, triY1: 0, triX2: 100, triY2: 50, triX3: 50, triY3: 100 }, 101, 51);
  assert.deepEqual([t.xs, t.ys], [[0, 100, 50], [0, 25, 50]]);
  const img = { width: 101, height: 51 };
  assert.deepEqual(dragCorner(img, 1, 50, 25), { triX2: 50, triY2: 50 });
  const tri = { triX1: 50, triY1: 15, triX2: 15, triY2: 85, triX3: 85, triY3: 85 };
  const moved = moveTriangle(tri, img, 10, -5);
  close(moved.triX1, 60, 1e-9, 'moved x'); close(moved.triY1, 5, 1e-9, 'moved y');
  const edge = moveTriangle(tri, img, 100, 100); // stops at the right / bottom edges, the shape kept
  close(edge.triX3, 100, 1e-9, 'stopped at the right'); close(edge.triY2, 100, 1e-9, 'stopped at the bottom');
  close(edge.triX3 - edge.triX2, 70, 1e-9, 'shape kept');
  // the Rectangle's handles are the Oval's (same controllers)
  close(dragOval({ x: 50, y: 50, ovalRotation: 0, scanType: SCAN.RECTANGLE }, img, 'width', 75, 25).ovalWidth, 50, 1e-9, 'rectangle width');
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
  // the wrap back to the start: the only fall through zero (band-limited, so over a few samples)
  const wraps = L.slice(128 * 5).filter((v, i, a) => i && a[i - 1] > 0 && v <= 0).length;
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
{ // each speaker its own colours: red on the right, blue on the left
  const { k, m } = make({ redLeft: 0, redRight: 100, blueLeft: 100, blueRight: 0 });
  m({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  const { L, R } = render(k, 10);
  assert.ok(Math.max(...L.slice(256).map(Math.abs)) < 1e-4, 'blue (flat) left: silent');
  assert.ok(Math.max(...R.map(Math.abs)) > 0.1, 'red ramp right: plays');
}
{ // amounts: red - green on a grey ramp (equal r = g) cancels
  const rgb = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgb.fill(Math.round((x / (W - 1)) * 255), (y * W + x) * 3, (y * W + x) * 3 + 3);
  const { k, m } = make({ greenLeft: -100, greenRight: 0, blueRight: 0 }, rgb);
  m({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  const { L, R } = render(k, 10);
  assert.ok(Math.max(...L.slice(256).map(Math.abs)) < 1e-4, 'red - green of grey = silence');
  assert.ok(Math.max(...R.map(Math.abs)) < 1e-4, 'nothing on the right');
  // changing an amount while playing glides (no jump)
  const g = make({}, rgb);
  g.m({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  const a = render(g.k, 10).L;
  g.m({ type: 'param', id: 'redLeft', value: -100 });
  const b = render(g.k, 10).L;
  const all = [...a, ...b];
  const step = Math.max(...all.slice(1).map((v, i) => Math.abs(v - all[i])));
  const wrap = Math.max(...a.slice(1).map((v, i) => Math.abs(v - a[i])));
  assert.ok(step <= wrap + 1e-6, `amount change: no bigger jump than the cycle wrap (${step} vs ${wrap})`);
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
    const { k, m } = make({ blueRight: 0, resolution: 1024, ...params });
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
  // Rectangle and Triangle: closed too, one turn per cycle
  const rect = run({ scanType: SCAN.RECTANGLE, ovalWidth: 90, ovalHeight: 60 });
  assert.ok(rect.pp > 0.2, `rectangle sounds (${rect.pp})`);
  assert.ok(rect.step < rect.pp * 0.06, `rectangle: no jump at the wrap (${rect.step} of ${rect.pp})`);
  close(rect.lag, 256, 2, 'rectangle: one turn per cycle');
  const tri = run({ scanType: SCAN.TRIANGLE });
  assert.ok(tri.pp > 0.2, `triangle sounds (${tri.pp})`);
  assert.ok(tri.step < tri.pp * 0.06, `triangle: no jump at the wrap (${tri.step} of ${tri.pp})`);
  close(tri.lag, 256, 2, 'triangle: one turn per cycle');
  // a rectangle turned 90° with no height is a vertical line on one column -> quiet
  const thin = run({ scanType: SCAN.RECTANGLE, ovalWidth: 20, ovalHeight: 0, ovalRotation: 90 });
  assert.ok(thin.pp < rect.pp * 0.1, `rectangle along a constant column: quiet (${thin.pp})`);
  // all three corners in one column: quiet (the ramp is constant vertically)
  const col = run({ scanType: SCAN.TRIANGLE, triX1: 40, triX2: 40, triX3: 40, triY1: 0, triY2: 50, triY3: 100 });
  assert.ok(col.pp < tri.pp * 0.1, `triangle in one column: quiet (${col.pp})`);
}

// ---- Resolution: points along the scanner, straight lines between them ----
{
  assert.deepEqual([resPoints(1), resPoints(2.4), resPoints(5000), resPoints(NaN)], [2, 2, 1024, 64]);
  assert.deepEqual([P.resolution.min, P.resolution.max, P.resolution.default, P.resolution.scale], [2, 1024, 64, 'log']);
  // halved table copies: [1 2 1] / 4 per pair, periodic
  const T = { buf: new Float32Array(64 * 3), off: new Int32Array(16), len: new Int32Array(16), count: 0 };
  [0, 4, 8, 4].forEach((v, j) => { T.buf[j * 3] = v; });
  T.len[0] = 4;
  tableLevels(T);
  assert.equal(T.count, 2);
  assert.deepEqual([T.off[1], T.len[1]], [4, 2]);
  assert.deepEqual([T.buf[4 * 3], T.buf[5 * 3]], [(4 + 0 + 4) / 4, (4 + 16 + 4) / 4]);

  const hz = 187.5; // 256 samples per cycle
  const cycle = (params) => {
    const { k, m } = make({ blueRight: 0, ...params });
    m({ type: 'noteOn', id: 1, pitch: pitch(hz), velocity: 1 });
    return { k, c: render(k, 12).L.slice(1024, 1280) };
  };
  // 2 points on the ramp: the start and the middle -> a triangle (up half a cycle, down the other)
  const two = cycle({ resolution: 2 }).c;
  const ups = two.slice(1).filter((v, i) => v > two[i]).length;
  close(ups, 128, 4, 'two points: rises half the cycle');
  const steps = two.slice(1).map((v, i) => Math.abs(v - two[i]));
  const pp2 = Math.max(...two) - Math.min(...two);
  assert.ok(Math.max(...steps) < pp2 * 0.05, 'two points: no jump (the lines join up)');
  // 4 points: straight lines between them, so the slope is constant within each quarter
  const four = cycle({ resolution: 4 }).c;
  const d = four.slice(1).map((v, i) => v - four[i]);
  close(d[20], d[40], 1e-6, 'four points: a straight line inside a quarter');
  // the full resolution keeps the ramp's detail: a saw, not a triangle
  const full = cycle({ resolution: 1024 }).c;
  assert.ok(full.slice(1).filter((v, i) => v > full[i]).length > 240, 'full resolution: a saw');

  // the table is built once while the scanner stands still, every block while it moves
  const still = cycle({});
  assert.equal(still.k.rebuilds, 1, 'still scanner: one table');
  const spin = make({ scanType: SCAN.PROPELLOR, speed: 1 });
  spin.m({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  render(spin.k, 10);
  assert.equal(spin.k.rebuilds, 10, 'propellor: a table per block');
  // nothing sounding: no tables
  const idle = make({ scanType: SCAN.PROPELLOR, speed: 1 });
  render(idle.k, 10);
  assert.equal(idle.k.rebuilds, 0, 'silent: no tables');

  // moving the scanner while playing crossfades the tables: no bigger jump than the cycle wrap
  for (const resolution of [1024, 16]) {
    const mv = make({ blueRight: 0, resolution, length: 20 });
    mv.m({ type: 'noteOn', id: 1, pitch: 40, velocity: 1 });
    const a = render(mv.k, 40).L.slice(128 * 4);
    mv.m({ type: 'param', id: 'length', value: 90 });
    mv.m({ type: 'param', id: 'resolution', value: 3 });
    const b = render(mv.k, 40).L;
    const pp = (x) => Math.max(...x) - Math.min(...x);
    assert.ok(pp(b.slice(-2000)) > pp(a) * 2, 'the longer scanner plays louder');
    const all = [...a, ...b];
    const jump = (x) => Math.max(...x.slice(1).map((v, i) => Math.abs(v - x[i])));
    // the biggest step stays one of the waveform's own (the new wrap), not a click at the change
    const at = jump(all.slice(a.length - 1, a.length + 512));
    const own = Math.max(jump(a), jump(b.slice(-2000)));
    assert.ok(at <= own + 1e-6, `${resolution} points: scanner / resolution change is smooth (${at} vs ${own})`);
  }
}

// ---- shared image preparation: cloned bytes, replacement and ownership ----
{
  let builds = 0, frees = 0;
  const cache = imageCache(() => ({ serial: ++builds }), () => frees++);
  const rgb = new Uint8Array([0, 100, 255]);
  const a = cache.acquire(1, 1, rgb);
  const b = cache.acquire(1, 1, rgb.slice());
  assert.equal(a, b, 'separate worklet messages share one preparation');
  assert.equal(builds, 1);
  rgb[0] = 1;
  const changed = cache.acquire(1, 1, rgb);
  assert.notEqual(changed, a, 'cache owns immutable bytes and distinguishes new content');
  cache.release(a);
  assert.equal(frees, 0, 'remaining owner keeps data alive');
  cache.release(b);
  assert.equal(frees, 1, 'last owner releases data');
  cache.release(changed);
  assert.equal(frees, 2);
  assert.equal(cache.acquire(2, 1, rgb), null, 'invalid image clears instead of preparing');
  assert.equal(builds, 2);
}

// Old saved resolutions clamp in the model as well as DSP, so UI and exports agree.
{
  const { dsp } = dspTestHost();
  const engine = { ctx: { currentTime: 0 }, dsp, createPatch(sink) { return PatchRuntime.create(this, sink); } };
  const rt = await PatchRuntime.create(engine, dsp.destination);
  const fresh = await rt.addModule('IMAGESAMPLER');
  assert.equal(fresh.values.resolution, 64);
  await rt.load({ modules: [{ id: 1, type: 'IMAGESAMPLER', values: { resolution: 2048 } }], cables: [] });
  const entry = rt.modules.get(1);
  assert.equal(entry.values.resolution, 1024, 'old project values above the new maximum clamp');
  rt.setParam(1, 'resolution', 3000);
  assert.equal(entry.values.resolution, 1024, 'programmatic edits cannot exceed the maximum');
  assert.equal(rt.toJSON().modules.find((m) => m.id === 1).values.resolution, 1024);
  rt.setParam(1, 'resolution', 63.8);
  assert.equal(entry.values.resolution, 64, 'model holds integer point count');
  rt.destroy();
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
