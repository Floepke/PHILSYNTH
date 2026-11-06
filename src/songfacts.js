import { centsLabel, centsOf, isAuto, loopEnd, meter, noteName } from './song.js';
import { pitchHz } from './modules/lfo.dsp.js';

export function songFacts(layers) {
  let notes = 0;
  let measures = 0;
  let frequency = 0;
  const pitches = new Map();
  for (const { song } of layers) {
    const end = loopEnd(song);
    for (const segment of meter(song)) {
      const length = Math.min(end, segment.end) - segment.at;
      if (length > 0) measures += Math.ceil(length / segment.len - 1e-9);
    }
    for (const clip of song.clips) {
      if (isAuto(clip)) continue;
      for (const note of clip.notes) {
        notes++;
        frequency += pitchHz(note.pitch);
        pitches.set(note.pitch, (pitches.get(note.pitch) ?? 0) + 1);
      }
    }
  }
  const main = layers[0];
  const seconds = main ? loopEnd(main.song) * 60 / main.rt.bpm : 0;
  const rounded = Math.round(seconds);
  const duration = [Math.floor(rounded / 3600), Math.floor(rounded / 60) % 60, rounded % 60]
    .map((value) => String(value).padStart(2, '0')).join(':');
  const topPitches = [...pitches].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5)
    .map(([pitch, count]) => ({
      pitch, count,
      label: `${noteName(pitch)}${centsOf(pitch) ? ` (${centsLabel(centsOf(pitch))})` : ''}`,
    }));
  return { duration, notes, measures, averageFrequency: notes ? frequency / notes : null, topPitches };
}
