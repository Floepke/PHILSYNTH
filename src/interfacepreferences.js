export const PANEL_DIVIDER_WIDTH_ID = 'interface.controllerPanelDividerWidth';

export function registerInterfacePreferences(preferencesManager) {
  preferencesManager.register({
    id: PANEL_DIVIDER_WIDTH_ID,
    category: 'Interface',
    label: 'Controller Panel Divider Width',
    type: 'number',
    defaultValue: 48,
    min: 10,
    max: 128,
    step: 1,
    validate: Number.isInteger,
    description: 'Width in px (10-128). The minimum fits the grip with padding. App scaling still applies; other dividers are unchanged.',
    apply: (width) => document.documentElement.style.setProperty('--panel-divider-width', `${width}px`),
  });
}
