// Linked controllers of envelopes (OSC, ADSR): with Sustain at 0 the envelope is a pure
// decay, so Decay and Release move together (setting one sets the other, clamped to its range),
// and so do their curves (OSC Decay Curve <-> Release Curve).
// Used as a module's `linked(values, id, value, params)` hook, see PatchRuntime.setParam.
export function linkDecayRelease(values, id, value, params) {
  const other = { decay: 'release', release: 'decay', decCurve: 'relCurve', relCurve: 'decCurve' }[id];
  if (values.sustain !== 0 || !other) return null;
  const p = params.find((q) => q.id === other);
  if (!p) return null;
  return { [other]: Math.min(p.max, Math.max(p.min, value)) };
}
