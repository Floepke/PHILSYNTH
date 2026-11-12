// ADSR editor of the OSC panel (below the waveform preview) and the ADSR module panel. Draws the envelope with the same
// stage curves the DSP plays (adsrcurve.js) and edits the real controllers: drag the peak (Attack
// time), the decay corner (Decay time, Sustain level), the release end (Release time) or a curve dot
// in the middle of a stage (up/down = that stage's Curve). Every value goes through api.setParam,
// clamped and stepped like its slider, so the graph and the controllers always agree. Double-click a
// handle to reset its controllers. Times use a log axis per stage (1 ms .. the controller's maximum,
// e.g. 10 s, in a fixed lane), the sustain plateau has a fixed width. The ranges come from the
// module's params, so OSC (Sustain 0..1) and ADSR (Sustain 0..100 %, Release up to 20 s) share it.
// Right-click: Copy / Paste ADSR between the envelope editors of all modules (app-internal clipboard).
import { FONT, WEIGHT } from '../font.js';
import { attackLevel, decayLevel, releaseLevel } from './adsrcurve.js';
import { showMenu } from '../seq/menu.js';
import { registerShortcutMenu } from '../shortcuts.js';

const T_MIN = 0.001;
const T_MAX = 10; // default lane range (OSC)
const PAD = 7;
const SUSTAIN_W = 0.16; // share of the width for the sustain plateau
const HIT = 10; // px
const CURVE_PER_PX = 2; // curve % per pixel of vertical drag

// Time (s) <-> share of a stage lane (0..1), log axis
export const timeFrac = (t, tMax = T_MAX) => Math.log(Math.min(tMax, Math.max(T_MIN, t)) / T_MIN) / Math.log(tMax / T_MIN) * 0.94 + 0.06;
export const fracTime = (f, tMax = T_MAX) => T_MIN * Math.pow(tMax / T_MIN, (Math.min(1, Math.max(0.06, f)) - 0.06) / 0.94);

// Lane ranges and the Sustain scale from the module's controllers
export function adsrRanges(params) {
  const max = (id, d) => params?.find((p) => p.id === id)?.max ?? d;
  return { attack: max('attack', T_MAX), decay: max('decay', T_MAX), release: max('release', T_MAX), sustain: max('sustain', 1) };
}

// Clamp and step a value like its slider
export function stepValue(p, v) {
  const s = p.step || 0;
  let x = Math.min(p.max, Math.max(p.min, v));
  if (s > 0) x = Math.min(p.max, Math.max(p.min, p.min + Math.round((x - p.min) / s) * s));
  return +x.toFixed(6);
}

// Handle positions of the envelope in a w x h canvas
export function adsrLayout(values, w, h, params) {
  const R = adsrRanges(params);
  const v = { ...values, sustain: values.sustain / R.sustain }; // level 0..1
  const lane = (w - 2 * PAD) * (1 - SUSTAIN_W) / 3;
  const top = PAD;
  const bottom = h - PAD;
  const yOf = (level) => bottom - level * (bottom - top);
  const x0 = PAD;
  const xA = x0 + lane * timeFrac(v.attack, R.attack);
  const xD = xA + lane * timeFrac(v.decay, R.decay);
  const xS = xD + (w - 2 * PAD) * SUSTAIN_W;
  const xR = xS + lane * timeFrac(v.release, R.release);
  const ys = yOf(v.sustain);
  return {
    R, v, lane, top, bottom, yOf, x0, xA, xD, xS, xR,
    peak: { x: xA, y: top },
    corner: { x: xD, y: ys },
    end: { x: xR, y: bottom },
    atkDot: { x: (x0 + xA) / 2, y: yOf(attackLevel(0.5, v.atkCurve)) },
    decDot: { x: (xA + xD) / 2, y: yOf(decayLevel(0.5, v.decCurve, v.sustain)) },
    relDot: { x: (xS + xR) / 2, y: yOf(releaseLevel(0.5, v.relCurve, v.sustain)) },
  };
}

// The envelope as a polyline (x, level) following the DSP curves
export function adsrPath(L, steps = 48) {
  const { v } = L;
  const pts = [[L.x0, 0]];
  for (let i = 1; i <= steps; i++) { const u = i / steps; pts.push([L.x0 + (L.xA - L.x0) * u, attackLevel(u, v.atkCurve)]); }
  for (let i = 1; i <= steps; i++) { const u = i / steps; pts.push([L.xA + (L.xD - L.xA) * u, decayLevel(u, v.decCurve, v.sustain)]); }
  pts.push([L.xS, v.sustain]);
  for (let i = 1; i <= steps; i++) { const u = i / steps; pts.push([L.xS + (L.xR - L.xS) * u, releaseLevel(u, v.relCurve, v.sustain)]); }
  return pts;
}

const HANDLES = ['peak', 'corner', 'end', 'atkDot', 'decDot', 'relDot'];
const RESET = { peak: ['attack'], corner: ['decay', 'sustain'], end: ['release'], atkDot: ['atkCurve'], decDot: ['decCurve'], relDot: ['relCurve'] };

export function handleAt(L, x, y) {
  let best = null;
  let bd = HIT;
  for (const k of HANDLES) {
    const d = Math.hypot(L[k].x - x, L[k].y - y);
    if (d <= bd) { bd = d; best = k; }
  }
  return best;
}

// New controller values for dragging handle `h` from `start` (values and pointer at pointerdown) to (x, y)
export function dragValues(h, start, x, y, L, params) {
  const P = (id) => params.find((p) => p.id === id);
  const v = start.values;
  const frac = (from) => (x - from) / L.lane;
  switch (h) {
    case 'peak': return { attack: stepValue(P('attack'), fracTime(frac(L.x0), L.R.attack)) };
    // Sustain first: leaving Sustain 0 must not drag Release along with Decay (envlink.js)
    case 'corner': return {
      sustain: stepValue(P('sustain'), ((L.bottom - y) / (L.bottom - L.top)) * L.R.sustain),
      decay: stepValue(P('decay'), fracTime(frac(L.xA), L.R.decay)),
    };
    case 'end': return { release: stepValue(P('release'), fracTime(frac(L.xS), L.R.release)) };
    default: {
      // up = bulge upward: a faster rise (attack +) or a slower fall (decay/release -)
      const id = h === 'atkDot' ? 'atkCurve' : h === 'decDot' ? 'decCurve' : 'relCurve';
      const dir = h === 'atkDot' ? 1 : -1;
      return { [id]: stepValue(P(id), v[id] + dir * (start.y - y) * CURVE_PER_PX) };
    }
  }
}

// "Attack 0.25 s" (OSC: label "Attack (s)", plain number) / "Attack 250 ms" (ADSR: own format)
export function handleText(p, vals) {
  const v = vals[p.id];
  if (p.format) return `${p.label} ${p.format(v, vals)}`;
  const secs = / \(s\)$/.test(p.label);
  return `${p.label.replace(/ \(s\)$/, '')} ${v}${secs ? ' s' : ''}`;
}

// App-internal ADSR clipboard: times in seconds, Sustain as a level 0..1 (OSC 0..1 vs ADSR 0..100 %)
let clipboard = null;
export const adsrClipboard = () => clipboard;

export function copyAdsr(values, params) {
  const R = adsrRanges(params);
  const c = { sustain: values.sustain / R.sustain };
  for (const id of ['attack', 'decay', 'release', 'atkCurve', 'decCurve', 'relCurve']) if (typeof values[id] === 'number') c[id] = values[id];
  return c;
}

// Controller changes for pasting `clip` into a module with `params`, clamped and stepped to its ranges.
// Order matters (envlink.js links Decay and Release at Sustain 0): Sustain first, Decay last, so
// with a pasted Sustain of 0 the copied Decay wins.
export function pasteAdsr(clip, params) {
  const out = {};
  for (const id of ['sustain', 'attack', 'atkCurve', 'release', 'relCurve', 'decay', 'decCurve']) {
    const p = params.find((q) => q.id === id);
    if (!p || typeof clip[id] !== 'number') continue;
    out[id] = stepValue(p, id === 'sustain' ? clip.sustain * adsrRanges(params).sustain : clip[id]);
  }
  return out;
}

export function createAdsrView({ color = '#db7c3d', values, params, setParam, beginEdit, endEdit }) {
  const el = document.createElement('div');
  el.className = 'wave-view adsr-view';
  el.setAttribute('data-editor-title', 'ADSR envelope');
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'ADSR envelope editor');
  cv.title = 'Drag the peak (Attack), the corner (Decay, Sustain), the end (Release) or a curve dot (up/down = Curve); double-click resets; right-click: copy / paste the envelope';
  el.append(cv);
  const g = cv.getContext('2d');
  let vals = { ...values };
  let drag = null;
  let hover = null;

  const size = () => ({ w: cv.clientWidth, h: cv.clientHeight });
  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size();
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const L = adsrLayout(vals, w, h, params);
    // stage separators
    g.strokeStyle = '#2c2c32';
    g.lineWidth = 1;
    g.beginPath();
    for (const x of [L.xA, L.xD, L.xS]) { const xx = Math.round(x) + 0.5; g.moveTo(xx, 0); g.lineTo(xx, h); }
    g.stroke();
    // envelope
    const pts = adsrPath(L);
    g.beginPath();
    pts.forEach(([x, lv], i) => (i ? g.lineTo(x, L.yOf(lv)) : g.moveTo(x, L.yOf(lv))));
    g.lineTo(L.xR, L.bottom);
    g.fillStyle = `color-mix(in srgb, ${color} 18%, transparent)`;
    g.fill();
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    pts.forEach(([x, lv], i) => (i ? g.lineTo(x, L.yOf(lv)) : g.moveTo(x, L.yOf(lv))));
    g.stroke();
    // handles: squares for times/levels, round dots for curves
    for (const k of HANDLES) {
      const p = L[k];
      const on = k === (drag?.h ?? hover);
      g.fillStyle = on ? '#fff' : color;
      g.strokeStyle = '#111';
      g.lineWidth = 1;
      g.beginPath();
      if (k.endsWith('Dot')) g.arc(p.x, p.y, on ? 4.5 : 3.5, 0, Math.PI * 2);
      else { const r = on ? 5 : 4; g.rect(p.x - r, p.y - r, 2 * r, 2 * r); }
      g.fill();
      g.stroke();
    }
    // value of the handle under the pointer / being dragged
    const k = drag?.h ?? hover;
    if (k) {
      const text = RESET[k].map((id) => handleText(params.find((q) => q.id === id), vals)).join('  ');
      g.font = `${WEIGHT} 10px ${FONT}`;
      g.fillStyle = '#ddd';
      g.textAlign = 'right';
      g.textBaseline = 'top';
      g.fillText(text, w - 6, 4);
    }
  };

  const pos = (ev) => {
    const r = cv.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const apply = (changes) => {
    for (const [id, v] of Object.entries(changes)) if (vals[id] !== v) { vals[id] = v; setParam(id, v); }
    draw();
  };
  cv.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !setParam) return;
    const p = pos(ev);
    const h = handleAt(adsrLayout(vals, cv.clientWidth, cv.clientHeight, params), p.x, p.y);
    if (!h) return;
    ev.preventDefault();
    try { cv.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
    beginEdit?.();
    // the layout of the drag start: the lanes stay put while a time handle moves
    drag = { h, y: p.y, values: { ...vals }, L: adsrLayout(vals, cv.clientWidth, cv.clientHeight, params) };
    draw();
  });
  cv.addEventListener('pointermove', (ev) => {
    const p = pos(ev);
    if (!drag) {
      const h = handleAt(adsrLayout(vals, cv.clientWidth, cv.clientHeight, params), p.x, p.y);
      if (h !== hover) { hover = h; cv.style.cursor = h ? (h.endsWith('Dot') ? 'ns-resize' : h === 'corner' ? 'move' : 'ew-resize') : ''; draw(); }
      return;
    }
    apply(dragValues(drag.h, drag, p.x, p.y, drag.L, params));
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    draw();
    endEdit?.();
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('lostpointercapture', end);
  cv.addEventListener('pointerleave', () => { if (!drag && hover) { hover = null; cv.style.cursor = ''; draw(); } });
  cv.addEventListener('dblclick', (ev) => {
    const p = pos(ev);
    const h = handleAt(adsrLayout(vals, cv.clientWidth, cv.clientHeight, params), p.x, p.y);
    if (!h || !setParam) return;
    beginEdit?.();
    apply(Object.fromEntries(RESET[h].map((id) => [id, params.find((q) => q.id === id).default])));
    endEdit?.();
  });

  const envelopeMenuItems = () => [
        { label: 'Copy ADSR', action: () => { clipboard = copyAdsr(vals, params); } },
        {
          label: 'Paste ADSR',
          disabled: !clipboard || !setParam,
          action: () => {
            beginEdit?.();
            const changes = pasteAdsr(clipboard, params);
            for (const [id, v] of Object.entries(changes)) { vals[id] = v; setParam(id, v); }
            draw();
            endEdit?.();
          },
        },
      ];
  registerShortcutMenu('envelope', envelopeMenuItems, { active: () => cv.isConnected && document.activeElement === cv });
  cv.tabIndex = 0;
  cv.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    cv.focus();
    showMenu({ x: ev.clientX, y: ev.clientY, items: envelopeMenuItems(), shortcutScope: 'envelope' });
  });

  new ResizeObserver(draw).observe(cv);
  return {
    el,
    refresh(v) { vals = { ...v }; draw(); },
  };
}
