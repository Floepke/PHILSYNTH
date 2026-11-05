// Amplifier: gain 0..4×, stereo pan and polarity inversion. DSP: amp.dsp.js.
// Signal: input (mono is upmixed to stereo) -> gain (amplification × fine volume × ±1) -> per-channel pan gains
// Fine Volume: 0..100 % in 2 × 16384 steps, for smooth fades (Amplification's 0.01 steps are
// audible near silence).
// Panning is a balance law: center leaves both channels untouched (1× really is unity),
// panning left fades the right channel out (and vice versa) without boosting the other side.
export { panGains } from './amp.dsp.js';

export const FINE_STEPS = 2 * 16384;
export const formatFine = (v) => `${(v * 100).toFixed(3)} % (${v > 0 ? `${(20 * Math.log10(v)).toFixed(1)} dB` : '−∞ dB'})`;

export default {
  type: 'AMP',
  color: '#3c8836',
  label: 'Amplifier',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'inverse', label: 'Inverse', min: 0, max: 1, default: 0, step: 1, options: ['Off', 'On'] },
    { id: 'amp', label: 'Amplification', min: 0, max: 4, default: 1, step: 0.01, format: (v) => `${v.toFixed(2)} ×` },
    {
      id: 'pan', label: 'Panning', min: -1, max: 1, default: 0, step: 0.01,
      format: (v) => (Math.abs(v) < 0.005 ? 'Center' : `${Math.round(Math.abs(v) * 100)} % ${v < 0 ? 'L' : 'R'}`),
    },
    { id: 'fine', label: 'Fine Volume', min: 0, max: 1, default: 1, step: 1 / FINE_STEPS, format: formatFine },
  ],
  create(_ctx, _def, host) {
    const node = host.dsp.create('amp'); // DSP: amp.dsp.js
    return {
      node,
      input: node,
      setParam: (id, v) => node.param(id, v),
      destroy: () => node.destroy(),
    };
  },
};
