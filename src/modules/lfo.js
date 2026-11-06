// LFO: modulates one controller of every module it is cabled to (control cable, no audio).
//   Frequency + Frequency Unit: Hz, or cycles per note value synced to the BPM of this patch's Output,
//   or MIDI Pitch: runs at the frequency of the incoming note (Frequency ignored). Notes come from a
//   clip sent to it or a MULTIMIDI cabled into it, never from the MIDI keyboard (liveMidi: false).
//   Phase: where in its cycle the wave starts, on project load, after a panic (' twice: stop, then
//   panic) and on every incoming note (plus that note's MODMIDI phase, e.g. a MULTIMIDI's Phase).
//   Amplitude: depth of the wave around its centre (100 % = full swing, 0 % = steady at the middle).
//   Out Controller: controller number (0..) of the connected module(s) to modulate.
//   Out Min / Out Max: modulation range in % of that controller's slider range (applied after Amplitude).
//   LFO On/Off: pauses/resumes the wave at its remembered phase; MIDI notes still reset it while Off.
// Audio input (tremolo): with sound cabled in, its cables to modules that take audio carry that sound
// with its volume following the wave (Out Min..Out Max = 0..100 % volume); cables to modules
// without an audio input stay control cables (see PatchRuntime.syncThrough, lfo.dsp.js).
import { modulatorParams, outParams, pct } from './modtarget.js';
import { syncedPeriod, MIDI_UNIT, SYNCED_FREQS } from './lfo.dsp.js';

export { lfoRateHz, syncedPeriod, pitchHz, MIDI_UNIT } from './lfo.dsp.js';

// appended last: saved Frequency Unit values keep their meaning
const UNITS = ['Hz', '1/4', '1/8', '1/16', 'MIDI Pitch (use incoming MIDI pitch)'];
const FRACTIONS = { 0.75: '3/4', 0.667: '2/3', 0.5: '1/2', 0.333: '1/3', 0.25: '1/4' };
export const phaseLabel = (v) => `${Math.round(v * 100)} % (${Math.round(v * 360)}°)`;

// Frequency with a synced Frequency Unit snaps to the note-value periods (Hz and MIDI Pitch: continuous)
export const freqSnaps = (values) => {
  const unit = values?.unit | 0;
  return unit && unit !== MIDI_UNIT ? SYNCED_FREQS : null;
};

export function formatFreq(v, values) {
  const unit = values?.unit | 0;
  if (unit === MIDI_UNIT) return 'MIDI pitch (ignored)';
  if (!unit) return `${v < 1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(1)} Hz`;
  const p = syncedPeriod(v);
  return `${FRACTIONS[+p.toFixed(3)] ?? p} × ${UNITS[unit]}`;
}


export default {
  type: 'LFO',
  color: '#05a6de',
  label: 'LFO (modulator)',
  acceptsMidi: true, // notes restart its phase; with Frequency Unit MIDI Pitch they also set the rate
  liveMidi: false, // not played by the MIDI device (selecting it does not take the keyboard)
  hasInput: true, // sound in: tremolo
  hasOutput: true,
  modulator: true, // its cables are control cables: they modulate a controller instead of carrying audio
  audioThrough: true, // ...except, with sound cabled in, those to modules that take audio (tremolo)
  params: [
    { id: 'wave', label: 'Waveform', min: 0, max: 4, default: 0, step: 1, options: ['Sine', 'Triangle', 'Saw', 'Square', 'Random'] },
    { id: 'unit', label: 'Frequency Unit', min: 0, max: UNITS.length - 1, default: 0, step: 1, options: UNITS },
    { id: 'freq', label: 'Frequency', min: 0.01, max: 50, default: 1, scale: 'log', format: formatFreq, snapValues: freqSnaps },
    { id: 'phase', label: 'Phase', min: 0, max: 1, default: 0, step: 0.01, format: phaseLabel },
    { id: 'amp', label: 'Amplitude', min: 0, max: 100, default: 100, step: 1, format: pct },
    ...outParams(),
    { id: 'enabled', label: 'LFO On/Off', min: 0, max: 1, default: 1, step: 1, options: ['Off', 'On'] },
  ],
  create(_ctx, def, host) {
    // DSP: lfo.dsp.js; the engine graph maps its value onto the controllers it is cabled to
    const node = host.dsp.create('lfo');
    const send = (m) => node.send(m);
    const inst = {
      node,
      input: node,
      getTargets: () => [], // set by the patch: modules this LFO is cabled to
      params: () => modulatorParams(inst, def),
      setParam: (id, v) => node.param(id, v),
      setBpm: (bpm) => send({ type: 'bpm', value: bpm }),
      noteOn: (id, pitch, _velocity, phase = 0) => send({ type: 'noteOn', id, pitch, phase }),
      noteMod: (id, pitch, velocity) => send({ type: 'noteMod', notes: [[id, pitch, velocity]] }),
      noteOff: (id) => send({ type: 'noteOff', id }),
      allOff: () => send({ type: 'allOff' }),
      destroy: () => node.destroy(),
    };
    return inst;
  },
};
