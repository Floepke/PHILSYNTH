// TUNING: a MIDI processor that retunes notes through a pitch map: the tuned (float) pitch of
// every MIDI key 0..127, edited per key in its panel (the key map editor of PITCH2CTL, see
// pitch2ctlview.js). A Scala scale (src/scala.js) fills the map: picked from the PHILSYNTH library
// or opened from a file it is applied at once; typed / pasted in the text box it is applied with
// Apply to editor (so manual edits are not lost by typing). Module state, saved with the project:
// { map, text (the box), name (of the scale last applied), edited (the map was changed by hand) }.
// There are no controllers. Notes arrive when it is selected and the MIDI keyboard is played,
// from a clip sent to it, or through a MIDI cable; the retuned notes go out through its MIDI
// cables (Shift+drag) to OSC / SAMPLER / Patch / MIDI modules. Micropitch away from the key is
// kept on top of the key's pitch. Sounding notes follow a new map.
import { createMidiScheduler } from '../midischedule.js';
import { parseScala, TWELVE_TET, ROOT_KEY, scaleMap, equalMap, normalizePitchMap, mapPitch, roundPitch, PITCH_MAX } from '../scala.js';
import { LIBRARY, libraryGroups } from '../scalalib.js';
import { openTextFile } from '../filedialog.js';
import { errorText } from '../filepicker.js';
import { createKeyMapView, keyLabel } from './pitch2ctlview.js';

export const MAX_SCALA = 256 * 1024;
// projects from before the map have only the scale text: its map is the scale applied
export const normalizeTuning = (state) => {
  const text = typeof state?.text === 'string' ? state.text.slice(0, MAX_SCALA) : TWELVE_TET;
  return {
    text,
    name: typeof state?.name === 'string' ? state.name.slice(0, 200) : '',
    map: normalizePitchMap(state?.map) ?? scaleMap(parseScala(text)),
    edited: state?.edited === true,
  };
};

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const fmt = (c) => (Math.abs(c - Math.round(c)) < 0.05 ? String(Math.round(c)) : c.toFixed(1));
const trim = (v, digits) => String(Number(v.toFixed(digits)));
const signed = (v, digits) => (v > 0 ? '+' : v < 0 ? '−' : '±') + trim(Math.abs(v), digits);
// cents of key k away from its equal-tempered pitch
const centsOff = (map, k) => (map[k] - k) * 100;

// one line about the parsed scale (or the error) for the panel
export function describeScale(scale) {
  if (!scale.ok) return scale.error;
  const period = Math.abs(scale.period - 1200) < 1e-6 ? 'octave' : `period ${fmt(scale.period)} ct`;
  const name = scale.description ? `${scale.description} — ` : '';
  return `${name}${scale.count} notes per ${period}; ${NAMES[ROOT_KEY % 12]}${ROOT_KEY / 12 - 1} = degree 0`;
}

// the editor's vertical range. Pitch: the visible keys' pitches (all keys: 0 … 128); Cents: ± the
// largest deviation of any key from equal temperament, with room to draw further (a step of
// CENTS_STEPS, then whole octaves)
export function pitchRange(map, first, last) {
  let lo = first;
  let hi = last + 1;
  for (let k = first; k <= last; k++) { lo = Math.min(lo, map[k]); hi = Math.max(hi, map[k]); }
  return { lo: Math.max(0, Math.floor(lo)), hi: Math.min(PITCH_MAX, Math.ceil(hi)) };
}
const CENTS_STEPS = [10, 25, 50, 100, 200, 500, 1200];
export function centsRange(map) {
  let most = 0;
  for (let k = 0; k < map.length; k++) most = Math.max(most, Math.abs(centsOff(map, k)));
  const want = most * 1.25;
  const r = CENTS_STEPS.find((c) => c >= want) ?? Math.ceil(want / 1200) * 1200;
  return { lo: -r, hi: r };
}
const gridLines = ({ lo, hi }, step) => {
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
};

let centsView = false; // the editor shows cents away from equal temperament instead of pitch

export default {
  type: 'TUNING',
  color: '#7fa7d9',
  label: 'Tuning (Scala scale)',
  acceptsMidi: true,
  midiOut: true,
  hasInput: false,
  hasOutput: true,
  params: [],
  defaultState: () => ({ text: TWELVE_TET, name: '12-TET.scl', map: equalMap(), edited: false }),
  normalizeState: normalizeTuning,
  view(entry, api) {
    const color = api.color ?? '#7fa7d9';
    const el = document.createElement('div');
    el.className = 'sample-view tuning-view';
    const st = () => entry.state;
    const save = (patch) => api.setState({ ...st(), ...patch });

    // ---- the pitch map editor ----
    const title = document.createElement('div');
    title.className = 'sample-info tuning-title';
    const showTitle = () => {
      const { name, edited } = st();
      title.textContent = `Tuning: ${name || 'untitled'}${edited ? ' (edited)' : ''}`;
    };
    const editor = createKeyMapView({
      color,
      getMap: () => st().map,
      playing: () => entry.inst?.playing ?? null,
      beginEdit: api.beginEdit,
      endEdit: api.endEdit,
      save: (map) => { save({ map, edited: true }); showTitle(); showKey(); },
      range: (map, first, last) => (centsView ? centsRange(map) : pitchRange(map, first, last)),
      shown: (p, v) => (centsView ? (v - p) * 100 : v),
      stored: (p, v) => roundPitch(centsView ? p + v / 100 : v),
      base: (r) => (centsView ? 0 : r.lo),
      grid: (r) => (centsView ? gridLines(r, r.hi / 5) : gridLines(r, r.hi - r.lo > 36 ? 12 : 1)),
      format: (p, v) => `${trim(v, 6)} (${signed((v - p) * 100, 4)} ct)`,
      valueAt: mapPitch,
      reference: (p) => (centsView ? 0 : p),
      buttons: [{ text: 'Reset', title: 'Back to 12-tone equal temperament: every key at its own pitch', action: () => equalMap() }],
      pickFirst: true,
      onPick: () => showKey(),
      hint: 'Click a key to type its pitch · drag to draw · Shift+drag: straight line',
      ariaLabel: 'Tuning: the output pitch of every MIDI key',
    });
    const centsButton = document.createElement('button');
    centsButton.type = 'button';
    centsButton.className = 'tuning-cents';
    centsButton.textContent = 'Cents';
    centsButton.title = 'Show the cents of every key away from equal temperament instead of its pitch';
    const showMode = () => centsButton.setAttribute('aria-pressed', String(centsView));
    centsButton.onclick = () => { centsView = !centsView; showMode(); editor.redraw(); };
    editor.tools.append(centsButton);
    showMode();

    // the picked key's exact pitch / cents, typed
    const keyRow = document.createElement('div');
    keyRow.className = 'tuning-key';
    const keyName = document.createElement('span');
    keyName.className = 'tuning-key-name';
    const field = (labelText, title) => {
      const label = document.createElement('label');
      label.textContent = labelText;
      const input = Object.assign(document.createElement('input'), { type: 'number', step: 'any', title });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); showKey(); input.blur(); }
        if (e.key === 'Enter') input.blur();
      });
      label.append(input);
      keyRow.append(label);
      return input;
    };
    keyRow.append(keyName);
    const pitchInput = field('Pitch', 'The pitch this key plays, in MIDI semitones (60 = C4, 60.5 = C4 + 50 cents)');
    const centsInput = field('Cents', 'Cents away from the key\'s equal-tempered pitch');
    const key = () => editor.picked() ?? ROOT_KEY;
    function showKey() {
      const k = key();
      const m = st().map;
      keyName.textContent = keyLabel(k);
      if (document.activeElement !== pitchInput) pitchInput.value = trim(m[k], 10);
      if (document.activeElement !== centsInput) centsInput.value = trim(centsOff(m, k), 8);
    }
    const typed = (toPitch) => function () {
      const v = Number(this.value);
      const k = key();
      if (this.value.trim() === '' || !Number.isFinite(v)) { showKey(); return; }
      const map = st().map.slice();
      map[k] = roundPitch(toPitch(v, k));
      if (map[k] === st().map[k]) { showKey(); return; }
      api.beginEdit?.();
      save({ map, edited: true });
      api.endEdit?.();
      editor.refresh();
      showTitle();
      showKey();
    };
    pitchInput.addEventListener('change', typed((v) => v));
    centsInput.addEventListener('change', typed((v, k) => k + v / 100));

    // ---- Scala: file, library, text box ----
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sample-load';
    button.textContent = 'Load Tuning';
    button.title = 'Open a Scala (.scl) file: it goes into the text box and into the editor';
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
    text.placeholder = 'Paste a Scala (.scl) file here, then Apply to editor…';
    text.value = st().text ?? '';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'sample-load tuning-apply';
    apply.textContent = 'Apply to editor';
    apply.title = 'Tune every key in the editor to the scale in the text box (replaces the edits; undo brings them back)';
    const show = () => {
      const scale = parseScala(text.value);
      info.textContent = `Text box: ${describeScale(scale)}`;
      info.classList.toggle('error', !scale.ok);
      apply.disabled = !scale.ok;
    };
    text.addEventListener('input', () => {
      save({ text: text.value });
      show();
    });
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      text.blur();
    });
    // the scale in the text box -> the editor (one undo step)
    const applyText = (newName) => {
      const scale = parseScala(text.value);
      if (!scale.ok) return;
      api.beginEdit?.();
      save({ text: text.value, map: scaleMap(scale), name: newName || scale.description || 'Scala scale', edited: false });
      api.endEdit?.();
      editor.refresh();
      showTitle();
      showKey();
    };
    apply.addEventListener('click', () => applyText(''));
    // a file or a library scale: into the text box and straight into the editor
    const load = (newText, newName) => {
      text.value = newText;
      show();
      if (parseScala(newText).ok) applyText(newName);
      else save({ text: newText });
    };
    // desktop app: the app's own file dialog; browsers: their file chooser
    button.addEventListener('click', async () => {
      if (!window.modsynthFiles?.openFile) { input.click(); return; }
      try {
        const f = await openTextFile('scala');
        if (f) load(f.text, f.name);
      } catch (err) {
        info.textContent = errorText(err);
        info.classList.add('error');
      }
    });
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
        it.addEventListener('click', () => { load(sc.text, sc.name); toggleLib(false); });
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
    el.append(title, editor.el, keyRow, button, input, libButton, lib, text, info, apply);
    showTitle();
    showKey();
    show();
    return {
      el,
      refresh: () => { editor.refresh(); showTitle(); showKey(); },
    };
  },
  create(ctx, _def, host) {
    const ctl = host.dsp.create('none');
    const midi = createMidiScheduler(ctx, host.dsp, () => inst.getMidiTargets());
    let map = equalMap();
    const held = new Map(); // incoming id -> { pitch, vel } of sounding notes, retuned on a new map
    const inst = {
      node: null, input: null, ctl,
      playing: null, // { id, pitch } (incoming) of the newest sounding note: marked in the editor
      get map() { return map; },
      get hasPendingMidi() { return midi.hasPending; },
      getMidiTargets: () => [],
      setParam() {},
      setState(state) {
        map = normalizeTuning(state).map;
        for (const [id, n] of held) midi.noteMod(id, mapPitch(map, n.pitch), n.vel);
      },
      noteOn(id, pitch, vel, phase = 0, time) {
        held.set(id, { pitch, vel });
        inst.playing = { id, pitch };
        midi.noteOn(id, mapPitch(map, pitch), vel, phase, 0, time);
      },
      noteMod(id, pitch, vel) {
        const n = held.get(id);
        if (n) { n.pitch = pitch; n.vel = vel; }
        if (inst.playing?.id === id) inst.playing = { id, pitch };
        midi.noteMod(id, mapPitch(map, pitch), vel);
      },
      noteOff(id) {
        held.delete(id);
        if (inst.playing?.id === id) inst.playing = null;
        midi.noteOff(id);
      },
      allOff() { held.clear(); inst.playing = null; midi.allOff(); },
      releaseTarget: midi.releaseTarget,
      destroy() { held.clear(); midi.destroy(); ctl.destroy(); },
    };
    return inst;
  },
};
