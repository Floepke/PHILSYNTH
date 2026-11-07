// Key map editor (PITCH2CTL's map, TUNING's pitch per key): one column per MIDI key (C-1 .. G9,
// 128 keys), with a key strip below it. Drag to draw the value of each key (the bottom of the
// range at the bottom, its top at the top; fast strokes fill the keys in between); Shift+drag
// draws a straight dashed line, and on release the keys under it snap onto it. The line through
// the columns is what a glide follows. The newest sounding note is marked at its exact pitch; the
// line below names the hovered key.
// Zoom: Ctrl/Cmd+wheel or the − / + buttons; scroll: Shift+wheel (or a sideways wheel) or drag the
// key strip. A bar under the octave names shows the visible part of the 128 keys.
// The defaults edit PITCH2CTL's 0..1 map; the hooks of createKeyMapView let TUNING show its
// pitches (or their cents away from equal temperament) on a range that follows the keys shown.
import { isBlack, noteName } from '../song.js';
import { KEYS, KEY_MAX, defaultMap, mapAt } from './pitch2ctl.dsp.js';

const LABELS = 12; // octave names below the key strip
const STRIP = 16; // the key strip
const PAD = 6; // above the graph (room for the line at the top of the range)
const DRAG = 3; // px the pointer moves before a click turns into drawing (pickFirst)
export const MIN_SPAN = 12; // most zoomed in: one octave across

export const keyLabel = (p) => `${noteName(p)} (${p})`;
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
// and the value lo..hi (default 0..1) at y
export const keyAtX = (x, w, start = 0, span = KEYS) => Math.max(0, Math.min(KEY_MAX, Math.floor(start + (x * span) / w)));
export function valueAtY(y, h, lo = 0, hi = 1) {
  const { top, gh } = layout(1, h);
  return Math.max(lo, Math.min(hi, hi - ((y - top) / gh) * (hi - lo)));
}

// a stroke from key a (shown value va) to key b (vb): every key from a to b on a straight line;
// `stored(key, shown)` turns a shown value into the map's value (default: the same)
export function drawLine(map, a, va, b, vb, stored = (_p, v) => v) {
  const out = map.slice();
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(KEY_MAX, Math.max(a, b));
  for (let p = lo; p <= hi; p++) out[p] = stored(p, a === b ? vb : va + ((vb - va) * (p - a)) / (b - a));
  return out;
}

// PITCH2CTL's buttons
const P2C_BUTTONS = [
  { text: 'Reset', title: 'Back to the default: a straight line over the 88-key piano, A0 = Out Min … C8 = Out Max', action: () => defaultMap() },
  { text: 'Invert', title: 'Flip every key upside down (Out Min ↔ Out Max)', action: (m) => m.map((v) => 1 - v) },
];

export function createKeyMapView({
  color = '#7d5fd1', map, getMap = () => map, playing = () => null, setState, beginEdit, endEdit,
  // hooks (the defaults: PITCH2CTL's 0..1 map)
  save = (keys) => setState?.({ map: keys }), // stores an edited map
  range = () => ({ lo: 0, hi: 1 }), // (keys, first, last visible key) -> shown values at the bottom / top
  shown = (_p, v) => v, // the map's value of key (or fractional pitch) p -> the value drawn
  stored = (_p, v) => v, // a drawn value of key p -> the map's value
  base = (r) => r.lo, // the bars grow from this shown value
  grid = () => [0, 0.25, 0.5, 0.75, 1], // shown values of the horizontal grid lines (range r)
  format = (_p, v) => pct(v), // the map's value of key p for the info line
  valueAt = mapAt, // the map's value at a fractional pitch (the playing note)
  reference = null, // (p) -> a shown value: a faint dashed line to compare with (e.g. equal temperament)
  buttons = P2C_BUTTONS, // { text, title, action(keys) -> new keys }
  pickFirst = false, // a click selects a key (onPick); drawing starts once the pointer moves
  onPick = null,
  hint = 'Drag to draw per key · Shift+drag: straight line',
  ariaLabel = 'Key map: one value per MIDI key',
} = {}) {
  const el = document.createElement('div');
  el.className = 'p2c-view';
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', ariaLabel);
  const info = document.createElement('div');
  info.className = 'p2c-info';
  const tools = document.createElement('div');
  tools.className = 'p2c-tools';
  el.append(cv, info, tools);
  const g = cv.getContext('2d');

  let keys = getMap().slice(); // the map shown (and drawn on)
  let source = getMap(); // the module's map it was copied from (an undo replaces it)
  let hover = null; // key under the pointer
  let picked = null; // key selected by a click (pickFirst)
  let lit = null; // pitch of the playing note
  let stroke = null; // { key, value } of the last freehand point
  let pending = null; // pickFirst: the pointer went down here and has not moved yet
  let line = null; // Shift+drag: { a, va, b, vb } in fractional keys and shown values
  let pan = null; // dragging the key strip: { x, start }
  let frozen = null; // the value range while drawing (it does not move under the pointer)
  let view = { start: 0, span: KEYS }; // the visible keys (zoom / scroll)

  const visible = () => ({ first: Math.max(0, Math.floor(view.start)), last: Math.min(KEY_MAX, Math.ceil(view.start + view.span)) });
  const curRange = () => {
    if (frozen) return frozen;
    const { first, last } = visible();
    const r = range(keys, first, last);
    return r.hi > r.lo ? r : { lo: r.lo - 0.5, hi: r.lo + 0.5 };
  };

  const commit = (next) => {
    keys = next;
    save(keys.slice());
    source = getMap();
    showInfo();
    draw();
  };

  const button = (text, title, onclick, className = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    if (className) b.className = className;
    b.onclick = onclick;
    tools.append(b);
    return b;
  };
  const zoomBy = (factor, at) => {
    const next = zoomView(view, factor, at ?? (lit !== null ? Math.max(0, Math.min(1, (lit + 0.5 - view.start) / view.span)) : 0.5));
    if (next.start === view.start && next.span === view.span) return;
    view = next;
    draw();
  };
  button('−', 'Zoom out (Ctrl+wheel over the map)', () => zoomBy(2), 'p2c-zoom');
  button('+', 'Zoom in (Ctrl+wheel over the map; Shift+wheel or drag the keys to scroll)', () => zoomBy(0.5), 'p2c-zoom');
  for (const { text, title, action } of buttons) button(text, title, () => { beginEdit?.(); commit(action(keys)); endEdit?.(); });

  function showInfo() {
    if (line) {
      const [a, va, b, vb] = line.a <= line.b ? [line.a, line.va, line.b, line.vb] : [line.b, line.vb, line.a, line.va];
      const ka = Math.max(0, Math.round(a));
      const kb = Math.min(KEY_MAX, Math.round(b));
      info.textContent = `Line ${noteName(ka)} → ${noteName(kb)}: ${format(ka, stored(ka, va))} → ${format(kb, stored(kb, vb))}`;
    } else if (hover !== null) info.textContent = `${keyLabel(hover)}: ${format(hover, keys[hover])}`;
    else if (lit !== null) info.textContent = `♪ ${noteName(Math.round(lit))}: ${format(lit, valueAt(keys, lit))}`;
    else if (picked !== null) info.textContent = `${keyLabel(picked)}: ${format(picked, keys[picked])}`;
    else info.textContent = hint;
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
    const { first, last } = visible();
    const r = curRange();
    const Y = (v) => top + ((r.hi - v) / (r.hi - r.lo)) * gh;
    const litKey = lit === null ? null : Math.max(0, Math.min(KEY_MAX, Math.round(lit)));

    g.save();
    g.beginPath();
    g.rect(0, top - PAD, w, gh + PAD);
    g.clip();
    // grid: the range's lines across, a line at every C (middle C brighter)
    g.fillStyle = 'rgba(255, 255, 255, 0.07)';
    for (const v of grid(r)) g.fillRect(0, Math.round(Y(v)), w, 1);
    for (let p = 0; p < KEYS; p += 12) {
      g.fillStyle = p === 60 ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.08)';
      g.fillRect(Math.round(L(p)), top, 1, gh);
    }
    // the playing / hovered / picked column
    for (const [p, a] of [[litKey, 0.22], [picked, 0.16], [hover, 0.12]]) {
      if (p === null) continue;
      g.fillStyle = `rgba(255, 255, 255, ${a})`;
      g.fillRect(L(p), top, cw, gh);
    }
    // one bar per key, and the line a glide follows
    const y0 = Y(Math.max(r.lo, Math.min(r.hi, base(r))));
    g.globalAlpha = 0.45;
    g.fillStyle = color;
    for (let p = first; p <= last; p++) {
      const y = Y(shown(p, keys[p]));
      g.fillRect(L(p), Math.min(y, y0), Math.max(1, cw - (cw > 3 ? 1 : 0)), Math.max(1, Math.abs(y0 - y)));
    }
    g.globalAlpha = 1;
    if (reference) {
      g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath();
      for (let p = first; p <= last; p++) g[p > first ? 'lineTo' : 'moveTo'](X(p), Y(reference(p)));
      g.stroke();
      g.setLineDash([]);
    }
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.lineJoin = 'round';
    g.beginPath();
    for (let p = first; p <= last; p++) g[p > first ? 'lineTo' : 'moveTo'](X(p), Y(shown(p, keys[p])));
    g.stroke();
    // the playing note's exact pitch (cents) and value
    if (lit !== null) {
      const x = X(lit);
      const y = Y(shown(lit, valueAt(keys, lit)));
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
    g.restore();

    // key strip: one column per key like the graph above (piano roll colours)
    for (let p = first; p <= last; p++) {
      g.fillStyle = p === litKey || p === picked ? color : isBlack(p) ? '#202128' : '#d7d8dd';
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
    const { lo, hi } = curRange();
    return {
      x, y,
      key: keyAtX(x, w, view.start, view.span),
      at: Math.max(0, Math.min(KEY_MAX, view.start + (x * view.span) / w - 0.5)),
      value: valueAtY(y, cv.clientHeight, lo, hi),
    };
  };
  const pick = (key) => {
    if (picked === key) return;
    picked = key;
    onPick?.(key);
  };
  const strokeTo = (from, to) => commit(drawLine(keys, from.key, from.value, to.key, to.value, stored));

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
    frozen = curRange();
    hover = p.key;
    if (pickFirst) pick(p.key);
    if (e.shiftKey) {
      beginEdit?.();
      line = { a: p.at, va: p.value, b: p.at, vb: p.value };
      showInfo();
      draw();
    } else if (pickFirst) {
      pending = p;
      showInfo();
      draw();
    } else {
      beginEdit?.();
      stroke = p;
      strokeTo(p, p);
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
    if (pending && Math.hypot(p.x - pending.x, p.y - pending.y) >= DRAG) {
      beginEdit?.();
      stroke = pending;
      pending = null;
    }
    if (!line && !stroke && !pending) cv.style.cursor = p.y >= layout(cv.clientWidth, cv.clientHeight).strip ? (view.span < KEYS ? 'grab' : 'default') : '';
    if (line) { line.b = p.at; line.vb = p.value; } else if (stroke) {
      strokeTo(stroke, p);
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
      if (hi < lo) next[Math.round(a)] = stored(Math.round(a), vb); // a click (or a line between two centres): one key
      for (let p = lo; p <= hi; p++) next[p] = stored(p, a === b ? vb : va + ((vb - va) * (p - a)) / (b - a));
      line = null;
      commit(next);
      endEdit?.();
    } else if (stroke) { stroke = null; endEdit?.(); }
    pending = null;
    if (frozen) { frozen = null; draw(); }
  };
  cv.addEventListener('pointerup', stop);
  cv.addEventListener('pointercancel', stop);
  cv.addEventListener('pointerleave', () => { if (!line && !stroke && !pending && hover !== null) { hover = null; showInfo(); draw(); } });
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
  return {
    el,
    tools,
    refresh: sync,
    redraw: () => { showInfo(); draw(); }, // a hook's answer changed (e.g. TUNING's Pitch / Cents view)
    keys: () => keys,
    picked: () => picked,
    pick: (key) => { pick(key); showInfo(); draw(); },
    // show `key` (zoom in to it when it is out of view)
    reveal: (key) => {
      if (key >= view.start && key + 1 <= view.start + view.span) return;
      view = clampView(key + 0.5 - view.span / 2, view.span);
      draw();
    },
  };
}
