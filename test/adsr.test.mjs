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
