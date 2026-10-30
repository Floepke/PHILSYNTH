// VELOCITY2CTL: turns the velocity of incoming notes into a controller value of every module it
// is cabled to (control cable, like the LFO / ADSR). Notes come from a clip sent to it or a
// MULTIMIDI cabled into it (Shift+drag); never directly from the MIDI keyboard (liveMidi: false),
// so selecting it keeps the keyboard playing the current synth.
//   The newest note wins: its velocity (and its velocity curve while it sounds, via noteMod) sets
//   the value. By default the value is held after the note ends, until the next note.
//   Out Controller / Out Min / Out Max: see modtarget.js (velocity 0 -> Out Min, 127 -> Out Max).
//   Noteoff Action: what happens when the newest note ends: hold the value (Do Nothing), go to
//   Out Min (Control Down) or to Out Max (Control Up).
// DSP: velocity2ctl.dsp.js (no audio; the engine graph maps the velocity onto the controllers).
import { modulatorParams, outParams } from './modtarget.js';

export default {
  type: 'VELOCITY2CTL',
  color: '#9a55a5',
  label: 'VELOCITY2CTL (velocity → controller)',
  acceptsMidi: true,
  liveMidi: false, // not played by the MIDI device (selecting it does not take the keyboard)
  hasInput: false,
  hasOutput: true,
  modulator: true,
  params: [
    ...outParams(),
    { id: 'noteOffAction', label: 'Noteoff Action', min: 0, max: 2, default: 0, step: 1, options: ['Do Nothing', 'Control Down', 'Control Up'] },
  ],
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
