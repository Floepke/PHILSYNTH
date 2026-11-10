// Live audio on the cables: the engine graph streams the waveform of the nodes feeding the visible
// cables (Graph.scope, one point per SCOPE_DECIM = 4 samples), and each cable draws that stream
// along its own curve, newest audio at the source port. One point per STEP px, so a longer cable
// shows a longer stretch of audio (about 0.08 ms per point at 48 kHz: a 300 px cable ≈ 8 ms).
// Drawn at the real speed the wave would race past far too fast to read, so every frame the
// window locks onto a rising zero crossing of the stream (hysteresis, sub-point accurate): a
// periodic wave stands still and drifts slowly (DRIFT px/s) from the source towards the
// destination. Without a stable period (noise, very slow signals, silence) the live stream shows.
// Glow: two wide translucent strokes under the wave (no CSS filter: a blur re-rasterised every frame
// costs too much) whose width and opacity follow the signal level (--glow 0..1 on the cable).
// Out of bounds: when a raw sample of the node went beyond ±1 (Graph.scope's clip flags), the
// cable gets the class `clipping` (its complementary color, style.css) for CLIP_HOLD ms.
import { samplePoints } from './cable.js';

const SVGNS = 'http://www.w3.org/2000/svg';
export const RING = 8192; // points kept per node (~0.7 s; the graph sends SCOPE_QUIET zeros after the sound stops)
export const STEP = 3; // world px between two points on a cable
export const AMP = 16; // max displacement in world px
export const DRIFT = 45;
export const GLOW_DB = 48; // level range of the glow: -48 dB .. 0 dB peak -> 0..1
export const CLIP_HOLD = 400; // ms a cable stays marked after its last out-of-bounds sample
const GLOW_RELEASE = 2.5; // glow falls by this much per second (rises at once)
const EDGE = 10; // points over which the wave fades in/out at the ports
const LOOK = 2048; // points searched for zero crossings beyond the longest cable (periods up to ~170 ms)
const HYST = 0.25; // a rising crossing counts after the wave went below -HYST × its peak

// Displacement for value v at point i of n: soft-clipped and pinned to zero at both ports.
export function displace(v, i, n) {
  const e = Math.min(1, i / EDGE, (n - 1 - i) / EDGE);
  return AMP * Math.tanh(1.5 * v) * e * e * (3 - 2 * e);
}

// Value history of one node. at(0) is the newest; count = points pushed so far.
export class Ring {
  constructor(size = RING) {
    this.buf = new Float32Array(size);
    this.pos = 0; // next write
    this.count = 0;
    this.quiet = size; // points since the last non-zero one
  }

  push(v) {
    this.buf[this.pos] = v;
    this.pos = (this.pos + 1) % this.buf.length;
    this.count++;
    this.quiet = v !== 0 ? 0 : Math.min(this.quiet + 1, this.buf.length);
  }

  at(age) {
    const n = this.buf.length;
    if (age >= n || age < 0) return 0;
    return this.buf[(this.pos - 1 - age + n * 2) % n];
  }

  // linear interpolation between points (fractional age)
  lerp(age) {
    const i = Math.floor(age);
    const f = age - i;
    return f ? this.at(i) + (this.at(i + 1) - this.at(i)) * f : this.at(i);
  }
}

// Ages (ascending, fractional) of the rising zero crossings within ages 0..maxAge, with hysteresis.
export function crossings(ring, maxAge) {
  const top = Math.min(maxAge, ring.buf.length - 1);
  let peak = 0;
  for (let a = 0; a <= top; a++) peak = Math.max(peak, Math.abs(ring.at(a)));
  const out = [];
  if (!(peak > 1e-6)) return out;
  const h = -HYST * peak;
  let armed = false;
  let prev = ring.at(top);
  for (let a = top - 1; a >= 0; a--) { // oldest -> newest
    const v = ring.at(a);
    if (v < h) armed = true;
    if (armed && prev < 0 && v >= 0) {
      out.push(a + v / (v - prev)); // the zero between age a + 1 (prev) and a (v)
      armed = false;
    }
    prev = v;
  }
  return out.reverse();
}

// Median distance between neighbouring crossings (the period in points), 0 when unknown.
export function period(xs) {
  if (xs.length < 2) return 0;
  const d = [];
  for (let i = 1; i < Math.min(xs.length, 9); i++) d.push(xs[i] - xs[i - 1]);
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

// Start age of a cable's window this frame. prev: the last start age; advanced: points that came in
// since; drift: points the wave should travel towards the destination. The wave keeps its phase
// relative to the crossings, placed on the newest crossing that keeps the window in the data.
export function lockAge(xs, P, prev, advanced, drift, n, size = RING) {
  if (!(P > 0) || xs.length < 2) return 0;
  const want = prev + advanced - drift;
  let k = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - want) < Math.abs(xs[k] - want)) k = i;
  let o = want - xs[k];
  if (Math.abs(o) > P) o %= P;
  let j = 0;
  while (j < xs.length && xs[j] + o < 0) j++;
  if (j === xs.length) return 0;
  const a = xs[j] + o;
  // the newest crossing is old (sound stopped / changed): show the live stream
  if (a > 2 * P + 2 || a + n >= size - 1) return 0;
  return a;
}

// Glow level 0..1 of the points shown (ages start..start+n): peak in dB over GLOW_DB.
export function peakGlow(peak) {
  return peak > 0 ? Math.max(0, Math.min(1, 1 + (20 * Math.log10(peak)) / GLOW_DB)) : 0;
}

export function releaseGlow(previous, level, dt) {
  return Math.max(level, previous - GLOW_RELEASE * Math.min(0.1, Math.max(0, dt)));
}

export function glowLevel(ring, start, n) {
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ring.lerp(start + i)));
  return peakGlow(peak);
}

// SVG path along the cable points displaced by the ring values from age `start` on.
export function scopePath(pts, ring, start = 0) {
  const { n, x, y, nx, ny } = pts;
  let d = '';
  for (let i = 0; i < n; i++) {
    const s = displace(ring.lerp(start + i), i, n);
    d += `${i ? 'L' : 'M'}${(x[i] + nx[i] * s).toFixed(1)},${(y[i] + ny[i] * s).toFixed(1)}`;
  }
  return d;
}

export class CableScope {
  constructor(host) {
    this.host = host;
    this.rings = new Map(); // node handle -> Ring
    this.clipUntil = new Map(); // node handle -> performance.now() until which it shows clipping
    this.cables = []; // { g, path, h, pts, shown, a, seen }
    this.key = '';
    this.dirty = false;
    this.last = 0;
    host.onScope = (s) => this.push(s);
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  // list: [{ g: <g class=cable>, h: node handle, from, to }] (world coordinates). Called on every
  // cable redraw; the engine is only told when the set of watched nodes changes.
  setCables(list) {
    this.cables = list.map(({ g, h, from, to }) => {
      const mk = (cls) => {
        const e = document.createElementNS(SVGNS, 'path');
        e.classList.add(cls);
        g.insertBefore(e, g.querySelector('.arrow'));
        return e;
      };
      const glows = [mk('glow'), mk('glow-core')];
      const path = mk('scope');
      const ring = this.rings.get(h);
      return { g, path, glows, h, pts: samplePoints(from, to, STEP), shown: false, a: 0, seen: ring?.count ?? 0, glow: 0, glowShown: -1, clipping: false };
    });
    const hs = [...new Set(list.map((c) => c.h))].sort((a, b) => a - b);
    for (const h of hs) if (!this.rings.has(h)) this.rings.set(h, new Ring());
    for (const h of this.rings.keys()) if (!hs.includes(h)) { this.rings.delete(h); this.clipUntil.delete(h); }
    const key = hs.join(',');
    if (key !== this.key) {
      this.key = key;
      this.host.scope(hs);
    }
    this.dirty = true;
  }

  // { h: [handles], n: points, v: Float32Array [point][node], clip?: [node] } from the graph
  push({ h, n, v, clip }, now = performance.now()) {
    for (let j = 0; j < h.length; j++) {
      const ring = this.rings.get(h[j]);
      if (ring) for (let p = 0; p < n; p++) ring.push(v[p * h.length + j]);
      if (ring && clip?.[j]) this.clipUntil.set(h[j], now + CLIP_HOLD);
    }
    this.dirty = true;
  }

  frame(now = performance.now()) {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (!this.dirty && !this.cables.some((c) => c.shown || c.clipping)) return;
    this.dirty = false;
    const locks = new Map(); // per node: crossings + period, shared by its cables
    for (const c of this.cables) {
      const ring = this.rings.get(c.h);
      const n = c.pts.n;
      let live = !!ring && ring.quiet < RING;
      if (live) {
        let lock = locks.get(c.h);
        if (!lock) {
          const longest = Math.max(...this.cables.filter((o) => o.h === c.h).map((o) => o.pts.n));
          const xs = crossings(ring, longest + LOOK);
          locks.set(c.h, (lock = { xs, P: period(xs) }));
        }
        c.a = lockAge(lock.xs, lock.P, c.a, ring.count - c.seen, (DRIFT / STEP) * dt, n);
        c.seen = ring.count;
        live = ring.quiet <= c.a + n;
      }
      const level = live ? glowLevel(ring, c.a, n) : 0;
      c.glow = releaseGlow(c.glow, level, dt);
      if (live) {
        const d = scopePath(c.pts, ring, c.a);
        c.path.setAttribute('d', d);
        for (const e of c.glows) e.setAttribute('d', d);
      } else if (c.shown) {
        c.path.removeAttribute('d');
        for (const e of c.glows) e.removeAttribute('d');
        c.glow = 0;
      }
      // only when it visibly changed: a new value restyles the cable
      const shownGlow = Math.round(c.glow * 50) / 50;
      if (shownGlow !== c.glowShown) {
        c.glowShown = shownGlow;
        c.g.style.setProperty('--glow', shownGlow);
      }
      if (live !== c.shown) c.g.classList.toggle('live', live);
      c.shown = live;
      const clipping = (this.clipUntil.get(c.h) ?? 0) > now;
      if (clipping !== c.clipping) c.g.classList.toggle('clipping', clipping);
      c.clipping = clipping;
    }
  }
}
