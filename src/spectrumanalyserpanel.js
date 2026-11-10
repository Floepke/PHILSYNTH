import { capture, clamp } from './seq/surface.js';
import { ANALYSIS_SIZE } from './dsp/analysis.js';
import { Spectrum } from './spectrum.js';

const DEFAULT_WIDTH = 280;

export function analysisHandle(entry) {
  if (!entry || entry.dead) return null;
  if (entry.def.isOutput) return entry.inst.input?.h ?? null;
  if (!entry.def.hasOutput || (entry.def.modulator && !(entry.def.audioThrough && entry.values.mode > 0))) return null;
  const signals = entry.inst.outSignals?.();
  if (signals && !signals.audio) return null;
  return entry.inst.node?.h ?? null;
}

export function createSpectrumAnalyserPanel({ host, panel, divider, controller, dsp, target, onChange }) {
  const cv = panel.querySelector('canvas');
  const g = cv.getContext('2d');
  const spectrum = new Spectrum();
  let width = DEFAULT_WIDTH;
  let watched = null;
  let active = false;
  let frame = 0;
  let latest = null;
  let levels = null;
  let rate = 48000;

  function reset() {
    latest = null;
    levels = null;
  }

  function draw() {
    frame = 0;
    if (!active) return;
    const box = cv.getBoundingClientRect();
    const w = Math.round(box.width), h = Math.round(box.height);
    if (w < 1 || h < 1) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
    if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#151517';
    g.fillRect(0, 0, w, h);
    const left = 0, top = 0, right = w - 1, bottom = h - 1;
    if (right <= left || bottom <= top) return;
    const high = Math.min(20000, rate / 2);
    const xOf = hz => left + Math.log(hz / 20) / Math.log(high / 20) * (right - left);
    const yOf = db => top + (12 - clamp(db, -100, 12)) / 112 * (bottom - top);
    g.font = '10px monospace';
    g.lineWidth = 1;
    for (const db of [0, -24, -48, -72, -96]) {
      const y = yOf(db);
      g.strokeStyle = db === 0 ? '#88463e' : '#303036';
      g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
      g.fillStyle = '#a0a0a8';
      g.fillText(String(db), 2, clamp(y + 3, 10, h - 2));
    }
    for (const hz of [20, 100, 1000, 10000]) {
      if (hz > high) continue;
      const x = xOf(hz);
      g.strokeStyle = '#303036';
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
      g.fillStyle = '#a0a0a8';
      const text = hz >= 1000 ? `${hz / 1000}k` : String(hz);
      g.fillText(text, clamp(x - 6, 2, Math.max(2, w - g.measureText(text).width - 2)), h - 3);
    }
    if (latest) {
      levels = spectrum.measure(latest.samples);
      latest = null;
    }
    if (!levels) return;
    g.beginPath();
    let previousY = 0;
    // Interpolate sparse low-frequency bins; retain narrow peaks where bins share a pixel.
    for (let x = left; x <= right; x++) {
      const lo = 20 * (high / 20) ** ((x - left) / (right - left));
      const hi = 20 * (high / 20) ** ((x + 1 - left) / (right - left));
      const bin = clamp(lo * ANALYSIS_SIZE / rate, 1, levels.length - 1);
      const first = Math.floor(bin);
      const last = Math.min(levels.length - 1, Math.floor(hi * ANALYSIS_SIZE / rate));
      const a = clamp(levels[first], -100, 12);
      const b = clamp(levels[Math.min(first + 1, levels.length - 1)], -100, 12);
      let db = a + (b - a) * (bin - first);
      if ((hi - lo) * ANALYSIS_SIZE / rate >= 1) {
        for (let i = first + 1; i <= last; i++) db = Math.max(db, levels[i]);
      }
      const y = yOf(db);
      if (x === left) g.moveTo(x, y);
      else g.quadraticCurveTo(x - 1, previousY, x - 0.5, (previousY + y) / 2);
      previousY = y;
    }
    g.lineTo(right, previousY);
    g.strokeStyle = '#65b4ff';
    g.lineWidth = 1.5;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.stroke();
  }

  function redraw() {
    if (active && !frame) frame = requestAnimationFrame(draw);
  }

  function refresh() {
    const visible = width > 0 && panel.clientWidth > 0 && host.clientHeight > 0
      && !document.hidden && getComputedStyle(panel).visibility !== 'hidden';
    active = visible;
    const h = visible ? target() : null;
    if (h !== watched) {
      watched = h;
      dsp.analyse(h);
      reset();
    }
    if (!active && frame) { cancelAnimationFrame(frame); frame = 0; }
    if (!active) latest = null;
    divider.setAttribute('aria-valuenow', String(Math.round(panel.clientWidth)));
    divider.setAttribute('aria-valuemax', String(host.clientWidth));
    redraw();
  }

  function availableWidth() {
    return Math.max(0, host.clientWidth - controller.getBoundingClientRect().width
      - controller.nextElementSibling.getBoundingClientRect().width
      - divider.getBoundingClientRect().width);
  }

  function apply() {
    host.style.setProperty('--analyse-width', `${width}px`);
    panel.classList.toggle('collapsed', width === 0);
    refresh();
  }

  divider.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const before = width;
    const start = panel.getBoundingClientRect().width;
    const x = e.clientX;
    const room = availableWidth();
    capture(divider, e, ev => {
      width = clamp(start + x - ev.clientX, 0, room);
      apply();
    }, ev => {
      if (ev.type === 'pointercancel') { width = before; apply(); }
      else onChange();
    });
  });
  divider.addEventListener('keydown', e => {
    if (e.target !== divider || e.ctrlKey || e.metaKey || e.altKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const room = availableWidth();
    width = e.key === 'Home' ? 0 : e.key === 'End' ? Math.min(DEFAULT_WIDTH, room)
      : clamp(panel.clientWidth + (e.key === 'ArrowLeft' ? 1 : -1) * (e.shiftKey ? 100 : 20), 0, room);
    apply();
    onChange();
  });
  dsp.onAnalysis = data => {
    if (!active || watched === null || data.h !== watched) return;
    latest = data;
    rate = data.sampleRate;
    redraw();
  };
  const observer = new ResizeObserver(refresh);
  observer.observe(panel);
  observer.observe(host);
  document.addEventListener('visibilitychange', refresh);
  apply();
  return {
    refresh,
    viewState: () => ({ width }),
    applyView(view) {
      width = Number.isFinite(view?.width) ? Math.max(0, view.width) : DEFAULT_WIDTH;
      apply();
    },
  };
}
