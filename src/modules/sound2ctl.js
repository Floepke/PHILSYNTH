// Audio voltage -> controller: stereo is averaged, -1..1 maps to Out Min..Out Max.
// No envelope follower or rectification. DSP: sound2ctl.dsp.js.
import { modulatorParams, outParams } from './modtarget.js';

export default {
  type: 'SOUND2CTL',
  color: '#aaa',
  label: 'SOUND2CTL (sound → controller)',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  modulator: true,
  params: outParams(),
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
