import { ANALYSIS_SIZE, ANALYSIS_SIZES } from './dsp/analysis.js';

export const SPECTRUM_FLOW_ID = 'patcher.spectrumFlowDirection';
export const SPECTRUM_SIZE_ID = 'patcher.spectrumSize';
export const SPECTRUM_SPEED_ID = 'patcher.spectrumSpeed';

export function registerPatcherPreferences(preferencesManager, redraw = () => {}) {
  const settings = { spectrumFlowDirection: 'down', spectrumSize: ANALYSIS_SIZE, spectrumSpeed: 1 };
  preferencesManager.register({
    id: SPECTRUM_FLOW_ID, category: 'Patcher',
    label: 'Spectrum Analyser flow direction',
    description: 'Direction in which spectrum history scrolls. Frequency labels stay at the bottom.',
    type: 'select', defaultValue: 'down',
    options: [
      { value: 'down', label: 'Top to bottom' },
      { value: 'up', label: 'Bottom to top' },
    ],
    apply: (value) => { settings.spectrumFlowDirection = value; redraw(); },
  });
  preferencesManager.register({
    id: SPECTRUM_SIZE_ID, category: 'Patcher',
    label: 'Spectrum Analyser FFT size',
    description: 'Samples per spectrum window. Larger sizes resolve frequencies more precisely but respond more slowly and use more CPU.',
    type: 'select', defaultValue: String(ANALYSIS_SIZE),
    options: ANALYSIS_SIZES.map(size => ({ value: String(size), label: `${size} samples` })),
    apply: (value) => { settings.spectrumSize = Number(value); redraw(); },
  });
  preferencesManager.register({
    id: SPECTRUM_SPEED_ID, category: 'Patcher',
    label: 'Spectrum Analyser speed',
    description: 'Scroll speed multiplier in either flow direction. 1 is the normal speed; lower values slow the history down.',
    type: 'number', defaultValue: 1, min: 0.25, max: 4, step: 0.25,
    apply: (value) => { settings.spectrumSpeed = value; redraw(); },
  });
  return settings;
}
