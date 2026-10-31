import { Engine } from './engine.js';
import { modules, getModule } from './modules/index.js';
import { initMidi } from './midi.js';
import { createPersistence, connectLiveReload } from './persist.js';
import { paramsOf, toNorm, wheelNotches } from './params.js';
import { initCpuMeter } from './cpumeter.js';
import { createController } from './controller.js';
import { linePath, arrowPath, centerOf, visibleSegment } from './cable.js';
import { Transport } from './transport.js';
import { confirmDialog } from './dialogs.js';
import { exitToOS } from './exit.js';
import { createSequencer } from './seq/index.js';
import { defaultCam, validCam, toWorld, zoomAt, fitBox, ZOOM_STEP } from './camera.js';
import { initWidgets } from './widgets.js';
import { snapStep } from './song.js';
import { CableScope } from './cablescope.js';
import { openMapDialog, patchControllersView } from './mapdialog.js';
import { MAX_NAME, cableSignals } from './patch.js';
import { showMenu, shortcut } from './seq/menu.js';
import { rightHold } from './seq/surface.js';

const engine = new Engine();
let transport = null; // song playback (created after the engine)
let seq = null; // piano roll + TimeLine UI
let scope = null; // live audio drawn on the cables (created after the engine)
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const svg = $('cables');
const world = $('world');
const panel = $('panel-content');
const dialog = $('insert-dialog');
const moduleList = $('module-list');
const SVGNS = 'http://www.w3.org/2000/svg';

let path = []; // stack of { patch, name, id, cam }: the patch levels we have entered (id = Patch module number)
let sel = null; // { kind: 'module', entry } | { kind: 'group', entries } | { kind: 'cable', cable }
const selectedEntries = () => (sel?.kind === 'module' ? [sel.entry] : sel?.kind === 'group' ? sel.entries : []);
// Selection from a list of modules: none, one (shows its controllers) or a group.
const selectEntries = (entries) => select(entries.length > 1 ? { kind: 'group', entries } : entries.length ? { kind: 'module', entry: entries[0] } : null);
// MIDI goes to the last selected MIDI-capable module. Selecting an audio-only module (Filter, Output),
// a cable or empty canvas never changes it. If that module is deleted, MIDI falls back to the
// previously used MIDI module that still exists.
// Modules with liveMidi: false (VELOCITY2CTL) only get notes from clips and MIDI cables.
const takesLiveMidi = (def) => !!def?.acceptsMidi && def.liveMidi !== false;
let midiHistory = []; // most recent last
const midiTarget = () => {
  while (midiHistory.length && midiHistory.at(-1).dead) midiHistory.pop();
  return midiHistory.at(-1) ?? null;
};
function setMidiTarget(entry) {
  const prev = midiTarget();
  if (prev === entry) return;
  prev?.inst.allOff?.();
  midiHistory = midiHistory.filter((e) => e !== entry && !e.dead);
  midiHistory.push(entry);
  persist.schedule();
}
let dropPos = { x: 0, y: 0 };
const current = () => path[path.length - 1].patch;

// ---- camera (pan / zoom), one per patch level ----
const cam = () => (path[path.length - 1].cam ??= defaultCam());
// client (pointer) coordinates -> world coordinates of the current patch
function clientToWorld(cx, cy) {
  const r = canvas.getBoundingClientRect();
  return toWorld(cam(), cx - r.left, cy - r.top);
}
function applyCam() {
  const { x, y, z } = cam();
  world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  canvas.style.backgroundSize = `${22 * z}px ${22 * z}px`;
  canvas.style.backgroundPosition = `${x}px ${y}px`;
  $('zoom').textContent = `${Math.round(z * 100)}%`;
}
function setCam(c) {
  path[path.length - 1].cam = c;
  applyCam();
  persist.schedule();
}
function fitAll() {
  const mods = [...current().modules.values()];
  if (!mods.length) return setCam(defaultCam());
  const box = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };
  for (const m of mods) {
    box.l = Math.min(box.l, m.x);
    box.t = Math.min(box.t, m.y);
    box.r = Math.max(box.r, m.x + m.el.offsetWidth);
    box.b = Math.max(box.b, m.y + m.el.offsetHeight);
  }
  setCam(fitBox(box, canvas.clientWidth, canvas.clientHeight));
}
$('zoom').onclick = fitAll;
$('zoom').addEventListener('pointerdown', (e) => e.stopPropagation());

// Mouse wheel: zoom around the pointer (trackpad pinch arrives as Ctrl + wheel, same thing).
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  setCam(zoomAt(cam(), e.clientX - r.left, e.clientY - r.top, Math.pow(ZOOM_STEP, wheelNotches(e.deltaY, e.deltaMode))));
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
const persist = createPersistence({
  getState: () => ({ ...engine.saveProject(), view: viewState() }),
  onSaved: ({ local, disk, at }) => {
    const t = new Date(at).toLocaleTimeString();
    $('saved').textContent = disk ? `Saved to disk ${t}` : local ? `Saved in browser ${t}` : 'Not saved!';
    $('saved').title = disk ? 'projects/autosave.json (+ browser storage)' : 'Browser localStorage only. Run "node server.mjs" to also save to disk.';
    $('saved').classList.toggle('error', !local && !disk);
  },
});
engine.onChange = () => persist.schedule();

// Path (list of module numbers) from the root patch to the patch containing `entry`.
function locate(entry, patch = engine.root, trail = []) {
  for (const e of patch.modules.values()) {
    if (e === entry) return trail;
    if (e.inst.patch) {
      const found = locate(entry, e.inst.patch, [...trail, e.id]);
      if (found) return found;
    }
  }
  return null;
}

function viewState() {
  const midi = midiTarget();
  const midiPath = midi && locate(midi);
  return {
    path: path.slice(1).map((l) => l.id),
    cams: path.map((l) => l.cam ?? defaultCam()),
    seq: seq?.viewState(),
    midi: midiPath ? { path: midiPath, id: midi.id } : null,
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
  path.forEach((l, i) => {
    if (view?.cams?.[i]) l.cam = validCam(view.cams[i]);
  });
  seq?.applyView(view?.seq);
  midiHistory = [];
  if (view?.midi) {
    const levels = patchAt(view.midi.path);
    if (levels.length === view.midi.path.length + 1) {
      const e = levels.at(-1).patch.modules.get(view.midi.id);
      if (takesLiveMidi(e?.def)) midiHistory.push(e);
    }
  }
  render();
}

async function openProject(data, view) {
  transport.stop();
  await persist.pause(() => engine.loadProject(data));
  seq.reload();
  applyView(view);
  persist.schedule();
}

// insert dialog list: one row per module type (colour, type, description)
let insertType = modules[0]?.type ?? null;
const listItems = modules.map((m) => {
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
  return li;
});
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
  const w = clientToWorld(e.clientX, e.clientY);
  dropPos = { x: Math.round(w.x), y: Math.round(w.y) };
  dialog.returnValue = '';
  chooseType(insertType); // the last inserted type stays selected
  dialog.showModal();
  moduleList.focus();
});

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
  const fit = !path[path.length - 1].cam;
  world.querySelectorAll('.module').forEach((el) => el.remove());
  applyCam();
  for (const entry of current().modules.values()) createBox(entry);
  if (fit && canvas.clientWidth > 0 && canvas.clientHeight > 0) fitAll();
  drawCables();
  renderCrumbs();
  select(null);
  persist.schedule(); // remember which patch level is open
}

function renderCrumbs() {
  const nav = $('crumbs');
  nav.replaceChildren();
  path.forEach((lvl, i) => {
    if (i) nav.append('/');
    const b = document.createElement('button');
    b.textContent = lvl.name;
    b.classList.toggle('current', i === path.length - 1);
    b.onclick = () => { path.length = i + 1; render(); };
    nav.append(b);
  });
}

// Type colour (def.color) as the --mod-color CSS variable; modules without one stay grey.
function setColor(el, def) {
  if (def?.color && !def.isOutput) el.style.setProperty('--mod-color', def.color);
}

// Name on a module box: its custom name (see rename) or the default from its type.
const defaultName = (def) => (def.isOutput ? 'Output' : def.type === 'PATCH' ? 'Patch' : def.type);
function showName(entry, el = entry.el?.querySelector('.module-name')) {
  if (!el) return;
  el.textContent = entry.name ?? defaultName(entry.def);
  el.classList.toggle('custom', !!entry.name);
  el.title = entry.name ? `${entry.name} (${entry.def.label})` : '';
}

// Patch modules: open (Enter or the right-click menu); Esc goes up again
function openPatch(entry) {
  if (!entry?.inst.patch) return;
  path.push({ patch: entry.inst.patch, name: `Patch #${entry.id}`, id: entry.id });
  render();
}

// Rename in place: an input over the module's name. Enter / leaving it keeps the name, Escape
// cancels; an empty name restores the default.
// Double-click a module, F2 or the right-click menu start it.
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
  setColor(el, def);
  el.style.left = `${entry.x}px`;
  el.style.top = `${entry.y}px`;
  const name = document.createElement('span');
  name.className = 'module-name';
  showName(entry, name);
  const num = document.createElement('span');
  num.className = 'module-id';
  num.textContent = entry.id;
  el.append(name, num);
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
      else startDuplicate(e, copyable);
      return;
    }
    const start = group.map((m) => ({ m, x: m.x, y: m.y }));
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev) => {
      for (const { m, x, y } of start) {
        m.x = Math.round(x + (ev.clientX - sx) / cam().z);
        m.y = Math.round(y + (ev.clientY - sy) / cam().z);
        m.el.style.left = `${m.x}px`;
        m.el.style.top = `${m.y}px`;
      }
      drawCables();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      persist.schedule();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(entry);
  });
  world.appendChild(el);
}

// ---- Alt + drag: duplicate ----
let suppressAltUp = false;
function startDuplicate(e, entries) {
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
  const move = (ev) => {
    dx = Math.round((ev.clientX - e.clientX) / cam().z);
    dy = Math.round((ev.clientY - e.clientY) / cam().z);
    for (const { m, g } of ghosts) {
      g.style.left = `${m.x + dx}px`;
      g.style.top = `${m.y + dy}px`;
    }
  };
  const up = async (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    suppressAltUp = true; // Alt released after the drag must not open the browser menu bar
    const done = () => ghosts.forEach(({ g }) => g.remove());
    if (ev.type === 'pointercancel' || Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) { done(); return; }
    try {
      const copies = await patch.duplicateMany(entries.map((m) => m.id), dx, dy);
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
  const live = []; // audio and modulation cables that show their signal
  for (const cable of patch.cables) {
    const a = patch.modules.get(cable.from);
    const b = patch.modules.get(cable.to);
    const signals = cableSignals(a.def, b.def);
    const ra = boxOf(a);
    const rb = boxOf(b);
    const { from, to } = visibleSegment(ra, rb); // arrow and audio wave go on the visible part
    const g = document.createElementNS(SVGNS, 'g');
    g.classList.add('cable');
    g.cable = cable; // for the right-click menu
    g.classList.toggle('selected', sel?.cable === cable);
    g.classList.toggle('mod', !!a.def.modulator);
    g.classList.toggle('midi', signals.midi && !signals.audio);
    setColor(g, a.def);
    const wire = document.createElementNS(SVGNS, 'path');
    wire.classList.add('wire');
    wire.setAttribute('d', linePath(centerOf(ra), centerOf(rb)));
    const arrow = document.createElementNS(SVGNS, 'path');
    arrow.classList.add('arrow');
    arrow.setAttribute('d', arrowPath(from, to));
    g.append(wire, arrow);
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      select({ kind: 'cable', cable });
    });
    svg.append(g);
    const h = signals.audio || a.def.modulator ? a.inst?.node?.h : undefined;
    if (h !== undefined) live.push({ g, h, from, to });
  }
  scope?.setCables(live);
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
  let over = null; // module element under the pointer (already handled)
  const toggle = (el) => {
    const toId = +el.dataset.id;
    const existing = patch.cables.find((c) => c.from === entry.id && c.to === toId);
    const ok = existing ? (patch.disconnect(existing), true) : patch.connect(entry.id, toId);
    if (!ok) {
      $('status').textContent = 'Cannot connect (duplicate, loop, or this module has no input of that kind).';
      return;
    }
    drawCables(); // clears the svg: put the temporary cable back on top
    svg.append(temp);
    el.classList.remove('cable-hit', 'cable-cut');
    void el.offsetWidth; // restart the flash animation
    el.classList.add(existing ? 'cable-cut' : 'cable-hit');
    el.addEventListener('animationend', () => el.classList.remove('cable-hit', 'cable-cut'), { once: true });
  };
  const move = (ev) => {
    const seg = visibleSegment(box, null, clientToWorld(ev.clientX, ev.clientY));
    wire.setAttribute('d', linePath(centerOf(box), seg.to));
    arrow.setAttribute('d', arrowPath(seg.from, seg.to));
    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.module:not(.ghost)') ?? null;
    if (el === over) return;
    over = el;
    if (el && el !== entry.el && patch.modules.has(+el.dataset.id)) toggle(el);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    temp.remove();
    select(sel); // refresh the panel: e.g. an LFO's Out Controller names follow its cables
  };
  over = entry.el; // starting on the source: nothing to do until the pointer leaves it
  move(e);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// ---- selection, deletion ----
// Drag on empty canvas: selection rectangle. Modules touching it get selected
// (Ctrl/⌘ adds to the current selection). A plain click clears the selection.
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || (e.target !== canvas && e.target !== svg && e.target !== world)) return;
  e.preventDefault();
  const additive = e.ctrlKey || e.metaKey;
  const base = additive ? selectedEntries() : [];
  if (!additive) select(null);
  const c = canvas.getBoundingClientRect();
  const x0 = e.clientX - c.left;
  const y0 = e.clientY - c.top;
  const box = document.createElement('div');
  box.className = 'select-rect';
  let shown = false;
  const move = (ev) => {
    const x1 = ev.clientX - c.left;
    const y1 = ev.clientY - c.top;
    if (!shown && Math.hypot(x1 - x0, y1 - y0) < 3) return;
    if (!shown) { canvas.appendChild(box); shown = true; }
    const r = { l: Math.min(x0, x1), t: Math.min(y0, y1), r: Math.max(x0, x1), b: Math.max(y0, y1) };
    Object.assign(box.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.r - r.l}px`, height: `${r.b - r.t}px` });
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
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    box.remove();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});

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
    const added = await patch.pasteMany(clipboard, w ? { x: Math.round(w.x), y: Math.round(w.y) } : {});
    if (patch !== current()) return;
    render();
    selectEntries(added);
    $('status').textContent = `Pasted ${added.length} module(s).`;
  } catch (err) {
    $('status').textContent = `Paste failed: ${err.message}`;
  }
}

// Right-click menu (hold the right button 500 ms, or the keyboard menu key): on a module (it joins /
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
  if (onModule) items.push('-', { label: 'Rename…', shortcut: 'F2', disabled: mods.length > 1, action: () => startRename(entry) });
  if (onModule && entry.name) items.push({ label: 'Reset name', action: () => { current().rename(entry.id, ''); showName(entry); drawCables(); } });
  showMenu({ x, y, items });
}
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 2 || e.target.closest('input, .module-rename')) return;
  e.preventDefault();
  const patch = current();
  const target = e.target;
  rightHold(canvas, e, {
    onHold: () => { if (patch === current() && target.isConnected) openPatcherMenu(target, e.clientX, e.clientY); },
  });
});
canvas.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, .module-rename')) return;
  e.preventDefault();
  if (e.button === 2 || e.ctrlKey) return; // mouse: the menu needs a 500 ms hold
  // keyboard menu key / Shift+F10: open at the selected module, the pointer or the canvas centre
  const box = selectedEntries()[0]?.el;
  const r = (box ?? canvas).getBoundingClientRect();
  const p = box ? { x: r.left + 8, y: r.top + 8 } : lastPointer ?? { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  openPatcherMenu(box ?? canvas, p.x, p.y);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && path.length && !document.querySelector('dialog[open]')) {
    if (e.repeat) return;
    if (path.length > 1) {
      path.pop();
      render();
    } else if (!e.defaultPrevented && !e.target.closest('input, select, textarea, dialog, #seq, #arranger')) {
      e.preventDefault();
      exitToOS(persist, (message) => { $('status').textContent = message; });
    }
    return;
  }
  if (e.target.closest('input, select, textarea, dialog, #seq, #arranger')) return; // the sequencer handles its own keys
  const command = (e.ctrlKey || e.metaKey) && !e.altKey;
  const k = e.key.toLowerCase();
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
function panelHeader(title, sub, def) {
  const h = document.createElement('div');
  h.className = 'panel-header';
  setColor(h, def);
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

function select(s) {
  sel = s;
  if (s?.kind === 'module' && takesLiveMidi(s.entry.def)) setMidiTarget(s.entry);
  const target = midiTarget();
  const chosen = new Set(selectedEntries().map((m) => m.el));
  document.querySelectorAll('.module:not(.ghost)').forEach((el) => {
    el.classList.toggle('selected', chosen.has(el));
    el.classList.toggle('midi-target', target?.el === el);
  });
  drawCables();
  panel.replaceChildren();
  panelRows.clear();
  panelView = null;
  if (s?.kind === 'cable') {
    panel.append(panelHeader('Cable', `#${s.cable.from} → #${s.cable.to}`));
    const patch = current();
    const lfo = patch.modules.get(s.cable.from);
    if (lfo?.def.routeParams) {
      const t = patch.modules.get(s.cable.to);
      const names = lfo.def.routeParams(lfo, t).map((pid) => {
        const i = paramsOf(t).findIndex((q) => q.id === pid);
        return i < 0 ? null : `<kbd>${i}</kbd> ${paramsOf(t)[i].label}`;
      }).filter(Boolean);
      panel.append(hint(names.length
        ? `Control cable: <b>Value</b> drives ${names.join(', ')}.`
        : 'Control cable: no controller of this module is routed yet. Select the MULTICTL and pick one under <b>Routes</b>.'));
    } else if (lfo?.def.modulator) {
      const n = lfo.values.outController | 0;
      const p = paramsOf(patch.modules.get(s.cable.to))[n];
      panel.append(hint(`Control cable: modulates controller <kbd>${n}</kbd> ${p ? p.label : '(does not exist on this module)'}.`));
    }
    if (lfo?.def.midiOut) {
      const signals = cableSignals(lfo.def, patch.modules.get(s.cable.to).def);
      if (signals.midi) panel.append(hint(`${signals.audio ? 'Audio + MIDI' : 'MIDI'} cable: carries MODMIDI notes (float pitch, velocity and start phase).`));
    }
    panel.append(hint('Press <kbd>Backspace</kbd> to remove this cable.'));
    return;
  }
  if (!s) {
    panel.append(
      panelHeader('No selection', ''),
      hint('<kbd>Double-click</kbd> the canvas to insert a module.'),
      hint('<kbd>Shift</kbd> + drag from a module and move over other modules: each one you touch gets connected (or disconnected when already connected), so one module can feed many in one sweep.'),
      hint('Drag on empty canvas to select several modules. <kbd>Ctrl</kbd> + click toggles a module, <kbd>Ctrl</kbd> + drag adds, <kbd>Ctrl</kbd> + <kbd>A</kbd> selects all.'),
      hint('<kbd>Alt</kbd> + drag a module to duplicate it (or the whole selection).'),
      hint('<kbd>Backspace</kbd> deletes the selection.'),
      hint('<b>Context menus:</b> everywhere (patcher, piano roll, velocity lane, TimeLine) hold the <kbd>right</kbd> mouse button still for <b>500 ms</b> to open the menu; moving 5 px or more first cancels it. A short right-click keeps its own action (delete a note / point, remove a time signature) or does nothing.'),
      hint(`Hold right-click on a module, cable or the canvas for <b>Cut / Copy / Paste / Delete</b> (or press the keyboard menu key; shortcuts <kbd>${shortcut('X')}</kbd> <kbd>${shortcut('C')}</kbd> <kbd>${shortcut('V')}</kbd>; paste lands at the mouse pointer). <b>Rename…</b> (or <kbd>F2</kbd>) gives a module its own name on its box; the controller panel keeps showing the module type.`),
      hint('<kbd>Double-click</kbd> a module (or <kbd>F2</kbd>) to rename it. Select a Patch and press <kbd>Enter</kbd> (or hold right-click → Open patch) to enter it, <kbd>Esc</kbd> to go up. At the main layer, <kbd>Esc</kbd> asks <b>Exit to OS?</b>; Yes autosaves and closes the app.'),
      hint('Select a Patch and click <b>Controllers…</b> to map controllers of any module inside to controllers of the Patch module, so they can be set, modulated (LFO) and automated from outside.'),
      hint('OSC / ADSR: with <b>Sustain</b> at 0, <b>Decay</b> and <b>Release</b> are linked: moving one moves the other.'),
      hint('<kbd>Middle mouse</kbd> + drag pans the canvas, <kbd>scroll</kbd> zooms. Click the zoom % (bottom right) to fit all modules.'),
      hint('Play with a MIDI controller or keys <kbd>A</kbd>–<kbd>;</kbd>.'),
      hint('<b>Sequencer</b> (piano roll above the patcher, TimeLine below; <kbd>S</kbd> maximizes the patcher, <kbd>S</kbd> again restores both panes): <kbd>Double-click</kbd> the TimeLine to add a clip, drag its edges to resize, <kbd>Alt</kbd> + drag to copy. In the piano roll click / drag to write notes (new notes get the last used length), drag a note body for its length (the end jumps to the pointer, snapped to the grid), its circle for pitch and time. A short right-click deletes the note under the pointer; hold the right button for <b>500 ms</b> to open the menu instead (cut / copy / paste / delete / duplicate / quantize / octave). Releasing after the menu opens never deletes a note. <kbd>Space</kbd> plays. <kbd>Double-click</kbd> the TimeLine ruler to insert a time signature change (right-click it to remove). Selecting a clip while stopped moves the playhead to its start (during playback it keeps playing).'),
      hint('<b>Piano roll selection:</b> <kbd>Shift</kbd> + drag or <kbd>right</kbd> + drag draws a selection rectangle; clicking a note selects it, <kbd>Shift</kbd> + click toggles it. Dragging a selected note moves / resizes the whole selection. <kbd>Ctrl/Cmd</kbd> + <kbd>D</kbd> duplicates the selection, <kbd>Q</kbd> quantizes note starts (selection, else all). <kbd>Ctrl/Cmd</kbd> + <kbd>A</kbd> selects all notes, <kbd>Esc</kbd> clears the selection, and <kbd>Backspace</kbd> / <kbd>Delete</kbd> deletes it. <kbd>Alt</kbd> + drag a note (body or circle) moves a clone.'),
      hint('<b>Arrow keys:</b> in the piano roll, <kbd>Left</kbd> / <kbd>Right</kbd> transpose selected notes by one semitone; <kbd>Up</kbd> / <kbd>Down</kbd> move them earlier/later by one snap step. With <kbd>Shift</kbd>: an octave / a bar. The selection moves together and stops at time zero or the MIDI pitch limits.'),
      hint('<b>Velocity:</b> the strip left of the piano roll shows every note\'s velocity (stick) and how it changes while the note sounds. Drag a note\'s dot to set its velocity (<kbd>Shift</kbd>-click adds it to the selection). The selected notes share one curve: <kbd>Double-click</kbd> inside them to add a point, drag points (time snaps, <kbd>Shift</kbd> = fine), and use the mouse wheel on a point to round it. Hold right-click on the lane to toggle <b>Snap velocity values</b> (1/16 increments, enabled by default, no grid); a short right-click on a point deletes it (also <b>Delete point</b> in the menu). The snap setting is saved with the project and only affects new edits. One selected note edits its own curve.'),
      hint('<b>Automation:</b> <kbd>Double right-click</kbd> the TimeLine to add an automation clip, then pick the module (<i>Send to</i>) and its <i>Controller</i> in the toolbar. In the automation lane <kbd>Double-click</kbd> inserts a point (snapped to the grid), drag moves it (<kbd>Shift</kbd> = fine), the mouse wheel on a point rounds the corner and right click deletes it. While playing, the clip drives the controller like an LFO; outside the clip (or when stopped) the controller has its own value again.'),
      hint('<b>Sequencer clipboard:</b> click the piano roll or TimeLine to focus it, then use <kbd>Ctrl/Cmd</kbd> + <kbd>X</kbd> / <kbd>C</kbd> / <kbd>V</kbd> to cut / copy / paste selected notes or the selected clip. Each view has its own in-app clipboard. Paste at the mouse pointer, snapped to the grid; note pitches and relative timing are preserved.'),
      hint('<b>TimeLine selection &amp; clones:</b> drag on empty TimeLine space for a selection rectangle (<kbd>Ctrl/Cmd</kbd> adds), <kbd>Ctrl/Cmd</kbd> + click toggles a clip. Dragging moves the whole selection; <kbd>Alt</kbd> + drag copies it, <kbd>Shift</kbd> + drag makes <i>linked clones</i> that share their notes with the source (marked ⧉): editing one edits all. Clones are drawn with diagonal stripes and a dashed outline; a selected clone shows a dashed arrow to its source. Hold right-click on a clip for cut / copy / paste / delete / duplicate / clone / detach (turns a clone into a standalone clip) / go to source. <kbd>Ctrl/Cmd</kbd> + <kbd>D</kbd> duplicates, <kbd>Ctrl/Cmd</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> clones.'),
      hint('<b>Sequencer undo:</b> <kbd>Ctrl/Cmd</kbd> + <kbd>Z</kbd> undoes TimeLine / piano roll / automation edits, <kbd>Ctrl/Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd> (or <kbd>Ctrl</kbd> + <kbd>Y</kbd>) redoes.'),
      hint('<b>Loop region:</b> click the TimeLine ruler to set the play position, drag along it to select a loop region (snapped to the grid, shown in blue). Song playback then loops inside the region and starts at its beginning. Right-click the region in the ruler to remove it; playback goes back to looping the whole song.'),
      hint('<b>TimeLine lanes:</b> clips sit on numbered lanes (the numbers left of the clips), one clip high; dragging up / down snaps to them. Scroll left past the bright zero line to park clips before the song start: they are not played (<kbd>/</kbd> still auditions them), which suits source clips whose clones make up the song.'),
      hint('<b>TimeLine placement:</b> moving, cloning, pasting or creating a clip snaps it to the nearest non-overlapping position. Clip edges take priority over the time grid; resizing stops at neighbouring clips. Use separate vertical rows for clips that play at the same time. The Start and Length fields follow these rules too.'),
      hint('<b>Playback:</b> <kbd>/</kbd> starts and loops only the selected clip from its start. <kbd>\'</kbd> stops playback; pressing <kbd>\'</kbd> again is a panic (all notes off, echo / reverb tails cut, all audio state reset). <kbd>.</kbd> plays/resumes the full song, and <kbd>,</kbd> restarts the song at zero. <kbd>Space</kbd> toggles play/stop; stopping with <kbd>Space</kbd> (or the ■ button) moves the playhead to the start of the selected clip, so the next <kbd>Space</kbd> plays from there. Shortcuts are inactive while typing in a field. Note chasing: starting or jumping into the middle of a note plays it for the rest of its length.'),
      hint('<b>Controls:</b> scroll a dropdown to change its selection. Number fields have permanent up/down buttons and also support scrolling; <kbd>Double-click</kbd> a number (or use <kbd>Tab</kbd>) to type. Mouse adjustments leave keyboard focus in the editor so <kbd>Space</kbd> still plays.'),
      hint('<b>Toolbar:</b> controls stay on one row. When space is tight, move the pointer toward the left or right edge to reveal hidden controls; the closer to the edge, the faster it moves. Move to the middle to stop. Clicking, typing or using the wheel pauses motion; the wheel still changes control values. <kbd>Tab</kbd> also reveals focused controls.'),
      hint('<b>Layout:</b> piano roll, patcher and TimeLine are stacked top to bottom. Drag either horizontal divider up/down; when the patcher closes, the dragged divider pushes the other one. Drag to an edge to hide a pane and back to reopen it. Positions are saved with the project. The piano keyboard stays at the bottom of the roll; selected notes are filled blue.'),
      hint('The piano roll fits all <b>128 MIDI notes (0–127)</b> across its width and rescales with the window width. Horizontal zoom is automatic; <kbd>Alt</kbd> + scroll no longer changes key width. Scroll upward to reveal a small margin above beat zero. <kbd>Ctrl/Cmd</kbd> + scroll still zooms time.'),
      hint('Drag the left controller-panel divider to resize the panel, or fully left to hide it. Its handle stays available to reopen it, and the width is saved with the project.'),
      hint('All three dividers resize the controller panel when dragged left/right. Dragging the controller-panel divider up/down also moves the upper horizontal divider. Each horizontal divider supports <kbd>Up</kbd>/<kbd>Down</kbd> (hold <kbd>Shift</kbd> for larger steps) and <kbd>Home</kbd>/<kbd>End</kbd> to reach the edges. Every divider shows a small four-dot grip.'),
      hint('<b>Piano roll colors:</b> charcoal paper keeps the stave dark rather than inverted. Notes use a lighter version of their module color; black-key bodies are slightly darker, including in blue selections, so dense chromatic chords retain the keyboard pattern.'),
      hint('The piano-roll snap bands and horizontal grid/bar lines run from the center of <b>A#0</b> to the center of <b>A#7</b> (American notation). Notes outside this range can still be edited and played.'),
    );
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
      setColor(li, m.def);
      li.onclick = () => select({ kind: 'module', entry: m });
      list.append(li);
    }
    panel.append(
      list,
      hint('Drag any selected module to move them together.'),
      hint('<kbd>Alt</kbd> + drag duplicates the selection, including the cables between them.'),
      hint('<kbd>Backspace</kbd> deletes them (the Output module stays).'),
    );
    return;
  }

  const entry = s.entry;
  const header = panelHeader(entry.def.label, `#${entry.id}`, entry.def);
  panel.append(header);
  const explanations = document.createDocumentFragment();
  if (entry.def.type === 'SOUND2CTL') {
    explanations.append(hint('Cable an audio source into this module, then cable this module to the module to control and select <kbd>Out Controller</kbd>. Voltage -1 = <kbd>Out Min</kbd>, +1 = <kbd>Out Max</kbd>; silence (0) is halfway. Stereo channels are averaged and voltage is clamped to -1..1. Direct voltage conversion, not an envelope follower: the last sample of each audio block controls the next block (128 samples).'));
  }
  if (entry.def.type === 'VELOCITY2CTL') {
    explanations.append(hint('The velocity of the newest incoming note (and its velocity curve while it sounds) sets the controller: velocity 0 = <kbd>Out Min</kbd>, 127 = <kbd>Out Max</kbd>. When the note ends, <kbd>Noteoff Action</kbd> holds the value (Do Nothing) or moves it to <kbd>Out Min</kbd> (Control Down) or <kbd>Out Max</kbd> (Control Up).'));
  }
  if (entry.def.type === 'OSC') {
    explanations.append(hint('<b>Half sine:</b> one positive sine bow followed by zero. <b>Duty Cycle</b> sets the bow length: 100% fills the period, 25% fills its first quarter, and 0% is silent. <b>Noise</b> (white, pink, brown, blue, violet: dark to bright) ignores the note pitch; every note gets its own noise, shaped by the envelope and velocity.'));
  }
  if (entry.def.type === 'DELAY') {
    explanations.append(hint('<b>Left Delay</b> delays left audio and each incoming MODMIDI message; <b>Right Delay</b> delays right audio only. No dry signal or feedback. Cables carry audio, MIDI, or both, according to the destination. Notes keep their pitch, velocity and start phase. Changing the delay affects new messages, not ones already queued; a release that overtakes its pending note cancels that note. MIDI delivery runs on the audio-clock reports (about every 5 ms).'));
  }
  if (entry.def.type === 'ECHO') {
    explanations.append(hint('<b>STEREO</b> repeats left and right together, preserving their separation. <b>PINGPONG</b> averages the input into a left-first echo, then alternates sides. <b>Filter</b> processes the first echo and every feedback repeat; dry audio is unaffected. Feedback is limited to 99%. At 0 ms, the echo uses a one-sample delay.'));
  }
  if (entry.def.type === 'MODULATOR') {
    explanations.append(hint('<b>Carrier</b> selects an audio input; all other audio inputs are summed as the modulator, separately for left and right. Inputs are numbered in cable connection order; changing cables can change their numbering. <b>Amp modulation</b> multiplies carrier by modulator (no modulator means silence). Add/Subtract and Min/Max combine those same two signals; Min/Max abs chooses by magnitude and keeps the chosen signal’s sign.'));
    explanations.append(hint('<b>Phase modulation</b> is a variable delay: modulator -1 = 0 ms, 0 = 20 ms, +1 = 40 ms. <b>Absolute</b> uses the modulator’s magnitude: 0 = 0 ms, either -1 or +1 = 40 ms. Larger levels are clamped. Interpolation is Off (nearest sample), Linear or Spline (cubic). <b>Bitwise AND/XOR</b> clamps and quantizes each signal to signed 16-bit audio before combining the bits.'));
  }
  if (entry.def.type === 'DELAY' || entry.def.type === 'ECHO') {
    explanations.append(hint('<b>Delay Unit:</b> ms gives 0–10,000 milliseconds. In 1/4, 1/8 or 1/16 mode, the same slider selects musical lengths from 1/4 to 64 of that note unit, synced to this patch’s Output BPM (including dotted and triplet lengths). Audio delay changes glide to avoid abrupt jumps.'));
  }
  if (entry.def.type === 'MULTIMIDI') {
    explanations.append(hint('<kbd>Shift</kbd> + drag to an OSC, Patch or another MultiMIDI. Every note drifts on its own. Several MultiMIDIs can feed one synth in parallel (each plays its own voices); chained ones add up. <b>Random Phase</b> starts every note at its own random point of the OSC waveform cycle (0 % = all start at the beginning, 100 % = anywhere).'));
  }
  if (entry.def.routeParams) {
    explanations.append(hint('<kbd>Shift</kbd> + drag over the modules to control, then pick their controllers under <b>Routes</b>. <b>Value</b> sets all of them at once (inside <kbd>Out Min</kbd>..<kbd>Out Max</kbd> of each slider). A controller picked on one module is also routed on connected modules of the same type that have no route yet, and newly connected ones copy it.'));
  } else if (entry.def.modulator) {
    explanations.append(hint('<kbd>Shift</kbd> + drag to a module, then pick its controller number with <kbd>Out Controller</kbd>.'));
    if (takesLiveMidi(entry.def)) explanations.append(hint('Notes trigger it: select it and play, send a clip to it, or <kbd>Shift</kbd> + drag a MultiMIDI into it.'));
    else if (entry.def.acceptsMidi) explanations.append(hint('Notes trigger it: send a clip to it, or <kbd>Shift</kbd> + drag a MultiMIDI into it.'));
  }

  // custom editor of the module's state (e.g. the WAVESHAPER curve), below the controllers
  const editor = entry.def.editor?.(entry, {
    color: entry.def.color,
    setState: (st) => current().setState(entry.id, st),
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
    const format = (v) => (p.format ? p.format(v, entry.values) : p.options ? p.options[v] : String(+v.toFixed(3)));
    const ctl = createController(p, {
      index,
      value: entry.values[p.id],
      format,
      onInput: (v) => {
        current().setParam(entry.id, p.id, v);
        refresh();
      },
    });
    setColor(ctl.el, entry.def);
    const row = ctl.el;
    controllers.appendChild(row);
    rows.push({ p, row, show: ctl.show });
    panelRows.set(p.id, { p, ctl });
    if (p.id in entry.mod) showModulation(entry, p.id, entry.mod[p.id]);
  });
  panel.insertBefore(controllers, header.nextSibling);

  // display below the controllers (e.g. the OSC waveform preview)
  view = entry.def.view?.(entry, {
    color: entry.def.color,
    setParam: (id, v) => { current().setParam(entry.id, id, v); refresh(); }, // e.g. dragging an EQ band
    setState: (st) => current().setState(entry.id, st), // e.g. the Output's comments
    refresh: () => refresh(), // e.g. MULTICTL: the Value text names its routed controllers
    // Patch: "Controllers…" opens the mapping dialog; the panel shows the new controllers after it
    patchControllers: (e) => patchControllersView(e, {
      open: async () => {
        const patch = current();
        await openMapDialog(e, { setState: (st) => patch.setState(e.id, st) });
        if (sel?.entry === e) select(sel);
      },
    }),
  }) ?? null;
  panelView = view;
  if (view) {
    panel.append(view.el);
    for (const id in entry.mod) view.modulate?.(id, entry.mod[id]);
  }
  panel.append(explanations);
  refresh();
}

// ---- live modulation display (LFO -> controller) ----
const panelRows = new Map(); // controller id -> row of the module shown in the panel
let panelView = null; // def.view() of the module shown in the panel
let modPending = new Map();
let modFrame = 0;
function showModulation(entry, id, v) {
  if (sel?.entry !== entry) return;
  panelView?.modulate?.(id, v);
  const r = panelRows.get(id);
  if (!r) return;
  r.ctl.setMod(v === null ? null : toNorm(r.p, v));
}
engine.onModulate = (entry, id, v) => {
  if (sel?.entry !== entry) return;
  modPending.set(id, v);
  modFrame ||= requestAnimationFrame(() => {
    modFrame = 0;
    const pending = modPending;
    modPending = new Map();
    if (sel?.entry === entry) pending.forEach((val, pid) => showModulation(entry, pid, val));
  });
};

// ---- save / load ----
// Project files are .mds (ModSynth project: JSON text inside). Older .json projects still load.
$('save').onclick = () => {
  const blob = new Blob([JSON.stringify({ ...engine.saveProject(), view: viewState() }, null, 2)], { type: 'application/octet-stream' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'project.mds' });
  a.click();
  URL.revokeObjectURL(a.href);
};
$('load').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await openProject(data, data.view);
    $('status').textContent = `Loaded ${file.name}`;
  } catch (err) {
    $('status').textContent = `Load failed: ${err.message}`;
  }
};
function emptyProject() {
  const values = Object.fromEntries(getModule('OUT').params.map((p) => [p.id, p.default]));
  return { format: 'modsynth', version: 1, patch: { modules: [{ id: 0, type: 'OUT', x: 560, y: 180, values }], cables: [] } };
}
$('new').onclick = async () => {
  const ok = await confirmDialog('The current project is replaced. Download it with Save first if you want to keep it.', { title: 'Start a new empty project?', ok: 'New project' });
  if (!ok) return;
  await openProject(emptyProject(), null);
  $('status').textContent = 'New project';
};

// ---- boot ----
initWidgets(document, { numberStep: () => snapStep(engine.song.snap) });
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => engine.resume()));
initCpuMeter(engine);
await engine.init();
scope = new CableScope(engine.dsp);
// clips play the module with their number in the main patch
const songTarget = (id) => {
  const e = id === null || id === undefined ? null : engine.root.modules.get(id);
  return e?.def.acceptsMidi ? e.inst : null;
};
transport = new Transport({
  getSong: () => engine.song,
  getBpm: () => engine.root.bpm,
  getTarget: songTarget,
  // automation clips drive a controller of a main-patch module (like an LFO, never saved)
  setAuto: (id, clip, value) => engine.root.automate(id, clip?.target ?? null, clip?.controller ?? 0, value),
});
seq = createSequencer({
  engine,
  transport,
  getTarget: songTarget,
  // new clips play the current MIDI module when it is in the main patch, else the first one there
  defaultTarget() {
    const t = midiTarget();
    if (t && engine.root.modules.get(t.id) === t) return t.id;
    return [...engine.root.modules.values()].find((e) => e.def.acceptsMidi)?.id ?? null;
  },
  // new automation clips drive the module selected in the main patch (else the clip's / first module)
  defaultAutoTarget() {
    if (current() === engine.root && sel?.entry && engine.root.modules.get(sel.entry.id) === sel.entry) return sel.entry.id;
    return null;
  },
  onChange: () => persist.schedule(),
});
const saved = await persist.loadAll();
let restored = null;
for (const { state, source } of saved.copies) {
  try {
    await persist.pause(() => engine.loadProject(state));
    applyView(state.view);
    restored = source;
    break;
  } catch (err) {
    console.error(`Could not restore autosave from ${source}:`, err);
    persist.keepBroken(state);
  }
}
if (!restored) {
  if (saved.copies.length) await persist.pause(() => engine.loadProject(emptyProject())); // clear a half-loaded patch
  path = [{ patch: engine.root, name: 'Main' }];
  seq.applyView(null);
  render();
}
$('saved').textContent = restored ? `Restored from ${restored}` : saved.copies.length ? 'Autosave unreadable, started empty' : '';
if (!saved.disk) $('saved').title = 'Browser localStorage only. Run "node server.mjs" to also save to disk.';
persist.start();
window.addEventListener('pagehide', () => persist.flushNow());
connectLiveReload(() => persist.flushNow());
const midi = initMidi({
  getTarget: midiTarget,
  onStatus: (msg) => ($('status').textContent = msg),
  onActivity: () => engine.resume(),
});
$('midi').onclick = () => midi.enable();
midi.enable();
