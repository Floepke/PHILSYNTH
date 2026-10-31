import { syncedPeriod } from './lfo.dsp.js';

export const DELAY_UNITS = ['ms', '1/4', '1/8', '1/16'];
export const MAX_DELAY_SECONDS = 64 * 60 / 20; // longest synced period at the Output's minimum BPM
const BEATS = [0, 1, 0.5, 0.25];

// Keep one controller range for automation: in sync mode its position selects the LFO's
// musical periods, ascending from 1/4 to 64 units instead of descending with frequency.
export function delayPeriod(value) {
  return syncedPeriod(4 / Math.pow(256, Math.max(0, Math.min(10000, value)) / 10000));
}

export function delaySeconds(value, unit, bpm) {
  value = Math.max(0, Math.min(10000, value));
  return unit ? delayPeriod(value) * BEATS[unit] * 60 / Math.max(20, Math.min(1000, bpm)) : value / 1000;
}

const FRACTIONS = { 0.75: '3/4', 0.667: '2/3', 0.5: '1/2', 0.333: '1/3', 0.25: '1/4' };
export function formatDelay(value, values) {
  if (!values?.unit) return `${value.toFixed(1)} ms`;
  const p = delayPeriod(value);
  return `${FRACTIONS[+p.toFixed(3)] ?? p} \u00d7 ${DELAY_UNITS[values.unit | 0]}`;
}

export const delayParam = (id, label, value = 250) => ({
  id, label, min: 0, max: 10000, default: value, format: formatDelay,
});
export const delayUnitParam = () => ({
  id: 'unit', label: 'Delay Unit', min: 0, max: 3, default: 0, step: 1, options: DELAY_UNITS,
});
