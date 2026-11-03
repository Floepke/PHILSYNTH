import assert from 'node:assert/strict';
import tuning, { normalizeTuning, describeScale } from '../src/modules/tuning.js';
import { getModule, modules } from '../src/modules/index.js';
import { parseScala, parsePitch, tunePitch, tuneKey, TWELVE_TET } from '../src/scala.js';
import { PatchRuntime } from '../src/patch.js';
import { dspTestHost } from './dsphost.mjs';
import { LIBRARY, libraryGroups } from '../src/scalalib.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// ---- parser ----
near(parsePitch(' 701.955 fifth'), 701.955);
near(parsePitch('3/2'), 1200 * Math.log2(1.5));
near(parsePitch('2'), 1200);
near(parsePitch('-5.0'), -5);
near(parsePitch('.5'), 0.5);
assert.equal(typeof parsePitch('0/1'), 'string');
assert.equal(typeof parsePitch('-3/2'), 'string');
assert.equal(typeof parsePitch('abc'), 'string');

{
  const s = parseScala(TWELVE_TET);
  assert.ok(s.ok);
  assert.equal(s.description, '12-tone equal temperament');
  assert.equal(s.count, 12);
  assert.equal(s.period, 1200);
  // 12-TET changes nothing
  for (let k = 0; k <= 127; k++) near(tunePitch(s, k), k);
  near(tunePitch(s, 60.25), 60.25);
}

// a just-intonation major scale (7 notes) with comments, CRLF and trailing text
const JUST = '! just.scl\r\n!\r\nJust major\r\n 7\r\n!\r\n 9/8\r\n 5/4  major third\r\n 4/3\r\n 3/2\r\n 5/3\r\n 15/8\r\n 2/1\r\n';
{
  const s = parseScala(JUST);
  assert.ok(s.ok, s.error);
  assert.equal(s.count, 7);
  near(tuneKey(s, 60), 60);
  near(tuneKey(s, 61), 60 + 12 * Math.log2(9 / 8));
  near(tuneKey(s, 62), 60 + 12 * Math.log2(5 / 4));
  near(tuneKey(s, 67), 72); // one period (7 keys) up = an octave
  near(tuneKey(s, 59), 48 + 12 * Math.log2(15 / 8)); // one key down: the 7th degree an octave lower
  near(tuneKey(s, 53), 48);
  // micropitch on top; ties round up to the next key (60.5 -> key 61, −50 ct)
  near(tunePitch(s, 60.2), 60.2);
  near(tunePitch(s, 60.5), tuneKey(s, 61) - 0.5);
  // output stays in range
  assert.ok(tunePitch(s, 127) <= 135);
  assert.ok(tunePitch(s, 0) >= 0);
}

// non-octave period (Bohlen–Pierce: 13 steps per 3/1)
{
  const bp = `BP\n13\n${Array.from({ length: 12 }, (_, i) => `${((i + 1) * 1200 * Math.log2(3)) / 13}`).map((c) => (c.includes('.') ? c : `${c}.0`)).join('\n')}\n3/1\n`;
  const s = parseScala(bp);
  assert.ok(s.ok, s.error);
  near(s.period, 1200 * Math.log2(3));
  near(tuneKey(s, 73), 60 + 12 * Math.log2(3));
  assert.match(describeScale(s), /13 notes per period 1902 ct/);
}

// pasted without description: the first line is the count
assert.ok(parseScala('3\n400.0\n800.0\n2/1').ok);
// empty description line is valid
assert.ok(parseScala('!x\n\n2\n600.0\n2/1').ok);
// errors carry a line number and leave notes untuned
{
  const s = parseScala('Bad\n3\n100.0\nfoo\n2/1');
  assert.equal(s.ok, false);
  assert.match(s.error, /^Line 4: "foo"/);
  assert.equal(tunePitch(s, 61), 61);
  assert.match(describeScale(s), /untuned/);
}
assert.match(parseScala('X\n3\n100.0\n2/1').error, /expected 3 pitches, found 2/);
assert.match(parseScala('X\nnope').error, /number of notes/);
assert.match(parseScala('X\n1\n0/1').error, /positive ratio/);
assert.match(parseScala('X\n1\n-100.0').error, /period/);
assert.equal(parseScala('').ok, false);
assert.equal(parseScala(undefined).ok, false);

// ---- state ----
assert.deepEqual(normalizeTuning({ text: 'a', name: 'b.scl' }), { text: 'a', name: 'b.scl' });
assert.equal(normalizeTuning(null).text, TWELVE_TET);
assert.equal(normalizeTuning({ text: 'x'.repeat(300 * 1024) }).text.length, 256 * 1024);
assert.match(describeScale(parseScala(JUST)), /^Just major — 7 notes per octave; C4 = degree 0$/);

// ---- module ----
assert.equal(getModule('TUNING'), tuning);
assert.ok(modules.includes(tuning));
assert.equal(tuning.params.length, 0);
assert.ok(tuning.acceptsMidi && tuning.midiOut);

function setup() {
  const clocks = new Set();
  const ctx = { currentTime: 0 };
  const log = [];
  const target = {
    noteOn(id, pitch, velocity, phase, time) { log.push({ type: 'on', id, pitch, velocity, phase, time }); },
    noteMod(id, pitch, velocity) { log.push({ type: 'mod', id, pitch, velocity }); },
    noteOff(id) { log.push({ type: 'off', id }); },
  };
  const dsp = {
    create() { return { param() {}, destroy() {} }; },
    onClock(fn) { clocks.add(fn); return () => clocks.delete(fn); },
  };
  const inst = tuning.create(ctx, tuning, { dsp });
  inst.getMidiTargets = () => [target];
  return { inst, log, clocks, target };
}

{
  const { inst, log, clocks } = setup();
  inst.setState({ text: JUST });
  inst.noteOn(1, 62, 0.7, 0.25, 3);
  assert.equal(log.length, 1);
  assert.equal(log[0].type, 'on');
  near(log[0].pitch, 60 + 12 * Math.log2(5 / 4));
  assert.equal(log[0].velocity, 0.7);
  assert.equal(log[0].phase, 0.25);
  assert.equal(log[0].time, 3);
  const out = log[0].id;
  // pitch bend / micropitch through noteMod
  inst.noteMod(1, 62.1, 0.5);
  near(log[1].pitch, tuneKey(inst.scale, 62) + 0.1);
  assert.deepEqual([log[1].type, log[1].id, log[1].velocity], ['mod', out, 0.5]);
  // a new scale retunes sounding notes
  inst.setState({ text: TWELVE_TET });
  assert.equal(log[2].type, 'mod');
  near(log[2].pitch, 62.1);
  inst.noteOff(1);
  assert.deepEqual(log[3], { type: 'off', id: out });
  inst.setState({ text: JUST });
  assert.equal(log.length, 4, 'released notes are not retuned');
  // allOff releases its own sounding notes
  inst.noteOn(2, 60, 1);
  inst.allOff();
  assert.equal(log.at(-1).type, 'off');
  inst.destroy();
  assert.equal(clocks.size, 0);
}

// in a patch: default state is 12-TET, the state is saved, notes pass through a MIDI cable
{
  const { dsp } = dspTestHost();
  const ctx = { currentTime: 0 };
  const engine = { ctx, dsp, createPatch: (sink) => PatchRuntime.create(engine, sink) };
  const root = await PatchRuntime.create(engine, dsp.destination);
  const tu = await root.addModule('TUNING');
  assert.equal(tu.state.name, '12-TET.scl');
  assert.ok(tu.inst.scale.ok);
  const osc = await root.addModule('OSC');
  assert.ok(root.connect(tu.id, osc.id));
  assert.equal(root.connect(osc.id, tu.id), false, 'TUNING cannot receive audio');
  const played = [];
  const on = osc.inst.noteOn.bind(osc.inst);
  osc.inst.noteOn = (id, pitch, ...rest) => { played.push(pitch); return on(id, pitch, ...rest); };
  root.setState(tu.id, { text: JUST, name: 'just.scl' });
  assert.equal(tu.inst.scale.count, 7);
  tu.inst.noteOn(1, 62, 1);
  near(played[0], 60 + 12 * Math.log2(5 / 4));
  tu.inst.allOff();
  const tu2 = await root.addModule('TUNING', { state: structuredClone(tu.state) });
  assert.equal(tu2.inst.scale.description, 'Just major');
}

// ---- PHILSYNTH library ----
{
  assert.ok(LIBRARY.length >= 30);
  assert.equal(new Set(LIBRARY.map((e) => e.file)).size, LIBRARY.length, 'unique file names');
  for (const e of LIBRARY) {
    const sc = parseScala(e.text);
    assert.ok(sc.ok, `${e.name}: ${sc.error}`);
    assert.ok(sc.description.length > 3, e.name);
    for (let i = 1; i < sc.count; i++) assert.ok(sc.cents[i] > sc.cents[i - 1] && sc.cents[i] < sc.period, `${e.name} ascending`);
  }
  assert.deepEqual(libraryGroups(), ['Equal temperament', 'Non-octave', 'Well temperament', 'Meantone', 'Just intonation']);
  const lib = (name) => parseScala(LIBRARY.find((e) => e.name === name).text);
  const round1 = (sc) => sc.cents.map((c) => Math.round(c * 10) / 10);
  // 12-TET from the library changes nothing
  for (let k = 0; k <= 127; k++) near(tunePitch(lib('12-TET (standard)'), k), k, 1e-6);
  // published cents tables
  assert.deepEqual(round1(lib('Werckmeister III')), [0, 90.2, 192.2, 294.1, 390.2, 498, 588.3, 696.1, 792.2, 888.3, 996.1, 1092.2]);
  assert.deepEqual(round1(lib('Kirnberger III')), [0, 90.2, 193.2, 294.1, 386.3, 498, 590.2, 696.6, 792.2, 889.7, 996.1, 1088.3]);
  assert.deepEqual(round1(lib('Vallotti')), [0, 94.1, 196.1, 298, 392.2, 502, 592.2, 698, 796.1, 894.1, 1000, 1090.2]);
  assert.deepEqual(round1(lib('1/4-comma meantone')), [0, 76, 193.2, 310.3, 386.3, 503.4, 579.5, 696.6, 772.6, 889.7, 1006.8, 1082.9]);
  near(lib('1/4-comma meantone').cents[4], 1200 * Math.log2(5 / 4), 1e-4); // pure major third
  assert.equal(lib('Harry Partch 43-tone').count, 43);
  assert.equal(lib('Indian 22 shruti').count, 22);
  // Bohlen–Pierce: 13 keys up = a tritave (3/1)
  for (const n of ['Bohlen–Pierce (equal)', 'Bohlen–Pierce (just)']) {
    const bp = lib(n);
    assert.equal(bp.count, 13);
    near(tuneKey(bp, 73), 60 + 12 * Math.log2(3), 1e-6);
  }
  near(tuneKey(lib('Wendy Carlos Alpha'), 61), 60.77965, 1e-9);
}

console.log('tuning tests passed');
