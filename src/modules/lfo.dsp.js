// LFO kernel (see src/dsp/kernel.js), control rate: steps once per render quantum on the audio
// clock (keeps running in background tabs). Its unipolar value (0..1) is mapped by the engine
// graph onto the controllers its cables point to.
// Off pauses advancement and controller output, and bypasses audio, retaining phase and Random targets.
// MIDI still resets phase.
// Frequency Unit MIDI Pitch (MIDI_UNIT): the rate is the frequency of the newest held note (its pitch
// curve included, via noteMod); Frequency is ignored. When that note ends the previous held one
// takes over; with none held the last pitch keeps running. Before the first note it stands still.
// Being control rate, notes above ~half the block rate (sampleRate / 256, ~187 Hz) alias.
// Phase (0..1): where in its cycle the wave starts. Applied when the kernel is created (project
// load / new module), on panic, and on every noteOn: there the note's MODMIDI phase (e.g. from a
// MULTIMIDI's Phase / Random Phase) is added to it. Turning it while running does not jump.
// Audio modes: the graph renders it in audio order and its
// output is that sound times the wave, mapped like a controller: Amplitude around the middle, then
// onto Out Min..Out Max (in %, 0..100 = silent..unchanged). The wave is computed per sample here,
// so with Frequency Unit MIDI Pitch it runs at the note frequency (audio-rate amplitude modulation).
// Square and Saw edges ramp over EDGE_S (at most a quarter / half cycle) so slow ones do not click.
import { Kernel } from '../dsp/kernel.js';

const BEATS_PER_UNIT = [0, 1, 0.5, 0.25];
export const MIDI_UNIT = 4;
const wrap = (p) => p - Math.floor(p); // into [0, 1)
const EDGE_S = 0.001; // tremolo: length of a Square / Saw edge
export const pitchHz = (pitch) => 440 * 2 ** ((pitch - 69) / 12);
// Synced cycle lengths, in units (e.g. 4 × 1/4 = one bar of 4/4).
const PERIODS = [64, 48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1.5, 1, 3 / 4, 2 / 3, 1 / 2, 1 / 3, 1 / 4];

// the Frequency values that pick each period exactly (ascending), see freqSnaps in lfo.js
export const SYNCED_FREQS = PERIODS.map((p) => 1 / p);

export function syncedPeriod(freq) {
  const want = Math.log(1 / freq);
  return PERIODS.reduce((best, p) => (Math.abs(Math.log(p) - want) < Math.abs(Math.log(best) - want) ? p : best));
}

// Frequency + Frequency Unit (0 = Hz, MIDI_UNIT = `pitch` (MIDI note number, null = no note yet: 0 Hz),
// else cycles per note value synced to `bpm`) -> Hz
export function lfoRateHz(freq, unit, bpm, pitch = null) {
  if (!unit) return freq;
  if (unit === MIDI_UNIT) return pitch === null ? 0 : pitchHz(pitch);
  return bpm / (60 * BEATS_PER_UNIT[unit] * syncedPeriod(freq));
}

// gain of the tremolo for wave value x (0..1): the position the graph would give a controller
export const tremoloGain = (x, amp, outMin, outMax) => (outMin + (outMax - outMin) * (0.5 + (x - 0.5) * (amp / 100))) / 100;

export default class LfoKernel extends Kernel {
  static modulator = true;
  static audioThrough = true; // Mode selects controller or audio processing (see graph.js)
  static meter = true;

  constructor() {
    super();
    this.freq = 1;
    this.unit = 0;
    this.bpm = 120;
    this.rate = 1; // Hz
    this.enabled = true;
    this.mode = 0;
    this.held = new Map(); // MIDI Pitch: id -> pitch of the held notes, oldest first
    this.pitch = null; // MIDI Pitch: the pitch followed (null until the first note)
    this.wave = 0;
    this.phase = 0;
    this.startPhase = 0; // the Phase controller
    this.ran = false; // until the first block, a Phase setting moves the wave there
    this.amp = 100; // tremolo mapping (the graph maps the same controllers for control cables)
    this.outMin = 0;
    this.outMax = 100;
    // Random uses smoothstep ramps; linear and stepped variants share its targets.
    this.from = 0.5;
    this.to = Math.random();
    this.value = this.at();
    this.meter = 0;
  }

  param(id, v) {
    if (id === 'enabled') {
      this.enabled = v >= 0.5;
      this.value = this.enabled ? this.at() : null;
    }
    else if (id === 'mode') this.mode = Math.max(0, Math.min(2, Math.round(v)));
    else if (id === 'freq' || id === 'unit') {
      this[id] = id === 'unit' ? v | 0 : v;
      this.updateRate();
    } else if (id === 'wave') {
      v |= 0;
      if ((v === 4 || v === 5 || v === 6) && this.wave !== v) this.from = this.to = this.at(); // continue from where the wave is
      this.wave = v;
    } else if (id === 'amp' || id === 'outMin' || id === 'outMax') {
      this[id] = Number(v) || 0;
    } else if (id === 'phase') {
      this.startPhase = wrap(Number(v) || 0);
      if (!this.ran) this.restart(0);
    }
  }

  // jump to Phase + `offset` (cycles)
  restart(offset) {
    this.phase = wrap(this.startPhase + (Number(offset) || 0));
    this.value = this.enabled ? this.at() : null;
  }

  panic() { this.restart(0); }

  message(m) {
    if (m.type === 'param') this.param(m.id, m.value);
    else if (m.type === 'bpm') { this.bpm = m.value; this.updateRate(); }
    else if (m.type === 'reset') this.restart(0);
    else if (m.type === 'noteOn') {
      this.held.delete(m.id);
      this.held.set(m.id, Number(m.pitch) || 0);
      this.follow();
      this.restart(m.phase);
    }
    else if (m.type === 'noteMod') {
      for (const [id, pitch] of m.notes) if (this.held.has(id)) this.held.set(id, Number(pitch) || 0);
      this.follow();
    } else if (m.type === 'noteOff') { this.held.delete(m.id); this.follow(); }
    else if (m.type === 'allOff') this.held.clear();
  }

  // MIDI Pitch: follow the newest held note (none held: keep the last pitch)
  follow() {
    let last = null;
    for (const p of this.held.values()) last = p;
    if (last === null || last === this.pitch) return;
    this.pitch = last;
    this.updateRate();
  }

  updateRate() {
    this.rate = lfoRateHz(this.freq, this.unit, this.bpm, this.pitch);
  }

  at() {
    const ph = this.phase;
    switch (this.wave) {
      case 1: return ph < 0.5 ? ph * 2 : 2 - ph * 2; // triangle
      case 2: return ph; // saw (ramp up)
      case 3: return ph < 0.5 ? 1 : 0; // square
      case 4: { const k = ph * ph * (3 - 2 * ph); return this.from + (this.to - this.from) * k; } // random smooth ramps
      case 5: return this.to; // random sample-and-hold
      case 6: return this.from + (this.to - this.from) * ph; // random linear ramps
      default: return 0.5 - 0.5 * Math.cos(2 * Math.PI * ph); // sine, starts at the bottom
    }
  }

  // the wave for audio: like at(), with the Square / Saw jumps ramped over `w` cycles
  smoothAt(w) {
    const ph = this.phase;
    if (w > 0 && this.wave === 3) {
      // signed distance (in cycles) to the nearest edge: + inside the high half
      const d = ph < 0.5 ? Math.min(ph, 0.5 - ph) : -Math.min(ph - 0.5, 1 - ph);
      return Math.min(1, Math.max(0, 0.5 + d / w));
    }
    if (w > 0 && this.wave === 2) {
      const u = ph < 0.5 ? ph : ph - 1; // around the wrap at 0
      if (Math.abs(u) < w / 2) return 1 - w / 2 + ((u + w / 2) / w) * (w - 1);
    }
    return this.at();
  }

  // advances `n` samples; a new Random target every cycle
  advance(n) {
    if (!this.enabled) return;
    this.phase += (this.rate * n) / sampleRate;
    if (this.phase >= 1) {
      this.from = this.to;
      this.to = Math.random();
    }
    this.phase -= Math.floor(this.phase);
  }

  process(inputs, outputs) {
    const n = outputs[0]?.[0]?.length ?? 128;
    this.ran = true;
    const wave = this.at();
    this.value = this.enabled ? wave : null;
    this.meter = tremoloGain(wave, this.amp, this.outMin, this.outMax) * 100;
    const i = inputs[0];
    if (!this.mode || !i || !i.length) {
      this.advance(n);
      return false;
    }
    const [L, R] = outputs[0];
    const iL = i[0];
    const iR = i[1] ?? iL;
    if (!this.enabled) {
      L.set(iL);
      R.set(iR);
      return true;
    }
    // tremoloGain, per sample: lo + span * x
    const depth = this.amp / 100;
    const span = ((this.outMax - this.outMin) / 100) * depth;
    const lo = this.outMin / 100 + ((this.outMax - this.outMin) / 100) * 0.5 * (1 - depth);
    const w = Math.min(this.wave === 3 ? 0.25 : 0.5, EDGE_S * this.rate);
    for (let j = 0; j < n; j++) {
      const g = lo + span * this.smoothAt(w);
      if (this.mode === 2) {
        const pan = Math.max(0, Math.min(1, g));
        L[j] = iL[j] * Math.min(1, 2 * (1 - pan));
        R[j] = iR[j] * Math.min(1, 2 * pan);
      } else {
        L[j] = iL[j] * g;
        R[j] = iR[j] * g;
      }
      this.advance(1);
    }
    return true;
  }
}
