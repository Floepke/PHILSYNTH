import { PatchRuntime, instanceSalt, runtimesAt, songLayers } from '../patch.js';
import { Transport } from '../transport.js';
import { emptySong, normalizeSong } from '../song.js';
import { preparePlayback } from '../playbackmodel.js';
import { captureMidiTrace, withMidiTrace } from '../modmidi.js';

class NoteIndex {
  constructor() { this.songs = new WeakMap(); }
  update(song) {
    const events = [];
    for (const clip of song.clips) for (const note of clip.notes) {
      if (note.start >= clip.length) continue;
      events.push({ clip, note, start: clip.start + note.start, end: clip.start + Math.min(clip.length, note.start + note.length) });
    }
    this.songs.set(song, events.sort((a, b) => a.start - b.start));
  }
  starting(song, from, to) {
    const events = this.songs.get(song) ?? [];
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (events[mid].start < from) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < events.length && events[i].start < to; i++) {
      const event = events[i];
      if (event.note.start >= 0 && event.clip.start + event.clip.length > from) out.push(event);
    }
    return out;
  }
  sounding(song, q) {
    return (this.songs.get(song) ?? []).filter((e) => e.clip.start <= q && e.clip.start + e.clip.length > q && e.start < q && e.end > q);
  }
}

class BoundNode {
  constructor(dsp, h) {
    this.dsp = dsp;
    this.h = h;
    this.notes = new Set();
  }
  get inputs() { return (this.dsp.graph.nodes.get(this.h)?.srcs ?? []).map((n) => this.dsp.node(n.h)); }
  send(message) {
    const dsp = this.dsp;
    if (dsp.loading || !dsp.graph.nodes.has(this.h)) return;
    if (message.type === 'noteOn') this.notes.add(message.id);
    else if (message.type === 'noteOff') this.notes.delete(message.id);
    else if (message.type === 'allOff') {
      // Only our notes: stopping/rebuilding playback must not release live keyboard voices.
      for (const id of this.notes) dsp.graph.message(this.h, { type: 'noteOff', id });
      this.notes.clear();
      return;
    }
    dsp.graph.message(this.h, message);
  }
  param(id, value) { this.send({ type: 'param', id, value }); }
  routes(list) { if (!this.dsp.loading) this.dsp.graph.setRoutes(this.h, list); }
  connect(node) { if (!this.dsp.loading) this.dsp.graph.connect(this.h, node.h); return node; }
  disconnect(node) {
    if (this.dsp.loading) return;
    if (node) this.dsp.graph.disconnect(this.h, node.h);
    else for (const dst of [...(this.dsp.graph.nodes.get(this.h)?.dsts ?? [])]) this.dsp.graph.disconnect(this.h, dst.h);
  }
  destroy() { this.send({ type: 'allOff' }); }
}

class BoundDsp {
  constructor(graph, bindings) {
    this.graph = graph;
    this.setBindings(bindings);
    this.nodes = new Map();
    this.clocks = new Set();
    this.loading = true;
    this.clockBatch = true;
    this.destination = this.node(0);
  }
  setBindings(bindings) { this.bindings = new Map(bindings.map((b) => [`${b.sink}:${b.salt}`, b])); }
  node(h) {
    if (!this.nodes.has(h)) this.nodes.set(h, new BoundNode(this, h));
    return this.nodes.get(h);
  }
  onClock(fn) { this.clocks.add(fn); return () => this.clocks.delete(fn); }
  forModule(sink, salt, id) {
    const entry = this.bindings.get(`${sink}:${salt}`)?.modules.find((m) => m.id === id);
    if (!entry) throw new Error(`Playback binding missing for module ${id} (${sink}:${salt})`);
    let index = 0;
    return {
      clockBatch: true,
      controlOnly: true,
      deferSync: () => this.updating,
      maxInstances: (output, parent) => {
        let count = 0;
        while (this.bindings.has(`${output}:${instanceSalt(parent, count)}`)) count++;
        return count;
      },
      onClock: (fn) => this.onClock(fn),
      create: (kind) => {
        const node = entry.nodes[index++];
        if (!node || node.kind !== kind || !this.graph.nodes.has(node.h)) {
          throw new Error(`Playback DSP binding mismatch for module ${id}: ${kind}`);
        }
        return this.node(node.h);
      },
    };
  }
}

export class Playback {
  constructor(graph, now) {
    this.graph = graph;
    this.now = now;
    this.root = null;
    this.song = emptySong();
    this.scope = [];
    this.revision = 0;
    this.driven = new Map();
    this.events = new NoteIndex();
    this.noteKeys = new WeakMap();
    this.cableKeys = new WeakMap();
    this.midi = [];
    this.midiRoots = new Map();
    this.nextTrace = 0;
    this.events.update(this.song);
    this.transport = new Transport({
      getScope: () => this.scope,
      getSong: (ids) => ids.length ? this.runtime(ids)?.song ?? emptySong() : this.song,
      getBpm: (ids) => this.runtime(ids)?.bpm ?? 120,
      getTarget: () => null,
      getLayers: (ids) => this.root ? songLayers(this.root, this.song, ids, { nested: false }) : [],
      pitchOffset: (ids) => this.runtime(ids)?.pitchOffset ?? 0,
      now: () => this.now() * 1000,
      ticker: () => ({ start() {}, stop() {} }),
      events: this.events,
      onCountBeat: (beat) => { this.blip = { time: this.now(), hz: beat === 0 ? 440 : 220 }; },
    });
  }
  runtime(ids) { return this.root ? runtimesAt(this.root, ids)[0] : null; }

  async model(data) {
    const structure = JSON.stringify(data.bindings);
    if (this.root) {
      this.dsp.setBindings(data.bindings);
      this.dsp.updating = true;
      try {
        if (structure === this.structure) this.applyValues(this.root, data.patch, this.modelData.patch);
        else await this.updateTopology(this.root, data.patch, this.modelData.patch);
      } catch (error) {
        this.structure = null; // a retry must reconcile any partially applied topology
        throw error;
      } finally { this.dsp.updating = false; }
      await preparePlayback(this.root);
      this.indexSongs(this.root, data.patch);
      this.structure = structure;
      this.modelData = data;
      this.failed = false;
      for (const h of this.dsp.nodes.keys()) if (!this.graph.nodes.has(h)) this.dsp.nodes.delete(h);
      return;
    }
    const dsp = new BoundDsp(this.graph, data.bindings);
    this.dsp = dsp;
    const engine = {
      dsp,
      ctx: { get currentTime() { return engine.now(); } },
      now: this.now,
      onError: (error) => this.onError?.(error),
      midiCables: { transmit: (cable, id, send) => {
        const key = this.cableKeys.get(cable);
        const trace = captureMidiTrace() ?? this.midiRoots.get(id) ?? { key: ++this.nextTrace, end: 0 };
        this.midiRoots.set(id, trace);
        if (key) this.midi.push([...key, trace.key, trace.end++]);
        return withMidiTrace(trace, send);
      } },
      onDrive: (entry, id, value) => {
        if (dsp.loading || !entry.ctl) return;
        this.driven.set(`${entry.ctl.h}:${id}`, [entry.ctl.h, id, value]);
      },
    };
    const root = await PatchRuntime.create(engine, dsp.destination);
    try {
      await root.load(data.patch);
      await preparePlayback(root);
    } catch (error) {
      root.destroy();
      throw error;
    }
    this.root = root;
    this.indexSongs(root, data.patch);
    this.structure = structure;
    this.modelData = data;
    dsp.loading = false;
    this.failed = false;
  }

  indexSongs(rt, data) {
    for (const cable of rt.cables) this.cableKeys.set(cable, [rt.sink.h, rt.salt, cable.from, cable.to]);
    // updateSong also preserves the active note objects across edits.
    this.updateSong(rt.song, data.song);
    for (const { id, inst } of rt.modules.values()) if (inst.patch) {
      const nested = data.modules.find((m) => m.id === id).patch;
      for (const child of [inst.patch, ...inst.clones]) this.indexSongs(child, nested);
    }
  }

  async updateTopology(rt, data, previous) {
    const binding = this.dsp.bindings.get(`${rt.sink.h}:${rt.salt}`);
    for (const e of [...rt.modules.values()]) {
      const wanted = binding.modules.find((m) => m.id === e.id);
      if (!wanted || wanted.type !== e.def.type || JSON.stringify(wanted.nodes) !== JSON.stringify(e.nodes)) rt.removeModule(e.id);
    }
    for (const cable of [...rt.cables]) {
      if (!data.cables.some((c) => c.from === cable.from && c.to === cable.to)) rt.disconnect(cable);
    }
    for (const m of data.modules) {
      let e = rt.modules.get(m.id);
      const old = previous?.modules.find((p) => p.id === m.id);
      if (!e) e = await rt.addModule(m.type, m);
      else this.applyModuleValues(rt, m, old);
      if (m.patch) await this.updateTopology(e.inst.patch, m.patch, old?.patch);
    }
    for (const c of data.cables) if (!rt.cables.some((x) => x.from === c.from && x.to === c.to)) rt.connect(c.from, c.to);
  }

  applyModuleValues(rt, m, old) {
    for (const [id, value] of Object.entries(m.values)) {
      if (old?.values[id] !== value) rt.setParam(m.id, id, value);
    }
    if (JSON.stringify(m.state) !== JSON.stringify(old?.state)) rt.setState(m.id, m.state);
  }

  applyValues(rt, data, previous) {
    for (const m of data.modules) {
      const e = rt.modules.get(m.id);
      const old = previous.modules.find((p) => p.id === m.id);
      this.applyModuleValues(rt, m, old);
      if (m.patch) for (const child of [e.inst.patch, ...e.inst.clones]) this.applyValues(child, m.patch, old.patch);
    }
  }

  setSong(song) {
    this.updateSong(this.song, song);
  }

  updateSong(song, data) {
    const next = normalizeSong(data);
    // Keep references for held notes and the auditioned song while replacing its contents.
    const oldClips = new Map(song.clips.map((c) => [c.id, c]));
    next.clips = next.clips.map((clip) => {
      const old = oldClips.get(clip.id);
      const source = data?.clips.find((c) => c.id === clip.id);
      const oldNotes = new Map((old?.notes ?? []).map((n) => [this.noteKeys.get(n), n]));
      clip.notes = clip.notes.map((note, i) => {
        const key = source?.notes[i]?.playbackKey;
        const previous = key === undefined ? null : oldNotes.get(key);
        const result = previous ? this.replace(previous, note) : note;
        if (key !== undefined) this.noteKeys.set(result, key);
        return result;
      });
      return old ? this.replace(old, clip) : clip;
    });
    this.replace(song, next);
    this.events.update(song);
  }

  replace(target, data) {
    for (const key of Object.keys(target)) if (!(key in data)) delete target[key];
    return Object.assign(target, data);
  }

  command(data) {
    this.revision = data.revision ?? this.revision;
    const tr = this.transport;
    if (data.type === 'start') {
      if (!this.root) throw new Error('Playback model is not ready');
      if (this.failed) throw new Error('Playback synchronization failed; synchronize the project before restarting');
      this.scope = data.scope;
      tr.clipId = data.clipId;
      tr.clipSong = data.clipId === null ? null : (this.scope.length ? this.runtime(this.scope)?.song : this.song);
      tr.chase = data.chase;
      tr.start(data.pos, { countIn: data.countIn, endAt: data.endAt ?? null, continuous: data.continuous ?? false });
    } else if (data.type === 'seek') tr.seek(data.pos);
    else if (data.type === 'stop') tr.stop({ to: data.pos });
    else if (data.type === 'continuous') tr.setContinuous(data.continuous);
    else if (data.type === 'panic') {
      tr.stop();
      for (const e of this.root?.modules.values() ?? []) e.inst.allOff?.();
    }
    if (!tr.playing) this.blip = null;
  }

  renderCountIn(left, right, rate) {
    if (!this.blip) return;
    const { time, hz } = this.blip;
    const age = this.now() - time;
    for (let i = 0; i < left.length; i++) {
      const t = age + i / rate;
      if (t >= 0.1) { this.blip = null; break; }
      const attack = Math.min(1, t / 0.002);
      const release = Math.max(0, 1 - t / 0.1);
      const v = 0.2 * attack * release * Math.exp(-t * 55) * Math.sin(2 * Math.PI * hz * t);
      left[i] += v;
      if (right !== left) right[i] += v;
    }
  }

  process() {
    if (!this.root || this.failed) return;
    this.transport.tick();
    for (const fn of this.dsp.clocks) fn(this.now());
    this.midiRoots.clear();
  }

  receive(mods) {
    if (!this.root || this.failed || !mods) return;
    for (let i = 0; i < mods.length; i += 3) this.dsp.nodes.get(mods[i])?.onMod?.(mods[i + 1], mods[i + 2]);
  }

  report() {
    const tr = this.transport;
    const result = {
      revision: this.revision, playing: tr.playing, pos: tr.pos, clipId: tr.clipId,
      elapsed: tr.elapsed, time: this.now(), bpm: tr.getBpm(),
      mods: [...this.driven.values()].flat(),
      midi: this.midi,
    };
    this.midi = [];
    this.driven.clear();
    return result;
  }
}
