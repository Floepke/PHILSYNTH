// PHILSYNTH library of Scala scales for the TUNING module. Every scale is generated from its
// definition (equal divisions, chains of tempered fifths, just ratios) into .scl text, so the module
// stores and shows exactly what a loaded file would hold.
//
// Twelve-note temperaments are built as a chain of fifths from E♭ to G♯ (C = 0); a fifth's
// `temper` is how much narrower than pure (3/2) it is, in cents (negative = wider). A closed
// well temperament's tempering adds up to one Pythagorean comma.

const PURE_FIFTH = 1200 * Math.log2(3 / 2);
const PC = 1200 * Math.log2(531441 / 524288); // Pythagorean comma ≈ 23.46 ct
const SC = 1200 * Math.log2(81 / 80); // syntonic comma ≈ 21.51 ct
const SCHISMA = PC - SC;

const CIRCLE = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F'];
const SEMI = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

const cents = (c) => c.toFixed(5);
const mod1200 = (c) => ((c % 1200) + 1200) % 1200;

// tempering per fifth of the circle C-G, G-D … A#-F, F-C (in that order) -> 12 cents values (C..B)
function circle(tempers) {
  const out = new Array(12).fill(0);
  let c = 0;
  for (let i = 1; i < 12; i++) {
    c = mod1200(c + PURE_FIFTH - tempers[i - 1]);
    out[SEMI[CIRCLE[i]]] = c;
  }
  return out;
}
// tempering: { 'C-G': x, ... } (unlisted fifths are pure)
const well = (map) => circle(CIRCLE.map((n, i) => map[`${n}-${CIRCLE[(i + 1) % 12]}`] ?? 0));

// regular temperament: every fifth the same; chain from E♭ (3 fifths down) to G♯ (8 up)
function regular(fifth) {
  const out = new Array(12).fill(0);
  for (let k = -3; k <= 8; k++) out[(((k * 7) % 12) + 12) % 12] = mod1200(k * fifth);
  return out;
}

const edo = (n, period = 1200) => Array.from({ length: n }, (_, i) => (period * (i + 1)) / n);

// steps: cents numbers or ratio strings, the period (last) included
function scl(file, description, steps, comment = '') {
  const body = steps.map((s) => ` ${typeof s === 'number' ? cents(s) : s}`).join('\n');
  return `! ${file}\n!${comment ? `\n! ${comment}\n!` : ''}\n${description}\n ${steps.length}\n!\n${body}\n`;
}
const twelve = (values) => [...values.slice(1), '2/1'];

const entry = (group, name, file, description, steps, comment) => ({ group, name, file, text: scl(file, description, steps, comment) });

export const LIBRARY = [
  // ---- equal temperaments ----
  entry('Equal temperament', '12-TET (standard)', '12-TET.scl', '12-tone equal temperament', [...edo(12).slice(0, -1), '2/1']),
  entry('Equal temperament', '5-TET', '5-TET.scl', '5-tone equal temperament (slendro-like)', [...edo(5).slice(0, -1), '2/1']),
  entry('Equal temperament', '7-TET', '7-TET.scl', '7-tone equal temperament (Thai-like)', [...edo(7).slice(0, -1), '2/1']),
  entry('Equal temperament', '17-TET', '17-TET.scl', '17-tone equal temperament', [...edo(17).slice(0, -1), '2/1']),
  entry('Equal temperament', '19-TET', '19-TET.scl', '19-tone equal temperament (≈ 1/3-comma meantone)', [...edo(19).slice(0, -1), '2/1']),
  entry('Equal temperament', '22-TET', '22-TET.scl', '22-tone equal temperament', [...edo(22).slice(0, -1), '2/1']),
  entry('Equal temperament', '24-TET (quarter tones)', '24-TET.scl', '24-tone equal temperament, quarter tones', [...edo(24).slice(0, -1), '2/1']),
  entry('Equal temperament', '31-TET', '31-TET.scl', '31-tone equal temperament (Huygens / Fokker, ≈ 1/4-comma meantone)', [...edo(31).slice(0, -1), '2/1']),
  entry('Equal temperament', '41-TET', '41-TET.scl', '41-tone equal temperament', [...edo(41).slice(0, -1), '2/1']),
  entry('Equal temperament', '53-TET', '53-TET.scl', '53-tone equal temperament (≈ Pythagorean and 5-limit just)', [...edo(53).slice(0, -1), '2/1']),

  // ---- non-octave ----
  entry('Non-octave', 'Bohlen–Pierce (equal)', 'bohlen-pierce-et.scl', 'Bohlen-Pierce equal temperament: 13 equal steps of the tritave 3/1',
    [...edo(13, 1200 * Math.log2(3)).slice(0, -1), '3/1'], 'repeats at the tritave (3/1, an octave + a fifth), not the octave'),
  entry('Non-octave', 'Bohlen–Pierce (just)', 'bohlen-pierce-just.scl', 'Bohlen-Pierce just intonation, 13 notes per tritave',
    ['27/25', '25/21', '9/7', '7/5', '75/49', '5/3', '9/5', '49/25', '15/7', '7/3', '63/25', '25/9', '3/1'], 'repeats at the tritave (3/1)'),
  entry('Non-octave', 'Wendy Carlos Alpha', 'carlos-alpha.scl', 'Wendy Carlos Alpha scale: equal steps of 77.965 cents', [77.965], 'no octave: every key is one step'),
  entry('Non-octave', 'Wendy Carlos Beta', 'carlos-beta.scl', 'Wendy Carlos Beta scale: equal steps of 63.833 cents', [63.833], 'no octave: every key is one step'),
  entry('Non-octave', 'Wendy Carlos Gamma', 'carlos-gamma.scl', 'Wendy Carlos Gamma scale: equal steps of 35.099 cents', [35.099], 'no octave: every key is one step'),

  // ---- historical well temperaments ----
  entry('Well temperament', 'Werckmeister III', 'werckmeister3.scl', 'Andreas Werckmeister III (1691): C-G-D-A and B-F# narrowed by 1/4 Pythagorean comma',
    twelve(well({ 'C-G': PC / 4, 'G-D': PC / 4, 'D-A': PC / 4, 'B-F#': PC / 4 }))),
  entry('Well temperament', 'Werckmeister IV', 'werckmeister4.scl', 'Andreas Werckmeister IV (1691): 1/3 Pythagorean comma, five narrow and two wide fifths',
    twelve(well({ 'C-G': PC / 3, 'D-A': PC / 3, 'E-B': PC / 3, 'F#-C#': PC / 3, 'A#-F': PC / 3, 'G#-D#': -PC / 3, 'D#-A#': -PC / 3 }))),
  entry('Well temperament', 'Kirnberger II', 'kirnberger2.scl', 'Johann Philipp Kirnberger II: D-A-E narrowed by 1/2 syntonic comma, F#-C# by a schisma',
    twelve(well({ 'D-A': SC / 2, 'A-E': SC / 2, 'F#-C#': SCHISMA }))),
  entry('Well temperament', 'Kirnberger III', 'kirnberger3.scl', 'Johann Philipp Kirnberger III: C-G-D-A-E narrowed by 1/4 syntonic comma, F#-C# by a schisma',
    twelve(well({ 'C-G': SC / 4, 'G-D': SC / 4, 'D-A': SC / 4, 'A-E': SC / 4, 'F#-C#': SCHISMA }))),
  entry('Well temperament', 'Vallotti', 'vallotti.scl', 'Francesco Antonio Vallotti: F-C-G-D-A-E-B narrowed by 1/6 Pythagorean comma',
    twelve(well({ 'F-C': PC / 6, 'C-G': PC / 6, 'G-D': PC / 6, 'D-A': PC / 6, 'A-E': PC / 6, 'E-B': PC / 6 }))),
  entry('Well temperament', 'Young II', 'young2.scl', 'Thomas Young (1799): C-G-D-A-E-B-F# narrowed by 1/6 Pythagorean comma',
    twelve(well({ 'C-G': PC / 6, 'G-D': PC / 6, 'D-A': PC / 6, 'A-E': PC / 6, 'E-B': PC / 6, 'B-F#': PC / 6 }))),
  entry('Well temperament', 'Bach / Lehman (1722)', 'bach-lehman.scl', 'Bradley Lehman\'s reading of Bach\'s 1722 title page: F-C-G-D-A-E 1/6 PC narrow, C#-G#-D#-A# 1/12 narrow, A#-F 1/12 wide',
    twelve(well({ 'F-C': PC / 6, 'C-G': PC / 6, 'G-D': PC / 6, 'D-A': PC / 6, 'A-E': PC / 6, 'C#-G#': PC / 12, 'G#-D#': PC / 12, 'D#-A#': PC / 12, 'A#-F': -PC / 12 }))),

  // ---- meantone ----
  entry('Meantone', '1/4-comma meantone', 'meanquar.scl', '1/4-comma meantone (Pietro Aron): pure major thirds, E♭ to G♯', twelve(regular(PURE_FIFTH - SC / 4))),
  entry('Meantone', '1/3-comma meantone', 'meanthird.scl', '1/3-comma meantone (Salinas): pure minor thirds, E♭ to G♯', twelve(regular(PURE_FIFTH - SC / 3))),
  entry('Meantone', '2/7-comma meantone', 'mean27.scl', '2/7-comma meantone (Zarlino), E♭ to G♯', twelve(regular(PURE_FIFTH - (2 * SC) / 7))),
  entry('Meantone', '1/5-comma meantone', 'meanfifth.scl', '1/5-comma meantone, E♭ to G♯', twelve(regular(PURE_FIFTH - SC / 5))),
  entry('Meantone', '1/6-comma meantone', 'meansixth.scl', '1/6-comma meantone (Silbermann), E♭ to G♯', twelve(regular(PURE_FIFTH - SC / 6))),
  entry('Meantone', 'Pythagorean', 'pythagorean.scl', 'Pythagorean tuning: pure 3/2 fifths, E♭ to G♯',
    ['256/243', '9/8', '32/27', '81/64', '4/3', '729/512', '3/2', '128/81', '27/16', '16/9', '243/128', '2/1']),

  // ---- just intonation ----
  entry('Just intonation', '5-limit just (12 notes)', 'ji-12.scl', '5-limit just intonation, 12 notes on C',
    ['16/15', '9/8', '6/5', '5/4', '4/3', '45/32', '3/2', '8/5', '5/3', '9/5', '15/8', '2/1']),
  entry('Just intonation', 'Just major (7 notes)', 'ji-major.scl', 'Ptolemy\'s intense diatonic: just major scale, 7 notes',
    ['9/8', '5/4', '4/3', '3/2', '5/3', '15/8', '2/1'], 'every key is the next degree: an octave spans 7 keys'),
  entry('Just intonation', 'Harmonic series 8–16', 'harmonic-8-16.scl', 'Overtone scale: harmonics 8 to 16, 8 notes',
    ['9/8', '5/4', '11/8', '3/2', '13/8', '7/4', '15/8', '2/1']),
  entry('Just intonation', 'Harry Partch 43-tone', 'partch-43.scl', 'Harry Partch\'s 43-tone 11-limit just scale',
    ['81/80', '33/32', '21/20', '16/15', '12/11', '11/10', '10/9', '9/8', '8/7', '7/6', '32/27', '6/5', '11/9', '5/4', '14/11', '9/7', '21/16',
      '4/3', '27/20', '11/8', '7/5', '10/7', '16/11', '40/27', '3/2', '32/21', '14/9', '11/7', '8/5', '18/11', '5/3', '27/16', '12/7', '7/4',
      '16/9', '9/5', '20/11', '11/6', '15/8', '40/21', '64/33', '160/81', '2/1']),
  entry('Just intonation', 'Indian 22 shruti', 'shruti-22.scl', 'Indian 22 shruti scale (5-limit just)',
    ['256/243', '16/15', '10/9', '9/8', '32/27', '6/5', '5/4', '81/64', '4/3', '27/20', '45/32', '729/512', '3/2', '128/81', '8/5', '5/3',
      '27/16', '16/9', '9/5', '15/8', '243/128', '2/1']),
];

export const libraryGroups = () => [...new Set(LIBRARY.map((s) => s.group))];
