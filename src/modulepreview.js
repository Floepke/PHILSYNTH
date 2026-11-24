import { PatchRuntime } from './patch.js';
import { getModule } from './modules/index.js';
import { MODULE_FORMAT, isFormat } from './fileformat.js';
import { importSamples } from './samples.js';
import { readModuleArchive } from './projectarchive.js';
import { isProjectZip, MAX_PROJECT_BYTES } from './projectzip.js';

function validateSynthFile(data) {
  if (!isFormat(data?.format, MODULE_FORMAT) || !Array.isArray(data.modules)) throw new Error('not a PHILSYNTH module file');
  const known = data.modules.filter((m) => getModule(m.type) && !getModule(m.type).isOutput);
  if (!known.length) throw new Error('no module types this version knows');
  return data;
}
export const parseSynthFile = (text) => validateSynthFile(JSON.parse(text));

export async function loadSynthFile(file, getAudioAssets) {
  let archive, error;
  try {
    if (file.blob) {
      const header = new Uint8Array(await file.blob.slice(0, 4).arrayBuffer());
      if (isProjectZip(header)) {
        archive = await readModuleArchive(file.blob, getAudioAssets);
        validateSynthFile(archive.data);
      } else {
        if (file.blob.size > MAX_PROJECT_BYTES) throw new Error('Module file is too large');
        archive = { data: parseSynthFile(await file.blob.text()), imported: [] };
      }
    } else archive = { data: parseSynthFile(file.text), imported: [] };
  } catch (cause) { error = cause; }
  try { await file.cleanup?.(); } catch (cause) {
    error = error ? new AggregateError([error, cause], 'Module load and cleanup failed') : cause;
  }
  const discard = async () => {
    const failures = [];
    for (const id of archive?.imported ?? []) {
      try { await getAudioAssets().discard(id); } catch (cause) { failures.push(cause); }
    }
    if (failures.length) throw new AggregateError(failures, 'Module audio cleanup failed');
  };
  if (error) {
    try { await discard(); } catch (cause) { throw new AggregateError([error, cause], 'Module load and cleanup failed'); }
    throw error;
  }
  return { data: archive.data, discard };
}

// An isolated patch on the existing audio engine: no project watchers, history, microphones,
// or project Output effects. Keep its sink disconnected until the selected file is ready.
export function createModulePreview(engine, readFile, getAudioAssets = null) {
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
  const dispose = async ({ patch, sink, discard }) => {
    sink.destroy();
    patch.destroy();
    await discard();
  };

  async function select(entry) {
    const mine = ++version;
    if (active) {
      const previous = active;
      active = null;
      await dispose(previous);
    }
    if (!entry || mine !== version) return;
    const file = await readFile(entry.path);
    if (mine !== version) { await file.cleanup?.(); return; }
    const { data, discard } = await loadSynthFile(file, getAudioAssets);
    if (mine !== version) { await discard(); return; }
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
      active = { patch, sink, targets, discard };
    } finally {
      if (active?.patch !== patch) await dispose({ patch, sink, discard });
    }
  }

  return { target, select, stop: () => select(null) };
}
