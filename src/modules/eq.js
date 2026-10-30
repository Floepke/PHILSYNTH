// EQ: 16-band graphic equalizer. Controllers 0..15 are the band gains (20 Hz .. 20 kHz,
// 2/3 octave apart, ±12 dB), then the bandwidth (Q) shared by all bands and the output Level.
// The panel shows the frequency response; drag a band point up or down, double-click resets it.
// DSP: eq.dsp.js (C++: cpp/eq.h).
import { BANDS, MAX_DB, responseDb } from './eq.dsp.js';

const hz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(2)} kHz` : `${f} Hz`);
const dB = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

export const bandId = (i) => `b${i}`;
const VIEW_DB = 15; // the display spans ±VIEW_DB
const F_LO = 16;
const F_HI = 22000;

export function createEqView({ color = '#7a6aa8', values, setParam }) {
  const el = document.createElement('div');
  el.className = 'wave-view eq-view';
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'EQ frequency response');
  el.append(cv);
  const g = cv.getContext('2d');
  let vals = { ...values };
  const mod = {}; // live (modulated) controller values
  const val = (id) => (id in mod ? mod[id] : vals[id]);
  const gains = () => BANDS.map((_, i) => val(bandId(i)) ?? 0);

  const xOf = (f, w) => (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * w;
  const yOf = (db, h) => h / 2 - (db / VIEW_DB) * (h / 2 - 6);
  const dbAt = (y, h) => ((h / 2 - y) / (h / 2 - 6)) * VIEW_DB;

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    for (const db of [-12, -6, 6, 12]) { g.beginPath(); g.moveTo(0, yOf(db, h)); g.lineTo(w, yOf(db, h)); g.stroke(); }
    for (const f of [100, 1000, 10000]) { g.beginPath(); g.moveTo(xOf(f, w), 0); g.lineTo(xOf(f, w), h); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    const gs = gains();
    const q = val('q') ?? 2.1;
    const level = val('level') ?? 0;
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const f = F_LO * Math.pow(F_HI / F_LO, x / w);
      const y = Math.max(1, Math.min(h - 1, yOf(responseDb(gs, q, level, f), h)));
      if (x) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
    g.fillStyle = color;
    BANDS.forEach((f, i) => {
      g.beginPath();
      g.arc(xOf(f, w), yOf(gs[i], h), i === drag ? 5 : 3.5, 0, Math.PI * 2);
      g.fill();
    });
  };

  // pick the band nearest to the pointer (horizontally)
  const bandAt = (ev) => {
    const r = cv.getBoundingClientRect();
    const x = ev.clientX - r.left;
    let best = 0;
    BANDS.forEach((f, i) => { if (Math.abs(xOf(f, r.width) - x) < Math.abs(xOf(BANDS[best], r.width) - x)) best = i; });
    return best;
  };
  const pos = (ev) => {
    const r = cv.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top, w: r.width, h: r.height };
  };
  const setBand = (i, y, h) => {
    const v = Math.round(Math.max(-MAX_DB, Math.min(MAX_DB, dbAt(y, h))) * 10) / 10;
    if ((vals[bandId(i)] ?? 0) !== v) setParam?.(bandId(i), v);
  };
  // Drawing: every band whose x lies between the previous and the current
  // pointer position gets the height of the line between them, so a fast
  // sideways sweep does not skip bands.
  const paint = (a, b) => {
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    BANDS.forEach((f, i) => {
      const x = xOf(f, b.w);
      if (x < lo || x > hi) return;
      const t = hi > lo ? (x - a.x) / (b.x - a.x) : 1;
      setBand(i, a.y + (b.y - a.y) * t, b.h);
    });
    drag = bandAt({ clientX: b.x + cv.getBoundingClientRect().left });
    setBand(drag, b.y, b.h);
  };
  let drag = -1;
  let last = null;
  cv.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !setParam) return;
    ev.preventDefault();
    try { cv.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
    last = pos(ev);
    drag = bandAt(ev);
    setBand(drag, last.y, last.h);
  });
  cv.addEventListener('pointermove', (ev) => {
    if (drag < 0) return;
    const p = pos(ev);
    paint(last, p);
    last = p;
  });
  const end = () => { if (drag >= 0) { drag = -1; last = null; draw(); } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('dblclick', (ev) => setParam?.(bandId(bandAt(ev)), 0));
  cv.title = 'Drag to draw the bands (sideways sweeps set every band you pass); double-click resets a band to 0 dB';

  new ResizeObserver(draw).observe(cv);
  return {
    el,
    refresh(v) { vals = { ...v }; draw(); },
    modulate(id, v) {
      if (v === null) delete mod[id]; else mod[id] = v;
      draw();
    },
  };
}

export default {
  type: 'EQ',
  color: '#6a5fa8',
  label: '16-band equalizer',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    ...BANDS.map((f, i) => ({ id: bandId(i), label: hz(f), min: -MAX_DB, max: MAX_DB, default: 0, step: 0.1, format: dB })),
    { id: 'q', label: 'Bandwidth (Q)', min: 0.5, max: 8, default: 2.1, step: 0.01, scale: 'log', format: (v) => v.toFixed(2) },
    { id: 'level', label: 'Level', min: -24, max: 12, default: 0, step: 0.1, format: dB },
  ],
  create(_ctx, _def, host) {
    const node = host.dsp.create('eq');
    return {
      node,
      input: node,
      setParam: (id, v) => node.param(id, v),
      destroy: () => node.destroy(),
    };
  },
  view: (entry, api) => createEqView({ color: api.color, values: entry.values, setParam: api.setParam }),
};
