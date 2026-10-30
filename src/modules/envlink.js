// Linked controllers of envelopes (OSC, ADSR): with Sustain at 0 the envelope is a pure
// decay, so Decay and Release move together (setting one sets the other, clamped to its range).
// Used as a module's `linked(values, id, value, params)` hook, see PatchRuntime.setParam.
export function linkDecayRelease(values, id, value, params) {
  if (values.sustain !== 0 || (id !== 'decay' && id !== 'release')) return null;
  const other = id === 'decay' ? 'release' : 'decay';
  const p = params.find((q) => q.id === other);
  return { [other]: Math.min(p.max, Math.max(p.min, value)) };
}
