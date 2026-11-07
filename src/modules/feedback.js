// FEEDBACK: the gain of a sound loop. Audio cables may only close a loop that passes through at
// least two FEEDBACK modules (see PatchRuntime.connect in src/patch.js); such a loop is rendered
// sample by sample (src/dsp/graph.js), so it adds just one sample of delay. FEEDBACK starts at 0
// (no feedback): raise it slowly, a loop can get loud. DSP: feedback.dsp.js (C++: cpp/basic.h).
export const FEEDBACK_MIN_IN_LOOP = 2;

export default {
  type: 'FEEDBACK',
  color: '#b0532f',
  label: 'Feedback loop gain',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  feedback: true, // counts toward the FEEDBACK modules a sound loop needs
  params: [
    { id: 'feedback', label: 'Feedback', min: 0, max: 1, default: 0, step: 0.001, format: (v) => `${v.toFixed(3)} ×` },
  ],
  create(_ctx, _def, host) {
    const node = host.dsp.create('feedback');
    return {
      node,
      input: node,
      setParam: (id, v) => node.param(id, v),
      destroy: () => node.destroy(),
    };
  },
};
