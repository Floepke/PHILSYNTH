// Live note input: MIDI devices (Web MIDI, initMidi) and the computer keyboard (initKeyboard).
// Notes are translated to MODMIDI (see modmidi.js): every key press becomes a note with its own
// id, sent to the current target. The note-off goes to the module that got the note-on, even
// when another module was selected in between.
import { newNoteId } from './modmidi.js';

let access = null; // keep a strong reference, otherwise the browser may GC it and stop delivering messages

// Keys held right now on any live input (MIDI device and computer keyboard), as played pitches
// (before Global Transpose), for the piano roll keyboard. Also when no module plays them.
const held = new Map(); // `${player}:${key}` -> pitch
const heldListeners = new Set();
let players = 0;
export const heldPitches = () => new Set(held.values());
export function onHeldChange(fn) { heldListeners.add(fn); return () => heldListeners.delete(fn); }
function setHeld(token, pitch) {
  if (pitch === null ? !held.delete(token) : held.get(token) === pitch) return;
  if (pitch !== null) held.set(token, pitch);
  heldListeners.forEach((fn) => fn());
}

// key -> playing note bookkeeping shared by the MIDI device and the computer keyboard
// pitchOffset(): semitones added to every note (Output Global Transpose / Cents Offset)
function notePlayer(getTarget, pitchOffset = () => 0) {
  const playing = new Map(); // key -> { id, inst }
  const player = ++players;
  const keys = new Set(); // keys held on this input (with or without a module playing them)
  const release = (key) => { keys.delete(key); setHeld(`${player}:${key}`, null); };
  const noteOff = (key) => {
    release(key);
    const n = playing.get(key);
    if (!n) return;
    playing.delete(key);
    n.inst.noteOff?.(n.id);
  };
  const noteOn = (key, velocity, pitch = key, time) => {
    noteOff(key); // the same key again without a note-off: release the old note first
    keys.add(key);
    setHeld(`${player}:${key}`, pitch);
    const t = getTarget();
    if (!t?.def.acceptsMidi || t.def.liveMidi === false) return false;
    const id = newNoteId();
    playing.set(key, { id, inst: t.inst });
    t.inst.noteOn?.(id, pitch + pitchOffset(), velocity, 0, time);
    return true;
  };
  const releaseAll = () => { [...playing.keys()].forEach(noteOff); [...keys].forEach(release); };
  const allOff = () => {
    [...keys].forEach(release);
    const insts = new Set([...playing.values()].map((n) => n.inst));
    playing.clear();
    const t = getTarget();
    if (t?.def.acceptsMidi) insts.add(t.inst);
    insts.forEach((i) => i.allOff?.());
  };
  return { noteOn, noteOff, releaseAll, allOff, playing };
}

// Computer keyboard as a piano, by physical key position (e.code, so it works on any layout):
// Q W E R T Y U I O P are the white keys C4..E5, the number row above them the black keys
// (2 3 . 5 6 7 . 9 0). Ignored while typing in a field, with Ctrl / Cmd / Alt held, or when
// an earlier handler already used the key (e.g. Shift + Q = quantize in the focused piano roll).
export const KEYBOARD_BASE = 60;
export const KEYBOARD_KEYS = {
  KeyQ: 0, Digit2: 1, KeyW: 2, Digit3: 3, KeyE: 4, KeyR: 5, Digit5: 6, KeyT: 7, Digit6: 8, KeyY: 9,
  Digit7: 10, KeyU: 11, KeyI: 12, Digit9: 13, KeyO: 14, Digit0: 15, KeyP: 16,
};
const KEYBOARD_VEL = 0.8;
const TYPING = 'input, select, textarea, dialog, [contenteditable]:not([contenteditable="false"])';

export function initKeyboard({ getTarget, onActivity, onNoTarget, pitchOffset }) {
  const player = notePlayer(getTarget, pitchOffset);
  window.addEventListener('keydown', (e) => {
    const semi = KEYBOARD_KEYS[e.code];
    if (semi === undefined || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (e.target?.closest?.(TYPING)) return;
    e.preventDefault();
    if (e.repeat) return; // held key: one note, no retrigger
    onActivity?.();
    if (!player.noteOn(e.code, KEYBOARD_VEL, KEYBOARD_BASE + semi, e.timeStamp / 1000)) onNoTarget?.();
  });
  window.addEventListener('keyup', (e) => player.noteOff(e.code));
  // a key released while the window is not focused never sends keyup
  window.addEventListener('blur', () => player.releaseAll());
  return { releaseAll: player.releaseAll, playing: player.playing };
}

// Linux (ALSA) always has a "Midi Through Port-0" that echoes whatever other software sends to
// it; with every port open, those echoes double (and retrigger) notes. Auto skips such ports.
export const isThru = (name = '') => /\bthrough\b|\bthru\b/i.test(name);
export const MIDI_AUTO = 'auto';

// MIDI devices. `selected`: MIDI_AUTO (every input except Through ports) or the name of one
// input; select(name) changes it (onSelect(name) lets the caller remember it).
// onNoTarget(): a note arrived but no module can play it.
export function initMidi({ getTarget, onStatus, onActivity, onNoTarget, onSelect, onNote, pitchOffset, selected = MIDI_AUTO }) {
  const player = notePlayer(getTarget, pitchOffset);
  const { noteOn, noteOff, allOff } = player;
  const releaseAll = () => { player.releaseAll(); onNote?.({ type: 'allOff' }); };
  const hooked = new WeakSet();
  const inputIds = new WeakMap();
  let nextInput = 0;
  const send = (fn, ...a) => {
    onActivity?.();
    const ok = ({ noteOn, noteOff, allOff })[fn](...a);
    if (fn === 'noteOn' && !ok) onNoTarget?.();
  };

  const nameOf = (input) => input.name || input.id;
  const used = (input) => (selected === MIDI_AUTO ? !isThru(nameOf(input)) : nameOf(input) === selected);

  const onMessage = (input, e) => {
    const [status, d1, d2 = 0] = e.data;
    const cmd = status & 0xf0;
    const prefix = `${inputIds.get(input)}:${status & 0x0f}:`;
    const event = { key: `${prefix}${d1}`, time: e.timeStamp / 1000 };
    if (cmd === 0x90 && d2 > 0) onNote?.({ ...event, type: 'on', pitch: d1, velocity: d2 / 127 });
    else if (cmd === 0x80 || cmd === 0x90) onNote?.({ ...event, type: 'off' });
    else if (cmd === 0xb0 && (d1 === 120 || d1 === 123)) onNote?.({ ...event, type: 'allOff', prefix });
    if (cmd === 0x90 && d2 > 0) send('noteOn', d1, d2 / 127, d1, e.timeStamp / 1000);
    else if (cmd === 0x80 || cmd === 0x90) send('noteOff', d1);
    else if (cmd === 0xb0 && (d1 === 120 || d1 === 123)) send('allOff');
  };

  // connected inputs: [{ name, used, thru }]
  const list = () => {
    const out = [];
    access?.inputs.forEach((input) => {
      if (input.state === 'connected') out.push({ name: nameOf(input), used: used(input), thru: isThru(nameOf(input)) });
    });
    return out;
  };

  const hookInputs = (event) => {
    if (event?.port?.type === 'input' && event.port.state === 'disconnected' && used(event.port)) releaseAll();
    access.inputs.forEach((input) => {
      if (hooked.has(input)) return;
      hooked.add(input);
      inputIds.set(input, ++nextInput);
      input.addEventListener('midimessage', (e) => { if (used(input)) onMessage(input, e); });
      input.open?.().catch(() => {});
    });
    const all = list();
    const on = all.filter((i) => i.used).map((i) => i.name);
    const off = all.filter((i) => !i.used).map((i) => i.name);
    const ignored = off.length ? ` (ignored: ${off.join(', ')})` : '';
    if (!all.length) onStatus('MIDI enabled, but no input devices found. Plug in a controller.');
    else if (on.length) onStatus(`MIDI: ${on.join(', ')}${ignored}`);
    else if (selected === MIDI_AUTO) onStatus(`MIDI: only Through ports found${ignored}. Plug in a controller or pick an input in Preferences → MIDI.`);
    else onStatus(`MIDI input "${selected}" is not connected${ignored}. Pick another one in Preferences → MIDI.`);
  };

  function select(name) {
    selected = name || MIDI_AUTO;
    releaseAll(); // notes held on the old input would never get their note-off
    onSelect?.(selected);
    if (access) hookInputs();
  }

  // Firefox only shows its permission prompt when it detects a MIDI device; it scans for
  // devices at browser start. Without one, or after an earlier "Block", it silently rejects the
  // request after a random 3..13 s delay (an anti-fingerprinting measure).
  let pending = null;
  function enable() {
    pending ??= request().finally(() => (pending = null));
    return pending;
  }

  async function request() {
    if (access) { hookInputs(); return true; }
    if (!navigator.requestMIDIAccess) {
      onStatus('Web MIDI not supported in this browser.');
      return false;
    }
    if (!window.isSecureContext) {
      onStatus('Web MIDI needs a secure context: open via http://localhost or https://');
      return false;
    }
    onStatus('Asking for MIDI access… (allow it in the browser prompt)');
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
      access.addEventListener('statechange', hookInputs);
      hookInputs();
      return true;
    } catch (err) {
      access = null;
      onStatus(err.name === 'SecurityError'
        // Firefox rejects like this without a prompt
        ? 'MIDI denied by Firefox without a prompt: it sees no MIDI device (plug in the controller, then restart Firefox completely) or access was blocked earlier (click the icon left of the address bar and clear the MIDI permission). Then open Preferences → MIDI → Re-scan MIDI Inputs.'
        : `MIDI blocked (${err.name}: ${err.message}). Open Preferences → MIDI → Re-scan MIDI Inputs to retry and allow access.`);
      return false;
    }
  }

  return { enable, select, inputs: list, selected: () => selected };
}
