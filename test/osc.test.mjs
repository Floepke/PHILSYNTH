// Run: node test/osc.test.mjs   (runs the real OSC DSP kernel)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';
import osc from '../src/modules/osc.js';
import { fromNorm, nudge } from '../src/params.js';

const SR = 48000;
const Proc = await loadKernel('osc.dsp.js', SR);
const { shape } = Proc.Kernel;
const [SINE, TRISAW, SAW, SQUARE, HALF_SINE] = [0, 1, 2, 3, 4];
const inc = 1e-4; // low note: band-limiting only touches the edges
const N = 10000;
const cycle = (w, d) => Array.from({ length: N }, (_, i) => shape(w, (i + 0.5) / N, d, inc));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const argmax = (a) => a.indexOf(Math.max(...a));
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// Append the waveform without renumbering saved wave selections or controller routings.
assert.deepEqual(osc.params.map((p) => p.id), ['polyphony', 'wave', 'attack', 'decay', 'sustain', 'release', 'gain', 'duty']);
const waveParam = osc.params[1];
assert.deepEqual(waveParam.options, ['Sine', 'Tri/Saw', 'Saw', 'Square', 'Half sine',
  'White noise', 'Pink noise', 'Brown noise', 'Blue noise', 'Violet noise']);
assert.equal(waveParam.default, SAW);
const VIOLET = 9;
assert.equal(waveParam.max, VIOLET);
assert.equal(fromNorm(waveParam, 1), VIOLET);
assert.equal(nudge(waveParam, SQUARE, 1), HALF_SINE);
assert.equal(nudge(waveParam, HALF_SINE, 1), 5);
const dutyParam = osc.params[7];
assert.ok(dutyParam.visible({ wave: SAW }) && !dutyParam.visible({ wave: 6 }), 'Duty Cycle hidden for noise');

// 50 % = the classic waveforms
for (let i = 1; i < 20; i++) {
  const t = i / 20 + 0.013;
  close(shape(SINE, t, 0.5, inc), Math.sin(2 * Math.PI * t), 1e-9, 'sine @50%');
  close(shape(TRISAW, t, 0.5, inc), 1 - 4 * Math.abs(t - 0.5), 1e-9, 'triangle @50%');
  close(shape(SAW, t, 0.5, inc), 2 * t - 1, 1e-9, 'saw @50%');
  close(shape(SQUARE, t, 0.5, inc), t < 0.5 ? 1 : -1, 1e-9, 'square @50%');
}

// the original bipolar waveforms stay centred (no DC) and bounded at every duty
for (const w of [SINE, TRISAW, SAW, SQUARE]) for (const d of [0, 0.1, 0.3, 0.5, 0.8, 1]) {
  const c = cycle(w, d);
  close(mean(c), 0, 0.01, `DC wave ${w} duty ${d}`);
  assert.ok(c.every((x) => Number.isFinite(x) && Math.abs(x) < 2.2), `bounded wave ${w} duty ${d}`);
}

// sine: the positive half-wave is squeezed into d, the negative stretched over 1-d
const s20 = cycle(SINE, 0.2);
close(argmax(s20) / N, 0.1, 0.002, 'sine @20% peaks at 10%');
close(s20.indexOf(Math.min(...s20)) / N, 0.6, 0.002, 'sine @20% trough at 60%');
const off = (2 / Math.PI) * (2 * 0.2 - 1);
close(shape(SINE, 0.05, 0.2, inc) + off, Math.sin(Math.PI / 2 * 0.5), 1e-9, 'squeezed half is still sine-shaped');

// tri/saw: peak at d; 100% is a rising saw, 0% a falling saw
close(argmax(cycle(TRISAW, 0.25)) / N, 0.25, 0.002, 'tri/saw peak follows duty');
close(shape(TRISAW, 0.3, 1, inc), -1 + 2 * 0.3 / (1 - 2 * inc), 1e-6, 'tri/saw @100% = rising saw');
close(shape(TRISAW, 0.3, 0, inc), 1 - 2 * (0.3 - 2 * inc) / (1 - 2 * inc), 1e-6, 'tri/saw @0% = falling saw');

// saw: ramp bent at d, the bend rounded with a sine-shaped curve (no corner)
{
  const { sawBend } = await import('../src/modules/oscshape.js');
  for (const d of [0.05, 0.2, 0.35, 0.65, 0.9]) {
    const ys = Array.from({ length: N + 1 }, (_, i) => sawBend(i / N, d));
    const span = ys[N] - ys[0];
    close(span, 2, 1e-9, `saw @${d} still spans -1..1`);
    const slopes = ys.slice(1).map((y, i) => (y - ys[i]) * N);
    assert.ok(slopes.every((s) => s > 0), `saw @${d} rises monotonically`);
    const jump = Math.max(...slopes.slice(1).map((s, i) => Math.abs(s - slopes[i])));
    assert.ok(jump < 0.02 * Math.max(1 / d, 1 / (1 - d)), `saw @${d} has no corner (max slope step ${jump})`);
    close(slopes[0], 1 / d, 0.02 / d, `saw @${d} starts on the first ramp`);
    close(slopes[N - 1], 1 / (1 - d), 0.02 / (1 - d), `saw @${d} ends on the second ramp`);
  }
}

// square: pulse width
const q = cycle(SQUARE, 0.25);
close(q.filter((x) => x > 0).length / N, 0.25, 0.002, 'square @25% is high for a quarter');

// Half sine keeps its exact positive bow and zero tail, including 0% and 100% duty.
for (const d of [0, 0.001, 0.01, 0.1, 0.25, 0.5, 0.8, 1]) {
  const c = cycle(HALF_SINE, d);
  assert.ok(c.every((x) => Number.isFinite(x) && x >= 0 && x <= 1));
  close(c.filter((x) => x > 0).length / N, d, 1 / N, `half sine active fraction @${d}`);
  close(mean(c), 2 * d / Math.PI, 1e-5, `half sine preserves its zero baseline @${d}`);
  for (const dt of [inc, 0.01, 0.45]) {
    assert.equal(shape(HALF_SINE, 0, d, dt), 0);
    for (const t of [d, d + (1 - d) / 2, 1]) {
      assert.equal(shape(HALF_SINE, t, d, dt), 0, `zero tail @${d}, phase ${t}`);
    }
    if (d > 0) for (const fraction of [0.125, 0.25, 0.5, 0.75, 0.875]) {
      close(shape(HALF_SINE, fraction * d, d, dt), Math.sin(Math.PI * fraction), 1e-12, `sine bow @${d}`);
    }
  }
}

// the processor renders with duty, also while it sweeps
const p = new Proc();
const msg = (data) => p.port.onmessage({ data });
msg({ type: 'param', id: 'wave', value: SINE });
msg({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
let peak = 0;
for (let b = 0; b < 200; b++) {
  msg({ type: 'param', id: 'duty', value: (b * 7) % 101 });
  const out = [new Float32Array(128), new Float32Array(128)];
  p.process([], [out]);
  for (const x of out[0]) { assert.ok(Number.isFinite(x)); peak = Math.max(peak, Math.abs(x)); }
}
assert.ok(peak > 0.05 && p.duty >= 0 && p.duty <= 1, `renders (peak ${peak})`);

// MODMIDI phase: where the voice starts in its waveform cycle
{
  const { startPhase } = await import('../src/modules/osc.dsp.js');
  assert.equal(startPhase(0.25), 0.25);
  assert.equal(startPhase(1.75), 0.75);
  assert.ok(Math.abs(startPhase(-0.25) - 0.75) < 1e-12);
  assert.equal(startPhase(undefined), 0, 'no phase: start of the cycle (as before)');
  assert.equal(startPhase(NaN), 0);
  assert.equal(startPhase(Infinity), 0);
  const k = new Proc();
  const m = (data) => k.port.onmessage({ data });
  m({ type: 'param', id: 'wave', value: SINE });
  m({ type: 'param', id: 'attack', value: 0.001 });
  m({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  m({ type: 'noteOn', id: 2, pitch: 60, velocity: 1, phase: 0.5 });
  const [v1, v2] = k.voices;
  assert.equal(v1.phase, 0);
  assert.equal(v2.phase, 0.5);
  const o = [new Float32Array(128), new Float32Array(128)];
  k.process([], [o]);
  // same pitch, half a cycle apart: the two sines cancel out
  assert.ok(o[0].every((x) => Math.abs(x) < 1e-3), 'phase 0 and 0.5 of a sine cancel');
  m({ type: 'noteOn', id: 2, pitch: 60, velocity: 1, phase: 0 });
  k.process([], [o]);
  assert.ok(Math.max(...o[0].map(Math.abs)) > 0.01, 'retriggered in phase: they add up');
}

// Exercise the actual audio renderer and duty smoothing, not just the shape helper.
const half = new Proc();
const halfMsg = (data) => half.port.onmessage({ data });
for (const [id, value] of Object.entries({ wave: HALF_SINE, attack: 0.001, decay: 0.001, sustain: 1, gain: 1 })) {
  halfMsg({ type: 'param', id, value });
}
halfMsg({ type: 'noteOn', id: 1, pitch: 69 + 12 * Math.log2((SR / 128) / 440), velocity: 1 });
const halfOut = [new Float32Array(128), new Float32Array(128)];
for (const d of [1, 0.25, 0, 0.001, 0.5]) {
  halfMsg({ type: 'param', id: 'duty', value: d * 100 });
  for (let b = 0; b < 64; b++) {
    half.process([], [halfOut]);
    assert.ok(halfOut[0].every((x) => Number.isFinite(x) && x >= 0 && x <= 0.5), 'bounded while duty changes');
    assert.deepEqual(halfOut[1], halfOut[0], 'identical stereo output');
  }
  assert.equal(half.duty, d, 'duty settles to the requested value, including endpoints');
  half.voiceOf(1).phase = 0;
  half.process([], [halfOut]);
  for (let i = 0; i < 128; i++) {
    const t = i / 128;
    const expected = d > 0 && t < d ? Math.sin(Math.PI * t / d) * 0.5 : 0;
    close(halfOut[0][i], expected, 1e-7, `rendered half sine @${d}, sample ${i}`);
    if (t > d || d === 0) assert.equal(halfOut[0][i], 0, 'rendered tail is exactly zero');
  }
}
halfMsg({ type: 'allOff' });
half.process([], [halfOut]);
assert.ok(halfOut[0].every((x) => x === 0), 'allOff silences half sine');

console.log('osc tests passed');

// Panel waveform preview uses the same shape() as the DSP, two cycles, peak-normalised.
{
  const { waveformPoints } = await import('../src/modules/oscview.js');
  const { shape: shared } = await import('../src/modules/oscshape.js');
  assert.equal(shared, shape, 'worklet and preview share one shape()');
  const sq = waveformPoints(SQUARE, 25, 801);
  assert.equal(sq.length, 801);
  assert.ok(Math.max(...sq.map(Math.abs)) <= 1 + 1e-9);
  const high = sq.filter((y) => y > 0).length / sq.length;
  close(high, 0.25, 0.02, 'square preview pulse width follows duty');
  const sine = waveformPoints(SINE, 50, 401);
  close(sine[50], 1, 1e-3, 'sine peak at a quarter of the first cycle');
  close(sine[250], 1, 1e-3, 'second cycle repeats');
  const hs = waveformPoints(HALF_SINE, 50, 401);
  assert.ok(Math.min(...hs) >= 0, 'half sine stays unipolar');
  assert.deepEqual(waveformPoints(SAW, -10, 50), waveformPoints(SAW, 0, 50), 'duty clamps');
  for (const w of [5, 6, 7, 8, 9]) {
    const nz = waveformPoints(w, 50, 300);
    assert.ok(Math.max(...nz.map(Math.abs)) <= 1 + 1e-9 && nz.some((y) => y > 0.3) && nz.some((y) => y < -0.3), `noise ${w} preview`);
    assert.deepEqual(nz, waveformPoints(w, 50, 300), 'noise preview is stable between redraws');
  }
  console.log('osc waveform preview ok');
}

// ---- noise colours ----
{
  const render = (wave, { seed = 99, pitch = 60, blocks = 400, poly = 1, notes = [pitch] } = {}) => {
    const k = new Proc({ seed });
    const m = (data) => k.port.onmessage({ data });
    m({ type: 'param', id: 'polyphony', value: poly });
    m({ type: 'param', id: 'wave', value: wave });
    m({ type: 'param', id: 'attack', value: 0.001 });
    m({ type: 'param', id: 'sustain', value: 1 });
    m({ type: 'param', id: 'gain', value: 1 });
    notes.forEach((p, i) => m({ type: 'noteOn', id: i + 1, pitch: p, velocity: 1 }));
    const all = new Float32Array(blocks * 128);
    for (let b = 0; b < blocks; b++) {
      const out = [new Float32Array(128), new Float32Array(128)];
      k.process([], [out]);
      all.set(out[0], b * 128);
    }
    return { k, m, y: all.subarray(4800) }; // skip the attack and the filter settling
  };
  const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  // energy split: one-pole lowpass at ~300 Hz vs the rest
  const lowShare = (a) => {
    let lp = 0, lo = 0, all = 0;
    for (const x of a) { lp += 0.04 * (x - lp); lo += lp * lp; all += x * x; }
    return lo / all;
  };
  const shares = [5, 6, 7, 8, 9].map((w) => lowShare(render(w).y));
  const [white, pink, brown, blue, violet] = shares;
  assert.ok(brown > pink && pink > white && white > blue && blue > violet,
    `noise colours get brighter brown > pink > white > blue > violet in low energy: ${shares.map((x) => x.toFixed(3))}`);
  for (const w of [5, 6, 7, 8, 9]) {
    const { y } = render(w);
    const r = rms(y) / 0.5; // gain 1 → output × 0.5
    assert.ok(r > 0.25 && r < 0.75, `noise ${w} loudness ~ white: rms ${r}`);
    assert.ok(Math.abs(y.reduce((s, x) => s + x, 0) / y.length) < 0.05, `noise ${w} has no DC`);
    assert.ok(y.every((x) => Number.isFinite(x) && Math.abs(x) < 1.5), `noise ${w} bounded`);
  }
  // unpitched: another note gives the same noise; another seed (other instance) different noise
  assert.deepEqual(render(6, { pitch: 30 }).y, render(6, { pitch: 90 }).y, 'noise ignores pitch');
  const a = render(5, { seed: 1 }).y, b = render(5, { seed: 2 }).y;
  assert.ok(a.some((x, i) => x !== b[i]), 'every OSC instance has its own noise');
  const r1 = render(5, { seed: null }).y, r2 = render(5, { seed: null }).y;
  assert.ok(r1.some((x, i) => x !== r2[i]), 'random seed by default');
  // two voices are uncorrelated (shared generator, different samples): louder by ~√2, not 2
  const two = rms(render(5, { poly: 2, notes: [60, 60.0001] }).y) / rms(render(5).y);
  assert.ok(two > 1.25 && two < 1.6, `two noise voices add as uncorrelated noise: ${two}`);
  // the envelope still shapes the noise: release ends in silence
  const { k, m } = render(7, { blocks: 50 });
  m({ type: 'param', id: 'release', value: 0.01 });
  m({ type: 'noteOff', id: 1 });
  let alive = true;
  for (let b = 0; b < 20; b++) alive = k.process([], [[new Float32Array(128), new Float32Array(128)]]) !== false;
  assert.equal(alive, false, 'noise voice releases to silence');
  console.log('osc noise ok');
}
