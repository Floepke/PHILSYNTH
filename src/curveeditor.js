// Classic curve editor on a canvas (used by the WAVESHAPER and ENVELOPE panels).
//   Double-click: add a point (keep the second press held to drag it right away, see doublepress.js)
//   Drag a point: move it (the end points move up/down only)
//   Scroll on a point: round its corner  Right-click a point: delete it
// createCurveEditor({ curve, color, labels, onChange, identity, formatX, formatY })
//   -> { el, set(curve), setLabels(labels), setPlayhead(x) }
//   onChange(curve) is called with a new curve object on every edit.
//   identity: draw the dashed no-change diagonal; formatX / formatY: point readout in the info line.
//   mapping: probe the curve at the pointer's x, with guides and an in-graph readout.
//   setPlayhead(x): a white dot riding the curve at x (0..1), null hides it (ENVELOPE playback).
import { MIN_GAP, NEW_POINT_ROUND, curvePolyline, normalizeCurve, sampleAt } from './curve.js';
import { doublePress } from './doublepress.js';

const PAD = 12;
const HIT = 9; // px
const ROUND_STEP = 0.05;

const IN = (x) => `in ${x.toFixed(3)}`;
const OUT = (y) => `out ${y.toFixed(3)}`;

export function createCurveEditor({ curve, color = '#c0a040', labels = {}, onChange, beginEdit, endEdit, identity = true, mapping = false, formatX = IN, formatY = OUT }) {
  let pts = normalizeCurve(curve).points;
  let hover = -1;
  let drag = -1;
  let cursor = null; // {x, y} in curve units while the mouse is over the graph
  let playhead = null; // x of the playback dot, or null
  const presses = doublePress();

  const el = document.createElement('div');
  el.className = 'curve-editor';
  const canvas = document.createElement('canvas');
  const info = document.createElement('div');
  info.className = 'curve-info';
  const help = document.createElement('p');
  help.className = 'hint';
  help.innerHTML = '<kbd>Double-click</kbd> adds a point (hold the second click to drag it), drag moves it, <kbd>scroll</kbd> on a point rounds its corner, <kbd>right-click</kbd> deletes it.';
  el.append(canvas, info, help);
  const g = canvas.getContext('2d');

  let W = 0;
  const size = () => W - 2 * PAD;
  const toPx = (p) => [PAD + p.x * size(), PAD + (1 - p.y) * size()];
  const fromPx = (px, py) => ({ x: (px - PAD) / size(), y: 1 - (py - PAD) / size() });
  const local = (e) => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  const hitTest = (px, py) => {
    let best = -1;
    let bestD = HIT;
    pts.forEach((p, i) => {
      const [x, y] = toPx(p);
      const d = Math.hypot(x - px, y - py);
      if (d <= bestD) { best = i; bestD = d; }
    });
    return best;
  };
  const commit = () => { onChange?.({ points: pts.map((p) => ({ ...p })) }); draw(); };

  function draw() {
    if (!W) return;
    const s = size();
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    g.clearRect(0, 0, W, W);
    g.fillStyle = '#121212';
    g.fillRect(PAD, PAD, s, s);
    g.strokeStyle = '#2a2a2a';
    g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const v = Math.round(PAD + (s * i) / 4) + 0.5;
      g.beginPath(); g.moveTo(v, PAD); g.lineTo(v, PAD + s); g.moveTo(PAD, v); g.lineTo(PAD + s, v); g.stroke();
    }
    g.strokeStyle = '#3a3a3a';
    g.strokeRect(PAD + 0.5, PAD + 0.5, s - 1, s - 1);
    if (identity) { // identity line (no change)
      g.setLineDash([4, 4]);
      g.strokeStyle = '#555';
      g.beginPath(); g.moveTo(PAD, PAD + s); g.lineTo(PAD + s, PAD); g.stroke();
      g.setLineDash([]);
    }
    // axis labels
    g.fillStyle = '#777';
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillText(labels.x0 ?? '0', PAD + 3, PAD + s - 13);
    g.textAlign = 'right';
    g.fillText(labels.x1 ?? 'in →', PAD + s - 3, PAD + s - (labels.xTicks ? 27 : 13));
    g.textAlign = labels.yTicks ? 'right' : 'left';
    g.fillText(labels.y1 ?? 'out ↑', labels.yTicks ? PAD + s - 3 : PAD + 3, PAD + 3);
    if (labels.xTicks) {
      g.textBaseline = 'bottom';
      labels.xTicks.forEach((text, i, ticks) => {
        g.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center';
        g.fillText(text, PAD + s * i / (ticks.length - 1), PAD + s - 3);
      });
    }
    if (labels.yTicks) {
      g.textAlign = 'left';
      labels.yTicks.forEach((text, i, ticks) => {
        g.textBaseline = i === 0 ? 'bottom' : i === ticks.length - 1 ? 'top' : 'middle';
        g.fillText(text, PAD + 3, PAD + s * (1 - i / (ticks.length - 1)));
      });
    }
    // curve
    const poly = curvePolyline(pts);
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < poly.length; i += 2) {
      const [x, y] = toPx({ x: poly[i], y: poly[i + 1] });
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    // control polygon of rounded corners
    g.strokeStyle = '#ffffff30';
    g.lineWidth = 1;
    pts.forEach((p, i) => {
      if (!p.r) return;
      const [x, y] = toPx(p);
      const [ax, ay] = toPx(pts[i - 1]);
      const [bx, by] = toPx(pts[i + 1]);
      g.beginPath();
      g.moveTo(x + (ax - x) * p.r / 2, y + (ay - y) * p.r / 2); g.lineTo(x, y); g.lineTo(x + (bx - x) * p.r / 2, y + (by - y) * p.r / 2);
      g.stroke();
    });
    // points
    drawPoints();
    if (mapping && (cursor || drag >= 0 || hover >= 0)) {
      const p = mappingPoint(poly);
      const [x, y] = toPx(p);
      g.strokeStyle = '#ffffff80';
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, PAD + s); g.lineTo(x, y); g.lineTo(PAD, y);
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      const text = `${formatX(p.x)} → ${formatY(p.y)}`;
      g.font = '11px system-ui, sans-serif';
      const width = g.measureText(text).width + 12;
      const left = Math.max(PAD, Math.min(PAD + s - width, x + 10));
      const top = y > PAD + 30 ? y - 26 : y + 10;
      g.fillStyle = '#121212ee';
      g.fillRect(left, top, width, 20);
      g.fillStyle = '#fff';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(text, left + 6, top + 10);
    }
    if (playhead !== null) { // playback dot: on the curve, above the points
      const [x, y] = toPx({ x: playhead, y: sampleAt(poly, playhead) });
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.fillStyle = '#ffffff40';
      g.fill();
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
    }
    drawInfo();
  }

  function mappingPoint(poly) {
    const i = drag >= 0 ? drag : hover;
    const x = i >= 0 ? pts[i].x : cursor.x;
    return { x, y: sampleAt(poly, x) };
  }

  function drawPoints() {
    pts.forEach((p, i) => {
      const [x, y] = toPx(p);
      const active = i === hover || i === drag;
      g.beginPath();
      g.arc(x, y, active ? 6 : 4.5, 0, Math.PI * 2);
      g.fillStyle = active ? '#fff' : color;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = '#000';
      g.stroke();
      if (p.r) { // rounding ring
        g.beginPath();
        g.arc(x, y, 8 + p.r * 6, -Math.PI / 2, -Math.PI / 2 + p.r * Math.PI * 2);
        g.strokeStyle = active ? '#fff' : color;
        g.stroke();
      }
    });
  }

  function drawInfo() {
    const i = drag >= 0 ? drag : hover;
    if (i >= 0) {
      const p = pts[i];
      const y = mapping ? sampleAt(curvePolyline(pts), p.x) : p.y;
      info.textContent = `${formatX(p.x)} → ${formatY(y)}${i > 0 && i < pts.length - 1 ? ` · round ${Math.round(p.r * 100)} %` : ' · end point'}`;
    } else if (cursor) {
      const p = mapping ? mappingPoint(curvePolyline(pts)) : cursor;
      info.textContent = `${formatX(p.x)}${mapping ? ` → ${formatY(p.y)}` : ''} · double-click to add a point`;
    }
    else info.textContent = `${pts.length} points`;
  }

  const resize = () => {
    W = canvas.clientWidth;
    if (!W) return;
    canvas.width = Math.round(W * devicePixelRatio);
    canvas.height = Math.round(W * devicePixelRatio);
    canvas.style.height = `${W}px`;
    draw();
  };
  let resizePending = false;
  new ResizeObserver(() => {
    if (resizePending) return;
    resizePending = true;
    // Square sizing can change the panel's scrollbar and width; resize outside observer delivery.
    requestAnimationFrame(() => { resizePending = false; resize(); });
  }).observe(canvas);

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const [px, py] = local(e);
    const second = presses.press(e);
    drag = hitTest(px, py);
    const inserting = drag < 0 && second;
    if (inserting) beginEdit?.();
    if (inserting) drag = insert(px, py); // down-up-DOWN: add a point and drag it at once
    if (drag >= 0 && !inserting) beginEdit?.();
    if (inserting && drag < 0) endEdit?.();
    if (drag < 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    const [px, py] = local(e);
    const c = fromPx(px, py);
    cursor = c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1 ? c : null;
    if (drag >= 0) {
      presses.reset();
      const p = pts[drag];
      const last = pts.length - 1;
      if (drag > 0 && drag < last) p.x = Math.min(pts[drag + 1].x - MIN_GAP, Math.max(pts[drag - 1].x + MIN_GAP, c.x));
      p.y = Math.min(1, Math.max(0, c.y));
      commit();
      return;
    }
    const h = hitTest(px, py);
    canvas.style.cursor = h >= 0 ? (h === 0 || h === pts.length - 1 ? 'ns-resize' : 'move') : 'crosshair';
    if (h !== hover || cursor || mapping) { hover = h; draw(); }
  });
  const endDrag = () => {
    if (drag < 0) return;
    drag = -1;
    draw();
    endEdit?.();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('pointerleave', () => { cursor = null; if (drag < 0) { hover = -1; draw(); } });

  // a new point at the pixel position: its index, or -1 when it does not fit there
  function insert(px, py) {
    const c = fromPx(px, py);
    if (c.x <= MIN_GAP || c.x >= 1 - MIN_GAP) return -1;
    const i = pts.findIndex((p) => p.x > c.x);
    if (c.x - pts[i - 1].x < MIN_GAP || pts[i].x - c.x < MIN_GAP) return -1;
    pts.splice(i, 0, { x: c.x, y: Math.min(1, Math.max(0, c.y)), r: NEW_POINT_ROUND });
    hover = i;
    commit();
    return i;
  }
  canvas.addEventListener('wheel', (e) => {
    const [px, py] = local(e);
    const i = hitTest(px, py);
    if (i <= 0 || i >= pts.length - 1) return; // end points have no corner; let the panel scroll
    e.preventDefault();
    const p = pts[i];
    p.r = Math.min(1, Math.max(0, Math.round((p.r + (e.deltaY < 0 ? ROUND_STEP : -ROUND_STEP)) * 100) / 100));
    hover = i;
    commit();
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const [px, py] = local(e);
    const i = hitTest(px, py);
    if (i <= 0 || i >= pts.length - 1) return;
    pts.splice(i, 1);
    hover = -1;
    commit();
  });

  return {
    el,
    set(c) { if (drag < 0) { pts = normalizeCurve(c).points; draw(); } },
    setLabels(l) { labels = l; draw(); },
    setPlayhead(x) {
      const v = x === null || x === undefined ? null : Math.min(1, Math.max(0, x));
      if (v !== playhead) { playhead = v; draw(); }
    },
  };
}
