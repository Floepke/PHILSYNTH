// A Patch is a folder: it holds a whole project (with its own Output, module 0).
// Incoming audio is routed to the inner module selected by 'Input Module'.
// The inner Output module feeds this module's output.
//
// Instances (1..16): when > 1 and Input Module is a MIDI module without audio input (OSC,
// MULTIMIDI), the contents run that many times and incoming notes go round robin over the
// instances (a free instance first). Instance 1 is the one you edit; the others are hidden
// copies kept in sync with it. Every instance runs its own random generators (drift, Random
// LFO, ...) and seeded modules (REVERB) get a per-instance salt, so no two instances are alike.
const RELEASE_KEEP_MS = 10000;
const MAX_INSTANCES = 16;

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
  async create(_ctx, def, host) {
    // signal buses: in -> the Input Module inside; the inner Output (of every instance) -> out
    const inGain = host.dsp.create('bus');
    const outGain = host.dsp.create('bus');
    const patch = await host.createPatch(outGain);
    let target = 0;
    let instances = 1;

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
      while (pending && !destroyed) {
        pending = false;
        const n = wanted();
        while (clones.length > n - 1) clones.pop().rt.destroy();
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
        }
      }
      syncing = null;
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

    return {
      node: outGain,
      input: inGain,
      patch,
      get clones() { return clones.map((c) => c.rt); },
      sync,
      // slider range follows the highest module id inside
      params: () => [
        { ...def.params[0], max: Math.max(...patch.modules.keys()) },
        { ...def.params[1], format: (v) => (v <= 1 ? '1' : midiTarget() ? `${v} · round robin` : `${v} · off (Input Module is not a MIDI module)`) },
      ],
      ctl: outGain, // receives modulation of Input Module / Instances (applied by onModulated)
      setParam(id, v) {
        apply(id, v);
        outGain.param(id, v);
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
