// Module definition for OSC. Every stock module follows this shape:
//   type        unique id shown in the insert dialog
//   label       display name
//   params      slider definitions: { id, label, min, max, default, step, ...optional }
//                 Controllers are numbered 0.. in this order (LFO "Out Controller" uses the number),
//                 so append new params at the end to keep saved LFO routings valid.
//                 options: [names]       stepped slider showing a name per value
//                 scale: 'log'           exponential slider (e.g. Hz); needs min > 0
//                 format: (v, values) => string  custom value display (values = all controllers)
//                 visible: (values) => bool  hide the slider depending on other params
//   color       type colour of the box, panel header and cables (darkish tone, optional)
//   acceptsMidi true if the module receives note events when selected
//   liveMidi    optional; false = notes only from clips / MIDI cables, never from the MIDI device
//   midiOut     true for MIDI processors (MULTIMIDI): cables carry MODMIDI notes to MIDI modules
//   audioMidi   with midiOut: cables also carry audio when the destination hasInput (DELAY)
//   hasInput / hasOutput  which cable ports the box shows
//   modulator   true for control sources (LFO): cables drive a controller instead of carrying audio
//   create(ctx, def, host) returns (or resolves to) an instance. The DSP runs on the audio thread
//     in a kernel (src/dsp/kernel.js, e.g. osc.dsp.js registered in src/dsp/kernels.js), created
//     with host.dsp.create(kind) (src/dsp/host.js), which gives a DspNode proxy:
//     { node (audio out), input (audio in), setParam(id, v), destroy,
//       ctl?  DspNode whose kernel gets the controllers (default node ?? input); modulators
//             (LFO, ...) change them right inside the audio thread,
//       onModulated?(id, v)  controllers applied on the main thread (PATCH, MULTIMIDI): called
//             when a modulator changed one (setParam must still send it to ctl),
//       noteOn(id, pitch, vel, phase), noteMod(id, pitch, vel), noteOff(id), allOff()  (MODMIDI, see
//       src/modmidi.js; only for acceptsMidi modules),
//       setBpm?(bpm) (called with the BPM of the patch's Output) }
//   editor(entry, api)  optional panel part below the controllers (e.g. WAVESHAPER curve editor)
//   view(entry, api)    optional display below the controllers (e.g. this waveform preview):
//                       { el, refresh?(values), modulate?(id, value|null) }; api.setParam(id, v)
//                       changes a controller (e.g. dragging an EQ band), api.setState(state)
//                       replaces the module state (e.g. the Output's comments)
//   linked(values, id, v, params)  optional: other controllers that follow a changed one,
//                       { id: value } or null (e.g. Decay <-> Release here, see envlink.js)
//   system / isOutput  reserved for the Output module
import { createWaveView } from './oscview.js';
import { WAVE_NAMES, isNoise } from './oscshape.js';
import { linkDecayRelease } from './envlink.js';

export default {
  type: 'OSC',
  color: '#db7c3d', // type colour (box, panel, cables). The 12 module colours are
  // 30° apart in OKLCH hue (rainbow, signal-flow order) with neighbours alternating light/dark, so
  // every pair stays clearly distinct on the dark boxes; keep that in mind when adding a module
  // (MULTICTL's light gold sits apart from all of them by lightness)
  label: 'Oscillator (poly synth)',
  acceptsMidi: true,
  hasInput: false,
  hasOutput: true,
  params: [
    { id: 'polyphony', label: 'Polyphony', min: 1, max: 32, default: 8, step: 1 },
    { id: 'wave', label: 'Waveform', min: 0, max: WAVE_NAMES.length - 1, default: 2, step: 1, options: WAVE_NAMES },
    { id: 'attack', label: 'Attack (s)', min: 0.001, max: 10, default: 0.01, step: 0.001 },
    { id: 'decay', label: 'Decay (s)', min: 0.001, max: 10, default: 0.2, step: 0.001 },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.7, step: 0.01 },
    { id: 'release', label: 'Release (s)', min: 0.001, max: 10, default: 0.4, step: 0.001 },
    { id: 'gain', label: 'Gain', min: 0, max: 1, default: 0.5, step: 0.01 },
    // shapes every waveform (see oscshape.js shape()); half sine uses duty as its bow length;
    // the noise colours are unpitched and have no duty cycle
    { id: 'duty', label: 'Duty Cycle', min: 0, max: 100, default: 50, step: 0.1, format: (v) => `${v.toFixed(1)} %`, visible: (v) => !isNoise(v.wave) },
  ],
  linked: linkDecayRelease, // Sustain at 0: Decay and Release move together
  view: (entry, api) => createWaveView({ color: api.color, values: entry.values }),
  create(_ctx, _def, host) {
    const node = host.dsp.create('osc'); // DSP: osc.dsp.js
    const send = (m) => node.send(m);
    // noteMod updates of one tick (e.g. all drifting notes of a MULTIMIDI) go in one message
    let mods = null;
    const flushMods = () => {
      if (!mods) return; // already sent (before a noteOn/noteOff, to keep the order) or dropped
      send({ type: 'noteMod', notes: [...mods.values()] });
      mods = null;
    };
    return {
      node,
      input: null,
      setParam: (id, value) => send({ type: 'param', id, value }),
      // MODMIDI (src/modmidi.js): float pitch, float velocity, start phase 0..1, per-note id
      noteOn: (id, pitch, velocity, phase = 0) => { flushMods(); send({ type: 'noteOn', id, pitch, velocity, phase }); },
      noteMod(id, pitch, velocity) {
        if (!mods) { mods = new Map(); queueMicrotask(flushMods); }
        mods.set(id, [id, pitch, velocity]);
      },
      noteOff: (id) => { flushMods(); send({ type: 'noteOff', id }); },
      allOff: () => { mods = null; send({ type: 'allOff' }); },
      destroy: () => node.destroy(),
    };
  },
};
