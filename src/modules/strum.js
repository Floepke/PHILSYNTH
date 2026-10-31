import { createMidiScheduler } from '../midischedule.js';

export default {
  type: 'STRUM',
  color: '#c58148',
  label: 'Strum (MIDI chords)',
  acceptsMidi: true,
  midiOut: true,
  hasInput: false,
  hasOutput: true,
  params: [
    { id: 'strumType', label: 'Strum Type', min: 0, max: 2, default: 0, step: 1,
      options: ['strum upwards', 'strum downwards', 'strum random order'] },
    { id: 'duration', label: 'Strum Duration', min: 0, max: 5000, default: 100, step: 1, format: (v) => `${Math.round(v)} ms` },
    { id: 'humanize', label: 'Timing Humanize', min: 0, max: 1, default: 0, step: 0.01, format: (v) => `${Math.round(v * 100)} %` },
  ],
  create(ctx, _def, host, { rand = Math.random } = {}) {
    const ctl = host.dsp.create('none');
    const values = { strumType: 0, duration: 100, humanize: 0 };
    const midi = createMidiScheduler(ctx, host.dsp, () => inst.getMidiTargets());
    let batches = [];
    let queued = false;
    let destroyed = false;
    const flush = () => {
      queued = false;
      const pending = batches;
      batches = [];
      if (destroyed) return;
      for (const batch of pending) {
        const notes = batch.notes.filter((n) => !n.cancelled);
        notes.sort((a, b) => a.pitch - b.pitch);
        if (batch.type === 1) notes.reverse();
        else if (batch.type === 2) for (let i = notes.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [notes[i], notes[j]] = [notes[j], notes[i]];
        }
        const spacing = notes.length > 1 ? batch.duration / (notes.length - 1) : 0;
        notes.forEach((note, i) => {
          const jitter = i > 0 && i < notes.length - 1 ? (rand() * 2 - 1) * spacing * 0.45 * batch.humanize : 0;
          midi.schedule(note, i * spacing + jitter);
        });
      }
    };
    const inst = {
      node: null, input: null, ctl,
      get hasPendingMidi() { return batches.length > 0 || midi.hasPending; },
      getMidiTargets: () => [],
      setParam(id, value) { values[id] = value; ctl.param(id, value); },
      onModulated(id, value) { values[id] = value; },
      noteOn(id, pitch, velocity, phase = 0, time) {
        const onset = Number.isFinite(time) ? time : midi.now();
        let batch = batches.find((b) => Math.abs(b.time - onset) <= 1e-7);
        if (!batch) {
          batch = {
            time: onset, type: Math.round(values.strumType),
            duration: Math.max(0, Math.min(5000, values.duration)) / 1000,
            humanize: Math.max(0, Math.min(1, values.humanize)), notes: [],
          };
          batches.push(batch);
        }
        batch.notes.push(midi.noteOn(id, pitch, velocity, phase, null, onset));
        // All notes with the same sequencer onset are collected before ordering the chord.
        if (!queued) { queued = true; queueMicrotask(flush); }
      },
      noteMod: midi.noteMod,
      noteOff: midi.noteOff,
      allOff() { batches = []; midi.allOff(); },
      releaseTarget: midi.releaseTarget,
      destroy() { destroyed = true; batches = []; stopBatchClock(); midi.destroy(); ctl.destroy(); },
    };
    // Offline renders do not yield a microtask every block; their audio clock also flushes chords.
    const stopBatchClock = host.dsp.onClock(flush);
    return inst;
  },
};
