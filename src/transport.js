// Plays the song: the position runs in quarter notes at the main patch's BPM; clip notes are sent
// as MODMIDI (see modmidi.js) to the module number each clip targets. Loops at loopEnd(song),
// or at the exact bounds of a single clip when clipId is set (the / audition: every other clip
// sounding in that time range plays along). Song playback continues at the restart point
// (song.restart, see song.js) instead of zero when it reaches the end.
// Note chasing: when playback starts or jumps (play, clip play, seek) into the middle of a note,
// that note is triggered right away and plays for the rest of its length.
// Velocity curves (note.vels, see song.js): every tick each sounding note's velocity is
// re-evaluated and changes are sent as noteMod, so edits while playing are heard right away too.
// Pitch bends (note.bends) the same way: the bent pitch is sent as noteMod each tick it changes
// (a chased note starts at its bent pitch).
// Automation clips: while playing, setAuto(clipId, clip, value 0..1) is called every tick for each
// automation clip under the playhead; setAuto(clipId, null, null) releases a clip when the
// playhead leaves it or playback stops (the controller keeps its last value). Notes starting in a
// tick are triggered in time order, each onset right after the automation at that time: a note
// never starts on the controller value from before its automation clip.
// Clips on muted lanes (song.mutes) are silent, the auditioned clip too; while lanes are soloed
// (song.solos) only those play. Muting / soloing while playing cuts silenced notes right away.
// Idea clips (above the first lane, see song.js) never play, except an idea auditioned with /:
// that one plays solo, every other clip (lanes, other layers, automation) stays silent.
// Layers: every Patch has its own song (see PatchRuntime.song). Playback runs from one level (the
// scope: getScope(), taken when playback starts, so navigating while playing changes nothing):
// getSong(scope) / getBpm(scope) are that level's song and Output BPM, getLayers(scope) returns the
// songs to play as { key, song, getTarget, setAuto } (the app passes only the level's own one:
// a Patch's TimeLine is heard only from inside it). They play together on its clock; the loop
// region of the first applies, without one playback loops at the end of the last clip of any.
// The / audition loops a clip (playClip(id, song)); at each boundary it follows that song's selection.
// pitchOffset(scope): semitones added to every played note (that level's Output Global Transpose /
// Cents Offset).
import { newNoteId } from './modmidi.js';
import { automationAt, barCeil, clipSilent, getClip, isIdea, loopEnd, notesSounding, notesStarting, notePitchAt, noteVelAt, songEnd } from './song.js';

const TICK_MS = 5;

// Timer in a worker: unlike setInterval on the page it keeps running at full speed when the
// window is in the background.
function createTicker(fn) {
  try {
    const src = 'let t=null;onmessage=(e)=>{clearInterval(t);t=e.data>0?setInterval(()=>postMessage(0),e.data):null}';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = fn;
    return { start: () => w.postMessage(TICK_MS), stop: () => w.postMessage(0) };
  } catch {
    let t = null;
    return { start: () => { clearInterval(t); t = setInterval(fn, TICK_MS); }, stop: () => clearInterval(t) };
  }
}

export class Transport {
  // getTarget(moduleNumber) -> instance with noteOn/noteOff, or null
  constructor({ getSong, getBpm, getTarget, setAuto = null, getLayers = null, getScope = () => null, onState, onCountBeat, now = () => performance.now(), ticker = createTicker, pitchOffset = () => 0, events = { starting: notesStarting, sounding: notesSounding } }) {
    Object.assign(this, { getTarget, setAuto, getScope, onState, onCountBeat, now, pitchOffset });
    this.scope = null; // the level playing (see getScope)
    this.song = () => getSong(this.scopeNow());
    this.bpm = () => getBpm(this.scopeNow());
    this.layerList = getLayers && (() => getLayers(this.scopeNow()));
    this.autoActive = new Map(); // layer key + automation clip id -> { id, layer } currently applied
    this.playing = false;
    this.clipId = null;
    this.clipSong = null; // the song of the looped clip (any layer)
    this.pos = 0;
    this.elapsed = 0; // unwrapped quarters since playback began; negative during the count-in
    this.countIn = null;
    this.endAt = null;
    this.generation = 0;
    this.active = []; // { id, inst, end, note, start, vel (last sent) } sounding notes
    this.chase = true; // trigger notes the playhead lands inside (see chaseAt)
    this.chasePending = false;
    this.events = events;
    this.ticker = ticker(() => this.tick());
  }

  // the level playing, else the one play would start from
  scopeNow() {
    return this.playing ? this.scope : this.getScope();
  }

  getSong() { return this.song(); }

  getBpm() { return this.bpm(); }

  layers() {
    return this.layerList?.() ?? [{ key: '', song: this.getSong(), getTarget: this.getTarget, setAuto: this.setAuto }];
  }

  // whether `song` is heard now (it is one of the playing layers); stopped: true (parked playhead)
  plays(song) {
    return !this.playing || this.layers().some((l) => l.song === song);
  }

  // the looped clip (playClip), or null
  loopClip() {
    return this.clipId === null ? null : getClip(this.clipSong ?? this.getSong(), this.clipId);
  }

  // song bounds of song playback: [0, end of the last clip of any layer)
  songBounds(song = this.getSong()) {
    if (song !== this.getSong() || !this.layerList) return [0, loopEnd(song)];
    const end = Math.max(0, ...this.layers().map((l) => songEnd(l.song)));
    return [0, end > 0 ? barCeil(song, end) : 0];
  }

  play({ fromStart = false, countIn = null, endAt = null } = {}) {
    const [start, end] = this.songBounds();
    if (end <= start) {
      if (this.playing) this.stop();
      return false;
    }
    const sameScope = JSON.stringify(this.scope) === JSON.stringify(this.getScope());
    if (this.playing && this.clipId === null && !fromStart && !countIn && sameScope) return true;
    this.clipId = null;
    return this.start(fromStart || this.pos < start || this.pos >= end ? start : this.pos, { countIn, endAt });
  }

  playClip(id, song = this.getSong(), options = {}) {
    const clip = getClip(song, id);
    if (!clip) return false;
    this.clipId = clip.id;
    this.clipSong = song;
    return this.start(clip.start, options);
  }

  get countingIn() { return this.playing && this.elapsed < 0; }

  recordingTime() { return this.elapsed; }

  start(pos = this.pos, { countIn = null, endAt = null } = {}) {
    if (!Number.isFinite(pos)) pos = Number.isFinite(this.pos) ? this.pos : 0; // a NaN position would feed garbage to the engine
    this.releaseAll();
    this.releaseAuto();
    this.scope = this.getScope();
    this.pos = this.from = pos;
    this.generation++;
    this.countIn = countIn;
    this.elapsed = countIn ? -countIn.beats * countIn.beat : 0;
    this.endAt = endAt;
    this.nextCountBeat = 1;
    this.chasePending = true;
    this.playing = true;
    this.last = this.now();
    if (countIn) this.onCountBeat?.(0);
    this.ticker.start();
    this.onState?.(this);
    return true;
  }

  // to: optional position (quarters) to park the playhead at
  stop({ to = null } = {}) {
    this.ticker.stop();
    this.releaseAll();
    this.releaseAuto();
    this.playing = false;
    this.clipId = null;
    this.clipSong = null;
    if (to !== null) this.pos = this.from = Math.max(0, to);
    this.onState?.(this);
  }

  toggle() { return this.playing ? (this.stop(), false) : this.play(); }

  seek(q) {
    if (this.clipId !== null) {
      const clip = this.loopClip();
      if (!clip) { this.stop(); return; }
      if (q < clip.start || q >= clip.start + clip.length) q = clip.start;
    }
    this.releaseAll();
    this.generation++;
    this.elapsed = 0;
    this.countIn = null;
    this.endAt = null;
    this.pos = this.from = this.clipId !== null ? q : Math.max(0, q); // a looped clip may sit before zero
    this.chasePending = true;
    this.last = this.now();
    this.onState?.(this);
  }

  // whether a clip is heard: not on a muted lane, nor outside the soloed lanes; an auditioned
  // idea plays solo (nothing else sounds, on any layer)
  audible(clip, song = this.getSong()) {
    const looped = this.loopClip();
    if (looped && isIdea(looped)) return clip.id === this.clipId && song === (this.clipSong ?? this.getSong());
    return !clipSilent(song, clip);
  }

  releaseAll() {
    for (const n of this.active) n.inst.noteOff(n.id);
    this.active = [];
  }

  tick(nowMs = this.now()) {
    if (!this.playing) return;
    const clip = this.loopClip();
    if (this.clipId !== null && !clip) { this.stop(); return; }
    let [start, end] = clip ? [clip.start, clip.start + clip.length] : this.songBounds();
    if (end <= start) { this.stop(); return; }
    // song playback continues at the restart point at the end of the song
    const restart = clip ? null : this.getSong().restart;
    const back = Number.isFinite(restart) && restart > start && restart < end ? restart : start;
    let span = end - back;
    const dt = Math.min(0.25, Math.max(0, (nowMs - this.last) / 1000)); // a stalled tab must not jump far ahead
    this.last = nowMs;
    let advance = (dt * this.getBpm()) / 60;
    if (this.elapsed < 0) {
      const before = this.elapsed;
      this.elapsed = Math.min(0, this.elapsed + advance);
      const count = this.countIn;
      const counted = count.beats * count.beat + this.elapsed;
      while (this.nextCountBeat < count.beats && counted + 1e-9 >= this.nextCountBeat * count.beat) {
        this.onCountBeat?.(this.nextCountBeat++);
      }
      if (this.elapsed < 0) return;
      advance = Math.max(0, advance + before);
      this.onState?.(this);
    }
    this.elapsed += this.endAt === null ? advance : Math.min(advance, Math.max(0, this.endAt - this.pos));
    if (this.from < start || this.from >= end) {
      this.releaseAll();
      this.from = this.pos = start;
      this.chasePending = true;
    }
    if (this.chasePending) {
      this.chasePending = false;
      if (this.chase) this.chaseAt(this.from);
    }
    let to = this.pos + advance;
    if (this.endAt !== null && to >= this.endAt) {
      this.advance(this.from, this.endAt);
      this.pos = this.from = this.endAt;
      this.stop();
      return;
    }
    for (let guard = 0; to >= end && guard < 4; guard++) {
      this.advance(this.from, end);
      this.releaseAll();
      const next = clip && getClip(this.clipSong, this.clipSong.selected);
      if (next && next.id !== this.clipId && next.length > 0) {
        const remaining = to - end;
        this.clipId = next.id;
        this.pos += next.start - end;
        start = next.start;
        end = next.start + next.length;
        span = next.length;
        to = start + remaining;
        this.releaseAuto();
        if (this.chase) this.chaseAt(start);
      } else {
        to -= span;
        if (!clip && back !== start) {
          start = back;
        }
        if (this.chase) this.chaseAt(start);
      }
      this.from = start;
    }
    // Very short clips can wrap many times in one tick; skip stale cycles, not the loop bounds.
    if (to >= end) {
      this.releaseAll();
      to = start + (to - start) % span;
      if (this.chase) this.chaseAt(start);
    }
    this.advance(this.from, to);
    this.pos = this.from = to;
    this.followNotes(to);
    this.automate(to);
  }

  // velocity curves and pitch bends of the sounding notes
  followNotes(q) {
    for (const n of this.active) {
      const v = noteVelAt(n.note, q - n.start);
      const pitch = notePitchAt(n.note, q - n.start) + n.off;
      if (Math.abs(v - n.vel) < 1e-4 && Math.abs(pitch - n.pitch) < 1e-4) continue;
      n.vel = v;
      n.pitch = pitch;
      n.inst.noteMod?.(n.id, pitch, v);
    }
  }

  automate(q) {
    const now = new Map();
    for (const layer of this.layers()) {
      if (!layer.setAuto) continue;
      for (const { clip, value } of automationAt(layer.song, q)) {
        if (!this.audible(clip, layer.song)) continue;
        now.set(`${layer.key}:${clip.id}`, { id: clip.id, layer });
        layer.setAuto(clip.id, clip, value);
      }
    }
    for (const [k, a] of this.autoActive) if (!now.has(k)) a.layer.setAuto(a.id, null, null);
    this.autoActive = now;
  }

  releaseAuto() {
    for (const a of this.autoActive.values()) a.layer.setAuto?.(a.id, null, null);
    this.autoActive = new Map();
  }

  // note-ons for notes already sounding at q (they end at their normal end)
  chaseAt(q) {
    this.automate(q); // controllers first: a note must not start on a stale controller value
    for (const layer of this.layers()) {
      for (const ev of this.events.sounding(layer.song, q)) {
        if (!this.audible(ev.clip, layer.song)) continue;
        this.trigger(ev, q, layer);
      }
    }
  }

  // at: song time the note starts sounding (later than ev.start when chased)
  trigger(ev, at = ev.start, layer = this.layers()[0]) {
    const inst = layer.getTarget(ev.clip.target);
    if (!inst) return;
    const id = newNoteId();
    const vel = noteVelAt(ev.note, at - ev.start);
    // Preserve distinct musical onsets even when one transport tick delivers several notes.
    const time = this.last / 1000 + (at - this.pos) * 60 / this.getBpm();
    const off = this.pitchOffset(this.scopeNow()); // kept for noteMod: a sounding note keeps its offset
    const pitch = notePitchAt(ev.note, at - ev.start) + off;
    inst.noteOn(id, pitch, vel, 0, time);
    this.active.push({ id, inst, pitch, off, end: ev.end, note: ev.note, start: ev.start, vel, clip: ev.clip, song: layer.song });
  }

  // note-offs due by `to`, then note-ons starting in [from, to) in time order. The automation is
  // applied at each onset before its notes, so a note never starts on a stale controller value
  // (e.g. an envelope or filter setting that jumps when an automation clip starts with the note).
  advance(from, to) {
    const layers = this.layers();
    const songs = new Set(layers.map((l) => l.song));
    this.active = this.active.filter((n) => {
      if (n.end > to && songs.has(n.song) && this.audible(n.clip, n.song)) return true;
      n.inst.noteOff(n.id);
      return false;
    });
    const due = [];
    for (const layer of layers) {
      for (const ev of this.events.starting(layer.song, from, to)) {
        if (this.audible(ev.clip, layer.song)) due.push({ ev, layer });
      }
    }
    due.sort((a, b) => a.ev.start - b.ev.start); // stable: same onset keeps layer/clip order
    let at = NaN;
    for (const { ev, layer } of due) {
      if (ev.start !== at) this.automate(at = ev.start);
      this.trigger(ev, ev.start, layer);
    }
  }
}
