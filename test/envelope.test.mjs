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
assert.equal(run(0.1), null, 'no value before the first note: the controller is left alone');
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
assert.equal(e.value, null, 'reset stops driving');
assert.equal(e.meter, -1, 'reset hides the playhead');

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
console.log('envelope tests passed');
