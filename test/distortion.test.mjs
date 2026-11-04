import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';
import { distortionShape } from '../src/modules/distortion.dsp.js';
import { getModule } from '../src/modules/index.js';
import { dspTestHost } from './dsphost.mjs';
import { PatchRuntime } from '../src/patch.js';

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} ≠ ${b}`);
const output = (n = 128) => [[new Float32Array(n), new Float32Array(n)]];
const def = getModule('DISTORTION');
assert.deepEqual(def.params.map((p) => p.id), ['type', 'power', 'bits', 'frequency']);
assert.equal(def.params[0].options.length, 12);
assert.equal(def.params[2].min, 1);
assert.equal(def.params[2].max, 16);
assert.equal(def.params[3].max, 48000);

// Landmarks of every transfer function, independently specified.
const points = [
  [0, 2.5, 2.5], [1, 2.5, 1],
  [2, 1, 1], [2, 2, 0], [2, 3, -1], [2, 4, 0],
  [3, 1, 1], [3, 1.5, 0], [3, 2, -1], [3, 2.5, 0], [3, 3, 1],
  [4, 1, 1], [4, 2, 0], [4, 3, 1], [4, 4, 0],
  [5, 0.8, 0.8], [5, 1.25, 0.25], [5, 2.75, 0.75],
  [6, 0.8, 0.8], [6, 1.25, -0.75], [6, 2.75, 0.75],
  [7, 0.5, 0.6875], [7, 1, 1], [7, 2, -1],
  [8, Math.PI / 2, 1], [8, Math.PI, 0],
  [9, 0.5, 0.75], [9, 2, 1],
  [10, 1, 1 / Math.sqrt(2)], [11, 1, 0.5], [11, 3, 0.75],
];
for (const [type, x, y] of points) {
  close(distortionShape(x, type), y, `type ${type}, input ${x}`);
  close(distortionShape(-x, type), -y, `type ${type}, negative input`);
}
for (let type = 0; type < 12; type++) {
  assert.equal(distortionShape(0, type), 0, `type ${type}: zero stays zero`);
  for (let i = -1000; i <= 1000; i++) {
    const v = distortionShape(i / 10, type);
    assert.ok(Number.isFinite(v), `type ${type}: finite`);
    if (type) assert.ok(Math.abs(v) <= 1 + 1e-12, `type ${type}: bounded`);
  }
}

for (const sr of [44100, 48000, 96000]) {
  const Proc = await loadKernel('distortion.dsp.js', sr);
  const fresh = (values = {}) => {
    const k = new Proc();
    for (const [id, value] of Object.entries(values)) k.param(id, value);
    return k;
  };
  // Original / 16 bit / Off is an exact floating-point passthrough.
  {
    const k = fresh({ type: 0, frequency: 0 });
    const left = Float32Array.from({ length: 128 }, (_, i) => (i - 64) / 19);
    const right = Float32Array.from(left, (v) => -v / 2);
    const out = output();
    assert.equal(k.process([[left, right]], out), true);
    assert.deepEqual(out[0], [left, right]);
    k.process([[left]], out);
    assert.deepEqual(out[0], [left, left], 'mono is copied to stereo');
  }
  // The initial gain applies immediately; subsequent changes glide.
  {
    const k = fresh({ type: 0, power: 4, frequency: 0 });
    const inp = [[new Float32Array(128).fill(0.25)]], out = output();
    k.process(inp, out);
    assert.equal(out[0][0][0], 1);
    k.param('power', 0);
    k.process(inp, out);
    assert.ok(out[0][0][0] > 0.99 && out[0][0][127] < out[0][0][0]);
    for (let b = 0; b < 100; b++) k.process(inp, out);
    assert.ok(Math.abs(out[0][0][127]) < 1e-5);
    const muted = fresh({ power: 0 });
    assert.equal(muted.process(inp, out), false);
  }
  // Exactly 2^bits signed PCM levels, zero included, with 16 bypassing quantization.
  for (let bits = 1; bits < 16; bits++) {
    const k = fresh({ type: 0, bits, frequency: 0 }), out = output(2 ** bits + 1);
    const q = 2 ** (bits - 1);
    const inp = Float32Array.from({ length: out[0][0].length }, (_, i) => (i - q) / q);
    k.process([[inp]], out);
    assert.equal(new Set(out[0][0]).size, 2 ** bits, `${sr}, ${bits} bits: level count`);
    assert.ok(out[0][0].includes(0), 'digital silence is representable');
    assert.equal(out[0][0][0], -1);
    assert.equal(out[0][0].at(-1), (q - 1) / q);
  }
  // Hold clock survives block boundaries and repeated controller messages.
  for (const hz of [1, 11025, 24000, 48000, 0]) {
    const k = fresh({ type: 0, frequency: hz });
    const rate = hz === 0 ? 1 : Math.min(hz / sr, 1);
    let count = 0, previous = -1, n = 0;
    const captures = [];
    for (let b = 0; n < sr; b++) {
      const len = Math.min(127, sr - n), out = output(len);
      const left = Float32Array.from({ length: len }, (_, i) => n + i + 1);
      k.param('frequency', hz);
      k.process([[left, Float32Array.from(left, (v) => -v)]], out);
      for (let i = 0; i < len; i++) {
        const v = out[0][0][i];
        assert.equal(out[0][1][i], -v, 'stereo channels share one clock');
        if (v !== previous) { count++; captures.push(n + i); previous = v; }
      }
      n += len;
    }
    assert.ok(Math.abs(count - sr * rate) <= 1, `${sr}, ${hz} Hz: ${count} updates in one second`);
    assert.equal(captures[0], 0, 'first input sample is captured');
    for (let i = 1; i < captures.length; i++) {
      const gap = captures[i] - captures[i - 1];
      assert.ok(gap >= Math.floor(1 / rate) && gap <= Math.ceil(1 / rate), `hold interval ${gap}`);
    }
  }
  // Silent-source blocks behave like zero buffers until the hold expires.
  {
    const a = fresh({ frequency: 10 }), b = fresh({ frequency: 10 });
    const signal = [[new Float32Array(128).fill(0.5)]];
    a.process(signal, output()); b.process(signal, output());
    let heldBlocks = 0;
    for (let i = 0; i < 100; i++) {
      const oa = output(), ob = output();
      const la = a.process([[]], oa), lb = b.process([[new Float32Array(128)]], ob);
      assert.equal(la, lb);
      assert.deepEqual(oa, ob);
      if (la) heldBlocks++;
    }
    assert.ok(heldBlocks > 0 && heldBlocks < 80, 'hold rings out, then becomes silent');
    a.panic();
    assert.equal(a.process([[]], output()), false, 'panic clears the hold');
    a.param('frequency', 0);
    a.process([[new Float32Array(128).fill(0.25)]], output());
    const o = output();
    a.process([[new Float32Array(128).fill(0.75)]], o);
    assert.equal(o[0][0][0], 0.75, 'Off processes every sample immediately');
  }
}

globalThis.sampleRate = 48000;
{
  const { dsp, render } = dspTestHost();
  const engine = { ctx: { currentTime: 0 }, dsp, createPatch(sink) { return PatchRuntime.create(this, sink); } };
  const root = await PatchRuntime.create(engine, dsp.destination);
  const src = await root.addModule('OSC');
  const fx = await root.addModule('DISTORTION', { values: { type: 8, power: 8, bits: 7, frequency: 9000 } });
  root.connect(src.id, fx.id); root.connect(fx.id, 0);
  src.inst.noteOn(1, 60, 1);
  const { L } = render(10);
  assert.ok(L.some((v) => Math.abs(v) > 0.01), 'audio passes through the new module');
  const clone = await root.duplicate(fx.id);
  assert.deepEqual(clone.values, fx.values, 'duplication retains all controllers');
  const json = JSON.parse(JSON.stringify(root.toJSON()));
  const loaded = await PatchRuntime.create(engine, dsp.destination);
  await loaded.load(json);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.toJSON())), json, 'save/load retains DISTORTION and cables');
  root.destroy(); loaded.destroy();
}

// Type chart: same transfer and bit crushing as the kernel; louder sine to the right.
{
  const { previewPoints, crush, gainAt, gainPos, MIN_GAIN, MAX_GAIN } = await import('../src/modules/distortionview.js');
  close(gainAt(0), MIN_GAIN, 'chart starts quiet');
  close(gainAt(1), MAX_GAIN, 'chart ends hot');
  close(gainPos(1), 0.5, 'Power 1 marker in the middle');
  close(gainPos(100), 1, 'Power marker clamps');
  for (let type = 0; type < 12; type++) {
    const ys = previewPoints(type, 16, 257);
    assert.equal(ys.length, 257);
    assert.ok(ys.every(Number.isFinite), `chart row ${type} finite`);
  }
  const peak = (ys) => Math.max(...ys.map(Math.abs));
  assert.ok(peak(previewPoints(0, 16).slice(400)) > 3, 'Original grows past full scale');
  close(peak(previewPoints(1, 16)), 1, 'Clipping row stops at full scale');
  assert.ok(previewPoints(1, 2).every((y) => [-1, -0.5, 0, 0.5].includes(y)), '2-bit preview uses 4 levels');
  close(crush(0.3, 16), 0.3, '16 bit bypasses');
}
console.log('distortion tests passed');
