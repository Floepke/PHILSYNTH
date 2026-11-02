// IMAGE SAMPLER DSP kernel (audio thread). Every voice reads the colours under a scanner on an
// image (imagescan.js): it runs from the scanner's start to its end once per cycle of its note, so
// the colours along the scanner are the waveform. Red, green and blue are read separately and
// mixed onto the speakers by their Pan / Level controllers (imagescan.js colorWeights, the weights
// glide per sample, so modulating them is click-free).
//   Line       a straight scanner at Rotation (degrees)
//   Propellor  the scanner spins around its centre at Propellor Speed (turns per second, negative
//              = clockwise); one angle shared by all voices, so chords spin together
//   Oval       once around an ellipse per cycle (Oval Width / Height, rotated by Oval Rotation): a
//              closed path, so the waveform has no jump at the cycle wrap
// X / Y / Length / Rotation / the oval's size glide per block while voices sound (no zipper noise when modulated).
// The waveform's DC (the average of every colour along the scanner) is removed, so bright or dark
// images don't thump.
// Anti-aliasing: the image is kept as a pyramid of half-size copies (each pixel the average of
// four); a voice reads the copy where it moves about one pixel per sample (blending the two
// nearest copies), so high notes and long scanners get smoother instead of aliasing.
// The image arrives from the main thread: { type: 'image', width, height, rgb } (rgb: Uint8Array
// of width * height * 3) or rgb null (no image: silent). ADSR with curves as OSC (poly.dsp.js).
import { PolyKernel, curveEnv, curveStart, curveRelease, curveBlock, curveTick } from './poly.dsp.js';
import { SCAN, scanCenter, ovalAxes, ovalPerimeter, unit, colorWeights, wrapDeg } from './imagescan.js';

const SMOOTH_S = 0.01;
const DC_POINTS = 32; // samples along the scanner for its average colour

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

export default class ImageSamplerKernel extends PolyKernel {
  constructor() {
    super({ atkCurve: 0, decCurve: 0, relCurve: 0, scanType: SCAN.LINE, x: 50, y: 50, length: 70, rotation: 0, speed: 0.5,
      ovalWidth: 60, ovalHeight: 60, ovalRotation: 0,
      redPan: -100, greenPan: 0, bluePan: 100, redLevel: 100, greenLevel: 100, blueLevel: 100 });
    this.levels = null;
    this.g = null; // smoothed scanner: { x, y, length } (controller units), angle in degrees
    this.angle = 0;
    this.dc = [0, 0, 0]; // average r, g, b along the scanner
    this.w = null; // smoothed colour -> speaker weights (colorWeights)
    this.wasActive = false;
    this.o = [0, 0, 0]; // last read colour (sample())
    this.t = [0, 0, 0];
    this.dx = new Float32Array(128);
    this.dy = new Float32Array(128);
  }

  message(m) {
    if (m.type !== 'image') return super.message(m);
    this.levels = m.rgb && m.width > 0 && m.height > 0 && m.rgb.length === m.width * m.height * 3 ? pyramid(m.width, m.height, m.rgb) : null;
  }

  start(v, phase) {
    v.pos = Number.isFinite(phase) ? phase - Math.floor(phase) : 0;
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
    if (this.dx.length < n) { this.dx = new Float32Array(n); this.dy = new Float32Array(n); }
    const top = this.levels.length - 1;
    const { w: W, h: H } = this.levels[0];
    const k = 1 - Math.exp(-n / (SMOOTH_S * sampleRate));
    const E = curveEnv(p);

    // scanner glide: position + size, the angle per sample (while silent it jumps to its place)
    const type = p.scanType | 0;
    const oval = type === SCAN.OVAL;
    const rest = !this.wasActive;
    const g0 = !rest && this.g ? this.g : { x: p.x, y: p.y, length: p.length, ow: p.ovalWidth, oh: p.ovalHeight };
    const glide = (a, b) => (Math.abs(b - a) < 1e-6 ? b : a + (b - a) * k);
    const g1 = { x: glide(g0.x, p.x), y: glide(g0.y, p.y), length: glide(g0.length, p.length), ow: glide(g0.ow, p.ovalWidth), oh: glide(g0.oh, p.ovalHeight) };
    this.g = g1;
    const c0 = scanCenter(g0.x, g0.y, g0.length, W, H);
    const c1 = scanCenter(g1.x, g1.y, g1.length, W, H);
    const e0 = ovalAxes(g0.ow, g0.oh, W, H);
    const e1 = ovalAxes(g1.ow, g1.oh, W, H);
    const rotT = Number(oval ? p.ovalRotation : p.rotation) || 0;
    if (rest && type !== SCAN.PROPELLOR) this.angle = wrapDeg(rotT);
    const a0 = this.angle;
    const toRad = Math.PI / 180;
    if (type === SCAN.PROPELLOR) {
      const step = ((Number(p.speed) || 0) * 360) / sampleRate;
      for (let i = 0; i < n; i++) {
        const a = (a0 + step * i) * toRad;
        this.dx[i] = Math.cos(a);
        this.dy[i] = -Math.sin(a);
      }
      this.angle = wrapDeg(a0 + step * n);
    } else {
      const d = wrapDeg(rotT - a0); // the short way round
      const a1 = Math.abs(d) < 1e-6 ? a0 + d : a0 + d * k;
      for (let i = 0; i < n; i++) {
        const a = (a0 + ((a1 - a0) * i) / n) * toRad;
        this.dx[i] = Math.cos(a);
        this.dy[i] = -Math.sin(a);
      }
      this.angle = wrapDeg(a1);
    }

    // the scanner's point at progress u (0..1) for sample i of this block -> this.sample(lv, ...)
    const sx = (c1.cx - c0.cx) / n;
    const sy = (c1.cy - c0.cy) / n;
    const sl = (c1.len - c0.len) / n;
    const sa = (e1.a - e0.a) / n;
    const sb = (e1.b - e0.b) / n;
    const TAU = 2 * Math.PI;
    const at = (lv, u, i) => {
      const cx = c0.cx + sx * i;
      const cy = c0.cy + sy * i;
      if (oval) { // local (a cos, b sin), rotated; y down on the image
        const lx = (e0.a + sa * i) * Math.cos(TAU * u);
        const ly = (e0.b + sb * i) * Math.sin(TAU * u);
        this.sample(lv, cx + lx * this.dx[i] + ly * this.dy[i], cy + lx * this.dy[i] - ly * this.dx[i]);
      } else {
        const t = (u - 0.5) * (c0.len + sl * i);
        this.sample(lv, cx + t * this.dx[i], cy + t * this.dy[i]);
      }
    };
    // pixels per cycle (the anti-aliasing picks the image copy from it)
    const span = oval ? Math.max(ovalPerimeter(e0.a, e0.b), ovalPerimeter(e1.a, e1.b)) : Math.max(c0.len, c1.len);

    // DC: the average colour along the scanner at the start of this block (glides while sounding)
    {
      const lv = Math.min(top, Math.max(0, Math.log2(Math.max(1, span / DC_POINTS))));
      const s = [0, 0, 0];
      for (let j = 0; j < DC_POINTS; j++) {
        at(lv, (j + 0.5) / DC_POINTS, 0);
        for (let c = 0; c < 3; c++) s[c] += this.o[c];
      }
      for (let c = 0; c < 3; c++) {
        const target = s[c] / DC_POINTS;
        this.dc[c] = this.wasActive ? this.dc[c] + (target - this.dc[c]) * k : target;
      }
    }
    const [dcR0, dcG0, dcB0] = this.dc;

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

    let active = 0;
    for (let vi = 0; vi < this.poly; vi++) {
      const v = this.voices[vi];
      if (!v.stage) continue;
      active++;
      let vel = v.vel;
      const velStep = this.glide(v, k, n);
      const inc = Math.min(0.45, (440 * Math.pow(2, (v.pitch - 69) / 12)) / sampleRate);
      // the copy where the voice moves about one pixel per sample
      const lv = Math.min(top, Math.max(0, Math.log2(Math.max(1, inc * span))));
      curveBlock(v, E);
      for (let i = 0; i < n; i++) {
        const lvl = curveTick(v, E);
        if (!v.stage) break;
        vel += velStep;
        at(lv, v.pos, i);
        const a = lvl * vel;
        const r = o[0] - dcR0;
        const g = o[1] - dcG0;
        const b = o[2] - dcB0;
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
