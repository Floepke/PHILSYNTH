import { createDistortionView } from './distortionview.js';

export default {
  type: 'DISTORTION',
  color: '#ad643b',
  label: 'Distortion (shaping / bit crusher)',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'type', label: 'Type', min: 0, max: 11, default: 1, step: 1, options: [
      'Original (no distortion)', 'Clipping', 'Foldback', 'Foldback2', 'Foldback3',
      'Overflow', 'Overflow2', 'Saturation + foldback', 'Saturation + foldback (sin)',
      'Saturation3', 'Saturation4', 'Saturation5',
    ] },
    { id: 'power', label: 'Power', min: 0, max: 100, default: 1, step: 0.01, format: (v) => `${v.toFixed(2)} ×` },
    { id: 'bits', label: 'Bit Depth', min: 1, max: 16, default: 16, step: 1, format: (v) => `${Math.round(v)} bit` },
    { id: 'frequency', label: 'Freq Hz', min: 0, max: 48000, default: 48000, step: 1, format: (v) => v === 0 ? 'Off' : `${Math.round(v)} Hz` },
  ],
  view(entry, api) {
    return createDistortionView({
      color: api.color, values: entry.values, options: entry.def.params[0].options,
      setParam: (v) => api.setParam('type', v), beginEdit: api.beginEdit, endEdit: api.endEdit,
    });
  },
  create(_ctx, _def, host) {
    const node = host.dsp.create('distortion');
    return {
      node, input: node,
      setParam: (id, v) => node.param(id, v),
      destroy: () => node.destroy(),
    };
  },
};
