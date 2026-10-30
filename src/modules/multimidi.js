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
import { newNoteId } from '../modmidi.js';

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

export default {
  type: 'MULTIMIDI',
  color: '#b54a52',
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
  ],
  create(_ctx, _def, host, { rand = Math.random } = {}) {
    // no DSP: its controllers live here; the node only receives modulation (LFO -> Transpose ...)
    const ctl = host.dsp.create('none');

    const v = { transpose: 0, finetune: 0, drift: 0, driftFreq: 1, velDrift: 0, velDriftFreq: 1, randomPhase: 0 };
    // incoming note id -> { id (outgoing), pitch, vel (incoming), pd, vd (drifters), out: [pitch, vel] sent, off (time released) }
    const notes = new Map();
    const sentTo = new Map(); // outgoing id -> targets that got the noteOn
    let lastTime = null;

    const outOf = (n) => [
      n.pitch + v.transpose + v.finetune + v.drift * n.pd.value,
      Math.max(0, n.vel * (1 - v.velDrift * n.vd.value)),
    ];
    const update = (n) => {
      const out = outOf(n);
      if (Math.abs(out[0] - n.out[0]) < 1e-4 && Math.abs(out[1] - n.out[1]) < 1e-4) return;
      n.out = out;
      for (const t of sentTo.get(n.id) ?? []) t.noteMod(n.id, out[0], out[1]);
    };
    const tick = (time) => {
      const dt = lastTime === null ? 0 : Math.min(0.1, time - lastTime);
      lastTime = time;
      for (const [inId, n] of notes) {
        if (n.off && time - n.off > RELEASE_KEEP_S) { notes.delete(inId); sentTo.delete(n.id); continue; }
        n.pd.step(dt, v.driftFreq);
        n.vd.step(dt, v.velDriftFreq);
        update(n);
      }
    };

    const inst = {
      node: null,
      input: null,
      ctl,
      getMidiTargets: () => [], // set by the patch: instances this module is MIDI-cabled to
      setParam(id, val) {
        v[id] = val; // pitch/velocity changes reach the notes on the next clock tick
        ctl.param(id, val);
      },
      onModulated(id, val) { v[id] = val; },
      noteOn(inId, pitch, vel, phase = 0) {
        inst.noteOff(inId); // same id again: release the old copy first
        const n = { id: newNoteId(), pitch, vel, pd: new Drifter(true, rand), vd: new Drifter(false, rand), off: 0 };
        const amount = Math.min(1, Math.max(0, v.randomPhase));
        n.phase = wrapPhase((Number.isFinite(phase) ? phase : 0) + (amount ? rand() * amount : 0));
        n.out = outOf(n);
        notes.set(inId, n);
        const targets = [...inst.getMidiTargets()];
        sentTo.set(n.id, targets);
        for (const t of targets) t.noteOn(n.id, n.out[0], n.out[1], n.phase);
      },
      noteMod(inId, pitch, vel) {
        const n = notes.get(inId);
        if (!n) return;
        n.pitch = pitch;
        n.vel = vel;
        update(n);
      },
      noteOff(inId) {
        const n = notes.get(inId);
        if (!n || n.off) return;
        n.off = lastTime ?? 0;
        for (const t of sentTo.get(n.id) ?? []) t.noteOff(n.id);
      },
      allOff() {
        notes.clear();
        sentTo.clear();
        for (const t of inst.getMidiTargets()) t.allOff();
      },
      // a MIDI cable to `t` was removed: release the notes it got from us
      releaseTarget(t) {
        for (const [id, targets] of sentTo) {
          const i = targets.indexOf(t);
          if (i < 0) continue;
          targets.splice(i, 1);
          t.noteOff(id);
        }
      },
      destroy() {
        for (const t of inst.getMidiTargets()) inst.releaseTarget(t);
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
