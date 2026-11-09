export const SNAP_VELOCITY_ID = 'pianoroll.snapVelocity';

export function registerPianorollPreferences(preferencesManager, redraw = () => {}) {
  const settings = { snapVelocity: true };
  preferencesManager.register({
    id: SNAP_VELOCITY_ID, category: 'Pianoroll',
    label: 'Snap velocity values to 16 step grid.',
    description: 'Snap edited velocity values to 1/16 increments. Existing values are not changed.',
    type: 'boolean', defaultValue: true,
    apply: (value) => { settings.snapVelocity = value; redraw(); },
  });
  return settings;
}
