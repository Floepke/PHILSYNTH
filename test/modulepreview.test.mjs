import assert from 'node:assert/strict';
import { dspTestHost } from './dsphost.mjs';
import { PatchRuntime } from '../src/patch.js';
import { createModulePreview, parseSynthFile } from '../src/modulepreview.js';

const mod = (id, type, extra = {}) => ({ id, type, x: id * 100, y: 0, ...extra });
const file = (modules, cables = [], extra = {}) => ({
  name: 'instrument.phmod',
  text: JSON.stringify({ format: 'philsynth-module', version: 1, modules, cables, ...extra }),
});
const oscFile = () => file([mod(1, 'OSC')]);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
async function setup(readFile = async () => oscFile()) {
  const host = dspTestHost();
  let changes = 0;
  let resumes = 0;
  const engine = { ctx: { currentTime: 0 }, dsp: host.dsp, onChange: () => changes++, resume: () => resumes++ };
  engine.root = await PatchRuntime.create(engine, host.dsp.destination);
  engine.root.setParam(0, 'volume', 0);
  const saved = engine.root.toJSON();
  const baseline = new Set(host.graph.nodes.keys());
  const before = changes;
  const preview = createModulePreview(engine, readFile);
  const unchanged = () => {
    assert.deepEqual(engine.root.toJSON(), saved, 'preview does not change the project');
    assert.equal(changes, before, 'preview never notifies project persistence/history');
  };
  const cleaned = () => assert.deepEqual(new Set(host.graph.nodes.keys()), baseline, 'all temporary DSP nodes are removed');
  return { ...host, engine, preview, unchanged, cleaned, resumes: () => resumes };
}
const audible = ({ L }) => L.some((v) => Math.abs(v) > 0.00001);

{
  assert.throws(() => parseSynthFile('{}'), /not a PHILSYNTH module/);
  assert.throws(() => parseSynthFile(file([mod(1, 'UNKNOWN')]).text), /no module types/);
  assert.equal(parseSynthFile(oscFile().text).modules[0].type, 'OSC');
  const h = await setup();
  h.preview.target.inst.noteOn(1, 60, 0.8, 0);
  h.cleaned();
  await h.preview.select({ path: '/instrument.phmod' });
  assert.equal(h.resumes(), 1);
  h.preview.target.inst.noteOn(2, 60, 0.8, 0);
  assert.ok(audible(h.render(10)), 'MIDI plays directly through a fresh Output, even when the project Output is muted');
  h.preview.target.inst.noteOff(2);
  assert.ok(!audible(h.render(300)), 'note-off releases the preview voice');
  h.preview.target.inst.noteOn(3, 64, 0.8, 0);
  assert.ok(audible(h.render(10)));
  await h.preview.stop();
  h.cleaned();
  assert.ok(!audible(h.render()), 'stopping removes held notes and audio tails immediately');
  h.preview.target.inst.noteOff(3);
  h.preview.target.inst.allOff();
  h.unchanged();
}

{
  const data = file([mod(1, 'OSC'), mod(2, 'AMP', { values: { fine: 0 } })], [{ from: 1, to: 2 }]);
  const h = await setup(async () => data);
  await h.preview.select({ path: '/chain.phmod' });
  h.preview.target.inst.noteOn(1, 60, 1, 0);
  assert.ok(!audible(h.render(10)), 'only terminal audio outputs are connected: the saved chain is not bypassed');
  h.unchanged();
  await h.preview.stop();
  h.cleaned();
}

{
  const data = file([mod(1, 'MULTIMIDI'), mod(2, 'OSC')], [{ from: 1, to: 2 }]);
  const h = await setup(async () => data);
  await h.preview.select({ path: '/midi-chain.phmod' });
  h.preview.target.inst.noteOn(1, 60, 1, 0);
  h.render(10);
  const osc = [...h.graph.nodes.values()].find((n) => n.kind === 'osc').k;
  assert.equal(osc.voices.filter((v) => v.stage !== 0).length, 1, 'MIDI is sent to the chain input, not doubled at its destination');
  h.preview.target.inst.allOff();
  assert.ok(!audible(h.render(300)));
  await h.preview.stop();
  h.cleaned();
}

{
  const data = file([mod(1, 'PATCH', {
    patch: { modules: [mod(0, 'OUT'), mod(1, 'OSC')], cables: [{ from: 1, to: 0 }] },
  })]);
  const h = await setup(async () => data);
  await h.preview.select({ path: '/nested.phmod' });
  h.preview.target.inst.noteOn(1, 67, 1, 0);
  assert.ok(audible(h.render(10)), 'saved nested instruments are playable');
  h.unchanged();
  await h.preview.stop();
  h.cleaned();
}

{
  const samples = {
    'preview-test-sample': {
      rate: 48000, channels: 1, length: 4800,
      data: Buffer.from(Int16Array.from({ length: 4800 }, (_, i) => Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 16000)).buffer).toString('base64'),
    },
  };
  const data = file([mod(1, 'SAMPLER', { state: { sampleId: 'preview-test-sample', name: 'preview.wav' } })], [], { samples });
  const h = await setup(async () => data);
  await h.preview.select({ path: '/sampled.phmod' });
  h.preview.target.inst.noteOn(1, 60, 1, 0);
  assert.ok(audible(h.render(10)), 'embedded samples are restored before the instrument is created');
  await h.preview.stop();
  h.cleaned();
  h.unchanged();
}

{
  const data = file([mod(1, 'PATCH', {
    patch: { modules: [mod(0, 'OUT'), mod(1, 'UNKNOWN')], cables: [] },
  })]);
  const h = await setup(async () => data);
  await assert.rejects(h.preview.select({ path: '/broken-nested.phmod' }), /Unknown module type/);
  h.cleaned();
  h.unchanged();
}

{
  const first = deferred();
  const h = await setup(async (path) => path === '/slow.phmod' ? first.promise : oscFile());
  const slow = h.preview.select({ path: '/slow.phmod' });
  await h.preview.select({ path: '/latest.phmod' });
  const current = new Set(h.graph.nodes.keys());
  first.resolve(oscFile());
  await slow;
  assert.deepEqual(new Set(h.graph.nodes.keys()), current, 'a stale file read cannot replace the latest preview');
  h.preview.target.inst.noteOn(1, 60, 1, 0);
  assert.ok(audible(h.render(10)));
  await h.preview.stop();
  h.cleaned();
  const pending = h.preview.select({ path: '/latest.phmod' });
  await Promise.resolve();
  await h.preview.stop();
  await pending;
  h.cleaned();
  assert.ok(!audible(h.render()), 'closing while a patch is being built cannot leave it sounding');
}

{
  const h = await setup(async (path) => {
    if (path === '/unreadable.phmod') throw new Error('Permission denied');
    if (path === '/invalid.phmod') return { text: '{' };
    return oscFile();
  });
  await h.preview.select({ path: '/valid.phmod' });
  await assert.rejects(h.preview.select({ path: '/invalid.phmod' }), SyntaxError);
  h.cleaned();
  await assert.rejects(h.preview.select({ path: '/unreadable.phmod' }), /Permission denied/);
  h.cleaned();
  await h.preview.select({ path: '/valid.phmod' });
  await h.preview.select(null);
  h.cleaned();
  h.unchanged();
}

console.log('module preview tests passed');
