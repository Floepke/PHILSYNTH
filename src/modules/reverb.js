// Stereo algorithmic reverb: pre-delay, seeded early reflections, diffusion and a 16-line
// feedback delay network with frequency-dependent decay. DSP lives in reverb.dsp.js.
const pct = (v) => `${Math.round(v * 100)}%`;
const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const secs = (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(v < 10 ? 2 : 1)} s`);

export default {
  type: 'REVERB',
  color: '#3a9a92',
  label: 'Reverb',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'mix', label: 'Dry / wet', min: 0, max: 1, default: 0.3, step: 0.01, format: pct },
    { id: 'size', label: 'Room size', min: 0, max: 1, default: 0.5, step: 0.001, format: pct },
    { id: 'decay', label: 'Decay', min: 0.1, max: 30, default: 2.5, scale: 'log', format: secs },
    { id: 'damp', label: 'Damp', min: 0, max: 1, default: 0.5, step: 0.01, format: pct },
    { id: 'seed', label: 'Seed', min: 1, max: 999, default: 1, step: 1, format: (v) => `#${Math.round(v)}` },
    { id: 'predelay', label: 'Pre-delay', min: 0, max: 0.5, default: 0.02, step: 0.001, format: (v) => `${Math.round(v * 1000)} ms` },
    { id: 'early', label: 'Early reflections', min: 0, max: 1, default: 0.4, step: 0.01, format: pct },
    { id: 'diffusion', label: 'Diffusion', min: 0, max: 1, default: 0.75, step: 0.01, format: pct },
    { id: 'mod', label: 'Modulation', min: 0, max: 1, default: 0.3, step: 0.01, format: pct },
    { id: 'lowCut', label: 'Low cut', min: 20, max: 1000, default: 60, scale: 'log', format: hz },
    { id: 'highCut', label: 'High cut', min: 1000, max: 20000, default: 14000, scale: 'log', format: hz },
    { id: 'width', label: 'Stereo width', min: 0, max: 1, default: 1, step: 0.01, format: pct },
    { id: 'freeze', label: 'Freeze', min: 0, max: 1, default: 0, step: 1, options: ['Off', 'On'] },
    { id: 'level', label: 'Output level', min: 0, max: 2, default: 1, step: 0.01, format: (v) => `${v.toFixed(2)} ×` },
  ],
  create(_ctx, _def, host) {
    // Patch instances (Instances > 1) each get their own salt: same Seed, different room per instance
    const node = host.dsp.create('reverb', { salt: host.salt | 0 }); // DSP: reverb.dsp.js
    return {
      node,
      input: node,
      setParam: (id, value) => node.param(id, value),
      destroy: () => node.destroy(),
    };
  },
};
