// ADSR envelope kernel (see src/dsp/kernel.js), control rate: steps once per render quantum on
// the audio clock; its value (0..1) is mapped by the engine graph onto the controllers its cables
// point to. Each stage runs over its progress u = 0..1 (exact stage time) along the Attack/Decay/
// Release Curve (adsrcurve.js, the same shapes as the OSC envelope; 0 = linear). A retrigger starts
// the attack where the curve reaches the current level, so it never jumps. Notes (noteOn/noteOff/allOff) arrive from the main-thread module (adsr.js).
//   trigger 0 = every note restarts the attack, 1 = legato (only when no other note is held)
//   velocity 0..100 % = how much the note velocity scales the envelope peak
import { Kernel } from '../dsp/kernel.js';
import { ATTACK_KMAX, FALL_KMAX, curveK, curveAt, curveInv } from './adsrcurve.js';

const IDLE = 0, ATTACK = 1, DECAY = 2, SUSTAIN = 3, RELEASE = 4;

export default class AdsrKernel extends Kernel {
  static modulator = true;

  constructor() {
    super();
    this.p = { attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.5, atkCurve: 0, decCurve: 0, relCurve: 0 }; // sustain 0..1
    this.legato = false;
    this.velAmount = 0;
    this.held = new Set(); // note ids currently down
    this.stage = IDLE;
    this.level = 0;
    this.peak = 1;
    this.relFrom = 0;
    this.decFrom = 1;
    this.u = 0; // progress of the current stage
    this.value = 0;
  }

  param(id, v) {
    if (id === 'trigger') this.legato = v >= 0.5;
    else if (id === 'velocity') this.velAmount = v / 100;
    else if (id === 'sustain') this.p.sustain = v / 100;
    else if (id in this.p) this.p[id] = v;
  }

  message(m) {
    switch (m.type) {
      case 'param': this.param(m.id, m.value); break;
      case 'noteOn': {
        const first = this.held.size === 0;
        this.held.add(m.id);
        const vel = Math.max(0, Math.min(1, m.velocity));
        if (first || !this.legato) this.gate(true, 1 - this.velAmount * (1 - vel));
        break;
      }
      case 'noteOff':
        if (this.held.delete(m.id) && !this.held.size) this.gate(false);
        break;
      case 'allOff': // stop / panic: release (a hard reset would make the modulated controller jump)
        this.held.clear();
        this.gate(false);
        break;
      case 'gate': this.gate(m.on, m.peak); break;
      case 'reset': this.stage = IDLE; this.level = 0; break;
    }
  }

  // unlike allOff: a hard reset to 0 (the modulated controller may jump)
  panic() {
    this.held.clear();
    this.stage = IDLE;
    this.level = this.value = 0;
  }

  gate(on, peak = 1) {
    if (on) {
      this.peak = peak;
      this.stage = ATTACK;
      this.u = curveInv(this.level / peak, curveK(this.p.atkCurve, ATTACK_KMAX));
    } else if (this.stage !== IDLE) { this.stage = RELEASE; this.relFrom = this.level; this.u = 0; }
  }

  toDecay() {
    this.stage = DECAY;
    this.decFrom = this.level;
    this.u = 0;
  }

  // advance by `dt` seconds
  advance(dt) {
    const p = this.p;
    const sus = p.sustain * this.peak;
    switch (this.stage) {
      case ATTACK:
        if (this.level >= this.peak) { this.toDecay(); break; } // retriggered above a softer peak: glide down
        this.u += dt / Math.max(p.attack, 1e-4);
        if (this.u >= 1) { this.level = this.peak; this.toDecay(); }
        else this.level = this.peak * curveAt(this.u, curveK(p.atkCurve, ATTACK_KMAX));
        break;
      case DECAY:
        this.u += dt / Math.max(p.decay, 1e-4);
        if (this.u >= 1 || this.decFrom <= sus) { this.level = sus; this.stage = SUSTAIN; }
        else this.level = this.decFrom + (sus - this.decFrom) * curveAt(this.u, curveK(p.decCurve, FALL_KMAX));
        break;
      case SUSTAIN:
        this.level = sus; // follows Sustain changes while held
        break;
      case RELEASE:
        this.u += dt / Math.max(p.release, 1e-4);
        if (this.u >= 1) { this.level = 0; this.stage = IDLE; }
        else this.level = this.relFrom * (1 - curveAt(this.u, curveK(p.relCurve, FALL_KMAX)));
        break;
    }
  }

  process(_inputs, outputs) {
    const n = outputs[0]?.[0]?.length ?? 128;
    this.advance(n / sampleRate);
    this.value = this.level;
    return false;
  }
}
