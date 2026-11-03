// TUNING: a MIDI processor that retunes notes to a Scala scale (see src/scala.js). The scale is
// module state (the .scl text, saved with the project), typed / pasted in its panel or loaded from
// a file; there are no controllers. Notes arrive when it is selected and the MIDI keyboard is
// played, from a clip sent to it, or through a MIDI cable; the retuned notes go out through its
// MIDI cables (Shift+drag) to OSC / SAMPLER / Patch / MIDI modules. Key 60 (C4) is degree 0 at its
// equal-tempered pitch; micropitch away from the key is kept. Sounding notes follow a new scale.
import { createMidiScheduler } from '../midischedule.js';
import { parseScala, tunePitch, TWELVE_TET, ROOT_KEY } from '../scala.js';
import { LIBRARY, libraryGroups } from '../scalalib.js';

export const MAX_SCALA = 256 * 1024;
export const normalizeTuning = (state) => ({
  text: typeof state?.text === 'string' ? state.text.slice(0, MAX_SCALA) : TWELVE_TET,
  name: typeof state?.name === 'string' ? state.name.slice(0, 200) : '',
});

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const fmt = (c) => (Math.abs(c - Math.round(c)) < 0.05 ? String(Math.round(c)) : c.toFixed(1));

// one line about the parsed scale (or the error) for the panel
export function describeScale(scale) {
  if (!scale.ok) return `${scale.error} — notes pass untuned`;
  const period = Math.abs(scale.period - 1200) < 1e-6 ? 'octave' : `period ${fmt(scale.period)} ct`;
  const name = scale.description ? `${scale.description} — ` : '';
  return `${name}${scale.count} notes per ${period}; ${NAMES[ROOT_KEY % 12]}${ROOT_KEY / 12 - 1} = degree 0`;
}

export default {
  type: 'TUNING',
  color: '#7fa7d9',
  label: 'Tuning (Scala scale)',
  acceptsMidi: true,
  midiOut: true,
  hasInput: false,
  hasOutput: true,
  params: [],
  defaultState: () => ({ text: TWELVE_TET, name: '12-TET.scl' }),
  normalizeState: normalizeTuning,
  view(entry, api) {
    const el = document.createElement('div');
    el.className = 'sample-view tuning-view';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sample-load';
    button.textContent = 'Load Tuning';
    const input = Object.assign(document.createElement('input'), { type: 'file', hidden: true, accept: '.scl,.scala,.txt' });
    const libButton = document.createElement('button');
    libButton.type = 'button';
    libButton.className = 'sample-load tuning-lib-button';
    libButton.textContent = 'Load Tuning from PHILSYNTH Library';
    libButton.setAttribute('aria-expanded', 'false');
    const lib = document.createElement('div');
    lib.className = 'tuning-lib';
    lib.setAttribute('role', 'listbox');
    lib.setAttribute('aria-label', 'PHILSYNTH tuning library');
    lib.tabIndex = -1;
    lib.hidden = true;
    const info = document.createElement('div');
    info.className = 'sample-info';
    const text = document.createElement('textarea');
    text.className = 'tuning-text';
    text.rows = 16;
    text.maxLength = MAX_SCALA;
    text.spellcheck = false;
    text.placeholder = 'Paste a Scala (.scl) file here…';
    text.value = entry.state?.text ?? '';
    let name = entry.state?.name ?? '';
    const show = () => {
      const scale = parseScala(text.value);
      info.textContent = (name ? `${name}: ` : '') + describeScale(scale);
      info.classList.toggle('error', !scale.ok);
    };
    text.addEventListener('input', () => {
      name = '';
      api.setState({ text: text.value, name });
      show();
    });
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      text.blur();
    });
    button.addEventListener('click', () => input.click());
    const load = (newText, newName) => {
      text.value = newText;
      name = newName;
      api.beginEdit?.();
      api.setState({ text: text.value, name });
      api.endEdit?.();
      show();
    };
    const items = [];
    for (const group of libraryGroups()) {
      const h = document.createElement('div');
      h.className = 'tuning-lib-group';
      h.textContent = group;
      lib.append(h);
      for (const sc of LIBRARY.filter((x) => x.group === group)) {
        const it = document.createElement('div');
        it.className = 'tuning-lib-item';
        it.setAttribute('role', 'option');
        it.textContent = sc.name;
        it.title = parseScala(sc.text).description;
        it.addEventListener('click', () => { load(sc.text, sc.file); toggleLib(false); });
        items.push({ it, sc });
        lib.append(it);
      }
    }
    const toggleLib = (open = lib.hidden) => {
      lib.hidden = !open;
      libButton.setAttribute('aria-expanded', String(open));
      if (!open) return;
      // mark the scale that is loaded now
      let current = null;
      for (const { it, sc } of items) {
        const on = sc.text === text.value;
        it.setAttribute('aria-selected', String(on));
        if (on) current = it;
      }
      lib.focus();
      current?.scrollIntoView({ block: 'nearest' });
    };
    libButton.addEventListener('click', () => toggleLib());
    lib.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      toggleLib(false);
      libButton.focus();
    });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      if (file.size > MAX_SCALA) { info.textContent = `${file.name}: file too large`; info.classList.add('error'); return; }
      load(await file.text(), file.name);
    });
    el.append(button, input, libButton, lib, info, text);
    show();
    return { el };
  },
  create(ctx, _def, host) {
    const ctl = host.dsp.create('none');
    const midi = createMidiScheduler(ctx, host.dsp, () => inst.getMidiTargets());
    let scale = parseScala(TWELVE_TET);
    const held = new Map(); // incoming id -> { pitch, vel } of sounding notes, retuned on a new scale
    const inst = {
      node: null, input: null, ctl,
      get scale() { return scale; },
      get hasPendingMidi() { return midi.hasPending; },
      getMidiTargets: () => [],
      setParam() {},
      setState(state) {
        scale = parseScala(state?.text);
        for (const [id, n] of held) midi.noteMod(id, tunePitch(scale, n.pitch), n.vel);
      },
      noteOn(id, pitch, vel, phase = 0, time) {
        held.set(id, { pitch, vel });
        midi.noteOn(id, tunePitch(scale, pitch), vel, phase, 0, time);
      },
      noteMod(id, pitch, vel) {
        const n = held.get(id);
        if (n) { n.pitch = pitch; n.vel = vel; }
        midi.noteMod(id, tunePitch(scale, pitch), vel);
      },
      noteOff(id) { held.delete(id); midi.noteOff(id); },
      allOff() { held.clear(); midi.allOff(); },
      releaseTarget: midi.releaseTarget,
      destroy() { held.clear(); midi.destroy(); ctl.destroy(); },
    };
    return inst;
  },
};
