import { Engine } from './engine.js';
import { modules, getModule } from './modules/index.js';
import { initMidi } from './midi.js';
import { createPersistence, connectLiveReload } from './persist.js';
import { paramsOf, toNorm, wheelNotches } from './params.js';
import { initCpuMeter } from './cpumeter.js';
import { createController } from './controller.js';
import { curvePath, arrowPath } from './cable.js';
import { Transport } from './transport.js';
import { confirmDialog } from './dialogs.js';
import { createSequencer } from './seq/index.js';
import { defaultCam, validCam, toWorld, zoomAt, fitBox, ZOOM_STEP } from './camera.js';
import { initWidgets } from './widgets.js';
import { snapStep } from './song.js';

const engine = new Engine();
let transport = null; // song playback (created after the engine)
let seq = null; // piano roll + TimeLine UI
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
  path.forEach((l, i) => (l.cam = validCam(view?.cams?.[i])));
  seq?.applyView(view?.seq);
  midiHistory = [];
  if (view?.midi) {
    const levels = patchAt(view.midi.path);
    if (levels.length === view.midi.path.length + 1) {
      const e = levels.at(-1).patch.modules.get(view.midi.id);
      if (e?.def.acceptsMidi) midiHistory.push(e);
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
  li.id = `module-option-${m.type}`;
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
  world.querySelectorAll('.module').forEach((el) => el.remove());
  applyCam();
  for (const entry of current().modules.values()) createBox(entry);
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
  name.textContent = def.isOutput ? 'Output' : def.type === 'PATCH' ? 'Patch' : def.type;
  const num = document.createElement('span');
  num.className = 'module-id';
  num.textContent = entry.id;
  el.append(name, num);
  entry.el = el;

  for (const dir of ['in', 'out']) {
    if (!(dir === 'in' ? def.hasInput : def.hasOutput)) continue;
    const port = document.createElement('span');
    port.className = `port ${dir}`;
    el.append(port);
  }

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
    if (entry.inst.patch) {
      path.push({ patch: entry.inst.patch, name: `Patch #${entry.id}`, id: entry.id });
      render();
    }
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
// world coordinates; computed from layout offsets so the camera transform does not matter
function portPos(entry, dir) {
  const el = entry.el;
  const port = el.querySelector(`.port.${dir}`);
  if (!port) return { x: entry.x, y: entry.y + el.offsetHeight / 2 }; // control cables may end on modules without an audio input
  let x = port.offsetWidth / 2;
  let y = port.offsetHeight / 2;
  for (let n = port; n && n !== el;) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent;
    if (n) { x += n.clientLeft; y += n.clientTop; }
  }
  return { x: entry.x + x, y: entry.y + y };
}

function drawCables() {
  svg.replaceChildren();
  const patch = current();
  for (const cable of patch.cables) {
    const a = patch.modules.get(cable.from);
    const b = patch.modules.get(cable.to);
    const from = portPos(a, 'out');
    const to = portPos(b, 'in');
    const g = document.createElementNS(SVGNS, 'g');
    g.classList.add('cable');
    g.classList.toggle('selected', sel?.cable === cable);
    g.classList.toggle('mod', !!a.def.modulator);
    g.classList.toggle('midi', !!a.def.midiOut);
    setColor(g, a.def);
    const wire = document.createElementNS(SVGNS, 'path');
    wire.classList.add('wire');
    wire.setAttribute('d', curvePath(from, to));
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
  }
}

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
  const from = portPos(entry, 'out');
  const move = (ev) => {
    const to = clientToWorld(ev.clientX, ev.clientY);
    wire.setAttribute('d', curvePath(from, to));
    arrow.setAttribute('d', arrowPath(from, to));
  };
  move(e);
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.module');
    if (target) {
      const patch = current();
      const toId = +target.dataset.id;
      const existing = patch.cables.find((c) => c.from === entry.id && c.to === toId);
      const ok = existing ? (patch.disconnect(existing), true) : patch.connect(entry.id, toId);
      if (!ok) $('status').textContent = 'Cannot connect (duplicate, loop, or incompatible ports).';
    }
    select(sel); // refresh the panel: e.g. an LFO's Out Controller names follow its cables
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
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

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && path.length > 1 && !dialog.open) {
    path.pop();
    render();
    return;
  }
  if (e.target.closest('input, select, dialog, #seq')) return; // the sequencer handles its own keys
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectEntries([...current().modules.values()]);
    return;
  }
  if ((e.key !== 'Backspace' && e.key !== 'Delete') || !sel) return;
  e.preventDefault();
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
  if (s?.kind === 'module' && s.entry.def.acceptsMidi) setMidiTarget(s.entry);
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
    if (lfo?.def.modulator) {
      const n = lfo.values.outController | 0;
      const p = paramsOf(patch.modules.get(s.cable.to))[n];
      panel.append(hint(`Control cable: modulates controller <kbd>${n}</kbd> ${p ? p.label : '(does not exist on this module)'}.`));
    }
    if (lfo?.def.midiOut) panel.append(hint('MIDI cable: carries MODMIDI notes (float pitch + velocity, changed per note while they sound).'));
    panel.append(hint('Press <kbd>Backspace</kbd> to remove this cable.'));
    return;
  }
  if (!s) {
    panel.append(
      panelHeader('No selection', ''),
      hint('<kbd>Double-click</kbd> the canvas to insert a module.'),
      hint('<kbd>Shift</kbd> + drag from one module to another to connect or disconnect.'),
      hint('Drag on empty canvas to select several modules. <kbd>Ctrl</kbd> + click toggles a module, <kbd>Ctrl</kbd> + drag adds, <kbd>Ctrl</kbd> + <kbd>A</kbd> selects all.'),
      hint('<kbd>Alt</kbd> + drag a module to duplicate it (or the whole selection).'),
      hint('<kbd>Backspace</kbd> deletes the selection.'),
      hint('<kbd>Double-click</kbd> a Patch to enter it, <kbd>Esc</kbd> to go up.'),
      hint('<kbd>Middle mouse</kbd> + drag pans the canvas, <kbd>scroll</kbd> zooms. Click the zoom % (bottom right) to fit all modules.'),
      hint('Play with a MIDI controller or keys <kbd>A</kbd>–<kbd>;</kbd>.'),
      hint('<b>Sequencer</b> (right, <kbd>S</kbd> shows / hides it): <kbd>Double-click</kbd> the TimeLine to add a clip, drag its edges to resize, <kbd>Alt</kbd> + drag to copy. In the piano roll click / drag to write notes, drag a note body for its length, its circle for pitch and time, right click deletes. <kbd>Space</kbd> plays. <kbd>Double-click</kbd> the TimeLine ruler to insert a time signature change (right-click it to remove).'),
      hint('<b>Piano roll selection:</b> <kbd>Shift</kbd> + drag draws a selection rectangle; clicking a note selects it. <kbd>Ctrl/Cmd</kbd> + <kbd>A</kbd> selects all notes, <kbd>Esc</kbd> clears the selection, and <kbd>Backspace</kbd> / <kbd>Delete</kbd> deletes it. <kbd>Alt</kbd> + drag a note (body or circle) moves a clone.'),
      hint('<b>Arrow keys:</b> in the piano roll, <kbd>Left</kbd> / <kbd>Right</kbd> transpose selected notes by one semitone; <kbd>Up</kbd> / <kbd>Down</kbd> move them earlier/later by one snap step. The selection moves together and stops at time zero or the MIDI pitch limits.'),
      hint('<b>Velocity:</b> the strip left of the piano roll shows every note\'s velocity (stick) and how it changes while the note sounds. Drag a note\'s dot to set its velocity (<kbd>Shift</kbd>-click adds it to the selection). The selected notes share one curve: <kbd>Double-click</kbd> inside them to add a point, drag points (time snaps, <kbd>Shift</kbd> = fine), the mouse wheel on a point rounds it, right click deletes it. One selected note edits its own curve.'),
      hint('<b>Automation:</b> <kbd>Double right-click</kbd> the TimeLine to add an automation clip, then pick the module (<i>Send to</i>) and its <i>Controller</i> in the toolbar. In the automation lane <kbd>Double-click</kbd> inserts a point (snapped to the grid), drag moves it (<kbd>Shift</kbd> = fine), the mouse wheel on a point rounds the corner and right click deletes it. While playing, the clip drives the controller like an LFO; outside the clip (or when stopped) the controller has its own value again.'),
      hint('<b>Sequencer clipboard:</b> click the piano roll or TimeLine to focus it, then use <kbd>Ctrl/Cmd</kbd> + <kbd>X</kbd> / <kbd>C</kbd> / <kbd>V</kbd> to cut / copy / paste selected notes or the selected clip. Each view has its own in-app clipboard. Paste at the mouse pointer, snapped to the grid; note pitches and relative timing are preserved.'),
      hint('<b>TimeLine placement:</b> moving, cloning, pasting or creating a clip snaps it to the nearest non-overlapping position. Clip edges take priority over the time grid; resizing stops at neighbouring clips. Use separate vertical rows for clips that play at the same time. The Start and Length fields follow these rules too.'),
      hint('<b>Playback:</b> <kbd>/</kbd> starts and loops only the selected clip from its start. <kbd>\'</kbd> stops playback, <kbd>.</kbd> plays/resumes the full song, and <kbd>,</kbd> restarts the song at zero. <kbd>Space</kbd> toggles play/stop; stopping with <kbd>Space</kbd> (or the ■ button) moves the playhead to the start of the selected clip, so the next <kbd>Space</kbd> plays from there. Shortcuts are inactive while typing in a field. Note chasing: starting or jumping into the middle of a note plays it for the rest of its length.'),
      hint('<b>Controls:</b> scroll a dropdown to change its selection. Number fields have permanent up/down buttons and also support scrolling; <kbd>Double-click</kbd> a number (or use <kbd>Tab</kbd>) to type. Mouse adjustments leave keyboard focus in the editor so <kbd>Space</kbd> still plays.'),
      hint('<b>Toolbar:</b> controls stay on one row. When space is tight, move the pointer toward the left or right edge to reveal hidden controls; the closer to the edge, the faster it moves. Move to the middle to stop. Clicking, typing or using the wheel pauses motion; the wheel still changes control values. <kbd>Tab</kbd> also reveals focused controls.'),
      hint('<b>Layout:</b> drag the wide dividers all the way to an edge to hide the patcher, piano roll or TimeLine. Drag the divider back to reopen a pane. The piano keyboard stays at the bottom of the roll; selected notes are filled blue.'),
      hint('Drag the left controller-panel divider to resize the panel, or fully left to hide it. Its handle stays available to reopen it, and the width is saved with the project.'),
      hint('The divider beside the sequencer moves both splits together: drag left/right for sequencer width and up/down for the piano roll / TimeLine split. The horizontal divider still adjusts only the heights.'),
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
  panel.append(panelHeader(entry.def.label, `#${entry.id}`, entry.def));
  if (entry.def.type === 'VELOCITY2CTL') {
    panel.append(hint('The velocity of the newest incoming note (and its velocity curve while it sounds) sets the controller: velocity 0 = <kbd>Out Min</kbd>, 127 = <kbd>Out Max</kbd>. The value is held until the next note.'));
  }
  if (entry.def.type === 'OSC') {
    panel.append(hint('<b>Half sine:</b> one positive sine bow followed by zero. <b>Duty Cycle</b> sets the bow length: 100% fills the period, 25% fills its first quarter, and 0% is silent.'));
  }
  if (!entry.def.acceptsMidi) {
    const what = entry.def.modulator ? 'Modulator' : 'Audio only';
    panel.append(hint(target
      ? `${what}. MIDI keeps playing <kbd>${target.def.type} #${target.id}</kbd>.`
      : `${what}. Select an OSC or Patch to play it with MIDI.`));
  }
  if (entry.def.midiOut) {
    panel.append(hint('<kbd>Shift</kbd> + drag to an OSC, Patch or another MultiMIDI. Every note drifts on its own. Several MultiMIDIs can feed one synth in parallel (each plays its own voices); chained ones add up.'));
  }
  if (entry.def.modulator) {
    panel.append(hint('<kbd>Shift</kbd> + drag to a module, then pick its controller number with <kbd>Out Controller</kbd>.'));
    if (entry.def.acceptsMidi) panel.append(hint('Notes trigger it: select it and play, send a clip to it, or <kbd>Shift</kbd> + drag a MultiMIDI into it.'));
  }

  // custom editor of the module's state (e.g. the WAVESHAPER curve), above the controllers
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
    panel.appendChild(row);
    rows.push({ p, row, show: ctl.show });
    panelRows.set(p.id, { p, ctl });
    if (p.id in entry.mod) showModulation(entry, p.id, entry.mod[p.id]);
  });

  // display below the controllers (e.g. the OSC waveform preview)
  view = entry.def.view?.(entry, { color: entry.def.color }) ?? null;
  panelView = view;
  if (view) {
    panel.append(view.el);
    for (const id in entry.mod) view.modulate?.(id, entry.mod[id]);
  }
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
$('save').onclick = () => {
  const blob = new Blob([JSON.stringify({ ...engine.saveProject(), view: viewState() }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'project.modsynth.json' });
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
