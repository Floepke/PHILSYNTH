// A Patch is a folder: it holds a whole project (with its own Output, module 0).
// Incoming audio is routed to the inner module selected by 'Input Module'.
// The inner Output module feeds this module's output.
//
// Instances (1..16): when > 1 and Input Module is a MIDI module without audio input (OSC,
// MULTIMIDI), the contents run that many times and incoming notes go round robin over the
// instances (a free instance first). Instance 1 is the one you edit; the others are hidden
// copies kept in sync with it. Every instance runs its own random generators (drift, Random
// LFO, ...) and seeded modules (REVERB) get a per-instance salt, so no two instances are alike.
//
// Mapped controllers (state.maps, edited in the Controllers dialog): any controller of any module
// inside can be mapped to an extra controller of this module (numbered after Input Module and
// Instances). It shows and sets that inner controller's value (saved inside, every instance
// follows), and LFOs / automation clips on it drive the inner controller (on the audio thread,
// every instance). A nested Patch's own mapped controllers can be mapped again one level up.
import { paramsOf } from '../params.js';

const RELEASE_KEEP_MS = 10000;
const MAX_INSTANCES = 16;
const MAP_KEY = /^map\d+$/;

// state: { maps: [{ key: 'map1', module: inner module id, param: inner controller id, label }] }
export function normalizeMaps(state) {
  const seen = new Set();
  const maps = [];
  for (const m of Array.isArray(state?.maps) ? state.maps : []) {
    const key = String(m?.key ?? '');
    const module = Number(m?.module);
    const param = typeof m?.param === 'string' ? m.param : '';
    if (!MAP_KEY.test(key) || seen.has(key) || !Number.isInteger(module) || module < 0 || !param) continue;
    if (maps.some((x) => x.module === module && x.param === param)) continue;
    seen.add(key);
    maps.push({ key, module, param, label: typeof m.label === 'string' ? m.label.slice(0, 40) : '' });
  }
  return { maps };
}

// unused key for a new mapping (keys stay put when others are removed or reordered)
export function nextMapKey(maps) {
  let n = 1;
  for (const m of maps) n = Math.max(n, +m.key.slice(3) + 1);
  return `map${n}`;
}

// structure of a saved patch (modules, types, cables, nested structure) without values/positions
const structure = (data) => JSON.stringify(data.modules.map((m) => [m.id, m.type, m.patch ? structure(m.patch) : 0])) + JSON.stringify(data.cables);

// copy all controller values (and module state) of `data` into runtime `rt` (same structure), nested patches too
function applyValues(rt, data) {
  for (const m of data.modules) {
    const e = rt.modules.get(m.id);
    if (!e) continue;
    for (const [k, v] of Object.entries(m.values)) if (e.values[k] !== v) rt.setParam(m.id, k, v);
    if (m.state && JSON.stringify(m.state) !== JSON.stringify(e.state)) rt.setState(m.id, m.state);
    if (m.patch && e.inst.patch) applyValues(e.inst.patch, m.patch);
  }
}

export default {
  type: 'PATCH',
  color: '#7d5fb8',
  label: 'Patch (folder)',
  acceptsMidi: true, // forwarded to every MIDI-capable module inside
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'inputModule', label: 'Input Module', min: 0, max: 0, default: 0, step: 1 },
    { id: 'instances', label: 'Instances', min: 1, max: MAX_INSTANCES, default: 1, step: 1 },
  ],
  defaultState: () => ({ maps: [] }),
  normalizeState: normalizeMaps,
  view: (entry, api) => api.patchControllers?.(entry) ?? null, // "Controllers…" button (main.js)
  async create(_ctx, def, host) {
    // signal buses: in -> the Input Module inside; the inner Output (of every instance) -> out
    const inGain = host.dsp.create('bus');
    const outGain = host.dsp.create('bus');
    const patch = await host.createPatch(outGain);
    let target = 0;
    let instances = 1;
    let maps = []; // state.maps
    let entry = null; // this module in its parent patch (attach)
    let owner = null; // the parent patch runtime

    const route = () => {
      inGain.disconnect();
      const t = patch.modules.get(target);
      if (t?.inst.input) inGain.connect(t.inst.input);
    };
    patch.listeners.add(route);
    route();

    // round robin needs a note-only entry point: a MIDI module without audio input
    const midiTarget = () => {
      const t = patch.modules.get(target);
      return !!t && t.def.acceptsMidi && !t.def.hasInput;
    };
    const wanted = () => (midiTarget() ? instances : 1);

    // ---- hidden copies (instances 2..N), rebuilt on structure changes, values mirrored ----
    const clones = []; // { rt, sig }
    let destroyed = false;
    let pending = false;
    let syncing = null;
    const runtimes = () => [patch, ...clones.map((c) => c.rt)];

    async function syncNow() {
      let rebuilt = false;
      while (pending && !destroyed) {
        pending = false;
        const n = wanted();
        while (clones.length > n - 1) { clones.pop().rt.destroy(); rebuilt = true; }
        const data = patch.toJSON();
        const sig = structure(data);
        for (let k = 0; k < n - 1 && !destroyed; k++) {
          const c = clones[k];
          if (c && c.sig === sig) { applyValues(c.rt, data); continue; }
          const rt = await host.createPatch(outGain, k + 1);
          await rt.load(data);
          if (destroyed || pending) { rt.destroy(); break; } // changed meanwhile: start over
          c?.rt.destroy();
          clones[k] = { rt, sig };
          rebuilt = true;
        }
      }
      syncing = null;
      // modulation of mapped controllers is routed to every instance: new copies need new routes
      if (rebuilt && !destroyed && maps.length) owner?.changed();
    }
    const sync = () => {
      pending = true;
      syncing ??= Promise.resolve().then(syncNow);
      return syncing;
    };
    patch.watchers.add(sync);

    // MIDI goes to every MIDI module inside (of one instance), except those fed by an inner MIDI
    // cable (they get the notes through their MULTIMIDI instead, so they are not played twice)
    // (MODMIDI note ids are unique, so every inner module can use the same id for its voice)
    const notes = new Map(); // note id -> { rt, insts, off }
    const midiOf = (rt) => [...rt.modules.values()].filter((e) => e.def.acceptsMidi && !rt.hasMidiInput(e.id)).map((e) => e.inst);
    let next = 0;
    const pickRuntime = () => {
      const all = runtimes().slice(0, wanted());
      if (all.length === 1) return all[0];
      const busy = new Set();
      for (const n of notes.values()) if (!n.off) busy.add(n.rt);
      let k = next % all.length;
      for (let i = 0; i < all.length; i++) {
        const j = (next + i) % all.length;
        if (!busy.has(all[j])) { k = j; break; }
      }
      next = k + 1;
      return all[k];
    };

    const apply = (id, v) => {
      if (id === 'inputModule') { target = v | 0; route(); sync(); }
      else if (id === 'instances') { instances = Math.max(1, Math.min(MAX_INSTANCES, v | 0)); sync(); }
    };

    // ---- mapped controllers ----
    const mapOf = (key) => maps.find((m) => m.key === key);
    const innerParam = (m) => {
      const t = patch.modules.get(m.module);
      const p = t && paramsOf(t).find((q) => q.id === m.param);
      return p ? { t, p } : null;
    };
    // entry.values[key] always shows the inner controller's (saved) value
    const mirror = () => {
      if (!entry) return;
      for (const k of Object.keys(entry.values)) if (MAP_KEY.test(k) && !mapOf(k)) delete entry.values[k];
      for (const m of maps) {
        const t = patch.modules.get(m.module);
        if (t && m.param in t.values) entry.values[m.key] = t.values[m.param];
        else delete entry.values[m.key];
      }
    };
    const mappedParam = (m) => {
      const r = innerParam(m);
      if (!r) return null; // its module (or controller) is gone: listed as missing in the dialog
      const { t, p } = r;
      return {
        id: m.key,
        label: m.label || p.label,
        min: p.min,
        max: p.max,
        default: p.default ?? p.min,
        ...(p.step !== undefined ? { step: p.step } : {}),
        ...(p.scale ? { scale: p.scale } : {}),
        ...(p.options ? { options: p.options } : {}),
        format: (v) => (p.format ? p.format(v, t.values) : p.options ? p.options[v] : String(+(+v).toFixed(3))),
        map: m,
        routes: () => runtimes().flatMap((rt) => rt.routesTo(m.module, m.param)),
      };
    };
    // an LFO inside reported a value on a mapped controller: show it on ours if our parent drives it
    patch.forward = (tid, pid, v) => {
      let ok = false;
      for (const m of maps) if (m.module === tid && m.param === pid && owner?.modulated(entry, m.key, v)) ok = true;
      return ok;
    };

    return {
      node: outGain,
      input: inGain,
      patch,
      get clones() { return clones.map((c) => c.rt); },
      sync,
      // slider range follows the highest module id inside; mapped controllers follow
      params: () => [
        { ...def.params[0], max: Math.max(...patch.modules.keys()) },
        { ...def.params[1], format: (v) => (v <= 1 ? '1' : midiTarget() ? `${v} · round robin` : `${v} · off (Input Module is not a MIDI module)`) },
        ...maps.map(mappedParam).filter(Boolean),
      ],
      ctl: outGain, // receives modulation of Input Module / Instances (applied by onModulated)
      attach(e, rt) {
        entry = e;
        owner = rt;
        mirror();
      },
      mirror,
      setState(st) {
        const next = normalizeMaps(st).maps;
        // a removed mapping gives the inner controller its own value back (if it was driven)
        for (const m of maps) {
          if (next.some((x) => x.module === m.module && x.param === m.param)) continue;
          runtimes().forEach((rt) => rt.override(m.module, m.param, null));
        }
        maps = next;
        mirror();
      },
      setParam(id, v) {
        const m = mapOf(id);
        if (m) {
          if (innerParam(m) && patch.modules.get(m.module).values[m.param] !== v) patch.setParam(m.module, m.param, v);
          return;
        }
        if (MAP_KEY.test(id)) return; // a mapping that was just removed
        apply(id, v);
        outGain.param(id, v);
      },
      // automation / release of a mapped controller: drive the inner one (every instance), unsaved
      liveParam(id, v) {
        const m = mapOf(id);
        if (!m) return MAP_KEY.test(id);
        runtimes().forEach((rt) => rt.override(m.module, m.param, v));
        return true;
      },
      onModulated: (id, v) => apply(id, v),
      // a note's mod/off go to the modules that got its noteOn, even if cables changed since
      // (released notes stay known for a while, so drift still reaches their release tail)
      noteOn(id, pitch, vel) {
        const now = Date.now();
        for (const [k, n] of notes) if ((n.off && now - n.off > RELEASE_KEEP_MS) || n.rt.dead) notes.delete(k);
        const rt = pickRuntime();
        const insts = midiOf(rt);
        insts.forEach((i) => i.noteOn(id, pitch, vel));
        notes.set(id, { rt, insts, off: 0 });
      },
      noteMod(id, pitch, vel) {
        const n = notes.get(id);
        if (n && !n.rt.dead) n.insts.forEach((i) => i.noteMod(id, pitch, vel));
      },
      noteOff(id) {
        const n = notes.get(id);
        if (!n || n.off) return;
        n.off = Date.now();
        if (!n.rt.dead) n.insts.forEach((i) => i.noteOff(id));
      },
      allOff() {
        notes.clear();
        runtimes().forEach((rt) => midiOf(rt).forEach((i) => i.allOff()));
      },
      destroy() {
        destroyed = true;
        clones.splice(0).forEach((c) => c.rt.destroy());
        patch.destroy();
        inGain.destroy();
        outGain.destroy();
      },
    };
  },
};
