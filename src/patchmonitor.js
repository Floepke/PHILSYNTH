// Audition the deepest uncabled Patch on the open path through the main Output.
export function createPatchMonitor(root) {
  const destination = root.modules.get(0).inst.input;
  const bus = root.engine.dsp.create('bus');
  let levels = [];
  let monitored = null;

  function refresh() {
    let node = null;
    for (let i = 1; i < levels.length; i++) {
      const owner = levels[i - 1].patch;
      const entry = owner.modules.get(levels[i].id);
      if (!entry || entry.dead || entry.inst.patch !== levels[i].patch) break;
      if (!owner.cables.some((c) => c.from === entry.id || c.to === entry.id)) node = entry.inst.node;
    }
    if (node === monitored) return;
    monitored?.disconnect(bus);
    monitored = node;
    if (monitored) {
      monitored.connect(bus);
      bus.connect(destination);
    } else {
      bus.disconnect(destination);
    }
  }

  return {
    setPath(path) {
      for (const level of levels.slice(0, -1)) level.patch.listeners.delete(refresh);
      levels = path.slice();
      for (const level of levels.slice(0, -1)) level.patch.listeners.add(refresh);
      refresh();
    },
  };
}
