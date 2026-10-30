// MIDI input (Web MIDI). The computer keyboard does not play notes; its keys are app shortcuts.
// Incoming MIDI is translated to MODMIDI (see modmidi.js): every key press becomes a note with
// its own id, sent to the current target. The note-off goes to the module that got the note-on,
// even when another module was selected in between.
import { newNoteId } from './modmidi.js';

let access = null; // keep a strong reference, otherwise the browser may GC it and stop delivering messages

export function initMidi({ getTarget, onStatus, onActivity }) {
  const playing = new Map(); // MIDI key -> { id, inst }
  const noteOff = (key) => {
    const n = playing.get(key);
    if (!n) return;
    playing.delete(key);
    n.inst.noteOff?.(n.id);
  };
  const noteOn = (key, velocity) => {
    noteOff(key); // the same key again without a note-off: release the old note first
    const t = getTarget();
    if (!t?.def.acceptsMidi) return;
    const id = newNoteId();
    playing.set(key, { id, inst: t.inst });
    t.inst.noteOn?.(id, key, velocity);
  };
  const allOff = () => {
    const insts = new Set([...playing.values()].map((n) => n.inst));
    playing.clear();
    const t = getTarget();
    if (t?.def.acceptsMidi) insts.add(t.inst);
    insts.forEach((i) => i.allOff?.());
  };
  const send = (fn, ...a) => {
    onActivity?.();
    ({ noteOn, noteOff, allOff })[fn](...a);
  };

  const onMessage = (e) => {
    const [status, d1, d2 = 0] = e.data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && d2 > 0) send('noteOn', d1, d2 / 127);
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
