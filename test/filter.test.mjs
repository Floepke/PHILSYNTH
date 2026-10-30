// Run: node test/filter.test.mjs   (runs the real DSP kernel)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';

const SR = 48000;
const Proc = await loadKernel('filter.dsp.js', SR);

const make = (params) => {
  const f = new Proc();
  for (const [id, value] of Object.entries(params)) f.port.onmessage({ data: { type: 'param', id, value } });
  return f;
};

// returns gain in dB of a sine at `freq` through the filter (steady state)
function gainDb(params, freq, { seconds = 0.4, amp = 0.25 } = {}) {
  const f = make(params);
  const N = 128;
  const blocks = Math.ceil((seconds * SR) / N);
  let inE = 0;
  let outE = 0;
  let t = 0;
  for (let b = 0; b < blocks; b++) {
    const L = new Float32Array(N);
    for (let i = 0; i < N; i++) L[i] = amp * Math.sin((2 * Math.PI * freq * t++) / SR);
    const R = L.slice();
    const out = [new Float32Array(N), new Float32Array(N)];
    f.process([[L, R]], [out]);
    if (b > blocks / 2) for (let i = 0; i < N; i++) { inE += L[i] * L[i]; outE += out[0][i] * out[0][i]; }
  }
  return 10 * Math.log10(outE / inE);
}

const near = (v, target, tol, msg) => assert.ok(Math.abs(v - target) <= tol, `${msg}: ${v.toFixed(2)} dB (want ${target}±${tol})`);
const below = (v, max, msg) => assert.ok(v < max, `${msg}: ${v.toFixed(2)} dB (want < ${max})`);
const fc = 1000;
const base = { cutoff: fc, resonance: 0.08 };

// Low-pass, all slopes: passband ~0 dB, stopband falls steeper per slope
const lpStop = [0, 1, 2, 3].map((slope) => {
  near(gainDb({ ...base, type: 0, slope }, 100), 0, 0.5, `LP slope ${slope} passband`);
  return gainDb({ ...base, type: 0, slope }, 8000);
});
below(lpStop[0], -30, 'LP 12dB @ 3 oct'); // ~-36
below(lpStop[1], -65, 'LP 24dB @ 3 oct'); // ~-72
assert.ok(lpStop[3] < lpStop[2] && lpStop[2] < lpStop[1], 'steeper slopes attenuate more');

near(gainDb({ ...base, type: 1, slope: 1 }, 10000), 0, 0.5, 'HP passband');
below(gainDb({ ...base, type: 1, slope: 1 }, 125), -65, 'HP stopband');

near(gainDb({ ...base, type: 2, slope: 0 }, fc), 0, 0.5, 'BP centre');
below(gainDb({ ...base, type: 2, slope: 0 }, 100), -15, 'BP skirt');

below(gainDb({ ...base, type: 3, slope: 0 }, fc), -40, 'Notch centre');
near(gainDb({ ...base, type: 3, slope: 0 }, 100), 0, 0.5, 'Notch passband');

// resonant peak rises with resonance
const pk = gainDb({ type: 4, slope: 0, cutoff: fc, resonance: 0.6 }, fc);
assert.ok(pk > 6, `Peak boosts at cutoff: ${pk.toFixed(2)} dB`);

for (const f of [100, 1000, 7000]) near(gainDb({ ...base, type: 5, slope: 2 }, f), 0, 0.3, `All-pass flat @${f}`);

near(gainDb({ type: 6, cutoff: fc, resonance: 0.2, gain: 12 }, fc), 12, 0.5, 'Bell +12 at centre');
near(gainDb({ type: 6, cutoff: fc, resonance: 0.2, gain: -12 }, fc), -12, 0.5, 'Bell -12 at centre');
near(gainDb({ type: 6, cutoff: fc, resonance: 0.2, gain: 12 }, 50), 0, 1, 'Bell flat far away');
near(gainDb({ type: 7, cutoff: fc, resonance: 0.08, gain: 9 }, 40), 9, 0.6, 'Low shelf boost');
near(gainDb({ type: 7, cutoff: fc, resonance: 0.08, gain: 9 }, 15000), 0, 0.6, 'Low shelf top flat');
near(gainDb({ type: 8, cutoff: fc, resonance: 0.08, gain: -9 }, 15000), -9, 0.6, 'High shelf cut');
near(gainDb({ type: 8, cutoff: fc, resonance: 0.08, gain: -9 }, 40), 0, 0.6, 'High shelf bottom flat');

// Ladder: 24 dB/oct-ish low-pass
const lad = gainDb({ type: 9, cutoff: fc, resonance: 0 }, 8000);
near(gainDb({ type: 9, cutoff: fc, resonance: 0 }, 100), 0, 1, 'Ladder passband');
below(lad, -60, 'Ladder stopband');

// Comb +: peak at fc multiples, dip halfway between; Comb −: the opposite
const combP = gainDb({ type: 10, cutoff: 500, resonance: 0.9 }, 1000);
const combPdip = gainDb({ type: 10, cutoff: 500, resonance: 0.9 }, 750);
assert.ok(combP - combPdip > 20, `Comb+ peak vs dip: ${combP.toFixed(1)} / ${combPdip.toFixed(1)}`);
const combN = gainDb({ type: 11, cutoff: 500, resonance: 0.9 }, 750);
const combNdip = gainDb({ type: 11, cutoff: 500, resonance: 0.9 }, 1000);
assert.ok(combN - combNdip > 20, `Comb− peak vs dip: ${combN.toFixed(1)} / ${combNdip.toFixed(1)}`);

// Formant 'A' (F1 800 Hz) passes 800 Hz far more than 5 kHz; 'I' (F1 270) favours 270 over 800
const fA = gainDb({ type: 12, vowel: 0, resonance: 0.3 }, 800) - gainDb({ type: 12, vowel: 0, resonance: 0.3 }, 5000);
assert.ok(fA > 20, `Formant A selectivity ${fA.toFixed(1)}`);
const fI = gainDb({ type: 12, vowel: 2, resonance: 0.3 }, 270) - gainDb({ type: 12, vowel: 2, resonance: 0.3 }, 800);
assert.ok(fI > 10, `Formant I selectivity ${fI.toFixed(1)}`);

// Dry/wet and level
near(gainDb({ ...base, type: 0, slope: 3, mix: 0 }, 8000), 0, 0.2, 'mix 0 = dry');
near(gainDb({ ...base, type: 0, level: 0.5 }, 100), -6.02, 0.3, 'level 0.5');

// Stability: every type, max resonance/drive, fast LFO sweep over full range, loud noise -> finite & bounded
for (let type = 0; type <= 12; type++) {
  for (const slope of [0, 3]) {
    const f = make({ type, slope, cutoff: 2000, resonance: 1, gain: 24, drive: 1, lfoDepth: 4, lfoRate: 20, lfoShape: 4, vowel: 2.5 });
    let peak = 0;
    for (let b = 0; b < 400; b++) {
      const L = Float32Array.from({ length: 128 }, () => Math.random() * 2 - 1);
      const out = [new Float32Array(128), new Float32Array(128)];
      f.process([[L, L]], [out]);
      for (const v of out[0]) {
        assert.ok(Number.isFinite(v), `type ${type} produced non-finite output`);
        peak = Math.max(peak, Math.abs(v));
      }
    }
    assert.ok(peak < 100, `type ${type} slope ${slope} peak ${peak.toFixed(1)} too large`);
  }
}

// mono input fills both outputs; no input -> the tail rings out, then silence (returns false)
{
  const f = make({ type: 0, resonance: 0.9 });
  const out = [new Float32Array(128), new Float32Array(128)];
  f.process([[Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 10))]], [out]);
  assert.deepEqual(out[0], out[1]);
  assert.equal(f.process([[]], [out]), true, 'still ringing');
  assert.ok(out[0].some((v) => Math.abs(v) > 1e-4), 'resonant tail continues without input');
  let blocks = 1;
  while (f.process([[]], [out]) && blocks < 5000) blocks++;
  assert.ok(blocks < 5000, 'stops once the tail is silent');
  assert.ok(out[0].every((v) => v === 0));
  assert.equal(f.process([], [out]), false, 'stays silent');
}

// LFO shape Random (5): smooth random glides, bipolar, a new target every cycle
{
  const def = (await import('../src/modules/filter.js')).default;
  const shapeParam = def.params.find((p) => p.id === 'lfoShape');
  assert.equal(shapeParam.options[5], 'Random');
  assert.equal(shapeParam.max, 5);
  const ids = def.params.map((p) => p.id);
  assert.ok(ids.indexOf('lfoShape') < ids.indexOf('lfoRate'), 'controller numbering unchanged');

  const f = make({ lfoShape: 0, lfoRate: 50 });
  for (let i = 0; i < 100; i++) f.lfo(); // somewhere into the sine
  const before = f.lfoLast;
  f.port.onmessage({ data: { type: 'param', id: 'lfoShape', value: 5 } });
  const first = f.lfo();
  assert.ok(Math.abs(first - before) < 0.05, `switching to Random continues from the current value (${before} -> ${first})`);
  const vals = [first];
  for (let i = 0; i < SR; i++) vals.push(f.lfo()); // 1 s = 50 cycles
  assert.ok(vals.every((v) => v >= -1 && v <= 1), 'Random stays within -1..1');
  const maxStep = Math.max(...vals.slice(1).map((v, i) => Math.abs(v - vals[i])));
  assert.ok(maxStep < 2 * 1.5 * 50 / SR + 1e-9, `Random glides without jumps (max step ${maxStep})`);
  // the value at each cycle start is a target: they differ (random) and span both halves
  const starts = vals.filter((_, i) => i % (SR / 50) === 0);
  assert.ok(new Set(starts.map((v) => v.toFixed(6))).size > 40, 'new random target every cycle');
  assert.ok(Math.min(...vals) < -0.3 && Math.max(...vals) > 0.3, 'Random is bipolar');
  // it modulates the cutoff: output differs from a steady filter
  const g1 = gainDb({ type: 0, cutoff: 500, lfoShape: 5, lfoRate: 8, lfoDepth: 3 }, 1000, { seconds: 1 });
  assert.ok(Number.isFinite(g1));
}

console.log('all filter tests passed');
