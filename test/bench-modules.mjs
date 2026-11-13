// Standalone CPU benchmark, not a timing-sensitive unit test. See README.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';

globalThis.sampleRate = 48000;
const { modules, getModule } = await import('../src/modules/index.js');
const { KERNELS } = await import('../src/dsp/kernels.js');
const { instantiateDsp, wasmKernels } = await import('../src/dsp/wasm.js');
const { dspTestHost } = await import('./dsphost.mjs');
const { PatchRuntime } = await import('../src/patch.js');

const flags = process.argv.slice(2);
for (const flag of flags) assert.ok(['--quick', '--json'].includes(flag), `Unknown argument: ${flag}`);
const quick = flags.includes('--quick');
const BLOCK = 128;
const RATE = 48000;
const blocks = quick ? 75 : 1875;
const repeats = quick ? 2 : 5;
const warmup = 750;
const seconds = blocks * BLOCK / RATE;
const wasmBytes = readFileSync(new URL('../src/dsp/modsynth.wasm', import.meta.url));
const wasm = wasmKernels(instantiateDsp(wasmBytes), RATE);
const param = (id, value) => ({ type: 'param', id, value });
const note = (id, pitch) => ({ type: 'noteOn', id, pitch, velocity: 0.7, phase: 0 });
const samples = Float32Array.from({ length: RATE }, (_, i) => 0.4 * Math.sin(i * 2 * Math.PI * 220 / RATE));
let seed = 123;
const image = {
  type: 'image', width: 256, height: 256,
  rgb: Uint8Array.from({ length: 256 * 256 * 3 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 24;
  }),
};
const midiTypes = ['MULTIMIDI', 'STRUM', 'TRILL', 'TUNING', 'CTL2NOTE', 'DELAY'];
const defs = [getModule('OUT'), ...modules];
const cases = [];
const add = (type, workload, values = {}, voices = 0) => {
  const kind = type === 'DC BLOCKER' ? 'dcblock' : type.toLowerCase();
  assert.ok(KERNELS[kind], `${type} needs a benchmark fixture`);
  const def = getModule(type);
  for (const [id, value] of Object.entries(values)) {
    const p = def.params.find(p => p.id === id);
    assert.ok(p && value >= p.min && value <= p.max, `${type}.${id}: invalid benchmark value`);
  }
  cases.push({ type, kind, workload, values, voices });
};

for (const def of defs) {
  if ((midiTypes.includes(def.type) && def.type !== 'DELAY') || def.type === 'PATCH') continue;
  const poly = def.params.some(p => p.id === 'polyphony');
  const values = {};
  // Keep the source active throughout warmup and all measured repetitions.
  if (def.type === 'SAMPLER') values.playMode = 3;
  if (def.type === 'ENVELOPE') values.mode = 1;
  if (def.type === 'FEEDBACK') values.feedback = 0.5;
  add(def.type, poly ? '1 held voice' : 'active defaults', values, def.acceptsMidi ? 1 : 0);
  if (poly) add(def.type, '8 held voices', values, 8);
}
add('OSC', '8 voices, saw', { wave: 1 }, 8);
add('OSC', '32 voices, saw', { wave: 1, polyphony: 32 }, 32);
add('SAMPLER', '32 voices, looping stereo', { playMode: 3, polyphony: 32 }, 32);
add('WAVETABLE', '32 voices, built-in table', { polyphony: 32 }, 32);
for (const interpolation of [0, 1]) {
  const name = ['nearest', 'linear'][interpolation];
  add('SAMPLER', `32 voices, stereo, ${name}`, { playMode: 3, polyphony: 32, interpolation }, 32);
  add('WAVETABLE', `32 voices, ${name}`, { polyphony: 32, interpolation }, 32);
}
add('WAVETABLE', '32 voices, frame crossfade', { polyphony: 32, position: 50.5 }, 32);
for (const scanType of [0, 1, 2]) {
  for (const resolution of [64, 1024]) {
    add('IMAGESAMPLER', `8 voices, scan ${scanType}, ${resolution} points`, { scanType, resolution }, 8);
  }
}
add('IMAGESAMPLER', '32 voices, propellor, 1024 points', { scanType: 1, resolution: 1024, polyphony: 32 }, 32);
for (const type of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  add('FILTER', `type ${type}, max slope`, { type, slope: 3, resonance: 0.7 });
}
add('FILTER', 'ladder + sine LFO', { type: 9, resonance: 0.7, lfoDepth: 1, lfoRate: 2 });
for (const oversample of [0, 1, 2]) {
  add('WAVESHAPER', `${[1, 2, 4][oversample]}x oversampling, drive 6`, { oversample, drive: 6 });
}
for (let type = 0; type < 12; type++) add('DISTORTION', `type ${type}, power 8`, { type, power: 8 });
for (const type of [1, 2]) add('MODULATOR', `phase type ${type}, spline`, { type, interpolation: 2 });
add('EQ', '16 non-flat bands', Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`b${i}`, i % 2 ? -6 : 6])));

function buffers(heap) {
  const ptrs = [];
  const channel = () => {
    if (!heap) return new Float32Array(BLOCK);
    const ptr = heap.alloc(BLOCK * 4);
    ptrs.push(ptr);
    return heap.f32(ptr, BLOCK);
  };
  const input = [channel(), channel()];
  const output = [channel(), channel()];
  for (let i = 0; i < BLOCK; i++) {
    input[0][i] = Math.sin(i * 0.1) * 0.5;
    input[1][i] = Math.cos(i * 0.07) * 0.5;
  }
  return { input, output, destroy: () => ptrs.forEach(p => heap.free(p)) };
}

function dspRunner(c, backend) {
  const native = backend === 'wasm';
  const K = native ? wasm.kernels[c.kind] : KERNELS[c.kind];
  const k = new K({});
  const def = getModule(c.type);
  for (const p of def.params) if (p.dsp !== false) k.message(param(p.id, c.values[p.id] ?? p.default));
  if (c.type === 'SAMPLER') k.message({ type: 'sample', rate: RATE, channels: [samples, samples] });
  if (c.type === 'IMAGESAMPLER') k.message(image);
  for (let i = 0; i < c.voices; i++) k.message(note(i + 1, 48 + i % 12));
  const b = buffers(native ? wasm.heap : null);
  if (c.type === 'INPUT') {
    k.graph = { ext: [b.input] };
    k.message({ type: 'slot', slot: 0 });
  }
  const ins = def.hasInput || c.type === 'MODULATOR' ? [b.input] : [[]];
  if (c.type === 'MODULATOR') ins.push(b.input);
  if (c.type === 'COMPRESSOR') { ins[0] = []; ins.push(b.input); }
  const outs = [b.output];
  let live;
  const run = (n) => { for (let i = 0; i < n; i++) live = k.process(ins, outs); };
  const validate = () => {
    if (K.modulator) assert.ok(Number.isFinite(k.value), `${c.type}: inactive control fixture`);
    else {
      assert.notEqual(live, false, `${c.type}: inactive audio fixture`);
      assert.ok(b.output.every(ch => ch.every(Number.isFinite)), `${c.type}: non-finite output`);
      assert.ok(b.output.some(ch => ch.some(v => Math.abs(v) > 1e-10)), `${c.type}: silent fixture`);
    }
  };
  return { run, validate, destroy() { k.destroy?.(); b.destroy(); } };
}

function midiRunner(type, stress) {
  const def = getModule(type);
  const clocks = new Set();
  const ctx = { currentTime: 0 };
  let ons = 0, offs = 0;
  let lastPitch, lastVelocity;
  const target = {
    noteOn(_id, pitch, velocity) {
      lastPitch = pitch;
      lastVelocity = velocity;
      ons++;
    },
    noteMod() {},
    noteOff() { offs++; },
  };
  const dsp = {
    create: () => ({ param() {}, send() {}, destroy() {} }),
    onClock(fn) { clocks.add(fn); return () => clocks.delete(fn); },
  };
  const inst = def.create(ctx, def, { dsp }, { rand: () => 0.37 });
  for (const p of def.params) inst.setParam(p.id, p.default);
  if (def.defaultState) inst.setState?.(def.defaultState());
  inst.getMidiTargets = () => [target];
  inst.setBpm?.(120);
  if (stress && type === 'MULTIMIDI') {
    inst.setParam('drift', 1);
    inst.setParam('velDrift', 1);
    inst.setParam('randomDelay', 100);
  }
  if (stress && type === 'TRILL') inst.setParam('separation', 100);
  const voices = stress ? 32 : 8;
  const chordBlocks = stress ? 12 : 96; // 31.25 or 3.906 chord retriggers/s
  let block = 0;
  let held = [];
  const run = (n) => {
    for (let i = 0; i < n; i++, block++) {
      ctx.currentTime = block * BLOCK / RATE;
      if (type === 'CTL2NOTE') {
        if (block % chordBlocks === 0) {
          inst.setParam('noteState', 0);
          inst.setParam('pitch', 48 + Math.floor(block / chordBlocks) % 24);
          inst.setParam('noteState', 1);
        } else if (block % 8 === 0) {
          inst.setParam('pitch', 48 + Math.floor(block / 8) % 24);
        }
        if (block % 2 === 0) for (const tick of clocks) tick(ctx.currentTime);
        continue;
      }
      if (block % chordBlocks === 0) {
        for (const id of held) inst.noteOff(id);
        held = Array.from({ length: voices }, (_, i) => block * voices + i + 1);
        held.forEach((id, i) => inst.noteOn(id, 48 + i % 24, 0.7, 0, ctx.currentTime));
      }
      if (block % 8 === 0) held.forEach((id, i) => inst.noteMod(id, 48 + i % 24 + Math.sin(block) * 0.1, 0.7));
      // Approximate the live audio-clock report interval (~5 ms), not wall-clock timers.
      if (block % 2 === 0) for (const tick of clocks) tick(ctx.currentTime);
    }
  };
  return {
    run,
    warmup: 3000, // Fill the MIDI schedulers' six-second release-history window.
    validate: () => assert.ok(ons > 0 && offs > 0 && Number.isFinite(lastPitch) && Number.isFinite(lastVelocity), `${type}: no valid MIDI reached the target`),
    destroy() { inst.destroy(); assert.equal(clocks.size, 0, `${type}: leaked clock`); },
  };
}

async function patchRunner(folder) {
  const h = dspTestHost();
  const engine = { ctx: { get currentTime() { return h.time; } }, dsp: h.dsp };
  const rt = await PatchRuntime.create(engine, h.dsp.destination);
  const src = await rt.addModule('OSC');
  src.inst.noteOn(1, 60, 0.7);
  if (folder) {
    const p = await rt.addModule('PATCH', { values: { inputModule: 0 } });
    assert.ok(rt.connect(src.id, p.id) && rt.connect(p.id, 0));
  } else assert.ok(rt.connect(src.id, 0));
  return {
    run: h.render,
    validate() {
      const { L } = h.render();
      assert.ok(L.every(Number.isFinite) && L.some(v => Math.abs(v) > 1e-10), 'silent Patch fixture');
    },
    destroy: () => { rt.destroy(); h.dsp.destination.destroy(); },
  };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    min: sorted[0], max: sorted.at(-1), samples: values,
  };
}

function measure(runners) {
  for (const [, r] of runners) { r.run(r.warmup ?? warmup); r.validate(); }
  const times = Object.fromEntries(runners.map(([name]) => [name, []]));
  for (let pass = 0; pass < repeats; pass++) {
    // Alternate backend order so the second backend is not always favoured.
    for (const [name, r] of pass % 2 ? [...runners].reverse() : runners) {
      const t = performance.now();
      r.run(blocks);
      times[name].push((performance.now() - t) / seconds);
      r.validate();
    }
  }
  for (const [, r] of runners) r.destroy();
  return Object.fromEntries(Object.entries(times).map(([name, values]) => [name, stats(values)]));
}

const dspResults = cases.map(c => {
  const runners = [['js', dspRunner(c, 'js')]];
  if (wasm.kernels[c.kind]) runners.push(['wasm', dspRunner(c, 'wasm')]);
  return { ...c, msPerAudioSecond: measure(runners) };
});
const midiResults = midiTypes.flatMap(type => [false, true].map(stress => ({
  type,
  workload: type === 'CTL2NOTE'
    ? stress ? '1 controller note, 31.25 retriggers/s, pitch updates' : '1 controller note, 3.906 retriggers/s, pitch updates'
    : stress ? '32 keys, 31.25 chords/s, pitch updates; drift/fast trill' : '8 keys, 3.906 chords/s, pitch updates',
  msPerAudioSecond: measure([['js', midiRunner(type, stress)]]).js,
})));
const patchResults = measure([['withoutFolder', await patchRunner(false)], ['emptyFolder', await patchRunner(true)]]);
const covered = new Set([...cases.map(c => c.type), ...midiTypes, 'PATCH']);
assert.deepEqual([...covered].sort(), defs.map(d => d.type).sort(), 'benchmark must cover every registered module');

const report = {
  measuredAt: new Date().toISOString(),
  environment: { cpu: cpus()[0]?.model, node: process.version, platform: process.platform, arch: process.arch },
  settings: { sampleRate: RATE, blockSize: BLOCK, secondsPerRepeat: seconds, repeats, warmupBlocks: warmup, midiWarmupBlocks: 3000, quick },
  units: 'milliseconds of elapsed execution time per second of simulated audio; divide by 10 for one-core-equivalent percent',
  limitations: [
    'Node microbenchmark, not a browser CPU meter; elapsed timings include scheduling/GC noise.',
    'DSP rows isolate kernel.process; exclude graph routing, modulation targets, UI, IPC, decoding and initialisation.',
    'Wasm rows only where a native kernel exists; other modules use JS even when Wasm is enabled.',
    'MIDI rows include input dispatch and clock callbacks, with a counting sink (no downstream synthesis).',
    'PATCH rows include OSC + Outputs + routing, in JS; an empty folder is not a populated patch.',
    'Active sustained workloads, not exhaustive worst cases or per-block deadline/underrun tests.',
    'Quick mode is a correctness smoke check, not a reliable performance ranking.',
  ],
  dsp: dspResults, midi: midiResults, patch: patchResults,
};

if (flags.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Module CPU benchmark: ${report.environment.cpu}, ${process.version}`);
  console.log(`48 kHz / 128 samples; ${repeats} repeats x ${seconds}s, warmup ${warmup} blocks. ${quick ? 'QUICK SMOKE CHECK ONLY.' : ''}`);
  console.log('Values: ms execution / simulated audio second (divide by 10 for % of one core).');
  console.log('\nDSP, ranked by preferred backend (Wasm where available, JS otherwise):');
  console.log('Module         Workload                                     JS median   Wasm median    preferred min..max');
  const preferred = r => r.msPerAudioSecond.wasm ?? r.msPerAudioSecond.js;
  for (const r of [...dspResults].sort((a, b) => preferred(b).median - preferred(a).median)) {
    const t = preferred(r);
    console.log(`${r.type.padEnd(14)} ${r.workload.padEnd(43)} ${r.msPerAudioSecond.js.median.toFixed(3).padStart(10)}   ${(r.msPerAudioSecond.wasm?.median.toFixed(3) ?? '-').padStart(11)}    ${t.min.toFixed(3)}..${t.max.toFixed(3)}`);
  }
  console.log('\nMIDI main-thread processing (not comparable to DSP alone):');
  for (const r of midiResults.sort((a, b) => b.msPerAudioSecond.median - a.msPerAudioSecond.median)) {
    const t = r.msPerAudioSecond;
    console.log(`${r.type.padEnd(12)} ${t.median.toFixed(3)} ms/s (${t.min.toFixed(3)}..${t.max.toFixed(3)})  ${r.workload}`);
  }
  console.log('\nPATCH container, complete JS graph:');
  for (const [name, t] of Object.entries(patchResults)) console.log(`${name}: ${t.median.toFixed(3)} ms/s (${t.min.toFixed(3)}..${t.max.toFixed(3)})`);
  console.log(`\nCoverage: ${covered.size}/${defs.length} modules. Limitations:`);
  report.limitations.forEach(s => console.log(`- ${s}`));
}
