// System module: the single Output of every patch. Always id 0, cannot be deleted or inserted.
// Global Transpose / Cents Offset shift every note entering that patch level while it is the current
// one (see PatchRuntime.pitchOffset); they are not DSP controllers (dsp: false).
// Inside a Patch, MIDI and control cables into it pass out through the Patch module (see
// passesMod in src/patch.js).
// Its state holds free text: the song name, the creator's name and comments / notes about the song
// (or patch), edited in its panel and saved with the project.
export const MAX_COMMENT = 20000;
export const MAX_NAME = 200; // song name and creator
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
export const normalizeComment = (state) => ({
  songName: text(state?.songName, MAX_NAME),
  creator: text(state?.creator, MAX_NAME),
  comment: text(state?.comment, MAX_COMMENT),
});

export default {
  type: 'OUT',
  label: 'Output',
  system: true,
  isOutput: true,
  hasInput: true,
  hasOutput: false,
  acceptsMidi: false,
  params: [
    // tempo of this patch level; LFO, DELAY and ECHO sync to it
    { id: 'bpm', label: 'BPM', min: 20, max: 1000, default: 120, step: 1, wheelStep: 1 }, // 1 BPM per wheel click
    // per level: shift every note entering this level while it is the current one, see PatchRuntime.pitchOffset
    { id: 'transpose', dsp: false, label: 'Global Transpose', min: -48, max: 48, default: 0, step: 1, wheelStep: 1, format: (v) => `${v > 0 ? '+' : ''}${v} st` },
    { id: 'cents', dsp: false, label: 'Global Cents Offset', min: -100, max: 100, default: 0, step: 1, wheelStep: 1, format: (v) => `${v > 0 ? '+' : ''}${v} ct` },
    { id: 'volume', label: 'Master volume', min: 0, max: 1, default: 0.8, step: 0.01 },
  ],
  defaultState: () => ({ songName: '', creator: '', comment: '' }),
  normalizeState: normalizeComment,
  // panel (below the controllers): Song/Patch Name, Creator and a Comments box, saved as you type
  view(entry, api) {
    const el = document.createElement('div');
    const field = (label, input) => {
      const row = document.createElement('label');
      row.className = 'out-comment';
      const title = document.createElement('span');
      title.textContent = label;
      // the app's key shortcuts skip text fields; Escape leaves the field (instead of going up a patch level)
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        input.blur();
      });
      row.append(title, input);
      el.append(row);
    };
    const line = (key, placeholder) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = MAX_NAME;
      input.spellcheck = false;
      input.placeholder = placeholder;
      input.value = entry.state?.[key] ?? '';
      return input;
    };
    const songName = line('songName', 'Title of the song/patch');
    const creator = line('creator', 'Your name');
    const text = document.createElement('textarea');
    text.rows = 8;
    text.maxLength = MAX_COMMENT;
    text.spellcheck = true;
    text.placeholder = 'Notes about the song/patch: ideas, structure, credits…';
    text.value = entry.state?.comment ?? '';
    const save = () => api.setState({ songName: songName.value, creator: creator.value, comment: text.value });
    for (const input of [songName, creator, text]) input.addEventListener('input', save);
    field('Song/Patch Name', songName);
    field('Creator', creator);
    field('Comments', text);
    const facts = document.createElement('section');
    facts.className = 'out-facts';
    const heading = document.createElement('h3');
    heading.textContent = 'Song facts';
    const list = document.createElement('dl');
    const values = new Map();
    for (const label of ['Song Length', 'Notes in project', 'Measures in project', 'Average frequency', 'Top 5 pitches']) {
      const name = document.createElement('dt');
      name.textContent = label;
      const value = document.createElement('dd');
      values.set(label, value);
      list.append(name, value);
    }
    facts.append(heading, list);
    el.append(facts);
    const refresh = () => {
      if (!api.songFacts) return;
      const data = api.songFacts();
      values.get('Song Length').textContent = data.duration;
      values.get('Notes in project').textContent = String(data.notes);
      values.get('Measures in project').textContent = String(data.measures);
      values.get('Average frequency').textContent = data.averageFrequency === null ? '—' : `${data.averageFrequency.toFixed(2)} Hz`;
      values.get('Top 5 pitches').textContent = data.topPitches.map(({ label, count }) => `${label}: ${count}`).join('\n') || '—';
    };
    refresh();
    return { el, refresh };
  },
  create(_ctx, def, host) {
    const input = host.dsp.create('out'); // DSP: out.dsp.js (sum × Master volume)
    const noDsp = new Set(def.params.filter((p) => p.dsp === false).map((p) => p.id));
    let rt = null; // the patch this Output belongs to
    // notes cabled into the Output inside a Patch go out through the Patch module (rt.outer)
    const pass = (fn) => (...args) => rt?.outer?.[fn](...args);
    return {
      input,
      node: null,
      attach: (_entry, runtime) => { rt = runtime; },
      noteOn: pass('noteOn'),
      noteMod: pass('noteMod'),
      noteOff: pass('noteOff'),
      allOff: pass('allOff'),
      setParam: (id, v) => { if (!noDsp.has(id)) input.param(id, v); },
      destroy: () => input.destroy(),
    };
  },
};
