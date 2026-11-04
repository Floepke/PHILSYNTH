// Audio and MODMIDI share the LEFT DELAY time; RIGHT DELAY only affects audio.
// MIDI events sample the current delay on arrival. Queued events retain their due time.
import { newNoteId } from '../modmidi.js';
import { MidiQueue } from '../midiqueue.js';
import { delayParam, delayUnitParam, delaySeconds } from './delaytime.js';

export default {
  type: 'DELAY',
  color: '#6389bf',
  label: 'Delay (audio / MIDI)',
  acceptsMidi: true,
  midiOut: true,
  audioMidi: true,
  hasInput: true,
  hasOutput: true,
  params: [
    delayUnitParam(),
    delayParam('left', 'Left Delay'),
    delayParam('right', 'Right Delay'),
  ],
  create(ctx, _def, host) {
    const node = host.dsp.create('delay');
    const values = { left: 250, right: 250, unit: 0 };
    let bpm = 120;
    let clock = 0;
    const queue = new MidiQueue();
    const expiries = new MidiQueue();
    let pending = 0;
    const notes = new Map();
    const records = new Set();
    const now = () => Math.max(ctx?.currentTime ?? 0, clock);
    const expire = (note) => {
      expiries.remove(note.expiry);
      if (note.pending) return;
      if (note.cancelled) {
        records.delete(note);
        if (notes.get(note.inId) === note) notes.delete(note.inId);
      } else if (note.released) note.expiry = expiries.push({ note, due: note.expires });
    };

    const dispatch = ({ note, type, args, due }) => {
      if (note.cancelled) return;
      if (type === 'noteOn') note.started = true;
      else if (type === 'noteOff') {
        note.released = true;
        note.expires = due + 6;
        // A shortened delay can make noteOff overtake noteOn. Cancel that pending note
        // rather than leaving a voice stuck when its late noteOn would otherwise arrive.
        if (!note.started) {
          pending -= note.pending;
          note.cancelled = true;
          return;
        }
      } else if (!note.started) return;
      for (const t of note.targets) t[type](note.id, ...args);
    };
    const tick = (time) => {
      clock = time;
      const at = now();
      while (queue.first && queue.first.due <= at + 1e-9) {
        const event = queue.pop();
        event.note.pending--;
        if (!event.note.cancelled) pending--;
        dispatch(event);
        expire(event.note);
      }
      while (expiries.first && at >= expiries.first.due) {
        const { note: n } = expiries.pop();
        records.delete(n);
        if (notes.get(n.inId) === n) notes.delete(n.inId);
      }
    };
    const enqueue = (note, type, args = []) => {
      const due = now() + delaySeconds(values.left, values.unit, bpm);
      const event = { note, type, args, due };
      note.pending++;
      pending++;
      if (note.released) note.expires = Math.max(note.expires, due + 6);
      expiries.remove(note.expiry);
      queue.push(event);
      tick(now());
    };

    const inst = {
      node,
      input: node,
      get hasPendingMidi() { return pending > 0; },
      getMidiTargets: () => [],
      setParam(id, value) { values[id] = value; node.param(id, value); },
      onModulated(id, value) { values[id] = value; },
      setBpm(value) { bpm = value; node.send({ type: 'bpm', value }); },
      noteOn(inId, pitch, velocity, phase = 0, time) {
        inst.noteOff(inId);
        const note = {
          inId, id: newNoteId(), targets: [...inst.getMidiTargets()],
          started: false, closed: false, released: false, cancelled: false, pending: 0, expires: Infinity, expiry: null,
        };
        notes.set(inId, note);
        records.add(note);
        const onset = Number.isFinite(time) ? time + delaySeconds(values.left, values.unit, bpm) : now() + delaySeconds(values.left, values.unit, bpm);
        enqueue(note, 'noteOn', [pitch, velocity, phase, onset]);
      },
      noteMod(inId, pitch, velocity) {
        const note = notes.get(inId);
        if (note && !note.cancelled) enqueue(note, 'noteMod', [pitch, velocity]);
      },
      noteOff(inId) {
        const note = notes.get(inId);
        if (!note || note.closed || note.cancelled) return;
        note.closed = true;
        enqueue(note, 'noteOff');
      },
      allOff() {
        queue.clear();
        expiries.clear();
        pending = 0;
        notes.clear();
        for (const n of records) if (n.started && !n.released) for (const t of n.targets) t.noteOff(n.id);
        records.clear();
      },
      releaseTarget(target) {
        for (const n of records) {
          const i = n.targets.indexOf(target);
          if (i < 0) continue;
          n.targets.splice(i, 1);
          if (n.started && !n.released) target.noteOff(n.id);
        }
      },
      destroy() { inst.allOff(); stopClock(); node.destroy(); },
    };
    const stopClock = host.dsp.onClock(tick);
    return inst;
  },
};
