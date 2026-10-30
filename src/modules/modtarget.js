// Shared by modulator modules (LFO, ADSR, VELOCITY2CTL): their control cables drive controller number
// `outController` of every module they connect to, inside Out Min..Out Max (% of its range).
// The patch (src/patch.js modulate()) maps the modulator's 0..1 value onto that range.
export const pct = (v) => `${Math.round(v)} %`;

export const outParams = () => [
  { id: 'outController', label: 'Out Controller', min: 0, max: 31, default: 0, step: 1 },
  { id: 'outMin', label: 'Out Min', min: 0, max: 100, default: 0, step: 1, format: pct },
  { id: 'outMax', label: 'Out Max', min: 0, max: 100, default: 100, step: 1, format: pct },
];

// The Out Controller slider's range and names follow the connected module(s).
export function modulatorParams(inst, def) {
  const targets = inst.getTargets();
  const lists = targets.map((t) => t.inst.params?.() ?? t.def.params);
  const max = Math.max(0, ...lists.map((l) => l.length - 1));
  const format = (v) => {
    const names = [...new Set(lists.map((l) => l[v | 0]?.label ?? '—'))];
    return names.length ? `${v | 0} · ${names.join(' / ')}` : `${v | 0} · (not connected)`;
  };
  return def.params.map((p) => (p.id === 'outController' ? { ...p, max: targets.length ? Math.max(1, max) : p.max, format } : p));
}
