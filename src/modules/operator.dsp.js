// Monophonic phase-modulation operator. Reuse OSC's note ids, fractional pitch, phase and release
// handling without changing OSC. Polyphony belongs to complete networks in Patch Instances.
import OscKernel from './osc.dsp.js';
import { ATTACK_KMAX, FALL_KMAX, CURVE_EPS, curveK } from './adsrcurve.js';

const OS = 4;
const TAPS = 65;
const TAU = 2 * Math.PI;
const SMOOTH_S = 0.006;

// Hamming-windowed sinc: cutoff 0.45 of the host sample rate; eight host samples of delay.
function lowpass() {
  const h = new Float64Array(TAPS);
  const fc = 0.45 / OS;
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const x = i - (TAPS - 1) / 2;
    h[i] = (x ? Math.sin(TAU * fc * x) / (Math.PI * x) : 2 * fc)
      * (0.54 - 0.46 * Math.cos(TAU * i / (TAPS - 1)));
    sum += h[i];
  }
  for (let i = 0; i < TAPS; i++) h[i] /= sum;
  return h;
}
const FILTER = lowpass();

function stage(seconds, amount, kmax) {
  const inc = 1 / (Math.max(seconds, 0.001) * sampleRate * OS);
  const k = curveK(amount, kmax);
  if (Math.abs(k) < CURVE_EPS) return { inc, k: 0, m: 1, norm: 1 };
  return { inc, k, m: Math.exp(-k * inc), norm: 1 / (1 - Math.exp(-k)) };
}

export default class OperatorKernel extends OscKernel {
  constructor() {
    super();
    this.poly = 1;
    Object.assign(this.p, {
      attack: 0.001, decay: 0.001, sustain: 1, release: 0.001,
      atkCurve: 100, decCurve: 100, relCurve: 100,
      modulation: 100, feedback: 0, velocity: 100, gain: 0.5,
    });
    this.s = { modulation: 1, feedback: 0, velocity: 1, gain: 0.5 };
    this.history = new Float64Array(TAPS);
    this.pos = 0;
    this.prevInput = 0;
    this.feedbackSample = 0;
    this.tail = 0;
  }

  noteOn(id, pitch, velocity, phase) {
    super.noteOn(id, pitch, velocity, phase);
    this.feedbackSample = 0;
  }

  panic() {
    super.panic();
    this.history.fill(0);
    this.pos = this.tail = 0;
    this.prevInput = this.feedbackSample = 0;
  }

  message(m) {
    if (m.type === 'allOff') this.panic();
    else super.message(m);
  }

  process(inputs, outputs) {
    const out = outputs[0], buf = out[0], n = buf.length;
    const v = this.voices[0], p = this.p;
    const left = inputs[0]?.[0], right = inputs[0]?.[1] ?? left;
    const k = 1 - Math.exp(-n / (SMOOTH_S * sampleRate));
    const s0 = { ...this.s };
    const targets = { modulation: p.modulation / 100, feedback: p.feedback / 100, velocity: p.velocity / 100, gain: p.gain };
    const idle = !v.stage && !this.tail;
    for (const key in targets) {
      this.s[key] = idle || Math.abs(targets[key] - s0[key]) < 1e-6
        ? targets[key] : s0[key] + (targets[key] - s0[key]) * k;
      if (idle) s0[key] = this.s[key];
    }
    if (idle) {
      buf.fill(0);
      this.prevInput = left ? (left[n - 1] + right[n - 1]) * 0.5 : 0;
      for (let c = 1; c < out.length; c++) out[c].fill(0);
      return false;
    }
    const A = stage(p.attack, p.atkCurve, ATTACK_KMAX);
    const D = stage(p.decay, p.decCurve, FALL_KMAX);
    const R = stage(p.release, p.relCurve, FALL_KMAX);
    const st = v.stage === 1 ? A : v.stage === 2 ? D : v.stage === 4 ? R : null;
    if (st) v.e = st.k ? Math.exp(-st.k * v.u) : 1;
    let inc = v.inc, vel = v.vel;
    if (v.pitch !== v.pitchT) v.pitch = Math.abs(v.pitchT - v.pitch) < 1e-5 ? v.pitchT : v.pitch + (v.pitchT - v.pitch) * k;
    if (v.vel !== v.velT) v.vel = Math.abs(v.velT - v.vel) < 1e-6 ? v.velT : v.vel + (v.velT - v.vel) * k;
    const incStep = (this.incOf(v.pitch) - inc) / (n * OS);
    const velStep = (v.vel - vel) / (n * OS);
    for (let i = 0; i < n; i++) {
      const input = left ? (left[i] + right[i]) * 0.5 : 0;
      for (let j = 0; j < OS; j++) {
        const u = (i * OS + j + 1) / (n * OS);
        const amount = s0.modulation + (this.s.modulation - s0.modulation) * u;
        const feedback = s0.feedback + (this.s.feedback - s0.feedback) * u;
        const sensitivity = s0.velocity + (this.s.velocity - s0.velocity) * u;
        const gain = s0.gain + (this.s.gain - s0.gain) * u;
        const mod = this.prevInput + (input - this.prevInput) * ((j + 1) / OS);
        let y = 0;
        if (v.stage) {
          switch (v.stage) {
            case 1:
              v.u += A.inc;
              if (v.u >= 1) { v.level = 1; v.stage = 2; v.u = 0; v.e = 1; }
              else { v.e *= A.m; v.level = A.k ? (1 - v.e) * A.norm : v.u; }
              break;
            case 2:
              v.u += D.inc;
              if (v.u >= 1) { v.level = p.sustain; v.stage = 3; }
              else { v.e *= D.m; v.level = 1 + (p.sustain - 1) * (D.k ? (1 - v.e) * D.norm : v.u); }
              break;
            case 3: v.level = p.sustain; break;
            case 4:
              v.u += R.inc;
              if (v.u >= 1) { v.level = 0; v.stage = 0; }
              else { v.e *= R.m; v.level = v.l0 * (1 - (R.k ? (1 - v.e) * R.norm : v.u)); }
              break;
          }
          inc += incStep;
          vel += velStep;
          const wave = Math.sin(TAU * (v.phase + mod * amount + this.feedbackSample * feedback));
          this.feedbackSample = wave;
          y = wave * v.level * (1 - sensitivity * (1 - vel)) * gain;
          v.phase += inc / OS;
          if (v.phase >= 1) v.phase -= 1;
          this.tail = TAPS;
        } else if (this.tail) this.tail--;
        this.history[this.pos] = y;
        this.pos = (this.pos + 1) % TAPS;
      }
      this.prevInput = input;
      let sum = 0;
      for (let t = 0; t < TAPS; t++) sum += FILTER[t] * this.history[(this.pos - 1 - t + TAPS) % TAPS];
      buf[i] = sum;
    }
    v.inc = inc;
    for (let c = 1; c < out.length; c++) out[c].set(buf);
    return true;
  }
}
