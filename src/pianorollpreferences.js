export const SNAP_VELOCITY_ID = 'pianoroll.snapVelocity';
export const ALTERNATE_STAVE_COLORS_ID = 'pianoroll.alternateStaveColors';

export function registerPianorollPreferences(preferencesManager, redraw = () => {}) {
  const settings = { snapVelocity: true, alternateStaveColors: true };
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
  return settings;
}
