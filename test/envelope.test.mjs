// Run: node test/envelope.test.mjs   (runs the real ENVELOPE DSP kernel)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';

const SR = 48000;
const Proc = await loadKernel('envelope.dsp.js', SR);

const e = new Proc();
const msg = (data) => e.port.onmessage({ data });
const run = (seconds) => { for (let b = 0; b < Math.round((seconds * SR) / 128); b++) e.process([], [[new Float32Array(128)]]); return e.value; };
const close = (v, t, tol, m) => assert.ok(Math.abs(v - t) <= tol, `${m}: ${v} (want ${t})`);

// ramp up then down: 0 -> 1 at half, back to 0.4 at the end
msg({ type: 'curve', curve: { points: [{ x: 0, y: 0, r: 0 }, { x: 0.5, y: 1, r: 0 }, { x: 1, y: 0.4, r: 0 }] } });
msg({ type: 'param', id: 'length', value: 1000 }); // ms
close(run(0.1), 0.4, 1e-6, 'before the first note: drives the curve end (as after a note) without advancing');
assert.equal(e.meter, -1, 'idle: no playhead');
assert.equal(Proc.Kernel.meter, true, 'the playhead is reported like a meter');
msg({ type: 'noteOn', id: 1 });
close(run(0.25), 0.5, 0.01, 'a quarter in: half way up');
close(e.meter, 0.25, 0.01, 'playhead a quarter through');
close(run(0.25), 1, 0.01, 'half way: the peak');
close(run(0.25), 0.7, 0.01, 'three quarters: half way down');
close(run(0.3), 0.4, 1e-6, 'holds the end value');
assert.equal(e.meter, -1, 'finished: the playhead is hidden');
close(run(1), 0.4, 1e-6, 'still holds');

// retrigger restarts from the beginning, length follows the controller
msg({ type: 'param', id: 'length', value: 200 });
msg({ type: 'noteOn', id: 2 });
close(run(128 / SR), 0, 1e-3, 'restarts at the start');
close(run(0.1), 1, 0.02, 'shorter length: the peak after 100 ms');
close(run(0.2), 0.4, 1e-6, 'done after 200 ms');

// length 0: straight to the end value
msg({ type: 'curve', curve: { points: [{ x: 0, y: 1, r: 0 }, { x: 1, y: 0.25, r: 0 }] } });
msg({ type: 'param', id: 'length', value: 0 });
msg({ type: 'noteOn', id: 3 });
close(run(128 / SR), 0.25, 1e-6, 'length 0 jumps to the end');

msg({ type: 'noteOn', id: 4 });
msg({ type: 'param', id: 'length', value: 1000 });
run(0.1);
assert.ok(e.meter > 0, 'playing');
msg({ type: 'reset' });
assert.equal(e.value, 0.25, 'reset drives the current curve end (trigger mode idle)');
assert.equal(e.meter, -1, 'reset hides the playhead');

// Loading/editing a curve before triggering updates its idle value (trigger mode: the curve's end,
// as after a finished note; loop modes: its start); reset restores that behavior.
for (const mode of [0, 1, 2]) {
  const l = new Proc();
  const m = (data) => l.port.onmessage({ data });
  const go = () => { l.process([], [[new Float32Array(128)]]); return l.value; };
  assert.equal(go(), 0, 'default envelope immediately drives Out Min');
  m({ type: 'param', id: 'mode', value: mode });
  m({ type: 'curve', curve: { points: [{ x: 0, y: 0.25, r: 0 }, { x: 1, y: 0.75, r: 0 }] } });
  const idle = mode === 0 ? 0.75 : 0.25;
  assert.equal(go(), idle, `mode ${mode}: loaded curve drives its idle value`);
  assert.equal(l.pos, 0, 'idle does not advance');
  assert.equal(l.meter, -1, 'idle does not display a playhead');
  m({ type: 'noteOn', id: 1, phase: 0.5 });
  close(go(), 0.5, 1e-6, 'first trigger still starts at the requested phase');
  m({ type: 'reset' });
  assert.equal(go(), idle, 'reset resumes driving the idle value');
  m({ type: 'curve', curve: { points: [{ x: 0, y: 0.6, r: 0 }, { x: 1, y: 0.9, r: 0 }] } });
  close(go(), mode === 0 ? 0.9 : 0.6, 1e-6, 'curve edits after reset update idle output');
}
{
  const l = new Proc();
  const m = (data) => l.port.onmessage({ data });
  m({ type: 'curve', curve: { points: [{ x: 0, y: 0.25, r: 0 }, { x: 1, y: 0.75, r: 0 }] } });
  m({ type: 'param', id: 'mode', value: 1 });
  assert.equal(l.value, 0.25, 'switching to a loop mode before any note: idle at the start');
  m({ type: 'param', id: 'mode', value: 0 });
  assert.equal(l.value, 0.75, 'back to trigger mode: idle at the end');
}

// Editing a completed/stopped curve does not replace its held output with the idle start.
for (const mode of [0, 1, 2]) {
  const l = new Proc();
  const m = (data) => l.port.onmessage({ data });
  const go = () => { l.process([], [[new Float32Array(128)]]); return l.value; };
  m({ type: 'param', id: 'mode', value: mode });
  m({ type: 'param', id: 'length', value: 0 });
  m({ type: 'curve', curve: { points: [{ x: 0, y: 0.25, r: 0 }, { x: 1, y: 0.75, r: 0 }] } });
  m({ type: 'noteOn', id: 1 });
  assert.equal(go(), 0.75);
  m({ type: 'noteOff', id: 1 });
  m({ type: 'curve', curve: { points: [{ x: 0, y: 0, r: 0 }, { x: 1, y: 1, r: 0 }] } });
  assert.equal(go(), 0.75, `mode ${mode}: post-trigger idle still holds its last output`);
  assert.equal(l.meter, -1);
}

// ---- Mode 1: Notes ON/OFF Loop ----
{
  const l = new Proc();
  const m = (data) => l.port.onmessage({ data });
  const go = (s) => { for (let b = 0; b < Math.round((s * SR) / 128); b++) l.process([], [[new Float32Array(128)]]); return l.value; };
  m({ type: 'curve', curve: { points: [{ x: 0, y: 0, r: 0 }, { x: 1, y: 1, r: 0 }] } }); // straight ramp: value = position
  m({ type: 'param', id: 'length', value: 1000 });
  m({ type: 'param', id: 'mode', value: 1 });
  m({ type: 'noteOn', id: 1 });
  close(go(0.4), 0.4, 0.01, 'loop: plays forward');
  m({ type: 'noteOn', id: 2 });
  close(go(0.2), 0.6, 0.01, 'a second note while one is held does not restart');
  close(go(0.6), 0.2, 0.01, 'past the end it starts over');
  m({ type: 'noteOff', id: 1 });
  close(go(0.3), 0.5, 0.01, 'still looping while a note is held');
  assert.ok(l.meter >= 0, 'playhead shown while looping');
  m({ type: 'noteOff', id: 2 });
  const held = go(128 / SR);
  close(go(0.5), held, 1e-9, 'all released: stops and holds');
  assert.equal(l.meter, -1, 'stopped: the playhead is hidden');
  m({ type: 'noteOn', id: 3 });
  close(go(0.1), 0.1, 0.01, 'the next note starts over from the beginning');
  m({ type: 'allOff' });
  const h2 = go(128 / SR);
  close(go(0.3), h2, 1e-9, 'allOff (stop/panic) stops the loop too');
}

// ---- Mode 2: Notes ON/OFF Loop Forward/Backwards ----
{
  const l = new Proc();
  const m = (data) => l.port.onmessage({ data });
  const go = (s) => { for (let b = 0; b < Math.round((s * SR) / 128); b++) l.process([], [[new Float32Array(128)]]); return l.value; };
  m({ type: 'curve', curve: { points: [{ x: 0, y: 0, r: 0 }, { x: 1, y: 1, r: 0 }] } });
  m({ type: 'param', id: 'length', value: 1000 });
  m({ type: 'param', id: 'mode', value: 2 });
  m({ type: 'noteOn', id: 1 });
  close(go(0.8), 0.8, 0.01, 'ping-pong: forward first');
  close(go(0.4), 0.8, 0.01, 'bounced at the end: now going back');
  close(go(0.7), 0.1, 0.01, 'back towards the start');
  close(go(0.3), 0.2, 0.01, 'bounced at the start: forward again');
  m({ type: 'noteOff', id: 1 });
  const held = go(128 / SR);
  close(go(0.5), held, 1e-9, 'released: holds');
  m({ type: 'noteOn', id: 2 });
  close(go(0.3), 0.3, 0.01, 'restarts forward from the beginning');
}

// ---- Mode 0 ignores note-offs (as before) ----
{
  const l = new Proc();
  const m = (data) => l.port.onmessage({ data });
  const go = (s) => { for (let b = 0; b < Math.round((s * SR) / 128); b++) l.process([], [[new Float32Array(128)]]); return l.value; };
  m({ type: 'curve', curve: { points: [{ x: 0, y: 0, r: 0 }, { x: 1, y: 1, r: 0 }] } });
  m({ type: 'param', id: 'length', value: 1000 });
  m({ type: 'noteOn', id: 1 });
  go(0.3);
  m({ type: 'noteOff', id: 1 });
  close(go(0.3), 0.6, 0.01, 'trigger mode plays on after note-off');
  m({ type: 'noteOn', id: 1 });
  m({ type: 'noteOn', id: 2 });
  close(go(0.2), 0.2, 0.01, 'every note restarts in trigger mode');
}

// ---- start phase: a note starts the curve at its MODMIDI phase ----
for (const mode of [0, 1, 2]) {
  const l = new Proc();
  const m = (data) => l.port.onmessage({ data });
  const go = (s) => { for (let b = 0; b < Math.round((s * SR) / 128); b++) l.process([], [[new Float32Array(128)]]); return l.value; };
  m({ type: 'curve', curve: { points: [{ x: 0, y: 0, r: 0 }, { x: 1, y: 1, r: 0 }] } });
  m({ type: 'param', id: 'length', value: 1000 });
  m({ type: 'param', id: 'mode', value: mode });
  m({ type: 'noteOn', id: 1, phase: 0.6 });
  close(go(128 / SR), 0.6, 1e-6, `mode ${mode}: starts at phase 0.6`);
  close(go(0.2), 0.8, 0.01, `mode ${mode}: plays on forward from there`);
  if (mode) {
    m({ type: 'noteOn', id: 2, phase: 0.1 });
    close(go(0.1), 0.9, 0.01, `mode ${mode}: a second held note does not move the loop`);
  }
}
{
  const l = new Proc();
  const m = (data) => l.port.onmessage({ data });
  const go = () => { l.process([], [[new Float32Array(128)]]); return l.value; };
  m({ type: 'curve', curve: { points: [{ x: 0, y: 0, r: 0 }, { x: 1, y: 1, r: 0 }] } });
  m({ type: 'noteOn', id: 1, phase: 1.25 });
  close(go(), 0.25, 1e-6, 'phase wraps into 0..1');
  m({ type: 'noteOn', id: 2, phase: NaN });
  close(go(), 0, 1e-6, 'invalid phase starts at the beginning');
  m({ type: 'noteOn', id: 3 });
  close(go(), 0, 1e-6, 'no phase starts at the beginning');
}

// ---- main-thread playhead extrapolation follows the mode ----
{
  const { playheadAt, MODES } = await import('../src/modules/envelope.js');
  assert.equal(MODES.length, 3);
  close(playheadAt({ pos: 0.9 }, 0.3, 0), 1, 1e-9, 'trigger: stops at the end');
  close(playheadAt({ pos: 0.9 }, 0.3, 1), 0.2, 1e-9, 'loop: wraps');
  close(playheadAt({ pos: 0.9, dir: 1 }, 0.3, 2), 0.8, 1e-9, 'ping-pong: bounces at the end');
  close(playheadAt({ pos: 0.1, dir: -1 }, 0.3, 2), 0.2, 1e-9, 'ping-pong: bounces at the start');
}
// ---- ENVELOPE.phmod (curve 0.245 -> ... -> 0.5, 2302 ms) on an OSC's Duty Cycle: the first note
// after loading must drive the OSC exactly like every later note (same idle duty before it) ----
{
  const { dspTestHost } = await import('./dsphost.mjs');
  const { PatchRuntime } = await import('../src/patch.js');
  const { dsp, graph, render } = dspTestHost();
  const engine = { ctx: { currentTime: 0 }, dsp, createPatch(sink) { return PatchRuntime.create(this, sink); } };
  const rt = await PatchRuntime.create(engine, dsp.destination);
  await rt.load({
    modules: [
      { id: 0, type: 'OUT', x: 0, y: 0, values: {}, color: null },
      {
        id: 1, type: 'ENVELOPE', x: 0, y: 0, color: null,
        values: { mode: 0, length: 2302, outController: 2, outMin: 0, outMax: 100, outSmooth: 0 },
        state: { points: [
          { x: 0, y: 0.24484321071010262, r: 0 },
          { x: 0.18801812418725616, y: 0.6087502031859557, r: 1 },
          { x: 0.49411776657997397, y: 0.5770023975942783, r: 1 },
          { x: 1, y: 0.5000558761378413, r: 0 },
        ] },
      },
      { id: 2, type: 'OSC', x: 0, y: 0, values: { wave: 0, duty: 50, polyphony: 1 }, color: null },
    ],
    cables: [{ from: 1, to: 2 }, { from: 2, to: 0 }],
  });
  const env = rt.modules.get(1).inst;
  const osc = graph.nodes.get(rt.modules.get(2).inst.node.h).k;
  // per block after the note: [envelope value, OSC duty controller, OSC smoothed duty, output]
  const playNote = (id) => {
    env.noteOn(id, 60, 1);
    const trace = [];
    for (let b = 0; b < 40; b++) {
      const { L } = render(1);
      trace.push([graph.nodes.get(env.node.h).k.value, osc.p.duty, osc.duty, Array.from(L)]);
    }
    render(Math.ceil((2.5 * SR) / 128)); // the curve finishes and holds its end
    env.noteOff(id);
    return trace;
  };
  render(50);
  close(osc.p.duty, 50, 0.01, 'loaded: the Duty Cycle sits where a finished note leaves it');
  close(osc.duty, 0.5, 1e-4, 'loaded: the OSC smoothed duty has settled there too');
  const first = playNote(1);
  close(first[0][1], 24.5, 1e-9, 'the note starts the curve at its start (Duty Cycle step 0.1)');
  close(osc.p.duty, 50, 0.01, 'after a note: holds the curve end');
  const second = playNote(2);
  for (let b = 0; b < first.length; b++) {
    const [ev1, d1, s1, out1] = first[b];
    const [ev2, d2, s2, out2] = second[b];
    close(ev2, ev1, 1e-9, `block ${b}: same envelope value`);
    close(d2, d1, 1e-9, `block ${b}: same Duty Cycle`);
    close(s2, s1, 1e-9, `block ${b}: same smoothed duty glide`);
    for (let i = 0; i < out1.length; i++) close(out2[i], out1[i], 1e-6, `block ${b} sample ${i}: same sound`);
  }
  rt.destroy();
  console.log('envelope: first note after load == later notes ok');
}
console.log('envelope tests passed');
