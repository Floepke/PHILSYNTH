// Shared by modulator modules (LFO, ADSR, ENVELOPE, VELOCITY2CTL, PITCH2CTL, SOUND2CTL): their control cables drive controller number
// `outController` of every module they connect to, inside Out Min..Out Max (% of its range).
// The engine graph maps the value, then smooths each route in normalized controller space.
import { controllerAt, controllerNumber, paramsOf, pctNum } from '../params.js';

export const pct = (v) => `${pctNum(v)} %`;

export const outParams = () => [
  { id: 'outController', label: 'Out Controller', min: 0, max: 127, default: 0, step: 1 },
  { id: 'outMin', label: 'Out Min', min: 0, max: 100, default: 0, step: 0.01, format: pct },
  { id: 'outMax', label: 'Out Max', min: 0, max: 100, default: 100, step: 0.01, format: pct },
  { id: 'outSmooth', label: 'Out Smooth', min: 0, max: 5000, default: 0, step: 1,
    format: (v) => v < 0.5 ? 'Off (jump)' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s` },
];

// The Out Controller slider's range and names follow the connected module(s).
// Target lists need only controller numbers and labels, not another target lookup.
let listingTargets = false;
export function modulatorParams(inst, def) {
  if (listingTargets) return def.params;
  const targets = inst.getTargets();
  let lists;
  listingTargets = true;
  try {
    lists = targets.map(paramsOf);
  } finally {
    listingTargets = false;
  }
  const max = Math.max(0, ...lists.flatMap((l) => l.map(controllerNumber)));
  const format = (v) => {
    const names = [...new Set(lists.map((l) => controllerAt(l, v | 0)?.label ?? '—'))];
    return names.length ? `${v | 0} · ${names.join(' / ')}` : `${v | 0} · (not connected)`;
  };
  return def.params.map((p) => (p.id === 'outController' ? { ...p, max: targets.length ? Math.max(1, max) : p.max, format } : p));
}
