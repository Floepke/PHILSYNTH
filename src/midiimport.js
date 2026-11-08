import { BAR, LANE_H } from './song.js';
import { MAX_MIDI_BYTES } from './fileformat.js';
import { toNorm } from './params.js';

export function midiTempoClip(result, target, controller, param) {
  const points = [];
  for (const event of result.tempoEvents) {
    const v = toNorm(param, event.bpm);
    if (points.length && points.at(-1).v !== v) points.push({ t: event.t, v: points.at(-1).v, r: 0 });
    if (!points.length || points.at(-1).v !== v) points.push({ t: event.t, v, r: 0 });
  }
  const end = result.clips.reduce((max, clip) => Math.max(max, clip.length), 0);
  return {
    name: 'MIDI Tempo', kind: 'auto', target, controller, notes: [], points,
    length: Math.max(end, points.at(-1).t + 0.001),
  };
}

// Standard MIDI Files use tick deltas and running status; all positions below remain in ticks
// until the entire tempo map is known (needed for SMPTE time divisions).
export function parseMidiFile(data, filename = 'MIDI', { importTempo = false, minBpm = 20, maxBpm = 1000 } = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > MAX_MIDI_BYTES) throw new Error('MIDI file is too large (maximum 32 MB)');
  let pos = 0;
  const fail = (message) => { throw new Error(`Invalid MIDI file: ${message}`); };
  const need = (n, end = bytes.length) => { if (n < 0 || pos + n > end) fail('unexpected end of file'); };
  const byte = (end) => { need(1, end); return bytes[pos++]; };
  const u16 = () => (byte() * 256 + byte());
  const u32 = () => (byte() * 0x1000000 + byte() * 0x10000 + byte() * 256 + byte());
  const tag = () => String.fromCharCode(byte(), byte(), byte(), byte());
  const vlq = (end) => {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = byte(end);
      value = value * 128 + (b & 127);
      if (!(b & 128)) return value;
    }
    return fail('variable-length number exceeds four bytes');
  };
  if (tag() !== 'MThd') fail('missing header');
  const headerLength = u32();
  if (headerLength < 6) fail('short header');
  need(headerLength);
  const headerEnd = pos + headerLength;
  const format = u16();
  const count = u16();
  const division = u16();
  pos = headerEnd;
  if (format > 2 || !count || (format === 0 && count !== 1)) fail('unsupported format or track count');
  let ticksPerSecond = null;
  if (division & 0x8000) {
    const fpsCode = 256 - (division >> 8);
    const fps = fpsCode === 29 ? 30000 / 1001 : fpsCode;
    if (![24, 25, 29, 30].includes(fpsCode) || !(division & 255)) fail('invalid SMPTE division');
    ticksPerSecond = fps * (division & 255);
  } else if (!division) fail('invalid ticks per quarter note');

  const tracks = [];
  let warnings = 0;
  for (let index = 0; index < count; index++) {
    if (tag() !== 'MTrk') fail(`missing track ${index + 1}`);
    const length = u32();
    need(length);
    const end = pos + length;
    let tick = 0;
    let running = 0;
    let name = '';
    let ended = false;
    const active = new Map();
    const notes = [];
    const tempos = [];
    const close = (key, at) => {
      const queue = active.get(key);
      if (!queue) { warnings++; return; }
      const note = queue.items[queue.head++];
      if (queue.head === queue.items.length) active.delete(key);
      if (at <= note.start) warnings++;
      note.end = Math.max(at, note.start + 1);
      notes.push(note);
    };
    while (pos < end) {
      tick += vlq(end);
      if (!Number.isSafeInteger(tick)) fail('track duration is too long');
      let status = byte(end);
      let first = null;
      if (status < 0x80) {
        if (!running) fail('running status without a channel event');
        first = status;
        status = running;
      } else if (status < 0xf0) running = status;
      else running = 0;
      if (status === 0xff) {
        const type = byte(end);
        if (type > 127) fail('invalid meta event');
        const size = vlq(end);
        need(size, end);
        if (type === 0x03 && !name) name = new TextDecoder().decode(bytes.subarray(pos, pos + size)).replace(/\0/g, '').trim();
        if (type === 0x51) {
          if (size !== 3) fail('invalid tempo event');
          const tempo = bytes[pos] * 65536 + bytes[pos + 1] * 256 + bytes[pos + 2];
          if (!tempo) fail('invalid tempo');
          tempos.push({ tick, tempo });
        }
        pos += size;
        if (type === 0x2f) {
          if (size !== 0 || pos !== end) fail('invalid end-of-track event');
          ended = true;
          break;
        }
      } else if (status === 0xf0 || status === 0xf7) {
        const size = vlq(end);
        need(size, end);
        pos += size;
      } else if (status >= 0x80 && status < 0xf0) {
        const kind = status >> 4;
        const a = first ?? byte(end);
        const b = kind === 0xc || kind === 0xd ? null : byte(end);
        if (a > 127 || (b !== null && b > 127)) fail('invalid channel event');
        const key = `${status & 15}:${a}`;
        if (kind === 9 && b > 0) {
          const queue = active.get(key) ?? { items: [], head: 0 };
          queue.items.push({ pitch: a, start: tick, vel: b / 127 });
          active.set(key, queue);
        } else if (kind === 8 || (kind === 9 && b === 0)) close(key, tick);
      } else fail('unsupported system event');
    }
    if (!ended) fail(`track ${index + 1} has no end-of-track event`);
    for (const queue of active.values()) for (const note of queue.items.slice(queue.head)) {
      note.end = Math.max(tick, note.start + 1);
      notes.push(note);
      warnings++;
    }
    tracks.push({ name, notes, tick, tempos });
  }
  if (pos !== bytes.length) fail('unexpected data after tracks');

  const timeMap = (tempos) => {
    if (!ticksPerSecond) return (tick) => tick / division;
    const points = [{ tick: 0, beat: 0, tempo: 500000 }];
    for (const event of [...tempos].sort((a, b) => a.tick - b.tick)) {
      const previous = points.at(-1);
      const beat = previous.beat + (event.tick - previous.tick) * 1000000 / (ticksPerSecond * previous.tempo);
      points.push({ ...event, beat });
    }
    return (tick) => {
      let lo = 0, hi = points.length;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid].tick <= tick) lo = mid; else hi = mid;
      }
      const point = points[lo];
      return point.beat + (tick - point.tick) * 1000000 / (ticksPerSecond * point.tempo);
    };
  };
  const sharedMap = timeMap(tracks.flatMap((track) => track.tempos));
  let tempoEvents = null;
  let clampedTempos = 0;
  let convertedTimes = null;
  if (importTempo) {
    if (!Number.isInteger(minBpm) || !Number.isInteger(maxBpm) || minBpm <= 0 || maxBpm < minBpm) {
      throw new Error('Invalid BPM controller range');
    }
    // SMF format 2 tracks are independent sequences. Their source clocks are mapped through
    // elapsed seconds onto a single output clock, whose tempo is taken from the first track.
    const sharedTempos = tracks.flatMap((track) => track.tempos);
    const sourceClock = (tempos) => {
      if (ticksPerSecond) return (tick) => tick / ticksPerSecond;
      const points = [{ tick: 0, seconds: 0, tempo: 500000 }];
      for (const event of [...tempos].sort((a, b) => a.tick - b.tick)) {
        const prev = points.at(-1);
        points.push({ ...event, seconds: prev.seconds + (event.tick - prev.tick) * prev.tempo / (division * 1000000) });
      }
      return (tick) => {
        let lo = 0, hi = points.length;
        while (lo + 1 < hi) {
          const mid = (lo + hi) >> 1;
          if (points[mid].tick <= tick) lo = mid; else hi = mid;
        }
        const point = points[lo];
        return point.seconds + (tick - point.tick) * point.tempo / (division * 1000000);
      };
    };
    const mainTempos = format === 2 ? tracks[0].tempos : sharedTempos;
    const mainClock = sourceClock(mainTempos);
    const events = [{ seconds: 0, tempo: 500000 }];
    for (const event of [...mainTempos].sort((a, b) => a.tick - b.tick)) {
      const item = { seconds: mainClock(event.tick), tempo: event.tempo };
      if (events.at(-1).seconds === item.seconds) events[events.length - 1] = item;
      else events.push(item);
    }
    const outputClock = [];
    for (const event of events) {
      const rawBpm = 60000000 / event.tempo;
      const rounded = Math.round(rawBpm);
      const bpm = Math.max(minBpm, Math.min(maxBpm, rounded));
      if (rounded !== bpm) clampedTempos++;
      const prev = outputClock.at(-1);
      const beat = prev ? prev.beat + (event.seconds - prev.seconds) * prev.bpm / 60 : 0;
      outputClock.push({ seconds: event.seconds, beat, bpm });
    }
    const outputBeat = (seconds) => {
      let lo = 0, hi = outputClock.length;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (outputClock[mid].seconds <= seconds) lo = mid; else hi = mid;
      }
      const point = outputClock[lo];
      return point.beat + (seconds - point.seconds) * point.bpm / 60;
    };
    tempoEvents = outputClock.map(({ beat, bpm }) => ({ t: beat, bpm }));
    convertedTimes = tracks.map((track) => {
      const clock = format === 2 ? sourceClock(track.tempos) : mainClock;
      return (tick) => outputBeat(clock(tick));
    });
  }
  const basename = filename.replace(/\.(mid|midi)$/i, '') || 'MIDI';
  const clips = tracks.map((track, i) => {
    const toBeat = convertedTimes?.[i] ?? (format === 2 ? timeMap(track.tempos) : sharedMap);
    const notes = track.notes.map((note) => ({
      pitch: note.pitch, start: toBeat(note.start), length: toBeat(note.end) - toBeat(note.start), vel: note.vel,
    })).sort((a, b) => a.start - b.start);
    const end = notes.reduce((max, note) => Math.max(max, note.start + note.length), toBeat(track.tick));
    return { name: track.name || `${basename} - Track ${i + 1}`, start: 0, y: i * LANE_H,
      length: Math.max(0.001, end || BAR), target: null, notes };
  });
  return { format, clips, warnings, tempoEvents, clampedTempos };
}
