// Run: node test/dynamics.test.mjs   (COMPRESSOR + INPUT kernels, graph meters and worklet inputs)
import assert from 'node:assert/strict';
import { dspTestHost } from './dsphost.mjs';
import compressor from '../src/modules/compressor.js';
import input from '../src/modules/input.js';
import CompressorKernel, { gainReduction, ratioText, MODES, LOOKAHEAD_MS } from '../src/modules/compressor.dsp.js';
import InputKernel, { METER_FLOOR } from '../src/modules/input.dsp.js';
import { MicHub } from '../src/mics.js';

const SR = sampleRate;
const N = 128;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const stereo = (l = 0, r = l) => [new Float32Array(N).fill(l), new Float32Array(N).fill(r)];
const dB = (x) => 20 * Math.log10(x);

// ---- controllers (numbered by order: append new ones at the end) ----
assert.deepEqual(compressor.params.map((p) => p.id), ['threshold', 'slope', 'attack', 'release', 'mode', 'sidechain', 'knee', 'makeup', 'mix', 'scHpf']);
assert.deepEqual(MODES, ['Peak', 'RMS', 'Peak Zero Latency']);
assert.deepEqual(input.params.map((p) => p.id), ['mic', 'gain', 'channel']);

// ---- static curve ----
assert.equal(gainReduction(-30, -20, 0.75, 0), 0, 'below threshold: no reduction');
close(gainReduction(-8, -20, 0.75, 0), 9, 1e-12, '12 dB over at 4:1 -> 9 dB reduction');
close(gainReduction(-8, -20, 1, 0), 12, 1e-12, 'slope 1 limits');
assert.equal(gainReduction(-8, -20, 0, 0), 0, 'slope 0 does nothing');
assert.equal(gainReduction(-24, -20, 0.5, 6), 0, 'below the knee');
close(gainReduction(-20, -20, 0.5, 6), 0.5 * 3 * 3 / 12, 1e-12, 'soft knee at the threshold');
close(gainReduction(-17, -20, 0.5, 6), 1.5, 1e-12, 'knee joins the line at its upper end');
close(gainReduction(-10, -20, 0.5, 6), 5, 1e-12, 'above the knee: straight line');
assert.equal(ratioText(0.75), '4.0:1');
assert.equal(ratioText(1), '∞:1');

function comp(params) {
  const k = new CompressorKernel();
  for (const p of compressor.params) k.param(p.id, params[p.id] ?? p.default);
  return k;
}
function sine(amp, f = 1000) {
  let n = 0;
  return () => {
    const b = stereo();
    for (let i = 0; i < N; i++, n++) b[0][i] = b[1][i] = amp * Math.sin((2 * Math.PI * f * n) / SR);
    return b;
  };
}
const peakOf = (b) => Math.max(...b[0].map(Math.abs));

// steady state: gain reduction follows the curve (peak detector on a sine = its amplitude)
for (const mode of [0, 2]) {
  const k = comp({ threshold: -20, slope: 0.75, knee: 0, attack: 1, release: 50, mode });
  const src = sine(0.5); // -6 dB peak: 14 dB over -> 10.5 dB reduction
  let out;
  for (let b = 0; b < 200; b++) { out = [stereo()]; k.process([[], src()], out); }
  const tol = mode ? 0.6 : 0.3; // without look-ahead hold the gain ripples between the peaks
  close(k.env, 0.75 * (dB(0.5) + 20), tol, `${MODES[mode]}: steady gain reduction`);
  close(k.meter, k.env, tol, 'meter = gain reduction');
  close(dB(peakOf(out[0])), dB(0.5) - 0.75 * (dB(0.5) + 20), tol, `${MODES[mode]}: output level`);
}
// RMS: a sine's RMS is 3 dB under its peak
{
  const k = comp({ threshold: -20, slope: 0.5, knee: 0, attack: 1, release: 50, mode: 1 });
  const src = sine(0.5);
  for (let b = 0; b < 200; b++) k.process([[], src()], [stereo()]);
  close(k.env, 0.5 * (dB(0.5 / Math.SQRT2) + 20), 0.5, 'RMS detector');
}

// attack / release timing: one time constant reaches 63 %
{
  const attack = 20;
  const k = comp({ threshold: -40, slope: 1, knee: 0, attack, release: 100, mode: 2 });
  const hot = stereo(0.5);
  const n = Math.round((attack / 1000) * SR / N);
  for (let b = 0; b < n; b++) k.process([[], hot], [stereo()]);
  const target = dB(0.5) + 40;
  close(k.env / target, 1 - Math.exp(-(n * N) / (attack / 1000 * SR)), 0.02, 'attack time constant');
  for (let b = 0; b < 400; b++) k.process([[], hot], [stereo()]);
  const start = k.env;
  const m = Math.round((100 / 1000) * SR / N);
  for (let b = 0; b < m; b++) k.process([[], stereo(0.001)], [stereo()]);
  close(k.env / start, Math.exp(-(m * N) / (0.1 * SR)), 0.02, 'release time constant');
}

// Peak mode delays the audio by the look-ahead and is already reducing when the transient arrives;
// Peak Zero Latency has no delay
{
  const la = Math.round((LOOKAHEAD_MS * SR) / 1000);
  for (const mode of [0, 2]) {
    const k = comp({ threshold: -20, slope: 1, knee: 0, attack: 0.5, release: 100, mode });
    const quiet = stereo();
    k.process([[], quiet], [stereo()]);
    const step = stereo(0.8);
    const out = [];
    for (let b = 0; b < 6; b++) { const o = [stereo()]; k.process([[], step], o); out.push(...o[0][0]); }
    const first = out.findIndex((v) => v !== 0);
    assert.equal(first, mode === 0 ? la : 0, `${MODES[mode]}: latency`);
    if (mode === 0) assert.ok(out[first] < 0.8 * 0.6, `look-ahead: gain already reduced at the transient (${out[first]})`);
    else close(out[0], 0.8, 0.1, 'zero latency: the transient passes before the attack');
  }
}

// makeup and mix
{
  const k = comp({ threshold: 0, slope: 0.75, knee: 0, makeup: 6, mode: 2 });
  const o = [stereo()];
  k.process([[], stereo(0.1)], o);
  close(o[0][0][5], 0.1 * 10 ** (6 / 20), 1e-6, 'makeup gain below threshold');
  const p = comp({ threshold: -60, slope: 1, knee: 0, attack: 0.05, mix: 0, mode: 2 });
  for (let b = 0; b < 20; b++) p.process([[], stereo(0.5)], o);
  close(o[0][0][100], 0.5, 1e-6, 'mix 0 = dry');
}

// silence: no input -> not rendered once the look-ahead line is empty and the gain recovered
{
  const k = comp({ release: 5 });
  assert.equal(k.process([[], []], [stereo()]), false, 'nothing connected: silent');
  k.process([[], stereo(0.9)], [stereo()]);
  let live = true;
  let blocks = 0;
  while (live && blocks < 1000) { live = k.process([[], []], [stereo()]); blocks++; }
  assert.ok(!live && blocks < 1000, 'silent after the tail');
}

// ---- side chain through the graph: the key input ducks the other inputs ----
{
  const h = dspTestHost();
  const key = h.dsp.create('osc');
  const bass = h.dsp.create('osc');
  const c = h.dsp.create('compressor');
  for (const [s, gain, pitch] of [[key, 1, 36], [bass, 0.05, 48]]) {
    s.param('attack', 0);
    s.param('wave', 0);
    s.param('gain', gain);
    s.send({ type: 'noteOn', id: 1, pitch, velocity: 1 });
  }
  key.connect(c); // input 1
  bass.connect(c); // input 2
  c.connect(h.dsp.destination);
  for (const p of compressor.params) c.param(p.id, p.default);
  c.param('threshold', -30);
  c.param('slope', 1);
  c.param('mode', 2);
  const level = () => {
    let pk = 0;
    for (let b = 0; b < 40; b++) { const { L } = h.render(); for (const v of L) pk = Math.max(pk, Math.abs(v)); }
    return pk;
  };
  c.param('sidechain', 0);
  const own = level(); // key + bass compressed together
  c.param('sidechain', 1);
  h.render(40);
  const ducked = level();
  const bassPeak = (() => { let pk = 0; for (const v of h.graph.nodes.get(bass.h).outs[0][0]) pk = Math.max(pk, Math.abs(v)); return pk; })();
  assert.ok(ducked < bassPeak * 0.5, `key on input 1 ducks the bass (${ducked} vs ${bassPeak})`);
  assert.ok(own > ducked, 'side chain off plays the key too');
  assert.ok(h.kernel(c).meter > 10, 'gain reduction meter');
  let reported = null;
  c.onMeter = (v) => { reported = v; };
  c.param('threshold', -10);
  h.render(40);
  assert.ok(reported !== null && Math.abs(reported - h.kernel(c).meter) < 0.05, 'meter reported to the main thread');
  c.param('sidechain', 2); // the bass as key: the key osc plays, keyed by the quiet bass
  h.render(600); // after the release
  assert.ok(h.kernel(c).meter < 1, 'quiet key: little reduction');
}

// ---- INPUT kernel reads its worklet input slot ----
{
  const h = dspTestHost();
  const mic = h.dsp.create('input');
  mic.connect(h.dsp.destination);
  for (const p of input.params) if (p.id !== 'mic') mic.param(p.id, p.default);
  const ext = Array.from({ length: 8 }, () => []);
  ext[3] = [new Float32Array(N).fill(0.25), new Float32Array(N).fill(-0.5)];
  h.graph.ext = ext;
  let { L, R } = h.render();
  assert.ok(L.every((v) => v === 0), 'no slot: silent');
  mic.send({ type: 'slot', slot: 3 });
  ({ L, R } = h.render());
  close(L[0], 0.25, 1e-7, 'left from the slot');
  close(R[0], -0.5, 1e-7, 'right from the slot');
  mic.param('gain', 6);
  mic.param('channel', 2); // right on both sides
  ({ L, R } = h.render());
  close(L[0], -0.5 * 10 ** (6 / 20), 1e-6, 'right channel on left, with gain');
  close(R[0], L[0], 0, 'both sides');
  mic.param('channel', 3);
  mic.param('gain', 0);
  ({ L } = h.render());
  close(L[0], -0.125, 1e-7, 'mono sum');
  let level = null;
  mic.onMeter = (v) => { level = v; };
  h.render(2);
  assert.ok(level > -1, 'peak hold of the louder signal before');
  h.render(600); // falls 20 dB/s to the current peak
  close(level, dB(0.125), 0.2, 'level meter');
  ext[3] = [new Float32Array(N).fill(0.3)]; // mono device: both sides
  mic.param('channel', 0);
  ({ L, R } = h.render());
  close(R[0], 0.3, 1e-7, 'mono input on both channels');
  mic.send({ type: 'slot', slot: -1 });
  h.render(1500);
  assert.ok(h.kernel(mic).meter < -60 || h.kernel(mic).meter === METER_FLOOR, 'meter falls');
  h.graph.ext = null; // offline render: no microphones
  ({ L } = h.render());
  assert.ok(L.every((v) => v === 0), 'no worklet inputs: silent');
  assert.ok(new InputKernel().process([], [stereo()]) === false);
}

// ---- MicHub: shared devices, slots, release ----
{
  const streams = [];
  const md = {
    async getUserMedia(c) {
      const id = c.audio.deviceId?.exact ?? '';
      if (id === 'missing') throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
      const s = { id, stopped: false, getTracks: () => [{ stop() { s.stopped = true; } }] };
      streams.push(s);
      return s;
    },
    async enumerateDevices() {
      return [
        { kind: 'audioinput', deviceId: 'default', label: 'Default - Mic A' },
        { kind: 'audioinput', deviceId: 'a', label: 'Mic A' },
        { kind: 'audioinput', deviceId: 'b', label: 'Mic B' },
        { kind: 'audiooutput', deviceId: 'x', label: 'Speakers' },
      ];
    },
    addEventListener() {},
  };
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: md }, configurable: true });
  const connected = [];
  const ctx = { createMediaStreamSource: (s) => ({ connect: (_n, _o, slot) => connected.push([s.id, slot]), disconnect() { connected.splice(connected.findIndex((c) => c[0] === s.id), 1); } }) };
  const hub = new MicHub(ctx, {}, 2);
  const s1 = await hub.acquire('a');
  const s2 = await hub.acquire('a');
  assert.equal(s1, 0);
  assert.equal(s2, 0, 'same device shares its slot');
  assert.equal(streams.length, 1);
  assert.equal(hub.status, 'ok');
  assert.deepEqual(hub.devices.map((d) => d.label), ['Mic A', 'Mic B'], 'device list without aliases and outputs');
  assert.equal(await hub.acquire('b'), 1);
  assert.equal(await hub.acquire(''), -1, 'all slots in use');
  hub.release('a');
  assert.ok(!streams[0].stopped, 'still used once');
  hub.release('a');
  assert.ok(streams[0].stopped, 'closed when unused');
  assert.equal(await hub.acquire(''), 0, 'freed slot reused');
  assert.equal(await hub.acquire('missing'), -1, 'missing device');
  assert.deepEqual(connected.map((c) => c[1]).sort(), [0, 1]);

  // a watcher that watches again while notified (an INPUT panel rebuilding) must not loop, and
  // refreshing an unchanged device list notifies nobody
  let calls = 0;
  const again = () => { calls++; if (calls > 50) throw new Error('watch loop'); hub.watch(again); };
  hub.watch(again);
  hub.emit();
  assert.equal(calls, 1, 'watchers added while notifying wait for the next change');
  calls = 0;
  await hub.refresh();
  assert.equal(calls, 0, 'nothing changed: no notification');
  delete globalThis.navigator;
}

// ---- INPUT module without microphones (offline render, or no MediaDevices) ----
{
  const h = dspTestHost();
  const inst = input.create(null, input, { dsp: h.dsp, mics: null });
  inst.attach({ values: { mic: 0 } });
  inst.setParam('mic', 0);
  assert.equal(inst.statusText(), 'Microphones not supported here');
  assert.equal(inst.params()[0].format(0), 'Microphones not supported here');
  const hub = { status: 'none', devices: [], open: new Map(), slots: [], watch: () => () => {} };
  const none = input.create(null, input, { dsp: h.dsp, mics: hub });
  none.attach({ values: { mic: 0 } });
  assert.equal(none.params()[0].format(0), 'No microphone found', 'the controller tells when there is no microphone');
  inst.destroy();
  none.destroy();
}

console.log('dynamics tests passed');
