// Polyphonic voice handling + ADSR shared by the SAMPLER and WAVETABLE kernels (audio thread).
// Same behaviour as OscKernel (osc.dsp.js): MODMIDI notes (src/modmidi.js) with their own float
// pitch and velocity, noteMod glides to new values (one-pole per block, linear ramp inside the
// block), retrigger by note id, else a free voice, else the oldest voice is stolen.
import { Kernel } from '../dsp/kernel.js';

export const MAX_VOICES = 32;
const SMOOTH_S = 0.006;

export class PolyKernel extends Kernel {
  constructor(params) {
    super();
    this.poly = 8;
    this.p = { attack: 0.005, decay: 0.2, sustain: 1, release: 0.3, gain: 0.5, ...params };
    this.clock = 0;
    this.voices = Array.from({ length: MAX_VOICES }, () => ({
      stage: 0, // 0 idle, 1 attack, 2 decay, 3 sustain, 4 release
      id: 0, level: 0, relStep: 0, age: 0,
      pitch: 0, vel: 0, pitchT: 0, velT: 0,
      pos: 0, step: 0, // playback position + increment (meaning depends on the kernel)
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

  panic() { for (const v of this.voices) { v.stage = 0; v.level = 0; } }

  voiceOf(id) {
    for (let i = 0; i < this.poly; i++) if (this.voices[i].stage && this.voices[i].id === id) return this.voices[i];
    return null;
  }

  // start(v, phase) sets the kernel's own voice fields
  noteOn(id, pitch, velocity, phase) {
    let v = this.voiceOf(id);
    if (!v) for (let i = 0; i < this.poly; i++) if (!this.voices[i].stage) { v = this.voices[i]; break; }
    if (!v) {
      v = this.voices[0];
      for (let i = 1; i < this.poly; i++) if (this.voices[i].age < v.age) v = this.voices[i];
    }
    v.id = id;
    v.pitch = v.pitchT = pitch;
    v.vel = v.velT = velocity;
    v.level = 0;
    v.stage = 1;
    v.age = ++this.clock;
    this.start(v, phase);
  }

  start(_v, _phase) {}

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

  // per block: envelope increments + the glide coefficient
  blockEnv(n) {
    const p = this.p;
    return {
      atk: 1 / (Math.max(p.attack, 0.001) * sampleRate),
      dec: (1 - p.sustain) / (Math.max(p.decay, 0.001) * sampleRate),
      sus: p.sustain,
      k: 1 - Math.exp(-n / (SMOOTH_S * sampleRate)),
    };
  }

  // glide pitch/velocity toward their targets; returns the per-sample velocity step of this block
  glide(v, k, n) {
    if (v.pitch !== v.pitchT) v.pitch = Math.abs(v.pitchT - v.pitch) < 1e-5 ? v.pitchT : v.pitch + (v.pitchT - v.pitch) * k;
    const vel = v.vel;
    if (v.vel !== v.velT) v.vel = Math.abs(v.velT - v.vel) < 1e-6 ? v.velT : v.vel + (v.velT - v.vel) * k;
    return (v.vel - vel) / n;
  }
}

// One envelope sample: advances v.stage / v.level; v.stage is 0 once the release has ended.
export function envTick(v, e) {
  switch (v.stage) {
    case 1: v.level += e.atk; if (v.level >= 1) { v.level = 1; v.stage = 2; } break;
    case 2: v.level -= e.dec; if (v.level <= e.sus) { v.level = e.sus; v.stage = 3; } break;
    case 3: v.level = e.sus; break;
    case 4: v.level -= v.relStep; if (v.level <= 0) { v.level = 0; v.stage = 0; } break;
  }
  return v.level;
}
