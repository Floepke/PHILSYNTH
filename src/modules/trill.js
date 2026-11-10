// TRILL: MIDI processor that plays the held notes one after another like a human trill. Two keys
// alternate; more keys follow ORDER (random never repeats the previous note). Separation and length
// are divisions of a whole note at the BPM of this patch level's Output (16 = 1/16, 12 = 1/8
// triplet). Onsets stay on a nominal grid (no drift); HUMANIZE adds per-note timing (up to ±40 % of
// the separation), length (±30 %) and velocity (±20 %) variation. Generated notes go out through its
// MIDI cables with their own ids; the trill runs on the audio clock (about every 5 ms).
import { newNoteId, captureMidiTrace, withMidiTrace } from '../modmidi.js';

export const ORDERS = ['random', 'up', 'down', 'up-down'];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const divisionSeconds = (div, bpm) => 240 / (bpm > 0 ? bpm : 120) / clamp(Math.round(div) || 1, 1, 100);
const cmp = (a, b) => a.pitch - b.pitch || a.seq - b.seq;

// next key after `last` in `order` (0 random, 1 up, 2 down, 3 up-down); state.dir keeps the
// up-down direction. `last` may already be released: it is compared by pitch.
export function nextKey(keys, last, order, state, rand = Math.random) {
  const list = [...keys].sort(cmp);
  if (list.length <= 1 || !last) return list[0] ?? null;
  if (order === 0) {
    let pool = list.filter((k) => k !== last && k.pitch !== last.pitch);
    if (!pool.length) pool = list.filter((k) => k !== last);
    return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  }
  const above = list.find((k) => cmp(k, last) > 0);
  const below = list.findLast((k) => cmp(k, last) < 0);
  if (order === 1) return above ?? list[0];
  if (order === 2) return below ?? list.at(-1);
  if (state.dir > 0 && above) return above;
  if (state.dir < 0 && below) return below;
  state.dir = -state.dir;
  return (state.dir > 0 ? above : below) ?? list[0];
}

export default {
  type: 'TRILL',
  color: '#b8607e',
  label: 'Trill (MIDI trills)',
  acceptsMidi: true,
  midiOut: true,
  hasInput: false,
  hasOutput: true,
  params: [
    { id: 'order', label: 'Order', min: 0, max: 3, default: 0, step: 1, options: ORDERS },
    { id: 'separation', label: 'Note Separation', min: 1, max: 100, default: 32, step: 1, format: (v) => `1/${Math.round(v)}` },
    { id: 'length', label: 'Note Length', min: 1, max: 100, default: 32, step: 1, format: (v) => `1/${Math.round(v)}` },
    { id: 'humanize', label: 'Humanize', min: 0, max: 1, default: 0.2, step: 0.01, format: (v) => `${Math.round(v * 100)} %` },
  ],
  create(ctx, _def, host, { rand = Math.random } = {}) {
    const ctl = host.dsp.create('none');
    const values = { order: 0, separation: 32, length: 32, humanize: 0.2 };
    let bpm = 120;
    let clock = 0;
    let seq = 0;
    const keys = new Map(); // incoming id -> { pitch, velocity, phase, seq }
    let sounding = []; // generated notes: { id, pitch, key, off, targets }
    let next = null; // { nominal, at, key? } upcoming onset
    let last = null;
    const order = { dir: 1 };
    let stopClock = null;
    const now = () => Math.max(ctx?.currentTime ?? 0, clock);
    const human = () => clamp(values.humanize, 0, 1) * (rand() * 2 - 1);

    const release = (n) => { for (const t of n.targets) t.noteOff(n.id); };
    const fire = (t) => {
      const key = next.key && keys.has(next.key.inId) ? next.key : nextKey(keys.values(), last, Math.round(values.order), order, rand);
      const sep = divisionSeconds(values.separation, bpm);
      const first = !last;
      if (key) {
        sounding = sounding.filter((n) => (n.pitch === key.pitch ? (release(n), false) : true));
        const id = newNoteId();
        const velocity = clamp(key.velocity * (1 + 0.2 * human()), 0.01, 1);
        const targets = [...inst.getMidiTargets()];
        const trace = key.trace;
        // Repeated notes share the incoming arrival, not a growing animation queue.
        key.trace = trace && { ...trace };
        withMidiTrace(trace, () => {
          for (const target of targets) target.noteOn(id, key.pitch, velocity, first ? key.phase : 0, t);
        });
        const len = divisionSeconds(values.length, bpm) * (1 + 0.3 * human());
        sounding.push({ id, pitch: key.pitch, key: key.inId, off: t + Math.max(0.001, len), targets });
        last = key;
      }
      const nominal = next.nominal + sep;
      next = { nominal, at: Math.max(t + 0.001, nominal + 0.4 * sep * human()) };
    };
    const tick = (time) => {
      if (Number.isFinite(time)) clock = time;
      const at = now();
      for (;;) {
        const due = next && keys.size && next.at <= at + 1e-9 ? next.at : Infinity;
        const off = sounding.reduce((m, n) => Math.min(m, n.off), Infinity);
        if (off === Infinity && due === Infinity) break;
        if (off <= at + 1e-9 && off <= due) {
          const i = sounding.findIndex((n) => n.off === off);
          release(sounding[i]);
          sounding.splice(i, 1);
        } else if (due !== Infinity) fire(due);
        else break;
      }
      if (!keys.size && !sounding.length && stopClock) { stopClock(); stopClock = null; }
    };
    const run = () => { if (!stopClock) stopClock = host.dsp.onClock(tick); };

    const inst = {
      node: null, input: null, ctl,
      get hasPendingMidi() { return keys.size > 0 || sounding.length > 0; },
      getMidiTargets: () => [],
      setParam(id, value) { values[id] = value; ctl.param(id, value); },
      onModulated(id, value) { values[id] = value; },
      setBpm(value) { bpm = Number(value) > 0 ? Number(value) : 120; },
      noteOn(inId, pitch, velocity, phase = 0, time) {
        const key = { inId, pitch, velocity, phase, seq: seq++, trace: captureMidiTrace() };
        keys.set(inId, key);
        if (!next) {
          const t0 = Number.isFinite(time) ? Math.min(time, now()) : now();
          last = null;
          order.dir = 1;
          next = { nominal: t0, at: t0, key };
        }
        run();
        tick();
      },
      noteMod(inId, pitch, velocity) {
        const key = keys.get(inId);
        if (!key) return;
        key.pitch = pitch;
        key.velocity = velocity;
        for (const n of sounding) if (n.key === inId) {
          n.pitch = pitch;
          for (const t of n.targets) t.noteMod(n.id, pitch, velocity);
        }
      },
      noteOff(inId) {
        if (!keys.delete(inId)) return;
        if (!keys.size) { next = null; last = null; }
        tick();
      },
      allOff() {
        for (const n of sounding) release(n);
        sounding = [];
        keys.clear();
        next = null;
        last = null;
        if (stopClock) { stopClock(); stopClock = null; }
      },
      releaseTarget(target) {
        for (const n of sounding) {
          const i = n.targets.indexOf(target);
          if (i < 0) continue;
          n.targets.splice(i, 1);
          target.noteOff(n.id);
        }
      },
      destroy() { inst.allOff(); ctl.destroy(); },
    };
    return inst;
  },
};
