import { PatchRuntime } from './patch.js';
import { getModule } from './modules/index.js';
import { MODULE_FORMAT, isFormat } from './fileformat.js';
import { importSamples } from './samples.js';

export function parseSynthFile(text) {
  const data = JSON.parse(text);
  if (!isFormat(data?.format, MODULE_FORMAT) || !Array.isArray(data.modules)) throw new Error('not a PHILSYNTH module file');
  const known = data.modules.filter((m) => getModule(m.type) && !getModule(m.type).isOutput);
  if (!known.length) throw new Error('no module types this version knows');
  return data;
}

// An isolated patch on the existing audio engine: no project watchers, history, microphones,
// or project Output effects. Keep its sink disconnected until the selected file is ready.
export function createModulePreview(engine, readFile) {
  let version = 0;
  let active = null;
  const forward = (method, args) => {
    for (const e of active?.targets ?? []) e.inst[method]?.(...args);
  };
  const target = {
    def: { acceptsMidi: true },
    inst: {
      noteOn: (...args) => forward('noteOn', args),
      noteMod: (...args) => forward('noteMod', args),
      noteOff: (...args) => forward('noteOff', args),
      allOff: (...args) => forward('allOff', args),
    },
  };
  const dispose = ({ patch, sink }) => {
    sink.destroy();
    patch.destroy();
  };

  async function select(entry) {
    const mine = ++version;
    if (active) {
      const previous = active;
      active = null;
      dispose(previous);
    }
    if (!entry) return;
    const file = await readFile(entry.path);
    if (mine !== version) return;
    const data = parseSynthFile(file.text);
    importSamples(data.samples);
    const sink = engine.dsp.create('bus');
    const patch = new PatchRuntime({ ctx: engine.ctx, dsp: engine.dsp, mics: null }, sink);
    try {
      await patch.addModule('OUT', { id: 0 });
      if (mine !== version) return;
      const added = await patch.pasteMany(data);
      if (mine !== version) return;
      const output = patch.modules.get(0);
      const audioEdges = patch.cables.filter((c) => patch.signals(patch.modules.get(c.from), patch.modules.get(c.to)).audio);
      for (const e of added) {
        if (patch.signals(e, output).audio && !audioEdges.some((c) => c.from === e.id)) patch.connect(e.id, 0);
      }
      const targets = added.filter((e) => e.def.acceptsMidi && e.def.liveMidi !== false
        && !patch.cables.some((c) => c.to === e.id && patch.signals(patch.modules.get(c.from), e).midi));
      sink.connect(engine.dsp.destination);
      engine.resume();
      active = { patch, sink, targets };
    } finally {
      if (active?.patch !== patch) dispose({ patch, sink });
    }
  }

  return { target, select, stop: () => select(null) };
}
