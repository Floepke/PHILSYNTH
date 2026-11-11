import { barCeil, clean, isAuto, isIdea, meter, segAt } from '../song.js';

const EPS = 1e-7;

// Capture unquantized input against the audio transport's unwrapped clock. Held notes that
// cross a loop boundary are split, so each pass can play back without extending the clip.
export class MidiRecorder {
  constructor({ transport, song, clip, onNotes, onCommit, onState, onError }) {
    Object.assign(this, { transport, song, clip, onNotes, onCommit, onState, onError });
    this.armed = false;
    this.take = null;
    this.held = new Map();
  }

  arm() {
    if (this.armed) { this.finish(); return; }
    if (!this.validClip()) return;
    this.armed = true;
    this.onState();
  }

  validClip() {
    const clip = this.clip();
    if (clip && !isAuto(clip) && clip.length > 0) return clip;
    this.onError('Select a MIDI clip to record into. Double-click empty TimeLine space to create one.');
    return null;
  }

  start({ loop = false, fromStart = false } = {}) {
    const clip = this.validClip();
    if (!clip) return false;
    if (!loop && isIdea(clip)) {
      this.onError('Use / to record a clip stored above the TimeLine.');
      return false;
    }
    const owner = this.song();
    const from = loop ? clip.start : fromStart ? 0 : this.transport.pos;
    if (from < clip.start || from >= clip.start + clip.length) {
      this.onError('Start recording inside the selected clip, or use / to record from its beginning.');
      return false;
    }
    this.finish({ disarm: false });
    const sig = segAt(meter(owner), from);
    const options = { countIn: { beats: sig.num, beat: sig.beat }, continuous: !loop };
    const ok = loop
      ? this.transport.playClip(clip.id, owner, options)
      : this.transport.play({ ...options, fromStart });
    if (!ok) {
      this.onError('This clip cannot play here. Use / to record a clip stored above the TimeLine or before time zero.');
      return false;
    }
    this.take = { owner, clip, loop, from, originalLength: clip.length, generation: this.transport.generation, changed: false, lastElapsed: 0 };
    this.onState();
    return true;
  }

  position(time) {
    const take = this.take;
    if (!take) return null;
    if (this.transport.generation !== take.generation) return take.lastElapsed;
    const elapsed = this.transport.recordingTime(time);
    if (elapsed === null) return null;
    const position = Math.max(0, elapsed);
    take.lastElapsed = Math.max(take.lastElapsed, position);
    return position;
  }

  append(note, start, length) {
    if (length <= EPS) return;
    const take = this.take;
    take.clip.notes.push({ pitch: note.pitch, start: clean(start), length: clean(length), vel: note.velocity });
    take.changed = true;
  }

  flush(note, elapsed, released) {
    const take = this.take;
    if (!take.loop) {
      if (released) {
        this.append(note, take.from - take.clip.start + note.at, elapsed - note.at);
        note.at = elapsed;
      }
      return;
    }
    const length = take.clip.length;
    while (note.at < elapsed - EPS) {
      const offset = clean(take.from - take.clip.start + note.at);
      let start = take.loop ? clean(((offset % length) + length) % length) : offset;
      if (take.loop && start >= length - EPS) start = 0;
      const duration = Math.min(elapsed - note.at, length - start);
      if (!released && start + duration < length - EPS) break;
      this.append(note, start, duration);
      note.at += duration;
    }
  }

  input(event) {
    this.update(event.time);
    const take = this.take;
    if (!take) return;
    const elapsed = this.position(event.time);
    if (elapsed === null) return;
    const before = take.clip.notes.length;
    if (event.type === 'off' || event.type === 'on') {
      const previous = this.held.get(event.key);
      if (previous) { this.flush(previous, elapsed, true); this.held.delete(event.key); }
    } else if (event.type === 'allOff') {
      for (const [key, note] of this.held) {
        if (event.prefix && !key.startsWith(event.prefix)) continue;
        this.flush(note, elapsed, true);
        this.held.delete(key);
      }
    }
    // position() clamps the count-in to zero: early notes held into the take start on its boundary.
    if (event.type === 'on' && this.transport.playing) {
      this.held.set(event.key, { pitch: event.pitch, velocity: event.velocity, at: elapsed });
    }
    if (take.clip.notes.length !== before) this.onNotes();
  }

  update(time) {
    const take = this.take;
    if (!take) return;
    if (!this.transport.playing || this.transport.generation !== take.generation
      || this.song() !== take.owner || this.clip() !== take.clip || !take.owner.clips.includes(take.clip)) {
      this.finish();
      return;
    }
    const elapsed = this.position(time);
    if (elapsed === null) return;
    const before = take.clip.notes.length;
    const previousLength = take.clip.length;
    if (!take.loop && take.from - take.clip.start + elapsed > take.clip.length) {
      take.clip.length = clean(barCeil(take.owner, take.from + elapsed) - take.clip.start);
    }
    for (const note of this.held.values()) this.flush(note, elapsed, false);
    if (take.clip.notes.length !== before || take.clip.length !== previousLength) this.onNotes();
  }

  finish({ disarm = true } = {}) {
    const take = this.take;
    if (take) {
      const elapsed = this.position();
      if (elapsed !== null) for (const note of this.held.values()) this.flush(note, elapsed, true);
      if (!take.loop) {
        const end = take.clip.notes.reduce((end, note) => Math.max(end, note.start + note.length), 0);
        take.clip.length = take.changed
          ? clean(barCeil(take.owner, take.clip.start + end) - take.clip.start)
          : take.originalLength;
        this.transport.setContinuous(false);
      }
    }
    this.held.clear();
    this.take = null;
    if (disarm) this.armed = false;
    if (take && !take.loop) this.onNotes();
    if (take?.changed) this.onCommit();
    this.onState();
  }
}
