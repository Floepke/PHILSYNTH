// WAVESHAPER: remaps the incoming voltage (x) to an outgoing voltage (y) along a curve you
// draw in the panel (see src/curveeditor.js). The diagonal from (0,0) to (1,1) changes nothing.
//   Range: Symmetric — the graph is 0..max input, mirrored for the negative half of the wave
//          (odd harmonics, the classic shaper); Full — the graph spans -max..+max, so the two
//          halves can be shaped differently (adds even harmonics; DC is filtered out).
//   Drive: input gain before the curve (pushes more of the wave into the top of the graph).
// The curve is module state (saved with the project), not a controller.
import { defaultCurve, normalizeCurve } from '../curve.js';
import { createCurveEditor } from '../curveeditor.js';

const db = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

export default {
  type: 'WAVESHAPER',
  color: '#9ba022',
  label: 'Waveshaper (curve)',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'drive', label: 'Drive', min: -12, max: 36, default: 0, step: 0.1, format: db },
    { id: 'range', label: 'Range', min: 0, max: 1, default: 0, step: 1, options: ['Symmetric', 'Full −/+'] },
    { id: 'oversample', label: 'Oversample', min: 0, max: 2, default: 1, step: 1, options: ['Off', '2×', '4×'] },
    { id: 'mix', label: 'Dry/Wet', min: 0, max: 100, default: 100, step: 1, format: (v) => `${Math.round(v)} % wet` },
    { id: 'level', label: 'Output level', min: 0, max: 2, default: 1, step: 0.01, format: (v) => `${v.toFixed(2)} ×` },
  ],
  defaultState: defaultCurve,
  normalizeState: normalizeCurve,
  // panel editor (src/main.js): api.setState(curve) stores the curve; refresh() follows controllers
  editor(entry, api) {
    const labels = (v) => (v.range ? { x0: '−max', x1: 'in +max →', y1: 'out +max ↑' } : { x0: '0', x1: 'in max →', y1: 'out max ↑' });
    const ed = createCurveEditor({ curve: entry.state, color: api.color, labels: labels(entry.values), onChange: (c) => api.setState(c) });
    let range = entry.values.range;
    return {
      el: ed.el,
      refresh(values) { if (values.range !== range) { range = values.range; ed.setLabels(labels(values)); } },
    };
  },
  create(_ctx, _def, host) {
    const node = host.dsp.create('waveshaper'); // DSP: waveshaper.dsp.js
    return {
      node,
      input: node,
      setParam: (id, v) => node.param(id, v),
      setState: (curve) => node.send({ type: 'curve', curve }),
      destroy: () => node.destroy(),
    };
  },
};
