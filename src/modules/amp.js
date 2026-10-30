// Amplifier: gain 0..4×, stereo pan and polarity inversion. DSP: amp.dsp.js.
// Signal: input (mono is upmixed to stereo) -> gain (amplification × ±1) -> per-channel pan gains
// Panning is a balance law: center leaves both channels untouched (1× really is unity),
// panning left fades the right channel out (and vice versa) without boosting the other side.
export { panGains } from './amp.dsp.js';

export default {
  type: 'AMP',
  color: '#3c8836',
  label: 'Amplifier',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'amp', label: 'Amplification', min: 0, max: 4, default: 1, step: 0.01, format: (v) => `${v.toFixed(2)} ×` },
    {
      id: 'pan', label: 'Panning', min: -1, max: 1, default: 0, step: 0.01,
      format: (v) => (Math.abs(v) < 0.005 ? 'Center' : `${Math.round(Math.abs(v) * 100)} % ${v < 0 ? 'L' : 'R'}`),
    },
    { id: 'inverse', label: 'Inverse', min: 0, max: 1, default: 0, step: 1, options: ['Off', 'On'] },
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
