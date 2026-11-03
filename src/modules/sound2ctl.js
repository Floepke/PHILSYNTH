// Audio voltage -> controller: stereo is averaged, -1..1 maps to Out Min..Out Max.
// No envelope follower or rectification. DSP: sound2ctl.dsp.js.
//   Audio Rate: how many times a second a new value is taken from the audio (max = audio rate:
//     the last sample of every 128-sample block, the original behaviour).
//   Smooth: glide time to each new value, in % of the time between two values (0 = jump).
import { modulatorParams, outParams } from './modtarget.js';
import { RATE_MAX } from './sound2ctl.dsp.js';

const rateLabel = (v) => (v >= RATE_MAX ? `${RATE_MAX} Hz · audio rate`
  : v < 1 ? `${v.toFixed(v < 0.1 ? 3 : 2)} Hz` : v < 100 ? `${v.toFixed(v < 10 ? 2 : 1)} Hz` : `${Math.round(v)} Hz`);

export default {
  type: 'SOUND2CTL',
  color: '#aaa',
  label: 'SOUND2CTL (sound → controller)',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  modulator: true,
  params: [
    { id: 'rate', label: 'Audio Rate (Hz)', min: 0.01, max: RATE_MAX, default: RATE_MAX, scale: 'log', format: rateLabel },
    { id: 'smooth', label: 'Smooth', min: 0, max: 100, default: 0, step: 1, format: (v) => `${Math.round(v)} %` },
    ...outParams(),
  ],
  create(_ctx, def, host) {
    const node = host.dsp.create('sound2ctl');
    const inst = {
      node,
      input: node,
      getTargets: () => [],
      params: () => modulatorParams(inst, def),
      setParam: (id, v) => node.param(id, v),
      destroy: () => node.destroy(),
    };
    return inst;
  },
};
