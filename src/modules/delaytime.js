import { syncedPeriod } from './lfo.dsp.js';

export const DELAY_UNITS = ['ms', '1/4', '1/8', '1/16'];
// DELAY only: the audio delay is one period of the newest incoming note, minus what the rest of
// the sound loop adds (see notePeriodSamples), so a FEEDBACK loop through it rings at the note's pitch
export const NOTE_UNIT = 4;
export const DELAY_NOTE_UNITS = [...DELAY_UNITS, 'Note'];
export const MAX_DELAY_SECONDS = 64 * 60 / 20; // longest synced period at the Output's minimum BPM
const BEATS = [0, 1, 0.5, 0.25];

// Keep one controller range for automation: in sync mode its position selects the LFO's
// musical periods, ascending from 1/4 to 64 units instead of descending with frequency.
export function delayPeriod(value) {
  return syncedPeriod(4 / Math.pow(256, Math.max(0, Math.min(10000, value)) / 10000));
}

export const noteHz = (pitch) => 440 * Math.pow(2, ((Number.isFinite(+pitch) ? +pitch : 60) - 69) / 12);

// Delay in samples of the Note unit at float MIDI pitch `pitch` (A4 = 69 = 440 Hz). `loop`: the
// samples the rest of the sound loop delays the tone (the graph sends it, see Graph.tuneLoops:
// one sample per loop pass plus the phase delay of FILTERs in the loop); 1 outside a loop.
export function notePeriodSamples(pitch, sr, loop = 1) {
  return Math.max(0, sr / noteHz(pitch) - (Number.isFinite(+loop) ? +loop : 1));
}

// The Note unit has no time of its own: MIDI passes without delay.
export function delaySeconds(value, unit, bpm) {
  if (unit === NOTE_UNIT) return 0;
  value = Math.max(0, Math.min(10000, value));
  return unit ? delayPeriod(value) * BEATS[unit] * 60 / Math.max(20, Math.min(1000, bpm)) : value / 1000;
}

const FRACTIONS = { 0.75: '3/4', 0.667: '2/3', 0.5: '1/2', 0.333: '1/3', 0.25: '1/4' };
export function formatDelay(value, values) {
  if (!values?.unit) return `${value.toFixed(1)} ms`;
  const p = delayPeriod(value);
  return `${FRACTIONS[+p.toFixed(3)] ?? p} \u00d7 ${DELAY_UNITS[values.unit | 0]}`;
}

export const delayParam = (id, label, value = 250, extra = {}) => ({
  id, label, min: 0, max: 10000, default: value, format: formatDelay, ...extra,
});
export const delayUnitParam = (options = DELAY_UNITS) => ({
  id: 'unit', label: 'Delay Unit', min: 0, max: options.length - 1, default: 0, step: 1, options,
});
