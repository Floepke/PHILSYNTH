// Run: node test/waveshaper.test.mjs   (runs the real WAVESHAPER DSP kernel)
// A silent input block (a source reporting silence, e.g. a half sine's zero half through a
// MODULATOR) must give the same samples as a block of real zeros: the oversampling and the built-in
// DC blocker fade out instead of jumping to 0 (a click). Silent again once settled.
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';
import waveshaper from '../src/modules/waveshaper.js';
import { createCurveEditor } from '../src/curveeditor.js';
import { curveTable, defaultCurve } from '../src/curve.js';

const SR = 48000;
const Proc = await loadKernel('waveshaper.dsp.js', SR);
const block = () => [[new Float32Array(128), new Float32Array(128)]];
const halfSine = (n) => Math.max(0, Math.sin((2 * Math.PI * 40 * n) / SR)); // 40 Hz: 600-sample zero half

assert.ok(!Proc.passive, 'not passive: it has memory, so the graph keeps running it on silent input');

for (const os of [0, 1, 2]) {
  const run = (gapAsSilence) => {
    const k = new Proc();
    k.port.onmessage({ data: { type: 'param', id: 'oversample', value: os } });
    const out = [];
    let n = 0;
    for (let b = 0; b < 200; b++) {
      const L = new Float32Array(128);
      for (let i = 0; i < 128; i++, n++) L[i] = halfSine(n);
      const o = block();
      const live = k.process(gapAsSilence && L.every((v) => v === 0) ? [[]] : [[L]], o);
      out.push(...(live === false ? new Float32Array(128) : o[0][0]));
    }
    return out;
  };
  const real = run(false);
  const gapped = run(true);
  assert.ok(Math.max(...real.map((v, i) => Math.abs(v - gapped[i]))) < 1e-6, `oversample ${os}: silent blocks = zeros, no click`);
  const maxStep = Math.max(...gapped.slice(1).map((v, i) => Math.abs(v - gapped[i])));
  assert.ok(maxStep < 0.05, `oversample ${os}: no jumps (${maxStep})`);
}

// rings out after the input stops, then reports silence and stays silent
{
  const k = new Proc();
  k.process([[new Float32Array(128).fill(0.5)]], block());
  let blocks = 0;
  while (k.process([[]], block()) !== false) assert.ok(++blocks < 200, 'settles');
  assert.ok(blocks > 2, `rings out over a few blocks (${blocks})`);
  assert.equal(k.process([[]], block()), false, 'then stays silent');
  assert.equal(new Proc().process([[]], block()), false, 'a fresh one is silent without input');
}

console.log('waveshaper tests passed');

// First audio after creation / idling: no thump. In the Full -/+ range silence maps to curve(0.5),
// often not 0; the DC blocker rests as if the input had always been silent (not at 0, which made the
// first note of every instance click), and the controllers start on their values (no glide from
// the defaults).
{
  const curve = { points: [{ x: 0, y: 0, r: 0 }, { x: 0.5, y: 0.9, r: 0 }, { x: 1, y: 1, r: 0 }] }; // silence -> 0.8
  const soft = (n) => 0.3 * Math.sin((2 * Math.PI * 220 * n) / SR) * Math.min(1, n / 480); // 10 ms fade-in
  const firstNote = (k) => {
    const out = [];
    for (let b = 0, n = 0; b < 40; b++) {
      const L = new Float32Array(128);
      for (let i = 0; i < 128; i++, n++) L[i] = soft(n);
      const o = block();
      k.process([[L]], o);
      out.push(...o[0][0]);
    }
    return out;
  };
  for (const os of [0, 2]) {
    const k = new Proc();
    const m = (data) => k.port.onmessage({ data });
    m({ type: 'param', id: 'oversample', value: os });
    for (let b = 0; b < 3; b++) assert.equal(k.process([[]], block()), false, 'idle before any audio');
    m({ type: 'curve', curve }); // the curve arrives later than the kernel
    m({ type: 'param', id: 'range', value: 1 });
    const first = firstNote(k);
    assert.ok(Math.abs(first[0]) < 0.01, `os ${os}: first sample of the first note is no step: ${first[0]}`);
    // ring out, go idle: the same note again (the case that was always clean) sounds identical
    const ringOut = () => {
      let alive = true;
      for (let b = 0; b < 2000 && alive; b++) alive = k.process([[]], block()) !== false;
      assert.equal(alive, false, 'idle again');
    };
    ringOut();
    const second = firstNote(k);
    const diff = Math.max(...first.map((v, i) => Math.abs(v - second[i])));
    assert.ok(diff < 1e-4, `os ${os}: first note = a later note, no thump: ${diff}`);
    ringOut();
    m({ type: 'curve', curve: { points: [{ x: 0, y: 0.2, r: 0 }, { x: 1, y: 1, r: 0 }] } });
    const again = firstNote(k);
    assert.ok(Math.abs(again[0]) < 0.01, `os ${os}: clean after a curve change while idle: ${again[0]}`);
  }
  // controllers set before the first audio apply from its first sample
  const k = new Proc();
  const m = (data) => k.port.onmessage({ data });
  m({ type: 'param', id: 'mix', value: 0 });
  m({ type: 'param', id: 'level', value: 0.25 });
  m({ type: 'param', id: 'drive', value: 20 });
  const L = new Float32Array(128).map((_, i) => 0.5 * Math.sin(i / 7));
  const o = block();
  k.process([[L]], o);
  for (let i = 0; i < 128; i += 9) assert.ok(Math.abs(o[0][0][i] - L[i] * 0.25) < 1e-6, `dry × level from the first sample @${i}`);
  console.log('waveshaper first-note tests passed');
}

// Graph labels and the hover probe use the same range conversion as the DSP table.
{
  let texts = [];
  const g = {
    setTransform() {}, clearRect() { texts = []; }, fillRect() {}, strokeRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {}, arc() {}, fill() {},
    fillText(text) { texts.push(text); }, measureText(text) { return { width: text.length * 6 }; },
  };
  class Element extends EventTarget {
    constructor(tag) { super(); this.tag = tag; this.children = []; this.style = {}; this.clientWidth = 320; }
    append(...els) { this.children.push(...els); }
    getContext() { return g; }
    getBoundingClientRect() { return { left: 0, top: 0 }; }
  }
  globalThis.document = { createElement: (tag) => new Element(tag) };
  globalThis.devicePixelRatio = 1;
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  globalThis.ResizeObserver = class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } };
  const curve = { points: [{ x: 0, y: 0, r: 0 }, { x: 0.5, y: 1, r: 1 }, { x: 1, y: 0.5, r: 0 }] };
  let edits = 0;
  const panel = waveshaper.editor({ state: curve, values: { range: 0 } }, { setState() { edits++; } });
  assert.equal(texts.length, 0, 'canvas resizing waits for an animation frame, outside observer delivery');
  frames.shift()();
  const [canvas, info] = panel.el.children;
  assert.equal(canvas.width, 320);
  assert.equal(canvas.height, 180, 'shared curve editor uses a 16:9 canvas');
  assert.equal(canvas.style.height, '180px');
  const move = (x, y) => {
    const e = new Event('pointermove');
    Object.assign(e, { clientX: 12 + x * 296, clientY: 12 + (1 - y) * 156 });
    canvas.dispatchEvent(e);
  };
  assert.ok(texts.includes('0.25'), 'symmetric axis ticks');
  for (const range of [0, 1, 0]) {
    panel.refresh({ range });
    for (const x of [0.25, 0.5, 0.75]) {
      move(x, 0.2);
      const voltage = range ? x * 2 - 1 : x;
      const table = curveTable(curve, !range, 4097);
      const expected = table[Math.round((voltage + 1) * 2048)];
      const badge = texts.find((text) => text.startsWith('in '));
      assert.ok(badge, 'numeric mapping inside the graph');
      const output = Number(badge.split('out ')[1]);
      assert.ok(Math.abs(output - expected) < 0.001, `range ${range}: graph matches DSP at ${voltage}`);
      assert.ok(info.textContent.startsWith(badge), 'info and graph agree');
    }
    assert.ok(texts.includes(range ? '−0.5' : '0.25'), 'ticks refresh with Range');
    assert.ok(panel.el.children.at(-1).textContent.includes(range ? 'zero is at the center' : 'Negative input'), 'mode explanation refreshes');
  }
  move(0.5, 1); // Hover the control point, not the actual rounded curve.
  assert.ok(!info.textContent.includes('out +1.000'), 'rounded point readout follows the actual curve');
  move(-0.1, 0.2);
  assert.ok(!texts.some((text) => text.startsWith('in ')), 'probe disappears outside the graph');
  move(0.25, 0.2);
  canvas.dispatchEvent(new Event('pointerleave'));
  assert.ok(!texts.some((text) => text.startsWith('in ')), 'probe disappears on pointer leave');
  assert.equal(edits, 0, 'probing and range refresh do not edit the curve');

  // The shared ENVELOPE editor retains its original point readout without a probe.
  const envelope = createCurveEditor({ curve: defaultCurve(), identity: false });
  frames.shift()();
  const e = new Event('pointermove');
  Object.assign(e, { clientX: 86, clientY: 100 });
  envelope.el.children[0].dispatchEvent(e);
  assert.equal(envelope.el.children[1].textContent, 'in 0.250 · double-click to add a point');
  assert.ok(!texts.some((text) => text.startsWith('in ') && text.includes(' → out ')), 'mapping remains opt-in');
  console.log('waveshaper graph tests passed');
}
