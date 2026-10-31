// Horizontal level bar for module views (INPUT level, COMPRESSOR gain reduction).
//   createMeter({ label, min, max, color, text(v) }) -> { el, set(value) }
// The bar fills from the left by (value - min) / (max - min).
export function createMeter({ label, min, max, color, text }) {
  const el = document.createElement('div');
  el.className = 'meter';
  el.setAttribute('role', 'meter');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-valuemin', min);
  el.setAttribute('aria-valuemax', max);
  const name = document.createElement('span');
  name.className = 'meter-label';
  name.textContent = label;
  const bar = document.createElement('span');
  bar.className = 'meter-bar';
  const fill = document.createElement('span');
  fill.className = 'meter-fill';
  fill.style.background = color;
  bar.append(fill);
  const out = document.createElement('output');
  out.className = 'meter-value';
  el.append(name, bar, out);
  let last = NaN;
  const set = (v) => {
    if (v === last) return;
    last = v;
    const x = Math.min(1, Math.max(0, (v - min) / (max - min)));
    fill.style.transform = `scaleX(${x})`;
    out.textContent = text(v);
    el.setAttribute('aria-valuenow', v);
  };
  set(min);
  return { el, set };
}
