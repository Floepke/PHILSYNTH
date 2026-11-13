// ADSR stage curves of the OSC envelope (Attack/Decay/Release Curve, -100..+100 %). Shared by the
// DSP kernel (osc.dsp.js, C++ twin cpp/osc.h) and the ADSR editor (adsrview.js), so the graph shows
// exactly what plays. A stage runs over its progress u = 0..1 (its time stays exact) and moves
//   f(u, k) = (1 - e^(-k u)) / (1 - e^(-k))        (k = 0: f = u, linear)
// of the way from its start to its end level. +100 % is the analog RC shape: the attack charges
// toward 1.5 (Kmax = ln 3, the classic analog attack overshoot target), decay and release fall
// exponentially to -60 dB of their distance at the stage end (Kmax = ln 1000). Negative amounts
// mirror the shape (slow start, fast end).
import { pctNum } from '../params.js';
export const ATTACK_KMAX = Math.log(3);
export const FALL_KMAX = Math.log(1000);
export const CURVE_EPS = 1e-9;

export const curveK = (amount, kmax) => (Math.max(-100, Math.min(100, Number(amount) || 0)) / 100) * kmax;

export const curveAt = (u, k) => (Math.abs(k) < CURVE_EPS ? u : (1 - Math.exp(-k * u)) / (1 - Math.exp(-k)));

// Stage levels (u = stage progress 0..1, l0 = level where the release started)
export const attackLevel = (u, amount) => curveAt(u, curveK(amount, ATTACK_KMAX));
export const decayLevel = (u, amount, sustain) => 1 + (sustain - 1) * curveAt(u, curveK(amount, FALL_KMAX));
export const releaseLevel = (u, amount, l0) => l0 * (1 - curveAt(u, curveK(amount, FALL_KMAX)));

// Inverse of curveAt: the stage progress u where the curve reaches y (0..1). The ADSR module starts
// a retriggered attack there, so it continues from the current level on the curve without a jump.
export function curveInv(y, k) {
  const c = Math.min(1, Math.max(0, y));
  if (Math.abs(k) < CURVE_EPS) return c;
  return Math.min(1, Math.max(0, -Math.log(1 - c * (1 - Math.exp(-k))) / k));
}

// The Attack/Decay/Release Curve controllers (OSC, ADSR, IMAGESAMPLER); `def` = their default (OSC: +100 analog)
export const formatCurve = (v) => (v === 0 ? 'Linear' : `${v > 0 ? '+' : ''}${pctNum(v)} %${Math.abs(v) === 100 ? (v > 0 ? ' (analog)' : ' (inverse)') : ''}`);
export const curveParams = (def = 0) => [
  { id: 'atkCurve', label: 'Attack Curve', min: -100, max: 100, default: def, step: 0.01, format: formatCurve },
  { id: 'decCurve', label: 'Decay Curve', min: -100, max: 100, default: def, step: 0.01, format: formatCurve },
  { id: 'relCurve', label: 'Release Curve', min: -100, max: 100, default: def, step: 0.01, format: formatCurve },
];
