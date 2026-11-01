// Live note input: MIDI devices (Web MIDI, initMidi) and the computer keyboard (initKeyboard).
// Notes are translated to MODMIDI (see modmidi.js): every key press becomes a note with its own
// id, sent to the current target. The note-off goes to the module that got the note-on, even
// when another module was selected in between.
import { newNoteId } from './modmidi.js';

let access = null; // keep a strong reference, otherwise the browser may GC it and stop delivering messages

// key -> playing note bookkeeping shared by the MIDI device and the computer keyboard
// pitchOffset(): semitones added to every note (Output Global Transpose / Cents Offset)
function notePlayer(getTarget, pitchOffset = () => 0) {
  const playing = new Map(); // key -> { id, inst }
  const noteOff = (key) => {
    const n = playing.get(key);
    if (!n) return;
    playing.delete(key);
    n.inst.noteOff?.(n.id);
  };
  const noteOn = (key, velocity, pitch = key, time) => {
    noteOff(key); // the same key again without a note-off: release the old note first
    const t = getTarget();
    if (!t?.def.acceptsMidi || t.def.liveMidi === false) return false;
    const id = newNoteId();
    playing.set(key, { id, inst: t.inst });
    t.inst.noteOn?.(id, pitch + pitchOffset(), velocity, 0, time);
    return true;
  };
  const releaseAll = () => [...playing.keys()].forEach(noteOff);
  const allOff = () => {
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
// an earlier handler already used the key (e.g. Q = quantize in the focused piano roll).
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

export function initMidi({ getTarget, onStatus, onActivity, pitchOffset }) {
  const { noteOn, noteOff, allOff } = notePlayer(getTarget, pitchOffset);
  const send = (fn, ...a) => {
    onActivity?.();
    ({ noteOn, noteOff, allOff })[fn](...a);
  };

  const onMessage = (e) => {
    const [status, d1, d2 = 0] = e.data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && d2 > 0) send('noteOn', d1, d2 / 127, d1, e.timeStamp / 1000);
    else if (cmd === 0x80 || cmd === 0x90) send('noteOff', d1);
    else if (cmd === 0xb0 && (d1 === 120 || d1 === 123)) send('allOff');
  };

  const hookInputs = () => {
    const names = [];
    access.inputs.forEach((input) => {
      if (!input._modsynth) {
        input.addEventListener('midimessage', onMessage);
        input._modsynth = true;
        input.open?.().catch(() => {});
      }
      if (input.state === 'connected') names.push(input.name || input.id);
    });
    onStatus(names.length
      ? `MIDI: ${names.join(', ')}`
      : 'MIDI enabled, but no input devices found. Plug in a controller.');
  };

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
        ? 'MIDI denied by Firefox without a prompt: it sees no MIDI device (plug in the controller, then restart Firefox completely) or access was blocked earlier (click the icon left of the address bar and clear the MIDI permission). Then click "MIDI".'
        : `MIDI blocked (${err.name}: ${err.message}). Click "MIDI" to retry and allow access.`);
      return false;
    }
  }

  return { enable };
}
