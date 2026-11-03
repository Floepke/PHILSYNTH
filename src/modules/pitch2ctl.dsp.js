// PITCH2CTL kernel: the pitch of the newest note, looked up in the per-key map, is its modulator
// value (0 = Out Min .. 1 = Out Max; see pitch2ctl.js). The map holds one value per MIDI key
// (128); a pitch between two keys (cents, a glide) moves in a straight line from one key's value
// to the next. Its pitch curve (noteMod) follows while it is the newest note. Noteoff Action,
// Smooth and the "null until the first note" rule are VELOCITY2CTL's.
import Velocity2CtlKernel from './velocity2ctl.dsp.js';

export const KEY_MAX = 127;
export const KEYS = KEY_MAX + 1;
// default map: the 88-key piano A0 (21) .. C8 (108) in a straight line, below 0, above 1
const RAMP_LOW = 21;
const RAMP_HIGH = 108;

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const round = (v) => Math.round(clamp01(v) * 10000) / 10000; // keeps saved projects small

// a straight line from key `low` (0) to key `high` (1), flat outside it
export function rampMap(low = RAMP_LOW, high = RAMP_HIGH) {
  return Array.from({ length: KEYS }, (_, p) => round(low === high ? +(p >= low) : (p - low) / (high - low)));
}
export const defaultMap = () => rampMap();

// any saved / sent map -> 128 numbers 0..1 (missing keys: the default ramp)
export function normalizeMap(map) {
  const def = defaultMap();
  return def.map((d, p) => (Array.isArray(map) && Number.isFinite(map[p]) ? round(map[p]) : d));
}

// 0..1 of a (float) pitch: between two keys linear, outside 0..127 the end key's value
export function mapAt(map, pitch) {
  const p = Math.max(0, Math.min(KEY_MAX, Number(pitch) || 0));
  const i = Math.min(KEY_MAX - 1, Math.floor(p));
  const f = p - i;
  return map[i] + (map[i + 1] - map[i]) * f;
}

export default class Pitch2CtlKernel extends Velocity2CtlKernel {
  constructor() {
    super();
    this.keyMap = defaultMap();
    this.pitch = null; // newest note's pitch (kept after it ends while the value is held)
  }

  map() { return mapAt(this.keyMap, this.pitch); }

  message(m) {
    switch (m.type) {
      case 'map':
        this.keyMap = normalizeMap(m.map);
        // a held value (sounding note, or Do Nothing after it) follows the new map
        if (this.pitch !== null && (this.lastId !== null || this.noteOffAction === 0)) this.set(this.map());
        break;
      case 'noteOn':
        this.lastId = m.id;
        this.pitch = Number(m.pitch) || 0;
        this.set(this.map());
        break;
      case 'noteMod':
        for (const [id, pitch] of m.notes) {
          if (id !== this.lastId) continue;
          this.pitch = Number(pitch) || 0;
          this.set(this.map());
        }
        break;
      default: super.message(m);
    }
  }
}
