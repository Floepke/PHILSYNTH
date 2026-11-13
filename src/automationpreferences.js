export const MARGIN_SIZE_ID = 'automation.marginSize';
export const DEFAULT_MARGIN_SIZE = 200;

export function registerAutomationPreferences(preferencesManager, redraw = () => {}) {
  const settings = { marginSize: DEFAULT_MARGIN_SIZE };
  preferencesManager.register({
    id: MARGIN_SIZE_ID, category: 'Automation Editor',
    label: 'Margin Size',
    description: 'Empty space in px (0-400) left and right of the value range, like the margins beside the pianoroll stave. Narrow editors use less, so the value range stays usable.',
    type: 'number', defaultValue: DEFAULT_MARGIN_SIZE, min: 0, max: 400, step: 1,
    validate: (value) => Number.isInteger(value) && value >= 0 && value <= 400,
    apply: (value) => { settings.marginSize = value; redraw(); },
  });
  return settings;
}
