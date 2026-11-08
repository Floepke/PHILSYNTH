export const SHOW_INPUT_GRID_ID = 'timeline.showInputGrid';
export const SHOW_VERTICAL_BARLINES_ID = 'timeline.showVerticalBarlines';

export function registerTimelinePreferences(preferencesManager, redraw = () => {}) {
  const display = { showInputGrid: true, showVerticalBarlines: true };
  for (const [id, key, label, description] of [
    [SHOW_INPUT_GRID_ID, 'showInputGrid', 'Show Input Grid', 'Show alternating dark and light input-grid bands across the timeline. This does not change snapping.'],
    [SHOW_VERTICAL_BARLINES_ID, 'showVerticalBarlines', 'Show Vertical Barlines', 'Show vertical barlines in the timeline lanes. Bar marks in the ruler remain visible.'],
  ]) {
    preferencesManager.register({
      id, category: 'Timeline', label, description,
      type: 'boolean', defaultValue: true,
      apply: (value) => { display[key] = value; redraw(); },
    });
  }
  return display;
}
