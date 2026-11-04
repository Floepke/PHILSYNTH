// Fixed per-note delays on the audio clock. Modulation and release keep the note's delay,
// so even notes shorter than their delay play with their original duration.
import { newNoteId } from './modmidi.js';
import { MidiQueue } from './midiqueue.js';

export function createMidiScheduler(ctx, dsp, getTargets) {
  let clock = 0;
  const queue = new MidiQueue();
  const expiries = new MidiQueue();
  const notes = new Map();
  const records = new Set();
  const pending = new Set();
  const now = () => Math.max(ctx?.currentTime ?? 0, clock);
  const expire = (note, due) => {
    expiries.remove(note.expiry);
    note.expiry = expiries.push({ note, due });
  };
  const dispatch = ({ note, type, args, due }) => {
    if (note.cancelled) return;
    if (type === 'noteOn') {
      note.started = true;
      if (!note.closed || note.released) pending.delete(note);
    }
    if (type === 'noteOff') {
      note.released = true;
      pending.delete(note);
      expire(note, due + 6);
    }
    for (const target of note.targets) target[type](note.id, ...args);
  };
  const tick = (time) => {
    clock = time;
    const at = now();
    while (queue.first && queue.first.due <= at + 1e-9) {
      dispatch(queue.pop());
    }
    while (expiries.first && at >= expiries.first.due) {
      const { note } = expiries.pop();
      records.delete(note);
      if (notes.get(note.inId) === note) notes.delete(note.inId);
    }
  };
  const enqueue = (note, type, args, at = now()) => {
    if (note.cancelled) return;
    if (note.delay === null) { note.waiting.push({ type, args, at }); return; }
    const due = at + note.delay;
    if (note.released) expire(note, Math.max(note.expiry.due, due + 6));
    queue.push({ note, type, args, due });
  };
  const cancel = (note) => {
    note.cancelled = true;
    if (note.started && !note.released) for (const target of note.targets) target.noteOff(note.id);
    note.waiting = [];
    records.delete(note);
    pending.delete(note);
    expiries.remove(note.expiry);
  };
  const api = {
    now,
    get hasPending() { return pending.size > 0; },
    noteOn(inId, pitch, velocity, phase = 0, delay = 0, time) {
      const old = notes.get(inId);
      if (old) cancel(old);
      const note = {
        inId, id: newNoteId(), pitch, velocity, phase, time, arrival: now(),
        targets: [...getTargets()], delay: null, waiting: [], started: false,
        closed: false, released: false, cancelled: false, expiry: null,
      };
      notes.set(inId, note);
      records.add(note);
      pending.add(note);
      if (delay !== null) api.schedule(note, delay);
      return note;
    },
    schedule(note, delay) {
      if (note.cancelled || note.delay !== null) return;
      note.delay = delay;
      const time = Number.isFinite(note.time) ? note.time + delay : note.arrival + delay;
      enqueue(note, 'noteOn', [note.pitch, note.velocity, note.phase, time], note.arrival);
      for (const event of note.waiting) enqueue(note, event.type, event.args, event.at);
      note.waiting = [];
      tick(now());
    },
    noteMod(inId, pitch, velocity) {
      const note = notes.get(inId);
      if (!note) return;
      enqueue(note, 'noteMod', [pitch, velocity]);
      tick(now());
    },
    noteOff(inId) {
      const note = notes.get(inId);
      if (!note || note.closed) return;
      note.closed = true;
      if (!note.released) pending.add(note);
      enqueue(note, 'noteOff', []);
      tick(now());
    },
    allOff() {
      queue.clear();
      for (const note of records) cancel(note);
      notes.clear();
      expiries.clear();
      pending.clear();
    },
    releaseTarget(target) {
      for (const note of records) {
        const i = note.targets.indexOf(target);
        if (i < 0) continue;
        note.targets.splice(i, 1);
        if (note.started && !note.released) target.noteOff(note.id);
      }
    },
    destroy() { api.allOff(); stopClock(); },
  };
  const stopClock = dsp.onClock(tick);
  return api;
}
