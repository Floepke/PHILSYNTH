// Custom module colours (patcher right-click menu: Set Color…). A module's `color` is a '#rrggbb'
// code, or null when it uses the stock colour of its type (def.color). Saved with the project;
// older projects have no `color` field and load with null, so they look as before.

const HEX = /^#[0-9a-f]{6}$/i;
const SHORT = /^#[0-9a-f]{3}$/i;

// '#RRGGBB' / '#rrggbb' -> '#rrggbb'; anything else -> null (the stock colour)
export const cleanColor = (c) => (typeof c === 'string' && HEX.test(c.trim()) ? c.trim().toLowerCase() : null);

// The colour a module is drawn with: its custom colour, else its type's. The Output module has
// no type colour (it stays light grey) unless it got a custom one.
export const colorOf = (entry) => entry?.color ?? (entry?.def.isOutput ? null : entry?.def.color ?? null);

// Stock colour of a module type as a '#rrggbb' code (the Output's light grey when it has none).
export function stockColor(def) {
  const c = def?.isOutput ? null : def?.color;
  if (typeof c === 'string' && SHORT.test(c)) return `#${[...c.slice(1)].map((d) => d + d).join('')}`.toLowerCase();
  return cleanColor(c) ?? '#c4c4c8';
}

export function hexToRgb(hex) {
  const c = cleanColor(hex) ?? '#000000';
  return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
}

const byte = (v) => Math.min(255, Math.max(0, Math.round(+v || 0)));
export const rgbToHex = (r, g, b) => `#${[r, g, b].map((v) => byte(v).toString(16).padStart(2, '0')).join('')}`;
