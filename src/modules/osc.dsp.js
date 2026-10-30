// Polyphonic oscillator DSP kernel (see src/dsp/kernel.js). Runs on the audio thread.
// Plays MODMIDI notes (see src/modmidi.js): each voice belongs to one note id and has its own
// float pitch and velocity. noteMod changes them while the note sounds; the voice glides to the
// new values (one-pole smoothing per block + a linear ramp inside the block), so no clicks.
import { WAVES, shape, isNoise, noiseSample, noiseState, xorshift } from './oscshape.js';
import { Kernel } from '../dsp/kernel.js';

const MAX_VOICES = 32;
const SMOOTH_S = 0.006;

// Start phase of a note (MODMIDI phase, 0..1 of the waveform cycle): wrapped into [0, 1); missing or
// invalid -> 0 (every note starts at the beginning of the cycle, as before phase existed).
export const startPhase = (phase) => (Number.isFinite(phase) ? phase - Math.floor(phase) : 0);

export default class OscKernel extends Kernel {
  // seed: noise generator start (random by default, so every OSC / Patch instance has its own noise)
  constructor({ seed } = {}) {
    super();
    this.rng = (seed ?? Math.random() * 2 ** 32) >>> 0 || 0x9e3779b9; // xorshift32, shared by the voices
    this.poly = 8;
    this.p = { wave: WAVES.SAW, attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.4, gain: 0.5, duty: 50 };
    this.duty = 0.5; // smoothed duty (0..1), ramps per block so LFO modulation doesn't zipper
    this.clock = 0;
    this.voices = Array.from({ length: MAX_VOICES }, () => ({
      stage: 0, // 0 idle, 1 attack, 2 decay, 3 sustain, 4 release
      id: 0, phase: 0, inc: 0, level: 0, relStep: 0, age: 0,
      pitch: 0, vel: 0, // current (smoothed) values
      pitchT: 0, velT: 0, // targets from noteOn / noteMod
      noise: noiseState(),
    }));
  }

  param(id, value) {
    if (id === 'polyphony') {
      this.poly = Math.max(1, Math.min(MAX_VOICES, value | 0));
      for (let i = this.poly; i < MAX_VOICES; i++) this.voices[i].stage = 0;
    } else this.p[id] = value;
  }

  message(m) {
    if (m.type === 'param') this.param(m.id, m.value);
    else if (m.type === 'noteOn') this.noteOn(m.id, m.pitch, m.velocity, m.phase);
    else if (m.type === 'noteMod') for (const [id, pitch, vel] of m.notes) this.noteMod(id, pitch, vel);
    else if (m.type === 'noteOff') this.noteOff(m.id);
    else if (m.type === 'allOff') this.voices.forEach((v) => (v.stage = 0));
  }

  voiceOf(id) {
    for (let i = 0; i < this.poly; i++) if (this.voices[i].stage && this.voices[i].id === id) return this.voices[i];
    return null;
  }

  noteOn(id, pitch, velocity, phase) {
    // retrigger the same note, else a free voice, else steal the oldest
    let v = this.voiceOf(id);
    if (!v) for (let i = 0; i < this.poly; i++) if (!this.voices[i].stage) { v = this.voices[i]; break; }
    if (!v) {
      v = this.voices[0];
      for (let i = 1; i < this.poly; i++) if (this.voices[i].age < v.age) v = this.voices[i];
    }
    v.id = id;
    v.pitch = v.pitchT = pitch; // a new note starts directly at its values, no glide
    v.vel = v.velT = velocity;
    v.inc = this.incOf(pitch);
    v.phase = startPhase(phase);
    v.level = 0;
    v.noise = noiseState();
    v.stage = 1;
    v.age = ++this.clock;
  }

  incOf(pitch) {
    return Math.min(0.45, (440 * Math.pow(2, (pitch - 69) / 12)) / sampleRate);
  }

  noteMod(id, pitch, velocity) {
    const v = this.voiceOf(id);
    if (v) { v.pitchT = pitch; v.velT = velocity; }
  }

  noteOff(id) {
    const v = this.voiceOf(id);
    if (v && v.stage !== 4) {
      v.stage = 4;
      v.relStep = v.level / (Math.max(this.p.release, 0.001) * sampleRate);
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const buf = out[0];
    buf.fill(0);
    const p = this.p;
    const atkStep = 1 / (Math.max(p.attack, 0.001) * sampleRate);
    const decStep = (1 - p.sustain) / (Math.max(p.decay, 0.001) * sampleRate);
    const wave = p.wave | 0;
    const noise = isNoise(wave);
    const k = 1 - Math.exp(-n / (SMOOTH_S * sampleRate)); // per-block smoothing coefficient
    const dutyT = Math.min(1, Math.max(0, (p.duty ?? 50) / 100));
    const duty0 = this.duty;
    this.duty = Math.abs(dutyT - duty0) < 1e-5 ? dutyT : duty0 + (dutyT - duty0) * k;
    const dutyStep = (this.duty - duty0) / n;

    let active = 0;
    for (let vi = 0; vi < this.poly; vi++) {
      const v = this.voices[vi];
      if (!v.stage) continue;
      active++;
      // glide pitch/velocity toward their targets, ramping linearly through this block
      let incStep = 0;
      let vel = v.vel;
      let velStep = 0;
      if (v.pitch !== v.pitchT) {
        v.pitch = Math.abs(v.pitchT - v.pitch) < 1e-5 ? v.pitchT : v.pitch + (v.pitchT - v.pitch) * k;
        incStep = (this.incOf(v.pitch) - v.inc) / n;
      }
      if (v.vel !== v.velT) {
        v.vel = Math.abs(v.velT - v.vel) < 1e-6 ? v.velT : v.vel + (v.velT - v.vel) * k;
        velStep = (v.vel - vel) / n;
      }
      for (let i = 0; i < n; i++) {
        switch (v.stage) {
          case 1: v.level += atkStep; if (v.level >= 1) { v.level = 1; v.stage = 2; } break;
          case 2: v.level -= decStep; if (v.level <= p.sustain) { v.level = p.sustain; v.stage = 3; } break;
          case 3: v.level = p.sustain; break;
          case 4: v.level -= v.relStep; if (v.level <= 0) { v.level = 0; v.stage = 0; } break;
        }
        if (!v.stage) break;
        v.inc += incStep;
        vel += velStep;
        let y;
        if (noise) {
          this.rng = xorshift(this.rng);
          y = noiseSample(wave, (this.rng / 4294967296) * 2 - 1, v.noise);
        } else y = shape(wave, v.phase, duty0 + dutyStep * i, v.inc);
        buf[i] += y * v.level * vel;
        v.phase += v.inc;
        if (v.phase >= 1) v.phase -= 1;
      }
    }

    const g = p.gain * 0.5;
    for (let i = 0; i < n; i++) buf[i] *= g;
    for (let c = 1; c < out.length; c++) out[c].set(buf);
    return active > 0;
  }
}

OscKernel.shape = shape; // for tests
