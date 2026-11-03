// PITCH2CTL: turns the pitch of incoming notes into a controller value of every module it is
// cabled to (control cable, like VELOCITY2CTL). Notes come from a clip sent to it or a MULTIMIDI
// cabled into it (Shift+drag); never directly from the MIDI keyboard (liveMidi: false).
//   Key map (module state, saved with the project): one value per MIDI key (128), 0 = Out Min ..
//   1 = Out Max, drawn in the panel editor (pitch2ctlview.js). Default: a straight line over the
//   88-key piano (A0 = Out Min .. C8 = Out Max). Between two keys (cents, glides) the value moves
//   in a straight line from one key's value to the next.
//   Out Controller / Out Min / Out Max: see modtarget.js. Noteoff Action / Smooth: as VELOCITY2CTL.
// DSP: pitch2ctl.dsp.js (no audio; the engine graph maps the value onto the controllers).
import { modulatorParams, outParams } from './modtarget.js';
import { SMOOTH_MAX_MS } from './velocity2ctl.dsp.js';
import { defaultMap, normalizeMap } from './pitch2ctl.dsp.js';
import { createKeyMapView } from './pitch2ctlview.js';

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
    { id: 'noteOffAction', label: 'Noteoff Action', min: 0, max: 2, default: 0, step: 1, options: ['Do Nothing', 'Control Down', 'Control Up'] },
    { id: 'smooth', label: 'Smooth', min: 0, max: SMOOTH_MAX_MS, default: 0, step: 1, format: smoothLabel },
    ...outParams(),
  ],
  defaultState: () => ({ map: defaultMap() }),
  normalizeState: (st) => ({ map: normalizeMap(st?.map) }),
  view(entry, api) {
    return createKeyMapView({ ...api, getMap: () => entry.state.map, playing: () => entry.inst?.playing ?? null });
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
      setState: (st) => send({ type: 'map', map: st.map }),
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
