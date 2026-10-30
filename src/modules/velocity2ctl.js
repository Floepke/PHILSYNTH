// VELOCITY2CTL: turns the velocity of incoming notes into a controller value of every module it
// is cabled to (control cable, like the LFO / ADSR). Notes come in like on any synth: select it
// and play, send a clip to it, or cable a MULTIMIDI into it (Shift+drag).
//   The newest note wins: its velocity (and its velocity curve while it sounds, via noteMod) sets
//   the value. The value is held after the note ends, until the next note.
//   Out Controller / Out Min / Out Max: see modtarget.js (velocity 0 -> Out Min, 127 -> Out Max).
// DSP: velocity2ctl.dsp.js (no audio; the engine graph maps the velocity onto the controllers).
import { modulatorParams, outParams } from './modtarget.js';

export default {
  type: 'VELOCITY2CTL',
  color: '#8a6fc2',
  label: 'VELOCITY2CTL (velocity → controller)',
  acceptsMidi: true,
  hasInput: false,
  hasOutput: true,
  modulator: true,
  params: [...outParams()],
  create(_ctx, def, host) {
    const node = host.dsp.create('velocity2ctl');
    const send = (m) => node.send(m);
    const inst = {
      node,
      input: null,
      getTargets: () => [], // set by the patch: modules this module is cabled to
      params: () => modulatorParams(inst, def),
      setParam: (id, v) => node.param(id, v),
      noteOn: (id, _pitch, velocity) => send({ type: 'noteOn', id, velocity }),
      noteMod: (id, pitch, velocity) => send({ type: 'noteMod', notes: [[id, pitch, velocity]] }),
      noteOff: (id) => send({ type: 'noteOff', id }),
      allOff: () => send({ type: 'allOff' }),
      destroy: () => node.destroy(),
    };
    return inst;
  },
};
