// ADSR: an envelope that modulates one controller of every module it is cabled to (control
// cable, like the LFO). It is triggered by notes: select it and play, send a clip to it, or
// cable a MULTIMIDI into it (Shift+drag), e.g. MULTIMIDI -> OSC and MULTIMIDI -> ADSR -> OSC
// controller, so every note also sweeps a controller of the synth.
//   Trigger: Every note restarts the attack (from the current level, no jump); Legato only
//   when no other note is held. Release starts when the last held note ends.
//   Velocity: how much the note velocity scales the envelope peak (0 % = always full).
//   Out Controller / Out Min / Out Max: see modtarget.js (the envelope runs Out Min -> Out Max).
import { modulatorParams, outParams, pct } from './modtarget.js';

const secs = (v) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);

export default {
  type: 'ADSR',
  color: '#a8577e',
  label: 'ADSR (envelope modulator)',
  acceptsMidi: true, // notes trigger the envelope
  hasInput: false,
  hasOutput: true,
  modulator: true,
  params: [
    { id: 'attack', label: 'Attack', min: 0.001, max: 10, default: 0.01, scale: 'log', format: secs },
    { id: 'decay', label: 'Decay', min: 0.001, max: 10, default: 0.3, scale: 'log', format: secs },
    { id: 'sustain', label: 'Sustain', min: 0, max: 100, default: 50, step: 1, format: pct },
    { id: 'release', label: 'Release', min: 0.001, max: 20, default: 0.5, scale: 'log', format: secs },
    ...outParams(),
    { id: 'trigger', label: 'Trigger', min: 0, max: 1, default: 0, step: 1, options: ['Every note', 'Legato'] },
    { id: 'velocity', label: 'Velocity', min: 0, max: 100, default: 0, step: 1, format: pct },
  ],
  create(_ctx, def, host) {
    // DSP: adsr.dsp.js (held notes, legato and velocity are handled there too)
    const node = host.dsp.create('adsr');
    const send = (m) => node.send(m);
    const inst = {
      node,
      input: null,
      getTargets: () => [], // set by the patch: modules this ADSR is cabled to
      params: () => modulatorParams(inst, def),
      setParam: (id, v) => node.param(id, v),
      noteOn: (id, _pitch, velocity) => send({ type: 'noteOn', id, velocity }),
      noteMod() {},
      noteOff: (id) => send({ type: 'noteOff', id }),
      allOff: () => send({ type: 'allOff' }),
      destroy: () => node.destroy(),
    };
    return inst;
  },
};
