// Run: node test/sound2ctl.test.mjs   (SOUND2CTL kernel: Audio Rate and Smooth)
import assert from 'node:assert/strict';

globalThis.sampleRate = 48000;
const { default: Sound2Ctl, RATE_MAX } = await import('../src/modules/sound2ctl.dsp.js');
const { getModule } = await import('../src/modules/index.js');

const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);
// one block whose sample i is f(i) (both channels)
const block = (f) => { const L = Float32Array.from({ length: 128 }, (_, i) => f(i)); return [[L, L]]; };
const ramp = (start) => block((i) => ((start + i) % 1000) / 1000); // distinct value per sample

// defaults: unchanged behaviour (the last sample of every block, no smoothing)
const def = getModule('SOUND2CTL');
const ids = def.params.map((p) => p.id);
assert.deepEqual(ids.slice(-4), ['outController', 'outMin', 'outMax', 'outSmooth'], 'Out block last');
assert.equal(def.params.find((p) => p.id === 'rate').default, RATE_MAX, 'Audio Rate defaults to max');
assert.equal(def.params.find((p) => p.id === 'smooth').default, 0, 'Smooth defaults to 0');
{
  const k = new Sound2Ctl();
  for (let b = 0; b < 5; b++) {
    const ins = ramp(b * 128);
    k.process(ins);
    near(k.value, (Math.fround(ins[0][0][127]) + 1) / 2, `block ${b}: last sample`);
  }
  k.process([[]]);
  assert.equal(k.value, 0.5, 'no input = zero voltage');
  k.process(block(() => 4));
  assert.equal(k.value, 1, 'clamped');
}
// also at 44.1 kHz the max rate takes the last sample of each block
{
  globalThis.sampleRate = 44100;
  const k = new Sound2Ctl();
  const ins = ramp(300);
  k.process(ins);
  near(k.value, (ins[0][0][127] + 1) / 2, '44.1 kHz: last sample');
  globalThis.sampleRate = 48000;
}

// 1 Hz: a value right away, then held for one second (375 blocks), then the next one
{
  const k = new Sound2Ctl();
  k.param('rate', 1);
  k.process(block(() => 0.5));
  near(k.value, 0.75, 'first block samples immediately');
  let blocks = 1;
  while (blocks < 375) { k.process(block(() => -1)); blocks++; near(k.value, 0.75, `held at block ${blocks}`); }
  k.process(block(() => -1)); // samples 48000..48127: the tick at sample 48000 (index 0)
  near(k.value, 0, 'next value after one second');
}

// 1 Hz with 100 % smooth: a linear glide that arrives as the next value is taken
{
  const k = new Sound2Ctl();
  k.param('rate', 1);
  k.param('smooth', 100);
  k.process(block(() => -1)); // first target 0: glides from the 0.5 start
  k.process(block(() => -1));
  for (let b = 2; b < 375; b++) k.process(block(() => 1)); // input changes, but not sampled yet
  near(k.value, 0, 'first glide done', 1e-6);
  k.process(block(() => 1)); // block 375: new target 1, glide over 375 blocks
  near(k.value, 1 / 375, 'first glide step');
  for (let b = 1; b < 187; b++) k.process(block(() => 1));
  near(k.value, 187 / 375, 'halfway after half a second', 1e-6);
  for (let b = 187; b < 375; b++) k.process(block(() => 1));
  near(k.value, 1, 'arrives after one second', 1e-6);
}

// 50 % smooth: arrives after half the period, then holds
{
  const k = new Sound2Ctl();
  k.param('rate', 1);
  k.param('smooth', 50);
  k.process(block(() => -1));
  for (let b = 1; b < 375; b++) k.process(block(() => 1));
  k.process(block(() => 1)); // target 1 from 0
  for (let b = 1; b < 187; b++) k.process(block(() => 1));
  assert.ok(k.value > 0.99 || Math.abs(k.value - 1) < 0.01, `nearly there after half a period: ${k.value}`);
  for (let b = 0; b < 3; b++) k.process(block(() => 1));
  assert.equal(k.value, 1, 'holds the target');
}

// a glide shorter than one block jumps (e.g. 100 % smooth at audio rate)
{
  const k = new Sound2Ctl();
  k.param('smooth', 100);
  k.process(block(() => 1));
  assert.equal(k.value, 1, 'no glide when the period is shorter than a block');
}

// a new target mid-glide continues from the current value (no jump)
{
  const k = new Sound2Ctl();
  k.param('rate', 2);
  k.param('smooth', 100);
  k.process(block(() => 1)); // target 1 from 0.5 over 187.5 blocks
  for (let b = 1; b < 100; b++) k.process(block(() => 1));
  const before = k.value;
  k.param('rate', 1000); // ticks every block now; glide length < 1 block -> jump to the new target
  k.process(block(() => -1));
  assert.ok(before > 0.5 && before < 1, `mid glide: ${before}`);
  assert.equal(k.value, 0, 'fast rate: jumps to the new target');
}

console.log('sound2ctl tests passed');
