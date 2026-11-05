// Panel display of the IMAGE SAMPLER (below the controllers): Load Image, what is loaded, the photo
// with the scanner on it, and the ADSR editor (adsrview.js, as OSC). The scanner editor moves the
// real controllers (api.setParam, stepped like the sliders; one undo step per drag):
//   drag the centre dot, or anywhere on the photo   X / Y (the centre jumps there)
//   drag the scanner (an end, or anywhere on it)    Length (+ Rotation for the Line scanner); a
//                                                   grab between centre and end scales the length,
//                                                   so ends outside the photo can be reached too
//   double-click the centre / an end                reset X, Y / Length, Rotation
// The Oval and the Rectangle have three handles instead: the Width handle (on the end of the
// width axis, where every cycle starts and ends), the Height handle (on the height axis) and the
// rotation knob (the small ring on a stalk beyond the Width handle: drag it around the centre to
// turn the shape); a double-click on one resets its controller.
// The Triangle has a numbered handle on each corner (X1 / Y1 … X3 / Y3) and its centre dot (the
// centroid) moves all three corners together; a click elsewhere moves the triangle there. A
// double-click resets a corner, on the centre all three.
// The arrow marks where every cycle ends (Line / Propellor: it starts at the other end; Oval,
// Rectangle, Triangle: the direction the scan runs round). Small dots mark the Resolution's points (up to POINT_DOTS, when
// they are apart enough to see). The Propellor spins on the
// photo at Propellor Speed (this picture's own clock: same speed, not the voices' exact angle).
// Modulated controllers (LFO, ADSR, automation) move the scanner live. Dropping a picture on the
// photo loads it too.
import { addImage, getImage, onSample, MAX_IMAGE } from '../samples.js';
import { createAdsrView, stepValue } from './adsrview.js';
import { hasMediaDialog, openMediaFile } from '../filedialog.js';
import { errorText } from '../filepicker.js';
import { SCAN, TRI, sized, scanCenter, scanEnds, angleTo, diagonal, ovalAxes, ovalPoint, rectCorners, triCorners, polyPath, wrapDeg, resPoints } from './imagescan.js';

const POINT_DOTS = 128;

const HIT = 10; // px
const KNOB = 18; // px from the Width handle to the oval's rotation knob
const MAX_H = 260; // px of the photo box

// A picture file -> { width, height, rgb } scaled to MAX_IMAGE px on its longest side
export async function imageFromFile(file) {
  let src;
  try {
    src = await createImageBitmap(file);
  } catch {
    throw new Error('not a picture this browser can read');
  }
  const s = Math.min(1, MAX_IMAGE / Math.max(src.width, src.height));
  const width = Math.max(1, Math.round(src.width * s));
  const height = Math.max(1, Math.round(src.height * s));
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, width, height);
  src.close?.();
  const px = g.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    const a = px[i + 3] / 255; // transparent = black
    rgb[j] = px[i] * a;
    rgb[j + 1] = px[i + 1] * a;
    rgb[j + 2] = px[i + 2] * a;
  }
  return { width, height, rgb };
}

// Canvas of an image from the pool (cached per id)
const pictures = new Map();
function pictureOf(id, img) {
  let cv = pictures.get(id);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const data = new ImageData(img.width, img.height);
  for (let i = 0, j = 0; j < img.rgb.length; i += 4, j += 3) {
    data.data[i] = img.rgb[j];
    data.data[i + 1] = img.rgb[j + 1];
    data.data[i + 2] = img.rgb[j + 2];
    data.data[i + 3] = 255;
  }
  cv.getContext('2d').putImageData(data, 0, 0);
  pictures.set(id, cv);
  return cv;
}

// Fit (contain) an image of iw x ih into a w x h box: image pixel centres <-> canvas px
export function fitImage(iw, ih, w, h) {
  const sc = Math.min(w / iw, h / ih);
  const ox = (w - iw * sc) / 2;
  const oy = (h - ih * sc) / 2;
  return {
    sc, ox, oy,
    toCanvas: (px, py) => ({ x: ox + (px + 0.5) * sc, y: oy + (py + 0.5) * sc }),
    toImage: (x, y) => ({ px: (x - ox) / sc - 0.5, py: (y - oy) / sc - 0.5 }),
  };
}

// Controller values for dragging the end point `end` (0 = start, 1 = end) of the scanner to image
// pixel (px, py): Length (and Rotation for the Line scanner)
export function dragEnd(values, img, end, px, py) {
  const { cx, cy } = scanCenter(values.x, values.y, values.length, img.width, img.height);
  const d = diagonal(img.width, img.height);
  const out = { length: d > 0 ? Math.min(100, ((2 * Math.hypot(px - cx, py - cy)) / d) * 100) : values.length };
  if ((values.scanType | 0) === SCAN.LINE) {
    const a = angleTo(cx, cy, px, py);
    out.rotation = end ? a : (a <= 0 ? a + 180 : a - 180); // the start sits opposite the end
  }
  return out;
}

// Oval controller values for dragging a handle to image pixel (px, py): 'width' / 'height' measure
// along the oval's own (rotated) axis, 'rotation' points the width axis at the pointer (`flip`: the
// knob sits on the far side, beyond the opposite end)
export function dragOval(values, img, handle, px, py, flip = false) {
  const { cx, cy } = scanCenter(values.x, values.y, values.length, img.width, img.height);
  const r = ((Number(values.ovalRotation) || 0) * Math.PI) / 180;
  const pct = (d, n) => (n > 1 ? Math.min(100, (2 * Math.abs(d) * 100) / (n - 1)) : 0);
  if (handle === 'width') return { ovalWidth: pct((px - cx) * Math.cos(r) - (py - cy) * Math.sin(r), img.width) };
  if (handle === 'height') return { ovalHeight: pct(-(px - cx) * Math.sin(r) - (py - cy) * Math.cos(r), img.height) };
  return { ovalRotation: wrapDeg(angleTo(cx, cy, px, py) + (flip ? 180 : 0)) };
}

// Controller values (X / Y) for the centre at image pixel (px, py)
export function dragCenter(img, px, py) {
  const pct = (v, n) => (n > 1 ? Math.min(100, Math.max(0, (v / (n - 1)) * 100)) : 50);
  return { x: pct(px, img.width), y: pct(py, img.height) };
}

// Triangle: corner k (0..2) to image pixel (px, py) -> { triXk, triYk }
export function dragCorner(img, k, px, py) {
  const { x, y } = dragCenter(img, px, py);
  return { [TRI[2 * k]]: x, [TRI[2 * k + 1]]: y };
}

// Triangle: all corners of `start` (controller values) moved by (dx, dy) image px, stopped at the
// image edges so the shape stays the same -> { triX1 … triY3 }
export function moveTriangle(start, img, dx, dy) {
  const W = Math.max(1, img.width - 1);
  const H = Math.max(1, img.height - 1);
  const xs = [0, 2, 4].map((i) => Number(start[TRI[i]]) || 0);
  const ys = [1, 3, 5].map((i) => Number(start[TRI[i]]) || 0);
  const ddx = Math.min(100 - Math.max(...xs), Math.max(-Math.min(...xs), (dx / W) * 100));
  const ddy = Math.min(100 - Math.max(...ys), Math.max(-Math.min(...ys), (dy / H) * 100));
  return Object.fromEntries(TRI.map((id, i) => [id, (i % 2 ? ys[i >> 1] + ddy : xs[i >> 1] + ddx)]));
}

export function createImageView(entry, api) {
  const el = document.createElement('div');
  el.className = 'sample-view image-view';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sample-load';
  button.textContent = 'Load Image';
  const input = Object.assign(document.createElement('input'), { type: 'file', hidden: true, accept: 'image/*' });
  const info = document.createElement('div');
  info.className = 'sample-info';
  const box = document.createElement('div');
  box.className = 'wave-view image-box';
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  cv.className = 'image-scan';
  box.append(cv);
  const adsr = createAdsrView({ color: api.color, values: entry.values, params: entry.def.params, ...api });
  el.append(button, input, info, box, adsr.el);
  const g = cv.getContext('2d');
  const params = Object.fromEntries(entry.def.params.map((p) => [p.id, p]));
  let values = { ...entry.values };
  let spin = 0; // propellor angle of the picture (degrees)
  let last = 0;
  let raf = 0;

  const image = () => getImage(entry.state?.imageId);
  const angle = () => ((values.scanType | 0) === SCAN.PROPELLOR ? spin : values.rotation ?? 0);

  const describe = () => {
    info.classList.remove('error');
    const img = image();
    if (img) info.textContent = `${entry.state.name} · ${img.width} × ${img.height} px`;
    else if (entry.state?.imageId) info.textContent = `${entry.state.name}: image data missing, load it again`;
    else info.textContent = 'No image loaded: notes stay silent. Load one or drop a picture here.';
  };

  // the box takes the image's aspect ratio (up to MAX_H px high)
  const size = () => {
    const img = image();
    const w = box.clientWidth || 260;
    const h = img ? Math.min(MAX_H, Math.max(60, Math.round((w * img.height) / img.width))) : 96;
    if (box.style.height !== `${h}px`) box.style.height = `${h}px`;
  };

  // scanner in canvas px
  const geometry = (w, h, img) => {
    const fit = fitImage(img.width, img.height, w, h);
    const c = scanCenter(values.x, values.y, values.length, img.width, img.height);
    const e = scanEnds(c, angle());
    const G = { fit, c: fit.toCanvas(c.cx, c.cy), a: fit.toCanvas(e.x0, e.y0), b: fit.toCanvas(e.x1, e.y1), r: (c.len / 2) * fit.sc };
    const type = values.scanType | 0;
    if (type === SCAN.TRIANGLE) {
      const t = triCorners(values, img.width, img.height);
      const path = polyPath(t.xs, t.ys);
      const q = [0, 0];
      const at = (u) => { path.at(u, q); return fit.toCanvas(q[0], q[1]); };
      const corners = [0, 1, 2].map((i) => fit.toCanvas(t.xs[i], t.ys[i]));
      G.c = fit.toCanvas((t.xs[0] + t.xs[1] + t.xs[2]) / 3, (t.ys[0] + t.ys[1] + t.ys[2]) / 3);
      G.tri = { corners, at, span: path.length * fit.sc };
      return G;
    }
    if (sized(type)) {
      const { a, b } = ovalAxes(values.ovalWidth, values.ovalHeight, img.width, img.height);
      const deg = Number(values.ovalRotation) || 0;
      let at = (u) => { const q = ovalPoint(c.cx, c.cy, a, b, deg, u); return fit.toCanvas(q.x, q.y); };
      let span = Math.PI * (a + b) * fit.sc;
      let rect = null;
      if (type === SCAN.RECTANGLE) {
        const r = rectCorners(c.cx, c.cy, a, b, deg);
        const path = polyPath(r.xs, r.ys);
        const q = [0, 0];
        at = (u) => { path.at(u, q); return fit.toCanvas(q[0], q[1]); };
        span = path.length * fit.sc;
        rect = [1, 2, 3, 4].map((i) => fit.toCanvas(r.xs[i], r.ys[i]));
      }
      const rad = (deg * Math.PI) / 180;
      const ux = Math.cos(rad);
      const uy = -Math.sin(rad); // the width axis on the canvas (the height axis: (uy, -ux))
      // how far the view reaches from the centre along (dx, dy), keeping handles 6 px inside
      const reach = (dx, dy) => {
        const m = 6;
        const t = (d, c, n) => (d > 1e-9 ? (n - m - c) / d : d < -1e-9 ? (m - c) / d : Infinity);
        return Math.max(0, Math.min(t(dx, G.c.x, w), t(dy, G.c.y, h)));
      };
      const along = (s, dx, dy) => ({ x: G.c.x + dx * s, y: G.c.y + dy * s });
      const A = a * fit.sc;
      const B = b * fit.sc;
      // Width handle + rotation knob beyond it; if they do not fit, the knob goes beyond the far end,
      // else both slide inwards (the handle's drag is scaled up by f, so it does not jump)
      let sgn = 1;
      let wd = A;
      let kd = A + KNOB;
      const R = reach(ux, uy);
      if (kd > R) {
        const R2 = reach(-ux, -uy);
        if (A + KNOB <= R2) sgn = -1;
        else { kd = R; wd = Math.min(A, Math.max(R - KNOB, R / 2)); }
      }
      const fw = wd > 0.5 ? A / wd : 1;
      const knob = along(sgn * kd, ux, uy);
      const stalk = along(sgn > 0 ? wd : -A, ux, uy);
      // Height handle on whichever side of the height axis fits (else slid inwards)
      const up = reach(uy, -ux);
      const dn = reach(-uy, ux);
      const hs = B <= up || up >= dn ? 1 : -1;
      const hd = Math.min(B, hs > 0 ? up : dn);
      const fh = hd > 0.5 ? B / hd : 1;
      G.oval = { a: A, b: B, deg, at, span, rect, wh: along(wd, ux, uy), hh: along(hs * hd, uy, -ux), knob, flip: sgn < 0, stalk, fw, fh };
    }
    return G;
  };

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
    const img = image();
    if (!img) { cv.setAttribute('aria-label', 'No image'); return; }
    const G = geometry(w, h, img);
    g.imageSmoothingEnabled = G.fit.sc < 2;
    g.drawImage(pictureOf(entry.state.imageId, img), G.fit.ox, G.fit.oy, img.width * G.fit.sc, img.height * G.fit.sc);
    const prop = (values.scanType | 0) === SCAN.PROPELLOR;
    if (G.oval) { drawOval(G); return; }
    if (G.tri) { drawTri(G); return; }
    if (prop) { // the propellor's sweep
      g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      g.setLineDash([3, 4]);
      g.lineWidth = 1;
      g.beginPath();
      g.arc(G.c.x, G.c.y, Math.max(1, G.r), 0, 2 * Math.PI);
      g.stroke();
      g.setLineDash([]);
    }
    const line = (width, color) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(G.a.x, G.a.y);
      g.lineTo(G.b.x, G.b.y);
      g.stroke();
    };
    line(4, 'rgba(0, 0, 0, 0.6)');
    line(2, '#fff');
    points((u) => ({ x: G.a.x + (G.b.x - G.a.x) * u, y: G.a.y + (G.b.y - G.a.y) * u }), Math.hypot(G.b.x - G.a.x, G.b.y - G.a.y));
    // arrow at the end of a cycle
    const dx = G.b.x - G.a.x;
    const dy = G.b.y - G.a.y;
    const L = Math.hypot(dx, dy);
    if (L > 4) {
      const ux = dx / L;
      const uy = dy / L;
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(G.b.x + ux * 4, G.b.y + uy * 4);
      g.lineTo(G.b.x - ux * 6 - uy * 5, G.b.y - uy * 6 + ux * 5);
      g.lineTo(G.b.x - ux * 6 + uy * 5, G.b.y - uy * 6 - ux * 5);
      g.closePath();
      g.fill();
      g.stroke();
    }
    // start handle + centre
    g.fillStyle = '#fff';
    g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    g.beginPath();
    g.arc(G.a.x, G.a.y, 3.5, 0, 2 * Math.PI);
    g.fill();
    g.stroke();
    g.fillStyle = api.color;
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(G.c.x, G.c.y, 5, 0, 2 * Math.PI);
    g.fill();
    g.stroke();
    cv.setAttribute('aria-label', `Image ${entry.state.name}, ${prop ? 'propellor' : 'line'} scanner at ${values.x.toFixed(1)} %, ${values.y.toFixed(1)} %, length ${values.length.toFixed(1)} %`);
  };

  const dot = (q, r, fill, stroke = 'rgba(0, 0, 0, 0.6)', lw = 1) => {
    g.fillStyle = fill;
    g.strokeStyle = stroke;
    g.lineWidth = lw;
    g.beginPath();
    g.arc(q.x, q.y, r, 0, 2 * Math.PI);
    g.fill();
    g.stroke();
  };
  // the Resolution's points along the scanner (at(u): canvas point at progress u, span: its length)
  const points = (at, span) => {
    const n = resPoints(values.resolution);
    if (n > POINT_DOTS || span / n < 4) return;
    g.fillStyle = api.color;
    g.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    g.lineWidth = 1;
    g.beginPath();
    for (let j = 0; j < n; j++) {
      const q = at(j / n);
      g.moveTo(q.x + 2.5, q.y);
      g.arc(q.x, q.y, 2.5, 0, 2 * Math.PI);
    }
    g.fill();
    g.stroke();
  };
  // a closed polygon (canvas px) as a white ring with a dark edge
  const outline = (pts, width, color) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineJoin = 'round';
    g.beginPath();
    pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.closePath();
    g.stroke();
  };
  // arrow on a closed path at(u), arriving at its start (where every cycle ends)
  const loopArrow = (at) => {
    const p = at(-0.03);
    const e = at(0);
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const L = Math.hypot(dx, dy);
    if (L <= 2) return;
    const ux = dx / L;
    const uy = dy / L;
    const t = at(-0.015);
    g.fillStyle = '#fff';
    g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(t.x + ux * 5, t.y + uy * 5);
    g.lineTo(t.x - ux * 5 - uy * 5, t.y - uy * 5 + ux * 5);
    g.lineTo(t.x - ux * 5 + uy * 5, t.y - uy * 5 - ux * 5);
    g.closePath();
    g.fill();
    g.stroke();
  };
  const drawTri = (G) => {
    const T = G.tri;
    outline(T.corners, 4, 'rgba(0, 0, 0, 0.6)');
    outline(T.corners, 2, '#fff');
    points(T.at, T.span);
    loopArrow(T.at);
    g.font = 'bold 9px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    T.corners.forEach((q, i) => {
      dot(q, 6, '#fff', 'rgba(0, 0, 0, 0.7)', 1);
      g.fillStyle = '#000';
      g.fillText(String(i + 1), q.x, q.y + 0.5);
    });
    dot(G.c, 5, api.color, '#fff', 2);
    const v = (id) => (+values[id]).toFixed(1);
    cv.setAttribute('aria-label', `Image ${entry.state.name}, triangle scanner with corners ${v('triX1')} % ${v('triY1')} %, ${v('triX2')} % ${v('triY2')} %, ${v('triX3')} % ${v('triY3')} %`);
  };
  const drawOval = (G) => {
    const O = G.oval;
    const ring = (width, color) => {
      if (O.rect) { outline(O.rect, width, color); return; }
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      g.ellipse(G.c.x, G.c.y, Math.max(0.5, O.a), Math.max(0.5, O.b), (-O.deg * Math.PI) / 180, 0, 2 * Math.PI);
      g.stroke();
    };
    // the axes (dashed), the stalk to the rotation knob
    g.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(G.c.x, G.c.y); g.lineTo(O.wh.x, O.wh.y);
    g.moveTo(G.c.x, G.c.y); g.lineTo(O.hh.x, O.hh.y);
    g.stroke();
    g.setLineDash([]);
    ring(4, 'rgba(0, 0, 0, 0.6)');
    ring(2, '#fff');
    points(O.at, O.span);
    g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(O.stalk.x, O.stalk.y); g.lineTo(O.knob.x, O.knob.y); g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(O.stalk.x, O.stalk.y); g.lineTo(O.knob.x, O.knob.y); g.stroke();
    loopArrow(O.at); // the scan's direction, arriving at the Width handle (where every cycle ends)
    // handles: width / height (squares read as size), rotation (a ring), centre
    const square = (q) => {
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      g.lineWidth = 1;
      g.fillRect(q.x - 4, q.y - 4, 8, 8);
      g.strokeRect(q.x - 4, q.y - 4, 8, 8);
    };
    square(O.hh);
    square(O.wh);
    dot(O.knob, 4.5, 'rgba(0, 0, 0, 0.35)', '#fff', 2);
    dot(G.c, 5, api.color, '#fff', 2);
    cv.setAttribute('aria-label', `Image ${entry.state.name}, ${O.rect ? 'rectangle' : 'oval'} scanner at ${values.x.toFixed(1)} %, ${values.y.toFixed(1)} %, width ${(+values.ovalWidth).toFixed(1)} %, height ${(+values.ovalHeight).toFixed(1)} %, rotation ${(+O.deg).toFixed(1)}°`);
  };

  // the propellor turns on the picture while the panel shows it
  const animate = (t) => {
    raf = 0;
    if (!el.isConnected) return;
    const prop = (values.scanType | 0) === SCAN.PROPELLOR && values.speed && image();
    if (!prop) { last = 0; return; }
    if (last) spin = (spin + ((values.speed * 360 * (t - last)) / 1000)) % 360;
    last = t;
    draw();
    raf = requestAnimationFrame(animate);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(animate); };

  const show = () => { describe(); size(); draw(); kick(); };

  const set = (changes) => {
    for (const [id, v] of Object.entries(changes)) {
      const x = stepValue(params[id], v);
      api.setParam?.(id, x);
      values[id] = x;
    }
    draw();
  };

  async function load(file) {
    if (!file) return;
    info.classList.remove('error');
    info.textContent = `Loading ${file.name}…`;
    try {
      const imageId = addImage(await imageFromFile(file));
      api.beginEdit?.();
      api.setState({ imageId, name: file.name.replace(/\.[^.]+$/, '') });
      api.endEdit?.();
      show();
    } catch (err) {
      info.textContent = `Loading ${file.name} failed: ${err.message}`;
      info.classList.add('error');
    }
  }

  // ---- scanner editor ----
  const pointer = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  // 'center', 'start' / 'end' (+ f: the grab's share of the half length, 1 = on the end), or null
  const hitAt = (p, G) => {
    const d = (q) => Math.hypot(p.x - q.x, p.y - q.y);
    if (G.tri) {
      const hits = [...G.tri.corners.map((q, k) => ({ kind: 'corner', k, d: d(q) })), { kind: 'center', d: d(G.c) }]
        .filter((h) => h.d <= HIT).sort((x, y) => x.d - y.d);
      return hits[0] ?? null;
    }
    if (G.oval) { // the nearest handle within reach
      const hits = [['rotation', G.oval.knob], ['width', G.oval.wh], ['height', G.oval.hh], ['center', G.c]]
        .map(([kind, q]) => ({ kind, d: d(q) })).filter((h) => h.d <= HIT).sort((x, y) => x.d - y.d);
      return hits.length ? { kind: hits[0].kind } : null;
    }
    if (d(G.c) <= HIT) return { kind: 'center' };
    if (d(G.b) <= HIT) return { kind: 'end', f: 1 };
    if (d(G.a) <= HIT) return { kind: 'start', f: 1 };
    const vx = G.b.x - G.c.x;
    const vy = G.b.y - G.c.y;
    const half = Math.hypot(vx, vy);
    if (half < 1) return null;
    const along = ((p.x - G.c.x) * vx + (p.y - G.c.y) * vy) / half; // signed distance along the line
    const off = Math.abs((p.x - G.c.x) * vy - (p.y - G.c.y) * vx) / half;
    if (off > HIT / 2 || Math.abs(along) > half) return null;
    return { kind: along > 0 ? 'end' : 'start', f: Math.abs(along) / half };
  };
  cv.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    const img = image();
    const hit = img ? hitAt(pointer(e), geometry(cv.clientWidth, cv.clientHeight, img)) : null;
    cv.style.cursor = !img ? 'default' : hit?.kind === 'center' ? 'move' : hit ? 'grab' : 'crosshair';
    cv.title = hit?.kind === 'rotation' ? 'Rotation' : hit?.kind === 'width' ? 'Width' : hit?.kind === 'height' ? 'Height' : hit?.kind === 'corner' ? `X${hit.k + 1} / Y${hit.k + 1}` : '';
  });
  cv.addEventListener('pointerdown', (e) => {
    const img = image();
    if (e.button !== 0 || !img) return;
    e.preventDefault();
    const G = geometry(cv.clientWidth, cv.clientHeight, img);
    const p0 = pointer(e);
    const hit = hitAt(p0, G);
    // grabbing the centre keeps its offset; a click elsewhere puts the centre there
    const held = hit?.kind === 'center' ? G.c : hit?.kind === 'corner' ? G.tri.corners[hit.k] : G.oval && hit ? { width: G.oval.wh, height: G.oval.hh, rotation: G.oval.knob }[hit.kind] : null;
    const off = held ? { x: held.x - p0.x, y: held.y - p0.y } : { x: 0, y: 0 };
    const f = Math.max(0.15, hit?.f ?? 1); // not too close to the centre (the length would explode)
    api.beginEdit?.();
    const start = { ...values };
    const apply = (p) => {
      if (G.tri) { // a corner, or the whole triangle (its centre follows the pointer)
        const at = G.fit.toImage(p.x + off.x, p.y + off.y);
        if (hit?.kind === 'corner') set(dragCorner(img, hit.k, at.px, at.py));
        else {
          const c0 = G.fit.toImage(G.c.x, G.c.y);
          set(moveTriangle(start, img, at.px - c0.px, at.py - c0.py));
        }
      } else if (G.oval && hit && hit.kind !== 'center') {
        const f = { width: G.oval.fw, height: G.oval.fh }[hit.kind] ?? 1; // a handle slid inwards
        const at = G.fit.toImage(G.c.x + (p.x + off.x - G.c.x) * f, G.c.y + (p.y + off.y - G.c.y) * f);
        set(dragOval(values, img, hit.kind, at.px, at.py, G.oval.flip));
      } else if (hit && hit.kind !== 'center') { // the end follows the grabbed point, scaled to the end
        const at = G.fit.toImage(G.c.x + (p.x - G.c.x) / f, G.c.y + (p.y - G.c.y) / f);
        set(dragEnd(values, img, hit.kind === 'end' ? 1 : 0, at.px, at.py));
      } else {
        const at = G.fit.toImage(p.x + off.x, p.y + off.y);
        set(dragCenter(img, at.px, at.py));
      }
    };
    if (!hit) apply(p0);
    cv.setPointerCapture(e.pointerId);
    const move = (ev) => apply(pointer(ev));
    const up = () => {
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      api.endEdit?.();
    };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  });
  cv.addEventListener('dblclick', (e) => {
    const img = image();
    if (!img) return;
    const hit = hitAt(pointer(e), geometry(cv.clientWidth, cv.clientHeight, img));
    const oval = { width: ['ovalWidth'], height: ['ovalHeight'], rotation: ['ovalRotation'] };
    const tri = (values.scanType | 0) === SCAN.TRIANGLE;
    const reset = hit?.kind === 'corner' ? TRI.slice(2 * hit.k, 2 * hit.k + 2)
      : hit?.kind === 'center' ? (tri ? TRI : ['x', 'y']) : oval[hit?.kind] ?? (hit ? ['length', 'rotation'] : null);
    if (!reset) return;
    api.beginEdit?.();
    set(Object.fromEntries(reset.map((id) => [id, params[id].default])));
    api.endEdit?.();
  });

  // desktop app: the app's own file dialog; browsers: their file chooser
  button.onclick = async () => {
    if (!hasMediaDialog()) { input.click(); return; }
    try {
      load(await openMediaFile('image'));
    } catch (err) {
      info.textContent = errorText(err);
      info.classList.add('error');
    }
  };
  input.onchange = () => { load(input.files[0]); input.value = ''; };
  el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop');
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    e.preventDefault();
    load(file);
  });
  new ResizeObserver(() => { size(); draw(); }).observe(box);
  let unsub = null;
  unsub = onSample((id) => {
    if (!el.isConnected) { unsub(); return; }
    if (id === entry.state?.imageId) show();
  });
  describe();
  queueMicrotask(show);

  return {
    el,
    refresh(v) {
      const was = values;
      values = { ...v };
      adsr.refresh(v);
      if (['x', 'y', 'length', 'rotation', 'scanType', 'speed', 'ovalWidth', 'ovalHeight', 'ovalRotation', ...TRI].some((id) => v[id] !== was[id])) { draw(); kick(); }
    },
  };
}
