import { barLines } from '../song.js';

export const GRID_MIN_PX = 30;
export const TIME_GRID = {
  color: '#111216',
  width: 4,
  beatDash: [12, 12],
  band: 'rgba(0, 0, 0, 0.10)',
};

export const beatsShown = (m, ppq) => Math.min(...m.map((x) => x.beat)) * ppq >= GRID_MIN_PX;

// Anchor thinning at the clip start so scrolling does not change which bars are visible.
export function spacedBars(m, from, t0, t1, ppq) {
  const out = [];
  let last = -Infinity;
  for (const b of barLines(null, Math.min(from, t0), t1, m)) {
    if ((b.t - last) * ppq < GRID_MIN_PX - 1e-9) continue;
    last = b.t;
    if (b.t >= t0 - 1e-7) out.push(b);
  }
  return out;
}
