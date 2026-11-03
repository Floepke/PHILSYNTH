// PITCH2CTL panel editor: the key map, one column per MIDI key (C-1 .. G9, 128 keys), with a key
// strip below it. Drag to draw the value of each key (Out Min at the bottom, Out Max at the top;
// fast strokes fill the keys in between); Shift+drag draws a straight dashed line, and on release
// the keys under it snap onto it. The line through the columns is what a glide follows. The
// newest sounding note is marked at its exact pitch; the line below names the hovered key.
// Zoom: Ctrl/Cmd+wheel or the − / + buttons; scroll: Shift+wheel (or a sideways wheel) or drag the
// key strip. A bar under the octave names shows the visible part of the 128 keys.
import { isBlack, noteName } from '../song.js';
import { KEYS, KEY_MAX, defaultMap, mapAt } from './pitch2ctl.dsp.js';

const LABELS = 12; // octave names below the key strip
const STRIP = 16; // the key strip
const PAD = 6; // above the graph (room for the line at Out Max)
export const MIN_SPAN = 12; // most zoomed in: one octave across

const label = (p) => `${noteName(p)} (${p})`;
const pct = (v) => `${Math.round(v * 100)} %`;

// canvas layout for a canvas w x h: column width, graph top / height, key strip top
export function layout(w, h) {
  const gh = h - PAD - STRIP - LABELS - 2;
  return { cw: w / KEYS, top: PAD, gh, strip: PAD + gh + 2 };
}
// the visible keys: `span` keys from key `start` (fractional), kept inside 0..128
export function clampView(start, span) {
  const s = Math.max(MIN_SPAN, Math.min(KEYS, span));
  return { start: Math.max(0, Math.min(KEYS - s, start)), span: s };
}
// zoom by `factor` (< 1 zooms in) keeping the key under x (0..1 across the canvas) in place
export function zoomView({ start, span }, factor, at = 0.5) {
  const next = Math.max(MIN_SPAN, Math.min(KEYS, span * factor));
  return clampView(start + (span - next) * at, next);
}
// the key under x on a canvas w wide showing `span` keys from `start` (clamped to 0..127),
// and the value 0..1 at y
export const keyAtX = (x, w, start = 0, span = KEYS) => Math.max(0, Math.min(KEY_MAX, Math.floor(start + (x * span) / w)));
export function valueAtY(y, h) {
  const { top, gh } = layout(1, h);
  return Math.max(0, Math.min(1, 1 - (y - top) / gh));
}

// a stroke from key a (value va) to key b (value vb): every key from a to b on a straight line
export function drawLine(map, a, va, b, vb) {
  const out = map.slice();
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(KEY_MAX, Math.max(a, b));
  for (let p = lo; p <= hi; p++) out[p] = a === b ? vb : va + ((vb - va) * (p - a)) / (b - a);
  return out;
}

export function createKeyMapView({ color = '#7d5fd1', map, getMap = () => map, playing = () => null, setState, beginEdit, endEdit }) {
  const el = document.createElement('div');
  el.className = 'p2c-view';
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'Key map: one value per MIDI key');
  const info = document.createElement('div');
  info.className = 'p2c-info';
  const tools = document.createElement('div');
  tools.className = 'p2c-tools';
  const button = (text, title, action) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.onclick = () => { beginEdit?.(); commit(action(keys)); endEdit?.(); };
    tools.append(b);
  };
  el.append(cv, info, tools);
  const g = cv.getContext('2d');

  let keys = getMap().slice(); // the map shown (and drawn on)
  let source = getMap(); // the module's map it was copied from (an undo replaces it)
  let hover = null; // key under the pointer
  let lit = null; // pitch of the playing note
  let stroke = null; // { key, value } of the last freehand point
  let line = null; // Shift+drag: { a, va, b, vb } in fractional keys
  let pan = null; // dragging the key strip: { x, start }
  let view = { start: 0, span: KEYS }; // the visible keys (zoom / scroll)

  const commit = (next) => {
    keys = next;
    setState?.({ map: keys.slice() });
    source = getMap();
    showInfo();
    draw();
  };

  const zoomBy = (factor, at) => {
    const next = zoomView(view, factor, at ?? (lit !== null ? Math.max(0, Math.min(1, (lit + 0.5 - view.start) / view.span)) : 0.5));
    if (next.start === view.start && next.span === view.span) return;
    view = next;
    draw();
  };
  const zoomButton = (text, title, factor) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'p2c-zoom';
    b.textContent = text;
    b.title = title;
    b.onclick = () => zoomBy(factor);
    tools.append(b);
  };
  zoomButton('−', 'Zoom out (Ctrl+wheel over the map)', 2);
  zoomButton('+', 'Zoom in (Ctrl+wheel over the map; Shift+wheel or drag the keys to scroll)', 0.5);
  button('Reset', 'Back to the default: a straight line over the 88-key piano, A0 = Out Min … C8 = Out Max', () => defaultMap());
  button('Invert', 'Flip every key upside down (Out Min ↔ Out Max)', (m) => m.map((v) => 1 - v));

  function showInfo() {
    if (line) {
      const a = Math.round(Math.min(line.a, line.b));
      const b = Math.round(Math.max(line.a, line.b));
      info.textContent = `Line ${noteName(Math.max(0, a))} → ${noteName(Math.min(KEY_MAX, b))}: ${pct(line.a <= line.b ? line.va : line.vb)} → ${pct(line.a <= line.b ? line.vb : line.va)}`;
    } else if (hover !== null) info.textContent = `${label(hover)}: ${pct(keys[hover])}`;
    else if (lit !== null) info.textContent = `♪ ${noteName(Math.round(lit))}: ${pct(mapAt(keys, lit))}`;
    else info.textContent = 'Drag to draw per key · Shift+drag: straight line';
  }

  function draw() {
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
    const { top, gh, strip } = layout(w, h);
    const { start, span } = view;
    const cw = w / span;
    const L = (p) => (p - start) * cw; // left edge of key p
    const X = (p) => L(p + 0.5); // centre of key p (fractional keys too)
    const first = Math.max(0, Math.floor(start));
    const last = Math.min(KEY_MAX, Math.ceil(start + span));
    const Y = (v) => top + (1 - v) * gh;
    const litKey = lit === null ? null : Math.max(0, Math.min(KEY_MAX, Math.round(lit)));

    // grid: quarters across, a line at every C (middle C brighter)
    g.fillStyle = 'rgba(255, 255, 255, 0.07)';
    for (const v of [0, 0.25, 0.5, 0.75, 1]) g.fillRect(0, Math.round(Y(v)), w, 1);
    for (let p = 0; p < KEYS; p += 12) {
      g.fillStyle = p === 60 ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.08)';
      g.fillRect(Math.round(L(p)), top, 1, gh);
    }
    // the playing / hovered column
    for (const [p, a] of [[litKey, 0.22], [hover, 0.12]]) {
      if (p === null) continue;
      g.fillStyle = `rgba(255, 255, 255, ${a})`;
      g.fillRect(L(p), top, cw, gh);
    }
    // one bar per key, and the line a glide follows
    g.globalAlpha = 0.45;
    g.fillStyle = color;
    for (let p = first; p <= last; p++) {
      const y = Y(keys[p]);
      g.fillRect(L(p), y, Math.max(1, cw - (cw > 3 ? 1 : 0)), top + gh - y);
    }
    g.globalAlpha = 1;
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.lineJoin = 'round';
    g.beginPath();
    for (let p = first; p <= last; p++) g[p > first ? 'lineTo' : 'moveTo'](X(p), Y(keys[p]));
    g.stroke();
    // the playing note's exact pitch (cents) and value
    if (lit !== null) {
      const x = X(lit);
      const y = Y(mapAt(keys, lit));
      g.fillStyle = '#fff';
      g.fillRect(Math.round(x) - 0.5, top, 1, gh);
      g.beginPath();
      g.arc(x, y, 3.5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.stroke();
    }
    // Shift+drag: the straight line the keys snap onto on release
    if (line) {
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.moveTo(X(line.a), Y(line.va));
      g.lineTo(X(line.b), Y(line.vb));
      g.stroke();
      g.setLineDash([]);
    }

    // key strip: one column per key like the graph above (piano roll colours)
    for (let p = first; p <= last; p++) {
      g.fillStyle = p === litKey ? color : isBlack(p) ? '#202128' : '#d7d8dd';
      g.fillRect(L(p), strip, cw + 0.5, STRIP);
      if (p < KEY_MAX && !isBlack(p) && !isBlack(p + 1)) { // E|F and B|C
        g.fillStyle = 'rgba(0, 0, 0, 0.45)';
        g.fillRect(Math.round(L(p + 1)) - 0.5, strip, 1, STRIP);
      }
    }
    if (hover !== null) {
      g.strokeStyle = isBlack(hover) ? '#fff' : color;
      g.lineWidth = 1;
      g.strokeRect(L(hover) + 0.5, strip + 0.5, Math.max(1, cw - 1), STRIP - 1);
    }
    // octave names under every C
    g.fillStyle = '#8a8c96';
    g.font = '500 9px system-ui, sans-serif';
    g.textBaseline = 'top';
    for (let p = 0; p < KEYS; p += 12) {
      const x = Math.round(L(p));
      if (x < 0 || x >= w) continue;
      g.fillRect(x, strip + STRIP, 1, 3);
      if (x + 14 < w) g.fillText(noteName(p), x + 2, strip + STRIP + 1);
    }
    // zoomed: where the visible keys are among all 128
    if (span < KEYS) {
      g.fillStyle = 'rgba(255, 255, 255, 0.1)';
      g.fillRect(0, h - 2, w, 2);
      g.fillStyle = color;
      g.fillRect((start / KEYS) * w, h - 2, Math.max(4, (span / KEYS) * w), 2);
    }
  }

  // the pointer in the canvas content box (inside its border)
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left - cv.clientLeft;
    const y = e.clientY - r.top - cv.clientTop;
    const w = cv.clientWidth;
    return {
      x, y,
      key: keyAtX(x, w, view.start, view.span),
      at: Math.max(0, Math.min(KEY_MAX, view.start + (x * view.span) / w - 0.5)),
      value: valueAtY(y, cv.clientHeight),
    };
  };

  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const p = pos(e);
    if (p.y >= layout(cv.clientWidth, cv.clientHeight).strip) { // the key strip: scroll
      pan = { x: p.x, start: view.start };
      cv.style.cursor = 'grabbing';
      return;
    }
    beginEdit?.();
    hover = p.key;
    if (e.shiftKey) {
      line = { a: p.at, va: p.value, b: p.at, vb: p.value };
      showInfo();
      draw();
    } else {
      stroke = p;
      commit(drawLine(keys, p.key, p.value, p.key, p.value));
    }
  });
  cv.addEventListener('pointermove', (e) => {
    const p = pos(e);
    if (pan) {
      const next = clampView(pan.start - ((p.x - pan.x) * view.span) / cv.clientWidth, view.span);
      if (next.start !== view.start) { view = next; draw(); }
      return;
    }
    hover = p.key;
    if (!line && !stroke) cv.style.cursor = p.y >= layout(cv.clientWidth, cv.clientHeight).strip ? (view.span < KEYS ? 'grab' : 'default') : '';
    if (line) { line.b = p.at; line.vb = p.value; } else if (stroke) {
      commit(drawLine(keys, stroke.key, stroke.value, p.key, p.value));
      stroke = p;
      return;
    }
    showInfo();
    draw();
  });
  const stop = () => {
    if (pan) { pan = null; cv.style.cursor = ''; return; }
    if (line) {
      // the keys whose centres the line covers take its value there
      const { a, va, b, vb } = line;
      const next = keys.slice();
      const lo = Math.ceil(Math.min(a, b) - 1e-9);
      const hi = Math.floor(Math.max(a, b) + 1e-9);
      if (hi < lo) next[Math.round(a)] = vb; // a click (or a line between two centres): one key
      for (let p = lo; p <= hi; p++) next[p] = a === b ? vb : va + ((vb - va) * (p - a)) / (b - a);
      line = null;
      commit(next);
      endEdit?.();
    } else if (stroke) { stroke = null; endEdit?.(); }
  };
  cv.addEventListener('pointerup', stop);
  cv.addEventListener('pointercancel', stop);
  cv.addEventListener('pointerleave', () => { if (!line && !stroke && hover !== null) { hover = null; showInfo(); draw(); } });
  // Ctrl/Cmd+wheel zooms around the pointer, Shift+wheel (or a sideways wheel) scrolls; a plain
  // wheel keeps scrolling the panel
  cv.addEventListener('wheel', (e) => {
    const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomBy(Math.exp(e.deltaY * 0.0025), Math.max(0, Math.min(1, pos(e).x / cv.clientWidth)));
    } else if (e.shiftKey || sideways) {
      if (view.span >= KEYS) return;
      e.preventDefault();
      const d = sideways ? e.deltaX : e.deltaY;
      const next = clampView(view.start + (d * view.span) / cv.clientWidth, view.span);
      if (next.start !== view.start) { view = next; draw(); }
    }
  }, { passive: false });

  // follow the module's map (undo / redo) and the playing note (set by the module on the main thread)
  const sync = () => {
    const m = getMap();
    if (m !== source && !line && !stroke) { source = m; keys = m.slice(); showInfo(); draw(); }
  };
  const tick = () => {
    if (!el.isConnected && el.dataset.started) return;
    if (el.isConnected) el.dataset.started = '1';
    sync();
    const n = playing();
    const pitch = n ? Math.max(0, Math.min(KEY_MAX, n.pitch)) : null;
    if (pitch !== lit) { lit = pitch; showInfo(); draw(); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  new ResizeObserver(draw).observe(cv);
  showInfo();
  return { el, refresh: sync };
}
