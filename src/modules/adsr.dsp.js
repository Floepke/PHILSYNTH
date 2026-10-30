// ADSR envelope kernel (see src/dsp/kernel.js), control rate: steps once per render quantum on
// the audio clock; its value (0..1) is mapped by the engine graph onto the controllers its cables
// point to. Segments are linear; a retrigger starts the attack from the current level, so it
// never jumps. Notes (noteOn/noteOff/allOff) arrive from the main-thread module (adsr.js).
//   trigger 0 = every note restarts the attack, 1 = legato (only when no other note is held)
//   velocity 0..100 % = how much the note velocity scales the envelope peak
import { Kernel } from '../dsp/kernel.js';

const IDLE = 0, ATTACK = 1, DECAY = 2, SUSTAIN = 3, RELEASE = 4;

export default class AdsrKernel extends Kernel {
  static modulator = true;

  constructor() {
    super();
    this.p = { attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.5 }; // sustain 0..1
    this.legato = false;
    this.velAmount = 0;
    this.held = new Set(); // note ids currently down
    this.stage = IDLE;
    this.level = 0;
    this.peak = 1;
    this.relFrom = 0;
    this.decFrom = 1;
    this.value = 0;
  }

  param(id, v) {
    if (id === 'trigger') this.legato = v >= 0.5;
    else if (id === 'velocity') this.velAmount = v / 100;
    else if (id === 'sustain') this.p.sustain = v / 100;
    else if (id === 'attack' || id === 'decay' || id === 'release') this.p[id] = v;
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

  gate(on, peak = 1) {
    if (on) { this.peak = peak; this.stage = ATTACK; }
    else if (this.stage !== IDLE) { this.stage = RELEASE; this.relFrom = this.level; }
  }

  toDecay() {
    this.stage = DECAY;
    this.decFrom = this.level;
  }

  // advance by `dt` seconds
  advance(dt) {
    const p = this.p;
    const sus = p.sustain * this.peak;
    switch (this.stage) {
      case ATTACK:
        if (this.level >= this.peak) { this.toDecay(); break; } // retriggered above a softer peak: glide down
        this.level += (this.peak * dt) / Math.max(p.attack, 1e-4);
        if (this.level >= this.peak) { this.level = this.peak; this.toDecay(); }
        break;
      case DECAY:
        this.level -= (Math.max(this.decFrom - sus, 1e-3) * dt) / Math.max(p.decay, 1e-4);
        if (this.level <= sus) { this.level = sus; this.stage = SUSTAIN; }
        break;
      case SUSTAIN:
        this.level = sus; // follows Sustain changes while held
        break;
      case RELEASE:
        this.level -= (Math.max(this.relFrom, 1e-6) * dt) / Math.max(p.release, 1e-4);
        if (this.level <= 0) { this.level = 0; this.stage = IDLE; }
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
