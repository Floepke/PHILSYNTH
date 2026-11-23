export const SNAP_VELOCITY_ID = 'pianoroll.snapVelocity';
export const ALTERNATE_STAVE_COLORS_ID = 'pianoroll.alternateStaveColors';
export const STAVE_BRIGHTNESS_ID = 'pianoroll.staveBrightness';
export const DEFAULT_STAVE_BRIGHTNESS = 10;

export function registerPianorollPreferences(preferencesManager, redraw = () => {}) {
  const settings = { snapVelocity: true, alternateStaveColors: true, staveBrightness: DEFAULT_STAVE_BRIGHTNESS };
  preferencesManager.register({
    id: SNAP_VELOCITY_ID, category: 'Pianoroll',
    label: 'Snap velocity values to 16 step grid.',
    description: 'Snap edited velocity values to 1/16 increments. Existing values are not changed.',
    type: 'boolean', defaultValue: true,
    apply: (value) => { settings.snapVelocity = value; redraw(); },
  });
  preferencesManager.register({
    id: ALTERNATE_STAVE_COLORS_ID, category: 'Pianoroll',
    label: 'Alternate stave colors by octave',
    description: 'Alternate light and dark stave lines by octave. Turn off to make all stave lines dark.',
    type: 'boolean', defaultValue: true,
    apply: (value) => { settings.alternateStaveColors = value; redraw(); },
  });
  preferencesManager.register({
    id: STAVE_BRIGHTNESS_ID, category: 'Pianoroll',
    label: 'Alternate stave brightness (%)',
    description: 'Brightness of the tinted alternating octave lines, from dark (0) to light (100).',
    type: 'number', defaultValue: DEFAULT_STAVE_BRIGHTNESS, min: 0, max: 100, step: 1,
    validate: Number.isInteger,
    apply: (value) => { settings.staveBrightness = value; redraw(); },
  });
  return settings;
}
