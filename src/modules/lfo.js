// LFO: modulates one controller of every module it is cabled to (control cable, no audio).
//   Frequency + Freq Unit: Hz, or cycles per note value synced to the BPM of this patch's Output.
//   Out Controller: controller number (0..) of the connected module(s) to modulate.
//   Amplitude: depth of the wave around its centre (100 % = full swing, 0 % = steady at the middle).
//   Out Min / Out Max: modulation range in % of that controller's slider range (applied after Amplitude).
import { modulatorParams, outParams, pct } from './modtarget.js';
import { syncedPeriod } from './lfo.dsp.js';

export { lfoRateHz, syncedPeriod } from './lfo.dsp.js';

const UNITS = ['Hz', '1/4', '1/8', '1/16'];
const FRACTIONS = { 0.75: '3/4', 0.667: '2/3', 0.5: '1/2', 0.333: '1/3', 0.25: '1/4' };

function formatFreq(v, values) {
  const unit = values?.unit | 0;
  if (!unit) return `${v < 1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(1)} Hz`;
  const p = syncedPeriod(v);
  return `${FRACTIONS[+p.toFixed(3)] ?? p} × ${UNITS[unit]}`;
}


export default {
  type: 'LFO',
  color: '#3f86b0',
  label: 'LFO (modulator)',
  acceptsMidi: false,
  hasInput: false,
  hasOutput: true,
  modulator: true, // its cables are control cables: they modulate a controller instead of carrying audio
  params: [
    { id: 'freq', label: 'Frequency', min: 0.01, max: 50, default: 1, scale: 'log', format: formatFreq },
    { id: 'unit', label: 'Freq Unit', min: 0, max: 3, default: 0, step: 1, options: UNITS },
    { id: 'wave', label: 'Waveform', min: 0, max: 4, default: 0, step: 1, options: ['Sine', 'Triangle', 'Saw', 'Square', 'Random'] },
    ...outParams(),
    { id: 'amp', label: 'Amplitude', min: 0, max: 100, default: 100, step: 1, format: pct },
  ],
  create(_ctx, def, host) {
    // DSP: lfo.dsp.js; the engine graph maps its value onto the controllers it is cabled to
    const node = host.dsp.create('lfo');
    const inst = {
      node,
      input: null,
      getTargets: () => [], // set by the patch: modules this LFO is cabled to
      params: () => modulatorParams(inst, def),
      setParam: (id, v) => node.param(id, v),
      setBpm: (bpm) => node.send({ type: 'bpm', value: bpm }),
      destroy: () => node.destroy(),
    };
    return inst;
  },
};
