// Multi-mode filter: SVF (LP/HP/BP/Notch/Peak/All-pass, 12-48 dB), EQ (bell, shelves),
// Moog-style ladder, comb (+/-) and vowel formant. Built-in LFO modulates the cutoff.
const TYPES = [
  'Low-pass', 'High-pass', 'Band-pass', 'Notch', 'Peak', 'All-pass',
  'Bell (EQ)', 'Low shelf', 'High shelf', 'Ladder LP 24dB', 'Comb +', 'Comb −', 'Formant',
];
const SLOPED = (v) => v.type <= 5;
const EQ = (v) => v.type >= 6 && v.type <= 8;
const FORMANT = 12;

const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(v < 100 ? 1 : 0)} Hz`);
const vowel = (v) => {
  const L = 'AEIOU';
  const i = Math.min(3, Math.floor(v));
  const f = v - i;
  if (f < 0.01) return L[i];
  if (f > 0.99) return L[i + 1];
  return `${L[i]}→${L[i + 1]} ${Math.round(f * 100)}%`;
};

export default {
  type: 'FILTER',
  color: '#996a03',
  label: 'Filter',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'type', label: 'Type', min: 0, max: TYPES.length - 1, default: 0, step: 1, options: TYPES },
    { id: 'slope', label: 'Slope', min: 0, max: 3, default: 1, step: 1, options: ['12 dB/oct', '24 dB/oct', '36 dB/oct', '48 dB/oct'], visible: SLOPED },
    { id: 'cutoff', label: 'Cutoff', min: 20, max: 20000, default: 1000, scale: 'log', format: hz, visible: (v) => v.type !== FORMANT },
    { id: 'vowel', label: 'Vowel', min: 0, max: 4, default: 0, step: 0.01, format: vowel, visible: (v) => v.type === FORMANT },
    { id: 'resonance', label: 'Resonance', min: 0, max: 1, default: 0.1, step: 0.001 },
    { id: 'gain', label: 'EQ gain', min: -24, max: 24, default: 0, step: 0.1, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`, visible: EQ },
    { id: 'drive', label: 'Drive', min: 0, max: 1, default: 0, step: 0.01 },
    { id: 'lfoShape', label: 'LFO shape', min: 0, max: 5, default: 0, step: 1, options: ['Sine', 'Triangle', 'Saw', 'Square', 'Sample & hold', 'Random'] },
    { id: 'lfoRate', label: 'LFO rate', min: 0.02, max: 20, default: 1, scale: 'log', format: (v) => `${v.toFixed(v < 1 ? 2 : 1)} Hz` },
    { id: 'lfoDepth', label: 'LFO depth', min: 0, max: 4, default: 0, step: 0.01, format: (v) => `${v.toFixed(2)} oct` },
    { id: 'mix', label: 'Dry / wet', min: 0, max: 1, default: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
    { id: 'level', label: 'Output level', min: 0, max: 2, default: 1, step: 0.01 },
  ],
  create(_ctx, _def, host) {
    const node = host.dsp.create('filter'); // DSP: filter.dsp.js
    return {
      node,
      input: node,
      setParam: (id, value) => node.param(id, value),
      destroy: () => node.destroy(),
    };
  },
};
