// PITCH2CTL panel keyboard: all 128 MIDI keys (C-1 .. G9) with the Low Key / High Key range.
// Drag on the keys to move the nearest handle (a click jumps it there), double-click a handle to
// reset it. The newest sounding note lights up; the line below names the range and hovered key.
// Key colours follow the piano roll keyboard (src/seq/pianoroll.js).
import { isBlack, noteName } from '../song.js';
import { KEY_MAX } from './pitch2ctl.dsp.js';

const KEYS = KEY_MAX + 1;
const STRIP = 16; // handle labels above the keys
const HEIGHT = 70;

// white keys left of every key: a key's white index (black keys: of the white key before them)
const WHITE_BEFORE = [];
let whites = 0;
for (let p = 0; p < KEYS; p++) { WHITE_BEFORE.push(whites); if (!isBlack(p)) whites++; }
export const WHITE_KEYS = whites; // 75

// x of the left edge / centre of key `p` on a keyboard `w` wide, and the black key width
export function keyGeometry(p, w) {
  const ww = w / WHITE_KEYS;
  if (!isBlack(p)) return { left: WHITE_BEFORE[p] * ww, width: ww, centre: (WHITE_BEFORE[p] + 0.5) * ww };
  const bw = ww * 0.64;
  const centre = WHITE_BEFORE[p] * ww; // on the border of the white keys around it
  return { left: centre - bw / 2, width: bw, centre };
}

// the key under x: on a real keyboard, the upper part (`upper`, where the black keys are) hits a
// black key first; below it, or between black keys, the white key there
export function keyAt(x, w, upper = false) {
  const ww = w / WHITE_KEYS;
  const wi = Math.max(0, Math.min(WHITE_KEYS - 1, Math.floor(x / ww)));
  let white = WHITE_BEFORE.findIndex((n, p) => n === wi && !isBlack(p));
  if (upper) {
    for (const p of [white - 1, white + 1]) {
      if (p < 0 || p > KEY_MAX || !isBlack(p)) continue;
      const k = keyGeometry(p, w);
      if (x >= k.left && x < k.left + k.width) return p;
    }
  }
  return white;
}

const label = (p) => `${noteName(p)} (${p})`;

export function createPitchRangeView({ color = '#7d5fd1', values, params, playing = () => null, setParam, beginEdit, endEdit }) {
  const el = document.createElement('div');
  el.className = 'p2c-view';
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  const info = document.createElement('div');
  info.className = 'p2c-info';
  el.append(cv, info);
  const g = cv.getContext('2d');
  const def = (id) => params.find((p) => p.id === id)?.default ?? 0;
  let low = Math.round(values.lowKey ?? def('lowKey'));
  let high = Math.round(values.highKey ?? def('highKey'));
  let hover = null;
  let lit = null; // pitch drawn as playing
  let drag = null; // 'lowKey' | 'highKey'

  const showInfo = () => {
    const span = Math.abs(high - low);
    const flip = low > high ? ' · flipped' : '';
    const range = `${label(low)} → ${label(high)}${flip}`;
    info.textContent = hover !== null ? `${label(hover)}${hover === low ? ' · Low Key' : hover === high ? ' · High Key' : ''}` : range;
    cv.setAttribute('aria-label', `Key range ${range}, ${span} semitone${span === 1 ? '' : 's'}`);
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
    const kh = h - STRIP;
    const bh = Math.round(kh * 0.6);
    const lo = Math.min(low, high);
    const hi = Math.max(low, high);
    const inRange = (p) => p >= lo && p <= hi;
    const litKey = lit === null ? null : Math.max(0, Math.min(KEY_MAX, Math.floor(lit + 0.5)));

    // white keys, then black keys on top (light in the range, dimmed outside)
    for (let p = 0; p < KEYS; p++) {
      if (isBlack(p)) continue;
      const k = keyGeometry(p, w);
      g.fillStyle = p === litKey ? color : inRange(p) ? '#d7d8dd' : '#6c6e77';
      g.fillRect(k.left, STRIP, k.width, kh);
      // borders only where no black key separates the white keys (E|F, B|C)
      if (p < KEY_MAX && !isBlack(p + 1)) {
        g.fillStyle = 'rgba(0, 0, 0, 0.5)';
        g.fillRect(Math.round(k.left + k.width) - 0.5, STRIP, 1, kh);
      }
    }
    for (let p = 0; p < KEYS; p++) {
      if (!isBlack(p)) continue;
      const k = keyGeometry(p, w);
      g.fillStyle = p === litKey ? color : inRange(p) ? '#191a20' : '#2b2c33';
      g.fillRect(k.left, STRIP, k.width, bh);
    }
    // the range tinted in the module colour
    const a = keyGeometry(lo, w);
    const b = keyGeometry(hi, w);
    g.globalAlpha = 0.28;
    g.fillStyle = color;
    g.fillRect(a.left, STRIP, b.left + b.width - a.left, kh);
    g.globalAlpha = 1;
    // the playing key on top, in full colour (a white key keeps its black neighbours over it)
    if (litKey !== null) {
      const k = keyGeometry(litKey, w);
      g.fillStyle = color;
      g.fillRect(k.left, STRIP, k.width, isBlack(litKey) ? bh : kh);
      if (!isBlack(litKey)) {
        for (const p of [litKey - 1, litKey + 1]) {
          if (p < 0 || p > KEY_MAX || !isBlack(p)) continue;
          const n = keyGeometry(p, w);
          g.fillStyle = inRange(p) ? '#191a20' : '#2b2c33';
          g.fillRect(n.left, STRIP, n.width, bh);
        }
      }
    }
    // a tick above every C, middle C (60) longer
    g.fillStyle = '#8a8c96';
    for (let p = 0; p < KEYS; p += 12) {
      const x = Math.round(keyGeometry(p, w).left) + 0.5;
      g.fillRect(x - 0.5, p === 60 ? STRIP - 6 : STRIP - 3, 1, p === 60 ? 6 : 3);
    }
    // exact pitch of the playing note (cents) as a thin line
    if (lit !== null) {
      const f = lit - Math.floor(lit);
      const x = keyGeometry(Math.floor(lit), w).centre + f * (keyGeometry(Math.min(KEY_MAX, Math.floor(lit) + 1), w).centre - keyGeometry(Math.floor(lit), w).centre);
      g.fillStyle = '#fff';
      g.fillRect(Math.round(x) - 0.5, STRIP, 1, kh);
    }
    if (hover !== null) {
      const k = keyGeometry(hover, w);
      g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      g.lineWidth = 1;
      g.strokeRect(k.left + 0.5, STRIP + 0.5, Math.max(1, k.width - 1), (isBlack(hover) ? bh : kh) - 1);
    }
    // handles: a line through the keys and a labelled tab above them (Low left of its line,
    // High right of it; swapped when flipped)
    g.font = '600 10px system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (const [p, left] of [[low, low <= high], [high, low > high]]) {
      const x = Math.round(keyGeometry(p, w).centre) + 0.5;
      g.fillStyle = '#fff';
      g.fillRect(x - 1, STRIP - 2, 2, kh + 2);
      const text = noteName(p);
      const tw = g.measureText(text).width + 8;
      let tx = left ? x - tw : x;
      tx = Math.max(0, Math.min(w - tw, tx));
      g.fillStyle = color;
      g.beginPath();
      g.roundRect(tx, 1, tw, STRIP - 4, 3);
      g.fill();
      g.fillStyle = '#fff';
      g.fillText(text, tx + 4, 1 + (STRIP - 4) / 2 + 0.5);
    }
  };

  const pitchOf = (e) => {
    const r = cv.getBoundingClientRect();
    const y = e.clientY - r.top;
    return keyAt(e.clientX - r.left, cv.clientWidth, y < STRIP + Math.round((cv.clientHeight - STRIP) * 0.6));
  };
  // the handle a press moves: the nearer one (equal distance: the side the press is on)
  const handleFor = (p) => {
    const dl = Math.abs(p - low);
    const dh = Math.abs(p - high);
    if (dl !== dh) return dl < dh ? 'lowKey' : 'highKey';
    return (p < low) === (low <= high) ? 'lowKey' : 'highKey';
  };
  const put = (id, p) => {
    if ((id === 'lowKey' ? low : high) === p) return;
    if (id === 'lowKey') low = p; else high = p;
    setParam?.(id, p);
    showInfo();
    draw();
  };

  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = pitchOf(e);
    drag = handleFor(p);
    cv.setPointerCapture(e.pointerId);
    beginEdit?.();
    put(drag, p);
  });
  cv.addEventListener('pointermove', (e) => {
    const p = pitchOf(e);
    if (drag) put(drag, p);
    if (hover !== p) { hover = p; showInfo(); draw(); }
  });
  const stop = () => { if (drag) { drag = null; endEdit?.(); } };
  cv.addEventListener('pointerup', stop);
  cv.addEventListener('pointercancel', stop);
  cv.addEventListener('pointerleave', () => { if (!drag && hover !== null) { hover = null; showInfo(); draw(); } });
  cv.addEventListener('dblclick', (e) => {
    const p = pitchOf(e);
    const id = handleFor(p);
    if (Math.abs(p - (id === 'lowKey' ? low : high)) > 1) return;
    put(id, Math.round(def(id)));
  });

  // follow the playing note (it is set by the module on the main thread)
  const tick = () => {
    if (!el.isConnected && el.dataset.started) return;
    if (el.isConnected) el.dataset.started = '1';
    const n = playing();
    const pitch = n ? Math.max(0, Math.min(KEY_MAX, n.pitch)) : null;
    if (pitch !== lit) { lit = pitch; draw(); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  new ResizeObserver(draw).observe(cv);
  showInfo();
  return {
    el,
    refresh(v) {
      const l = Math.round(v.lowKey ?? low);
      const hh = Math.round(v.highKey ?? high);
      if (l === low && hh === high) return;
      low = l;
      high = hh;
      showInfo();
      draw();
    },
  };
}
