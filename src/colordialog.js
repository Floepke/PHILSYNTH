// Set Color… (patcher right-click menu): three wooden R / G / B sliders and a preview of the
// module box as it will look after OK. Reset color goes back to the stock colour of the type.
import { colorOf, stockColor, hexToRgb, rgbToHex, cleanColor } from './modcolor.js';
import { MODULE_COLOR_PALETTE, nearestModuleColorIndex } from './modulecolorpalette.js';

const $ = (id) => document.getElementById(id);
const CHANNELS = ['r', 'g', 'b'];
const PALETTE_WINDOW_SIZE = 9;
const PALETTE_WINDOW_HALF = Math.floor(PALETTE_WINDOW_SIZE / 2);

function wrapPaletteIndex(index) {
  return (index % MODULE_COLOR_PALETTE.length + MODULE_COLOR_PALETTE.length) % MODULE_COLOR_PALETTE.length;
}

function paletteGradient(index) {
  const colors = Array.from({ length: PALETTE_WINDOW_SIZE }, (_, offset) =>
    MODULE_COLOR_PALETTE[wrapPaletteIndex(index + offset - PALETTE_WINDOW_HALF)]);
  return `linear-gradient(to right, ${colors.map((color, i) => {
    const start = (i / colors.length * 100).toFixed(4);
    const end = ((i + 1) / colors.length * 100).toFixed(4);
    return `${color} ${start}% ${end}%`;
  }).join(', ')})`;
}

// Resolves with the chosen colour: '#rrggbb', null (the stock colour) or undefined (cancelled).
// `entry` is the module shown in the preview (the first one when several are recoloured).
export function openColorDialog(entry, { name, count = 1, clip = false } = {}) {
  const dialog = $('color-dialog');
  const sample = $('color-sample');
  const palette = $('color-palette');
  const sliders = CHANNELS.map((c) => $(`color-${c}`));
  const outs = CHANNELS.map((c) => $(`color-${c}-val`));
  const stock = stockColor(entry.def);
  let isStock = !cleanColor(entry.color); // untouched stock colour: OK keeps null
  let paletteDrag = null;

  sample.dataset.id = entry.id; // the Output (#0) keeps its own look
  sample.classList.toggle('patch', entry.def.type === 'PATCH');
  sample.querySelector('.module-name').textContent = name ?? entry.def.type;
  sample.querySelector('.module-name').classList.toggle('custom', !!entry.name);
  sample.querySelector('.module-id').textContent = entry.id;
  $('color-title').textContent = count > 1 ? `Color of ${count} ${clip ? 'clips' : 'modules'}` : `Color of ${name ?? entry.def.type} #${entry.id}`;
  $('color-reset').textContent = clip ? 'Use module color' : 'Reset color';
  $('color-reset').title = clip ? 'Inherit the connected module color' : 'Back to the stock color of the module type';

  const hex = () => rgbToHex(...sliders.map((s) => +s.value));
  const show = () => {
    const rgb = sliders.map((s) => +s.value);
    sliders.forEach((s, i) => {
      // each track runs through its channel with the other two as they are now
      const lo = [...rgb]; lo[i] = 0;
      const hi = [...rgb]; hi[i] = 255;
      s.style.setProperty('--track', `linear-gradient(to right, ${rgbToHex(...lo)}, ${rgbToHex(...hi)})`);
      outs[i].textContent = rgb[i];
    });
    const index = nearestModuleColorIndex(hex());
    palette.setAttribute('aria-valuenow', index);
    palette.setAttribute('aria-valuetext', hex());
    palette.style.setProperty('--palette-position', '50%');
    palette.style.backgroundImage = paletteGradient(index);
    const shown = isStock ? colorOf({ def: entry.def, color: null }) : hex();
    if (shown) sample.style.setProperty('--mod-color', shown); else sample.style.removeProperty('--mod-color');
    $('color-note').textContent = isStock ? (clip ? `Module color (${stock})` : `Stock color of ${entry.def.isOutput ? 'Output' : entry.def.type} (${stock})`) : `Custom color ${hex()}`;
  };
  const set = (c) => hexToRgb(c).forEach((v, i) => { sliders[i].value = v; });
  const choosePalette = (index) => {
    const color = MODULE_COLOR_PALETTE[wrapPaletteIndex(index)];
    set(color);
    isStock = !clip && color === stock && !entry.def.isOutput;
    show();
  };
  const pointerDown = (event) => {
    if (event.button !== 0) return;
    if (event.isTrusted) palette.setPointerCapture(event.pointerId);
    paletteDrag = { index: nearestModuleColorIndex(hex()), x: event.clientX };
    event.preventDefault();
  };
  const pointerMove = (event) => {
    if (!paletteDrag || !(event.buttons & 1)) return;
    const width = palette.getBoundingClientRect().width;
    if (width <= 0) return;
    const steps = Math.round((paletteDrag.x - event.clientX) / (width / PALETTE_WINDOW_SIZE));
    choosePalette(paletteDrag.index + steps);
  };
  const pointerUp = () => { paletteDrag = null; };
  const paletteWheel = (event) => {
    const delta = event.deltaY || event.deltaX;
    if (!delta) return;
    event.preventDefault();
    choosePalette(nearestModuleColorIndex(hex()) + Math.sign(delta));
  };
  const paletteKey = (event) => {
    const current = nearestModuleColorIndex(hex());
    const next = {
      ArrowLeft: current - 1, ArrowDown: current - 1,
      ArrowRight: current + 1, ArrowUp: current + 1,
      Home: 0, End: MODULE_COLOR_PALETTE.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    choosePalette(next);
  };

  set(cleanColor(entry.color) ?? stock);
  for (const s of sliders) s.oninput = () => { isStock = !clip && hex() === stock && !entry.def.isOutput; show(); };
  $('color-reset').onclick = () => { isStock = true; set(stock); show(); };
  palette.addEventListener('pointerdown', pointerDown);
  palette.addEventListener('pointermove', pointerMove);
  palette.addEventListener('pointerup', pointerUp);
  palette.addEventListener('pointercancel', pointerUp);
  palette.addEventListener('wheel', paletteWheel, { passive: false });
  palette.addEventListener('keydown', paletteKey);
  show();

  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => {
      for (const s of sliders) s.oninput = null;
      $('color-reset').onclick = null;
      paletteDrag = null;
      palette.removeEventListener('pointerdown', pointerDown);
      palette.removeEventListener('pointermove', pointerMove);
      palette.removeEventListener('pointerup', pointerUp);
      palette.removeEventListener('pointercancel', pointerUp);
      palette.removeEventListener('wheel', paletteWheel);
      palette.removeEventListener('keydown', paletteKey);
      if (dialog.returnValue !== 'ok') resolve(undefined);
      else resolve(isStock ? null : hex());
    }, { once: true });
    dialog.showModal();
    sliders[0].focus();
  });
}

export function openClipColorDialog(clip, moduleColor, count = 1) {
  return openColorDialog({
    id: clip.id, name: clip.name, color: clip.color,
    def: { type: 'Clip', color: moduleColor },
  }, { name: clip.name, count, clip: true });
}
