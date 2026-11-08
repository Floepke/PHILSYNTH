import { bendPolyline, notePitchAt, isAuto, isIdea, normalizeSigs } from './song.js';
import { MAX_MIDI_BYTES } from './fileformat.js';
import { sampleAt } from './curve.js';

export const MIDI_PPQN = 960;
const MAX_TICK = 0x0fffffff;
const encoder = new TextEncoder();
const pitchAt = (note, t, poly, offset) => Math.max(0, Math.min(127, notePitchAt(note, t, poly) + offset));

// Use the same bend polyline as playback, splitting exactly at rounded-pitch transitions.
export function midiNoteSegments(note, from = 0, to = note.length, offset = 0) {
  if (to <= from) return [];
  const poly = bendPolyline(note);
  const times = [from];
  if (poly) for (let i = 0; i < poly.length; i += 2) if (poly[i] > from && poly[i] < to) times.push(poly[i]);
  times.push(to);
  const cuts = [from];
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1], b = times[i];
    const boundaries = [a];
    if (poly) {
      const rawA = note.pitch + sampleAt(poly, a), rawB = note.pitch + sampleAt(poly, b);
      if (rawA !== rawB) for (const limit of [0, 127]) {
        const t = a + (limit - rawA) / (rawB - rawA) * (b - a);
        if (t > a && t < b) boundaries.push(t);
      }
    }
    boundaries.push(b);
    boundaries.sort((a, b) => a - b);
    for (let j = 1; j < boundaries.length; j++) {
      const a = boundaries[j - 1], b = boundaries[j];
      const rawA = notePitchAt(note, a, poly) + offset, rawB = notePitchAt(note, b, poly) + offset;
      const crossings = [];
      if (rawA !== rawB) {
        for (let threshold = Math.max(0.5, Math.floor(Math.min(rawA, rawB) + 0.5) + 0.5); threshold < Math.max(rawA, rawB) && threshold < 127; threshold++) {
          const t = a + (threshold - rawA) / (rawB - rawA) * (b - a);
          if (t > a && t < b) crossings.push(t);
        }
      }
      cuts.push(...crossings.sort((a, b) => a - b), b);
    }
  }
  const out = [];
  for (let i = 1; i < cuts.length; i++) {
    const start = cuts[i - 1], end = cuts[i];
    if (end <= start) continue;
    const pitch = Math.round(pitchAt(note, (start + end) / 2, poly, offset));
    if (out.at(-1)?.pitch === pitch) out.at(-1).end = end;
    else out.push({ start, end, pitch });
  }
  return out;
}

function vlq(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TICK) throw new Error('MIDI timeline exceeds the supported tick range');
  const bytes = [value & 127];
  while ((value = Math.floor(value / 128))) bytes.unshift((value & 127) | 128);
  return bytes;
}
const u32 = value => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const tick = quarters => {
  const value = Math.round(quarters * MIDI_PPQN);
  vlq(value);
  return value;
};
const meta = (type, bytes) => [255, type, ...vlq(bytes.length), ...bytes];
const text = (type, value) => meta(type, encoder.encode(value));
const event = (at, data, order = 0) => ({ at, data, order });

function track(events, end) {
  events.push(event(end, meta(0x2f, []), 3));
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  const bytes = [];
  let previous = 0;
  for (const entry of events) {
    bytes.push(...vlq(entry.at - previous));
    for (const byte of entry.data) bytes.push(byte);
    if (bytes.length > MAX_MIDI_BYTES) throw new Error('Exported MIDI exceeds the 32 MB size limit');
    previous = entry.at;
  }
  const chunk = new Uint8Array(8 + bytes.length);
  chunk.set([77, 84, 114, 107, ...u32(bytes.length)]);
  chunk.set(bytes, 8);
  return chunk;
}

// Format 1: conductor plus one track per destination in the currently shown timeline.
export function exportMidi(song, { bpm = 120, metadata = {}, destinationName = id => id === null ? 'Unassigned' : `#${id} (missing)`, pitchOffset = 0 } = {}) {
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(pitchOffset)) throw new Error('Invalid MIDI tempo or pitch offset');
  const tempo = Math.round(60000000 / bpm);
  if (tempo < 1 || tempo > 0xffffff) throw new Error('Tempo is outside the MIDI range');
  const groups = new Map();
  let end = 0;
  for (const clip of song.clips) {
    if (isAuto(clip) || isIdea(clip) || clip.start + clip.length <= 0) continue;
    if (!groups.has(clip.target)) groups.set(clip.target, []);
    end = Math.max(end, tick(clip.start + clip.length));
    const notes = groups.get(clip.target);
    for (const note of clip.notes) {
      if (note.vel === 0) continue;
      const origin = clip.start + note.start;
      const from = Math.max(0, -note.start, -origin);
      const to = Math.min(note.length, clip.length - note.start);
      const velocity = Math.max(1, Math.min(127, Math.round((note.vel ?? 0.8) * 127)));
      for (const segment of midiNoteSegments(note, from, to, pitchOffset)) {
        const start = tick(origin + segment.start), stop = tick(origin + segment.end);
        if (stop > start) notes.push({ start, end: stop, pitch: segment.pitch, velocity });
      }
    }
  }
  const conductor = [event(0, text(3, metadata.songName || 'PHILSYNTH')),
    event(0, meta(0x51, [(tempo >>> 16) & 255, (tempo >>> 8) & 255, tempo & 255]))];
  if (metadata.creator) conductor.push(event(0, text(1, `Creator: ${metadata.creator}`)));
  if (metadata.comment) conductor.push(event(0, text(1, metadata.comment)));
  conductor.push(event(0, text(1, 'Exported by PHILSYNTH')));
  for (const sig of normalizeSigs(song.sigs)) {
    const at = tick(sig.at);
    end = Math.max(end, at);
    conductor.push(event(at, meta(0x58, [sig.num, Math.log2(sig.den), 24, 8])));
  }
  const tracks = [track(conductor, end)];
  for (const [id, notes] of [...groups].sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity))) {
    const index = tracks.length - 1;
    const channel = index % 15 >= 9 ? index % 15 + 1 : index % 15;
    const events = [event(0, text(3, destinationName(id)))];
    // Overlapping equal pitches must not send a note-off while another copy is still sounding.
    const merged = [];
    notes.sort((a, b) => a.pitch - b.pitch || a.start - b.start);
    for (const note of notes) {
      const previous = merged.at(-1);
      if (previous?.pitch === note.pitch && note.start < previous.end) previous.end = Math.max(previous.end, note.end);
      else merged.push({ ...note });
    }
    for (const note of merged) {
      events.push(event(note.start, [0x90 | channel, note.pitch, note.velocity], 2));
      events.push(event(note.end, [0x80 | channel, note.pitch, 0], 1));
    }
    tracks.push(track(events, end));
  }
  if (tracks.length > 65535) throw new Error('Too many MIDI destinations');
  const size = 14 + tracks.reduce((sum, bytes) => sum + bytes.length, 0);
  if (size > MAX_MIDI_BYTES) throw new Error('Exported MIDI exceeds the 32 MB size limit');
  const bytes = new Uint8Array(size);
  bytes.set([77, 84, 104, 100, 0, 0, 0, 6, 0, 1, tracks.length >>> 8, tracks.length & 255, MIDI_PPQN >>> 8, MIDI_PPQN & 255]);
  let position = 14;
  for (const data of tracks) { bytes.set(data, position); position += data.length; }
  return { bytes, tracks: groups.size };
}
