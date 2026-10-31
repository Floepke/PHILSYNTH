// Run: node test/midi.test.mjs   (mocks Web MIDI + DOM)
import assert from 'node:assert/strict';

const winListeners = {};
globalThis.window = {
  isSecureContext: true,
  addEventListener: (t, fn) => (winListeners[t] ??= []).push(fn),
};

class FakeInput {
  constructor(name) { this.name = name; this.state = 'connected'; this.l = []; this.opened = false; }
  addEventListener(t, fn) { if (t === 'midimessage') this.l.push(fn); }
  open() { this.opened = true; return Promise.resolve(this); }
  emit(...bytes) { this.l.forEach((fn) => fn({ data: Uint8Array.from(bytes) })); }
}
const inputs = new Map();
const accessListeners = [];
let deny = true;
let denyAs = 'SecurityError';
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  requestMIDIAccess: async () => {
    if (deny) throw Object.assign(new Error('denied'), { name: denyAs });
    return { inputs, addEventListener: (t, fn) => t === 'statechange' && accessListeners.push(fn) };
  },
} });

const { initMidi, initKeyboard } = await import('../src/midi.js');
const calls = [];
const ids = new Map(); // MODMIDI note id -> pitch
let status = '';
let activity = 0;
const target = {
  def: { acceptsMidi: true },
  inst: {
    noteOn: (id, p, v) => { ids.set(id, p); calls.push(['on', p, v]); },
    noteOff: (id) => calls.push(['off', ids.get(id)]),
    allOff: () => calls.push(['all']),
  },
};
const midi = initMidi({ getTarget: () => target, onStatus: (s) => (status = s), onActivity: () => activity++ });

// initMidi itself does not listen to the computer keyboard (initKeyboard does)
assert.ok(!winListeners.keydown && !winListeners.keyup, 'no keyboard listeners');

// denied -> helpful status, retry possible
assert.equal(await midi.enable(), false);
assert.match(status, /Firefox.*no MIDI device.*restart Firefox/, 'Firefox silent denial explained');
denyAs = 'NotAllowedError';
const [p1, p2] = [midi.enable(), midi.enable()];
assert.equal(p1, p2, 'one request at a time');
assert.match(status, /Asking/);
assert.equal(await p1, false);
assert.match(status, /blocked.*NotAllowedError/);

// granted, but no devices yet
deny = false;
assert.equal(await midi.enable(), true);
assert.match(status, /no input devices/);

// hot-plug a controller
const ctl = new FakeInput('Arturia KeyStep');
inputs.set('1', ctl);
accessListeners.forEach((fn) => fn());
assert.match(status, /Arturia KeyStep/);
assert.ok(ctl.opened);

ctl.emit(0x90, 64, 127); // note on ch1
ctl.emit(0x93, 65, 64); // note on ch4
ctl.emit(0x90, 64, 0); // note on vel 0 == off
ctl.emit(0x81, 65, 10); // note off ch2
ctl.emit(0xb0, 123, 0); // all notes off
ctl.emit(0xfe); // active sensing ignored
assert.deepEqual(calls.splice(0), [['on', 64, 1], ['on', 65, 64 / 127], ['off', 64], ['off', 65], ['all']]);
assert.ok(activity > 0);

// every key press is a MODMIDI note with its own id; a repeated note-on releases the old one
ctl.emit(0x90, 70, 127); ctl.emit(0x90, 70, 127); ctl.emit(0x80, 70, 0);
const used = [...ids.keys()].slice(-2);
assert.notEqual(used[0], used[1]);
assert.deepEqual(calls.splice(0), [['on', 70, 1], ['off', 70], ['on', 70, 1], ['off', 70]]);

// the note-off goes to the module that got the note-on, also after selecting another one
const other = [];
let current = target;
const midi2 = initMidi({ getTarget: () => current, onStatus: () => {} });
const ctl2 = new FakeInput('Second controller');
inputs.set('2', ctl2);
await midi2.enable();
ctl2.emit(0x90, 62, 127);
current = { def: { acceptsMidi: true }, inst: { noteOn: () => other.push('on'), noteOff: () => other.push('off') } };
ctl2.emit(0x80, 62, 0);
assert.deepEqual(calls.splice(0), [['on', 62, 1], ['off', 62]], 'off reached the first target');
assert.deepEqual(other, []);

// statechange again must not double-subscribe
accessListeners.forEach((fn) => fn());
ctl.emit(0x90, 60, 100);
assert.equal(calls.splice(0).length, 1);
ctl.emit(0x80, 60, 0);
calls.splice(0);

// modules with liveMidi: false (VELOCITY2CTL) never get notes from the MIDI device
const vel = [];
current = { def: { acceptsMidi: true, liveMidi: false }, inst: { noteOn: () => vel.push('on'), noteOff: () => vel.push('off') } };
ctl2.emit(0x90, 61, 127);
ctl2.emit(0x80, 61, 0);
assert.deepEqual(vel, []);
const { default: vel2ctl } = await import('../src/modules/velocity2ctl.js');
assert.equal(vel2ctl.acceptsMidi, true, 'clips and MIDI cables still play it');
assert.equal(vel2ctl.liveMidi, false);
// computer keyboard: Q..P white keys from C4, the number row the black keys
{
  let kbTarget = target;
  let resumed = 0;
  let missing = 0;
  initKeyboard({ getTarget: () => kbTarget, onActivity: () => resumed++, onNoTarget: () => missing++ });
  const fire = (type, code, o = {}) => {
    const e = { type, code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false,
      target: { closest: () => null }, prevented: false, ...o };
    e.preventDefault = () => { e.prevented = true; };
    (winListeners[type] ?? []).forEach((fn) => fn(e));
    return e;
  };
  calls.splice(0);
  const codes = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'];
  for (const c of codes) { assert.ok(fire('keydown', c).prevented); fire('keyup', c); }
  const white = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76];
  assert.deepEqual(calls.splice(0), white.flatMap((p) => [['on', p, 0.8], ['off', p]]));
  assert.ok(resumed >= 10, 'audio resumed');
  fire('keydown', 'Digit2'); fire('keyup', 'Digit2');
  fire('keydown', 'Digit0'); fire('keyup', 'Digit0');
  assert.deepEqual(calls.splice(0), [['on', 61, 0.8], ['off', 61], ['on', 75, 0.8], ['off', 75]]);
  // held key repeats do not retrigger; chords work
  fire('keydown', 'KeyQ'); fire('keydown', 'KeyQ', { repeat: true }); fire('keydown', 'KeyE');
  fire('keyup', 'KeyE'); fire('keyup', 'KeyQ');
  assert.deepEqual(calls.splice(0), [['on', 60, 0.8], ['on', 64, 0.8], ['off', 64], ['off', 60]]);
  // ignored: typing in a field, modifiers, keys already handled, other keys
  assert.ok(!fire('keydown', 'KeyQ', { target: { closest: () => ({}) } }).prevented);
  fire('keydown', 'KeyQ', { ctrlKey: true });
  fire('keydown', 'KeyQ', { metaKey: true });
  fire('keydown', 'KeyQ', { defaultPrevented: true });
  fire('keydown', 'KeyA'); fire('keydown', 'KeyS'); fire('keydown', 'Digit1');
  assert.deepEqual(calls.splice(0), []);
  // the off reaches the module that got the note; window blur releases held keys
  fire('keydown', 'KeyW');
  kbTarget = null;
  fire('keydown', 'KeyT');
  assert.equal(missing, 1, 'no target: reported');
  fire('keyup', 'KeyW');
  kbTarget = target;
  fire('keydown', 'KeyR');
  (winListeners.blur ?? []).forEach((fn) => fn({}));
  fire('keyup', 'KeyR');
  assert.deepEqual(calls.splice(0), [['on', 62, 0.8], ['off', 62], ['on', 65, 0.8], ['off', 65]]);
}
console.log('all midi tests passed');
