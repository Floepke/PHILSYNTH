import { Engine } from './engine.js';
import { modules, getModule } from './modules/index.js';
import { initMidi, initKeyboard } from './midi.js';
import { registerMidiPreferences, migrateMidiInput, MIDI_INPUT_ID } from './midipreferences.js';
import { createPersistence, connectLiveReload } from './persist.js';
import { paramsOf, controllerAt, controllerNumber } from './params.js';
import { initCpuMeter } from './cpumeter.js';
import { createController } from './controller.js';
import { linePath, arrowPath, arrowPoints, centerOf, visibleSegment } from './cable.js';
import { colorOf, stockColor } from './modcolor.js';
import { openColorDialog } from './colordialog.js';
import { initWoodTheme, migrateWoodTint } from './woodtheme.js';
import { createPreferencesManager } from './preferences.js';
import { createPreferencesDialog } from './preferencesdialog.js';
import { registerInterfacePreferences } from './interfacepreferences.js';
import { registerTimelinePreferences } from './timelinepreferences.js';
import { registerPianorollPreferences } from './pianorollpreferences.js';
import { Transport } from './transport.js';
import { unsavedDialog } from './dialogs.js';
import { exitToOS } from './exit.js';
import { createSequencer } from './seq/index.js';
import { defaultCam, validCam, toWorld, toScreen, wheelCam, fitBox, clampCam, resizeCam } from './camera.js';
import { edgeScroll } from './seq/surface.js';
import { initWidgets } from './widgets.js';
import { emptySong, getClip, newSong, snapStep } from './song.js';
import { CableScope } from './cablescope.js';
import { MidiCableAnimation } from './midicable.js';
import { openMapDialog, patchControllersView } from './mapdialog.js';
import { defaultName, moduleName } from './modname.js';
import { MAX_NAME, runtimesAt, songLayers } from './patch.js';
import { showMenu, closeMenu, shortcut } from './seq/menu.js';
import { snapToGrid } from './grid.js';
import { createNoiseBackground } from './noisebg.js';
import { renderGuide } from './guide.js';
import { createHistory } from './history.js';
import { renderAudio, writeAudio } from './audioexport.js';
import { AUDIO_FORMATS, audioFormat } from './audioformat.js';
import { exportMidi } from './midiexport.js';
import { withSamples, importSamples } from './samples.js';
import { createProjectFile, pickBackend } from './projectfile.js';
import { initStatusTips } from './statustips.js';
import { saveTextFile, openTextFile } from './filedialog.js';
import { pickFile } from './filepicker.js';
import { createModulePreview, parseSynthFile } from './modulepreview.js';
import { PROJECT_FORMAT, MODULE_FORMAT, MODULE_EXT, jsonFileText } from './fileformat.js';
import { moduleDocs } from './moduledocs.js';
import { createPatchMonitor } from './patchmonitor.js';
import { songFacts } from './songfacts.js';
import { initMouseNavigation, MOUSE_FORWARD } from './mousebuttons.js';

const engine = new Engine();
let transport = null; // song playback (created after the engine)
let seq = null; // piano roll + TimeLine UI
let midi = null; // MIDI input, initialized after the project is restored
let modulePreview = null;
let undoHistory = null;
let scope = null; // live audio drawn on the cables (created after the engine)
let patchMonitor = null;
const $ = (id) => document.getElementById(id);
const preferencesManager = createPreferencesManager();
initWoodTheme(preferencesManager);
registerInterfacePreferences(preferencesManager);
const timelineDisplay = registerTimelinePreferences(preferencesManager, () => seq?.redrawTimeline());
const pianorollPreferences = registerPianorollPreferences(preferencesManager, () => seq?.redrawPianoroll());
registerMidiPreferences(preferencesManager, () => midi);
let preferencesLoadError = '';
try {
  await preferencesManager.load();
  await migrateWoodTint(preferencesManager);
  await migrateMidiInput(preferencesManager);
} catch (err) {
  console.error('Could not load preferences:', err);
  preferencesLoadError = `Could not load preferences: ${err.message}`;
  $('status').textContent = preferencesLoadError;
}
const openPreferences = createPreferencesDialog(preferencesManager, { loadError: preferencesLoadError });
const canvas = $('canvas');
const noiseBg = createNoiseBackground(canvas);
const svg = $('cables');
const world = $('world');
const panel = $('panel-content');
const panelScroller = $('panel');
const dialog = $('insert-dialog');
const moduleList = $('module-list');
const SVGNS = 'http://www.w3.org/2000/svg';

let path = []; // stack of { patch, name, id, cam }: the patch levels we have entered (id = Patch module number)
let sel = null; // { kind: 'module', entry } | { kind: 'group', entries } | { kind: 'cable', cable }
let panelScrolls = {};
let activePanelScrollKey = null;
const panelScrollKey = (entry) => JSON.stringify([...path.slice(1).map((level) => level.id), entry.id]);
const selectedEntries = () => (sel?.kind === 'module' ? [sel.entry] : sel?.kind === 'group' ? sel.entries : []);
// Selection from a list of modules: none, one (shows its controllers) or a group.
const selectEntries = (entries) => select(entries.length > 1 ? { kind: 'group', entries } : entries.length ? { kind: 'module', entry: entries[0] } : null);
// MIDI goes to the last selected MIDI-capable module. Selecting an audio-only module (Filter, Output),
// a cable or empty canvas never changes it. If that module is deleted, MIDI falls back to the
// previously used MIDI module that still exists.
// Modules with liveMidi: false (VELOCITY2CTL, PITCH2CTL) only get notes from clips and MIDI cables.
const takesLiveMidi = (def) => !!def?.acceptsMidi && def.liveMidi !== false;
// Every patch level (layer: the main patch, a Patch's inside) has its own MIDI module: the one
// followed there (view state) or the one locked there (MIDI badge, saved with that layer as
// PatchRuntime.midiLock). Live MIDI plays the shown layer's module, else the nearest one above.
const followed = new WeakMap(); // runtime -> modules selected there, most recent last
const midiEntry = (rt, id) => {
  const e = id === null || id === undefined ? null : rt.modules.get(id);
  return e && !e.dead && takesLiveMidi(e.def) ? e : null;
};
const lockedEntry = (rt) => midiEntry(rt, rt.midiLock);
function followedEntry(rt) {
  const h = followed.get(rt) ?? [];
  while (h.length && (h.at(-1).dead || rt.modules.get(h.at(-1).id) !== h.at(-1))) h.pop();
  return h.at(-1) ?? null;
}
const layerMidi = (rt) => lockedEntry(rt) ?? followedEntry(rt);
// New clips (double-click / Insert clip in the TimeLine) play the module selected in the patcher
// when it takes notes, else the one of its layer selected last that does and still exists (any
// module that takes MIDI, also when the MIDI badge locks live MIDI elsewhere).
let clipFollowed = new WeakMap(); // runtime -> module numbers selected there, most recent last (reset per project)
const playsClips = (rt, id) => !!rt.modules.get(id)?.def.acceptsMidi;
function followClips(entry) {
  const rt = current();
  if (!entry.def.acceptsMidi || rt.modules.get(entry.id) !== entry) return;
  clipFollowed.set(rt, [...(clipFollowed.get(rt) ?? []).filter((id) => id !== entry.id), entry.id]);
}
function clipTarget(rt) {
  const h = clipFollowed.get(rt) ?? [];
  while (h.length && !playsClips(rt, h.at(-1))) h.pop();
  return h.at(-1) ?? null;
}
const midiTarget = () => {
  for (let i = path.length - 1; i >= 0; i--) {
    const t = layerMidi(path[i].patch);
    if (t) return t;
  }
  return null;
};
function setMidiTarget(entry) {
  const rt = current();
  if (lockedEntry(rt) || followedEntry(rt) === entry) return;
  // no allOff on the old module: song notes and held keys play on (their note-offs still reach
  // the module that got the note-on, see midi.js)
  followed.set(rt, [...(followed.get(rt) ?? []).filter((e) => e !== entry && !e.dead), entry]);
  persist.schedule();
}
// the TimeLine shown: the main song or the open Patch's own one
const layerSong = (rt) => (rt === engine.root ? engine.song : rt.song);
// per-layer view state: followed MIDI module and selected clip of every layer
function layerView() {
  return songLayers(engine.root, engine.song).flatMap(({ path: p, rt, song }) => {
    const midi = followedEntry(rt)?.id ?? null;
    const clip = rt === engine.root ? null : song.selected;
    return midi === null && clip === null ? [] : [{ path: p, midi, clip }];
  });
}
function applyLayerView(list) {
  for (const v of Array.isArray(list) ? list : []) {
    const levels = patchAt(v?.path);
    if (levels.length !== (v.path?.length ?? 0) + 1) continue;
    const rt = levels.at(-1).patch;
    const e = midiEntry(rt, v.midi);
    if (e) followed.set(rt, [e]);
    if (rt !== engine.root && getClip(rt.song, v.clip)) rt.song.selected = v.clip;
  }
}
let dropPos = { x: 0, y: 0 };
const current = () => path[path.length - 1].patch;
const shown = () => path.at(-1)?.patch ?? engine.root; // current(), also before a project is open

// ---- camera (pan / zoom), one per patch level ----
const cam = () => (path[path.length - 1].cam ??= defaultCam());
let cameraWidth = canvas.clientWidth;
let cameraHeight = canvas.clientHeight;
new ResizeObserver(() => {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  // A collapsed pane retains its last visible size so restoring it preserves the centre.
  if (width <= 0 || height <= 0) return;
  if (path.length && cameraWidth > 0 && cameraHeight > 0 && (width !== cameraWidth || height !== cameraHeight)) {
    // Resizing is not a pan: clamping here would displace the centre near the pan limits.
    path[path.length - 1].cam = resizeCam(cam(), cameraWidth, cameraHeight, width, height);
    applyCam();
    persist.schedule();
  }
  cameraWidth = width;
  cameraHeight = height;
}).observe(canvas);
// client (pointer) coordinates -> world coordinates of the current patch
function clientToWorld(cx, cy) {
  const r = canvas.getBoundingClientRect();
  return toWorld(cam(), cx - r.left, cy - r.top);
}
function applyCam() {
  const { x, y, z } = cam();
  world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  noiseBg.draw({ x, y, z }); // the background noise lives in world space too
  $('zoom').textContent = `${Math.round(z * 100)}%`;
}
// World box around the modules of the current level that have a box on screen, or null.
function modulesBox() {
  let box = null;
  for (const m of current().modules.values()) {
    if (!m.el?.isConnected) continue;
    box ??= { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
    box.l = Math.min(box.l, m.x);
    box.t = Math.min(box.t, m.y);
    box.r = Math.max(box.r, m.x + m.el.offsetWidth);
    box.b = Math.max(box.b, m.y + m.el.offsetHeight);
  }
  return box;
}
// Panning and zooming stop just before the outermost modules would leave the view, so they can't get lost.
function setCam(c) {
  if (![c.x, c.y, c.z].every(Number.isFinite)) return; // a bad wheel event must not break the view
  path[path.length - 1].cam = clampCam(validCam(c), modulesBox(), canvas.clientWidth, canvas.clientHeight);
  applyCam();
  persist.schedule();
}
// Dragging (a module, a copy, a Shift cable sweep or a selection rectangle) near / past an edge of
// the patcher pans the view along, faster further out; onScroll re-applies the drag at the new view.
function patcherScroll(onScroll) {
  return edgeScroll({
    area: () => { const r = canvas.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; },
    scroll: (dx, dy) => { const c = cam(); setCam({ ...c, x: c.x - dx, y: c.y - dy }); },
    onScroll,
  });
}
function fitAll() {
  const box = modulesBox();
  if (!box) return setCam(defaultCam());
  setCam(fitBox(box, canvas.clientWidth, canvas.clientHeight));
}
$('zoom').onclick = fitAll;
$('zoom').addEventListener('pointerdown', (e) => e.stopPropagation());

// Wheel and pinch zoom around the pointer.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  setCam(wheelCam(cam(), e, e.clientX - r.left, e.clientY - r.top));
}, { passive: false });

// Any click in the patcher (or its controller panel) gives the patcher keyboard focus, so
// Backspace deletes modules/cables instead of reaching the piano roll / TimeLine that had focus.
canvas.tabIndex = -1;
const focusPatcher = (e) => {
  if (e.target.closest('input, select, textarea, button, dialog, [contenteditable]')) return;
  if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
};
canvas.addEventListener('pointerdown', focusPatcher, true);
$('panel').addEventListener('pointerdown', focusPatcher, true);

// Middle mouse button + drag: pan (works over modules and cables too).
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 1) return;
  e.preventDefault(); // no autoscroll / paste
  e.stopPropagation();
  const start = { ...cam() };
  const sx = e.clientX;
  const sy = e.clientY;
  canvas.classList.add('panning');
  const move = (ev) => setCam({ ...start, x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy });
  const up = (ev) => {
    if (ev.button !== undefined && ev.type === 'pointerup' && ev.button !== 1) return;
    canvas.classList.remove('panning');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}, true);
canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

// ---- persistence ----
// The project file (main menu: New / Open / Save / Save As). Unsaved = the project differs from
// what was last opened or saved; view and selection changes do not count.
const projectFile = createProjectFile({
  fingerprint() {
    const project = engine.saveProject();
    return { ...project, song: { ...project.song, selected: null } };
  },
  serialize: () => jsonFileText(withSamples({ ...engine.saveProject(), view: viewState() })),
  backend: pickBackend(window, $('file')),
  onChange: showDocument,
});
function showDocument({ name, ref, dirty }) {
  const el = $('doc-name');
  el.textContent = name;
  el.classList.toggle('dirty', dirty);
  const where = typeof ref === 'string' && !/^(fsa|download):/.test(ref) ? ref : name;
  el.title = dirty ? `${where} (unsaved changes)` : where;
  document.title = `${dirty ? '• ' : ''}${name} — PHILSYNTH`;
}
// Autosave: the latest state always comes back on start, with its file name and unsaved state.
const persist = createPersistence({
  getState: () => withSamples({ ...engine.saveProject(), view: viewState(), doc: projectFile.toJSON() }),
  onSaved: ({ local, disk, at }) => {
    if (!local && !disk) $('status').textContent = `Autosave failed! (${new Date(at).toLocaleTimeString()})`;
    showDocument(projectFile.info());
  },
});
function rememberPanelScroll() {
  if (!activePanelScrollKey) return;
  const top = panelScroller.scrollTop;
  if (panelScrolls[activePanelScrollKey] === top) return;
  panelScrolls[activePanelScrollKey] = top;
  persist.schedule();
}
panelScroller.addEventListener('scroll', rememberPanelScroll, { passive: true });
engine.onChange = () => {
  persist.schedule();
  undoHistory?.record();
  if (sel?.entry?.def.isOutput) panelRefresh?.();
};

function viewState() {
  return {
    path: path.slice(1).map((l) => l.id),
    cams: path.map((l) => l.cam ?? defaultCam()),
    cameraSize: { width: cameraWidth, height: cameraHeight },
    seq: seq?.viewState(),
    layers: layerView(),
    panelScrolls,
  };
}

function patchAt(ids) {
  let patch = engine.root;
  const levels = [{ patch, name: 'Main' }];
  for (const id of ids ?? []) {
    const inner = patch.modules.get(id)?.inst.patch;
    if (!inner) break;
    patch = inner;
    levels.push({ patch, name: `Patch #${id}`, id });
  }
  return levels;
}

function applyView(view) {
  path = patchAt(view?.path);
  activePanelScrollKey = null;
  panelScrolls = {};
  if (view?.panelScrolls && typeof view.panelScrolls === 'object' && !Array.isArray(view.panelScrolls)) {
    for (const [key, top] of Object.entries(view.panelScrolls)) {
      if (Number.isFinite(top) && top >= 0) panelScrolls[key] = top;
    }
  }
  path.forEach((l, i) => {
    if (view?.cams?.[i]) l.cam = validCam(view.cams[i]);
  });
  applyLayerView(view?.layers);
  if (view?.midi?.path) { // older saves: one MIDI module for the whole project, maybe locked
    applyLayerView([{ path: view.midi.path, midi: view.midi.id }]);
    const rt = patchAt(view.midi.path).at(-1).patch;
    if (view.midi.locked && rt.midiLock === null && followedEntry(rt)?.id === view.midi.id) rt.midiLock = view.midi.id;
  }
  seq?.applyView(view?.seq);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const size = view?.cameraSize;
  if (Number.isFinite(size?.width) && size.width > 0 && Number.isFinite(size?.height) && size.height > 0) {
    cameraWidth = size.width;
    cameraHeight = size.height;
    if (width > 0 && height > 0 && path.at(-1).cam) {
      path.at(-1).cam = resizeCam(cam(), cameraWidth, cameraHeight, width, height);
    }
  }
  if (width > 0 && height > 0) {
    cameraWidth = width;
    cameraHeight = height;
  }
  render();
}

async function openProject(data, view) {
  transport.stop();
  const load = () => persist.pause(() => engine.loadProject(data));
  clipFollowed = new WeakMap(); // module numbers of the old project mean other modules now
  if (undoHistory) await undoHistory.suspend(load);
  else await load();
  seq.reload();
  applyView(view);
  persist.schedule();
  undoHistory?.reset();
}

// insert dialog list: one row per module type (colour, type, description)
let insertType = modules[0]?.type ?? null;
const synths = modules.filter((m) => m.acceptsMidi && !m.midiOut && !m.modulator && m.type !== 'PATCH');
const synthSet = new Set(synths);
const effects = modules.filter((m) => !synthSet.has(m) && m.hasInput && m.hasOutput && !m.modulator && m.type !== 'PATCH');
const categorizedModules = new Set([...synths, ...effects]);
const moduleGroups = [
  ['Synths:', synths],
  ['Effects:', effects],
  ['Other:', modules.filter((m) => !categorizedModules.has(m))],
];
const listItems = [];
for (const [heading, group] of moduleGroups) {
  const label = document.createElement('div');
  label.className = 'listbox-heading';
  label.setAttribute('role', 'presentation');
  label.textContent = heading;
  moduleList.append(label);
  for (const m of group) {
    const li = document.createElement('div');
    li.className = 'listbox-item';
    li.setAttribute('role', 'option');
    li.id = `module-option-${m.type.replace(/\s+/g, '-')}`;
    li.dataset.type = m.type;
    li.style.setProperty('--c', m.color);
    li.innerHTML = '<span class="swatch"></span><b></b><span class="desc"></span>';
    li.querySelector('b').textContent = m.type;
    li.querySelector('.desc').textContent = m.label;
    moduleList.append(li);
    listItems.push(li);
  }
}
function chooseType(type) {
  insertType = type;
  for (const li of listItems) {
    const on = li.dataset.type === type;
    li.setAttribute('aria-selected', on);
    if (on) {
      moduleList.setAttribute('aria-activedescendant', li.id);
      li.scrollIntoView({ block: 'nearest' });
    }
  }
}
moduleList.addEventListener('click', (e) => {
  const li = e.target.closest('.listbox-item');
  if (li) chooseType(li.dataset.type);
});
moduleList.addEventListener('dblclick', (e) => {
  const li = e.target.closest('.listbox-item');
  if (!li) return;
  chooseType(li.dataset.type);
  dialog.close('ok');
});
moduleList.addEventListener('keydown', (e) => {
  const i = listItems.findIndex((li) => li.dataset.type === insertType);
  let j = null;
  if (e.key === 'ArrowDown') j = Math.min(listItems.length - 1, i + 1);
  else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = listItems.length - 1;
  else if (e.key === 'Enter') { e.preventDefault(); dialog.close('ok'); return; }
  else if (e.key.length === 1 && /\w/.test(e.key)) { // type a letter: next module starting with it
    const k = e.key.toLowerCase();
    const n = listItems.length;
    for (let d = 1; d <= n; d++) {
      const li = listItems[(i + d) % n];
      if (li.dataset.type.toLowerCase().startsWith(k)) { j = (i + d) % n; break; }
    }
  }
  if (j === null) return;
  e.preventDefault();
  chooseType(listItems[j].dataset.type);
});

// ---- insert dialog ----
canvas.addEventListener('dblclick', (e) => {
  if (e.target !== canvas) return;
  openInsertDialog(e.clientX, e.clientY);
});

function openInsertDialog(clientX, clientY) {
  const w = clientToWorld(clientX, clientY);
  dropPos = { x: Math.round(w.x), y: Math.round(w.y) };
  dialog.returnValue = '';
  chooseType(insertType); // the last inserted type stays selected
  dialog.showModal();
  moduleList.focus();
}

$('load-synth').onclick = () => {
  dialog.close('cancel');
  loadModuleFile(dropPos);
};

dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'ok') return;
  const patch = current();
  if (!insertType) return;
  const entry = await patch.addModule(insertType, dropPos);
  if (patch !== current()) return;
  render();
  select({ kind: 'module', entry });
});

// ---- rendering the current patch ----
function render() {
  patchMonitor.setPath(path);
  const fit = !path[path.length - 1].cam;
  world.querySelectorAll('.module').forEach((el) => el.remove());
  applyCam();
  for (const entry of current().modules.values()) createBox(entry);
  if (fit && canvas.clientWidth > 0 && canvas.clientHeight > 0) fitAll();
  else if (!fit && canvas.clientWidth > 0) { // a saved view with the modules out of sight comes back
    const c = cam();
    const k = clampCam(c, modulesBox(), canvas.clientWidth, canvas.clientHeight);
    if (k.x !== c.x || k.y !== c.y) setCam(k);
  }
  drawCables();
  renderCrumbs();
  seq?.setLayer(); // the TimeLine of this level
  select(null);
  persist.schedule(); // remember which patch level is open
}

function renderCrumbs() {
  const nav = $('crumbs');
  nav.replaceChildren();
  path.forEach((lvl, i) => {
    if (i) nav.append('/');
    const b = document.createElement('button');
    // a renamed Patch module shows its own name (looked up now, so renames show up right away)
    const entry = i ? path[i - 1].patch.modules.get(lvl.id) : null;
    b.textContent = entry?.name || lvl.name;
    const label = entry?.name ? `${entry.name} (${lvl.name})` : lvl.name;
    b.title = i === path.length - 1 ? `${label} — the patch level shown in the patcher` : `Go up to ${label}`;
    b.classList.toggle('current', i === path.length - 1);
    b.onclick = () => goUpPatch(i);
    nav.append(b);
  });
}

function goUpPatch(level = path.length - 2) {
  const exited = path[level + 1];
  path.length = level + 1;
  render();
  if (exited) {
    const entry = current().modules.get(exited.id);
    if (entry) select({ kind: 'module', entry });
  }
}

// Module colour (its custom colour, else its type's; see modcolor.js) as the --mod-color CSS
// variable; without one (the Output) it stays grey.
function setColor(el, color) {
  if (color) el.style.setProperty('--mod-color', color);
  else el.style.removeProperty('--mod-color');
}

function showName(entry, el = entry.el?.querySelector('.module-name')) {
  if (!el) return;
  el.textContent = entry.name ?? defaultName(entry.def);
  el.classList.toggle('custom', !!entry.name);
  el.title = entry.name ? `${entry.name} (${entry.def.label})` : '';
}

// Patch modules: open (panel button, Enter, double-click or right-click menu); Esc goes up again
function openPatch(entry) {
  if (!entry?.inst.patch) return;
  path.push({ patch: entry.inst.patch, name: `Patch #${entry.id}`, id: entry.id });
  render();
}

// Rename in place: an input over the module's name. Enter / leaving it keeps the name, Escape
// cancels; an empty name restores the default.
// F2 or the right-click menu start it.
function startRename(entry) {
  const label = entry.el?.querySelector('.module-name');
  if (!label || entry.el.querySelector('.module-rename')) return;
  const input = document.createElement('input');
  input.className = 'module-rename';
  input.value = entry.name ?? defaultName(entry.def);
  input.maxLength = MAX_NAME;
  input.placeholder = defaultName(entry.def);
  input.setAttribute('aria-label', `Name of module #${entry.id}`);
  label.hidden = true;
  label.after(input);
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const patch = current();
    if (keep && patch.modules.get(entry.id) === entry) {
      const value = input.value.trim();
      patch.rename(entry.id, value === defaultName(entry.def) ? '' : value);
    }
    input.remove();
    label.hidden = false;
    showName(entry);
    drawCables(); // the box width follows the name
    canvas.focus({ preventScroll: true });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing must not delete modules / go up a level
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  for (const t of ['pointerdown', 'dblclick']) input.addEventListener(t, (e) => e.stopPropagation()); // no drag, no new rename
  input.focus();
  input.select();
}

function createBox(entry) {
  const { def } = entry;
  const el = document.createElement('div');
  el.className = 'module' + (def.type === 'PATCH' ? ' patch' : '');
  el.dataset.id = entry.id;
  setColor(el, colorOf(entry));
  el.style.left = `${entry.x}px`;
  el.style.top = `${entry.y}px`;
  const name = document.createElement('span');
  name.className = 'module-name';
  showName(entry, name);
  const num = document.createElement('span');
  num.className = 'module-id';
  num.textContent = entry.id;
  el.append(name, num);
  if (takesLiveMidi(def)) {
    // shown only on the MIDI target (CSS); click toggles the lock
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'midi-badge';
    badge.textContent = 'MIDI';
    badge.addEventListener('pointerdown', (e) => e.stopPropagation()); // no drag / selection change
    badge.addEventListener('dblclick', (e) => e.stopPropagation()); // don't open a Patch
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const rt = current();
      if (layerMidi(rt) !== entry) return;
      const lock = !lockedEntry(rt);
      rt.midiLock = lock ? entry.id : null; // saved with this patch level (undoable)
      rt.changed();
      showMidiTarget();
      $('status').textContent = lock ? `MIDI locked to ${entry.name || def.type} on this patch level — click MIDI again to unlock.` : 'MIDI unlocked: on this patch level it follows the selected module again.';
    });
    el.append(badge);
  }
  entry.el = el;


  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // don't start a selection rectangle
    if (e.ctrlKey || e.metaKey) { // toggle this module in the selection
      e.preventDefault();
      const cur = selectedEntries();
      selectEntries(cur.includes(entry) ? cur.filter((x) => x !== entry) : [...cur, entry]);
      return;
    }
    if (e.shiftKey) { select({ kind: 'module', entry }); if (def.hasOutput) startCable(e, entry); return; }
    e.preventDefault(); // stop text selection / native drag from stealing the pointer
    // pressing a module that is part of the selection keeps the whole selection (move/duplicate all)
    const group = selectedEntries().includes(entry) ? selectedEntries() : [entry];
    if (group.length === 1) select({ kind: 'module', entry });
    if (e.altKey) {
      const copyable = group.filter((x) => !x.def.isOutput);
      if (!copyable.length) $('status').textContent = 'The Output module cannot be duplicated.';
      else startDuplicate(e, copyable, copyable.includes(entry) ? entry : copyable[0]);
      return;
    }
    const start = group.map((m) => ({ m, x: m.x, y: m.y }));
    const sx = e.clientX;
    const sy = e.clientY;
    // The grabbed module triggers cable toggles for the whole selection when it touches a target.
    // Modules it overlaps at the start count only after a separation.
    const patch = current();
    const others = () => [...patch.modules.values()].filter((m) => !group.includes(m) && m.el?.isConnected);
    const overlaps = (m) => {
      const a = boxOf(entry);
      const b = boxOf(m);
      return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    };
    const touching = new Set(others().filter(overlaps));
    let wired = false;
    undoHistory?.begin(); // the move and its cable toggles are one undo step
    // anchored in the world, so the modules stay under the pointer while the view pans along
    const w0 = clientToWorld(sx, sy);
    let last = null;
    const place = () => {
      if (!last) return;
      const w = clientToWorld(last.clientX, last.clientY);
      for (const { m, x, y } of start) {
        m.x = snapToGrid(x + w.x - w0.x, snapGrid);
        m.y = snapToGrid(y + w.y - w0.y, snapGrid);
        m.el.style.left = `${m.x}px`;
        m.el.style.top = `${m.y}px`;
      }
      for (const m of others()) {
        if (!overlaps(m)) touching.delete(m);
        else if (!touching.has(m)) {
          touching.add(m);
          for (const source of group) wired = toggleCable(patch, source, m.el) || wired;
        }
      }
      drawCables();
    };
    const auto = patcherScroll(place);
    let moved = false;
    const move = (ev) => {
      last = ev;
      moved ||= Math.hypot(ev.clientX - sx, ev.clientY - sy) >= 4;
      place();
      if (moved) auto.update({ x: ev.clientX, y: ev.clientY });
    };
    const up = () => {
      auto.stop();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      persist.schedule();
      undoHistory?.record();
      undoHistory?.end();
      if (wired && sel?.entry === entry) select(sel); // refresh the panel: e.g. an LFO's Out Controller names follow its cables
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  el.addEventListener('dblclick', (e) => {
    e.stopPropagation(); // no insert dialog
    if (entry.inst.patch) openPatch(entry);
  });
  world.appendChild(el);
}

// ---- Alt + drag: duplicate ----
let suppressAltUp = false;
// with Snap to Grid the grabbed module (anchor) lands on the grid; the others keep their offsets
function startDuplicate(e, entries, anchor = entries[0]) {
  const patch = current();
  const ghosts = entries.map((m) => {
    const g = m.el.cloneNode(true);
    g.classList.remove('selected', 'midi-target');
    g.classList.add('ghost');
    world.appendChild(g);
    return { m, g };
  });
  let dx = 0;
  let dy = 0;
  const w0 = clientToWorld(e.clientX, e.clientY);
  let last = null;
  let moved = false;
  const place = () => {
    if (!last) return;
    const w = clientToWorld(last.clientX, last.clientY);
    dx = snapToGrid(anchor.x + w.x - w0.x, snapGrid) - anchor.x;
    dy = snapToGrid(anchor.y + w.y - w0.y, snapGrid) - anchor.y;
    for (const { m, g } of ghosts) {
      g.style.left = `${m.x + dx}px`;
      g.style.top = `${m.y + dy}px`;
    }
  };
  const auto = patcherScroll(place);
  const move = (ev) => {
    last = ev;
    moved ||= Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) >= 4;
    place();
    if (moved) auto.update({ x: ev.clientX, y: ev.clientY });
  };
  const up = async (ev) => {
    auto.stop();
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    suppressAltUp = true; // Alt released after the drag must not open the browser menu bar
    const done = () => ghosts.forEach(({ g }) => g.remove());
    if (ev.type === 'pointercancel' || (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4)) { done(); return; }
    try {
      const copies = undoHistory
        ? await undoHistory.group(() => patch.duplicateMany(entries.map((m) => m.id), dx, dy))
        : await patch.duplicateMany(entries.map((m) => m.id), dx, dy);
      if (patch === current()) {
        render();
        selectEntries(copies);
      }
      $('status').textContent = copies.length === 1
        ? `Duplicated ${entries[0].def.type} #${entries[0].id} → #${copies[0].id}`
        : `Duplicated ${copies.length} modules → ${copies.map((c) => `#${c.id}`).join(' ')}`;
    } catch (err) {
      $('status').textContent = `Duplicate failed: ${err.message}`;
    } finally {
      done();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
window.addEventListener('keyup', (e) => {
  if (e.key === 'Alt' && suppressAltUp) { e.preventDefault(); suppressAltUp = false; }
});

// ---- cables ----
// Straight lines from module centre to module centre (see cable.js). The box of a module in world
// coordinates, from layout sizes so the camera transform does not matter.
const boxOf = (entry) => ({ x: entry.x, y: entry.y, w: entry.el.offsetWidth, h: entry.el.offsetHeight });

function drawCables() {
  svg.replaceChildren();
  const patch = current();
  const live = []; // audio cables that show their signal
  const midiCables = [];
  for (const cable of patch.cables) {
    const a = patch.modules.get(cable.from);
    const b = patch.modules.get(cable.to);
    const signals = patch.signals(a, b);
    // a Patch cable looks like what its inside sends out: control or MIDI unless it sends sound too
    const out = a.inst.outSignals?.();
    const soundy = signals.audio && (!out || out.audio || !(out.mod || out.midi));
    const isMod = (!!a.def.modulator && !signals.audio) || (signals.mod && !soundy);
    const ra = boxOf(a);
    const rb = boxOf(b);
    const { from, to } = visibleSegment(ra, rb); // arrow and audio wave go on the visible part
    const g = document.createElementNS(SVGNS, 'g');
    g.classList.add('cable');
    g.cable = cable; // for the right-click menu
    g.classList.toggle('selected', sel?.cable === cable);
    g.classList.toggle('mod', isMod);
    g.classList.toggle('midi', !isMod && signals.midi && !soundy);
    setColor(g, colorOf(a));
    const wire = document.createElementNS(SVGNS, 'path');
    wire.classList.add('wire');
    // two-way connection: shift both arrows back so they point towards each other, and end each
    // line at its own arrow (the wire inside the arrowhead, the live wave at its tip) so the two
    // cables meet in the middle instead of overlapping
    const twoWay = patch.cables.some((c) => c.from === cable.to && c.to === cable.from);
    const back = twoWay ? 9 : 0;
    const head = twoWay ? arrowPoints(from, to, 7, back) : null;
    wire.setAttribute('d', linePath(centerOf(ra), head ? head.centre : centerOf(rb)));
    const arrow = document.createElementNS(SVGNS, 'path');
    arrow.classList.add('arrow');
    arrow.setAttribute('d', arrowPath(from, to, 7, back));
    g.append(wire, arrow);
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      select({ kind: 'cable', cable });
    });
    svg.append(g);
    if (signals.midi) midiCables.push({ cable, g, from, to });
    // control cables (Out Controller modules) stay a plain dashed line, no value wave
    const h = soundy && !isMod ? a.inst?.node?.h : undefined;
    if (h !== undefined) live.push({ g, h, from, to: head ? head.tip : to });
  }
  scope?.setCables(live);
  engine.midiCables?.setCables(midiCables);
}

// Connects `from` -> the module of element `el`, or disconnects that cable when it exists, and
// flashes the target. Shared by Shift + drag sweeps and dragging a module onto another one.
function toggleCable(patch, from, el) {
  const toId = +el.dataset.id;
  const existing = patch.cables.find((c) => c.from === from.id && c.to === toId);
  const ok = existing ? (patch.disconnect(existing), true) : patch.connect(from.id, toId);
  if (!ok) {
    $('status').textContent = 'Cannot connect (duplicate, a loop without two FEEDBACK modules in it, or this module has no input of that kind).';
    return false;
  }
  drawCables();
  el.classList.remove('cable-hit', 'cable-cut');
  void el.offsetWidth; // restart the flash animation
  el.classList.add(existing ? 'cable-cut' : 'cable-hit');
  el.addEventListener('animationend', () => el.classList.remove('cable-hit', 'cable-cut'), { once: true });
  return true;
}

// Shift + drag from a module: every module the pointer moves onto gets connected (or, when that
// cable exists already, disconnected) at once, so one source can be wired to many targets in one
// sweep. Moving off a module and back onto it toggles it again; the source itself is ignored.
function startCable(e, entry) {
  e.stopPropagation();
  e.preventDefault();
  const temp = document.createElementNS(SVGNS, 'g');
  temp.classList.add('cable', 'temp');
  const wire = document.createElementNS(SVGNS, 'path');
  wire.classList.add('wire');
  const arrow = document.createElementNS(SVGNS, 'path');
  arrow.classList.add('arrow');
  temp.append(wire, arrow);
  svg.append(temp);
  const box = boxOf(entry);
  const patch = current();
  undoHistory?.begin();
  let over = null; // module element under the pointer (already handled)
  const toggle = (el) => {
    if (toggleCable(patch, entry, el)) svg.append(temp); // drawCables cleared the svg: temporary cable back on top
  };
  let last = e;
  const update = () => {
    const ev = last;
    const seg = visibleSegment(box, null, clientToWorld(ev.clientX, ev.clientY));
    wire.setAttribute('d', linePath(centerOf(box), seg.to));
    arrow.setAttribute('d', arrowPath(seg.from, seg.to));
    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.module:not(.ghost)') ?? null;
    if (el === over) return;
    over = el;
    if (el && el !== entry.el && patch.modules.has(+el.dataset.id)) toggle(el);
  };
  // the view pans along near / past the patcher edge, sweeping over the modules that come in
  const auto = patcherScroll(update);
  const move = (ev) => {
    last = ev;
    update();
    auto.update({ x: ev.clientX, y: ev.clientY });
  };
  const up = () => {
    auto.stop();
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    temp.remove();
    undoHistory?.end();
    select(sel); // refresh the panel: e.g. an LFO's Out Controller names follow its cables
  };
  over = entry.el; // starting on the source: nothing to do until the pointer leaves it
  update();
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// ---- selection, deletion ----
// Drag on empty canvas: selection rectangle; a plain click clears the selection.
// Shift + drag pans the view; Ctrl/⌘ + drag adds modules touching the rectangle to the selection.
canvas.addEventListener('pointerdown', (e) => {
  const forward = e.button === MOUSE_FORWARD;
  if ((!forward && e.button !== 0) || (!forward && e.target !== canvas && e.target !== svg && e.target !== world)) return;
  if (forward && e.target.closest('input, textarea, button, select, .module-rename')) return;
  e.preventDefault();
  const additive = e.ctrlKey || e.metaKey;
  if (!forward && e.shiftKey && !additive) { backgroundPan(e); return; }
  const base = additive ? selectedEntries() : [];
  if (!additive) select(null);
  const c = canvas.getBoundingClientRect();
  const x0 = e.clientX - c.left;
  const y0 = e.clientY - c.top;
  // the start corner is anchored in the world, so the rectangle grows while the view pans along
  const w0 = toWorld(cam(), x0, y0);
  const box = document.createElement('div');
  box.className = 'select-rect';
  let shown = false;
  let last = null;
  const apply = () => {
    if (!last) return;
    const k = canvas.getBoundingClientRect();
    const x1 = Math.min(k.width, Math.max(0, last.clientX - k.left));
    const y1 = Math.min(k.height, Math.max(0, last.clientY - k.top));
    const a0 = toScreen(cam(), w0.x, w0.y);
    if (!shown) { canvas.appendChild(box); shown = true; }
    const r = { l: Math.min(a0.x, x1), t: Math.min(a0.y, y1), r: Math.max(a0.x, x1), b: Math.max(a0.y, y1) };
    // drawn inside the patcher; hit-tested over the whole (world) span
    const d = { l: Math.max(0, r.l), t: Math.max(0, r.t), r: Math.min(k.width, r.r), b: Math.min(k.height, r.b) };
    Object.assign(box.style, { left: `${d.l}px`, top: `${d.t}px`, width: `${Math.max(0, d.r - d.l)}px`, height: `${Math.max(0, d.b - d.t)}px` });
    // the rectangle is drawn in screen space; hit-test modules in world space
    const a = toWorld(cam(), r.l, r.t);
    const b = toWorld(cam(), r.r, r.b);
    const wr = { l: a.x, t: a.y, r: b.x, b: b.y };
    const hit = [...current().modules.values()].filter((m) => {
      const el = m.el;
      return m.x < wr.r && m.x + el.offsetWidth > wr.l && m.y < wr.b && m.y + el.offsetHeight > wr.t;
    });
    selectEntries([...new Set([...base, ...hit])]);
  };
  const auto = patcherScroll(apply);
  const move = (ev) => {
    if (!shown && Math.hypot(ev.clientX - c.left - x0, ev.clientY - c.top - y0) < 3) return;
    last = ev;
    apply();
    auto.update({ x: ev.clientX, y: ev.clientY });
  };
  const up = () => {
    auto.stop();
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    box.remove();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});

function backgroundPan(e) {
  const start = { ...cam() };
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = false;
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    if (!moved) { moved = true; canvas.classList.add('panning'); }
    setCam({ ...start, x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy });
  };
  const up = (ev) => {
    canvas.classList.remove('panning');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!moved && ev.type === 'pointerup') select(null); // a click on the background
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// ---- commands: delete, cut / copy / paste (keyboard and right-click menu) ----
let clipboard = null; // copied modules (PatchRuntime.copyMany), pasted into any patch level
let lastPointer = null; // client position of the pointer over the patcher (paste location)
canvas.addEventListener('pointermove', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerleave', () => { lastPointer = null; });

function deleteSelection() {
  if (!sel) return;
  const patch = current();
  if (sel.kind === 'cable') patch.disconnect(sel.cable);
  else {
    const entries = selectedEntries();
    const removable = entries.filter((m) => !m.def.isOutput);
    if (!removable.length) { $('status').textContent = 'The Output module cannot be deleted.'; return; }
    removable.forEach((m) => m.inst.allOff?.());
    patch.removeMany(removable.map((m) => m.id));
    $('status').textContent = removable.length < entries.length
      ? `Deleted ${removable.length} module(s); the Output module stays.`
      : `Deleted ${removable.length} module(s).`;
  }
  render();
}
function copySelection() {
  const data = current().copyMany(selectedEntries().map((m) => m.id));
  if (!data) { $('status').textContent = selectedEntries().length ? 'The Output module cannot be copied.' : 'Nothing selected to copy.'; return false; }
  clipboard = data;
  $('status').textContent = `Copied ${data.modules.length} module(s).`;
  return true;
}
function cutSelection() {
  if (copySelection()) deleteSelection();
}
// at = client position for the group's top-left corner (default: offset from the originals)
async function paste(at) {
  if (!clipboard) return;
  const patch = current();
  const w = at ? clientToWorld(at.x, at.y) : null;
  try {
    const options = w ? { x: Math.round(w.x), y: Math.round(w.y) } : {};
    const added = undoHistory
      ? await undoHistory.group(() => patch.pasteMany(clipboard, options))
      : await patch.pasteMany(clipboard, options);
    if (patch !== current()) return;
    render();
    selectEntries(added);
    $('status').textContent = `Pasted ${added.length} module(s).`;
  } catch (err) {
    $('status').textContent = `Paste failed: ${err.message}`;
  }
}

// ---- .phmod files: modules saved to disk, inserted again from the insert dialog ----
// JSON text: { format: 'philsynth-module', version, modules, cables } (PatchRuntime.copyMany data:
// settings, name, nested patches and the cables between the saved modules).
const fileSafe = (s) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'module';
async function saveModules() {
  const mods = selectedEntries().filter((m) => !m.def.isOutput);
  const data = current().copyMany(mods.map((m) => m.id));
  if (!data) { $('status').textContent = 'Select a module to save (the Output module cannot be saved).'; return; }
  const suggestedName = `${fileSafe(mods.length === 1 ? mods[0].name || mods[0].def.type : 'modules')}${MODULE_EXT}`;
  const text = jsonFileText(withSamples({ format: MODULE_FORMAT, version: 1, ...data }));
  let saved;
  try {
    saved = await saveTextFile('module', suggestedName, text); // starts in the last module folder
  } catch (err) {
    $('status').textContent = `Save failed: ${err.message}`;
    return;
  }
  if (!saved) return; // dialog cancelled
  $('status').textContent = `Saved ${data.modules.length} module(s) to ${saved.name}.`;
}
// the open dialog starts in the folder a module was last saved to / loaded from;
// pos: world position of the modules (the insert dialog's spot, or the right-clicked spot)
async function loadModuleFile(pos) {
  let file;
  let preview = null;
  try {
    file = await openTextFile('module', window, (files, opts) => {
      preview = createModulePreview(engine, (path) => files.openFile('module', path));
      modulePreview = preview;
      return pickFile(files, { ...opts, preview: preview.select });
    });
  } catch (err) {
    $('status').textContent = `Load module failed: ${err.message}`;
    console.error('Load module failed', err);
    return;
  } finally {
    await preview?.stop();
    if (modulePreview === preview) modulePreview = null;
  }
  if (file) insertSynthFile(file, pos);
}
async function insertSynthFile(file, pos) {
  const patch = current();
  try {
    const data = parseSynthFile(file.text);
    importSamples(data.samples);
    const options = { x: pos.x, y: pos.y };
    const added = undoHistory
      ? await undoHistory.group(() => patch.pasteMany(data, options))
      : await patch.pasteMany(data, options);
    if (patch !== current()) return;
    render();
    selectEntries(added);
    $('status').textContent = `Loaded ${file.name}: ${added.length} module(s).`;
  } catch (err) {
    $('status').textContent = `Loading ${file.name} failed: ${err.message}`;
  }
}

// Snap to Grid (patcher right-click menu): moved modules land on an invisible grid. A setting of
// this computer, not of the project.
const SNAP_GRID_KEY = 'philsynth:snapGrid';
let snapGrid = false;
try { snapGrid = localStorage.getItem(SNAP_GRID_KEY) === '1'; } catch { /* storage blocked */ }
function setSnapGrid(on) {
  snapGrid = on;
  try { localStorage.setItem(SNAP_GRID_KEY, on ? '1' : '0'); } catch { /* storage blocked */ }
  $('status').textContent = on ? 'Snap to Grid on: moved modules snap to the grid by their left edge.' : 'Snap to Grid off.';
}

// Set Color… (right-click menu): one colour for every selected module, previewed on the one
// right-clicked. A module whose new colour is its type's stock colour stores null (see modcolor.js).
async function setModuleColor(entry, mods) {
  const patch = current();
  const list = mods.includes(entry) ? mods : [entry];
  const color = await openColorDialog(entry, { name: entry.name ?? defaultName(entry.def), count: list.length });
  if (color === undefined || patch !== current()) return;
  const apply = () => {
    for (const m of list) patch.recolor(m.id, color && !m.def.isOutput && color === stockColor(m.def) ? null : color);
  };
  if (undoHistory) await undoHistory.group(apply); else apply();
  for (const m of list) if (m.el) setColor(m.el, colorOf(m));
  drawCables();
  if (sel) select(sel); // the panel header and controllers take the new colour
  $('status').textContent = color ? `Color ${color} set on ${list.length === 1 ? `#${entry.id}` : `${list.length} modules`}.` : 'Stock color restored.';
}

// Right-click menu (right-click, or the keyboard menu key): on a module (it joins /
// becomes the selection), a cable, or empty canvas.
function openPatcherMenu(target, x, y) {
  const box = target.closest('.module');
  const entry = box ? current().modules.get(+box.dataset.id) : null;
  const cableEl = target.closest('.cable');
  if (entry && !selectedEntries().includes(entry)) select({ kind: 'module', entry });
  else if (!entry && cableEl?.cable && sel?.cable !== cableEl.cable) select({ kind: 'cable', cable: cableEl.cable });
  const mods = selectedEntries();
  const onModule = !!entry;
  const copyable = onModule && mods.some((m) => !m.def.isOutput);
  const at = { x, y };
  const items = [
    { label: 'Cut', shortcut: shortcut('X'), disabled: !copyable, action: cutSelection },
    { label: 'Copy', shortcut: shortcut('C'), disabled: !copyable, action: copySelection },
    { label: 'Paste', shortcut: shortcut('V'), disabled: !clipboard, action: () => paste(at) },
    { label: 'Delete', shortcut: '⌫', disabled: !(onModule ? copyable : sel?.kind === 'cable'), action: deleteSelection },
  ];
  if (onModule && entry.inst.patch) items.push('-', { label: 'Open patch', shortcut: '↵', disabled: mods.length > 1, action: () => openPatch(entry) });
  if (onModule) items.push('-', { label: mods.length > 1 ? 'Save modules…' : 'Save module…', disabled: !copyable, action: saveModules });
  else items.push('-', { label: 'Load module…', action: () => openInsertDialog(x, y) });
  if (onModule) items.push({ label: 'Rename…', shortcut: 'F2', disabled: mods.length > 1, action: () => startRename(entry) });
  if (onModule && entry.name) items.push({ label: 'Reset name', action: () => { current().rename(entry.id, ''); showName(entry); drawCables(); } });
  if (onModule) items.push({ label: 'Set Color…', action: () => setModuleColor(entry, mods) });
  items.push('-', { label: 'Snap to Grid', checked: snapGrid, action: () => setSnapGrid(!snapGrid) });
  showMenu({ x, y, items });
}
// Right-click a module, cable or the canvas: menu.
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 2 || e.target.closest('input, .module-rename')) return;
  e.preventDefault();
  openPatcherMenu(e.target, e.clientX, e.clientY);
});
canvas.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, .module-rename')) return;
  e.preventDefault();
  if (e.button === 2 || e.ctrlKey) return; // mouse: the menu already opened on the press
  // keyboard menu key / Shift+F10: open at the selected module, the pointer or the canvas centre
  const box = selectedEntries()[0]?.el;
  const r = (box ?? canvas).getBoundingClientRect();
  const p = box ? { x: r.left + 8, y: r.top + 8 } : lastPointer ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  openPatcherMenu(box ?? canvas, p.x, p.y);
});

// Mouse back button (button 3): one patch level up. Its default (history back) is
// suppressed so the page never navigates away.
initMouseNavigation(window, () => {
  if (path.length > 1 && !document.querySelector('dialog[open]')) {
    goUpPatch();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
    if (e.repeat) return;
    if (!e.defaultPrevented && !e.target.closest('input, select, textarea, dialog, [contenteditable]:not([contenteditable="false"])')) {
      e.preventDefault();
      if (path.length > 1) {
        goUpPatch();
      } else {
        exitToOS(persist, (message) => { $('status').textContent = message; });
      }
    }
    return;
  }
  const command = (e.ctrlKey || e.metaKey) && !e.altKey;
  const k = e.key.toLowerCase();
  if (command && (k === 'z' || (k === 'y' && !e.shiftKey))
    && !e.target.closest('input, select, textarea, dialog, [contenteditable]:not([contenteditable="false"])')) {
    e.preventDefault();
    e.stopPropagation();
    if (!undoHistory) {
      $('status').textContent = 'Nothing to undo / redo.';
      return;
    }
    const direction = k === 'y' || e.shiftKey ? 1 : -1;
    const label = direction > 0 ? 'Redo' : 'Undo';
    undoHistory.travel(direction).then((ok) => {
      $('status').textContent = ok ? label : 'Nothing to undo / redo.';
    }).catch((err) => {
      $('status').textContent = `${label} failed: ${err.message}`;
    });
    return;
  }
  if (e.target.closest('input, select, textarea, dialog, #seq')) return; // #seq handles its own keys; the TimeLine bubbles here
  if (command && k === 'a') {
    e.preventDefault();
    selectEntries([...current().modules.values()]);
    return;
  }
  // only while the patcher has focus: elsewhere Cmd/Ctrl + C copies text as usual
  const patcherFocused = document.activeElement === canvas || document.activeElement === document.body;
  if (command && !e.shiftKey && patcherFocused && (k === 'c' || k === 'x' || k === 'v')) {
    e.preventDefault();
    if (k === 'c') copySelection();
    else if (k === 'x') cutSelection();
    else paste(lastPointer);
    return;
  }
  if (e.key === 'Enter' && sel?.kind === 'module' && sel.entry.inst.patch) {
    e.preventDefault();
    openPatch(sel.entry);
    return;
  }
  if (e.key === 'F2' && sel?.kind === 'module') {
    e.preventDefault();
    startRename(sel.entry);
    return;
  }
  if ((e.key !== 'Backspace' && e.key !== 'Delete') || !sel) return;
  e.preventDefault();
  deleteSelection();
});

// ---- controller panel ----
function panelHeader(title, sub, color) {
  const h = document.createElement('div');
  h.className = 'panel-header';
  setColor(h, color);
  const t = document.createElement('h2');
  t.textContent = title;
  const s = document.createElement('span');
  s.textContent = sub;
  h.append(t, s);
  return h;
}

function hint(html) {
  const p = document.createElement('p');
  p.className = 'hint';
  p.innerHTML = html; // static strings only
  return p;
}

function showMidiTarget() {
  const target = layerMidi(current());
  const locked = !!target && lockedEntry(current()) === target;
  document.querySelectorAll('.module:not(.ghost)').forEach((el) => {
    const on = target?.el === el;
    el.classList.toggle('midi-target', on);
    el.classList.toggle('midi-locked', on && locked);
    const badge = el.querySelector(':scope > .midi-badge');
    if (badge) badge.title = locked ? 'MIDI locked to this module on this patch level (saved with it) — click to unlock' : 'MIDI follows the selection on this patch level — click to lock it to this module';
  });
}

function select(s) {
  rememberPanelScroll();
  sel = s;
  activePanelScrollKey = s?.kind === 'module' ? panelScrollKey(s.entry) : null;
  if (s?.kind === 'module' && takesLiveMidi(s.entry.def)) setMidiTarget(s.entry);
  if (s?.kind === 'module') followClips(s.entry);
  const chosen = new Set(selectedEntries().map((m) => m.el));
  document.querySelectorAll('.module:not(.ghost)').forEach((el) => el.classList.toggle('selected', chosen.has(el)));
  showMidiTarget();
  drawCables();
  panel.replaceChildren();
  panelScroller.scrollTop = 0;
  panel.classList.toggle('no-selection', !s); // larger help text when nothing is selected
  panelRefresh = null;
  if (s?.kind === 'cable') {
    panel.append(panelHeader('Cable', `#${s.cable.from} → #${s.cable.to}`));
    const patch = current();
    const lfo = patch.modules.get(s.cable.from);
    if (lfo?.def.routeParams) {
      const t = patch.modules.get(s.cable.to);
      const names = lfo.def.routeParams(lfo, t).map((pid) => {
        const i = paramsOf(t).findIndex((q) => q.id === pid);
        return i < 0 ? null : `<kbd>${controllerNumber(paramsOf(t)[i], i)}</kbd> ${paramsOf(t)[i].label}`;
      }).filter(Boolean);
      panel.append(hint(names.length
        ? `Control cable: <b>Value</b> drives ${names.join(', ')}.`
        : 'Control cable: no controller of this module is routed yet. Select the MULTICTL and pick one under <b>Routes</b>.'));
    } else if (lfo?.def.audioThrough && patch.signals(lfo, patch.modules.get(s.cable.to)).audio) {
      panel.append(hint('Audio cable (tremolo): carries the sound cabled into this LFO, its volume following the wave (Amplitude, Out Min..Out Max = 0..100 % volume).'));
    } else if (lfo?.def.modulator) {
      const t = patch.modules.get(s.cable.to);
      const n = lfo.values.outController | 0;
      const passed = patch.controlTargets(t, lfo);
      if (passed[0] !== t) {
        panel.append(hint(`Control cable into the Output: passes out of this Patch. Controller <kbd>${n}</kbd> of the modules the Patch module is cabled to is modulated${passed.length ? ` (${[...new Set(passed.map((o) => controllerAt(paramsOf(o), n)?.label ?? '—'))].join(' / ')})` : ' (the Patch module is not cabled to any yet)'}.`));
      } else {
        const p = controllerAt(paramsOf(t), n);
        panel.append(hint(`Control cable: modulates controller <kbd>${n}</kbd> ${p ? p.label : '(does not exist on this module)'}.`));
      }
    }
    const signals = lfo && !lfo.def.modulator ? patch.signals(lfo, patch.modules.get(s.cable.to)) : null;
    if (signals?.midi) {
      const into = patch.modules.get(s.cable.to);
      panel.append(hint(into.def.isOutput
        ? 'MIDI cable into the Output: the notes pass out of this Patch, over the Patch module\'s cables to MIDI modules.'
        : `${signals.audio ? 'Audio + MIDI' : 'MIDI'} cable: carries MODMIDI notes (float pitch, velocity and start phase).`));
    }
    if (signals?.mod) {
      const t = patch.modules.get(s.cable.to);
      const names = [...lfo.inst.patch.passOutControllers()].map((k) => `<kbd>${k}</kbd> ${controllerAt(paramsOf(t), k)?.label ?? '(does not exist on this module)'}`);
      panel.append(hint(t.def.isOutput && patch.passesOut
        ? 'Control cable into the Output: the modulation of this Patch passes on out of the Patch around it.'
        : `Control cable: the modulators cabled into this Patch's Output drive ${names.join(', ')}.`));
    }
    panel.append(hint('Press <kbd>Backspace</kbd> to remove this cable.'));
    return;
  }
  if (!s) {
    panel.append(panelHeader('No selection', 'Guide'), renderGuide());
    return;
  }
  if (s.kind === 'group') {
    panel.append(panelHeader(`${s.entries.length} modules`, 'selected'));
    const list = document.createElement('ul');
    list.className = 'sel-list';
    for (const m of [...s.entries].sort((a, b) => a.id - b.id)) {
      const li = document.createElement('li');
      const num = document.createElement('span');
      num.className = 'ctl-num';
      num.textContent = m.id;
      li.append(num, m.def.isOutput ? 'Output' : m.def.label);
      setColor(li, colorOf(m));
      li.onclick = () => select({ kind: 'module', entry: m });
      list.append(li);
    }
    panel.append(
      list,
      hint('Drag any selected module to move them together.'),
      hint('When the module you grabbed touches an unselected module, every compatible selected source connects to it (or disconnects its existing cable). Pull the grabbed module away and back to toggle again. The move and all connections are one undoable edit.'),
      hint('<kbd>Alt</kbd> + drag duplicates the selection, including the cables between them.'),
      hint('<kbd>Backspace</kbd> deletes them (the Output module stays).'),
    );
    return;
  }

  const entry = s.entry;
  const header = panelHeader(entry.def.label, `#${entry.id}`, colorOf(entry));
  panel.append(header);
  // custom editor of the module's state (e.g. the WAVESHAPER curve), below the controllers
  const editor = entry.def.editor?.(entry, {
    color: colorOf(entry) ?? entry.def.color,
    setState: (st) => current().setState(entry.id, st),
    beginEdit: () => undoHistory?.begin(),
    endEdit: () => undoHistory?.end(),
  });
  if (editor) panel.append(editor.el);

  let view = null;
  const rows = [];
  const refresh = () => {
    for (const { p, row, show } of rows) {
      row.hidden = p.visible ? !p.visible(entry.values) : false;
      show(entry.values[p.id]); // formats may depend on other controllers (e.g. LFO unit)
    }
    editor?.refresh?.(entry.values);
    view?.refresh?.(entry.values);
  };

  const controllers = document.createDocumentFragment();
  paramsOf(entry).forEach((p, index) => {
    if (p.panel === false) return; // shown by the module's own view (MULTICTL route ranges)
    const format = (v) => (p.format ? p.format(v, entry.values) : p.options ? p.options[v] : String(+v.toFixed(3)));
    const ctl = createController(p, {
      index: controllerNumber(p, index),
      value: entry.values[p.id],
      values: () => entry.values,
      format,
      onBegin: () => undoHistory?.begin(),
      onEnd: () => undoHistory?.end(),
      onInput: (v) => {
        current().setParam(entry.id, p.id, v);
        refresh();
      },
    });
    setColor(ctl.el, colorOf(entry));
    const row = ctl.el;
    controllers.appendChild(row);
    rows.push({ p, row, show: ctl.show });
  });
  panel.insertBefore(controllers, header.nextSibling);

  // display below the controllers (e.g. the OSC waveform preview)
  view = entry.def.view?.(entry, {
    songFacts: () => songFacts(songLayers(engine.root, engine.song)),
    color: colorOf(entry) ?? entry.def.color,
    setParam: (id, v) => { current().setParam(entry.id, id, v); refresh(); }, // e.g. dragging an EQ band
    setState: (st) => current().setState(entry.id, st), // e.g. the Output's comments
    beginEdit: () => undoHistory?.begin(),
    endEdit: () => undoHistory?.end(),
    refresh: () => refresh(), // e.g. MULTICTL: the Value text names its routed controllers
    rebuild: () => { if (sel?.entry === entry) select(sel); }, // e.g. INPUT: the Microphone list changed
    // Patch: "Controllers…" opens the mapping dialog; the panel shows the new controllers after it
    patchControllers: (e) => patchControllersView(e, {
      edit: () => openPatch(e),
      open: async () => {
        const patch = current();
        await openMapDialog(e, { setState: (st) => patch.setState(e.id, st) });
        if (sel?.entry === e) select(sel);
      },
    }),
  }) ?? null;
  if (view) panel.append(view.el);
  // structured reference: summary, every controller, usage notes (src/moduledocs.js)
  const docs = moduleDocs(entry.def, paramsOf(entry));
  if (docs) panel.append(docs);
  panelRefresh = refresh;
  refresh();
  panelScroller.scrollTop = panelScrolls[activePanelScrollKey] ?? 0;
}

// ---- driven controllers (LFO, ADSR, VELO2CTL, SOUND2CTL, MULTICTL, automation clips) ----
// They move the real controller value (src/patch.js drive()): the panel follows once per frame,
// and the project is autosaved now and then while values keep moving (no undo steps).
let panelRefresh = null; // redraws the controllers of the module shown in the panel
let driveFrame = 0;
let driveSaveTimer = 0;
const DRIVE_SAVE_MS = 3000;
engine.onDrive = (entry) => {
  if (sel?.entry === entry && !driveFrame) {
    driveFrame = requestAnimationFrame(() => {
      driveFrame = 0;
      panelRefresh?.();
    });
  }
  driveSaveTimer ||= setTimeout(() => {
    driveSaveTimer = 0;
    persist.schedule();
  }, DRIVE_SAVE_MS);
};

// ---- main menu: New / Open / Save / Save As / Export ----
// Project files are .phproject (PHILSYNTH project: JSON text inside). Older .mds / .json projects
// still open; Save then asks for a new .phproject file instead of overwriting them.
let fileBusy = false;
async function fileCommand(label, fn) {
  if (fileBusy) return;
  fileBusy = true;
  try {
    await fn();
  } catch (err) {
    console.error(`${label} failed:`, err);
    $('status').textContent = `${label} failed: ${err.message}`;
  } finally {
    fileBusy = false;
  }
}
async function saveFile(as = false) {
  const name = await (as ? projectFile.saveAs() : projectFile.save());
  if (name) $('status').textContent = `Saved ${name}`;
  persist.schedule(); // the autosave remembers the file and that it is saved
  return name;
}
// Unsaved changes: Yes saves first, No discards them, Cancel (or Escape) keeps the project.
async function keepGoing(action) {
  if (!projectFile.isDirty()) return true;
  const answer = await unsavedDialog(projectFile.name, { action });
  if (answer === 'cancel') return false;
  if (answer === 'no') return true;
  return !!(await saveFile());
}
const newFile = () => fileCommand('New', async () => {
  if (!(await keepGoing('starting a new project'))) return;
  await openProject(emptyProject(), null);
  projectFile.reset();
  $('status').textContent = 'New project';
});
const openFile = () => fileCommand('Open', async () => {
  if (!(await keepGoing('opening another project'))) return;
  const name = await projectFile.open((data) => openProject(data, data.view));
  if (name) $('status').textContent = `Opened ${name}`;
});
const saveCommand = (as) => fileCommand(as ? 'Save As' : 'Save', () => saveFile(as));

const brand = $('brand');
let mainMenuOpen = false;
let brandClosesMenu = false;
// a click on the logo while its menu is open only closes the menu (runs before the menu's own listener)
window.addEventListener('pointerdown', (e) => { brandClosesMenu = mainMenuOpen && brand.contains(e.target); }, true);
function openMainMenu(focusFirst) {
  const r = brand.getBoundingClientRect();
  mainMenuOpen = true;
  brand.setAttribute('aria-expanded', 'true');
  showMenu({
    x: r.left - 2,
    y: r.bottom + 2,
    className: 'main-menu',
    onClose: () => {
      mainMenuOpen = false;
      brand.setAttribute('aria-expanded', 'false');
    },
    items: [
      { label: 'New', shortcut: shortcut('N'), action: newFile },
      { label: 'Open…', shortcut: shortcut('O'), action: openFile },
      { label: 'Save', shortcut: shortcut('S'), action: () => saveCommand(false) },
      { label: 'Save As…', shortcut: shortcut('⇧S'), action: () => saveCommand(true) },
      '-',
      { label: 'Export…', children: [
        { label: 'Export Audio…', shortcut: shortcut('E'), disabled: exporting, action: exportAudio },
        { label: 'Export MIDI…', disabled: exportingMidi, action: exportMidiFile },
      ] },
      '-',
      { label: 'Preferences…', action: openPreferences },
      '-',
      { label: 'Exit', shortcut: 'Esc', action: () => exitToOS(persist, (message) => { $('status').textContent = message; }) },
    ],
  });
  if (focusFirst) document.querySelector('.main-menu .ctx-item')?.focus();
}
brand.addEventListener('click', (e) => {
  if (brandClosesMenu) {
    brandClosesMenu = false;
    return;
  }
  openMainMenu(e.detail === 0); // detail 0: opened with Enter / Space
});
// Ctrl/Cmd + N / O / S / Shift + S / E work everywhere (also while typing), except in dialogs
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  const run = k === 's' ? () => saveCommand(e.shiftKey)
    : e.shiftKey ? null
      : k === 'n' ? newFile
        : k === 'o' ? openFile
          : k === 'e' ? exportAudio
            : null;
  if (!run) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  closeMenu();
  run();
}, true);

// ---- Export MIDI ----
let exportingMidi = false;
async function exportMidiFile() {
  if (exportingMidi) return;
  exportingMidi = true;
  try {
    const suggestedName = `${projectFile.name.replace(/\.(phproject|mds|json)$/i, '') || 'philsynth-song'}.mid`;
    const files = window.modsynthFiles;
    let desktop = null, handle = null;
    if (files?.saveMidi) {
      desktop = await pickFile(files, { mode: 'save', dialog: 'midi', title: 'Export MIDI', types: 'MIDI file (.mid)', exts: ['.mid'], saveExt: '.mid', suggestedName });
      if (!desktop) return;
    } else if (typeof window.showSaveFilePicker === 'function') {
      handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: 'MIDI file', accept: { 'audio/midi': ['.mid'] } }] });
    }
    const rt = shown();
    const out = exportMidi(layerSong(rt), {
      bpm: rt.bpm,
      metadata: rt.modules.get(0)?.state,
      pitchOffset: rt.pitchOffset,
      destinationName: id => {
        if (id === null) return 'Unassigned';
        const entry = rt.modules.get(id);
        return `#${id} ${entry ? moduleName(entry) : '(missing)'}`;
      },
    });
    const name = desktop?.name ?? handle?.name ?? suggestedName;
    const blob = new Blob([out.bytes], { type: 'audio/midi' });
    if (desktop) await files.saveMidi(desktop.path, out.bytes);
    else if (handle) await writeAudio(handle, blob, new AbortController().signal);
    else {
      const url = URL.createObjectURL(blob);
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    $('status').textContent = `${desktop || handle ? 'Exported' : 'Download started for'} ${name} (${out.tracks} destination tracks).`;
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error('MIDI export failed:', err);
    $('status').textContent = `MIDI export failed: ${err.message}`;
  } finally {
    exportingMidi = false;
  }
}

// ---- Export Audio ----
// The save dialog comes first (it needs the click's user activation), then the song renders
// offline (src/render.js) and is written there. The desktop app uses its own dialog
// (src/filepicker.js) and the main process writes the file. Without the File System Access API
// the file is downloaded instead.
let exporting = false;
const exportDialog = $('export-dialog');
const exportMessage = $('export-message');
const exportProgress = $('export-progress');
const exportCancel = $('export-cancel');
let exportController = null;
exportCancel.onclick = () => {
  exportController?.abort(new DOMException('Export cancelled', 'AbortError'));
  exportDialog.close();
};
exportDialog.addEventListener('cancel', (e) => { e.preventDefault(); exportCancel.onclick(); });

function showExportProgress(message, percent) {
  exportMessage.textContent = message;
  if (percent === null) exportProgress.removeAttribute('value');
  else exportProgress.value = percent;
  $('status').textContent = message;
}

// Let the dialog paint before synchronous project copying.
const paintExportProgress = () => new Promise((resolve) => {
  const frame = requestAnimationFrame(() => {
    clearTimeout(fallback);
    setTimeout(resolve, 0);
  });
  const fallback = setTimeout(() => { cancelAnimationFrame(frame); resolve(); }, 100);
});

async function exportAudio() {
  if (exporting) return;
  const suggestedName = `${projectFile.name.replace(/\.(phproject|mds|json)$/i, '') || 'modsynth-song'}.wav`;
  let handle = null;
  let desktop = null; // { path, name } chosen in the desktop app's dialog
  const files = window.modsynthFiles;
  if (files?.saveAudio) {
    desktop = await pickFile(files, { mode: 'save', dialog: 'audio', title: 'Export Audio', types: 'Audio format', formats: AUDIO_FORMATS, exts: AUDIO_FORMATS.map(format => format.ext), saveExt: '.wav', suggestedName });
    if (!desktop) return;
  } else if (typeof window.showSaveFilePicker === 'function') {
    try {
      handle = await window.showSaveFilePicker({ suggestedName, types: AUDIO_FORMATS.map(format => ({ description: format.label, accept: { [format.mime]: [format.ext] } })) });
    } catch (err) {
      if (err?.name === 'AbortError') return; // dialog cancelled
      console.warn('Save dialog unavailable, downloading instead:', err);
    }
  }
  exporting = true;
  const controller = new AbortController();
  exportController = controller;
  const { signal } = controller;
  exportCancel.textContent = 'Cancel';
  exportProgress.hidden = false;
  $('export-title').textContent = 'Export Audio';
  showExportProgress('Preparing audio…', 0);
  exportDialog.show();
  try {
    const format = audioFormat(desktop?.name ?? handle?.name ?? suggestedName);
    await paintExportProgress();
    signal.throwIfAborted();
    const project = withSamples(engine.saveProject());
    const sampleRate = engine.ctx?.sampleRate || 48000;
    const wasm = engine.dspInfo?.dsp === 'wasm' ? engine.wasm : null;
    showExportProgress('Rendering audio… 0%', 0);
    const out = await renderAudio(project, {
      sampleRate,
      wasm,
      format: format.ext,
      signal,
      onProgress: (f) => { showExportProgress(`Rendering audio… ${Math.round(f * 90)}%`, f * 90); },
      onEncoding: () => showExportProgress(`Encoding ${format.ext.slice(1).toUpperCase()}…`, 90),
    });
    signal.throwIfAborted();
    const { wav } = out;
    const blob = new Blob([wav], { type: format.mime });
    const name = desktop?.name ?? handle?.name ?? suggestedName;
    let downloaded = false;
    const download = () => {
      signal.throwIfAborted();
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
      a.click();
      downloaded = true;
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    };
    showExportProgress(`Writing ${name}…`, null);
    await paintExportProgress();
    signal.throwIfAborted();
    if (desktop) {
      const id = crypto.randomUUID();
      const cancelWrite = () => {
        files.cancelAudio(id).catch((err) => console.error('Could not cancel audio file write:', err));
      };
      signal.addEventListener('abort', cancelWrite, { once: true });
      try { await files.saveAudio(desktop.path, wav, id); }
      finally { signal.removeEventListener('abort', cancelWrite); }
    } else if (handle) {
      try {
        await writeAudio(handle, blob, signal);
      } catch (err) {
        signal.throwIfAborted();
        // write access refused (e.g. by the platform): save it as a download instead
        console.warn('Writing the chosen file failed, downloading instead:', err);
        download();
      }
    } else download();
    signal.throwIfAborted();
    const secs = Math.round(out.seconds);
    const length = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const clipped = out.peak > 1 ? ` Clipped: peak +${(20 * Math.log10(out.peak)).toFixed(1)} dBFS, lower the Output level.` : '';
    $('export-title').textContent = downloaded ? 'Audio ready' : 'Export complete';
    const quality = format.ext === '.wav' ? `${sampleRate} Hz, 24-bit stereo`
      : format.ext === '.mp3' ? 'MP3, 320 kbps stereo' : 'Ogg Vorbis, quality 10 stereo';
    showExportProgress(`${downloaded ? 'Download started for' : 'Exported'} ${name} (${length}, ${quality}).${downloaded ? ' Check your browser downloads for completion.' : ''}${clipped}`, 100);
  } catch (err) {
    if (signal.aborted) {
      showExportProgress('Export cancelled.', 0);
      exportDialog.close();
    } else {
      console.error('Audio export failed:', err);
      $('export-title').textContent = 'Export failed';
      exportProgress.hidden = true;
      showExportProgress(`Export failed: ${err.message}`, 0);
    }
  } finally {
    exporting = false;
    exportController = null;
    exportCancel.textContent = 'Close';
  }
}
function emptyProject() {
  const values = Object.fromEntries(getModule('OUT').params.map((p) => [p.id, p.default]));
  return { format: PROJECT_FORMAT, version: 1, patch: { modules: [{ id: 0, type: 'OUT', x: 560, y: 180, values }], cables: [] }, song: newSong() };
}

// ---- boot ----
// Mouse clicks never leave the keyboard focus on a button: Space must keep playing / stopping
// instead of pressing the last clicked button again. A text field or button that had the focus
// lets go of it (a typed name is committed); the keyboard (Tab) can still focus buttons.
window.addEventListener('mousedown', (e) => {
  if (!e.target.closest?.('button')) return;
  e.preventDefault();
  const active = document.activeElement;
  if (active?.matches?.('input, select, textarea, button, [contenteditable]:not([contenteditable="false"])')) active.blur();
}, true);
initWidgets(document, { numberStep: () => snapStep(layerSong(shown()).snap) });
initStatusTips({ tipEl: $('tip'), statusEl: $('status') }); // after initWidgets: it extends some titles
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => engine.resume()));
initCpuMeter(engine);
await engine.init();
patchMonitor = createPatchMonitor(engine.root);
scope = new CableScope(engine.dsp);
engine.midiCables = new MidiCableAnimation();
// clips play the module with their number in their own patch level (shown: the open one)
const targetIn = (rt) => (id) => {
  const e = id === null || id === undefined ? null : rt.modules.get(id);
  return e?.def.acceptsMidi ? e.inst : null;
};
// Play runs from the level shown (scope = its path of Patch module numbers): only its own TimeLine,
// at its Output's BPM (the TimeLines of Patches inside it are sketches heard only from inside).
// Automation drives a controller's real value (see PatchRuntime.drive). Every note entering the
// project is shifted by the Global Transpose / Cents Offset of the current level's Output (playback:
// the level playing; live input: the level shown).
const pitchOffset = () => shown()?.pitchOffset ?? 0;
const scopeRt = (ids) => runtimesAt(engine.root, ids ?? [])[0] ?? null;
transport = new Transport({
  getScope: () => path.slice(1).map((l) => l.id),
  getSong: (ids) => { const rt = scopeRt(ids); return rt ? layerSong(rt) : emptySong(); },
  getBpm: (ids) => scopeRt(ids)?.bpm ?? engine.root.bpm,
  getTarget: targetIn(engine.root),
  getLayers: (ids) => songLayers(engine.root, engine.song, ids ?? [], { nested: false }),
  pitchOffset: (ids) => scopeRt(ids)?.pitchOffset ?? 0,
});
// live notes (computer keyboard, on-screen piano keys) go to the red MIDI module
const firstLive = (rt) => [...rt.modules.values()].find((e) => takesLiveMidi(e.def)) ?? null;
const liveMidiEntry = () => modulePreview?.target ?? midiTarget() ?? firstLive(shown()) ?? firstLive(engine.root);
seq = createSequencer({
  engine,
  pianorollPreferences,
  timelineDisplay,
  transport,
  getSong: () => layerSong(shown()),
  getPatch: () => shown(),
  getTarget: (id) => targetIn(shown())(id),
  liveTarget: () => liveMidiEntry()?.inst ?? null,
  pitchOffset,
  // new clips play the module selected in the patcher (or the last selected one that takes MIDI)
  selectedTarget: () => clipTarget(shown()),
  // without one: this level's MIDI module, else its first module that takes MIDI
  defaultTarget() {
    return layerMidi(shown())?.id ?? [...shown().modules.values()].find((e) => e.def.acceptsMidi)?.id ?? null;
  },
  // new automation clips drive the module selected on this level (else the clip's / first module)
  defaultAutoTarget() {
    if (sel?.entry && shown().modules.get(sel.entry.id) === sel.entry) return sel.entry.id;
    return null;
  },
  undoHistory: {
    record: () => {
      // Sequencer callbacks finish an edit; do not debounce separate notes or gestures together.
      undoHistory?.record();
      undoHistory?.flush();
    },
    travel: (direction) => undoHistory ? undoHistory.travel(direction) : false,
  },
  onChange: () => {
    persist.schedule();
    if (sel?.entry?.def.isOutput) panelRefresh?.();
  },
});
undoHistory = createHistory({
  capture() {
    const project = engine.saveProject();
    return { ...project, song: { ...project.song, selected: null } };
  },
  async restore(project) {
    const ids = path.slice(1).map((level) => level.id);
    const cameras = path.map((level) => level.cam);
    const selected = engine.song.selected;
    const layers = layerView();
    if (project.song) {
      project.song.selected = project.song.clips?.some((clip) => clip.id === selected) ? selected : null;
    }
    transport.stop();
    await engine.loadProject(project);
    path = patchAt(ids).map((level, i) => ({ ...level, cam: cameras[i] }));
    applyLayerView(layers);
    seq.reload();
    render();
    persist.schedule();
  },
});
undoHistory.reset();
const saved = await persist.loadAll();
let restored = null;
for (const { state, source } of saved.copies) {
  try {
    await undoHistory.suspend(() => persist.pause(() => engine.loadProject(state)));
    applyView(state.view);
    projectFile.restore(state.doc); // file name and unsaved state of the restored project
    restored = source;
    break;
  } catch (err) {
    console.error(`Could not restore autosave from ${source}:`, err);
    persist.keepBroken(state);
  }
}
if (!restored) {
  await undoHistory.suspend(() => persist.pause(() => engine.loadProject(emptyProject())));
  path = [{ patch: engine.root, name: 'Main' }];
  seq.applyView(null);
  render();
  projectFile.reset();
}
undoHistory.reset();
if (restored || saved.copies.length) $('status').textContent = restored ? `Restored from ${restored}` : 'Autosave unreadable, started empty';
persist.start();
let nativeExitWaiting = false;
window.modsynthExit?.onRequest(() => {
  closeMenu();
  if (nativeExitWaiting) return;
  const dialog = document.querySelector('dialog[open]');
  const request = () => exitToOS(persist, (message) => { $('status').textContent = message; });
  if (!dialog || dialog.id === 'confirm-dialog' && $('confirm-title').textContent === 'Exit to OS?') {
    request();
  } else {
    nativeExitWaiting = true;
    dialog.addEventListener('close', () => {
      nativeExitWaiting = false;
      request();
    }, { once: true });
  }
});
// driven controller values that are still waiting for the throttled autosave are written too
const flushAll = () => {
  if (driveSaveTimer) persist.schedule();
  persist.flushNow();
};
window.addEventListener('pagehide', flushAll);
connectLiveReload(flushAll);
midi = initMidi({
  getTarget: () => modulePreview?.target ?? midiTarget(),
  pitchOffset: () => modulePreview ? 0 : pitchOffset(),
  selected: preferencesManager.get(MIDI_INPUT_ID),
  onStatus: (msg) => ($('status').textContent = msg),
  onActivity: () => engine.resume(),
  onNoTarget: () => ($('status').textContent = 'MIDI note received, but no module to play: select a module that takes MIDI (e.g. OSC).'),
});
midi.enable();
// Q..P (and the number row) play the current MIDI module, else the first one in the main patch
initKeyboard({
  getTarget: liveMidiEntry,
  pitchOffset,
  onActivity: () => engine.resume(),
  onNoTarget: () => ($('status').textContent = 'No module to play: add a module that takes MIDI (e.g. OSC) to hear the Q..P keys.'),
});

// wall clock (HH:MM, 24 h) on the lower divider; re-aligned to every minute boundary
(function startClock() {
  const el = $('clock');
  if (!el) return;
  const tick = () => {
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    el.textContent = hm;
    el.dateTime = hm;
    setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  };
  tick();
})();
