import assert from 'node:assert/strict';
import { midpoint, arrowPath, arrowPoints, linePath, samplePoints, edgePoint, visibleSegment, centerOf } from '../src/cable.js';
import { Ring, displace, scopePath, AMP, crossings, period, lockAge, glowLevel, peakGlow, releaseGlow, GLOW_DB, CableScope, CLIP_HOLD } from '../src/cablescope.js';
import { MidiCableAnimation, MIDI_TRAVEL_MS } from '../src/midicable.js';
import { captureMidiTrace, withMidiTrace } from '../src/modmidi.js';
import { PatchRuntime } from '../src/patch.js';
import { dspTestHost } from './dsphost.mjs';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const tipOf = (d) => d.match(/^M([-\d.]+),([-\d.]+)/).slice(1).map(Number);

// straight left-to-right cable: midpoint in the middle, arrow points right
let m = midpoint({ x: 0, y: 0 }, { x: 200, y: 0 });
near(m.x, 100); near(m.y, 0); near(m.tx, 1); near(m.ty, 0);
assert.deepEqual(tipOf(arrowPath({ x: 0, y: 0 }, { x: 200, y: 0 })), [107, 0]);

// reversed: arrow points left
m = midpoint({ x: 200, y: 0 }, { x: 0, y: 0 });
near(m.x, 100); assert.ok(m.tx < 0);
assert.ok(tipOf(arrowPath({ x: 200, y: 0 }, { x: 0, y: 0 }))[0] < 100);

// two-way connection: both arrows shifted back towards their source, tips facing each other
const fwd = tipOf(arrowPath({ x: 0, y: 0 }, { x: 200, y: 0 }, 7, 9));
const rev = tipOf(arrowPath({ x: 200, y: 0 }, { x: 0, y: 0 }, 7, 9));
assert.deepEqual(fwd, [98, 0]);
assert.deepEqual(rev, [102, 0]);
// their lines end at their own arrow (centre inside the head, tip = where the wave stops): no overlap
{
  const f = arrowPoints({ x: 0, y: 0 }, { x: 200, y: 0 }, 7, 9);
  const r = arrowPoints({ x: 200, y: 0 }, { x: 0, y: 0 }, 7, 9);
  assert.deepEqual([f.centre, f.tip], [{ x: 91, y: 0 }, { x: 98, y: 0 }]);
  assert.deepEqual([r.centre, r.tip], [{ x: 109, y: 0 }, { x: 102, y: 0 }]);
  assert.ok(f.tip.x < r.tip.x, 'the halves do not overlap');
}

// vertical-ish cable: tangent points from a towards b, unit length
m = midpoint({ x: 0, y: 0 }, { x: 0, y: 300 });
near(Math.hypot(m.tx, m.ty), 1); assert.ok(m.ty > 0); near(m.y, 150);

// degenerate (same point) does not produce NaN
assert.ok(!arrowPath({ x: 5, y: 5 }, { x: 5, y: 5 }).includes('NaN'));
assert.equal(linePath({ x: 0, y: 0 }, { x: 10, y: 10 }), 'M0,0 L10,10', 'a straight line');

// centre to centre: the visible part runs from box edge to box edge
{
  const A = { x: 0, y: 0, w: 100, h: 40 }; // centre 50,20
  const B = { x: 300, y: 0, w: 100, h: 40 }; // centre 350,20
  assert.deepEqual(centerOf(A), { x: 50, y: 20 });
  assert.deepEqual(visibleSegment(A, B), { from: { x: 100, y: 20 }, to: { x: 300, y: 20 } });
  const C = { x: 0, y: 200, w: 100, h: 40 }; // straight below A
  assert.deepEqual(visibleSegment(A, C), { from: { x: 50, y: 40 }, to: { x: 50, y: 200 } });
  // diagonal: leaves through the edge the ray crosses first, stays on the centre line
  const D = { x: 400, y: 300, w: 100, h: 40 }; // centre 450,320
  const s = visibleSegment(A, D);
  near(s.from.y, 40); near(s.from.x, 50 + 400 * (20 / 300)); // bottom edge of A (flat box)
  near(s.to.y, 300); // top edge of D
  const cross = (p) => (p.x - 50) * 300 - (p.y - 20) * 400;
  near(cross(s.from), 0, 1e-6); near(cross(s.to), 0, 1e-6);
  // overlapping boxes: nothing visible, fall back to the centre line (no NaN, no reversed arrow)
  const o = visibleSegment(A, { x: 20, y: 10, w: 100, h: 40 });
  assert.deepEqual(o, { from: { x: 50, y: 20 }, to: { x: 70, y: 30 } });
  // a point instead of a box (dragging a new cable to the pointer)
  assert.deepEqual(visibleSegment(A, null, { x: 50, y: 120 }), { from: { x: 50, y: 40 }, to: { x: 50, y: 120 } });
  assert.deepEqual(visibleSegment(A, null, { x: 60, y: 25 }), { from: { x: 50, y: 20 }, to: { x: 60, y: 25 } }, 'pointer inside the box');
  assert.deepEqual(edgePoint(A, { x: 50, y: 20 }), { x: 50, y: 20 }, 'degenerate');
}

// points along the cable for the audio scope: evenly spaced, from a to b, unit normals
{
  const a = { x: 10, y: 20 }, b = { x: 400, y: 260 };
  const p = samplePoints(a, b, 3);
  near(p.x[0], 10); near(p.y[0], 20); near(p.x[p.n - 1], 400, 1e-3); near(p.y[p.n - 1], 260, 1e-3);
  const gaps = [];
  for (let i = 1; i < p.n; i++) gaps.push(Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1]));
  assert.ok(Math.max(...gaps) < 3.1 && Math.min(...gaps) > 2.7, `even spacing ${Math.min(...gaps)}..${Math.max(...gaps)}`);
  for (let i = 0; i < p.n; i++) near(Math.hypot(p.nx[i], p.ny[i]), 1, 1e-5);
  // a straight line: every point on it, one normal for all
  for (let i = 0; i < p.n; i++) {
    near((p.x[i] - 10) * 240 - (p.y[i] - 20) * 390, 0, 0.5);
    near(p.nx[i], p.nx[0]); near(p.ny[i], p.ny[0]);
  }
  near(p.nx[0] * 390 + p.ny[0] * 240, 0, 1e-4); // perpendicular to the cable
  const z = samplePoints({ x: 5, y: 5 }, { x: 5, y: 5 });
  assert.ok(z.n >= 2 && [...z.x, ...z.y, ...z.nx, ...z.ny].every(Number.isFinite), 'degenerate cable');
}

// scope ring: newest value first, quiet count; displacement pinned to the ports
{
  const r = new Ring(8);
  assert.equal(r.quiet, 8);
  [1, 2, 3].forEach((v) => r.push(v / 10));
  near(r.at(0), 0.3); near(r.at(2), 0.1); assert.equal(r.at(3), 0); assert.equal(r.at(99), 0);
  assert.equal(r.quiet, 0);
  for (let i = 0; i < 10; i++) r.push(0);
  assert.equal(r.quiet, 8);
  assert.equal(displace(1, 0, 100), 0); assert.equal(displace(1, 99, 100), 0);
  assert.ok(displace(1, 50, 100) > 0.8 * AMP && displace(-1, 50, 100) < -0.8 * AMP);
  assert.ok(displace(100, 50, 100) <= AMP, 'soft clipped');
  const pts = samplePoints({ x: 0, y: 0 }, { x: 300, y: 0 });
  const ring = new Ring();
  for (let i = 0; i < 200; i++) ring.push(i % 2 ? 0.5 : -0.5);
  const d = scopePath(pts, ring);
  const ys = [...d.matchAll(/[ML][-\d.]+,([-\d.]+)/g)].map((m) => +m[1]);
  assert.equal(ys.length, pts.n);
  assert.ok(Math.max(...ys) > 4 && Math.min(...ys) < -4 && ys[0] === 0, 'the wave runs along the cable');
}

// trigger lock: a periodic wave stands still on the cable and drifts slowly towards the destination
{
  const P = 37.3; // period in points, not a whole number
  const ring = new Ring();
  let t = 0;
  const feed = (k) => { for (let i = 0; i < k; i++, t++) ring.push(Math.sin((2 * Math.PI * t) / P) + 0.3 * Math.sin((4 * Math.PI * t) / P)); };
  feed(3000);
  const xs = crossings(ring, 2000);
  assert.ok(xs.length > 40, 'one rising crossing per period');
  near(period(xs), P, 0.05);
  for (let i = 1; i < xs.length; i++) near(xs[i] - xs[i - 1], P, 0.05);
  // the value at the window start is the same frame after frame (no drift)
  const n = 100;
  let a = lockAge(xs, period(xs), 0, 0, 0, n);
  const v0 = [0, 10, 20].map((i) => ring.lerp(a + i));
  for (const k of [17, 128, 64, 301]) {
    const seen = ring.count;
    feed(k);
    const ys = crossings(ring, 2000);
    a = lockAge(ys, period(ys), a, ring.count - seen, 0, n);
    assert.ok(a >= 0 && a < 3 * P, `window stays on recent audio (${a})`);
    [0, 10, 20].forEach((i, j) => near(ring.lerp(a + i), v0[j], 0.02));
  }
  // with drift the pattern moves `drift` points towards the destination per frame
  const before = ring.lerp(a + 30);
  const ys = crossings(ring, 2000);
  const b = lockAge(ys, period(ys), a, 0, 2, n);
  near(ring.lerp(b + 32), before, 0.02);
  // no period: live stream
  const flat = new Ring();
  for (let i = 0; i < 500; i++) flat.push(0.4);
  assert.deepEqual(crossings(flat, 400), []);
  assert.equal(lockAge([], 0, 50, 10, 1, n), 0);
  // the newest crossing is old (sound stopped): live stream, so the silence flows in
  for (let i = 0; i < 400; i++) ring.push(0);
  const zs = crossings(ring, 2000);
  assert.equal(lockAge(zs, period(zs), a, 400, 0, n), 0);
}

console.log('cable tests passed');

// glow follows the peak level of the shown points in dB: 0 dB = 1, -GLOW_DB and silence = 0
{
  assert.equal(peakGlow(0), 0);
  assert.equal(peakGlow(1), 1);
  assert.equal(peakGlow(2), 1);
  assert.equal(peakGlow(0.001), 0);
  assert.equal(releaseGlow(0, 1, 0.01), 1, 'glow rises immediately');
  assert.equal(releaseGlow(1, 0, 0.1), 0.75, 'glow releases at the cable rate');
  assert.equal(releaseGlow(1, 0, 5), 0.75, 'long frame gaps are capped');
  const ring = new Ring(64);
  assert.equal(glowLevel(ring, 0, 20), 0, 'silence: no glow');
  for (let i = 0; i < 64; i++) ring.push(Math.sin(i / 3));
  assert.ok(glowLevel(ring, 0, 32) > 0.99, 'full scale');
  const quiet = new Ring(64);
  for (let i = 0; i < 64; i++) quiet.push(0.0316 * Math.sin(i / 3)); // about -30 dB
  const g = glowLevel(quiet, 0, 32);
  assert.ok(Math.abs(g - (1 - 30 / GLOW_DB)) < 0.03, `-30 dB glows partly (${g})`);
  const tiny = new Ring(64);
  for (let i = 0; i < 64; i++) tiny.push(1e-4);
  assert.equal(glowLevel(tiny, 0, 32), 0, 'below the range: none');
}
console.log('cable glow tests passed');

// out of bounds: the cable gets `clipping` (complementary colour in style.css) for CLIP_HOLD ms
{
  const saved = Object.fromEntries(['document', 'requestAnimationFrame']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.requestAnimationFrame = () => 0;
  const el = () => {
    const classes = new Set();
    return {
      classes, style: { setProperty() {} },
      classList: { add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
      setAttribute() {}, removeAttribute() {}, insertBefore() {}, querySelector: () => null,
    };
  };
  globalThis.document = { createElementNS: el };
  let watched = null;
  const scope = new CableScope({ scope: (hs) => { watched = hs; } });
  const [g1, g2] = [el(), el()];
  scope.setCables([{ g: g1, h: 1, from: { x: 0, y: 0 }, to: { x: 90, y: 0 } }, { g: g2, h: 2, from: { x: 0, y: 0 }, to: { x: 90, y: 0 } }]);
  assert.deepEqual(watched, [1, 2]);
  scope.push({ h: [1, 2], n: 1, v: new Float32Array([0.5, 0.5]), clip: new Uint8Array([1, 0]) }, 1000);
  scope.frame(1000);
  assert.ok(g1.classes.has('clipping'), 'the clipping source marks its cable');
  assert.ok(!g2.classes.has('clipping'), 'other cables keep their colour');
  scope.frame(1000 + CLIP_HOLD - 1);
  assert.ok(g1.classes.has('clipping'), 'held so a short crackle is visible');
  scope.frame(1000 + CLIP_HOLD + 1);
  assert.ok(!g1.classes.has('clipping'), 'back to normal after the hold');
  for (const [key, d] of Object.entries(saved)) if (d) Object.defineProperty(globalThis, key, d); else delete globalThis[key];
}
console.log('cable clipping tests passed');

// Deterministic animation frames: test the full 100 ms trip, not a timer approximation.
{
  const saved = Object.fromEntries(['performance', 'document', 'requestAnimationFrame', 'cancelAnimationFrame']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let now = 0, nextFrame = 0;
  const frames = new Map();
  const element = () => ({
    attrs: {}, children: [], parentNode: null,
    classList: { add() {} },
    setAttribute(key, value) { this.attrs[key] = String(value); },
    append(child) { child.remove(); this.children.push(child); child.parentNode = this; },
    remove() {
      if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    },
  });
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  globalThis.document = { createElementNS: element };
  globalThis.requestAnimationFrame = (fn) => { frames.set(++nextFrame, fn); return nextFrame; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const advance = (at) => {
    now = at;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((fn) => fn(now));
  };
  const view = (cable) => ({ cable, g: element(), from: { x: 10, y: 20 }, to: { x: 210, y: 120 } });
  const rig = async () => {
    const { dsp } = dspTestHost();
    const animation = new MidiCableAnimation();
    const engine = { ctx: { currentTime: 0 }, dsp, midiCables: animation };
    const patch = await PatchRuntime.create(engine, dsp.destination);
    return {
      animation, patch,
      show: (...runtimes) => animation.setCables(runtimes.flatMap((rt) => rt.cables.map(view))),
      tick(time) {
        engine.ctx.currentTime = time;
        for (const fn of dsp.clocks) fn(time);
      },
      destroy() { patch.destroy(); animation.clear(); },
    };
  };
  try {
    const animation = new MidiCableAnimation();
    const cables = [{}, {}, {}];
    const views = cables.map(view);
    animation.setCables(views);
    let delivered = 0;
    animation.transmit(cables[0], 1, () => {
      delivered++;
      animation.transmit(cables[1], 2, () => delivered++);
    });
    animation.transmit(cables[2], 1, () => delivered++);
    animation.transmit(cables[0], 3, () => delivered++);
    assert.equal(delivered, 4, 'MIDI is synchronous; no animation frame or timeout delays delivery');
    assert.deepEqual(animation.pulses.map((p) => [p.start, p.end]), [[0, 100], [100, 200], [200, 300], [0, 100]],
      'chain and parallel branches follow each other, independent notes can overlap');
    assert.ok(animation.pulses.every((p) => p.end - p.start === MIDI_TRAVEL_MS));
    advance(0);
    assert.deepEqual(animation.pulses[0].dot.attrs, { r: '4', cx: '10', cy: '20' });
    advance(50);
    assert.equal(animation.pulses[0].dot.attrs.cx, '110');
    assert.equal(animation.pulses[0].dot.attrs.cy, '70');
    const replacement = view(cables[0]);
    replacement.to = { x: 410, y: 220 };
    animation.setCables([replacement, ...views.slice(1)]);
    assert.equal(animation.pulses[0].dot.parentNode, replacement.g, 'redraw reattaches active dots');
    assert.equal(animation.pulses[0].dot.attrs.cx, '210', 'redraw uses new cable geometry');
    advance(100);
    assert.equal(replacement.g.children.length, 0, 'first trip finishes at exactly 100 ms');
    assert.equal(views[1].g.children.length, 1, 'downstream trip starts on arrival');
    advance(200);
    assert.equal(views[2].g.children.length, 1, 'next parallel branch starts after the preceding path');
    animation.setCables([]);
    assert.equal(animation.pulses.length, 0, 'disconnect or layer change discards pending and active dots');
    advance(300);
    assert.equal(frames.size, 0, 'idle animation has no frame loop');
    animation.setCables(views);
    animation.transmit(cables[0], 4, () => {});
    advance(300);
    animation.clear();
    assert.equal(animation.pulses.length, 0);
    assert.equal(frames.size, 0, 'panic cancels the frame and removes dots');
    assert.equal(views[0].g.children.length, 0);
    document.hidden = true;
    animation.transmit(cables[0], 5, () => delivered++);
    assert.equal(delivered, 5, 'hidden tabs still deliver MIDI immediately');
    assert.equal(animation.pulses.length, 0, 'hidden tabs do not accumulate an animation backlog');
    document.hidden = false;
    assert.throws(() => withMidiTrace({}, () => { throw new Error('test delivery error'); }), /test delivery error/);
    assert.equal(captureMidiTrace(), null, 'delivery errors restore the previous trace');
    animation.receive(cables[0], 1, 0);
    animation.receive(cables[1], 1, 1);
    animation.receive(cables[1], 1, 1);
    assert.deepEqual(animation.pulses.map((p) => p.start), [300, 400, 400],
      'audio reports retain path order without accumulating a TRILL animation backlog');
    animation.clear();
    assert.equal(animation.remote.size, 0);

    // Actual routing: Round Robin only lights the chosen cable; mod/off do not launch dots.
    now = 0;
    const r = await rig();
    const sender = await r.patch.addModule('MULTIMIDI', { values: { routeMode: 1 } });
    const a = await r.patch.addModule('OSC');
    const b = await r.patch.addModule('OSC');
    r.patch.connect(sender.id, a.id);
    r.patch.connect(sender.id, b.id);
    r.show(r.patch);
    const on = [], off = [];
    for (const target of [a, b]) {
      target.inst.noteOn = (...args) => on.push([target.id, ...args]);
      target.inst.noteOff = (id) => off.push([target.id, id]);
    }
    const before = JSON.stringify(r.patch.toJSON());
    sender.inst.noteOn(10, 60, 0.8, 0.25, 0);
    assert.deepEqual(on[0].slice(0, 5), [a.id, on[0][1], 60, 0.8, 0.25]);
    assert.equal(r.animation.pulses[0].cable, r.patch.cables[0]);
    sender.inst.noteMod(10, 61, 0.7);
    assert.equal(r.animation.pulses.length, 1);
    const target = sender.inst.getMidiTargets()[0];
    assert.equal(target, sender.inst.getMidiTargets()[0], 'target identity is stable across route lookups');
    r.patch.disconnect(r.patch.cables[0]);
    assert.equal(off.length, 1, 'disconnect releases notes on the wrapped target');
    r.show(r.patch);
    assert.equal(r.animation.pulses.length, 0, 'disconnected notes leave no stale animation');
    sender.inst.noteOn(11, 64, 1);
    sender.inst.noteOff(11);
    assert.equal(on.at(-1)[0], b.id);
    assert.equal(r.animation.pulses.length, 1, 'note-off does not add a dot');
    assert.ok(!before.includes('midiTargets') && !JSON.stringify(r.patch.toJSON()).includes('midiTargets'),
      'animation state is not serialized');
    r.destroy();

    // Logical paths survive a delayed clock dispatch, STRUM's microtask and a remapped note id.
    now = 0;
    const delayed = await rig();
    const chain = [];
    for (const type of ['MULTIMIDI', 'DELAY', 'STRUM', 'TUNING', 'OSC']) chain.push(await delayed.patch.addModule(type));
    delayed.patch.setParam(chain[1].id, 'left', 10);
    delayed.patch.setParam(chain[2].id, 'duration', 0);
    for (let i = 1; i < chain.length; i++) delayed.patch.connect(chain[i - 1].id, chain[i].id);
    delayed.show(delayed.patch);
    let received = 0;
    chain.at(-1).inst.noteOn = () => received++;
    chain[0].inst.noteOn(20, 60, 1);
    assert.equal(delayed.animation.pulses.length, 1);
    assert.equal(received, 0);
    now = 10;
    delayed.tick(0.01);
    await Promise.resolve();
    assert.equal(received, 1, 'real MIDI waits only for its configured 10 ms delay');
    assert.deepEqual(delayed.animation.pulses.map((p) => p.start), [0, 100, 200, 300]);
    assert.deepEqual(delayed.animation.pulses.map((p) => p.cable), delayed.patch.cables);
    delayed.destroy();

    // Nested Patch output passes retain provenance; both inner and outer connections are real.
    now = 0;
    const nested = await rig();
    const input = await nested.patch.addModule('MULTIMIDI');
    const sub = await nested.patch.addModule('PATCH');
    const inner = sub.inst.patch;
    const processor = await inner.addModule('MULTIMIDI');
    const voice = await nested.patch.addModule('OSC');
    inner.connect(processor.id, 0);
    nested.patch.connect(input.id, sub.id);
    nested.patch.connect(sub.id, voice.id);
    nested.show(nested.patch, inner);
    input.inst.noteOn(30, 60, 1);
    assert.deepEqual(nested.animation.pulses.map((p) => p.start), [0, 100, 200]);
    assert.deepEqual(nested.animation.pulses.map((p) => p.cable),
      [nested.patch.cables[0], inner.cables[0], nested.patch.cables[1]]);
    nested.destroy();

    // CTL2NOTE has no incoming noteOn: its parallel targets still share one visual route.
    now = 0;
    const generated = await rig();
    const ctl = await generated.patch.addModule('CTL2NOTE');
    const voices = [await generated.patch.addModule('OSC'), await generated.patch.addModule('OSC')];
    for (const v of voices) generated.patch.connect(ctl.id, v.id);
    generated.show(generated.patch);
    generated.patch.setParam(ctl.id, 'noteState', 1);
    assert.deepEqual(generated.animation.pulses.map((p) => p.start), [0, 100]);
    generated.destroy();

    // Fast repeated TRILL notes retain ancestry without accumulating an ever-longer backlog.
    now = 0;
    const trilled = await rig();
    const source = await trilled.patch.addModule('MULTIMIDI');
    const trill = await trilled.patch.addModule('TRILL', { values: { humanize: 0, separation: 100 } });
    const dest = await trilled.patch.addModule('OSC');
    trilled.patch.connect(source.id, trill.id);
    trilled.patch.connect(trill.id, dest.id);
    trilled.show(trilled.patch);
    source.inst.noteOn(40, 60, 1);
    assert.deepEqual(trilled.animation.pulses.map((p) => p.start), [0, 100]);
    for (const ms of [20, 40, 60]) { now = ms; trilled.tick(ms / 1000); }
    assert.deepEqual(trilled.animation.pulses.map((p) => p.start), [0, 100, 100, 100, 100]);
    trilled.destroy();
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
console.log('MIDI cable animation tests passed');
