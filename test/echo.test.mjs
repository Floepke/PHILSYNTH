// Run: node test/echo.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import EchoKernel from '../src/modules/echo.dsp.js';
import { instantiateDsp, wasmKernels } from '../src/dsp/wasm.js';

globalThis.sampleRate = 48000;
const { kernels } = wasmKernels(instantiateDsp(readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url))), sampleRate);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

function run(k, frames, input) {
  const result = [new Float32Array(frames), new Float32Array(frames)];
  for (let at = 0; at < frames; at += 128) {
    const n = Math.min(128, frames - at);
    const ins = input ? [[new Float32Array(n), new Float32Array(n)]] : [[]];
    if (input) for (let ch = 0; ch < 2; ch++) for (let i = 0; i < n; i++) ins[0][ch][i] = input(at + i, ch);
    const outs = [[new Float32Array(n), new Float32Array(n)]];
    if (!k.process(ins, outs)) continue;
    for (let ch = 0; ch < 2; ch++) result[ch].set(outs[0][ch], at);
  }
  return result;
}

for (const K of [EchoKernel, kernels.echo]) {
  {
    const k = new K();
    k.param('delay', 10); k.param('dry', 0.7); k.param('wet', 0.8); k.param('feedback', 0.5);
    const out = run(k, 2000, (i, ch) => i === 0 ? (ch ? 0.25 : 1) : 0);
    for (let ch = 0; ch < 2; ch++) {
      const gain = ch ? 0.25 : 1;
      close(out[ch][0], gain * 0.7, 'independent dry gain');
      for (let repeat = 1; repeat <= 4; repeat++) close(out[ch][repeat * 480], gain * 0.8 * 0.5 ** (repeat - 1), 'feedback decay and wet gain');
      assert.equal(out[ch].filter((v) => v !== 0).length, 5, 'no extra echoes');
    }
    k.destroy?.();
  }
  {
    const k = new K();
    k.param('delay', 10); k.param('dry', 0); k.param('wet', 1); k.param('mode', 1);
    const out = run(k, 2000, (i) => i === 0 ? 1 : 0);
    for (let repeat = 1; repeat <= 4; repeat++) {
      const ch = (repeat - 1) % 2;
      close(out[ch][repeat * 480], 0.5 ** (repeat - 1), 'centered input alternates sides');
      assert.equal(out[1 - ch][repeat * 480], 0, 'other speaker silent');
    }
    k.destroy?.();
  }
  {
    const k = new K();
    k.param('delay', 10); k.param('dry', 0); k.param('wet', 1); k.param('feedback', 0);
    run(k, 128, (i) => i === 0 ? 1 : 0);
    const tail = run(k, 1000);
    close(tail[0][480 - 128], 1, 'echo survives disconnected input and silent gap');
    assert.equal(tail[0].filter((v) => v !== 0).length, 1, 'zero feedback is a single echo');
    k.destroy?.();
  }
  {
    const k = new K();
    k.param('delay', 0); k.param('dry', 0); k.param('wet', 1); k.param('feedback', 0.5);
    const out = run(k, 128, (i) => i === 0 ? 1 : 0);
    assert.equal(out[0][0], 0);
    close(out[0][1], 1, 'zero ms is causal');
    close(out[0][2], 0.5, 'one-sample feedback');
    assert.ok(out.every((ch) => ch.every(Number.isFinite)));
    k.destroy?.();
  }
  // Dry is not filtered, and LP/HP cascades progressively suppress their stopband.
  for (const high of [false, true]) {
    let previous = Infinity;
    for (let slope = 1; slope <= 4; slope++) {
      const k = new K();
      k.param('delay', 1); k.param('dry', 0); k.param('wet', 1); k.param('feedback', 0);
      k.param('filter', slope + (high ? 4 : 0)); k.param('cutoff', 1000);
      const freq = high ? 200 : 5000;
      const out = run(k, 8192, (i) => Math.sin(2 * Math.PI * freq * i / sampleRate));
      const rms = Math.sqrt(out[0].slice(4096).reduce((s, v) => s + v * v, 0) / 4096);
      assert.ok(rms < previous * 0.15, `steeper ${high ? 'HP' : 'LP'} slope attenuates (${rms})`);
      assert.ok(rms < 0.04, 'stopband rejection');
      previous = rms;
      k.param('wet', 0); k.param('dry', 1);
      const dry = run(k, 128, (i, ch) => (ch ? -0.25 : 0.5));
      close(dry[0][0], 0.5, 'dry bypasses filter');
      close(dry[1][0], -0.25, 'stereo dry bypasses filter');
      k.destroy?.();
    }
  }
  // The feedback loop must filter again, not merely replay a once-filtered input.
  {
    const k = new K();
    k.param('delay', 100); k.param('dry', 0); k.param('wet', 1);
    k.param('feedback', 0.5); k.param('filter', 1); k.param('cutoff', 1000);
    const freq = 4000;
    const out = run(k, 15000, (i) => i < 2400 ? Math.sin(2 * Math.PI * freq * i / sampleRate) : 0);
    const energy = (start) => out[0].slice(start, start + 1000).reduce((s, v) => s + v * v, 0);
    const first = energy(5400), second = energy(10200);
    assert.ok(first > 0.1, 'first filtered repeat audible');
    assert.ok(second / first < 0.01, 'second echo is filtered again, beyond 0.25 feedback energy ratio');
    k.destroy?.();
  }
}
console.log('all echo tests passed');
