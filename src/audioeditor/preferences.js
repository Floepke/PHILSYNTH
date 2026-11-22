export const AUDIO_MARGIN_SIZE_ID = 'audioEditor.marginSize';
export const DEFAULT_AUDIO_MARGIN_SIZE = 200;

export function registerAudioEditorPreferences(preferencesManager, redraw = () => {}) {
  const settings = { marginSize: DEFAULT_AUDIO_MARGIN_SIZE };
  preferencesManager.register({
    id: AUDIO_MARGIN_SIZE_ID, category: 'Audio Editor',
    label: 'Margin Size',
    description: 'Empty space in px (0-400) on each side of the waveform. Narrow editors use less to keep the waveform usable.',
    type: 'number', defaultValue: DEFAULT_AUDIO_MARGIN_SIZE, min: 0, max: 400, step: 1,
    validate: (value) => Number.isInteger(value) && value >= 0 && value <= 400,
    apply: (value) => { settings.marginSize = value; redraw(); },
  });
  return settings;
}
