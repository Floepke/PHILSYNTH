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
console.log('envelope tests passed');
