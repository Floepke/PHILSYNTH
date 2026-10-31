// Sample interpolation shared by SAMPLER and WAVETABLE (also used on the audio thread: no DOM).
//   0 Off     nearest sample (gritty, aliased: the classic early-sampler sound)
//   1 Linear  straight line between neighbours (cheap, dulls the top end a little)
//   2 Spline  4-point cubic Hermite (Catmull-Rom) through the neighbours, as in MODULATOR
export const INTERP_NAMES = ['Off', 'Linear', 'Spline'];

const cubic = (y0, y1, y2, y3, f) =>
  ((0.5 * (-y0 + 3 * y1 - 3 * y2 + y3) * f + y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3) * f + 0.5 * (y2 - y0)) * f + y1;

// buf read at fractional index x; samples outside 0..len-1 are silence (one-shot sample).
export function readClamped(buf, len, x, mode) {
  if (mode === 0) {
    const i = Math.round(x);
    return i >= 0 && i < len ? buf[i] : 0;
  }
  const i = Math.floor(x);
  const f = x - i;
  const at = (k) => (k >= 0 && k < len ? buf[k] : 0);
  if (mode === 1) { const a = at(i); return a + (at(i + 1) - a) * f; }
  return cubic(at(i - 1), at(i), at(i + 1), at(i + 2), f);
}

// buf of `size` samples read as one cycle at fractional index x (0 <= x < size), wrapping around.
export function readWrapped(buf, size, x, mode) {
  if (mode === 0) { const i = Math.round(x); return buf[i >= size ? i - size : i]; }
  const i = Math.floor(x);
  const f = x - i;
  const i1 = i + 1 >= size ? i + 1 - size : i + 1;
  if (mode === 1) { const a = buf[i]; return a + (buf[i1] - a) * f; }
  const i0 = i ? i - 1 : size - 1;
  const i2 = i1 + 1 >= size ? i1 + 1 - size : i1 + 1;
  return cubic(buf[i0], buf[i], buf[i1], buf[i2], f);
}
