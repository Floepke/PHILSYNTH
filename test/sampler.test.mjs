// Run: node test/sampler.test.mjs   (SAMPLER + WAVETABLE kernels, sample files and the sample pool)
import assert from 'node:assert/strict';
import { loadKernel } from './kernelproc.mjs';
import sampler from '../src/modules/sampler.js';
import wavetable from '../src/modules/wavetable.js';
import { readClamped, readWrapped } from '../src/modules/interp.js';
import { fft } from '../src/modules/fft.js';
import {
  addSample, getSample, exportSamples, importSamples, withSamples, parseWav, parseSurgeWt, guessFrame, tableFromFile, sampleFromFile,
} from '../src/samples.js';

const SR = 48000;
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const block = () => [new Float32Array(128), new Float32Array(128)];
function run(k, blocks) {
  const L = [];
  const R = [];
  let live = false;
  for (let b = 0; b < blocks; b++) {
    const out = block();
    live = k.process([], [out]);
    if (live) { L.push(...out[0]); R.push(...out[1]); } else { L.push(...new Float32Array(128)); R.push(...new Float32Array(128)); }
  }
  return { L, R, live };
}

// ---- controllers (numbered by order: append new ones at the end) ----
assert.deepEqual(sampler.params.map((p) => p.id), ['polyphony', 'attack', 'decay', 'sustain', 'release', 'gain', 'transpose', 'finetune', 'interpolation']);
assert.deepEqual(wavetable.params.map((p) => p.id), ['polyphony', 'attack', 'decay', 'sustain', 'release', 'gain', 'position', 'block', 'interpolation']);
for (const def of [sampler, wavetable]) {
  const interp = def.params.find((p) => p.id === 'interpolation');
  assert.deepEqual(interp.options, ['Off', 'Linear', 'Spline']);
  assert.equal(interp.default, 2, 'Spline by default');
  assert.ok(def.acceptsMidi && def.hasOutput && !def.hasInput);
}
assert.deepEqual(wavetable.params.find((p) => p.id === 'block').options, ['Auto', '256', '512', '1024', '2048', '4096']);

// ---- interpolation ----
const ramp = Float32Array.from({ length: 8 }, (_, i) => i);
assert.equal(readClamped(ramp, 8, 2.4, 0), 2);
close(readClamped(ramp, 8, 2.25, 1), 2.25, 1e-6, 'linear');
close(readClamped(ramp, 8, 2.25, 2), 2.25, 1e-6, 'spline is exact on a line');
assert.equal(readClamped(ramp, 8, 9, 2), 0, 'past the end = silence');
close(readWrapped(ramp, 8, 7.5, 1), 3.5, 1e-6, 'wraps to the start');
const sine = Float32Array.from({ length: 64 }, (_, i) => Math.sin((2 * Math.PI * i) / 64));
const exact = Math.sin((2 * Math.PI * 10.37) / 64);
assert.ok(Math.abs(readWrapped(sine, 64, 10.37, 2) - exact) < Math.abs(readWrapped(sine, 64, 10.37, 1) - exact), 'spline beats linear');

// ---- FFT ----
{
  const re = Float64Array.from({ length: 16 }, (_, i) => Math.cos((2 * Math.PI * 3 * i) / 16));
  const im = new Float64Array(16);
  fft(re, im);
  close(re[3], 8, 1e-9, 'bin 3');
  close(re[13], 8, 1e-9, 'mirror bin');
  fft(re, im, true);
  close(re[1] / 16, Math.cos((2 * Math.PI * 3) / 16), 1e-9, 'inverse');
}

// ---- SAMPLER kernel ----
{
  const Proc = await loadKernel('sampler.dsp.js', SR);
  const k = new Proc();
  k.message({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  assert.equal(run(k, 2).live, false, 'no sample: silent');

  const len = 4800; // 0.1 s, a different rate than the engine
  const L = Float32Array.from({ length: len }, (_, i) => 0.5 * Math.sin(i / 7));
  const R = Float32Array.from({ length: len }, (_, i) => -0.25 * Math.sin(i / 7));
  k.message({ type: 'sample', rate: SR, channels: [L, R] });
  k.message({ type: 'param', id: 'attack', value: 0.001 });
  k.message({ type: 'param', id: 'gain', value: 1 });
  k.message({ type: 'noteOn', id: 1, pitch: 60, velocity: 1 });
  const a = run(k, 50);
  close(a.L[1000], L[1000], 1e-4, 'C4 plays the sample at its own speed (left)');
  close(a.R[1000], R[1000], 1e-4, 'stereo (right)');
  const lastL = a.L.findLastIndex((x) => x !== 0);
  assert.ok(lastL >= len - 2 && lastL < len + 1, `one-shot: ends with the sample (${lastL})`);
  assert.equal(a.live, false, 'voice ends with the sample');

  k.message({ type: 'noteOn', id: 2, pitch: 72, velocity: 1 });
  const oct = run(k, 50);
  close(oct.L[500], L[1000], 1e-3, 'an octave up plays twice as fast');
  const lastOct = oct.L.findLastIndex((x) => x !== 0);
  assert.ok(Math.abs(lastOct - len / 2) <= 2, `half as long (${lastOct})`);

  k.message({ type: 'param', id: 'transpose', value: -12 });
  k.message({ type: 'noteOn', id: 3, pitch: 72, velocity: 1 });
  close(run(k, 20).L[1000], L[1000], 1e-4, 'transpose -12 brings C5 back to the original speed');
  k.message({ type: 'param', id: 'transpose', value: 0 });

  k.message({ type: 'sample', rate: SR / 2, channels: [L] });
  k.message({ type: 'noteOn', id: 4, pitch: 60, velocity: 1 });
  const half = run(k, 80);
  close(half.L[2000], L[1000], 1e-3, 'a 24 kHz sample plays at its own speed');
  close(half.R[2000], half.L[2000], 1e-9, 'mono sample on both sides');

  k.message({ type: 'param', id: 'release', value: 0.01 });
  k.message({ type: 'noteOn', id: 5, pitch: 60, velocity: 1 });
  run(k, 2);
  k.message({ type: 'noteOff', id: 5 });
  const rel = run(k, 10);
  assert.equal(rel.live, false, 'release ends the voice');
}

// ---- WAVETABLE kernel ----
{
  const Proc = await loadKernel('wavetable.dsp.js', SR);
  const { mipmaps, builtinTable } = await import('../src/modules/wavetable.dsp.js');
  const k = new Proc();
  assert.equal(k.size, 2048, 'built-in table: 2048-sample frames');
  assert.equal(k.frames, builtinTable().data.length / 2048);
  k.message({ type: 'param', id: 'gain', value: 1 });
  k.message({ type: 'noteOn', id: 1, pitch: 69, velocity: 1 }); // first frame = sine, A4
  const { L } = run(k, 400);
  let ups = 0;
  for (let i = 4801; i < L.length; i++) if (L[i - 1] < 0 && L[i] >= 0) ups++;
  close(ups / ((L.length - 4801) / SR), 440, 2, 'plays the note pitch');
  close(Math.max(...L.slice(4800)), 0.45, 0.01, 'sine frame at gain 1 (0.9 * 0.5)');

  // mipmaps keep only harmonics a note can play below Nyquist
  const saw = Float32Array.from({ length: 2048 }, (_, i) => 2 * (i / 2048) - 1);
  const lv = mipmaps(saw, 2048);
  assert.equal(lv.length, 11);
  const spectrum = (d) => { const re = Float64Array.from(d); const im = new Float64Array(d.length); fft(re, im); return (h) => Math.hypot(re[h], im[h]) / d.length; };
  const s3 = spectrum(lv[3].data); // keeps up to harmonic 1024 >> 3 = 128
  assert.ok(s3(128) > 1e-3 && lv[3].size >= 2 * 128, 'level 3 keeps harmonic 128');
  assert.ok(s3(129) < 1e-9 && s3(150) < 1e-9, 'and nothing above it');
  assert.ok(spectrum(lv[0].data)(0) < 1e-9, 'DC removed');
  const odd = mipmaps(Float32Array.from({ length: 600 }, (_, i) => Math.sin((2 * Math.PI * i) / 600)), 600);
  assert.equal(odd[0].size, 1024, 'a 600-sample frame is resampled to 1024');
  close(odd[0].data[256], 1, 1e-3, 'and still one sine cycle');

  // high notes stay clean: an A7 square has no aliased energy between its harmonics
  k.message({ type: 'allOff' });
  k.message({ type: 'param', id: 'position', value: 100 }); // last frame = square
  run(k, 200); // position glides there
  k.message({ type: 'noteOn', id: 2, pitch: 105, velocity: 1 });
  const hi = run(k, 64).L.slice(4096, 4096 + 4096);
  const sp = spectrum(Float64Array.from(hi, (x, i) => x * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 4096))));
  const f0 = 440 * 2 ** 3; // 3520 Hz: harmonics 1 and 3 below Nyquist (3 * 3520 = 10560; 5 * 3520 = 17600, 7 * = 24640 > 24000)
  const bin = (hz) => Math.round((hz * 4096) / SR);
  const at = (hz) => Math.max(sp(bin(hz) - 1), sp(bin(hz)), sp(bin(hz) + 1));
  assert.ok(at(f0) > 0.05, 'fundamental');
  assert.ok(at(SR - 7 * f0) < at(f0) * 1e-3, `no alias of harmonic 7 (${at(SR - 7 * f0)})`);

  // Block Size re-slices the table; position morphs between neighbouring frames
  const data = new Float32Array(4096);
  for (let f = 0; f < 16; f++) data.fill(f, f * 256, (f + 1) * 256);
  k.message({ type: 'table', data, frame: 256 });
  assert.equal(k.size, 256);
  assert.equal(k.frames, 16);
  k.message({ type: 'param', id: 'block', value: 3 }); // 1024
  assert.equal(k.size, 1024);
  assert.equal(k.frames, 4);
  k.message({ type: 'param', id: 'block', value: 0 });
  assert.equal(k.size, 256, 'Auto = the frame size of the file');
  k.message({ type: 'table', data: null, frame: 0 });
  assert.equal(k.size, 2048, 'no table: built-in');
}

// ---- WAV / .wt parsing ----
function wav({ channels, rate = 44100, bits = 16, float = false, extra = [] }) {
  const n = channels[0].length;
  const bytes = bits / 8;
  const dataSize = n * channels.length * bytes;
  const chunks = [];
  const fmt = new DataView(new ArrayBuffer(16));
  fmt.setUint16(0, float ? 3 : 1, true);
  fmt.setUint16(2, channels.length, true);
  fmt.setUint32(4, rate, true);
  fmt.setUint32(8, rate * channels.length * bytes, true);
  fmt.setUint16(12, channels.length * bytes, true);
  fmt.setUint16(14, bits, true);
  chunks.push(['fmt ', new Uint8Array(fmt.buffer)]);
  for (const [id, text] of extra) chunks.push([id, new TextEncoder().encode(text)]);
  const d = new DataView(new ArrayBuffer(dataSize));
  for (let i = 0; i < n; i++) {
    channels.forEach((c, ch) => {
      const o = (i * channels.length + ch) * bytes;
      if (float) d.setFloat32(o, c[i], true);
      else if (bits === 16) d.setInt16(o, Math.round(c[i] * 32767), true);
      else if (bits === 24) { const v = Math.round(c[i] * 8388607); d.setUint8(o, v & 255); d.setUint8(o + 1, (v >> 8) & 255); d.setInt8(o + 2, v >> 16); }
    });
  }
  chunks.push(['data', new Uint8Array(d.buffer)]);
  const total = 12 + chunks.reduce((s, [, b]) => s + 8 + b.length + (b.length & 1), 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  const put = (at, s) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); v.setUint32(4, total - 8, true); put(8, 'WAVE');
  let at = 12;
  for (const [id, b] of chunks) { put(at, id); v.setUint32(at + 4, b.length, true); out.set(b, at + 8); at += 8 + b.length + (b.length & 1); }
  return out.buffer;
}
{
  const a = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) * 0.8);
  const b = Float32Array.from({ length: 100 }, (_, i) => Math.cos(i / 5) * -0.5);
  for (const opts of [{ bits: 16 }, { bits: 24 }, { bits: 32, float: true }]) {
    const p = parseWav(wav({ channels: [a, b], ...opts }));
    assert.equal(p.rate, 44100);
    assert.equal(p.channels.length, 2);
    close(p.channels[0][37], a[37], 1e-4, `${opts.bits}-bit left`);
    close(p.channels[1][37], b[37], 1e-4, `${opts.bits}-bit right`);
    assert.equal(p.frame, 0);
  }
  const serum = parseWav(wav({ channels: [new Float32Array(4096)], extra: [['clm ', '<!>2048 01000000 wavetable (www.xferrecords.com)']] }));
  assert.equal(serum.frame, 2048, 'Serum clm chunk: frame size');
  assert.equal(parseWav(new ArrayBuffer(8)), null);

  const wt = new DataView(new ArrayBuffer(12 + 4 * 256 * 2));
  [...'vawt'].forEach((c, i) => wt.setUint8(i, c.charCodeAt(0)));
  wt.setUint32(4, 256, true);
  wt.setUint16(8, 2, true);
  wt.setFloat32(12 + 4 * 300, 0.75, true);
  const surge = parseSurgeWt(wt.buffer);
  assert.equal(surge.frame, 256);
  assert.equal(surge.channels[0].length, 512);
  assert.equal(surge.channels[0][300], 0.75);

  assert.equal(guessFrame(600), 600, 'single cycle (AKWF)');
  assert.equal(guessFrame(64 * 2048), 2048);
  assert.equal(guessFrame(64 * 256 + 256), 256);
  const t = tableFromFile({ rate: 44100, channels: [new Float32Array(8192).fill(1), new Float32Array(8192).fill(0)], frame: 0 });
  assert.equal(t.channels.length, 1, 'tables are mono');
  assert.equal(t.channels[0][5], 0.5, 'channels averaged');
  assert.equal(t.frame, 2048);
  const long = sampleFromFile({ rate: 1000, channels: [new Float32Array(100000)], frame: 0 });
  assert.equal(long.channels[0].length, 60000, 'samples are cut at 60 s');
  assert.ok(long.cut);
}

// ---- sample pool: content ids, saved with the project, loaded back ----
{
  const ch = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 3));
  const id = addSample({ rate: 44100, channels: [ch] });
  assert.equal(addSample({ rate: 44100, channels: [Float32Array.from(ch)] }), id, 'same audio = same id');
  assert.notEqual(addSample({ rate: 48000, channels: [ch] }), id, 'rate is part of the id');
  close(getSample(id).channels[0][10], ch[10], 1 / 32767, '16-bit');
  const project = { patch: { modules: [{ type: 'SAMPLER', state: { sampleId: id, name: 'x' } }, { type: 'PATCH', patch: { modules: [{ state: { sampleId: id } }] } }] } };
  const saved = withSamples(project);
  assert.deepEqual(Object.keys(saved.samples), [id], 'used samples (also in nested patches), once');
  assert.equal(withSamples({ patch: { modules: [] } }).samples, undefined, 'no samples: nothing added');
  const entry = JSON.parse(JSON.stringify(exportSamples(project)))[id];
  importSamples({ 'copy-of-it': entry, broken: { rate: 1, channels: 1, length: 5, data: 'AAAA' } });
  assert.deepEqual(Array.from(getSample('copy-of-it').channels[0]), Array.from(getSample(id).channels[0]), 'round trip');
  assert.equal(getSample('broken'), null, 'bad entries are skipped');

  // modules: the kernel gets the sample their state names, also when it arrives later
  const sent = [];
  const host = { dsp: { create: () => ({ send: (m) => sent.push(m), destroy() {} }) } };
  const inst = sampler.create(null, sampler, host);
  inst.setState({ sampleId: id, name: 'x' });
  assert.equal(sent.at(-1).type, 'sample');
  assert.equal(sent.at(-1).channels[0], getSample(id).channels[0]);
  inst.setState({ sampleId: 'later', name: 'y' });
  assert.equal(sent.at(-1).channels, null, 'missing: silent');
  importSamples({ later: entry });
  assert.equal(sent.at(-1).channels[0], getSample('later').channels[0], 'arrived: sent');
  inst.destroy();

  const wsent = [];
  const wt = wavetable.create(null, wavetable, { dsp: { create: () => ({ send: (m) => wsent.push(m), destroy() {} }) } });
  wt.setState(wavetable.defaultState());
  assert.equal(wsent.length, 0, 'no table: the kernel keeps its built-in one');
  wt.setState({ sampleId: id, name: 'x', frame: 500 });
  assert.equal(wsent.at(-1).frame, 500);
  wt.setState({ sampleId: id, name: 'x', frame: 250 });
  assert.equal(wsent.at(-1).frame, 250, 'new frame size of the same table is sent');
  assert.deepEqual(wavetable.normalizeState({ sampleId: 5, frame: -3 }), { sampleId: null, name: '', frame: 0 });
}

console.log('sampler + wavetable: ok');
