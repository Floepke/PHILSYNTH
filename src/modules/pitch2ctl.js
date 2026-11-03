// PITCH2CTL: turns the pitch of incoming notes into a controller value of every module it is
// cabled to (control cable, like VELOCITY2CTL). Notes come from a clip sent to it or a MULTIMIDI
// cabled into it (Shift+drag); never directly from the MIDI keyboard (liveMidi: false).
//   Low Key / High Key: the key range that sweeps the controller: Low Key gives Out Min, High Key
//   Out Max, in a straight line per semitone (cents count). Outside the range the value stays at
//   the nearest end; Low Key above High Key flips it (high notes give low values).
//   Out Controller / Out Min / Out Max: see modtarget.js. Noteoff Action / Smooth: as VELOCITY2CTL.
//   The panel shows a keyboard of all 128 MIDI keys to drag the range on (pitch2ctlview.js).
// DSP: pitch2ctl.dsp.js (no audio; the engine graph maps the value onto the controllers).
import { modulatorParams, outParams } from './modtarget.js';
import { SMOOTH_MAX_MS } from './velocity2ctl.dsp.js';
import { KEY_MAX } from './pitch2ctl.dsp.js';
import { noteName, PIANO_LOW, PIANO_HIGH } from '../song.js';
import { createPitchRangeView } from './pitch2ctlview.js';

export const keyLabel = (v) => `${noteName(Math.round(v))} (${Math.round(v)})`;
const smoothLabel = (v) => (v < 0.5 ? 'Off (jump)' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);

export default {
  type: 'PITCH2CTL',
  color: '#7d5fd1',
  label: 'PITCH2CTL (pitch → controller)',
  acceptsMidi: true,
  liveMidi: false, // like VELOCITY2CTL: selecting it does not take the keyboard
  hasInput: false,
  hasOutput: true,
  modulator: true,
  params: [
    ...outParams(),
    { id: 'lowKey', label: 'Low Key', min: 0, max: KEY_MAX, default: PIANO_LOW, step: 1, format: keyLabel },
    { id: 'highKey', label: 'High Key', min: 0, max: KEY_MAX, default: PIANO_HIGH, step: 1, format: keyLabel },
    { id: 'noteOffAction', label: 'Noteoff Action', min: 0, max: 2, default: 0, step: 1, options: ['Do Nothing', 'Control Down', 'Control Up'] },
    { id: 'smooth', label: 'Smooth', min: 0, max: SMOOTH_MAX_MS, default: 0, step: 1, format: smoothLabel },
  ],
  view(entry, api) {
    return createPitchRangeView({ ...api, values: entry.values, params: entry.def.params, playing: () => entry.inst?.playing ?? null });
  },
  create(_ctx, def, host) {
    const node = host.dsp.create('pitch2ctl');
    const send = (m) => node.send(m);
    const inst = {
      node,
      input: null,
      playing: null, // { id, pitch } of the newest sounding note: lit on the panel keyboard
      getTargets: () => [], // set by the patch: modules this module is cabled to
      params: () => modulatorParams(inst, def),
      setParam: (id, v) => node.param(id, v),
      noteOn(id, pitch) { inst.playing = { id, pitch }; send({ type: 'noteOn', id, pitch }); },
      noteMod(id, pitch, velocity) {
        if (inst.playing?.id === id) inst.playing = { id, pitch };
        send({ type: 'noteMod', notes: [[id, pitch, velocity]] });
      },
      noteOff(id) { if (inst.playing?.id === id) inst.playing = null; send({ type: 'noteOff', id }); },
      allOff() { inst.playing = null; send({ type: 'allOff' }); },
      destroy: () => node.destroy(),
    };
    return inst;
  },
};
