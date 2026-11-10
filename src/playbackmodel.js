// Control-side copies bind to the existing DSP handles; audio and sample data stay in Graph.
const noteKeys = new WeakMap();
let nextNoteKey = 0;
export function playbackSong(song) {
  return {
    ...song,
    clips: song.clips.map((clip) => ({
      ...clip,
      notes: clip.notes.map((note) => {
        if (!noteKeys.has(note)) noteKeys.set(note, ++nextNoteKey);
        return { ...note, playbackKey: noteKeys.get(note) };
      }),
    })),
  };
}

export async function preparePlayback(patch) {
  for (const { inst } of patch.modules.values()) {
    if (!inst.patch) continue;
    await inst.sync();
    for (const rt of [inst.patch, ...inst.clones]) await preparePlayback(rt);
  }
}

export function playbackModel(root) {
  const bindings = [];
  const patch = root.toJSON();
  const walk = (rt, data, edited = true) => {
    if (edited && rt._song) data.song = playbackSong(rt.song);
    bindings.push({
      sink: rt.sink.h, salt: rt.salt,
      modules: [...rt.modules.values()].map((e) => ({ id: e.id, type: e.def.type, nodes: e.nodes })),
      cables: rt.cables.map((c) => ({ ...c })),
    });
    for (const { id, inst } of rt.modules.values()) if (inst.patch) {
      const nested = data.modules.find((m) => m.id === id).patch;
      walk(inst.patch, nested, edited);
      inst.clones.forEach((clone) => walk(clone, nested, false));
    }
  };
  walk(root, patch);
  return { patch, bindings };
}
