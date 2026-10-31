// SAMPLER: one sample spread over the whole MIDI range (root key C4 = MIDI 60 plays it at its
// original speed and pitch; every semitone up plays it 2^(1/12) faster). Transpose and Finetune
// tune the sample to the notes; the ADSR shapes each note. Selection Start / Selection Length set
// the playback region (also what the sample editor below the controllers shows selected, and what
// Backspace cuts out of the sample); Playhead Mode plays it Forward, Reverse, Ping Pong, or
// loops it (Forward Loop / Reverse Loop).
// Load Sample (below the controllers) reads WAV and anything the browser decodes; the
// audio is kept in the sample pool (src/samples.js) and saved with the project.
import { linkDecayRelease } from './envlink.js';
import { INTERP_NAMES } from './interp.js';
import { createSampleView } from './sampleview.js';
import { PLAY_MODES } from './sampler.dsp.js';
import { getSample, onSample } from '../samples.js';

const percent = (v) => `${v.toFixed(2)} %`;
const signed = (v, unit) => `${v > 0 ? '+' : ''}${+v.toFixed(2)} ${unit}`;

export const sampleState = (s) => ({ sampleId: typeof s?.sampleId === 'string' ? s.sampleId : null, name: String(s?.name ?? '') });

// Keeps a kernel fed with the sample its state names (also when the sample reaches the pool later).
export function sampleFeeder(send) {
  let id = null;
  let unsub = null;
  const push = () => {
    unsub?.();
    unsub = null;
    const s = getSample(id);
    send(s);
    if (!s && id) unsub = onSample((got) => { if (got === id) push(); });
  };
  return {
    set(newId, force = false) { if (force || newId !== id) { id = newId; push(); } },
    destroy() { unsub?.(); unsub = null; },
  };
}

// MODMIDI note messages for a poly kernel (as osc.js: noteMod updates of one tick go in one message)
export function noteMessages(send) {
  let mods = null;
  const flushMods = () => {
    if (!mods) return;
    send({ type: 'noteMod', notes: [...mods.values()] });
    mods = null;
  };
  return {
    noteOn: (id, pitch, velocity, phase = 0) => { flushMods(); send({ type: 'noteOn', id, pitch, velocity, phase }); },
    noteMod(id, pitch, velocity) {
      if (!mods) { mods = new Map(); queueMicrotask(flushMods); }
      mods.set(id, [id, pitch, velocity]);
    },
    noteOff: (id) => { flushMods(); send({ type: 'noteOff', id }); },
    allOff: () => { mods = null; send({ type: 'allOff' }); },
  };
}

export default {
  type: 'SAMPLER',
  color: '#e3736b',
  label: 'Sampler (one sample)',
  acceptsMidi: true,
  hasInput: false,
  hasOutput: true,
  params: [
    { id: 'polyphony', label: 'Polyphony', min: 1, max: 32, default: 8, step: 1 },
    { id: 'attack', label: 'Attack (s)', min: 0.001, max: 10, default: 0.002, step: 0.001 },
    { id: 'decay', label: 'Decay (s)', min: 0.001, max: 10, default: 0.2, step: 0.001 },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 1, step: 0.01 },
    { id: 'release', label: 'Release (s)', min: 0.001, max: 10, default: 0.3, step: 0.001 },
    { id: 'gain', label: 'Gain', min: 0, max: 1, default: 0.5, step: 0.01 },
    { id: 'transpose', label: 'Transpose', min: -48, max: 48, default: 0, step: 1, format: (v) => signed(v, 'st') },
    { id: 'finetune', label: 'Finetune', min: -100, max: 100, default: 0, step: 1, format: (v) => signed(v, 'cent') },
    { id: 'interpolation', label: 'Interpolation', min: 0, max: 2, default: 2, step: 1, options: INTERP_NAMES },
    { id: 'selStart', label: 'Selection Start', min: 0, max: 100, default: 0, format: percent },
    { id: 'selLength', label: 'Selection Length', min: 0, max: 100, default: 100, format: percent },
    { id: 'playMode', label: 'Playhead Mode', min: 0, max: PLAY_MODES.length - 1, default: 0, step: 1, options: PLAY_MODES },
  ],
  linked: linkDecayRelease,
  defaultState: () => sampleState(null),
  normalizeState: sampleState,
  view: (entry, api) => createSampleView(entry, api),
  create(_ctx, _def, host) {
    const node = host.dsp.create('sampler'); // DSP: sampler.dsp.js
    const send = (m) => node.send(m);
    const feed = sampleFeeder((s) => send({ type: 'sample', rate: s?.rate ?? 0, channels: s?.channels ?? null }));
    return {
      node,
      input: null,
      setParam: (id, value) => send({ type: 'param', id, value }),
      setState: (st) => feed.set(st?.sampleId ?? null),
      ...noteMessages(send),
      destroy: () => { feed.destroy(); node.destroy(); },
    };
  },
};
