// CTL2NOTE: one controller-generated MODMIDI note. Pitch/velocity update without retriggering;
// Phase is captured only at note-on. Modulated controllers settle together at the audio clock.
import { pctNum } from '../params.js';
import { newNoteId } from '../modmidi.js';
import { noteName } from '../song.js';
import { phaseLabel } from './lfo.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export default {
  type: 'CTL2NOTE',
  color: '#b8784e',
  label: 'CTL2NOTE (controller -> note)',
  acceptsMidi: false,
  midiOut: true,
  hasInput: false,
  hasOutput: true,
  params: [
    { id: 'pitch', label: 'MIDI Pitch', min: 0, max: 127, default: 60, step: 1,
      normalize: (v) => clamp(Math.round(v), 0, 127), format: (v) => `${Math.round(v)} (${noteName(Math.round(v))})` },
    { id: 'noteState', label: 'Note State', min: 0, max: 1, default: 0, step: 1, options: ['Off', 'On'],
      normalize: (v) => clamp(Math.round(v), 0, 1) },
    { id: 'finetune', label: 'Finetune', min: -1, max: 1, default: 0, step: 0.01,
      normalize: (v) => clamp(v, -1, 1), format: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)} ct` },
    { id: 'velocity', label: 'Velocity', min: 0, max: 1, default: 0.8, step: 0.0001,
      normalize: (v) => clamp(v, 0, 1), format: (v) => `${pctNum(v * 100)} %` },
    { id: 'phase', label: 'Phase', min: 0, max: 1, default: 0, step: 0.0001,
      normalize: (v) => clamp(v, 0, 1), format: phaseLabel },
  ],
  create(ctx, def, host) {
    const ctl = host.dsp.create('none');
    const values = Object.fromEntries(def.params.map((p) => [p.id, p.default]));
    let note = null; // { id, pitch, velocity, phase, targets: Set }
    let silenced = false; // panic requires a fresh Off -> On transition

    const release = () => {
      if (!note) return;
      for (const target of note.targets) target.noteOff(note.id);
      note = null;
    };
    const update = (time = ctx?.currentTime) => {
      if (host.dsp.remoteNotes) return;
      if (!values.noteState || silenced) { release(); return; }
      const targets = new Set(inst.getMidiTargets());
      const pitch = values.pitch + values.finetune;
      const velocity = values.velocity;
      if (!note) {
        if (!targets.size) return; // loaded On notes start after their cables and values are restored
        note = { id: newNoteId(), pitch, velocity, phase: values.phase, targets: new Set() };
      }
      const changed = note.pitch !== pitch || note.velocity !== velocity;
      for (const target of note.targets) if (!targets.has(target)) {
        target.noteOff(note.id);
        note.targets.delete(target);
      }
      for (const target of targets) {
        if (!note.targets.has(target)) {
          note.targets.add(target);
          target.noteOn(note.id, pitch, velocity, note.phase, time);
        } else if (changed) target.noteMod(note.id, pitch, velocity);
      }
      note.pitch = pitch;
      note.velocity = velocity;
    };
    const set = (id, value) => {
      const p = def.params.find((p) => p.id === id);
      const next = p.normalize(value);
      if (id === 'noteState' && values.noteState !== next) silenced = false;
      values[id] = next;
    };
    const inst = {
      node: null, input: null, ctl,
      getMidiTargets: () => [],
      get hasPendingMidi() { return !!note?.targets.size; },
      setParam(id, value) {
        set(id, value);
        ctl.param(id, values[id]);
        update();
      },
      onModulated: set,
      allOff() { release(); silenced = true; },
      releaseTarget(target) {
        if (!note?.targets.delete(target)) return;
        target.noteOff(note.id);
      },
      destroy() { release(); stopClock(); ctl.destroy(); },
    };
    const stopClock = host.dsp.onClock(update);
    return inst;
  },
};
