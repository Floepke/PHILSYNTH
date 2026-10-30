import { getModule } from './modules/index.js';
import { fromNorm, paramsOf } from './params.js';

// One patch = one "folder": modules, cables and a sink (where its Output module plays to).
// Module ids are unique per patch; id 0 is always the Output module.
// Controllers (params) are numbered 0.. in definition order; modulator modules (LFO) use
// control cables to drive controller number `outController` of the modules they connect to.
// All DSP runs in one engine graph on the audio thread (src/dsp/): modules create their nodes
// with host.dsp, and the modulation itself is applied there (see updateRoutes); the patch only
// tells the graph which controllers each modulator drives and mirrors the values for display.
// Seed salt of one Patch instance (Instances > 1): instance k (0 = the edited one) of a patch
// whose runtime has salt `parent`. It encodes the whole instance path, so every instance at any
// nesting depth gets its own salt (0 only when every level is instance 0, i.e. as before);
// seeded modules (REVERB) mix it into their seed so no two instances generate the same numbers.
export const instanceSalt = (parent, k) => (parent * 17 + k) % 1000003;

export class PatchRuntime {
  constructor(engine, sink, salt = 0) {
    this.engine = engine;
    this.sink = sink;
    this.salt = salt;
    this.watchers = new Set(); // called on any change inside (structure, controllers, nested patches)
    // what modules get as `host` in create(): nested patches inherit this runtime's salt
    this.host = { salt, dsp: engine.dsp, createPatch: (s, k = 0) => PatchRuntime.create(engine, s, instanceSalt(salt, k)) };
    this.modules = new Map(); // id -> { id, def, inst, x, y, values }
    this.cables = []; // { from, to } module ids
    this.reserved = new Set(); // ids claimed by inserts still being created
    this.listeners = new Set(); // called whenever modules/cables change
  }

  static async create(engine, sink, salt = 0) {
    const p = new PatchRuntime(engine, sink, salt);
    await p.addModule('OUT', { id: 0, x: 560, y: 180 });
    return p;
  }

  emit() {
    this.listeners.forEach((fn) => fn());
    this.changed();
  }

  changed() {
    if (this.dead) return;
    this.refreshRoutes();
    this.watchers.forEach((fn) => fn());
    this.engine.onChange?.();
  }

  // Lowest free module number. 0 is reserved for the Output module.
  lowestFreeId() {
    let id = 1;
    while (this.modules.has(id) || this.reserved.has(id)) id++;
    return id;
  }

  async addModule(type, { id, x = 0, y = 0, values, state } = {}) {
    const def = getModule(type);
    if (!def) throw new Error(`Unknown module type: ${type}`);
    if (id === undefined) id = this.lowestFreeId();
    else if (this.modules.has(id) || this.reserved.has(id)) throw new Error(`Module number ${id} is already taken`);
    this.reserved.add(id); // claim before awaiting so concurrent inserts can't get the same number
    let inst;
    try {
      inst = await def.create(this.engine.ctx, def, this.host);
    } finally {
      this.reserved.delete(id);
    }
    const entry = { id, def, inst, x, y, values: {}, mod: {} };
    inst.attach?.(entry, this); // e.g. a Patch mirrors its mapped inner controllers into entry.values
    // the DSP node whose kernel gets the controllers; reports their modulated values back
    entry.ctl = inst.ctl ?? inst.node ?? inst.input ?? null;
    if (entry.ctl) entry.ctl.onMod = (pid, v) => this.modulated(entry, pid, v);
    for (const p of def.params) {
      entry.values[p.id] = values?.[p.id] ?? p.default;
      inst.setParam(p.id, entry.values[p.id]);
    }
    // module state that is not a controller (e.g. the WAVESHAPER curve); saved with the project
    if (def.defaultState) {
      entry.state = state ? def.normalizeState?.(state) ?? structuredClone(state) : def.defaultState();
      inst.setState?.(entry.state);
    }
    inst.setBpm?.(this.bpm);
    if (def.modulator) {
      entry.modTargets = new Map(); // target id -> controller id currently driven
      inst.getTargets = () => this.cables.filter((c) => c.from === id).map((c) => this.modules.get(c.to)).filter(Boolean);
    }
    if (def.midiOut) {
      inst.getMidiTargets = () => this.cables.filter((c) => c.from === id).map((c) => this.modules.get(c.to)?.inst).filter(Boolean);
    }
    if (inst.patch) inst.patch.watchers.add(() => { inst.mirror?.(); this.changed(); });
    if (def.isOutput) inst.input.connect(this.sink);
    this.modules.set(id, entry);
    this.emit();
    return entry;
  }

  // Copy of a module with the same controller values (a Patch also gets a deep copy of its
  // contents). Cables are not copied. The Output module cannot be duplicated.
  async duplicate(id, { x, y } = {}) {
    const src = this.modules.get(id);
    if (!src || src.def.isOutput) return null;
    const copy = await this.addModule(src.def.type, { x: x ?? src.x + 30, y: y ?? src.y + 30, values: { ...src.values }, state: src.state });
    if (src.inst.patch && copy.inst.patch) await copy.inst.patch.load(src.inst.patch.toJSON());
    return copy;
  }

  // Duplicate a group of modules, offset by (dx, dy). Cables between modules of the group are
  // copied too; the Output module is skipped. Returns the copies.
  async duplicateMany(ids, dx = 30, dy = 30) {
    const map = new Map(); // original id -> copy
    for (const id of [...ids].sort((a, b) => a - b)) {
      const src = this.modules.get(id);
      if (!src || src.def.isOutput) continue;
      map.set(id, await this.duplicate(id, { x: src.x + dx, y: src.y + dy }));
    }
    for (const c of [...this.cables]) {
      if (map.has(c.from) && map.has(c.to)) this.connect(map.get(c.from).id, map.get(c.to).id);
    }
    return [...map.values()];
  }

  // Delete several modules at once (the Output module is skipped). Returns how many were removed.
  removeMany(ids) {
    return [...ids].filter((id) => this.removeModule(id)).length;
  }

  get bpm() {
    return this.modules.get(0)?.values.bpm ?? 120;
  }

  setParam(id, key, value) {
    const e = this.modules.get(id);
    // controllers that follow this one (e.g. OSC Decay <-> Release with Sustain at 0)
    const linked = e.def.linked?.(e.values, key, value, e.def.params) ?? {};
    for (const [k, v] of [[key, value], ...Object.entries(linked)]) {
      e.values[k] = v;
      e.inst.setParam(k, v);
      delete e.mod[k]; // a modulated controller is re-applied (and reported) by the engine graph
    }
    if (e.def.isOutput && key === 'bpm') this.modules.forEach((m) => m.inst.setBpm?.(value));
    this.changed();
  }

  // Replace a module's state (see addModule). Saved, mirrored to Patch instance copies.
  setState(id, state) {
    const e = this.modules.get(id);
    if (!e?.def.defaultState) return;
    e.state = e.def.normalizeState?.(state) ?? structuredClone(state);
    e.inst.setState?.(e.state);
    this.changed();
  }

  // ---- modulation (LFO -> controller), never saved ----
  // The engine graph applies a modulator's value to the controllers in its route list on the audio
  // thread (Out Min/Out Max/Amplitude mapping, see src/dsp/graph.js). Here we keep those lists in
  // sync with the cables and Out Controller, and mirror the reported values in `mod` (display).
  refreshRoutes() {
    for (const m of this.modules.values()) if (m.def.modulator) this.updateRoutes(m);
  }

  updateRoutes(m) {
    if (m.dead || !m.ctl) return;
    const controller = (m.mod.outController ?? m.values.outController) | 0;
    const driven = new Map();
    const list = [];
    for (const c of this.cables) {
      if (c.from !== m.id) continue;
      const t = this.modules.get(c.to);
      const p = t?.ctl && paramsOf(t)[controller];
      if (!p) continue;
      driven.set(t.id, p.id);
      list.push(...this.routesOf(t, p));
    }
    const sig = JSON.stringify(list);
    if (sig !== m.routeSig) {
      m.routeSig = sig;
      m.ctl.routes(list);
    }
    const old = m.modTargets;
    m.modTargets = driven;
    for (const [tid, pid] of old) if (driven.get(tid) !== pid && !this.isDriven(tid, pid)) this.unmodulate(tid, pid);
  }

  // Graph routes that modulate controller `p` of module `t`. A controller a Patch module maps to
  // controllers inside it (p.routes) is modulated right on those inner kernels, every instance.
  routesOf(t, p) {
    if (p.routes) return p.routes();
    return t?.ctl ? [{ to: t.ctl.h, id: p.id, min: p.min, max: p.max, scale: p.scale, step: p.step }] : [];
  }

  // routes of controller id `pid` of module `id` (used by a parent Patch, see routesOf)
  routesTo(id, pid) {
    const t = this.modules.get(id);
    const p = t && paramsOf(t).find((q) => q.id === pid);
    return p ? this.routesOf(t, p) : [];
  }

  isDriven(tid, pid) {
    for (const m of this.modules.values()) if (m.modTargets?.get(tid) === pid) return true;
    return false;
  }

  // report from the engine graph: controller `pid` of module `t` is modulated to `v`. Controllers
  // driven from outside (mapped to a parent Patch controller) are reported up through `forward`.
  // Returns whether the value was accepted (driven).
  modulated(t, pid, v) {
    if (t.dead || this.dead) return false;
    if (!this.isDriven(t.id, pid) && !this.forward?.(t.id, pid, v)) return false;
    if (t.mod[pid] === v) return true;
    t.mod[pid] = v;
    t.inst.onModulated?.(pid, v);
    if (t.def.modulator && pid === 'outController') this.updateRoutes(t);
    this.engine.onModulate?.(t, pid, v);
    return true;
  }

  // Apply a temporary (unsaved) controller value, or the module's own value again (v === null).
  // A Patch module passes values of its mapped controllers on to the controllers inside it.
  live(t, pid, v) {
    if (!t.inst.liveParam?.(pid, v)) t.inst.setParam(pid, v ?? t.values[pid]);
  }

  // A parent Patch drives controller `pid` of module `id` (automation of a mapped controller):
  // like automate(), never saved; v === null gives the controller back its own value.
  override(id, pid, v) {
    const t = this.modules.get(id);
    if (!t || !paramsOf(t).some((q) => q.id === pid) || this.isDriven(id, pid)) return;
    if (v === null) {
      const had = pid in t.mod;
      delete t.mod[pid];
      this.live(t, pid, null);
      if (had) this.engine.onModulate?.(t, pid, null);
      return;
    }
    if (t.mod[pid] === v) return;
    t.mod[pid] = v;
    this.live(t, pid, v);
    this.engine.onModulate?.(t, pid, v);
  }

  // ---- automation clips (see song.js): like modulation, never saved ----
  // key = automation clip id; norm 0..1 over the controller range, or targetId null to release.
  automate(key, targetId, controller, norm) {
    this.autoBindings ??= new Map(); // key -> { tid, pid }
    const prev = this.autoBindings.get(key);
    const t = targetId === null || norm === null ? null : this.modules.get(targetId);
    const p = t ? paramsOf(t)[controller | 0] : null;
    if (prev && (!p || prev.tid !== t.id || prev.pid !== p.id)) {
      this.autoBindings.delete(key);
      if (![...this.autoBindings.values()].some((b) => b.tid === prev.tid && b.pid === prev.pid)) this.unmodulate(prev.tid, prev.pid);
    }
    if (!p) return false;
    this.autoBindings.set(key, { tid: t.id, pid: p.id });
    const v = fromNorm(p, norm);
    if (t.mod[p.id] !== v) {
      t.mod[p.id] = v;
      this.live(t, p.id, v);
      this.engine.onModulate?.(t, p.id, v);
    }
    return true;
  }

  // Give a controller back its own (saved) value.
  unmodulate(targetId, paramId) {
    const t = this.modules.get(targetId);
    if (!t || !(paramId in t.mod)) return;
    delete t.mod[paramId];
    this.live(t, paramId, null);
    this.engine.onModulate?.(t, paramId, null);
  }

  removeModule(id) {
    const e = this.modules.get(id);
    if (!e || e.def.isOutput) return false;
    this.cables.filter((c) => c.from === id || c.to === id).forEach((c) => this.disconnect(c, false));
    e.inst.destroy();
    e.dead = true;
    this.modules.delete(id);
    this.emit();
    return true;
  }

  reaches(from, to) {
    const seen = new Set();
    const walk = (id) => {
      if (id === to) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return this.cables.some((c) => c.from === id && !this.modules.get(id)?.def.modulator && walk(c.to));
    };
    return walk(from);
  }

  // true if a MIDI processor (MULTIMIDI) is cabled into this module
  hasMidiInput(id) {
    return this.cables.some((c) => c.to === id && this.modules.get(c.from)?.def.midiOut);
  }

  connect(fromId, toId) {
    const a = this.modules.get(fromId);
    const b = this.modules.get(toId);
    if (!a || !b || fromId === toId) return false;
    if (this.cables.some((c) => c.from === fromId && c.to === toId)) return false;
    if (a.def.modulator) {
      if (!paramsOf(b).length) return false; // control cable: target only needs controllers
    } else if (a.def.midiOut) {
      if (!b.def.acceptsMidi) return false; // MIDI cable: target must play notes
      if (this.reaches(toId, fromId)) return false; // notes would circle forever
    } else {
      if (!a.def.hasOutput || !b.def.hasInput) return false;
      if (this.reaches(toId, fromId)) return false; // feedback loops would be silenced by Web Audio
      a.inst.node.connect(b.inst.input);
    }
    this.cables.push({ from: fromId, to: toId });
    this.emit();
    return true;
  }

  disconnect(cable, notify = true) {
    const i = this.cables.indexOf(cable);
    if (i < 0) return;
    this.cables.splice(i, 1);
    const a = this.modules.get(cable.from);
    const b = this.modules.get(cable.to);
    if (a.def.modulator) this.updateRoutes(a); // gives the controller back its own value
    else if (a.def.midiOut) {
      a.inst.releaseTarget?.(b.inst);
    } else {
      try { a.inst.node.disconnect(b.inst.input); } catch { /* already disconnected */ }
    }
    if (notify) this.emit();
  }

  destroy() {
    this.dead = true;
    this.listeners.clear();
    this.watchers.clear();
    this.modules.forEach((e) => { e.inst.destroy(); e.dead = true; });
    this.modules.clear();
    this.cables = [];
  }

  // ---- persistence (nested Patch modules are embedded recursively) ----
  toJSON() {
    return {
      modules: [...this.modules.values()].map((e) => ({
        id: e.id, type: e.def.type, x: e.x, y: e.y, values: { ...e.values },
        ...(e.state ? { state: structuredClone(e.state) } : {}),
        ...(e.inst.patch ? { patch: e.inst.patch.toJSON() } : {}),
      })),
      cables: this.cables.map((c) => ({ ...c })),
    };
  }

  async load(data) {
    [...this.modules.keys()].forEach((id) => this.removeModule(id));
    for (const m of data.modules) {
      if (m.id === 0) {
        const out = this.modules.get(0);
        out.x = m.x; out.y = m.y;
        for (const [k, v] of Object.entries(m.values ?? {})) this.setParam(0, k, v);
        continue;
      }
      const e = await this.addModule(m.type, m);
      if (m.patch && e.inst.patch) await e.inst.patch.load(m.patch);
    }
    for (const c of data.cables ?? []) this.connect(c.from, c.to);
  }
}
