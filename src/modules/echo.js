import { delayParam, delayUnitParam } from './delaytime.js';

const pct = (v) => `${Math.round(v * 100)}%`;
const FILTERS = ['OFF', 'LP 12 dB/oct', 'LP 24 dB/oct', 'LP 36 dB/oct', 'LP 48 dB/oct',
  'HP 12 dB/oct', 'HP 24 dB/oct', 'HP 36 dB/oct', 'HP 48 dB/oct'];

export default {
  type: 'ECHO',
  color: '#449aab',
  label: 'Echo',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'dry', label: 'Dry', min: 0, max: 1, default: 1, step: 0.01, format: pct },
    { id: 'wet', label: 'Wet', min: 0, max: 1, default: 0.5, step: 0.01, format: pct },
    { id: 'feedback', label: 'Feedback', min: 0, max: 0.99, default: 0.5, step: 0.01, format: pct },
    delayParam('delay', 'Delay'),
    delayUnitParam(),
    { id: 'mode', label: 'Mode', min: 0, max: 1, default: 0, step: 1, options: ['STEREO', 'PINGPONG'] },
    { id: 'filter', label: 'Filter', min: 0, max: FILTERS.length - 1, default: 0, step: 1, options: FILTERS },
    { id: 'cutoff', label: 'Filter Freq', min: 20, max: 20000, default: 4000, scale: 'log', format: (v) => `${Math.round(v)} Hz` },
  ],
  create(_ctx, _def, host) {
    const node = host.dsp.create('echo');
    return {
      node,
      input: node,
      setParam: (id, value) => node.param(id, value),
      setBpm: (value) => node.send({ type: 'bpm', value }),
      destroy: () => node.destroy(),
    };
  },
};
