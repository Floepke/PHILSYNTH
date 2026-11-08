import { cleanColor, hexToRgb, rgbToHex } from './modcolor.js';

export const DEFAULT_WOOD_TINT = '#290000';
export const WOOD_TINT_KEY = 'philsynth:woodTint';
export const WOOD_TINT_ID = 'interface.woodTint';

export function initWoodTheme(preferencesManager) {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const textures = ['h', 'v'].map((axis) => {
    const url = style.getPropertyValue(`--wood-${axis}`).trim();
    const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1, -2));
    return { axis, svg };
  });

  function apply(tint) {
    // Keep detail visible even at pure black/white; tint only the material, not its children.
    const rgb = hexToRgb(tint).map((v) => Math.min(216, Math.max(24, v)));
    root.style.setProperty('--wood-tint', rgbToHex(...rgb));
    for (const { axis, svg } of textures) {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      doc.querySelector('rect[fill]').setAttribute('fill', rgbToHex(...rgb));
      for (const matrix of doc.querySelectorAll('feColorMatrix')) {
        const values = matrix.getAttribute('values').split(/\s+/).map(Number);
        const gray = values[4];
        rgb.forEach((v, i) => { values[i * 5 + 4] = gray * v / 88; });
        matrix.setAttribute('values', values.join(' '));
      }
      const image = new XMLSerializer().serializeToString(doc);
      root.style.setProperty(`--wood-${axis}`, `url("data:image/svg+xml,${encodeURIComponent(image)}")`);
    }
  }
  preferencesManager.register({
    id: WOOD_TINT_ID,
    category: 'Interface',
    label: 'Wood Tint',
    type: 'color',
    defaultValue: DEFAULT_WOOD_TINT,
    description: 'Previewed on all wood surfaces. Saved for this browser or app, not the project. Extreme tints are softened to keep the grain visible.',
    apply,
  });
}

export async function migrateWoodTint(preferencesManager) {
  if (preferencesManager.hasStored(WOOD_TINT_ID)) return;
  const stored = localStorage.getItem(WOOD_TINT_KEY);
  if (stored === null) return;
  const tint = cleanColor(stored);
  if (!tint) throw new Error('Saved wood tint is invalid');
  await preferencesManager.save({ [WOOD_TINT_ID]: tint });
}
