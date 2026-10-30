// Classic curve editor on a canvas (used by the WAVESHAPER panel).
//   Double-click: add a point (keep the second press held to drag it right away, see doublepress.js)
//   Drag a point: move it (the end points move up/down only)
//   Scroll on a point: round its corner  Right-click a point: delete it
// createCurveEditor({ curve, color, labels, onChange }) -> { el, set(curve), setLabels(labels) }
//   onChange(curve) is called with a new curve object on every edit.
import { MIN_GAP, NEW_POINT_ROUND, curvePolyline, normalizeCurve } from './curve.js';
import { doublePress } from './doublepress.js';

const PAD = 12;
const HIT = 9; // px
const ROUND_STEP = 0.05;

export function createCurveEditor({ curve, color = '#c0a040', labels = {}, onChange }) {
  let pts = normalizeCurve(curve).points;
  let hover = -1;
  let drag = -1;
  let cursor = null; // {x, y} in curve units while the mouse is over the graph
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
    // identity line (no change)
    g.setLineDash([4, 4]);
    g.strokeStyle = '#555';
    g.beginPath(); g.moveTo(PAD, PAD + s); g.lineTo(PAD + s, PAD); g.stroke();
    g.setLineDash([]);
    // axis labels
    g.fillStyle = '#777';
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillText(labels.x0 ?? '0', PAD + 3, PAD + s - 13);
    g.textAlign = 'right';
    g.fillText(labels.x1 ?? 'in →', PAD + s - 3, PAD + s - 13);
    g.textAlign = 'left';
    g.fillText(labels.y1 ?? 'out ↑', PAD + 3, PAD + 3);
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
    // info line
    const i = drag >= 0 ? drag : hover;
    if (i >= 0) {
      const p = pts[i];
      info.textContent = `in ${p.x.toFixed(3)} → out ${p.y.toFixed(3)}${i > 0 && i < pts.length - 1 ? ` · round ${Math.round(p.r * 100)} %` : ' · end point'}`;
    } else if (cursor) info.textContent = `in ${cursor.x.toFixed(3)} · double-click to add a point`;
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
  new ResizeObserver(resize).observe(canvas);

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const [px, py] = local(e);
    const second = presses.press(e);
    drag = hitTest(px, py);
    if (drag < 0 && second) drag = insert(px, py); // down-up-DOWN: add a point and drag it at once
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
    if (h !== hover || cursor) { hover = h; draw(); }
  });
  const endDrag = () => { if (drag >= 0) { drag = -1; draw(); } };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
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
  };
}
