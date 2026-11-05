// IMAGE SAMPLER DSP kernel (audio thread). Every voice reads the colours under a scanner on an
// image (imagescan.js): it runs from the scanner's start to its end once per cycle of its note, so
// the colours along the scanner are the waveform. Red, green and blue are read separately and
// mixed onto each speaker by its own + / − amount per colour (imagescan.js colorWeights, the weights
// glide per sample, so modulating them is click-free).
//   Line       a straight scanner at Rotation (degrees)
//   Propellor  the scanner spins around its centre at Propellor Speed (turns per second, negative
//              = clockwise); one angle shared by all voices, so chords spin together, turned by
//              each note's start phase (MODMIDI phase 0..1 = 0..360°): a voice with a phase other
//              than 0 reads its own propellor (own tables, made on first use) at the shared angle
//              plus its phase, e.g. MULTIMIDI's random phase gives every voice its own propellor
//   Oval       once around an ellipse per cycle (Oval Width / Height, rotated by Oval Rotation): a
//              closed path, so the waveform has no jump at the cycle wrap
//   Triangle   once around the triangle of corners X1 / Y1, X2 / Y2, X3 / Y3 (closed, even speed)
//   Rectangle  once around a rectangle (Width / Height / Rotation as the Oval; closed, even speed)
// X / Y / Length / Rotation / the size / the corners glide per block while voices sound (no zipper
// noise when modulated).
// Resolution: the scanner is read at that many points (point j at progress j / points), once per
// block and shared by every voice; the waveform is the straight lines between them (a wavetable).
// Few points = a coarse, jumpy wave; many = every detail. Each point reads the image copy that
// averages its stretch of the scanner. The table is rebuilt only when the scanner (or the image)
// changes, then crossfaded from the old one over the block, so moving the scanner stays smooth.
// The waveform's DC (the average of the table) is removed, so bright or dark images don't thump.
// Anti-aliasing: the image is kept as a pyramid of half-size copies (each pixel the average of
// four), the table as halved copies (each point smoothed with its neighbours); a voice reads the
// table copy where it moves about one point per sample (blending the two nearest copies), so high
// notes get smoother instead of aliasing.
// The image arrives from the main thread: { type: 'image', width, height, rgb } (rgb: Uint8Array
// of width * height * 3) or rgb null (no image: silent; the module sends the stock image of imagestock.js instead
// when no picture is loaded, so this only happens while an own picture's data is missing). ADSR with curves as OSC (poly.dsp.js).
import { PolyKernel, curveEnv, curveStart, curveRelease, curveBlock, curveTick } from './poly.dsp.js';
import { SCAN, TRI, sized, scanCenter, ovalAxes, ovalPerimeter, rectCorners, triCorners, polyPath, unit, colorWeights, wrapDeg, resPoints, RES_MAX, RES_DEFAULT } from './imagescan.js';
import { imageCache } from '../dsp/imagecache.js';

const SMOOTH_S = 0.01;
const MAX_TLEVELS = 16;
const KEY_LEN = 15;

// A wavetable with halved copies: level l has len[l] points at off[l] (r, g, b interleaved).
function table() {
  return { buf: new Float32Array((2 * RES_MAX + 2 * MAX_TLEVELS) * 3), off: new Int32Array(MAX_TLEVELS), len: new Int32Array(MAX_TLEVELS), count: 0 };
}

// level `l` of table T at progress u (0..1, periodic), linear between the points -> out[0..2]
function tapLevel(T, l, u, out) {
  const m = T.len[l];
  const x = u * m;
  let i0 = x | 0;
  const f = x - i0;
  if (i0 >= m) i0 -= m;
  const i1 = i0 + 1 === m ? 0 : i0 + 1;
  const b = T.buf;
  const a0 = (T.off[l] + i0) * 3;
  const a1 = (T.off[l] + i1) * 3;
  out[0] = b[a0] + (b[a1] - b[a0]) * f;
  out[1] = b[a0 + 1] + (b[a1 + 1] - b[a0 + 1]) * f;
  out[2] = b[a0 + 2] + (b[a1 + 2] - b[a0 + 2]) * f;
}

// Fills the halved copies of T from its level 0: each point is the average of the level above at
// a quarter point either side ([1 2 1] / 4 when the length halves exactly), down to 2 points.
export function tableLevels(T) {
  const b = T.buf;
  let l = 0;
  while (T.len[l] > 2 && l + 1 < MAX_TLEVELS) {
    const m = T.len[l];
    const n = Math.ceil(m / 2);
    const r = m / n;
    const src = T.off[l];
    const dst = src + m;
    // level l (at src, m points) at point x (may be below 0), times 0.5, added to point o
    const half = (x, o, add) => {
      if (x < 0) x += m;
      let i0 = x | 0;
      const f = x - i0;
      if (i0 >= m) i0 -= m;
      const i1 = i0 + 1 === m ? 0 : i0 + 1;
      const a0 = (src + i0) * 3;
      const a1 = (src + i1) * 3;
      for (let c = 0; c < 3; c++) {
        const v = 0.5 * (b[a0 + c] + (b[a1 + c] - b[a0 + c]) * f);
        b[o + c] = add ? b[o + c] + v : v;
      }
    };
    for (let i = 0; i < n; i++) {
      half((i - 0.25) * r, (dst + i) * 3, false);
      half((i + 0.25) * r, (dst + i) * 3, true);
    }
    l++;
    T.off[l] = dst;
    T.len[l] = n;
  }
  T.count = l + 1;
}

// Half-size copies down to 1 x 1: [{ w, h, c }], c = interleaved r, g, b (-1..1) per pixel
export function pyramid(width, height, rgb) {
  const c = new Float32Array(width * height * 3);
  for (let i = 0; i < c.length; i++) c[i] = unit(rgb[i]);
  const levels = [{ w: width, h: height, c }];
  for (let a = levels[0]; a.w > 1 || a.h > 1; a = levels[levels.length - 1]) {
    const w = Math.ceil(a.w / 2);
    const h = Math.ceil(a.h / 2);
    const b = { w, h, c: new Float32Array(w * h * 3) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = [0, 0, 0];
        let n = 0;
        for (let j = 2 * y; j < Math.min(a.h, 2 * y + 2); j++) {
          for (let i = 2 * x; i < Math.min(a.w, 2 * x + 2); i++) {
            const o = (j * a.w + i) * 3;
            s[0] += a.c[o]; s[1] += a.c[o + 1]; s[2] += a.c[o + 2];
            n++;
          }
        }
        const o = (y * w + x) * 3;
        b.c[o] = s[0] / n; b.c[o + 1] = s[1] / n; b.c[o + 2] = s[2] / n;
      }
    }
    levels.push(b);
  }
  return levels;
}

const images = imageCache(pyramid);

export default class ImageSamplerKernel extends PolyKernel {
  constructor() {
    super({ atkCurve: 0, decCurve: 0, relCurve: 0, scanType: SCAN.LINE, x: 50, y: 50, length: 100, rotation: 0, speed: 0.5,
      ovalWidth: 60, ovalHeight: 60, ovalRotation: 0, triX1: 50, triY1: 15, triX2: 15, triY2: 85, triX3: 85, triY3: 85, resolution: RES_DEFAULT,
      redLeft: 100, greenLeft: 50, blueLeft: 0, redRight: 0, greenRight: 50, blueRight: 100 });
    this.levels = null;
    this.imageEntry = null;
    this.g = null; // smoothed scanner: { x, y, length } (controller units), angle in degrees
    this.angle = 0;
    this.w = null; // smoothed colour -> speaker weights (colorWeights)
    this.wasActive = false;
    this.o = [0, 0, 0]; // last read colour (sample(), tap())
    this.t = [0, 0, 0];
    this.u = [0, 0, 0];
    this.cur = table(); // the waveform now
    this.prev = table(); // the one before (crossfaded from after a change)
    this.built = false;
    this.key = new Float64Array(KEY_LEN); // what cur was built from
    this.nextKey = new Float64Array(KEY_LEN);
    this.image = 0; // bumped per image
    this.rebuilds = 0; // tables built (tests)
  }

  message(m) {
    if (m.type !== 'image') return super.message(m);
    const entry = images.acquire(m.width, m.height, m.rgb);
    images.release(this.imageEntry);
    this.imageEntry = entry;
    this.levels = entry?.value ?? null;
    this.image++;
  }

  destroy() {
    images.release(this.imageEntry);
    this.imageEntry = this.levels = null;
  }

  start(v, phase) {
    v.pos = Number.isFinite(phase) ? phase - Math.floor(phase) : 0;
    v.spin = v.pos * 360; // the Propellor's turn for this voice (degrees)
    v.fresh = true; // nothing played yet: its first table needs no crossfade
    if (v.own) v.own.built = false;
    curveStart(v);
  }

  noteOff(id) {
    const v = this.voiceOf(id);
    if (v && v.stage !== 4) curveRelease(v);
  }

  // bilinear read of copy `l` at level-0 pixel (px, py) (clamped to the edges) -> out[0..2]
  read(l, px, py, out) {
    const a = this.levels[l];
    const s = 1 / (1 << l);
    const x = Math.min(a.w - 1, Math.max(0, (px + 0.5) * s - 0.5));
    const y = Math.min(a.h - 1, Math.max(0, (py + 0.5) * s - 0.5));
    const x0 = x | 0;
    const y0 = y | 0;
    const x1 = Math.min(a.w - 1, x0 + 1);
    const y1 = Math.min(a.h - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const c = a.c;
    const i00 = (y0 * a.w + x0) * 3;
    const i01 = (y0 * a.w + x1) * 3;
    const i10 = (y1 * a.w + x0) * 3;
    const i11 = (y1 * a.w + x1) * 3;
    for (let k = 0; k < 3; k++) {
      const t0 = c[i00 + k] + (c[i01 + k] - c[i00 + k]) * fx;
      const t1 = c[i10 + k] + (c[i11 + k] - c[i10 + k]) * fx;
      out[k] = t0 + (t1 - t0) * fy;
    }
  }

  // colour at a fractional pyramid level (blend of the two nearest copies)
  sample(lv, px, py) {
    const l0 = lv | 0;
    const o = this.o;
    this.read(l0, px, py, o);
    const f = lv - l0;
    if (f > 1e-4 && l0 + 1 < this.levels.length) {
      const t = this.t;
      this.read(l0 + 1, px, py, t);
      for (let k = 0; k < 3; k++) o[k] += (t[k] - o[k]) * f;
    }
  }

  // table T at progress u, table copy `lt` (fractional: the two nearest blended) -> out[0..2]
  tap(T, lt, u, out) {
    const l0 = lt | 0;
    tapLevel(T, l0, u, out);
    const f = lt - l0;
    if (f > 1e-4 && l0 + 1 < T.count) {
      const t = this.u;
      tapLevel(T, l0 + 1, u, t);
      for (let k = 0; k < 3; k++) out[k] += (t[k] - out[k]) * f;
    }
  }

  // Reads the scanner at `points` points into this.cur (level 0, DC removed) + its halved copies.
  // g: { type, cx, cy, len, a, b, deg, path } (pixels, degrees; path: polyPath of a Triangle /
  // Rectangle), span: pixels per cycle
  build(g, points, span, T = this.cur) {
    const b = T.buf;
    const top = this.levels.length - 1;
    // the image copy where one point covers about one pixel: each point averages its stretch
    const lv = Math.min(top, Math.max(0, Math.log2(Math.max(1, span / points))));
    const r = (g.deg * Math.PI) / 180;
    const dx = Math.cos(r);
    const dy = -Math.sin(r);
    const o = this.o;
    let s0 = 0; let s1 = 0; let s2 = 0;
    const q = [0, 0];
    for (let j = 0; j < points; j++) {
      const u = j / points;
      if (g.path) {
        g.path.at(u, q);
        this.sample(lv, q[0], q[1]);
      } else if (g.type === SCAN.OVAL) { // local (a cos, b sin), rotated; y down on the image
        const lx = g.a * Math.cos(2 * Math.PI * u);
        const ly = g.b * Math.sin(2 * Math.PI * u);
        this.sample(lv, g.cx + lx * dx + ly * dy, g.cy + lx * dy - ly * dx);
      } else {
        const t = (u - 0.5) * g.len;
        this.sample(lv, g.cx + t * dx, g.cy + t * dy);
      }
      b[j * 3] = o[0]; b[j * 3 + 1] = o[1]; b[j * 3 + 2] = o[2];
      s0 += o[0]; s1 += o[1]; s2 += o[2];
    }
    s0 /= points; s1 /= points; s2 /= points;
    for (let j = 0; j < points; j++) { b[j * 3] -= s0; b[j * 3 + 1] -= s1; b[j * 3 + 2] -= s2; }
    T.off[0] = 0;
    T.len[0] = points;
    tableLevels(T);
    this.rebuilds++;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    const bufL = out[0];
    const bufR = out[1] ?? null;
    bufL.fill(0);
    bufR?.fill(0);
    const p = this.p;
    if (!this.levels) {
      for (const v of this.voices) v.stage = 0;
      this.wasActive = false;
      return false;
    }
    const { w: W, h: H } = this.levels[0];
    const k = 1 - Math.exp(-n / (SMOOTH_S * sampleRate));
    const E = curveEnv(p);
    let sounding = false;
    for (let vi = 0; vi < this.poly && !sounding; vi++) sounding = this.voices[vi].stage !== 0;

    // scanner glide: position, size and angle (while silent it jumps to its place); the Propellor
    // turns on while silent too
    const type = p.scanType | 0;
    const oval = type === SCAN.OVAL;
    const box = sized(type); // Oval / Rectangle: Width, Height, Rotation
    const rest = !this.wasActive;
    const g0 = !rest && this.g ? this.g : { x: p.x, y: p.y, length: p.length, ow: p.ovalWidth, oh: p.ovalHeight, tri: TRI.map((id) => p[id]) };
    const glide = (a, b) => (Math.abs(b - a) < 1e-6 ? b : a + (b - a) * k);
    const g1 = { x: glide(g0.x, p.x), y: glide(g0.y, p.y), length: glide(g0.length, p.length), ow: glide(g0.ow, p.ovalWidth), oh: glide(g0.oh, p.ovalHeight),
      tri: TRI.map((id, i) => glide(g0.tri[i], p[id])) };
    this.g = g1;
    const rotT = Number(box ? p.ovalRotation : p.rotation) || 0;
    if (rest && type !== SCAN.PROPELLOR) this.angle = wrapDeg(rotT);
    const a0 = this.angle;
    if (type === SCAN.PROPELLOR) this.angle = wrapDeg(a0 + (((Number(p.speed) || 0) * 360) / sampleRate) * n);
    else {
      const d = wrapDeg(rotT - a0); // the short way round
      this.angle = wrapDeg(Math.abs(d) < 1e-6 ? a0 + d : a0 + d * k);
    }
    if (!sounding) {
      this.wasActive = false;
      return false;
    }

    // the table of the scanner where it is at the end of this block (rebuilt when that changed)
    const c1 = scanCenter(g1.x, g1.y, g1.length, W, H, type === SCAN.LINE ? this.angle : undefined);
    const e1 = ovalAxes(g1.ow, g1.oh, W, H);
    const points = resPoints(p.resolution);
    const tri = type === SCAN.TRIANGLE ? triCorners(Object.fromEntries(TRI.map((id, i) => [id, g1.tri[i]])), W, H) : null;
    const nk = this.nextKey;
    const line = type <= SCAN.PROPELLOR;
    nk[0] = type; nk[1] = tri ? 0 : c1.cx; nk[2] = tri ? 0 : c1.cy; nk[3] = line ? c1.len : 0; nk[4] = box ? e1.a : 0; nk[5] = box ? e1.b : 0;
    nk[6] = tri ? 0 : this.angle; nk[7] = points; nk[8] = this.image;
    for (let i = 0; i < 3; i++) { nk[9 + i] = tri ? tri.xs[i] : 0; nk[12 + i] = tri ? tri.ys[i] : 0; }
    let changed = !this.built;
    for (let i = 0; i < KEY_LEN && !changed; i++) changed = nk[i] !== this.key[i];
    let fade = false;
    if (changed) {
      fade = this.built && !rest;
      if (fade) { const t = this.prev; this.prev = this.cur; this.cur = t; }
      let path = null;
      if (tri) path = polyPath(tri.xs, tri.ys);
      else if (type === SCAN.RECTANGLE) { const r = rectCorners(c1.cx, c1.cy, e1.a, e1.b, this.angle); path = polyPath(r.xs, r.ys); }
      const span = path ? path.length : oval ? ovalPerimeter(e1.a, e1.b) : c1.len;
      this.build({ type, cx: c1.cx, cy: c1.cy, len: c1.len, a: e1.a, b: e1.b, deg: this.angle, path }, points, span);
      this.key.set(nk);
      this.built = true;
    }
    const cur = this.cur;
    const prev = this.prev;
    const prop = type === SCAN.PROPELLOR;

    // colour -> speaker weights, gliding through the block
    const wT = colorWeights(p);
    const w0 = !this.wasActive || !this.w ? wT : this.w;
    const w1 = { L: w0.L.map((v, c) => v + (wT.L[c] - v) * k), R: w0.R.map((v, c) => v + (wT.R[c] - v) * k) };
    this.w = w1;
    const [lr, lg, lb] = w0.L;
    const [rr, rg, rb] = w0.R;
    const dlr = (w1.L[0] - lr) / n; const dlg = (w1.L[1] - lg) / n; const dlb = (w1.L[2] - lb) / n;
    const drr = (w1.R[0] - rr) / n; const drg = (w1.R[1] - rg) / n; const drb = (w1.R[2] - rb) / n;
    const o = this.o;
    const t = this.t;
    // the table copy where a voice moves about one point per sample
    const levelOf = (T, inc) => Math.min(T.count - 1, Math.max(0, Math.log2(Math.max(1, inc * T.len[0]))));

    let active = 0;
    for (let vi = 0; vi < this.poly; vi++) {
      const v = this.voices[vi];
      if (!v.stage) continue;
      active++;
      let vel = v.vel;
      const velStep = this.glide(v, k, n);
      const inc = Math.min(0.45, (440 * Math.pow(2, (v.pitch - 69) / 12)) / sampleRate);
      // the voice's tables: the shared ones, or its own Propellor turned by its phase
      let vc = cur;
      let vp = prev;
      let vf = fade;
      if (prop && v.spin) {
        const S = (v.own ??= { cur: table(), prev: table(), key: new Float64Array(KEY_LEN), built: false });
        nk[6] = wrapDeg(this.angle + v.spin);
        let changed = !S.built;
        for (let i = 0; i < KEY_LEN && !changed; i++) changed = nk[i] !== S.key[i];
        vf = changed && !(v.fresh && !S.built);
        if (changed) {
          if (S.built) { const t = S.prev; S.prev = S.cur; S.cur = t; }
          this.build({ type, cx: c1.cx, cy: c1.cy, len: c1.len, deg: nk[6] }, points, c1.len, S.cur);
          vp = S.built ? S.prev : cur; // mid-note to the Propellor: from the shared table
          S.key.set(nk);
          S.built = true;
        }
        vc = S.cur;
      } else if (v.own?.built) { // back to the shared table (another scanner type): crossfade from its own
        vf = true;
        vp = v.own.cur;
        v.own.built = false;
      }
      v.fresh = false;
      const lc = levelOf(vc, inc);
      const lp = vf ? levelOf(vp, inc) : 0;
      curveBlock(v, E);
      for (let i = 0; i < n; i++) {
        const lvl = curveTick(v, E);
        if (!v.stage) break;
        vel += velStep;
        this.tap(vc, lc, v.pos, o);
        if (vf) {
          this.tap(vp, lp, v.pos, t);
          const x = (i + 1) / n;
          o[0] = t[0] + (o[0] - t[0]) * x; o[1] = t[1] + (o[1] - t[1]) * x; o[2] = t[2] + (o[2] - t[2]) * x;
        }
        const a = lvl * vel;
        const r = o[0];
        const g = o[1];
        const b = o[2];
        const L = (lr + dlr * i) * r + (lg + dlg * i) * g + (lb + dlb * i) * b;
        const R = (rr + drr * i) * r + (rg + drg * i) * g + (rb + drb * i) * b;
        if (bufR) { bufL[i] += L * a; bufR[i] += R * a; }
        else bufL[i] += (L + R) * 0.5 * a; // mono: both sides
        v.pos += inc;
        if (v.pos >= 1) v.pos -= 1;
      }
    }
    this.wasActive = active > 0;

    const gain = p.gain * 0.5;
    if (bufR) {
      for (let i = 0; i < n; i++) { bufL[i] *= gain; bufR[i] *= gain; }
      for (let c = 2; c < out.length; c++) out[c].set(c % 2 ? bufR : bufL);
    } else for (let i = 0; i < n; i++) bufL[i] *= gain;
    return active > 0;
  }
}
