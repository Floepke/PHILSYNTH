// DC BLOCKER: removes DC offset (and sub-audio drift below ~10 Hz) from the signal. No controllers.
// DSP: dcblock.dsp.js (C++: cpp/basic.h DcBlock).
export default {
  type: 'DC BLOCKER',
  color: '#07848c',
  label: 'Removes DC offset',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [],
  create(_ctx, _def, host) {
    const node = host.dsp.create('dcblock');
    return {
      node,
      input: node,
      setParam: () => {},
      destroy: () => node.destroy(),
    };
  },
};
