// Polyphonic voice handling + ADSR shared by the SAMPLER and WAVETABLE kernels (audio thread).
// Same behaviour as OscKernel (osc.dsp.js): MODMIDI notes (src/modmidi.js) with their own float
// pitch and velocity, noteMod glides to new values (one-pole per block, linear ramp inside the
// block), retrigger by note id, else a free voice, else the oldest voice is stolen.
import { Kernel } from '../dsp/kernel.js';
import { ATTACK_KMAX, FALL_KMAX, CURVE_EPS, curveK } from './adsrcurve.js';

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

// ---- curved ADSR (Attack/Decay/Release Curve, the OSC envelope of osc.dsp.js, see adsrcurve.js) ----
// A voice keeps its stage progress u (0..1), e = e^(-k u) of the stage curve and l0 = the level
// where the release started. The kernel calls curveStart(v) on noteOn, curveRelease(v) on noteOff,
// curveBlock(v, env) once per block (the curve or time may have changed) and curveTick per sample.
function curveStage(seconds, amount, kmax) {
  const inc = 1 / (Math.max(seconds, 0.001) * sampleRate);
  const k = curveK(amount, kmax);
  if (Math.abs(k) < CURVE_EPS) return { inc, k: 0, m: 1, norm: 1 };
  return { inc, k, m: Math.exp(-k * inc), norm: 1 / (1 - Math.exp(-k)) };
}

export const curveEnv = (p) => ({
  A: curveStage(p.attack, p.atkCurve, ATTACK_KMAX),
  D: curveStage(p.decay, p.decCurve, FALL_KMAX),
  R: curveStage(p.release, p.relCurve, FALL_KMAX),
  sus: p.sustain,
});

export function curveStart(v) { v.level = 0; v.u = 0; v.e = 1; }

export function curveRelease(v) {
  v.stage = v.level > 0 ? 4 : 0;
  v.l0 = v.level;
  v.u = 0;
  v.e = 1;
}

export function curveBlock(v, E) {
  const st = v.stage === 1 ? E.A : v.stage === 2 ? E.D : v.stage === 4 ? E.R : null;
  if (st) v.e = st.k ? Math.exp(-st.k * v.u) : 1;
}

export function curveTick(v, E) {
  switch (v.stage) {
    case 1:
      v.u += E.A.inc;
      if (v.u >= 1) { v.level = 1; v.stage = 2; v.u = 0; v.e = 1; }
      else { v.e *= E.A.m; v.level = E.A.k ? (1 - v.e) * E.A.norm : v.u; }
      break;
    case 2:
      v.u += E.D.inc;
      if (v.u >= 1) { v.level = E.sus; v.stage = 3; }
      else { v.e *= E.D.m; v.level = 1 + (E.sus - 1) * (E.D.k ? (1 - v.e) * E.D.norm : v.u); }
      break;
    case 3: v.level = E.sus; break;
    case 4:
      v.u += E.R.inc;
      if (v.u >= 1) { v.level = 0; v.stage = 0; }
      else { v.e *= E.R.m; v.level = v.l0 * (1 - (E.R.k ? (1 - v.e) * E.R.norm : v.u)); }
      break;
  }
  return v.level;
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
