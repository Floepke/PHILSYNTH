import { PolyKernel, curveEnv, curveStart, curveRelease, curveBlock, curveTick } from './poly.dsp.js';
import { startPhase } from './osc.dsp.js';
import { SPECTRA_ROOT_HZ, SPECTRA_ROOT_KEY, SPECTRA_TABLE_ROOT_HZ, SPECTRA_CYCLE_FADE_SECONDS } from './spectra.sample.js';

const SAMPLE_SWAP_SECONDS = 0.02;

function readSample(sample, pos, loopStart) {
  const i = Math.floor(pos);
  const next = i + 1 < sample.data.length ? i + 1 : loopStart;
  const t = pos - i;
  return sample.data[i] + (sample.data[next] - sample.data[i]) * t;
}

export default class SpectraKernel extends PolyKernel {
  static meter = true;

  constructor() {
    super({ attack: 0.003, decay: 0.003, sustain: 1, release: 0.02, atkCurve: 100, decCurve: 100, relCurve: 100, gain: 0.45 });
    this.poly = 8;
    this.sample = null;
    this.oldSample = null;
    this.nextSample = null;
    this.pendingSample = null;
    this.pendingSeconds = SAMPLE_SWAP_SECONDS;
    this.meter = 0;
    this.sampleBlend = 1;
    this.sampleBlendStep = 1;
  }

  message(m) {
    if (m.type !== 'sample' && m.type !== 'nextSample' && m.type !== 'phaseSample') return super.message(m);
    if (!(m.data instanceof Float32Array) || !m.data.length || !Number.isFinite(m.rate) || m.rate <= 0) {
      throw new TypeError('SPECTRA received an invalid sample');
    }
    if (m.type === 'phaseSample' && m.frame !== undefined && m.frame <= this.meter) return;
    const next = { data: m.data, rate: m.rate };
    if (m.type === 'nextSample') {
      const frame = m.frame ?? this.meter + 1;
      if (!Number.isInteger(frame) || frame <= 0 || frame > 0x7fffffff) throw new TypeError('SPECTRA received an invalid phase frame');
      next.frame = frame;
      this.nextSample = next;
      return;
    }
    this.nextSample = null;
    const seconds = m.type === 'phaseSample' ? this.cycleFade() : SAMPLE_SWAP_SECONDS;
    if (this.oldSample) { this.pendingSample = next; this.pendingSeconds = seconds; return; }
    this.applySample(next, seconds);
  }

  cycleFade() {
    let leader = null;
    for (let vi = 0; vi < this.poly; vi++) {
      const v = this.voices[vi];
      if (v.stage && (!leader || v.age < leader.age)) leader = v;
    }
    return this.sample && leader
      ? Math.min(SPECTRA_CYCLE_FADE_SECONDS, this.sample.data.length / (leader.step * sampleRate) / 4)
      : SAMPLE_SWAP_SECONDS;
  }

  applySample(next, seconds) {
    this.oldSample = this.sample;
    this.sample = next;
    for (const v of this.voices) {
      if (!v.stage) continue;
      v.oldPos = v.pos;
      v.pos %= next.data.length;
    }
    this.sampleBlend = this.oldSample ? 0 : 1;
    this.sampleBlendStep = 1 / Math.max(1, Math.round(seconds * sampleRate));
  }

  speedOf(pitch) {
    return (this.sample.rate / sampleRate) * (SPECTRA_ROOT_HZ / SPECTRA_TABLE_ROOT_HZ) * 2 ** ((pitch - SPECTRA_ROOT_KEY) / 12);
  }

  start(v, phase) {
    if (!this.sample) { v.stage = 0; return; }
    v.pos = startPhase(phase) * this.sample.data.length;
    v.oldPos = this.oldSample ? v.pos / this.sample.data.length * this.oldSample.data.length : 0;
    v.step = this.speedOf(v.pitch);
    curveStart(v);
  }

  noteOff(id) {
    const v = this.voiceOf(id);
    if (v && v.stage !== 4) curveRelease(v);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] && out[1] !== left ? out[1] : null;
    left.fill(0);
    right?.fill(0);
    if (!this.sample) return false;

    const n = left.length;
    const env = this.blockEnv(n);
    const curves = curveEnv(this.p);
    let active = 0;
    let leader = -1;
    for (let vi = 0; vi < this.poly; vi++) {
      const v = this.voices[vi];
      if (!v.stage) continue;
      active++;
      if (leader < 0 || v.age < this.voices[leader].age) leader = vi;
      curveBlock(v, curves);
      const targetStep = this.speedOf(v.pitch);
      v.velStart = v.vel;
      v.velStep = this.glide(v, env.k, n);
      v.stepStep = (targetStep - v.step) / n;
    }

    const loopStart = 0;
    for (let i = 0; i < n; i++) {
      if (this.oldSample) {
        this.sampleBlend = Math.min(1, this.sampleBlend + this.sampleBlendStep);
        if (this.sampleBlend === 1) {
          this.oldSample = null;
          if (this.pendingSample) {
            const next = this.pendingSample;
            this.pendingSample = null;
            this.applySample(next, this.pendingSeconds);
          }
        }
      }
      const blend = this.sampleBlend;
      let wrapped = false;
      for (let vi = 0; vi < this.poly; vi++) {
        const v = this.voices[vi];
        if (!v.stage) continue;
        const level = curveTick(v, curves);
        if (!v.stage) continue;

        const current = readSample(this.sample, v.pos, loopStart);
        const previous = this.oldSample ? readSample(this.oldSample, v.oldPos, loopStart) : current;
        const value = previous + (current - previous) * blend;
        const velocity = v.velStart + v.velStep * (i + 1);
        const sample = value * level * velocity * this.p.gain;
        left[i] += sample;
        if (right) right[i] += sample;

        v.step += v.stepStep;
        v.pos += v.step;
        if (this.oldSample) {
          v.oldPos = (v.oldPos + v.step * this.oldSample.rate / this.sample.rate) % this.oldSample.data.length;
        }
        if (v.pos >= this.sample.data.length) {
          v.pos %= this.sample.data.length;
          if (vi === leader) wrapped = true;
        }
      }
      if (wrapped && this.nextSample && !this.oldSample && !this.pendingSample) {
        const next = this.nextSample;
        this.nextSample = null;
        const duration = this.sample.data.length / (this.voices[leader].step * sampleRate);
        this.applySample(next, Math.min(SPECTRA_CYCLE_FADE_SECONDS, duration / 4));
        this.meter = next.frame;
      }
    }
    for (let c = right ? 2 : 1; c < out.length; c++) out[c].set(left);
    return active > 0;
  }
}
