import { getModule } from './modules/index.js';
import { fromNorm, paramsOf } from './params.js';

// One patch = one "folder": modules, cables and a sink (where its Output module plays to).
// Module ids are unique per patch; id 0 is always the Output module.
// Controllers (params) are numbered 0.. in definition order; modulator modules (LFO) use
// control cables to drive controller number `outController` of the modules they connect to.
// All DSP runs in one engine graph on the audio thread (src/dsp/): modules create their nodes
// with host.dsp, and the modulation itself is applied there (see updateRoutes); the patch tells
// the graph which controllers each modulator drives and takes the reported values over as the
// controllers' real values (see drive()).
// Seed salt of one Patch instance (Instances > 1): instance k (0 = the edited one) of a patch
// whose runtime has salt `parent`. It encodes the whole instance path, so every instance at any
// nesting depth gets its own salt (0 only when every level is instance 0, i.e. as before);
// seeded modules (REVERB) mix it into their seed so no two instances generate the same numbers.
export const instanceSalt = (parent, k) => (parent * 17 + k) % 1000003;

// Custom module name: trimmed, at most 40 characters; '' = the default name.
export const MAX_NAME = 40;
export const cleanName = (name) => (typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '');

// DELAY is a dual source: one cable carries whichever signals its destination accepts.
export const cableSignals = (a, b) => ({
  audio: !!(!a.modulator && (!a.midiOut || a.audioMidi) && a.hasOutput && b.hasInput),
  midi: !!(a.midiOut && b.acceptsMidi),
});

export class PatchRuntime {
  constructor(engine, sink, salt = 0) {
    this.engine = engine;
    this.sink = sink;
    this.salt = salt;
    this.watchers = new Set(); // called on any change inside (structure, controllers, nested patches)
    // what modules get as `host` in create(): nested patches inherit this runtime's salt
    this.host = { salt, dsp: engine.dsp, mics: engine.mics ?? null, createPatch: (s, k = 0) => PatchRuntime.create(engine, s, instanceSalt(salt, k)) };
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

  async addModule(type, { id, x = 0, y = 0, values, state, name } = {}) {
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
    const entry = { id, def, inst, x, y, values: {} };
    const label = cleanName(name);
    if (label) entry.name = label; // custom name shown on the module box (the panel keeps the type)
    inst.attach?.(entry, this); // e.g. a Patch mirrors its mapped inner controllers into entry.values
    // the DSP node whose kernel gets the controllers; reports their driven values back
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
      entry.modTargets = new Map(); // `${target id} ${controller id}` -> [target id, controller id] driven
      inst.getTargets = () => this.cables.filter((c) => c.from === id).map((c) => this.modules.get(c.to)).filter(Boolean);
    }
    if (def.midiOut) {
      inst.getMidiTargets = () => this.cables.filter((c) => c.from === id)
        .map((c) => this.modules.get(c.to)).filter((t) => t && cableSignals(def, t.def).midi).map((t) => t.inst);
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
    const copy = await this.addModule(src.def.type, { x: x ?? src.x + 30, y: y ?? src.y + 30, values: { ...src.values }, state: src.state, name: src.name });
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
    this.remapStates(map);
    for (const c of [...this.cables]) {
      if (map.has(c.from) && map.has(c.to)) this.connect(map.get(c.from).id, map.get(c.to).id);
    }
    return [...map.values()];
  }

  // Copies keep pointing at copies: module state that names module ids (MULTICTL routes) is
  // renumbered with `map` (original id -> new module) before the cables are copied.
  remapStates(map) {
    const ids = new Map([...map].map(([from, e]) => [from, e.id]));
    for (const e of map.values()) if (e.state && e.def.remapState) e.state = e.def.remapState(e.state, ids);
  }

  // Delete several modules at once (the Output module is skipped). Returns how many were removed.
  removeMany(ids) {
    return [...ids].filter((id) => this.removeModule(id)).length;
  }

  // Custom name shown on a module's box; empty restores the default (its type). Saved.
  rename(id, name) {
    const e = this.modules.get(id);
    if (!e) return false;
    const label = cleanName(name);
    if (label) e.name = label; else delete e.name;
    this.changed();
    return true;
  }

  // ---- clipboard (patcher cut / copy / paste) ----
  // Plain data of a group of modules (the Output module is skipped): their settings, nested
  // patches and the cables between them. Independent of this patch, so it pastes into any level.
  copyMany(ids) {
    const set = new Set([...ids].filter((id) => this.modules.has(id) && id !== 0));
    if (!set.size) return null;
    const { modules, cables } = this.toJSON();
    return {
      modules: modules.filter((m) => set.has(m.id)),
      cables: cables.filter((c) => set.has(c.from) && set.has(c.to)),
    };
  }

  // Insert copied modules with new numbers; the group's top-left corner lands at (x, y).
  // Returns the new modules.
  async pasteMany(data, { x, y } = {}) {
    if (!data?.modules?.length) return [];
    const left = Math.min(...data.modules.map((m) => m.x));
    const top = Math.min(...data.modules.map((m) => m.y));
    const dx = x === undefined ? 30 : x - left;
    const dy = y === undefined ? 30 : y - top;
    const map = new Map(); // copied id -> new module
    for (const m of [...data.modules].sort((a, b) => a.id - b.id)) {
      if (!getModule(m.type) || getModule(m.type).isOutput) continue;
      const e = await this.addModule(m.type, { x: Math.round(m.x + dx), y: Math.round(m.y + dy), values: m.values, state: m.state, name: m.name });
      if (m.patch && e.inst.patch) await e.inst.patch.load(m.patch);
      map.set(m.id, e);
    }
    this.remapStates(map);
    for (const c of data.cables ?? []) {
      if (map.has(c.from) && map.has(c.to)) this.connect(map.get(c.from).id, map.get(c.to).id);
    }
    return [...map.values()];
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
      e.inst.setParam(k, v); // a modulated controller is re-applied (and reported) by the engine graph
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

  // ---- modulation: LFO, ADSR, VELO2CTL, SOUND2CTL and MULTICTL cables, automation clips ----
  // A modulation source moves the controller for real: its value changes (the panel shows it) and
  // stays when the source stops, and it is saved with the project. It is no undo step, though.
  // The engine graph applies a modulator's value to the controllers in its route list on the audio
  // thread (Out Min/Out Max/Amplitude mapping, see src/dsp/graph.js) and reports it back; here we
  // keep those lists in sync with the cables and Out Controller.
  refreshRoutes() {
    for (const m of this.modules.values()) if (m.def.modulator) this.updateRoutes(m);
  }

  updateRoutes(m) {
    if (m.dead || !m.ctl) return;
    const controller = m.values.outController | 0;
    const driven = new Map(); // `${target id} ${controller id}` -> [target id, controller id]
    const list = [];
    for (const c of this.cables) {
      if (c.from !== m.id) continue;
      const t = this.modules.get(c.to);
      if (!t?.ctl) continue;
      const params = paramsOf(t);
      // MULTICTL picks controllers per target (def.routeParams); others drive Out Controller
      const ps = m.def.routeParams
        ? m.def.routeParams(m, t).map((pid) => params.find((q) => q.id === pid))
        : [params[controller]];
      for (const p of ps) {
        if (!p) continue;
        driven.set(`${t.id} ${p.id}`, [t.id, p.id]);
        list.push(...this.routesOf(t, p));
      }
    }
    const sig = JSON.stringify(list);
    if (sig !== m.routeSig) {
      m.routeSig = sig;
      m.ctl.routes(list);
    }
    m.modTargets = driven;
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

  // a modulator cable in this patch drives controller `pid` of module `tid`; `outside` also counts
  // a modulator on a parent Patch controller that is mapped to it
  isDriven(tid, pid, outside = false) {
    for (const m of this.modules.values()) if (m.modTargets?.has(`${tid} ${pid}`)) return true;
    return outside && !!this.drivenFromOutside?.(tid, pid);
  }

  // report from the engine graph: controller `pid` of module `t` was driven to `v` (the kernel
  // already has it). Returns whether the value was accepted (driven).
  modulated(t, pid, v) {
    if (t.dead || this.dead || !this.isDriven(t.id, pid, true)) return false;
    this.drive(t, pid, v, true);
    return true;
  }

  // A modulation source sets controller `pid` of module `t` to `v` for real (see above).
  // `applied`: the DSP already has the value (reported by the graph).
  drive(t, pid, v, applied = false) {
    if (t.dead || this.dead || t.values[pid] === v) return;
    t.values[pid] = v;
    if (applied) t.inst.onModulated?.(pid, v);
    else if (!t.inst.driveParam?.(pid, v)) t.inst.setParam(pid, v);
    if (t.def.isOutput && pid === 'bpm') this.modules.forEach((m) => m.inst.setBpm?.(v));
    if (t.def.modulator && pid === 'outController') this.updateRoutes(t);
    this.engine.onDrive?.(t, pid, v);
    this.forward?.(t.id, pid, v); // a parent Patch shows it on its mapped controller
  }

  // drive() by module number
  driveId(id, pid, v) {
    const t = this.modules.get(id);
    if (t && pid in t.values) this.drive(t, pid, v);
  }

  // ---- automation clips (see song.js) ----
  // key = automation clip id; norm 0..1 over the controller range, or targetId null when the clip
  // ends (the controller keeps its last value).
  automate(key, targetId, controller, norm) {
    const t = targetId === null || norm === null ? null : this.modules.get(targetId);
    const p = t ? paramsOf(t)[controller | 0] : null;
    if (!p) return false;
    this.drive(t, p.id, fromNorm(p, norm));
    return true;
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

  // true if a MIDI processor is cabled into this module
  hasMidiInput(id) {
    const target = this.modules.get(id);
    return !!target && this.cables.some((c) => c.to === id && cableSignals(this.modules.get(c.from).def, target.def).midi);
  }

  connect(fromId, toId) {
    const a = this.modules.get(fromId);
    const b = this.modules.get(toId);
    if (!a || !b || fromId === toId) return false;
    if (this.cables.some((c) => c.from === fromId && c.to === toId)) return false;
    if (a.def.modulator) {
      if (!paramsOf(b).length) return false; // control cable: target only needs controllers
    } else {
      const signals = cableSignals(a.def, b.def);
      if (!signals.audio && !signals.midi) return false;
      if (this.reaches(toId, fromId)) return false; // audio or notes would circle forever
      if (signals.audio) a.inst.node.connect(b.inst.input);
    }
    this.cables.push({ from: fromId, to: toId });
    a.def.connected?.(a, b, a.inst.getTargets?.() ?? []); // e.g. MULTICTL copies routes to a module of a routed type
    this.emit();
    return true;
  }

  disconnect(cable, notify = true) {
    const i = this.cables.indexOf(cable);
    if (i < 0) return;
    this.cables.splice(i, 1);
    const a = this.modules.get(cable.from);
    const b = this.modules.get(cable.to);
    if (a.def.modulator) {
      a.def.disconnected?.(a, b); // e.g. MULTICTL forgets its routes to that module
      this.updateRoutes(a); // gives the controller back its own value
    }
    else {
      const signals = cableSignals(a.def, b.def);
      if (signals.midi) a.inst.releaseTarget?.(b.inst);
      if (signals.audio) a.inst.node.disconnect(b.inst.input);
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
        ...(e.name ? { name: e.name } : {}),
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
        if (cleanName(m.name)) out.name = cleanName(m.name); else delete out.name;
        if (out.def.defaultState) out.state = m.state ? out.def.normalizeState?.(m.state) ?? structuredClone(m.state) : out.def.defaultState();
        for (const [k, v] of Object.entries(m.values ?? {})) this.setParam(0, k, v);
        continue;
      }
      const e = await this.addModule(m.type, m);
      if (m.patch && e.inst.patch) await e.inst.patch.load(m.patch);
    }
    for (const c of data.cables ?? []) this.connect(c.from, c.to);
  }
}
