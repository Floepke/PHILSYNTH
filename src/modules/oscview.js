// Waveform display of the OSC panel: two cycles of the current Waveform + Duty Cycle, drawn with
// the same shape() the audio worklet plays. Follows live modulation of the duty (LFO / ADSR).
import { shape } from './oscshape.js';

const CYCLES = 2;
const DISPLAY_INC = 1 / 4096; // as if a low note: band-limiting barely rounds the edges

// Samples of `cycles` periods (n points), scaled so the largest peak reaches ±1.
export function waveformPoints(wave, duty, n = 256, cycles = CYCLES) {
  const d = Math.min(1, Math.max(0, duty / 100));
  const ys = Array.from({ length: n }, (_, i) => shape(wave, ((i / (n - 1)) * cycles) % 1, d, DISPLAY_INC));
  const peak = Math.max(1, ...ys.map(Math.abs));
  return ys.map((y) => y / peak);
}

export function createWaveView({ color = '#c0713a', values }) {
  const el = document.createElement('div');
  el.className = 'wave-view';
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  el.append(cv);
  const g = cv.getContext('2d');
  let wave = values.wave;
  let duty = values.duty;
  let modDuty = null; // live (modulated) duty, null = follow the controller

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
    const pad = 6;
    const mid = h / 2;
    const amp = mid - pad;
    g.strokeStyle = '#2c2c32';
    g.lineWidth = 1;
    g.beginPath();
    for (let c = 1; c < CYCLES; c++) { const x = Math.round((w * c) / CYCLES) + 0.5; g.moveTo(x, 0); g.lineTo(x, h); }
    g.moveTo(0, Math.round(mid) + 0.5);
    g.lineTo(w, Math.round(mid) + 0.5);
    g.stroke();
    const d = modDuty ?? duty;
    const ys = waveformPoints(wave, d, Math.max(64, Math.round(w * 2)));
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    ys.forEach((y, i) => {
      const x = (i / (ys.length - 1)) * w;
      if (i) g.lineTo(x, mid - y * amp); else g.moveTo(x, mid - y * amp);
    });
    g.stroke();
    cv.setAttribute('aria-label', `Waveform preview, duty ${d.toFixed(1)} %`);
  };

  new ResizeObserver(draw).observe(cv);
  return {
    el,
    refresh(v) {
      if (v.wave === wave && v.duty === duty) return;
      wave = v.wave;
      duty = v.duty;
      draw();
    },
    modulate(id, v) {
      if (id !== 'duty' || v === modDuty) return;
      modDuty = v;
      draw();
    },
  };
}
