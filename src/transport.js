// Plays the song: the position runs in quarter notes at the main patch's BPM; clip notes are sent
// as MODMIDI (see modmidi.js) to the module number each clip targets. Loops at loopEnd(song),
// or at the exact bounds of a single clip when clipId is set. A loop region (song.loop, set on the
// TimeLine ruler) replaces the song bounds: playback jumps into it and loops there.
// Note chasing: when playback starts or jumps (play, clip play, seek) into the middle of a note,
// that note is triggered right away and plays for the rest of its length.
// Velocity curves (note.vels, see song.js): every tick each sounding note's velocity is
// re-evaluated and changes are sent as noteMod, so edits while playing are heard right away too.
// Automation clips: while playing, setAuto(clipId, clip, value 0..1) is called every tick for each
// automation clip under the playhead; setAuto(clipId, null, null) releases a clip when the
// playhead leaves it or playback stops (the controller gets its own value back).
import { newNoteId } from './modmidi.js';
import { automationAt, getClip, loopEnd, loopRegion, notesSounding, notesStarting, noteVelAt } from './song.js';

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
  constructor({ getSong, getBpm, getTarget, setAuto = null, onState, now = () => performance.now(), ticker = createTicker }) {
    Object.assign(this, { getSong, getBpm, getTarget, setAuto, onState, now });
    this.autoActive = new Set(); // automation clip ids currently applied
    this.playing = false;
    this.clipId = null;
    this.pos = 0;
    this.active = []; // { id, inst, end, note, start, vel (last sent) } sounding notes
    this.chase = true; // trigger notes the playhead lands inside (see chaseAt)
    this.chasePending = false;
    this.ticker = ticker(() => this.tick());
  }

  // song bounds of song playback: the loop region, else [0, loopEnd)
  songBounds(song = this.getSong()) {
    const r = loopRegion(song);
    return r ? [r.start, r.end] : [0, loopEnd(song)];
  }

  play({ fromStart = false } = {}) {
    const [start, end] = this.songBounds();
    if (end <= start) {
      if (this.playing) this.stop();
      return false;
    }
    if (this.playing && this.clipId === null && !fromStart) return true;
    this.clipId = null;
    return this.start(fromStart || this.pos < start || this.pos >= end ? start : this.pos);
  }

  playClip(id) {
    const clip = getClip(this.getSong(), id);
    if (!clip) return false;
    this.clipId = clip.id;
    return this.start(clip.start);
  }

  start(pos) {
    this.releaseAll();
    this.pos = this.from = pos;
    this.chasePending = true;
    this.playing = true;
    this.last = this.now();
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
    if (to !== null) this.pos = this.from = Math.max(0, to);
    this.onState?.(this);
  }

  toggle() { return this.playing ? (this.stop(), false) : this.play(); }

  seek(q) {
    if (this.clipId !== null) {
      const clip = getClip(this.getSong(), this.clipId);
      if (!clip) { this.stop(); return; }
      if (q < clip.start || q >= clip.start + clip.length) q = clip.start;
    }
    this.releaseAll();
    this.pos = this.from = this.clipId !== null ? q : Math.max(0, q); // a looped clip may sit before zero
    this.chasePending = true;
    this.last = this.now();
    this.onState?.(this);
  }

  releaseAll() {
    for (const n of this.active) n.inst.noteOff(n.id);
    this.active = [];
  }

  tick(nowMs = this.now()) {
    if (!this.playing) return;
    const song = this.getSong();
    const clip = getClip(song, this.clipId);
    if (this.clipId !== null && !clip) { this.stop(); return; }
    const [start, end] = clip ? [clip.start, clip.start + clip.length] : this.songBounds(song);
    if (end <= start) { this.stop(); return; }
    const span = end - start;
    const dt = Math.min(0.25, Math.max(0, (nowMs - this.last) / 1000)); // a stalled tab must not jump far ahead
    this.last = nowMs;
    if (this.from < start || this.from >= end) {
      this.releaseAll();
      this.from = this.pos = start;
      this.chasePending = true;
    }
    if (this.chasePending) {
      this.chasePending = false;
      if (this.chase) this.chaseAt(this.from);
    }
    let to = this.pos + (dt * this.getBpm()) / 60;
    for (let guard = 0; to >= end && guard < 4; guard++) {
      this.advance(this.from, end);
      this.releaseAll();
      to -= span;
      this.from = start;
    }
    // Very short clips can wrap many times in one tick; skip stale cycles, not the loop bounds.
    if (to >= end) to = start + (to - start) % span;
    this.advance(this.from, to);
    this.pos = this.from = to;
    this.followVelocity(to);
    this.automate(to);
  }

  followVelocity(q) {
    for (const n of this.active) {
      const v = noteVelAt(n.note, q - n.start);
      if (Math.abs(v - n.vel) < 1e-4) continue;
      n.vel = v;
      n.inst.noteMod?.(n.id, n.note.pitch, v);
    }
  }

  automate(q) {
    if (!this.setAuto) return;
    const now = new Set();
    for (const { clip, value } of automationAt(this.getSong(), q)) {
      if (this.clipId !== null && clip.id !== this.clipId) continue;
      now.add(clip.id);
      this.setAuto(clip.id, clip, value);
    }
    for (const id of this.autoActive) if (!now.has(id)) this.setAuto(id, null, null);
    this.autoActive = now;
  }

  releaseAuto() {
    for (const id of this.autoActive) this.setAuto?.(id, null, null);
    this.autoActive = new Set();
  }

  // note-ons for notes already sounding at q (they end at their normal end)
  chaseAt(q) {
    for (const ev of notesSounding(this.getSong(), q)) {
      if (this.clipId !== null && ev.clip.id !== this.clipId) continue;
      this.trigger(ev, q);
    }
  }

  // at: song time the note starts sounding (later than ev.start when chased)
  trigger(ev, at = ev.start) {
    const inst = this.getTarget(ev.clip.target);
    if (!inst) return;
    const id = newNoteId();
    const vel = noteVelAt(ev.note, at - ev.start);
    inst.noteOn(id, ev.note.pitch, vel);
    this.active.push({ id, inst, end: ev.end, note: ev.note, start: ev.start, vel });
  }

  // note-offs due by `to`, then note-ons starting in [from, to)
  advance(from, to) {
    this.active = this.active.filter((n) => {
      if (n.end > to) return true;
      n.inst.noteOff(n.id);
      return false;
    });
    for (const ev of notesStarting(this.getSong(), from, to)) {
      if (this.clipId !== null && ev.clip.id !== this.clipId) continue;
      this.trigger(ev);
    }
  }
}
