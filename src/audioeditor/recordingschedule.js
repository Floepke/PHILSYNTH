import { LANE_H } from '../song.js';

const BLOCK = 128;

export class RecordingSchedule {
  constructor(graph, transport, rate) {
    this.graph = graph;
    this.transport = transport;
    this.rate = rate;
    this.takes = new Map();
  }

  add({ handle, buffer, lane, scope, from }) {
    if (!Number.isInteger(lane) || lane < 0 || !Array.isArray(scope) || !Number.isFinite(from) || from < 0) {
      throw new Error('Invalid timeline recording');
    }
    this.graph.setRecording(handle, buffer);
    this.graph.setRecordingWindow(handle, 0, 0);
    this.takes.set(handle, { handle, lane, scope: JSON.stringify(scope), from, generation: null });
  }

  start(scope) {
    for (const take of this.takes.values()) {
      if (take.generation !== null || take.scope !== JSON.stringify(scope)) {
        this.graph.setRecording(take.handle, null);
        this.takes.delete(take.handle);
      } else take.generation = this.transport.generation;
    }
  }

  stop() {
    for (const take of this.takes.values()) this.graph.setRecording(take.handle, null);
    this.takes.clear();
  }

  pause() {
    for (const take of this.takes.values()) this.graph.setRecordingWindow(take.handle, 0, 0);
  }

  process() {
    const tr = this.transport;
    for (const take of this.takes.values()) {
      if (!this.graph.recordings.has(take.handle)) { this.takes.delete(take.handle); continue; }
      if (take.generation === null) { this.graph.setRecordingWindow(take.handle, 0, 0); continue; }
      if (!tr.playing || tr.generation !== take.generation || JSON.stringify(tr.scope) !== take.scope) {
        this.graph.setRecording(take.handle, null);
        this.takes.delete(take.handle);
        continue;
      }
      const bpm = tr.getBpm();
      const increment = bpm / (60 * this.rate);
      const wait = Math.max(0, -tr.elapsed);
      const clips = tr.layers().flatMap(({ song }) => song.clips.filter((clip) => clip.y === take.lane * LANE_H));
      let first = BLOCK, last = BLOCK, collision = false;
      for (let i = 0; i < BLOCK; i++) {
        const delta = i * increment;
        if (delta < wait) continue;
        const q = tr.pos + delta - wait;
        if (q < take.from) continue;
        if (clips.some((clip) => q >= clip.start && q < clip.start + clip.length)) {
          last = i;
          collision = true;
          break;
        }
        if (first === BLOCK) first = i;
      }
      if (first > last) first = last;
      if (first < last) {
        const ring = this.graph.recordings.get(take.handle).buffer;
        if (take.bpm !== undefined && Math.abs(take.bpm - bpm) > 1e-6) {
          ring.stopForTempoChange();
          this.graph.setRecording(take.handle, null);
          this.takes.delete(take.handle);
          continue;
        }
        if (take.bpm === undefined) { take.bpm = bpm; ring.tempo = bpm; }
      }
      this.graph.setRecordingWindow(take.handle, first, last, collision);
      if (collision) this.takes.delete(take.handle);
    }
  }
}
