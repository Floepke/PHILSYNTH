// Phase delay of a FILTER at one frequency, from its controller values (the exact frequency
// response of filter.dsp.js: its SVF and ladder are bilinear (TPT) transforms of their analog
// prototypes, so evaluating the prototype at the prewarped frequency is exact). Used by the graph
// to keep a sound loop through a DELAY in Note unit at the note's pitch (see Graph.tuneLoops):
// a filter in the loop delays the ringing tone too, which made the string go flat as the cutoff
// went down. Nonlinear parts (Drive, the ladder's saturation) and the cutoff LFO are left out.
import { T, VOWELS, qFromRes } from '../modules/filter.dsp.js';

const DEFAULTS = { type: T.LP, slope: 1, cutoff: 1000, resonance: 0.1, gain: 0, vowel: 0, mix: 1 };

// complex numbers as [re, im]
const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const div = (a, b) => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const arg = (a) => Math.atan2(a[1], a[0]);

// one SVF stage: H(S) = (n2 S² + n1 S + n0) / (S² + k S + 1), S = j t / g, as { h, phase }.
// The denominator's phase runs continuously from 0 to π, so a 2nd-order all-pass reaches -2π
// without wrapping.
const svfStage = (t, g, k, n2, n1, n0) => {
  const w = t / g;
  const num = [n0 - n2 * w * w, n1 * w];
  const den = [1 - w * w, k * w];
  return { h: div(num, den), phase: arg(num) - arg(den) };
};

// numerator [S², S, 1] of an SVF output (see the type switch in filter.dsp.js)
function svfNumerator(type, k, A) {
  switch (type) {
    case T.LP: return [0, 0, 1];
    case T.HP: return [1, 0, 0];
    case T.BP: return [0, k, 0];
    case T.NOTCH: return [1, 0, 1];
    case T.PEAK: return [-1, 0, 1];
    case T.AP: return [1, -k, 1];
    case T.BELL: return [1, k * A * A, 1];
    case T.LSHELF: return [1, k * A, A * A];
    default: return [A * A, k * A, 1]; // HSHELF
  }
}

// filter response at frequency f as { h: [re, im], phase: unwrapped phase of h (radians) }
function response(v, f, sr) {
  const type = v.type | 0;
  const fMax = Math.min(20000, sr * 0.45);
  const fc = Math.max(10, Math.min(fMax, v.cutoff));
  const wd = Math.tan(Math.PI * fc / sr);
  const t = Math.tan(Math.PI * Math.min(f, sr * 0.499) / sr);
  const w = 2 * Math.PI * f / sr;
  if (type <= T.HSHELF) {
    const shelf = type === T.LSHELF || type === T.HSHELF;
    const Q = shelf ? 0.5 + v.resonance * 1.5 : qFromRes(v.resonance);
    const A = Math.pow(10, v.gain / 40);
    let g = wd;
    let k = 1 / Q;
    if (type === T.BELL) k = 1 / (Q * A);
    else if (type === T.LSHELF) g = wd / Math.sqrt(A);
    else if (type === T.HSHELF) g = wd * Math.sqrt(A);
    const stages = type <= T.AP ? Math.min(4, (v.slope | 0) + 1) : 1;
    let h = [1, 0];
    let phase = 0;
    for (let st = 0; st < stages; st++) {
      const last = st === stages - 1;
      const kk = last ? k : Math.SQRT2; // earlier stages are Butterworth
      const [n2, n1, n0] = svfNumerator(type, kk, A);
      const s = svfStage(t, last ? g : wd, kk, n2, n1, n0);
      h = mul(h, s.h);
      phase += s.phase;
    }
    return { h, phase };
  }
  if (type === T.LADDER) {
    // linearised ZDF ladder: (1 + k/2) H1⁴ / (1 + k H1⁴), H1 = 1 / (1 + S)
    const h1 = div([1, 0], [1, t / wd]);
    const h4 = mul(mul(h1, h1), mul(h1, h1));
    const kL = v.resonance * 4.2;
    const den = [1 + kL * h4[0], kL * h4[1]];
    const h = div([(1 + kL / 2) * h4[0], (1 + kL / 2) * h4[1]], den);
    return { h, phase: 4 * arg(h1) - arg(den) };
  }
  if (type === T.FORMANT) {
    const vi = Math.max(0, Math.min(4, v.vowel));
    const i0 = Math.min(3, Math.floor(vi));
    const fr = vi - i0;
    const kF = 1 / (5 + v.resonance * 25);
    let h = [0, 0];
    for (let n = 0; n < 3; n++) {
      const [f0, g0] = VOWELS[i0][n];
      const [f1, g1] = VOWELS[i0 + 1][n];
      const ff = Math.min(fMax, f0 * Math.pow(f1 / f0, fr));
      const bp = svfStage(t, Math.tan(Math.PI * ff / sr), kF, 0, 1, 0).h;
      const a = 2 * kF * (g0 + (g1 - g0) * fr);
      h = [h[0] + a * bp[0], h[1] + a * bp[1]];
    }
    return { h, phase: arg(h) };
  }
  // feedback comb: (1 - |fb|) / (1 - fb e^(-jωd))
  const fb = (type === T.COMB_NEG ? -1 : 1) * v.resonance * 0.97;
  const d = Math.min(Math.ceil(sr / 10) + 2, sr / fc);
  const den = [1 - fb * Math.cos(w * d), fb * Math.sin(w * d)];
  const h = div([1 - Math.abs(fb), 0], den);
  return { h, phase: -arg(den) };
}

// Phase delay (samples) of a FILTER with controller values `values` at frequency f (Hz).
// Positive: the tone comes out later (a low-pass); negative: earlier (a high-pass).
export function filterPhaseDelay(values, f, sr) {
  if (!(f > 0) || !(sr > 0)) return 0;
  const v = { ...DEFAULTS };
  for (const key in DEFAULTS) if (Number.isFinite(+values?.[key])) v[key] = +values[key];
  const { h, phase: filtered } = response(v, f, sr);
  const mix = Math.max(0, Math.min(1, v.mix));
  let phase = filtered;
  if (mix < 1) {
    // dry + (filtered - dry) · mix; keep the turn count of the stronger part
    const total = [1 - mix + mix * h[0], mix * h[1]];
    const near = mix >= 0.5 ? filtered : 0;
    phase = arg(total);
    phase += 2 * Math.PI * Math.round((near - phase) / (2 * Math.PI));
  }
  return -phase / (2 * Math.PI * f / sr);
}
