// DISTORTION panel chart: every Type on its own row, fed by a sine that gets louder from left to
// right (MIN_GAIN … MAX_GAIN, one cycle per band). Drawn with the kernel's own transfer function
// and the current Bit Depth; the current Power is marked. Click a row to pick that Type.
import { distortionShape } from './distortion.dsp.js';

export const BANDS = 8;
export const MIN_GAIN = 0.25;
export const MAX_GAIN = 4;
const ROW_H = 30;
const LABEL_H = 11;

export const gainAt = (u) => MIN_GAIN * (MAX_GAIN / MIN_GAIN) ** Math.min(1, Math.max(0, u));
export const gainPos = (gain) => Math.log(Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain)) / MIN_GAIN) / Math.log(MAX_GAIN / MIN_GAIN);

export function crush(y, bits) {
  if (bits >= 16) return y;
  const q = 2 ** (bits - 1);
  return Math.max(-q, Math.min(q - 1, Math.floor(y * q + 0.5))) / q;
}

// n output samples of one row (u = 0..1 across the row)
export function previewPoints(type, bits = 16, n = 512) {
  return Array.from({ length: n }, (_, i) => {
    const u = i / (n - 1);
    const x = gainAt(u) * Math.sin(2 * Math.PI * BANDS * u);
    return crush(distortionShape(x, type), bits);
  });
}

export function createDistortionView({ color = '#ad643b', values, options, setParam, beginEdit, endEdit }) {
  const el = document.createElement('div');
  el.className = 'wave-view dist-view';
  el.setAttribute('data-editor-title', 'Distortion types');
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  cv.title = 'Every distortion type with a sine getting louder from left to right. Click a row to select it.';
  el.append(cv);
  el.style.height = `${options.length * ROW_H}px`;
  const g = cv.getContext('2d');
  let state = { type: values.type, power: values.power, bits: values.bits };

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const n = Math.max(128, Math.round(w * 2));
    const powerX = gainPos(state.power) * w;
    options.forEach((name, type) => {
      const top = type * ROW_H;
      const selected = type === state.type;
      for (let b = 0; b < BANDS; b++) {
        g.fillStyle = b % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.055)';
        g.fillRect((b * w) / BANDS, top, w / BANDS, ROW_H);
      }
      if (selected) {
        g.fillStyle = color;
        g.globalAlpha = 0.18;
        g.fillRect(0, top, w, ROW_H);
        g.globalAlpha = 1;
      }
      // dark name strip: its lower edge is the top (+full scale) of the wave area
      g.fillStyle = '#0d0d0e';
      g.fillRect(0, top, w, LABEL_H);
      if (selected) {
        g.fillStyle = color;
        g.globalAlpha = 0.3;
        g.fillRect(0, top, w, LABEL_H);
        g.globalAlpha = 1;
      }
      const mid = top + LABEL_H + (ROW_H - LABEL_H) / 2;
      const amp = (ROW_H - LABEL_H) / 2 - 2;
      g.strokeStyle = '#2c2c32';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, Math.round(mid) + 0.5);
      g.lineTo(w, Math.round(mid) + 0.5);
      g.moveTo(0, top + ROW_H - 0.5);
      g.lineTo(w, top + ROW_H - 0.5);
      g.stroke();
      g.save();
      g.beginPath();
      g.rect(0, top + LABEL_H, w, ROW_H - LABEL_H);
      g.clip();
      g.strokeStyle = selected ? color : '#8b8b94';
      g.lineWidth = selected ? 1.6 : 1;
      g.lineJoin = 'round';
      g.beginPath();
      previewPoints(type, state.bits, n).forEach((y, i) => {
        const x = (i / (n - 1)) * w;
        const py = mid - Math.max(-1.15, Math.min(1.15, y)) * amp;
        if (i) g.lineTo(x, py); else g.moveTo(x, py);
      });
      g.stroke();
      g.restore();
      g.fillStyle = selected ? '#f2f2f4' : '#9a9aa2';
      g.font = `${selected ? 600 : 500} 9px system-ui, sans-serif`;
      g.textBaseline = 'top';
      g.fillText(name, 4, top + 1);
    });
    g.strokeStyle = '#f2f2f4';
    g.globalAlpha = 0.55;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(Math.round(powerX) + 0.5, 0);
    g.lineTo(Math.round(powerX) + 0.5, h);
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
    cv.setAttribute('aria-label', `Distortion types preview, ${options[state.type]} selected, Power ${state.power.toFixed(2)}, ${state.bits} bit`);
  };

  cv.addEventListener('click', (e) => {
    const type = Math.floor((e.clientY - cv.getBoundingClientRect().top) / ROW_H);
    if (type < 0 || type >= options.length || type === state.type) return;
    beginEdit?.();
    setParam(type);
    endEdit?.();
  });

  new ResizeObserver(draw).observe(cv);
  return {
    el,
    refresh(v) {
      if (v.type === state.type && v.power === state.power && v.bits === state.bits) return;
      state = { type: v.type, power: v.power, bits: v.bits };
      draw();
    },
  };
}
