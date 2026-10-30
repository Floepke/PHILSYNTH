// Clip placement on the TimeLine: clips sit on lanes (y = lane * CLIP_H) and never overlap.
// Times may be negative (clips parked before time zero).
import { clean, LANE_H, laneY } from '../song.js';

export const CLIP_H = LANE_H;
const EPS = 1e-9;
const sameRow = (a, b) => a.y < b.y + CLIP_H - EPS && a.y + CLIP_H > b.y + EPS;

export const clipsOverlap = (a, b) => sameRow(a, b)
  && a.start < b.start + b.length - EPS && a.start + a.length > b.start + EPS;

// The nearest free position lies on the requested lane or a lane next to another clip.
// At each such y, merge forbidden start-time intervals to find the closest free time.
export function findClipPosition(clips, clip, { start = clip.start, y = clip.y } = {}, ppq = 16) {
  const wanted = { start, y: laneY(y), length: clip.length };
  const others = clips.filter((c) => c !== clip).sort((a, b) => a.start - b.start);
  if (!others.some((c) => clipsOverlap(wanted, c))) return { start: wanted.start, y: wanted.y };

  const rows = new Set([wanted.y]);
  for (const c of others) {
    if (c.y >= CLIP_H) rows.add(clean(c.y - CLIP_H));
    rows.add(clean(c.y + CLIP_H));
  }
  let best = { start: wanted.start, y: Math.max(...others.map((c) => c.y + CLIP_H)) };
  let distance = (best.y - wanted.y) ** 2;
  for (const y of [...rows].sort((a, b) => Math.abs(a - wanted.y) - Math.abs(b - wanted.y))) {
    const dy2 = (y - wanted.y) ** 2;
    if (dy2 > distance + EPS) break;
    const blocked = [];
    for (const c of others) {
      if (!sameRow({ y }, c)) continue;
      const left = clean(c.start - clip.length);
      const right = clean(c.start + c.length);
      const last = blocked.at(-1);
      if (last && left < last[1] - EPS) last[1] = Math.max(last[1], right);
      else blocked.push([left, right]);
    }
    let start = wanted.start;
    const interval = blocked.find(([left, right]) => start > left + EPS && start < right - EPS);
    if (interval) {
      const [left, right] = interval;
      start = start - left < right - start ? left : right;
    }
    const d = ((start - wanted.start) * ppq) ** 2 + dy2;
    if (d < distance - EPS || (Math.abs(d - distance) <= EPS && y === wanted.y)) {
      best = { start, y };
      distance = d;
    }
  }
  return best;
}

// Resizing keeps the other edge and vertical position fixed.
export function clipResizeBounds(clips, clip) {
  let start = -Infinity;
  let end = Infinity;
  for (const c of clips) {
    if (c === clip || !sameRow(c, clip)) continue;
    const right = clean(c.start + c.length);
    if (right <= clip.start + EPS) start = Math.max(start, right);
    if (c.start >= clip.start + clip.length - EPS) end = Math.min(end, c.start);
  }
  return { start, end };
}
