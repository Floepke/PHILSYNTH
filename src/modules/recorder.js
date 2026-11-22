export default {
  type: 'RECORDER',
  color: '#b55b55',
  label: 'Audio recorder',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'armed', label: 'Arm', min: 0, max: 1, default: 0, step: 1, options: ['Off', 'On'], dsp: false },
    { id: 'lane', label: 'Record lane', min: 1, max: 256, default: 1, step: 1, dsp: false },
    { id: 'channels', label: 'Channels', min: 0, max: 1, default: 1, step: 1, options: ['Mono', 'Stereo'], dsp: false },
  ],
  create(_ctx, _def, host) {
    const node = host.dsp.create('bus');
    return { node, input: node, setParam() {}, destroy: () => node.destroy() };
  },
};
