import { clamp } from './seq/surface.js';
import { ANALYSIS_SIZE } from './dsp/analysis.js';
import { Spectrum } from './spectrum.js';

export function analysisHandle(entry) {
  if (!entry || entry.dead) return null;
  if (entry.def.isOutput) return entry.inst.input?.h ?? null;
  if (!entry.def.hasOutput || (entry.def.modulator && !(entry.def.audioThrough && entry.values.mode > 0))) return null;
  const signals = entry.inst.outSignals?.();
  if (signals && !signals.audio) return null;
  return entry.inst.node?.h ?? null;
}

export function createSpectrumAnalyserPanel({ host, panel, button, dsp, target, onChange }) {
  const cv = panel.querySelector('canvas');
  const g = cv.getContext('2d');
  const spectrum = new Spectrum();
  const history = document.createElement('canvas');
  const ink = history.getContext('2d');
  let enabled = true;
  let watched = null;
  let active = false;
  let frame = 0;
  let latest = null;
  let rate = 48000;

  function draw() {
    frame = 0;
    if (!active) return;
    const box = cv.getBoundingClientRect();
    const w = Math.round(box.width), h = Math.round(box.height);
    if (w < 1 || h < 1) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
    if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
    if (history.width !== cv.width || history.height !== cv.height) {
      const saved = document.createElement('canvas');
      saved.width = history.width;
      saved.height = history.height;
      saved.getContext('2d').drawImage(history, 0, 0);
      history.width = cv.width;
      history.height = cv.height;
      ink.drawImage(saved, 0, 0, saved.width, saved.height, 0, 0, history.width, history.height);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const left = 0, top = 0, right = w - 1, bottom = h - 1;
    if (right <= left || bottom <= top) return;
    const high = Math.min(20000, rate / 2);
    const xOf = hz => left + Math.log(hz / 20) / Math.log(high / 20) * (right - left);
    if (latest) {
      const levels = latest.samples.some(value => value !== 0) ? spectrum.measure(latest.samples) : null;
      latest = null;
      const rowHeight = Math.min(history.height, Math.max(1, Math.round(dpr)));
      ink.globalCompositeOperation = 'copy';
      ink.drawImage(history, 0, -rowHeight);
      ink.globalCompositeOperation = 'source-over';
      ink.clearRect(0, history.height - rowHeight, history.width, rowHeight);
      const tint = levels ? getComputedStyle(panel).getPropertyValue('--wood-tint').trim() : null;
      // One full-rate spectrum per row; silence stays transparent above the noise background.
      for (let x = 0; levels && x < history.width; x++) {
        const position = x / dpr;
        const lo = 20 * (high / 20) ** (position / right);
        const hi = 20 * (high / 20) ** ((position + 1 / dpr) / right);
        const bin = clamp(lo * ANALYSIS_SIZE / rate, 1, levels.length - 1);
        const first = Math.floor(bin);
        const last = Math.min(levels.length - 1, Math.floor(hi * ANALYSIS_SIZE / rate));
        const a = clamp(levels[first], -100, 12);
        const b = clamp(levels[Math.min(first + 1, levels.length - 1)], -100, 12);
        let db = a + (b - a) * (bin - first);
        if ((hi - lo) * ANALYSIS_SIZE / rate >= 1) {
          for (let i = first + 1; i <= last; i++) db = Math.max(db, levels[i]);
        }
        const strength = clamp((db + 100) / 100, 0, 1);
        ink.globalAlpha = strength;
        ink.fillStyle = `color-mix(in srgb, ${tint} ${100 - 55 * strength}%, white)`;
        ink.fillRect(x, history.height - rowHeight, 1, rowHeight);
      }
      ink.globalAlpha = 1;
    }
    g.drawImage(history, 0, 0, w, h);
    g.font = '10px monospace';
    g.lineWidth = 1;
    for (const hz of [20, 100, 1000, 10000]) {
      if (hz > high) continue;
      const x = xOf(hz);
      g.strokeStyle = 'rgba(160, 160, 168, 0.25)';
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
      g.fillStyle = 'rgba(160, 160, 168, 0.7)';
      const text = hz >= 1000 ? `${hz / 1000}k` : String(hz);
      g.fillText(text, clamp(x - 6, 2, Math.max(2, w - g.measureText(text).width - 2)), 12);
    }
  }

  function redraw() {
    if (active && !frame) frame = requestAnimationFrame(draw);
  }

  function refresh() {
    const visible = enabled && panel.clientWidth > 0 && host.clientHeight > 0
      && !document.hidden && getComputedStyle(panel).visibility !== 'hidden';
    active = visible;
    const h = visible ? target() : null;
    if (h !== watched) {
      watched = h;
      dsp.analyse(h);
      latest = null;
    }
    if (!active && frame) { cancelAnimationFrame(frame); frame = 0; }
    if (!active) latest = null;
    redraw();
  }

  function apply() {
    panel.classList.toggle('collapsed', !enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.title = `${enabled ? 'Hide' : 'Show'} spectrum analyser`;
    refresh();
  }

  button.addEventListener('pointerdown', e => e.stopPropagation());
  button.addEventListener('click', () => {
    enabled = !enabled;
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
    viewState: () => ({ enabled }),
    applyView(view) {
      enabled = typeof view?.enabled === 'boolean' ? view.enabled : view?.attached === true || view?.width !== 0;
      apply();
    },
  };
}
