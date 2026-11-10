import { capture, clamp } from './seq/surface.js';
import { ANALYSIS_SIZE } from './dsp/analysis.js';
import { Spectrum, dbFS } from './spectrum.js';

const DEFAULT_WIDTH = 280;
const FLOOR = -60;
const CEILING = 12;
const levelText = value => value > 0 ? `${dbFS(value).toFixed(1)} dBFS` : '-inf dBFS';
const percent = value => clamp((dbFS(value) - FLOOR) / (CEILING - FLOOR) * 100, 0, 100);

export function analysisHandle(entry) {
  if (!entry || entry.dead) return null;
  if (entry.def.isOutput) return entry.inst.input?.h ?? null;
  if (!entry.def.hasOutput || (entry.def.modulator && !(entry.def.audioThrough && entry.values.mode > 0))) return null;
  const signals = entry.inst.outSignals?.();
  if (signals && !signals.audio) return null;
  return entry.inst.node?.h ?? null;
}

export function createAnalysePanel({ host, panel, divider, controller, dsp, target, onChange }) {
  const label = panel.querySelector('.analyse-target');
  const state = panel.querySelector('.analyse-state');
  const peakReadout = panel.querySelector('.analyse-peak');
  const rmsReadout = panel.querySelector('.analyse-rms');
  const clip = panel.querySelector('.analyse-clip');
  const bars = [...panel.querySelectorAll('.analyse-channel')];
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
  let peakHold = [0, 0];

  function reset() {
    latest = null;
    levels = null;
    peakHold = [0, 0];
    clip.classList.remove('clipping');
    clip.textContent = 'No clipping';
    peakReadout.textContent = '-inf dBFS';
    rmsReadout.textContent = '-inf dBFS';
    for (const bar of bars) {
      bar.querySelector('.analyse-fill').style.width = '0%';
      bar.querySelector('.analyse-rms-line').style.left = '0%';
      bar.querySelector('.analyse-hold').style.left = '0%';
    }
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
    const left = 30, top = 12, right = w - 12, bottom = h - 24;
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
      g.fillText(String(db), 2, y + 3);
    }
    for (const hz of [20, 100, 1000, 10000]) {
      if (hz > high) continue;
      const x = xOf(hz);
      g.strokeStyle = '#303036';
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke();
      g.fillStyle = '#a0a0a8';
      g.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x - 6, h - 7);
    }
    if (latest) {
      levels = spectrum.measure(latest.samples);
      latest = null;
    }
    if (!levels) return;
    g.beginPath();
    // Max-bin aggregation retains narrow peaks when many high-frequency bins share a pixel.
    for (let x = left; x <= right; x++) {
      const lo = 20 * (high / 20) ** ((x - left) / (right - left));
      const hi = 20 * (high / 20) ** ((x + 1 - left) / (right - left));
      const first = Math.max(1, Math.floor(lo * ANALYSIS_SIZE / rate));
      const last = Math.min(levels.length - 1, Math.max(first, Math.ceil(hi * ANALYSIS_SIZE / rate)));
      let db = -100;
      for (let bin = first; bin <= last; bin++) db = Math.max(db, levels[bin]);
      if (x === left) g.moveTo(x, yOf(db)); else g.lineTo(x, yOf(db));
    }
    g.strokeStyle = '#65b4ff';
    g.lineWidth = 1.5;
    g.stroke();
  }

  function redraw() {
    if (active && !frame) frame = requestAnimationFrame(draw);
  }

  function refresh() {
    const next = target();
    label.textContent = next.label;
    label.title = next.label;
    const visible = width > 0 && panel.clientWidth > 0 && host.clientHeight > 0
      && !document.hidden && getComputedStyle(panel).visibility !== 'hidden';
    active = visible;
    const h = visible ? next.h : null;
    state.textContent = !visible ? 'Analysis paused' : h === null ? 'No audio output to analyse' : 'Stereo peak / RMS - dBFS (not LUFS)';
    if (h !== watched) {
      watched = h;
      dsp.analyse(h);
      reset();
    }
    if (!active && frame) { cancelAnimationFrame(frame); frame = 0; }
    if (!active) latest = null;
    divider.setAttribute('aria-valuenow', String(Math.round(panel.clientWidth)));
    divider.setAttribute('aria-valuemax', String(host.clientWidth));
    for (const bar of bars) bar.style.setProperty('--analyse-meter-width', `${bar.querySelector('.analyse-track').clientWidth}px`);
    redraw();
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
    const room = Math.max(0, host.clientWidth - controller.getBoundingClientRect().width - 2 * divider.getBoundingClientRect().width);
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
    const room = Math.max(0, host.clientWidth - controller.getBoundingClientRect().width - 2 * divider.getBoundingClientRect().width);
    width = e.key === 'Home' ? 0 : e.key === 'End' ? Math.min(DEFAULT_WIDTH, room)
      : clamp(panel.clientWidth + (e.key === 'ArrowLeft' ? 1 : -1) * (e.shiftKey ? 100 : 20), 0, room);
    apply();
    onChange();
  });
  panel.querySelector('.analyse-reset').onclick = () => { reset(); redraw(); };
  dsp.onAnalysis = data => {
    if (!active || watched === null || data.h !== watched) return;
    latest = data;
    rate = data.sampleRate;
    for (let i = 0; i < bars.length; i++) {
      peakHold[i] = Math.max(peakHold[i], data.peak[i]);
      bars[i].querySelector('.analyse-fill').style.width = `${percent(data.peak[i])}%`;
      bars[i].querySelector('.analyse-rms-line').style.left = `${percent(data.rms[i])}%`;
      bars[i].querySelector('.analyse-hold').style.left = `${percent(peakHold[i])}%`;
    }
    peakReadout.textContent = levelText(Math.max(...peakHold));
    rmsReadout.textContent = levelText(Math.sqrt((data.rms[0] ** 2 + data.rms[1] ** 2) / 2));
    if (data.peak.some(value => value > 1)) {
      clip.classList.add('clipping');
      clip.textContent = 'CLIPPING';
    }
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
