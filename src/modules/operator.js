import { createAdsrView } from './adsrview.js';
import { curveParams } from './adsrcurve.js';
import { linkDecayRelease } from './envlink.js';

export default {
  type: 'OPERATOR',
  label: 'Operator (FM / phase modulation)',
  color: '#b572c9',
  acceptsMidi: true,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'modulation', label: 'Modulation Amount', min: 0, max: 1000, default: 100, step: 0.1, format: (v) => `${v.toFixed(1)} %` },
    { id: 'feedback', label: 'Feedback', min: 0, max: 100, default: 0, step: 0.1, format: (v) => `${v.toFixed(1)} %` },
    { id: 'attack', label: 'Attack (s)', min: 0.001, max: 10, default: 0.001, step: 0.001 },
    { id: 'decay', label: 'Decay (s)', min: 0.001, max: 10, default: 0.001, step: 0.001 },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 1, step: 0.01 },
    { id: 'release', label: 'Release (s)', min: 0.001, max: 10, default: 0.001, step: 0.001 },
    ...curveParams(100),
    { id: 'velocity', label: 'Velocity Sensitivity', min: 0, max: 100, default: 100, step: 0.1, format: (v) => `${v.toFixed(1)} %` },
    { id: 'gain', label: 'Level', min: 0, max: 1, default: 0.5, step: 0.01 },
  ],
  linked: linkDecayRelease,
  view(entry, api) {
    return createAdsrView({ color: api.color, values: entry.values, params: entry.def.params, ...api });
  },
  create(_ctx, _def, host) {
    const node = host.dsp.create('operator');
    let mods = null;
    const flush = () => {
      if (!mods) return;
      node.send({ type: 'noteMod', notes: [...mods.values()] });
      mods = null;
    };
    const stopClock = host.dsp.clockBatch ? host.dsp.onClock(flush) : null;
    return {
      node, input: node,
      setParam: (id, value) => node.param(id, value),
      noteOn(id, pitch, velocity, phase = 0) { flush(); node.send({ type: 'noteOn', id, pitch, velocity, phase }); },
      noteMod(id, pitch, velocity) {
        if (!mods) {
          mods = new Map();
          if (!stopClock) queueMicrotask(flush);
        }
        mods.set(id, [id, pitch, velocity]);
      },
      noteOff(id) { flush(); node.send({ type: 'noteOff', id }); },
      allOff() { mods = null; node.send({ type: 'allOff' }); },
      destroy() { stopClock?.(); mods = null; node.destroy(); },
    };
  },
};
