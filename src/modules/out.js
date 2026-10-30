// System module: the single Output of every patch. Always id 0, cannot be deleted or inserted.
export default {
  type: 'OUT',
  label: 'Output',
  system: true,
  isOutput: true,
  hasInput: true,
  hasOutput: false,
  acceptsMidi: false,
  params: [
    { id: 'volume', label: 'Master volume', min: 0, max: 1, default: 0.8, step: 0.01 },
    // tempo of this patch level; LFOs inside the patch sync to it
    { id: 'bpm', label: 'BPM', min: 20, max: 300, default: 120, step: 1 },
  ],
  create(_ctx, _def, host) {
    const input = host.dsp.create('out'); // DSP: out.dsp.js (sum × Master volume)
    return {
      input,
      node: null,
      setParam: (id, v) => input.param(id, v),
      destroy: () => input.destroy(),
    };
  },
};
