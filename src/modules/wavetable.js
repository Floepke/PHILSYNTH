// WAVETABLE: polyphonic wavetable synth (DSP: wavetable.dsp.js). The table is a row of
// single-cycle frames of Block Size samples; Wave Select scans through them, crossfading between
// neighbouring frames (sweep it with an LFO / ADSR for the typical wavetable movement).
// Block Size Auto uses the frame size stored in the file (Serum 'clm ' / Surge 'srge' chunk,
// Surge .wt header) or guesses it (2048 is the common standard, WaveEdit uses 256); pick a size
// to override it for raw WAV files. Without a file the built-in table plays.
import { linkDecayRelease } from './envlink.js';
import { INTERP_NAMES } from './interp.js';
import { BLOCK_NAMES } from './wavetable.dsp.js';
import { createSampleView } from './sampleview.js';
import { sampleState, sampleFeeder, noteMessages } from './sampler.js';

const tableState = (s) => ({ ...sampleState(s), frame: Number.isInteger(s?.frame) && s.frame > 0 ? s.frame : 0 });

export default {
  type: 'WAVETABLE',
  color: '#c78ae6',
  label: 'Wavetable (poly synth)',
  acceptsMidi: true,
  hasInput: false,
  hasOutput: true,
  params: [
    { id: 'polyphony', label: 'Polyphony', min: 1, max: 32, default: 8, step: 1 },
    { id: 'attack', label: 'Attack (s)', min: 0.001, max: 10, default: 0.01, step: 0.001 },
    { id: 'decay', label: 'Decay (s)', min: 0.001, max: 10, default: 0.2, step: 0.001 },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.7, step: 0.01 },
    { id: 'release', label: 'Release (s)', min: 0.001, max: 10, default: 0.4, step: 0.001 },
    { id: 'gain', label: 'Gain', min: 0, max: 1, default: 0.5, step: 0.01 },
    { id: 'position', label: 'Wave Select', min: 0, max: 100, default: 0, step: 0.1, format: (v) => `${v.toFixed(1)} %` },
    { id: 'block', label: 'Block Size', min: 0, max: BLOCK_NAMES.length - 1, default: 0, step: 1, options: BLOCK_NAMES },
    { id: 'interpolation', label: 'Interpolation', min: 0, max: 2, default: 2, step: 1, options: INTERP_NAMES },
  ],
  linked: linkDecayRelease,
  defaultState: () => tableState(null),
  normalizeState: tableState,
  view: (entry, api) => createSampleView(entry, api, { table: true }),
  create(_ctx, _def, host) {
    const node = host.dsp.create('wavetable'); // DSP: wavetable.dsp.js
    const send = (m) => node.send(m);
    let frame = 0;
    const feed = sampleFeeder((s) => send({ type: 'table', data: s?.channels[0] ?? null, frame }));
    return {
      node,
      input: null,
      setParam: (id, value) => send({ type: 'param', id, value }),
      setState(st) {
        const f = st?.frame ?? 0;
        const force = f !== frame; // same sample, other frame size
        frame = f;
        feed.set(st?.sampleId ?? null, force);
      },
      ...noteMessages(send),
      destroy: () => { feed.destroy(); node.destroy(); },
    };
  },
};
