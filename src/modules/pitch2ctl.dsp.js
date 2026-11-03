// PITCH2CTL kernel: the pitch of the newest note, placed in the key range Low Key..High Key, is
// its modulator value (Low Key -> 0 = Out Min, High Key -> 1 = Out Max; see pitch2ctl.js).
// Pitches are floats (cents count), notes outside the range clamp to its ends, and Low Key above
// High Key flips the mapping. Its pitch curve (noteMod, e.g. a glide) follows while it is the
// newest note. Noteoff Action, Smooth and the "null until the first note" rule are VELOCITY2CTL's.
import Velocity2CtlKernel from './velocity2ctl.dsp.js';

export const KEY_MAX = 127;
const key = (v) => Math.max(0, Math.min(KEY_MAX, Math.round(Number(v) || 0)));

// 0..1 of `pitch` in the range low..high (either order); low === high: a switch at that key
export function pitchPos(pitch, low, high) {
  if (low === high) return pitch >= low ? 1 : 0;
  return Math.max(0, Math.min(1, (pitch - low) / (high - low)));
}

export default class Pitch2CtlKernel extends Velocity2CtlKernel {
  constructor() {
    super();
    this.lowKey = 21; // A0 .. C8: the 88-key piano (the controllers' defaults)
    this.highKey = 108;
    this.pitch = null; // newest note's pitch (kept after it ends while the value is held)
  }

  map() { return pitchPos(this.pitch, this.lowKey, this.highKey); }

  param(id, v) {
    if (id === 'lowKey' || id === 'highKey') {
      this[id] = key(v);
      // a held value (sounding note, or Do Nothing after it) follows the new range
      if (this.pitch !== null && (this.lastId !== null || this.noteOffAction === 0)) this.set(this.map());
    } else super.param(id, v);
  }

  message(m) {
    switch (m.type) {
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
