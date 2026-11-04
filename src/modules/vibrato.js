// VIBRATO: audio pitch vibrato (audio in -> audio out, no MIDI). DSP: vibrato.dsp.js.
//   Waveform: the shape the pitch follows (Sine or Triangle).
//   Freq Unit + Frequency: rate in Hz, or cycles per note value synced to the BPM of this patch's
//     Output (the LFO's units, without MIDI Pitch: VIBRATO receives no notes).
//   Set Phase: where in its cycle the vibrato starts on project load and after a panic.
//   Amp: pitch depth in cents, up and down.
import { formatFreq, phaseLabel } from './lfo.js';

const UNITS = ['Hz', '1/4', '1/8', '1/16'];

export default {
  type: 'VIBRATO',
  color: '#8a6fc4',
  label: 'Vibrato (audio pitch modulation)',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'wave', label: 'Waveform', min: 0, max: 1, default: 0, step: 1, options: ['Sine', 'Triangle'] },
    { id: 'unit', label: 'Freq Unit', min: 0, max: UNITS.length - 1, default: 0, step: 1, options: UNITS },
    { id: 'freq', label: 'Frequency', min: 0.01, max: 50, default: 5, scale: 'log', format: formatFreq },
    { id: 'phase', label: 'Set Phase', min: 0, max: 1, default: 0, step: 0.01, format: phaseLabel },
    { id: 'amp', label: 'Amp', min: 0, max: 200, default: 25, step: 1, format: (v) => `±${Math.round(v)} cents` },
  ],
  create(_ctx, _def, host) {
    const node = host.dsp.create('vibrato');
    return {
      node,
      input: node,
      setParam: (id, v) => node.param(id, v),
      setBpm: (value) => node.send({ type: 'bpm', value }),
      destroy: () => node.destroy(),
    };
  },
};
