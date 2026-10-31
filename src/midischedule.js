// Fixed per-note delays on the audio clock. Modulation and release keep the note's delay,
// so even notes shorter than their delay play with their original duration.
import { newNoteId } from './modmidi.js';

export function createMidiScheduler(ctx, dsp, getTargets) {
  let clock = 0;
  let queue = [];
  const notes = new Map();
  const records = new Set();
  const now = () => Math.max(ctx?.currentTime ?? 0, clock);
  const dispatch = ({ note, type, args, due }) => {
    if (note.cancelled) return;
    if (type === 'noteOn') note.started = true;
    if (type === 'noteOff') { note.released = true; note.expires = due + 6; }
    for (const target of note.targets) target[type](note.id, ...args);
  };
  const tick = (time) => {
    clock = time;
    const at = now();
    let count = 0;
    while (count < queue.length && queue[count].due <= at + 1e-9) {
      const event = queue[count++];
      dispatch(event);
    }
    if (count) queue.splice(0, count);
    for (const note of records) if (note.cancelled || (note.released && at >= note.expires)) {
      records.delete(note);
      if (notes.get(note.inId) === note) notes.delete(note.inId);
    }
  };
  const enqueue = (note, type, args, at = now()) => {
    if (note.cancelled) return;
    if (note.delay === null) { note.waiting.push({ type, args, at }); return; }
    const due = at + note.delay;
    if (note.released) note.expires = Math.max(note.expires, due + 6);
    let lo = 0, hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (queue[mid].due <= due) lo = mid + 1; else hi = mid;
    }
    queue.splice(lo, 0, { note, type, args, due });
  };
  const cancel = (note) => {
    note.cancelled = true;
    if (note.started && !note.released) for (const target of note.targets) target.noteOff(note.id);
    note.waiting = [];
    records.delete(note);
  };
  const api = {
    now,
    get hasPending() { return [...records].some(n => !n.cancelled && (!n.started || n.closed && !n.released)); },
    noteOn(inId, pitch, velocity, phase = 0, delay = 0, time) {
      const old = notes.get(inId);
      if (old) cancel(old);
      const note = {
        inId, id: newNoteId(), pitch, velocity, phase, time, arrival: now(),
        targets: [...getTargets()], delay: null, waiting: [], started: false,
        closed: false, released: false, cancelled: false, expires: Infinity,
      };
      notes.set(inId, note);
      records.add(note);
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
      enqueue(note, 'noteOff', []);
      tick(now());
    },
    allOff() {
      queue = [];
      for (const note of records) cancel(note);
      notes.clear();
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
