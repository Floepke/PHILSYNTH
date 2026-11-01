// MULTIMIDI: a MODMIDI processor (see src/modmidi.js). It receives notes (when selected, or
// through a MIDI cable from another MULTIMIDI) and sends them on through its MIDI cables
// (Shift+drag) to OSC / Patch / MULTIMIDI modules.
//
// Every note gets its own drift: two smooth random generators (pitch and velocity) per note, so
// a chord drifts apart like detuned analog voices. Transpose and Finetune are added to the
// note's float pitch; the result is sent as noteMod updates and the synth glides to it.
// Several MULTIMIDIs can feed one synth in parallel (each plays its own copy of the note);
// chained MULTIMIDIs add up.
//
// Random Phase: every note starts its waveform at its own random point of the cycle (MODMIDI
// phase, 0..1): 0 % passes the incoming phase on unchanged (OSC starts at the cycle's beginning),
// 100 % = anywhere in the cycle. The offset is drawn once per note and added to the incoming phase
// (so chained MULTIMIDIs add up here too).
// Velocity: overall level, scales every outgoing velocity (100 % = unchanged, 0 % = silent).
// Overtone: plays the note's n-th overtone, (n + 1) × the fundamental frequency (0 = fundamental).
// Random Delay: sample one 0..maximum delay per note, keeping that offset for its
// onset, modulation, and release so short notes retain their length.
import { createMidiScheduler } from '../midischedule.js';

const RELEASE_KEEP_S = 6; // released notes keep drifting through the synth's release tail

// Smooth random value: every 1/rate seconds a new random destination, reached along a cosine
// curve (no corners, never jumps). Starts at a random value so every note has its own offset;
// rate 0 holds the value.
export class Drifter {
  constructor(bipolar, rand = Math.random) {
    this.rand = () => (bipolar ? rand() * 2 - 1 : rand());
    this.value = this.from = this.rand();
    this.to = this.rand();
    this.t = 0;
  }

  step(seconds, rate) {
    if (rate <= 0 || seconds <= 0) return this.value;
    this.t += seconds * rate;
    if (this.t >= 1) {
      this.from = this.value;
      this.to = this.rand();
      this.t %= 1;
    }
    this.value = this.from + (this.to - this.from) * (0.5 - 0.5 * Math.cos(Math.PI * this.t));
    return this.value;
  }
}

const wrapPhase = (p) => p - Math.floor(p); // into [0, 1)
const st = (v) => `${v > 0 ? '+' : ''}${v} st`;
const cents = (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)} ct`;
const hz = (v) => (v ? `${v < 10 ? v.toFixed(2) : v.toFixed(1)} Hz` : 'Hold');

// Overtone n = harmonic n + 1: n + 1 times the fundamental's frequency (1 = octave, 2 = octave +
// fifth, 3 = two octaves ...), i.e. 12·log2(n + 1) semitones up. Whole numbers only (also when modulated).
export const overtoneOf = (v) => Math.min(128, Math.max(0, Math.round(+v || 0)));
export const overtoneSemitones = (v) => 12 * Math.log2(overtoneOf(v) + 1);
function overtoneLabel(v) {
  const n = overtoneOf(v);
  return n ? `${n} (×${n + 1}, +${overtoneSemitones(n).toFixed(2)} st)` : 'Fundamental';
}

export default {
  type: 'MULTIMIDI',
  color: '#b84d4e',
  label: 'MultiMIDI (pitch/velocity)',
  acceptsMidi: true,
  midiOut: true, // its cables carry MODMIDI notes, not audio
  hasInput: false,
  hasOutput: true,
  params: [
    { id: 'transpose', label: 'Transpose', min: -48, max: 48, default: 0, step: 1, format: st },
    { id: 'finetune', label: 'Finetune', min: -1, max: 1, default: 0, step: 0.01, format: cents },
    { id: 'drift', label: 'Drift', min: 0, max: 1, default: 0, step: 0.01, format: (v) => `±${Math.round(v * 100)} ct` },
    { id: 'driftFreq', label: 'Drift Freq', min: 0, max: 20, default: 1, step: 0.01, format: hz },
    { id: 'velDrift', label: 'Velocity Drift', min: 0, max: 1, default: 0, step: 0.01, format: (v) => `-${Math.round(v * 100)} %` },
    { id: 'velDriftFreq', label: 'Velocity Drift Freq', min: 0, max: 20, default: 1, step: 0.01, format: hz },
    { id: 'randomPhase', label: 'Random Phase', min: 0, max: 1, default: 0, step: 0.01, format: (v) => `${Math.round(v * 100)} %` },
    { id: 'randomDelay', label: 'Random Delay', min: 0, max: 5000, default: 0, step: 1, format: (v) => `${Math.round(v)} ms` },
    // appended last: Out Controller targets controllers by index, existing ones keep their number
    { id: 'velocity', label: 'Velocity', min: 0, max: 1, default: 1, step: 0.01, format: (v) => `${Math.round(v * 100)} %` },
    { id: 'overtone', label: 'Overtone', min: 0, max: 128, default: 0, step: 1, format: overtoneLabel },
  ],
  create(ctx, _def, host, { rand = Math.random } = {}) {
    // no DSP: its controllers live here; the node only receives modulation (LFO -> Transpose ...)
    const ctl = host.dsp.create('none');

    const v = { transpose: 0, finetune: 0, drift: 0, driftFreq: 1, velocity: 1, overtone: 0, velDrift: 0, velDriftFreq: 1, randomPhase: 0, randomDelay: 0 };
    // Incoming id -> per-note pitch/velocity drift, including its delayed release tail.
    const notes = new Map();
    const midi = createMidiScheduler(ctx, host.dsp, () => inst.getMidiTargets());
    let lastTime = null;

    const outOf = (n) => [
      n.pitch + v.transpose + v.finetune + overtoneSemitones(v.overtone) + v.drift * n.pd.value,
      Math.max(0, n.vel * Math.min(1, Math.max(0, v.velocity)) * (1 - v.velDrift * n.vd.value)),
    ];
    const update = (inId, n) => {
      const out = outOf(n);
      if (Math.abs(out[0] - n.out[0]) < 1e-4 && Math.abs(out[1] - n.out[1]) < 1e-4) return;
      n.out = out;
      midi.noteMod(inId, out[0], out[1]);
    };
    const tick = (time) => {
      const dt = lastTime === null ? 0 : Math.min(0.1, time - lastTime);
      lastTime = time;
      for (const [inId, n] of notes) {
        if (n.off !== null && time - n.off > RELEASE_KEEP_S + n.delay) { notes.delete(inId); continue; }
        n.pd.step(dt, v.driftFreq);
        n.vd.step(dt, v.velDriftFreq);
        update(inId, n);
      }
    };

    const inst = {
      node: null,
      input: null,
      ctl,
      get hasPendingMidi() { return midi.hasPending; },
      getMidiTargets: () => [], // set by the patch: instances this module is MIDI-cabled to
      setParam(id, val) {
        v[id] = val; // pitch/velocity changes reach the notes on the next clock tick
        ctl.param(id, val);
      },
      onModulated(id, val) { v[id] = val; },
      noteOn(inId, pitch, vel, phase = 0, time) {
        inst.noteOff(inId); // same id again: release the old copy first
        const n = { pitch, vel, pd: new Drifter(true, rand), vd: new Drifter(false, rand), off: null };
        const delay = Math.max(0, Math.min(5000, v.randomDelay));
        n.delay = delay ? rand() * delay / 1000 : 0;
        const amount = Math.min(1, Math.max(0, v.randomPhase));
        n.phase = wrapPhase((Number.isFinite(phase) ? phase : 0) + (amount ? rand() * amount : 0));
        n.out = outOf(n);
        notes.set(inId, n);
        midi.noteOn(inId, n.out[0], n.out[1], n.phase, n.delay, time);
      },
      noteMod(inId, pitch, vel) {
        const n = notes.get(inId);
        if (!n) return;
        n.pitch = pitch;
        n.vel = vel;
        update(inId, n);
      },
      noteOff(inId) {
        const n = notes.get(inId);
        if (!n || n.off !== null) return;
        n.off = midi.now();
        midi.noteOff(inId);
      },
      allOff() {
        notes.clear();
        midi.allOff();
      },
      // a MIDI cable to `t` was removed: release the notes it got from us
      releaseTarget: midi.releaseTarget,
      destroy() {
        midi.destroy();
        notes.clear();
        stopClock();
        ctl.destroy();
      },
    };
    // drift runs on the audio clock (keeps running in background tabs, unlike timers)
    const stopClock = host.dsp.onClock(tick);
    return inst;
  },
};
