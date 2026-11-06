// Run: node test/adsr.test.mjs   (runs the real ADSR DSP kernel)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';

const SR = 48000;
const Proc = await loadKernel('adsr.dsp.js', SR);

const a = new Proc();
const msg = (data) => a.port.onmessage({ data });
const values = [];
a.port.postMessage = (v) => values.push(v);
const run = (seconds) => { for (let b = 0; b < Math.round((seconds * SR) / 128); b++) a.process([], [[new Float32Array(128)]]); return values.at(-1); };
const close = (v, t, tol, m) => assert.ok(Math.abs(v - t) <= tol, `${m}: ${v} (want ${t})`);

msg({ type: 'param', id: 'attack', value: 0.1 });
msg({ type: 'param', id: 'decay', value: 0.2 });
msg({ type: 'param', id: 'sustain', value: 50 }); // %
msg({ type: 'param', id: 'release', value: 0.4 });
close(run(0.1), 0, 0, 'idle at 0');
msg({ type: 'gate', on: true, peak: 1 });
close(run(0.05), 0.5, 0.02, 'half way through the attack');
close(run(0.05), 1, 0.02, 'peak after attack');
close(run(0.1), 0.75, 0.03, 'half way through the decay');
close(run(0.2), 0.5, 1e-9, 'sustain');
msg({ type: 'param', id: 'sustain', value: 60 });
close(run(0.01), 0.6, 1e-9, 'sustain follows the controller');
msg({ type: 'gate', on: false });
close(run(0.2), 0.3, 0.02, 'half way through the release');
close(run(0.3), 0, 0, 'back to 0');

// retrigger from the current level: no jump
msg({ type: 'gate', on: true, peak: 1 });
run(0.3);
msg({ type: 'gate', on: false });
run(0.2);
const at = values.at(-1);
msg({ type: 'gate', on: true, peak: 1 });
const after = run(128 * 2 / SR);
assert.ok(after >= at && after - at < 0.05, `retrigger continues from ${at} (got ${after})`);
// softer retrigger while high: glides down, no jump
run(0.2);
msg({ type: 'gate', on: true, peak: 0.2 });
const steps = [];
for (let i = 0; i < 100; i++) steps.push(run(256 / SR));
assert.ok(Math.max(...steps.slice(1).map((v, i) => Math.abs(v - steps[i]))) < 0.05, 'no jump down');
close(steps.at(-1), 0.12, 0.01, 'settles at sustain × softer peak');

msg({ type: 'reset' });
close(run(0.01), 0, 0, 'reset (all notes off)');
console.log('adsr tests passed');

// ---- Attack/Decay/Release Curve: the OSC envelope shapes (adsrcurve.js), exact stage times ----
{
  const { attackLevel, decayLevel, releaseLevel, curveInv, curveAt } = await import('../src/modules/adsrcurve.js');
  const adsr = (await import('../src/modules/adsr.js')).default;
  assert.deepEqual(adsr.params.map((p) => p.id), ['trigger', 'attack', 'decay', 'sustain', 'release', 'atkCurve', 'decCurve', 'relCurve', 'velocity', 'outController', 'outMin', 'outMax', 'outSmooth']);
  assert.deepEqual(adsr.params.filter((p) => /Curve$/.test(p.id)).map((p) => [p.id, p.min, p.max, p.default]),
    [['atkCurve', -100, 100, 0], ['decCurve', -100, 100, 0], ['relCurve', -100, 100, 0]], 'linear by default');
  const B = 128 / SR; // control rate: one step per render quantum
  const k = new Proc();
  const m = (data) => k.port.onmessage({ data });
  const step = () => { k.process([], [[new Float32Array(128)]]); return k.value; };
  for (const [id, value] of Object.entries({ attack: 0.1, decay: 0.2, sustain: 25, release: 0.4, atkCurve: 100, decCurve: 100, relCurve: -50 })) m({ type: 'param', id, value });
  m({ type: 'gate', on: true, peak: 0.8 });
  const nA = Math.round(0.1 / B); // 37.5 -> attack ends in block 38
  const lv = [];
  for (let i = 0; i < 300; i++) lv.push(step());
  for (const i of [0, 10, 20, 30, 36]) close(lv[i], 0.8 * attackLevel(((i + 1) * B) / 0.1, 100), 1e-9, `analog attack × peak @${i}`);
  close(lv[37], 0.8, 0, 'peak at the attack time');
  const d0 = 37; // decay starts at the peak block
  for (const i of [40, 80, 105]) close(lv[i], decayLevel(((i - d0) * B) / 0.2, 100, 0.25) * 0.8, 1e-9, `analog decay @${i}`);
  close(lv[d0 + Math.ceil(0.2 / B)], 0.2, 1e-12, 'sustain × peak after the decay time');
  m({ type: 'gate', on: false });
  const rel = [];
  for (let i = 0; i < 200; i++) rel.push(step());
  for (const i of [0, 50, 100, 140]) close(rel[i], releaseLevel(((i + 1) * B) / 0.4, -50, 0.2), 1e-9, `inverse release @${i}`);
  close(rel[Math.ceil(0.4 / B)], 0, 0, 'silent after the release time');
  assert.ok(nA > 30);

  // retrigger mid-release with a curved attack: continues from the current level, then the curve
  for (const [id, value] of Object.entries({ atkCurve: 70, relCurve: 0 })) m({ type: 'param', id, value });
  m({ type: 'gate', on: true, peak: 1 });
  for (let i = 0; i < 100; i++) step();
  m({ type: 'gate', on: false });
  for (let i = 0; i < 60; i++) step();
  const at = k.value;
  m({ type: 'gate', on: true, peak: 1 });
  const kA = Math.log(3) * 0.7;
  const u0 = curveInv(at, kA);
  close(curveAt(u0, kA), at, 1e-12, 'inverse of the curve');
  const next = step();
  close(next, curveAt(u0 + B / 0.1, kA), 1e-9, 'retrigger continues along the attack curve');
  assert.ok(next > at && next - at < 0.1, `no jump: ${at} -> ${next}`);
  // Sustain at 0 links the Decay/Release curves too (patch: linked hook)
  const { linkDecayRelease } = await import('../src/modules/envlink.js');
  assert.deepEqual(linkDecayRelease({ sustain: 0 }, 'relCurve', 30, adsr.params), { decCurve: 30 });
  console.log('adsr curves ok');
}

// ---- the shared ADSR editor on the ADSR ranges (Sustain 0..100 %, Release up to 20 s) ----
{
  const adsr = (await import('../src/modules/adsr.js')).default;
  const { adsrLayout, adsrPath, dragValues, timeFrac, handleText } = await import('../src/modules/adsrview.js');
  const v = Object.fromEntries(adsr.params.map((p) => [p.id, p.default]));
  Object.assign(v, { sustain: 40, release: 20, decCurve: 50 });
  const L = adsrLayout(v, 300, 96, adsr.params);
  assert.deepEqual(L.R, { attack: 10, decay: 10, release: 20, sustain: 100 });
  close(L.corner.y, L.yOf(0.4), 1e-9, 'Sustain 40 % drawn at 0.4');
  close(L.xR - L.xS, L.lane, 1e-9, 'Release 20 s fills its lane');
  assert.equal(adsrPath(L, 8).at(-1)[1], 0);
  const d = dragValues('corner', { values: v, y: 0 }, L.xA + L.lane * timeFrac(2, 10), L.yOf(0.75), L, adsr.params);
  assert.equal(d.sustain, 75, 'sustain in %');
  close(d.decay, 2, 1e-6, 'decay time');
  const e = dragValues('end', { values: v, y: 0 }, L.xS + L.lane * timeFrac(12, 20), 0, L, adsr.params);
  close(e.release, 12, 1e-5, 'release beyond 10 s');
  const P = (id) => adsr.params.find((p) => p.id === id);
  assert.equal(handleText(P('attack'), { attack: 0.25 }), 'Attack 250 ms', 'ADSR: own time format, no extra unit');
  assert.equal(handleText(P('decCurve'), v), 'Decay Curve +50 %');
  const osc = (await import('../src/modules/osc.js')).default;
  assert.equal(handleText(osc.params.find((p) => p.id === 'attack'), { attack: 0.25 }), 'Attack 0.25 s');
  console.log('adsr editor ok');
}

// ---- Copy / Paste ADSR between modules (right-click menu of the editor) ----
{
  const adsr = (await import('../src/modules/adsr.js')).default;
  const osc = (await import('../src/modules/osc.js')).default;
  const operator = (await import('../src/modules/operator.js')).default;
  const { copyAdsr, pasteAdsr } = await import('../src/modules/adsrview.js');
  const { linkDecayRelease } = await import('../src/modules/envlink.js');
  const defaults = (m) => Object.fromEntries(m.params.map((p) => [p.id, p.default]));
  // set the changes one by one like PatchRuntime.setParam, including the Decay/Release link
  const apply = (m, values, changes) => {
    for (const [id, v] of Object.entries(changes)) {
      values[id] = v;
      Object.assign(values, linkDecayRelease(values, id, v, m.params) ?? {});
    }
    return values;
  };

  const a = { ...defaults(adsr), attack: 0.05, decay: 1.2, sustain: 35, release: 15, atkCurve: 40, decCurve: -20, relCurve: 60 };
  const clip = copyAdsr(a, adsr.params);
  assert.equal(clip.sustain, 0.35, 'Sustain copied as a level');
  const o = apply(osc, defaults(osc), pasteAdsr(clip, osc.params));
  assert.deepEqual([o.attack, o.decay, o.sustain, o.release, o.atkCurve, o.decCurve, o.relCurve], [0.05, 1.2, 0.35, 10, 40, -20, 60], 'ADSR -> OSC: Sustain rescaled, Release clamped to 10 s');
  const back = apply(adsr, defaults(adsr), pasteAdsr(copyAdsr(o, osc.params), adsr.params));
  assert.equal(back.sustain, 35, 'OSC -> ADSR: Sustain in %');
  assert.equal(back.release, 10);
  assert.equal(pasteAdsr(clip, osc.params).gain, undefined, 'only envelope controllers');

  // pasting Sustain 0 (Decay and Release linked): the copied Decay wins, also into a target already at Sustain 0
  const pure = copyAdsr({ ...defaults(osc), sustain: 0, decay: 0.8, release: 0.8, decCurve: 30, relCurve: 30 }, osc.params);
  const t = apply(operator, { ...defaults(operator), sustain: 0, decay: 3, release: 3 }, pasteAdsr(pure, operator.params));
  assert.deepEqual([t.sustain, t.decay, t.release, t.decCurve, t.relCurve], [0, 0.8, 0.8, 30, 30]);
  // a target at Sustain 0 gets an independent Decay and Release when the pasted Sustain is not 0
  const u = apply(operator, { ...defaults(operator), sustain: 0, decay: 3, release: 3 }, pasteAdsr(copyAdsr(o, osc.params), operator.params));
  assert.deepEqual([u.sustain, u.decay, u.release], [0.35, 1.2, 10]);
  console.log('adsr copy/paste ok');
}
