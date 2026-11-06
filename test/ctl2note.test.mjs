import assert from 'node:assert/strict';
import ctl2note from '../src/modules/ctl2note.js';
import { getModule, modules } from '../src/modules/index.js';
import { dspTestHost } from './dsphost.mjs';
import { PatchRuntime, cableSignals } from '../src/patch.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const target = () => ({
  log: [],
  noteOn(...args) { this.log.push(['on', ...args]); },
  noteMod(...args) { this.log.push(['mod', ...args]); },
  noteOff(...args) { this.log.push(['off', ...args]); },
});
const setup = () => {
  const { dsp, render } = dspTestHost();
  const inst = ctl2note.create({ currentTime: 0 }, ctl2note, { dsp });
  const a = target(), b = target();
  let targets = [a, b];
  inst.getMidiTargets = () => targets;
  return { inst, a, b, dsp, render, targets: (v) => { targets = v; } };
};

assert.equal(getModule('CTL2NOTE'), ctl2note);
assert.ok(modules.includes(ctl2note));
assert.deepEqual(ctl2note.params.map((p) => p.id), ['pitch', 'noteState', 'finetune', 'velocity', 'phase']);
assert.deepEqual(cableSignals(ctl2note, getModule('OSC')), { audio: false, midi: true });
assert.equal(ctl2note.acceptsMidi, false);

// A single held note changes live; only Off -> On generates a new id and captures Phase.
{
  const { inst, a, b, render, dsp } = setup();
  render(2);
  assert.equal(a.log.length, 0, 'default Off is silent');
  inst.setParam('pitch', 63.7);
  inst.setParam('finetune', -0.25);
  inst.setParam('velocity', 0.6);
  inst.setParam('phase', 0.3);
  inst.setParam('noteState', 1);
  const id = a.log[0][1];
  assert.deepEqual(a.log[0], ['on', id, 63.75, 0.6, 0.3, 0]);
  assert.deepEqual(a.log, b.log, 'fan-out uses the same generated note');
  inst.setParam('noteState', 1);
  render(2);
  assert.equal(a.log.length, 1, 'repeated On does not retrigger');
  inst.setParam('pitch', 66.5);
  assert.deepEqual(a.log.at(-1), ['mod', id, 66.75, 0.6]);
  inst.setParam('finetune', 1);
  inst.setParam('velocity', 0);
  assert.deepEqual(a.log.at(-1), ['mod', id, 68, 0]);
  const count = a.log.length;
  inst.setParam('phase', 0.8);
  assert.equal(a.log.length, count, 'phase does not update/retrigger a sounding note');
  inst.setParam('noteState', 0);
  assert.deepEqual(a.log.at(-1), ['off', id]);
  assert.equal(inst.hasPendingMidi, false);
  inst.setParam('noteState', 1);
  const on = a.log.at(-1);
  assert.equal(on[0], 'on');
  assert.notEqual(on[1], id, 'each onset has a unique id');
  assert.equal(on[4], 0.8);
  inst.destroy();
  assert.deepEqual(a.log.at(-1), ['off', on[1]], 'destroy releases its own note');
  assert.equal(dsp.clocks.size, 0, 'destroy unsubscribes the audio clock');
}

// Pitch bounds and finetuning are separate, including +/-100 cents at the MIDI boundaries.
{
  const { inst, a } = setup();
  inst.setParam('pitch', -10);
  inst.setParam('finetune', -2);
  inst.setParam('velocity', 2);
  inst.setParam('noteState', 1);
  assert.deepEqual(a.log[0].slice(2, 4), [-1, 1]);
  inst.setParam('pitch', 140);
  inst.setParam('finetune', 2);
  assert.deepEqual(a.log.at(-1).slice(2), [128, 1]);
  inst.destroy();
}

// Modulation reports are batched: Note State may arrive before Pitch/Velocity/Phase.
{
  const { inst, a, render } = setup();
  inst.onModulated('noteState', 1);
  inst.onModulated('pitch', 72.6);
  inst.onModulated('finetune', 0.42);
  inst.onModulated('velocity', 0.4);
  inst.onModulated('phase', 0.75);
  assert.equal(a.log.length, 0);
  render();
  assert.equal(a.log[0][0], 'on');
  near(a.log[0][2], 73.42);
  assert.deepEqual(a.log[0].slice(3, 5), [0.4, 0.75]);
  const id = a.log[0][1];
  inst.onModulated('pitch', 60);
  inst.onModulated('finetune', -0.5);
  inst.onModulated('velocity', 0.9);
  inst.onModulated('phase', 0.1);
  render();
  assert.deepEqual(a.log.at(-1), ['mod', id, 59.5, 0.9]);
  inst.onModulated('noteState', 0);
  render();
  assert.deepEqual(a.log.at(-1), ['off', id]);
  inst.destroy();
}

// Adding/removing MIDI targets while On never leaves a note stuck on an old target.
{
  const { inst, a, b, render, targets } = setup();
  targets([]);
  inst.setParam('noteState', 1);
  inst.setParam('pitch', 71);
  inst.setParam('phase', 0.4);
  render();
  assert.equal(inst.hasPendingMidi, false);
  targets([a]);
  render();
  const id = a.log[0][1];
  assert.equal(a.log[0][2], 71, 'armed On starts with fully restored parameters');
  inst.setParam('phase', 0.9);
  targets([a, b]);
  render();
  assert.equal(b.log[0][1], id);
  assert.equal(b.log[0][4], 0.4, 'new target receives the active note phase');
  targets([b]);
  inst.releaseTarget(a);
  render();
  assert.deepEqual(a.log.at(-1), ['off', id]);
  inst.allOff();
  assert.deepEqual(b.log.at(-1), ['off', id]);
  const count = b.log.length;
  render(5);
  inst.setParam('velocity', 0.5);
  inst.setParam('noteState', 1);
  assert.equal(b.log.length, count, 'panic does not restart while state remains On');
  inst.setParam('noteState', 0);
  inst.setParam('noteState', 1);
  assert.equal(b.log.at(-1)[0], 'on');
  inst.destroy();
}

// Real patch routing, live LFO control, saving/loading On and nested Patch panic.
{
  const { dsp, graph, render, kernel } = dspTestHost();
  const engine = { ctx: { currentTime: 0 }, dsp };
  const root = await PatchRuntime.create(engine, dsp.destination);
  const generator = await root.addModule('CTL2NOTE');
  const osc = await root.addModule('OSC');
  const second = await root.addModule('OSC');
  root.connect(generator.id, osc.id);
  root.connect(generator.id, second.id);
  root.setParam(generator.id, 'pitch', 70);
  root.setParam(generator.id, 'finetune', 0.5);
  root.setParam(generator.id, 'velocity', 0.7);
  root.setParam(generator.id, 'phase', 0.25);
  root.setParam(generator.id, 'noteState', 1);
  const voice = () => kernel(osc.inst.node).voices.find(v => v.stage !== 0);
  assert.equal(voice().pitchT, 70.5);
  assert.equal(voice().velT, 0.7);
  assert.equal(voice().phase, 0.25);
  const id = voice().id;
  const lfo = await root.addModule('LFO', { values: { outController: 0, outMin: 50, outMax: 50 } });
  assert.ok(root.connect(lfo.id, generator.id), 'control cable into generator');
  render(2);
  await Promise.resolve(); // OSC coalesces live noteMod messages in a microtask
  assert.equal(generator.values.pitch, 64);
  assert.equal(voice().pitchT, 64.5, 'modulated pitch updates the existing voice');
  assert.equal(voice().id, id);
  assert.equal(graph.nodes.get(generator.ctl.h).values.pitch, 64);
  root.disconnect(root.cables.find(c => c.from === generator.id && c.to === second.id));
  assert.ok([0, 4].includes(kernel(second.inst.node).voices.find(v => v.id === id).stage), 'disconnect releases only removed target');
  const saved = root.toJSON();
  root.destroy();
  const restored = await PatchRuntime.create(engine, dsp.destination);
  await restored.load(saved);
  render(2);
  const gen2 = restored.modules.get(generator.id);
  const osc2 = restored.modules.get(osc.id);
  const v2 = kernel(osc2.inst.node).voices.find(v => v.stage !== 0);
  assert.ok(v2);
  assert.equal(v2.pitchT, 64.5);
  assert.equal(v2.velT, 0.7, 'saved On uses saved velocity');
  assert.equal(gen2.values.phase, 0.25);
  restored.removeModule(generator.id);
  assert.ok([0, 4].includes(v2.stage), 'deleting generator releases its outgoing note');
  restored.destroy();

  const nested = await PatchRuntime.create(engine, dsp.destination);
  const pm = await nested.addModule('PATCH');
  const inner = pm.inst.patch;
  const gen = await inner.addModule('CTL2NOTE', { values: { noteState: 1, phase: 0.6 } });
  const synth = await inner.addModule('OSC');
  inner.connect(gen.id, synth.id);
  render(2);
  const nv = kernel(synth.inst.node).voices.find(v => v.stage !== 0);
  assert.ok(nv);
  pm.inst.allOff();
  render(2);
  assert.ok([0, 4].includes(nv.stage), 'Patch panic reaches autonomous generators');
  assert.equal(gen.inst.hasPendingMidi, false);
  // Notes generated inside can also pass through the Patch Output to an external target.
  inner.disconnect(inner.cables.find(c => c.from === gen.id));
  inner.connect(gen.id, 0);
  const outside = await nested.addModule('OSC');
  assert.ok(nested.connect(pm.id, outside.id));
  inner.setParam(gen.id, 'noteState', 0);
  inner.setParam(gen.id, 'noteState', 1);
  render();
  assert.ok(kernel(outside.inst.node).voices.some(v => v.stage !== 0), 'generator passes MIDI through Patch Output');
  pm.inst.allOff();
  render();
  assert.ok(kernel(outside.inst.node).voices.filter(v => v.stage !== 0).every(v => v.stage === 4));
  nested.destroy();
}

console.log('ctl2note tests passed');
