// OSC waveform maths, shared by the DSP kernel (osc.dsp.js) and the panel display (oscview.js).
export const WAVES = {
  SINE: 0, TRIANGLE: 1, SAW: 2, SQUARE: 3, HALF_SINE: 4, // TRIANGLE = Tri/Saw morph
  WHITE: 5, PINK: 6, BROWN: 7, BLUE: 8, VIOLET: 9, // noise colours (unpitched, see noiseSample)
};
export const WAVE_NAMES = ['Sine', 'Tri/Saw', 'Saw', 'Square', 'Half sine', 'White noise', 'Pink noise', 'Brown noise', 'Blue noise', 'Violet noise'];
export const isNoise = (wave) => wave >= WAVES.WHITE;

// xorshift32 step: same integer maths as Rng in cpp/kernel.h, so JS and C++ give identical noise.
export function xorshift(s) {
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  return s >>> 0;
}

// Noise filter state (per voice): pink filter b0..b6, brown integrator, previous white / pink.
export const noiseState = () => ({ b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0, br: 0, pw: 0, pp: 0 });

// One sample of coloured noise from white sample w (-1..1), roughly the loudness of white noise:
//   White  flat spectrum
//   Pink   -3 dB/octave (Paul Kellet's refined filter)
//   Brown  -6 dB/octave (leaky integrator)
//   Blue   +3 dB/octave (difference of pink)
//   Violet +6 dB/octave (difference of white)
// Mirrored operation by operation in cpp/osc.h.
export function noiseSample(wave, w, z) {
  if (wave === WAVES.WHITE) return w;
  if (wave === WAVES.VIOLET) { const y = (w - z.pw) * 0.7; z.pw = w; return y; }
  if (wave === WAVES.BROWN) { z.br = (z.br + 0.02 * w) / 1.02; return z.br * 6; }
  z.b0 = 0.99886 * z.b0 + w * 0.0555179;
  z.b1 = 0.99332 * z.b1 + w * 0.0750759;
  z.b2 = 0.969 * z.b2 + w * 0.153852;
  z.b3 = 0.8665 * z.b3 + w * 0.3104856;
  z.b4 = 0.55 * z.b4 + w * 0.5329522;
  z.b5 = -0.7616 * z.b5 - w * 0.016898;
  const pink = z.b0 + z.b1 + z.b2 + z.b3 + z.b4 + z.b5 + z.b6 + w * 0.5362;
  z.b6 = w * 0.115926;
  if (wave === WAVES.PINK) return pink * 0.2;
  const y = (pink - z.pp) * 0.5;
  z.pp = pink;
  return y;
}

export function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// One sample of `wave` at phase t (0..1) with duty cycle d (0..1, 0.5 = classic shape).
// inc = phase increment per sample (for band-limiting). Bipolar waves have their DC removed.
//   Sine:    first half-wave squeezed into d, second half stretched over 1-d (both stay sine-shaped)
//   Tri/Saw: rises during d, falls during 1-d: 0.5 triangle, 1 rising saw, 0 falling saw
//   Saw:     ramp bent at d (lower half of the ramp takes d, upper half 1-d); the bend is rounded:
//            the slope glides along a raised cosine, so the curve joins both ramps smoothly (sawBend)
//   Square:  pulse width d
//   Half sine: positive half-wave during d, then exactly zero (deliberately unipolar)
export function shape(wave, t, d, inc) {
  if (wave === WAVES.HALF_SINE) return d > 0 && t < d ? Math.sin((Math.PI * t) / d) : 0;
  const e = Math.min(0.49, 2 * inc); // keep the shortest segment ≥ ~2 samples
  if (wave === WAVES.SQUARE) {
    d = Math.min(1 - e, Math.max(e, d));
    const s = t < d ? 1 : -1;
    return s + polyBlep(t, inc) - polyBlep((t - d + 1) % 1, inc) - (2 * d - 1);
  }
  if (wave === WAVES.TRIANGLE) {
    d = Math.min(1 - e, Math.max(e, d));
    return t < d ? -1 + (2 * t) / d : 1 - (2 * (t - d)) / (1 - d);
  }
  d = Math.min(0.99, Math.max(0.01, d));
  if (wave === WAVES.SINE) {
    const ph = t < d ? (0.5 * t) / d : 0.5 + (0.5 * (t - d)) / (1 - d);
    return Math.sin(2 * Math.PI * ph) - (2 / Math.PI) * (2 * d - 1);
  }
  return sawBend(t, d) - polyBlep(t, inc);
}

const SAW_ROUND_DC = 0.5 - 4 / (Math.PI * Math.PI);

// Saw rising from -1 to 1 with slope 1/d before the bend and 1/(1-d) after it (d in 0.01..0.99,
// DC removed). Around the bend (window of ±r, r = the shorter ramp) the slope moves from s1 to s2
// along a raised cosine; integrated that gives a sine-shaped curve that is tangent to both ramps.
export function sawBend(t, d) {
  const s1 = 1 / d;
  const s2 = 1 / (1 - d);
  const r = Math.min(d, 1 - d);
  const dc = 0.5 * (1 - 2 * d) + (s2 - s1) * r * r * SAW_ROUND_DC; // mean of the rounded ramp
  let y;
  if (t <= d - r) y = -1 + t * s1;
  else if (t >= d + r) y = (t - d) * s2;
  else {
    const w = 2 * r;
    const u = t - (d - r);
    y = -1 + (d - r) * s1 + s1 * u + (s2 - s1) * (u / 2 - (w / (2 * Math.PI)) * Math.sin((Math.PI * u) / w));
  }
  return y - dc;
}
