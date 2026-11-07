import { cleanColor, hexToRgb, rgbToHex } from './modcolor.js';

export const DEFAULT_WOOD_TINT = '#290000';
export const WOOD_TINT_KEY = 'philsynth:woodTint';

export function initWoodTheme(onError) {
  const root = document.documentElement;
  const dialog = document.getElementById('wood-dialog');
  const sliders = ['r', 'g', 'b'].map((c) => document.getElementById(`wood-${c}`));
  const outputs = ['r', 'g', 'b'].map((c) => document.getElementById(`wood-${c}-val`));
  const note = document.getElementById('wood-note');
  const error = document.getElementById('wood-error');
  const style = getComputedStyle(root);
  const textures = ['h', 'v'].map((axis) => {
    const url = style.getPropertyValue(`--wood-${axis}`).trim();
    const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1, -2));
    return { axis, svg };
  });
  let saved = DEFAULT_WOOD_TINT;

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

  try {
    const stored = localStorage.getItem(WOOD_TINT_KEY);
    if (stored !== null) {
      saved = cleanColor(stored);
      if (!saved) {
        saved = DEFAULT_WOOD_TINT;
        onError('Saved wood tint is invalid; using charcoal gray.');
      }
    }
  } catch (err) {
    onError(`Could not load wood tint: ${err.message}`);
  }
  apply(saved);

  const chosen = () => rgbToHex(...sliders.map((s) => +s.value));
  function preview() {
    const rgb = sliders.map((s) => +s.value);
    sliders.forEach((s, i) => {
      const lo = [...rgb]; lo[i] = 0;
      const hi = [...rgb]; hi[i] = 255;
      s.style.setProperty('--track', `linear-gradient(to right, ${rgbToHex(...lo)}, ${rgbToHex(...hi)})`);
      outputs[i].textContent = rgb[i];
    });
    note.textContent = `Wood tint ${chosen()} (live preview)`;
    error.textContent = '';
    apply(chosen());
  }
  function set(tint) {
    hexToRgb(tint).forEach((v, i) => { sliders[i].value = v; });
    preview();
  }
  for (const slider of sliders) slider.addEventListener('input', preview);
  document.getElementById('wood-reset').addEventListener('click', () => set(DEFAULT_WOOD_TINT));
  dialog.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.submitter?.value !== 'ok') {
      dialog.close('cancel');
      return;
    }
    try {
      localStorage.setItem(WOOD_TINT_KEY, chosen());
    } catch (err) {
      error.textContent = `Could not save wood tint: ${err.message}`;
      return;
    }
    saved = chosen();
    dialog.close('ok');
  });
  dialog.addEventListener('close', () => apply(saved));

  return () => {
    if (dialog.open) return;
    dialog.returnValue = '';
    set(saved);
    dialog.showModal();
    sliders[0].focus();
  };
}
