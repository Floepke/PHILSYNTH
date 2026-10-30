// Run: node test/patch.test.mjs   (uses a mock Web Audio graph)
import assert from 'node:assert/strict';

import { dspTestHost } from './dsphost.mjs';

const ctx = { currentTime: 0 };
const { dsp, graph, render, kernel } = dspTestHost();

const { PatchRuntime } = await import('../src/patch.js');
const engine = {
  ctx, dsp,
  createPatch(sink) { return PatchRuntime.create(this, sink); },
};

const root = await PatchRuntime.create(engine, dsp.destination);
const out = root.modules.get(0);
assert.ok(out.inst.input.out.has(dsp.destination), 'Output feeds destination');
assert.equal(root.removeModule(0), false, 'Output cannot be deleted');

const osc = await root.addModule('OSC', { x: 10, y: 10 });
const sub = await root.addModule('PATCH', { x: 100, y: 10 });
assert.equal(osc.id, 1); assert.equal(sub.id, 2);
assert.ok(root.connect(1, 2)); assert.ok(root.connect(2, 0));
assert.equal(root.connect(1, 2), false, 'no duplicate cable');
assert.equal(root.connect(0, 1), false, 'Output has no output port');
assert.equal(root.connect(2, 1), false, 'OSC has no input port');

// inside the patch: route input to an inner module
const inner = sub.inst.patch;
assert.ok(inner.modules.get(0).def.isOutput);
// default Input Module = 0 -> passthrough to inner Output
assert.ok(sub.inst.input.out.has(inner.modules.get(0).inst.input));
assert.ok(inner.modules.get(0).inst.input.out.has(sub.inst.node), 'inner Output feeds patch output');
const innerOsc = await inner.addModule('OSC');
const inner2 = await inner.addModule('PATCH');
assert.equal(innerOsc.id, 1);
assert.ok(inner.connect(2, 0));
root.setParam(2, 'inputModule', 2);
assert.ok(sub.inst.input.out.has(inner2.inst.input), 'input routed to module 2');
assert.equal(sub.inst.input.out.size, 1);
assert.equal(sub.inst.params()[0].max, 2);
inner.removeModule(2);
assert.equal(sub.inst.input.out.size, 0, 'route cleared when target deleted');
root.setParam(2, 'inputModule', 0);

// cycles rejected
const sub2 = await root.addModule('PATCH');
assert.ok(root.connect(2, 3)); assert.equal(root.connect(3, 2), false, 'loop rejected');

// save / load round trip incl. nested
const nestedOsc = await inner.addModule('OSC', { values: { polyphony: 5, wave: 4, duty: 25 } });
root.setParam(0, 'volume', 0.3);
const json = JSON.parse(JSON.stringify(root.toJSON()));
const root2 = await PatchRuntime.create(engine, dsp.destination);
await root2.load(json);
assert.deepEqual(JSON.parse(JSON.stringify(root2.toJSON())), json);
assert.equal(root2.modules.get(0).values.volume, 0.3);
const n2 = root2.modules.get(2).inst.patch.modules.get(nestedOsc.id);
assert.equal(n2.values.polyphony, 5);
assert.equal(n2.values.wave, 4, 'half sine survives saving and loading');
assert.equal(n2.values.duty, 25, 'half sine bow length survives saving and loading');

// deleting a patch module destroys its contents and cables
root.removeModule(2);
assert.equal(root.cables.some((c) => c.from === 2 || c.to === 2), false);

// lowest free module number is reused
assert.deepEqual([...root.modules.keys()].sort(), [0, 1, 3]);
assert.equal((await root.addModule('OSC')).id, 2, 'fills gap at 2');
assert.equal((await root.addModule('OSC')).id, 4, 'then continues after 3');
root.removeModule(1);
root.removeModule(3);
const [c1, c2, c3] = await Promise.all([root.addModule('OSC'), root.addModule('PATCH'), root.addModule('OSC')]);
assert.deepEqual([c1.id, c2.id, c3.id], [1, 3, 5], 'concurrent inserts get distinct lowest ids');
await assert.rejects(root.addModule('OSC', { id: 2 }), /already taken/);
assert.equal((await c2.inst.patch.addModule('OSC')).id, 1, 'numbering is per patch');

// ---- duplicate ----
{
  const r = await PatchRuntime.create(engine, dsp.destination);
  const osc = await r.addModule('OSC', { x: 10, y: 20, values: { polyphony: 3, wave: 1 } });
  const p = await r.addModule('PATCH');
  await p.inst.patch.addModule('OSC', { values: { gain: 0.2 } });
  r.connect(osc.id, 0);
  assert.equal(await r.duplicate(0), null, 'Output cannot be duplicated');
  const c = await r.duplicate(osc.id, { x: 100, y: 200 });
  assert.equal(c.id, 3, 'lowest free number');
  assert.deepEqual([c.x, c.y], [100, 200]);
  assert.deepEqual(c.values, osc.values);
  assert.notEqual(c.values, osc.values, 'values are copied, not shared');
  assert.equal(r.cables.some((k) => k.from === 3 || k.to === 3), false, 'cables not copied');
  const pc = await r.duplicate(p.id);
  assert.notEqual(pc.inst.patch, p.inst.patch, 'nested patch is a separate copy');
  assert.equal(pc.inst.patch.modules.get(1).values.gain, 0.2, 'nested contents copied');
  pc.inst.patch.setParam(1, 'gain', 0.9);
  assert.equal(p.inst.patch.modules.get(1).values.gain, 0.2, 'editing the copy leaves the original');

  // group duplicate keeps internal cables only; Output is skipped
  const flt = await r.addModule('FILTER', { x: 50, y: 50 });
  assert.ok(r.connect(osc.id, flt.id));
  const copies = await r.duplicateMany([0, osc.id, flt.id], 10, 5);
  assert.equal(copies.length, 2, 'Output skipped');
  const [co, cf] = copies;
  assert.deepEqual([co.def.type, cf.def.type], ['OSC', 'FILTER']);
  assert.deepEqual([cf.x, cf.y], [60, 55]);
  assert.ok(r.cables.some((k) => k.from === co.id && k.to === cf.id), 'internal cable copied');
  assert.equal(r.cables.some((k) => k.from === co.id && k.to === 0), false, 'cable to a module outside the group not copied');
  const count = r.modules.size;
  assert.equal(r.removeMany([0, co.id, cf.id]), 2, 'removeMany skips Output');
  assert.equal(r.modules.size, count - 2);
  assert.ok(r.modules.has(0));
}

// ---- Amplifier ----
{
  const r = await PatchRuntime.create(engine, dsp.destination);
  const amp = await r.addModule('AMP');
  const osc = await r.addModule('OSC');
  assert.ok(r.connect(osc.id, amp.id) && r.connect(amp.id, 0), 'audio in and out');
  const k = kernel(amp.inst.node);
  assert.deepEqual(k.t, [1, 1], 'default 1×');
  r.setParam(amp.id, 'amp', 4);
  assert.deepEqual(k.t, [4, 4]);
  r.setParam(amp.id, 'inverse', 1);
  assert.deepEqual(k.t, [-4, -4], 'inverse flips polarity');
  r.setParam(amp.id, 'amp', 0.5);
  assert.deepEqual(k.t, [-0.5, -0.5], 'inverse kept when amplification changes');
  r.setParam(amp.id, 'inverse', 0);
  r.setParam(amp.id, 'pan', -1);
  assert.deepEqual(k.t, [0.5, 0], 'hard left fades the right channel');
  r.setParam(amp.id, 'pan', 0);
  r.setParam(amp.id, 'amp', 2);
  const { panGains } = await import('../src/modules/amp.js');
  assert.deepEqual(panGains(0), [1, 1], 'center is unity on both sides');
  assert.deepEqual(panGains(-1), [1, 0], 'hard left');
  assert.deepEqual(panGains(0.5), [0.5, 1]);
  const pan = amp.def.params[1];
  assert.deepEqual([pan.format(0), pan.format(-1), pan.format(0.25)], ['Center', '100 % L', '25 % R']);
  // audio: the AMP output is twice its input (after smoothing settles)
  const ga = graph.nodes.get(amp.inst.node.h);
  const go = graph.nodes.get(osc.inst.node.h);
  render(4);
  assert.equal(ga.silent, true, 'nothing playing: the AMP is skipped');
  assert.deepEqual(k.g, [1, 1], 'and not rendered at all');
  osc.inst.noteOn(1, 69, 1);
  render(100);
  assert.ok(Math.abs(k.g[0] - 2) < 1e-6, 'gain smoothed to its target');
  const i = 64;
  assert.ok(Math.abs(ga.outs[0][0][i] - 2 * go.outs[0][0][i]) < 1e-6, 'AMP doubles the OSC signal');
  osc.inst.allOff();
  r.destroy();
}

// ---- DC BLOCKER: no controllers, removes a DC offset, passes audio ----
{
  const r = await PatchRuntime.create(engine, dsp.destination);
  const dc = await r.addModule('DC BLOCKER');
  assert.equal(dc.def.params.length, 0, 'works out of the box: no controllers');
  assert.ok(!r.modules.get(dc.id).def.acceptsMidi);
  const k = kernel(dc.inst.node);
  const run = (fn, blocks) => {
    const out = [[new Float32Array(128), new Float32Array(128)]];
    let last = null;
    for (let b = 0; b < blocks; b++) {
      const L = new Float32Array(128).map((_, i) => fn(b * 128 + i));
      k.process([[L, L]], out);
      last = out[0][0].slice();
    }
    return last;
  };
  const dcOut = run(() => 0.5, 375 * 2); // 2 s of constant 0.5
  assert.ok(Math.max(...dcOut.map(Math.abs)) < 1e-4, 'a constant offset decays to zero');
  const tone = run((n) => 0.5 + 0.4 * Math.sin((2 * Math.PI * 440 * n) / 48000), 375 * 2);
  const hi = Math.max(...tone);
  const lo = Math.min(...tone);
  assert.ok(Math.abs(hi - 0.4) < 0.01 && Math.abs(lo + 0.4) < 0.01, `440 Hz passes, centred on zero (${lo}..${hi})`);
  const osc = await r.addModule('OSC');
  assert.ok(r.connect(osc.id, dc.id) && r.connect(dc.id, 0));
  const g = graph.nodes.get(dc.inst.node.h);
  render(4);
  assert.equal(g.silent, true, 'nothing playing: skipped');
  osc.inst.noteOn(1, 69, 1);
  render(20);
  assert.equal(g.silent, false, 'plays the OSC through');
  assert.deepEqual(r.toJSON().modules.find((m) => m.id === dc.id).values, {}, 'nothing to save');
  osc.inst.allOff();
  r.destroy();
}

// ---- EQ: 16 bands, Q, level ----
{
  const { BANDS, responseDb, peaking } = await import('../src/modules/eq.dsp.js');
  const r = await PatchRuntime.create(engine, dsp.destination);
  const eq = await r.addModule('EQ');
  assert.equal(BANDS.length, 16);
  assert.deepEqual(eq.def.params.map((p) => p.id), [...BANDS.map((_, i) => `b${i}`), 'q', 'level'], 'controllers 0..15 are the bands');
  assert.equal(eq.def.params[8].label, '800 Hz');
  assert.equal(eq.def.params[9].label, '1.25 kHz');
  assert.equal(eq.def.params[0].format(3), '+3.0 dB');
  const k = kernel(eq.inst.node);
  // gain of a steady sine through the kernel (after the glide and the filter settle)
  const gainAt = (f) => {
    const out = [[new Float32Array(128), new Float32Array(128)]];
    let pk = 0;
    for (let b = 0; b < 200; b++) {
      const L = Float32Array.from({ length: 128 }, (_, i) => 0.25 * Math.sin((2 * Math.PI * f * (b * 128 + i)) / 48000));
      k.process([[L, L]], out);
      if (b >= 150) pk = Math.max(pk, ...out[0][0].map(Math.abs), ...out[0][1].map(Math.abs));
    }
    return 20 * Math.log10(pk / 0.25);
  };
  const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);
  near(gainAt(1000), 0, 0.01, 'flat EQ passes unchanged');
  r.setParam(eq.id, 'b8', 12); // 800 Hz
  near(gainAt(800), 12, 0.1, 'a band boosts its centre by its gain');
  near(gainAt(100), 0, 0.2, 'far away bands are untouched');
  r.setParam(eq.id, 'b8', 0);
  r.setParam(eq.id, 'b4', -12); // 125 Hz
  near(gainAt(125), -12, 0.2, 'cut');
  r.setParam(eq.id, 'level', -6);
  near(gainAt(5000), -6, 0.05, 'level');
  // response used by the panel display agrees with the coefficients
  const gs = new Array(16).fill(0);
  gs[10] = 6;
  near(responseDb(gs, 2.1, 0, 2000), 6, 1e-9, 'response at the band centre');
  near(responseDb(gs, 2.1, -3, 20), -3, 0.01, 'level only far away');
  assert.ok(responseDb(gs, 0.7, 0, 1000) > responseDb(gs, 4, 0, 1000), 'lower Q is wider');
  const c = peaking(1000, 0, 2, 48000);
  near(c[0], 1, 1e-12, '0 dB is the identity'); near(c[1], c[3], 1e-12, '');
  assert.ok(peaking(20000, 6, 2, 44100).every(Number.isFinite), 'top band below Nyquist at 44.1 kHz');
  // cable OSC -> EQ -> Output plays
  const osc = await r.addModule('OSC');
  assert.ok(r.connect(osc.id, eq.id) && r.connect(eq.id, 0));
  osc.inst.noteOn(1, 69, 1);
  render(10);
  assert.equal(graph.nodes.get(eq.inst.node.h).silent, false);
  osc.inst.allOff();
  r.destroy();
}

// ---- LFO modulation (applied by the engine graph on the audio thread) ----
// Modulator kernels are stubbed to output a fixed value: set(lfo, x) renders one block with it.
const hold = (e, x) => { const k = kernel(e.inst.node); k.process = () => false; k.value = x; };
const set = (e, x) => { hold(e, x); render(1); };
{
  const { lfoRateHz, syncedPeriod } = await import('../src/modules/lfo.js');
  const r = await PatchRuntime.create(engine, dsp.destination);
  const osc = await r.addModule('OSC');
  const flt = await r.addModule('FILTER');
  const lfo = await r.addModule('LFO');
  const ko = kernel(osc.inst.node);
  const kf = kernel(flt.inst.node);
  const shown = []; // engine.onModulate (panel display)
  engine.onModulate = (e, id, v) => shown.push([e.id, id, v]);

  assert.ok(r.connect(lfo.id, osc.id), 'LFO may connect to a module without audio input');
  assert.equal(r.connect(osc.id, lfo.id), false, 'LFO has no audio input');
  assert.equal(lfo.inst.params().find((p) => p.id === 'outController').max, 7, 'Out Controller range follows the target (8 OSC controllers)');
  assert.match(lfo.inst.params().find((p) => p.id === 'outController').format(6), /Gain/);

  r.setParam(lfo.id, 'outController', 6); // OSC gain 0..1
  r.setParam(lfo.id, 'outMin', 20);
  r.setParam(lfo.id, 'outMax', 60);
  set(lfo, 0.5);
  assert.equal(ko.p.gain, 0.4, '50% between 20% and 60% of 0..1, applied in the kernel');
  assert.equal(osc.mod.gain, 0.4, 'reported back for display');
  assert.deepEqual(shown.at(-1), [osc.id, 'gain', 0.4]);
  assert.equal(osc.values.gain, 0.5, 'modulation does not change the saved value');
  const n = shown.length;
  set(lfo, 0.5);
  assert.equal(shown.length, n, 'unchanged values are not reported again');

  // a hand change of a modulated controller is overridden again on the next block
  r.setParam(osc.id, 'gain', 0.9);
  assert.equal(ko.p.gain, 0.9);
  render(1);
  assert.equal(ko.p.gain, 0.4, 'modulation re-applied');
  assert.equal(osc.mod.gain, 0.4);

  // amplitude scales the swing around the centre, then Out Min/Max trim it
  r.setParam(lfo.id, 'amp', 50);
  set(lfo, 1);
  assert.ok(Math.abs(ko.p.gain - 0.5) < 1e-9, 'top of a 50% wave = 75% of the 20..60 range');
  set(lfo, 0);
  assert.ok(Math.abs(ko.p.gain - 0.3) < 1e-9, 'bottom of a 50% wave = 25% of the 20..60 range');
  r.setParam(lfo.id, 'amp', 0);
  set(lfo, 1);
  assert.ok(Math.abs(ko.p.gain - 0.4) < 1e-9, '0% amplitude holds the middle');
  r.setParam(lfo.id, 'amp', 100);

  // stepped controller: normalized modulation spans all ten waveform choices
  r.setParam(lfo.id, 'outController', 1); // waveform 0..9
  r.setParam(lfo.id, 'outMin', 0);
  r.setParam(lfo.id, 'outMax', 100);
  set(lfo, 0.7);
  assert.equal(ko.p.gain, 0.9, 'previous controller gets its own value back');
  assert.equal(osc.mod.gain, undefined);
  assert.equal(ko.p.wave, 6, '70% of 0..9 rounds to step 6');
  set(lfo, 1);
  assert.equal(ko.p.wave, 9, 'modulation can select violet noise');

  // log controller (filter cutoff 20..20000): 50% is the geometric middle
  assert.ok(r.connect(lfo.id, flt.id));
  r.setParam(lfo.id, 'outController', 2);
  set(lfo, 0.5);
  const fp = flt.def.params[2];
  assert.ok(Math.abs(kf.p.cutoff - Math.sqrt(fp.min * fp.max)) < 1e-6, `log mapping (${kf.p.cutoff})`);

  // disconnect restores
  r.disconnect(r.cables.find((c) => c.to === flt.id));
  assert.equal(kf.p.cutoff, flt.values.cutoff, 'disconnect gives the cutoff back');
  render(2);
  assert.equal(kf.p.cutoff, flt.values.cutoff, 'and the graph no longer drives it');
  r.removeModule(lfo.id);
  assert.equal(Object.keys(osc.mod).length, 0, 'deleting the LFO releases its targets');
  assert.equal(ko.p.attack, osc.values.attack);

  // BPM sync from this patch's Output
  assert.equal(lfoRateHz(3, 0, 120), 3, 'Hz unit');
  assert.equal(syncedPeriod(0.26), 4);
  assert.equal(lfoRateHz(0.25, 1, 120), 0.5, '4 quarters at 120 BPM = 2 s');
  assert.equal(lfoRateHz(1, 3, 120), 8, '1 sixteenth at 120 BPM');
  const lfo2 = await r.addModule('LFO', { values: { unit: 1, freq: 1 } });
  r.setParam(0, 'bpm', 90);
  assert.equal(kernel(lfo2.inst.node).rate, 1.5, 'Output BPM change re-syncs LFOs');

  // a real LFO sweeps the controller over time
  const lfo3 = await r.addModule('LFO', { values: { freq: 50, outController: 6 } });
  r.connect(lfo3.id, osc.id);
  const seen = new Set();
  for (let i = 0; i < 20; i++) { render(1); seen.add(ko.p.gain); }
  assert.ok(seen.size > 5, 'running LFO modulates every block');
  engine.onModulate = null;
  r.destroy();
}

// ---- MULTIMIDI / MODMIDI ----
{
  const r = await PatchRuntime.create(engine, dsp.destination);
  const capture = (e) => { const log = []; e.inst.node.port.postMessage = (m) => log.push(m); return log; };
  const flush = () => new Promise((res) => setTimeout(res)); // OSC batches noteMod per microtask
  const osc = await r.addModule('OSC');
  const mmA = await r.addModule('MULTIMIDI', { values: { transpose: 12, finetune: 0.5 } });
  const mmB = await r.addModule('MULTIMIDI', { values: { transpose: -12 } });
  const flt = await r.addModule('FILTER');
  const log = capture(osc);
  assert.equal(r.connect(mmA.id, flt.id), false, 'MIDI cable needs a MIDI module');
  assert.equal(r.connect(osc.id, mmA.id), false, 'MULTIMIDI has no audio input');
  assert.ok(r.connect(mmA.id, osc.id)); assert.ok(r.connect(mmB.id, osc.id), 'parallel');
  assert.equal(mmA.inst.node, null, 'no audio output');
  assert.equal(mmA.inst.ctl.out.size, 0, 'no audio connection');

  // float pitch: transpose + finetune are added to the note number
  mmA.inst.noteOn(1001, 60, 0.5); mmB.inst.noteOn(1001, 60, 0.5);
  const ons = log.filter((m) => m.type === 'noteOn');
  assert.equal(ons.length, 2);
  assert.notEqual(ons[0].id, ons[1].id, 'parallel copies are separate notes');
  assert.equal(ons[0].pitch, 72.5); assert.equal(ons[0].velocity, 0.5);
  assert.equal(ons[1].pitch, 48);

  // per-note drift: every note gets its own random offset
  r.setParam(mmA.id, 'drift', 1); r.setParam(mmA.id, 'velDrift', 0.5);
  mmA.inst.noteOn(1002, 64, 1);
  dsp.receive({ time: 0 }); // audio clock ticks (graph reports while a MULTIMIDI exists)
  dsp.receive({ time: 0.25 });
  await flush();
  const mods = log.filter((m) => m.type === 'noteMod').flatMap((m) => m.notes);
  const latest = new Map(mods.map(([id, p, v]) => [id, [p, v]]));
  const [a, b] = [latest.get(ons[0].id), latest.get(log.filter((m) => m.type === 'noteOn').at(-1).id)];
  assert.ok(a && b, 'both notes of mmA are modulated');
  assert.ok(Math.abs(a[0] - 72.5) <= 1 && Math.abs(b[0] - 76.5) <= 1, 'drift within ±1 semitone');
  assert.notEqual((a[0] - 72.5).toFixed(6), (b[0] - 76.5).toFixed(6), 'notes drift independently');
  assert.ok(a[1] >= 0.25 && a[1] <= 0.5 && b[1] >= 0.5 && b[1] <= 1, 'velocity drift lowers up to 50 %');
  assert.equal(log.filter((m) => m.type === 'noteMod').length, 1, 'updates are batched into one message');
  assert.ok(!latest.has(ons[1].id), 'mmB without drift sends no updates');

  // drift moves smoothly: a 5 ms tick at 20 Hz never jumps
  {
    const { Drifter } = await import('../src/modules/multimidi.js');
    const d = new Drifter(true);
    let max = 0;
    for (let i = 0; i < 2000; i++) { const before = d.value; d.step(0.005, 20); max = Math.max(max, Math.abs(d.value - before)); }
    assert.ok(max <= 2 * (Math.PI / 2) * 20 * 0.005 + 1e-9, `max step ${max}`);
    const h = new Drifter(false);
    const held = h.value;
    h.step(1, 0);
    assert.equal(h.value, held, 'rate 0 holds');
  }

  // chain: mmC -> mmA -> osc: the offsets add up, upstream changes pass through as noteMod
  const mmC = await r.addModule('MULTIMIDI', { values: { transpose: 7 } });
  r.setParam(mmA.id, 'drift', 0); r.setParam(mmA.id, 'velDrift', 0);
  assert.ok(r.connect(mmC.id, mmA.id));
  assert.equal(r.connect(mmA.id, mmC.id), false, 'MIDI loop rejected');
  mmC.inst.noteOn(1003, 60, 1);
  const chained = log.filter((m) => m.type === 'noteOn').at(-1);
  assert.equal(chained.pitch, 60 + 7 + 12.5);
  r.setParam(mmC.id, 'transpose', 5);
  dsp.receive({ time: 0.3 });
  await flush();
  assert.deepEqual(log.at(-1).notes.find(([id]) => id === chained.id), [chained.id, 60 + 5 + 12.5, 1]);
  mmC.inst.noteOff(1003);
  assert.deepEqual(log.at(-1), { type: 'noteOff', id: chained.id });

  // disconnecting a MIDI cable releases the notes that went through it
  const before = log.length;
  r.disconnect(r.cables.find((c) => c.from === mmB.id));
  assert.deepEqual(log.slice(before), [{ type: 'noteOff', id: ons[1].id }]);
  r.removeModule(mmA.id);
  assert.ok(log.some((m) => m.type === 'noteOff' && m.id === ons[0].id), 'deleting a MULTIMIDI releases its notes');

  // patch: notes go to inner MIDI modules without an incoming MIDI cable; off/mod follow the noteOn
  const pm = await r.addModule('PATCH');
  const ip = pm.inst.patch;
  const iosc = await ip.addModule('OSC');
  const imm = await ip.addModule('MULTIMIDI', { values: { finetune: 0.25 } });
  const ilog = capture(iosc);
  pm.inst.noteOn(50, 60, 1);
  assert.deepEqual(ilog.at(-1), { type: 'noteOn', id: 50, pitch: 60, velocity: 1 });
  ip.connect(imm.id, iosc.id);
  pm.inst.noteOff(50);
  assert.deepEqual(ilog.at(-1), { type: 'noteOff', id: 50 }, 'off reaches the module that got the note, despite the new cable');
  pm.inst.noteOn(51, 61.5, 0.7);
  const viaMM = ilog.filter((m) => m.type === 'noteOn');
  assert.equal(viaMM.length, 2, 'cabled inner OSC is played once, through its MULTIMIDI');
  assert.equal(viaMM.at(-1).pitch, 61.75);
  pm.inst.noteMod(51, 62, 0.7);
  await flush();
  assert.deepEqual(ilog.at(-1).notes, [[viaMM.at(-1).id, 62.25, 0.7]], 'outer noteMod passes through inner MULTIMIDI');
}

// ---- Patch Instances (round robin) ----
{
  const { instanceSalt } = await import('../src/patch.js');
  const r = await PatchRuntime.create(engine, dsp.destination);
  const pm = await r.addModule('PATCH');
  const ip = pm.inst.patch;
  const osc = await ip.addModule('OSC', { values: { polyphony: 1 } });
  const flt = await ip.addModule('FILTER');
  assert.ok(ip.connect(osc.id, flt.id) && ip.connect(flt.id, 0));
  const fmt = (v) => pm.inst.params().find((p) => p.id === 'instances').format(v);

  // Input Module is the Output (audio): instances stay off
  r.setParam(pm.id, 'instances', 4);
  await pm.inst.sync();
  assert.equal(pm.inst.clones.length, 0, 'no copies while Input Module takes audio');
  assert.match(fmt(4), /off/);

  // Input Module = the OSC (no audio input): 4 instances, round robin
  r.setParam(pm.id, 'inputModule', osc.id);
  await pm.inst.sync();
  assert.equal(pm.inst.clones.length, 3);
  assert.match(fmt(4), /round robin/);
  const all = [ip, ...pm.inst.clones];
  assert.ok(pm.inst.clones.every((c) => c.modules.get(osc.id).values.polyphony === 1 && c.cables.length === 2), 'copies mirror modules, values and cables');
  assert.ok(pm.inst.clones.every((c) => c.modules.get(0).inst.input.out.has(pm.inst.node)), 'every copy plays into the patch output');

  const logs = all.map((rt) => { const l = []; rt.modules.get(osc.id).inst.node.port.postMessage = (m) => l.push(m); return l; });
  const ons = () => logs.map((l) => l.filter((m) => m.type === 'noteOn').map((m) => m.id));
  for (let i = 1; i <= 4; i++) pm.inst.noteOn(i, 60 + i, 1);
  assert.deepEqual(ons(), [[1], [2], [3], [4]], 'one note per instance');
  pm.inst.noteOff(2);
  pm.inst.noteOn(5, 70, 1);
  assert.deepEqual(ons()[1], [2, 5], 'a free instance is preferred');
  pm.inst.noteOn(6, 70, 1);
  assert.deepEqual(ons()[2], [3, 6], 'all busy: plain round robin');
  pm.inst.noteMod(6, 70.5, 1);
  pm.inst.noteOff(6);
  assert.deepEqual(logs[2].at(-1), { type: 'noteOff', id: 6 }, 'off goes to the instance that got the note');
  assert.ok(!logs[0].concat(logs[1], logs[3]).some((m) => m.id === 6));

  // editing instance 1 updates the copies: values in place, structure by rebuilding
  const before = pm.inst.clones[0];
  r.setParam(pm.id, 'instances', 4);
  ip.setParam(flt.id, 'cutoff', 500);
  await pm.inst.sync();
  assert.equal(pm.inst.clones[0], before, 'value change keeps the copies');
  assert.ok(pm.inst.clones.every((c) => c.modules.get(flt.id).values.cutoff === 500));
  await ip.addModule('REVERB', { values: { seed: 7 } });
  await pm.inst.sync();
  assert.ok(before.dead && pm.inst.clones.every((c) => c.modules.size === 4), 'structure change rebuilds the copies');

  // unique random numbers: every instance has its own salt and the REVERB seed differs per instance
  assert.deepEqual([ip, ...pm.inst.clones].map((c) => c.salt), [0, 1, 2, 3]);
  const seeds = [];
  for (const rt of [ip, ...pm.inst.clones]) {
    const rv = [...rt.modules.values()].find((e) => e.def.type === 'REVERB');
    rt.setParam(rv.id, 'seed', 7);
    seeds.push(kernel(rv.inst.node).p.seed); // the kernel mixes the instance salt in
  }
  assert.equal(new Set(seeds).size, 4, `reverb seeds unique per instance (${seeds})`);
  assert.equal(seeds[0], 7, 'instance 1 keeps the plain seed');

  // salts stay unique for nested patches with instances
  const salts = new Set();
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) salts.add(instanceSalt(instanceSalt(0, a), b));
  assert.equal(salts.size, 256);

  // fewer instances / audio input again / deleting the patch drops the copies
  r.setParam(pm.id, 'instances', 2);
  await pm.inst.sync();
  assert.equal(pm.inst.clones.length, 1);
  r.setParam(pm.id, 'inputModule', 0);
  await pm.inst.sync();
  assert.equal(pm.inst.clones.length, 0);
  r.setParam(pm.id, 'inputModule', osc.id);
  await pm.inst.sync();
  const last = pm.inst.clones[0];
  r.removeModule(pm.id);
  assert.ok(last.dead);
  assert.deepEqual(r.toJSON().modules.map((m) => m.type), ['OUT'], 'copies are never saved');
}

// ---- ADSR: notes (direct or through a MULTIMIDI cable) trigger an envelope that modulates a controller ----
{
  const r = await PatchRuntime.create(engine, dsp.destination);
  const mm = await r.addModule('MULTIMIDI');
  const osc = await r.addModule('OSC');
  const env = await r.addModule('ADSR');
  const k = kernel(env.inst.node);
  const sent = []; // gate changes of the envelope kernel
  const gate = k.gate.bind(k);
  k.gate = (on, peak) => { sent.push(on ? { type: 'gate', on, peak } : { type: 'gate', on }); gate(on, peak); };
  assert.ok(r.connect(mm.id, env.id), 'MULTIMIDI -> ADSR (MIDI cable)');
  assert.ok(r.connect(env.id, osc.id), 'ADSR -> OSC (control cable)');
  assert.ok(r.connect(mm.id, osc.id));
  assert.equal(r.connect(osc.id, env.id), false, 'ADSR has no audio input');
  assert.match(env.inst.params().find((p) => p.id === 'outController').format(7), /Duty/);

  r.setParam(env.id, 'outController', 7); // OSC duty 0..100
  r.setParam(env.id, 'outMin', 10);
  r.setParam(env.id, 'outMax', 90);
  mm.inst.noteOn(1, 60, 0.5);
  mm.inst.noteOn(2, 64, 0.5);
  const gates = () => sent.filter((m) => m.type === 'gate');
  assert.equal(gates().length, 2, 'every note retriggers');
  assert.equal(gates()[0].on, true);
  mm.inst.noteOff(1);
  assert.equal(gates().length, 2, 'still held: no release');
  mm.inst.noteOff(2);
  assert.deepEqual(gates().at(-1), { type: 'gate', on: false }, 'last note off releases');

  r.setParam(env.id, 'trigger', 1); // legato
  env.inst.noteOn(10, 60, 1);
  env.inst.noteOn(11, 62, 1);
  assert.equal(gates().length, 4, 'legato: only the first held note triggers');
  r.setParam(env.id, 'velocity', 100);
  env.inst.noteOff(10); env.inst.noteOff(11);
  env.inst.noteOn(12, 60, 0.25);
  assert.equal(gates().at(-1).peak, 0.25, 'velocity scales the peak');

  // the real envelope runs: attack (10 ms) reaches the peak 0.25 -> 10 + 0.25 × 80 = 30 %
  render(10);
  assert.equal(k.stage, 2, 'decaying after the attack');
  assert.ok(osc.mod.duty > 10 && osc.mod.duty <= 30, `envelope drives the duty (${osc.mod.duty})`);
  assert.equal(kernel(osc.inst.node).p.duty, osc.mod.duty, 'applied in the OSC kernel');
  set(env, 0.5);
  assert.equal(osc.mod.duty, 50, 'envelope 0.5 = middle of 10..90 %');
  set(env, 0);
  assert.equal(osc.mod.duty, 10);
  assert.equal(osc.values.duty, 50, 'saved value untouched');
  r.removeModule(env.id);
  assert.ok(!('duty' in osc.mod), 'deleting the ADSR releases the controller');
}

// ---- VELOCITY2CTL: the newest note's velocity drives a controller (through Out Min..Out Max) ----
{
  const r = await PatchRuntime.create(engine, dsp.destination);
  const mm = await r.addModule('MULTIMIDI');
  const osc = await r.addModule('OSC');
  const v2c = await r.addModule('VELOCITY2CTL');
  assert.ok(r.connect(mm.id, v2c.id), 'MULTIMIDI -> VELOCITY2CTL (MIDI cable)');
  assert.ok(r.connect(v2c.id, osc.id), 'VELOCITY2CTL -> OSC (control cable)');
  assert.equal(r.connect(osc.id, v2c.id), false, 'no audio input');
  assert.deepEqual(v2c.def.params.map((p) => p.id), ['outController', 'outMin', 'outMax']);
  assert.match(v2c.inst.params().find((p) => p.id === 'outController').format(7), /Duty/);

  r.setParam(v2c.id, 'outController', 7); // OSC duty 0..100
  render(2);
  assert.ok(!('duty' in osc.mod), 'nothing modulated before the first note');
  mm.inst.noteOn(1, 60, 0.5);
  render(1); // the graph applies the value on the next render quantum
  render(1);
  assert.equal(osc.mod.duty, 50, 'velocity 0.5 = middle of 0..100 %');
  r.setParam(v2c.id, 'outMin', 20);
  r.setParam(v2c.id, 'outMax', 60);
  render(1);
  assert.equal(osc.mod.duty, 40, 'Out Min / Out Max re-apply the held velocity at once');
  mm.inst.noteOn(2, 64, 1);
  render(1);
  assert.equal(osc.mod.duty, 60, 'newest note wins');
  mm.inst.noteMod(1, 60, 0);
  render(1);
  assert.equal(osc.mod.duty, 60, 'older notes do not change it');
  mm.inst.noteMod(2, 64, 0.25);
  render(1);
  assert.equal(osc.mod.duty, 30, 'velocity curve of the newest note is followed');
  mm.inst.noteOff(2);
  mm.inst.noteOff(1);
  render(1);
  assert.equal(osc.mod.duty, 30, 'value is held after note off');
  v2c.inst.noteOn(3, 60, 0);
  render(1);
  assert.equal(osc.mod.duty, 20, 'velocity 0 = Out Min');
  assert.equal(osc.values.duty, 50, 'saved value untouched');
  r.removeModule(v2c.id);
  assert.ok(!('duty' in osc.mod), 'deleting it releases the controller');
}

// ---- WAVESHAPER: curve state is saved, duplicated and mirrored to Patch instances ----
{
  const r = await PatchRuntime.create(engine, dsp.destination);
  const ws = await r.addModule('WAVESHAPER');
  assert.deepEqual(ws.state.points.map((p) => [p.x, p.y]), [[0, 0], [1, 1]], 'default = identity');
  const k = kernel(ws.inst.node);
  const before = k.table;
  assert.ok(Math.abs(before[0] + 1) < 1e-6 && Math.abs(before.at(-1) - 1) < 1e-6 && Math.abs(before[2048]) < 1e-3, 'identity table');
  r.setState(ws.id, { points: [{ x: 0, y: 0 }, { x: 0.3, y: 0.9, r: 0.5 }, { x: 1, y: 1 }] });
  assert.notEqual(k.table, before, 'new curve reaches the shaper');
  assert.ok(k.table[3500] > 0.9, 'boosted');
  r.setParam(ws.id, 'oversample', 2);
  assert.equal(k.os, 4);
  // audio: OSC -> WAVESHAPER -> OUT, a boosting curve raises the level, Dry/Wet 0 % is the input
  {
    const osc = await r.addModule('OSC', { values: { wave: 0 } });
    r.connect(osc.id, ws.id); r.connect(ws.id, 0);
    const go = graph.nodes.get(osc.inst.node.h);
    const gw = graph.nodes.get(ws.inst.node.h);
    osc.inst.noteOn(1, 57, 1);
    let inPk = 0; let outPk = 0;
    for (let i = 0; i < 100; i++) {
      render(1);
      if (i < 50) continue;
      for (let j = 0; j < 128; j++) { inPk = Math.max(inPk, Math.abs(go.outs[0][0][j])); outPk = Math.max(outPk, Math.abs(gw.outs[0][0][j])); }
    }
    assert.ok(outPk > inPk * 1.5, `curve boosts quiet input (${inPk} -> ${outPk})`);
    r.setParam(ws.id, 'mix', 0);
    render(100);
    const diff = go.outs[0][0].reduce((m, v, j) => Math.max(m, Math.abs(v - gw.outs[0][0][j])), 0);
    assert.ok(diff < 1e-6, 'dry only = the input');
    r.setParam(ws.id, 'mix', 100);
    osc.inst.allOff();
    r.removeModule(osc.id);
  }

  const json = JSON.parse(JSON.stringify(r.toJSON()));
  assert.equal(json.modules.find((m) => m.type === 'WAVESHAPER').state.points.length, 3, 'curve saved');
  const r2 = await PatchRuntime.create(engine, dsp.destination);
  await r2.load(json);
  assert.deepEqual(r2.modules.get(ws.id).state, ws.state, 'curve loaded');
  const dup = await r.duplicate(ws.id);
  assert.deepEqual(dup.state, ws.state);
  assert.notEqual(dup.state, ws.state, 'duplicate gets its own copy');
  await r.load({ modules: [{ id: 0, type: 'OUT', values: {} }, { id: 1, type: 'WAVESHAPER', values: {}, state: { points: [{ x: 0.5, y: 2 }] } }], cables: [] });
  assert.equal(r.modules.get(1).state.points.length, 2, 'broken curves are repaired on load');

  // Patch instances mirror the curve
  const pm = await r.addModule('PATCH');
  const ip = pm.inst.patch;
  const o = await ip.addModule('OSC');
  const w = await ip.addModule('WAVESHAPER');
  r.setParam(pm.id, 'inputModule', o.id);
  r.setParam(pm.id, 'instances', 3);
  await pm.inst.sync();
  ip.setState(w.id, { points: [{ x: 0, y: 0 }, { x: 0.5, y: 1 }, { x: 1, y: 1 }] });
  await pm.inst.sync();
  assert.ok(pm.inst.clones.every((c) => c.modules.get(w.id).state.points[1].y === 1), 'copies follow the curve');
}

// automation clips drive a controller by number, and give it back when released
{
  const target = await root.addModule('OSC', { x: 300, y: 300 });
  const { paramsOf, fromNorm } = await import('../src/params.js');
  const ps = paramsOf(target);
  const seen = [];
  root.engine.onModulate = (t, pid, v) => seen.push({ t: t.id, pid, v });
  const p1 = ps[1];
  const own = target.values[p1.id];
  assert.equal(root.automate(77, target.id, 1, 0.5), true);
  assert.equal(target.mod[p1.id], fromNorm(p1, 0.5));
  assert.equal(target.values[p1.id], own, 'saved value untouched');
  assert.deepEqual(seen.at(-1), { t: target.id, pid: p1.id, v: fromNorm(p1, 0.5) });
  // switching controller releases the old one
  const p2 = ps[2];
  root.automate(77, target.id, 2, 1);
  assert.equal(p1.id in target.mod, false);
  assert.equal(target.mod[p2.id], fromNorm(p2, 1));
  // two clips on the same controller: releasing one keeps the other's value
  root.automate(78, target.id, 2, 0);
  root.automate(77, null, 0, null);
  assert.ok(p2.id in target.mod, 'other clip still drives it');
  root.automate(78, null, 0, null);
  assert.equal(p2.id in target.mod, false);
  assert.deepEqual(seen.at(-1), { t: target.id, pid: p2.id, v: null });
  assert.equal(root.automate(79, 9999, 0, 0.3), false, 'missing module');
  assert.equal(root.automate(79, target.id, 999, 0.3), false, 'missing controller');
  root.engine.onModulate = undefined;
}

console.log('all patch tests passed');
