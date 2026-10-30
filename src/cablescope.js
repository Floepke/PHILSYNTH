// Live audio on the cables: the engine graph reports a stream of signed peak values for the
// nodes feeding the visible cables (Graph.scope, one point per ~5 ms), and each cable draws that
// stream as a wave along its own curve. The newest value enters at the source port and travels
// towards the destination, so the cable shows the last fraction of a second of its signal.
import { samplePoints } from './cable.js';

const SVGNS = 'http://www.w3.org/2000/svg';
export const RING = 1024; // points kept per node (the graph sends SCOPE_QUIET zeros after the sound stops)
export const STEP = 3; // world px between two points on a cable
export const AMP = 8; // max displacement in world px
const EDGE = 10; // points over which the wave fades in/out at the ports

// Displacement for value v at point i of n: soft-clipped and pinned to zero at both ports.
export function displace(v, i, n) {
  const e = Math.min(1, i / EDGE, (n - 1 - i) / EDGE);
  return AMP * Math.tanh(1.5 * v) * e * e * (3 - 2 * e);
}

// Value history of one node. at(0) is the newest.
export class Ring {
  constructor(size = RING) {
    this.buf = new Float32Array(size);
    this.pos = 0; // next write
    this.quiet = size; // points since the last non-zero one
  }

  push(v) {
    this.buf[this.pos] = v;
    this.pos = (this.pos + 1) % this.buf.length;
    this.quiet = v !== 0 ? 0 : Math.min(this.quiet + 1, this.buf.length);
  }

  at(age) {
    const n = this.buf.length;
    if (age >= n) return 0;
    return this.buf[(this.pos - 1 - age + n * 2) % n];
  }
}

// SVG path along the cable points displaced by the ring values.
export function scopePath(pts, ring) {
  const { n, x, y, nx, ny } = pts;
  let d = '';
  for (let i = 0; i < n; i++) {
    const s = displace(ring.at(i), i, n);
    d += `${i ? 'L' : 'M'}${(x[i] + nx[i] * s).toFixed(1)},${(y[i] + ny[i] * s).toFixed(1)}`;
  }
  return d;
}

export class CableScope {
  constructor(host) {
    this.host = host;
    this.rings = new Map(); // node handle -> Ring
    this.cables = []; // { g, path, h, pts, shown }
    this.key = '';
    this.dirty = false;
    host.onScope = (s) => this.push(s);
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  // list: [{ g: <g class=cable>, h: node handle, from, to }] (world coordinates). Called on every
  // cable redraw; the engine is only told when the set of watched nodes changes.
  setCables(list) {
    this.cables = list.map(({ g, h, from, to }) => {
      const path = document.createElementNS(SVGNS, 'path');
      path.classList.add('scope');
      g.insertBefore(path, g.querySelector('.arrow'));
      return { g, path, h, pts: samplePoints(from, to, STEP), shown: false };
    });
    const hs = [...new Set(list.map((c) => c.h))].sort((a, b) => a - b);
    for (const h of hs) if (!this.rings.has(h)) this.rings.set(h, new Ring());
    for (const h of this.rings.keys()) if (!hs.includes(h)) this.rings.delete(h);
    const key = hs.join(',');
    if (key !== this.key) {
      this.key = key;
      this.host.scope(hs);
    }
    this.dirty = true;
  }

  // { h: [handles], n: points, v: Float32Array [point][node] } from the graph
  push({ h, n, v }) {
    for (let j = 0; j < h.length; j++) {
      const ring = this.rings.get(h[j]);
      if (ring) for (let p = 0; p < n; p++) ring.push(v[p * h.length + j]);
    }
    this.dirty = true;
  }

  frame() {
    requestAnimationFrame(this.frame);
    if (!this.dirty) return;
    this.dirty = false;
    for (const c of this.cables) {
      const ring = this.rings.get(c.h);
      const live = !!ring && ring.quiet < c.pts.n;
      if (live) c.path.setAttribute('d', scopePath(c.pts, ring));
      else if (c.shown) c.path.removeAttribute('d');
      if (live !== c.shown) c.g.classList.toggle('live', live);
      c.shown = live;
    }
  }
}
