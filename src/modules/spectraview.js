import { defaultSpectraState, normalizeSpectraState, SPECTRA_PARTIALS } from './spectra.sample.js';

const TABS = [
  { key: 'levels', label: 'Amp', min: 0, max: 100, unit: '%' },
  { key: 'detunes', label: 'Pitch', min: -100, max: 100, unit: '%' },
];
const PAD = { left: 40, right: 10, top: 12, bottom: 26 };
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function createSpectraEditor(entry, api) {
  let state = normalizeSpectraState(entry.state);
  let tab = 0;
  let selected = 0;
  let painting = false;
  let last = null;
  let erase = false;
  const el = document.createElement('div');
  el.className = 'spectra-editor';
  el.dataset.editorTitle = 'Overtone editor';
  const tabs = document.createElement('div');
  tabs.className = 'spectra-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Overtone graphs');
  const panel = document.createElement('div');
  panel.setAttribute('role', 'tabpanel');
  const buttons = TABS.map((item, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => selectTab(i));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      selectTab((tab + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length);
      buttons[tab].focus();
    });
    tabs.append(button);
    return button;
  });
  const canvas = document.createElement('canvas');
  canvas.title = 'Drag to draw overtones. Right-drag resets values to zero.';
  const tools = document.createElement('div');
  tools.className = 'spectra-tools';
  const partialLabel = document.createElement('label');
  partialLabel.textContent = 'Overtone ';
  const partial = document.createElement('input');
  partial.type = 'number';
  partial.min = '1';
  partial.max = String(SPECTRA_PARTIALS);
  partial.step = '1';
  partialLabel.append(partial);
  const valueLabel = document.createElement('label');
  const valueText = document.createElement('span');
  const value = document.createElement('input');
  value.type = 'number';
  value.step = '0.1';
  valueLabel.append(valueText, value);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset tab';
  tools.append(partialLabel, valueLabel, reset);
  const hint = document.createElement('p');
  hint.className = 'hint';
  panel.append(canvas, tools, hint);
  el.append(tabs, panel);
  const g = canvas.getContext('2d');

  function selectTab(i) {
    endStroke();
    tab = i;
    buttons.forEach((button, index) => {
      button.setAttribute('aria-selected', String(index === tab));
      button.tabIndex = index === tab ? 0 : -1;
    });
    const item = TABS[tab];
    panel.setAttribute('aria-label', `${item.label} overtone graph`);
    canvas.setAttribute('aria-label', `${item.label}: overtone 1 to ${SPECTRA_PARTIALS} horizontally, ${item.min} to ${item.max} percent vertically`);
    valueText.textContent = `${item.label} (%) `;
    value.min = String(item.min);
    value.max = String(item.max);
    hint.textContent = tab === 0 ? 'Drag to set amplitudes (0–100%). Right-drag clears. The combined loop is peak-limited.'
      : 'Pitch: −100% reaches the previous harmonic; +100% reaches the next. Right-drag restores harmonic tuning.';
    draw();
  }

  function draw() {
    partial.value = String(selected + 1);
    value.value = String(state[TABS[tab].key][selected]);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pw = w - PAD.left - PAD.right;
    const ph = h - PAD.top - PAD.bottom;
    const item = TABS[tab];
    const yOf = (v) => PAD.top + ph * (1 - (v - item.min) / (item.max - item.min));
    g.fillStyle = '#17191e';
    g.fillRect(0, 0, w, h);
    g.font = '10px monospace';
    g.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = item.min + (item.max - item.min) * i / 4;
      const y = yOf(v);
      g.strokeStyle = v === 0 ? '#767982' : '#34363d';
      g.beginPath(); g.moveTo(PAD.left, y); g.lineTo(w - PAD.right, y); g.stroke();
      g.fillStyle = '#b7bac2';
      g.textAlign = 'right';
      g.fillText(`${v}`, PAD.left - 6, y);
    }
    const bw = pw / SPECTRA_PARTIALS;
    const zero = yOf(0);
    for (let i = 0; i < SPECTRA_PARTIALS; i++) {
      const x = PAD.left + i * bw;
      const y = yOf(state[item.key][i]);
      g.fillStyle = i === selected ? '#fff' : api.color;
      g.fillRect(x + 0.5, Math.min(y, zero), Math.max(1, bw - 1), Math.max(1, Math.abs(y - zero)));
      if (i === 0 || (i + 1) % 16 === 0) {
        g.fillStyle = '#b7bac2';
        g.textAlign = 'center';
        g.fillText(String(i + 1), x + bw / 2, h - 10);
      }
    }
  }

  function commit() {
    api.setState(state);
    state = normalizeSpectraState(entry.state);
    draw();
  }

  function pointAt(event) {
    const rect = canvas.getBoundingClientRect();
    const pw = rect.width - PAD.left - PAD.right;
    const ph = rect.height - PAD.top - PAD.bottom;
    if (pw <= 0 || ph <= 0) return null;
    const x = event.clientX - rect.left - PAD.left;
    const y = event.clientY - rect.top - PAD.top;
    const item = TABS[tab];
    return {
      index: clamp(Math.floor(x / pw * SPECTRA_PARTIALS), 0, SPECTRA_PARTIALS - 1),
      value: erase ? 0 : Math.round(clamp(item.max - y / ph * (item.max - item.min), item.min, item.max) * 10) / 10,
    };
  }

  function paint(event) {
    const point = pointAt(event);
    if (!point) return;
    const values = [...state[TABS[tab].key]];
    const start = last ?? point;
    const steps = Math.max(1, Math.abs(point.index - start.index));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      values[Math.round(start.index + (point.index - start.index) * t)] = Math.round((start.value + (point.value - start.value) * t) * 10) / 10;
    }
    selected = point.index;
    state = { ...state, [TABS[tab].key]: values };
    last = point;
    commit();
  }

  function endStroke() {
    if (!painting) return;
    painting = false;
    last = null;
    api.endEdit();
  }
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    if (event.isTrusted) canvas.setPointerCapture(event.pointerId);
    api.beginEdit();
    state = normalizeSpectraState(entry.state);
    painting = true;
    erase = event.button === 2;
    last = null;
    paint(event);
  });
  canvas.addEventListener('pointermove', (event) => { if (painting) paint(event); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, endStroke);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  partial.addEventListener('change', () => {
    if (!Number.isFinite(partial.valueAsNumber)) { draw(); return; }
    selected = clamp(Math.round(partial.valueAsNumber) - 1, 0, SPECTRA_PARTIALS - 1);
    draw();
  });
  value.addEventListener('change', () => {
    if (!Number.isFinite(value.valueAsNumber)) { draw(); return; }
    api.beginEdit();
    state = normalizeSpectraState(entry.state);
    const item = TABS[tab];
    state[item.key][selected] = clamp(value.valueAsNumber, item.min, item.max);
    commit();
    api.endEdit();
  });
  reset.addEventListener('click', () => {
    api.beginEdit();
    state = { ...normalizeSpectraState(entry.state), [TABS[tab].key]: defaultSpectraState()[TABS[tab].key] };
    commit();
    api.endEdit();
  });
  new ResizeObserver(draw).observe(canvas);
  selectTab(0);
  return { el, refresh() { if (!painting) state = normalizeSpectraState(entry.state); draw(); } };
}
