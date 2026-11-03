// Scala scale files (.scl, https://www.huygens-fokker.org/scala/scl_format.html):
//   ! comment lines start with an exclamation mark (anywhere in the file)
//   first other line: a description (may be empty)
//   next: the number of notes N
//   then N pitches, one per line, the last one is the period (usually 2/1, the octave):
//     a value with a period is in cents (e.g. 701.955), otherwise a ratio (3/2) or a whole number (2 = 2/1);
//     anything after the value on the line is ignored.
// The 1/1 (0 cents) is implied as degree 0.
//
// Keyboard mapping (Scala's default without a .kbm file): MIDI key 60 (C4) plays degree 0 at the
// pitch of the equal-tempered C4, every key up / down is one scale degree further, and every N
// keys the period repeats. A 12-tone equal temperament file changes nothing.

export const ROOT_KEY = 60;
export const MAX_NOTES = 1024;
const OUT_MIN = 0;
const OUT_MAX = 135; // ≈ 19.9 kHz

export const TWELVE_TET = `! 12-TET.scl
!
12-tone equal temperament
 12
!
 100.0
 200.0
 300.0
 400.0
 500.0
 600.0
 700.0
 800.0
 900.0
 1000.0
 1100.0
 2/1
`;

const fail = (line, message) => ({ ok: false, error: line ? `Line ${line}: ${message}` : message });

// One pitch line -> cents, or an error string.
export function parsePitch(text) {
  const token = text.trim().split(/\s+/)[0] ?? '';
  if (!token) return 'empty pitch';
  if (token.includes('.')) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) return `"${token}" is not a cents value`;
    return Number(token);
  }
  const m = /^(\d+)(?:\/(\d+))?$/.exec(token);
  if (!m) return `"${token}" is not a ratio or cents value`;
  const num = Number(m[1]);
  const den = m[2] === undefined ? 1 : Number(m[2]);
  if (!(num > 0) || !(den > 0)) return `"${token}" must be a positive ratio`;
  return 1200 * Math.log2(num / den);
}

// text -> { ok: true, description, cents: [0, degree 1 .. N-1], period } or { ok: false, error }
export function parseScala(text) {
  if (typeof text !== 'string' || !text.trim()) return fail(0, 'no scale: paste a Scala (.scl) file or load one');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
    .map((t, i) => ({ t, n: i + 1 })).filter(({ t }) => !t.trimStart().startsWith('!'));
  if (!lines.length) return fail(0, 'only comments, no scale');
  let at = 0;
  let description = lines[at++].t.trim();
  const countOf = (l) => (l && /^\s*\d+(\s|$)/.test(l.t) ? parseInt(l.t, 10) : null);
  let count = countOf(lines[at]);
  // pasted without the description line: the first line is already the number of notes
  if (count === null && countOf(lines[0]) !== null) { at = 0; description = ''; count = countOf(lines[0]); }
  if (count === null) return fail(lines[at]?.n ?? lines[lines.length - 1].n + 1, 'expected the number of notes');
  const countLine = lines[at++].n;
  if (count < 1) return fail(countLine, 'the scale needs at least one note');
  if (count > MAX_NOTES) return fail(countLine, `at most ${MAX_NOTES} notes`);
  const values = [];
  for (; values.length < count && at < lines.length; at++) {
    const { t, n } = lines[at];
    if (!t.trim()) continue; // tolerate blank lines between pitches
    const c = parsePitch(t);
    if (typeof c === 'string') return fail(n, c);
    values.push(c);
  }
  if (values.length < count) return fail(0, `expected ${count} pitches, found ${values.length}`);
  const period = values[count - 1];
  if (!(period > 0)) return fail(0, 'the last pitch (the period) must be above 1/1');
  return { ok: true, description, count, cents: [0, ...values.slice(0, -1)], period };
}

// Tuned float pitch of a MIDI key (whole number) in a parsed scale.
export function tuneKey(scale, key) {
  const k = key - ROOT_KEY;
  const octave = Math.floor(k / scale.count);
  const degree = k - octave * scale.count;
  return ROOT_KEY + (octave * scale.period + scale.cents[degree]) / 100;
}

// Float pitch (micropitch kept: the part away from the nearest key is added on top) -> tuned pitch.
export function tunePitch(scale, pitch) {
  if (!scale?.ok || !Number.isFinite(pitch)) return pitch;
  const key = Math.floor(pitch + 0.5);
  return Math.min(OUT_MAX, Math.max(OUT_MIN, tuneKey(scale, key) + (pitch - key)));
}
