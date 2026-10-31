// The sequencer surrounds the patcher: piano roll above, TimeLine arranger below,
// with a toolbar for transport, the selected clip and the snap grid above the roll.
// An automation clip shows the automation lane editor in place of the piano roll.
import { newNoteId } from '../modmidi.js';
import { getClip, isAuto, SNAP_BASES, SNAP_NAMES, snapStep, formatPos, DEFAULT_VEL, meter, segAt, setSig, removeSig, linkedClips, normalizeSong } from '../song.js';
import { sigDialog } from '../dialogs.js';
import { createPianoRoll } from './pianoroll.js';
import { createArranger } from './arranger.js';
import { createAutomationLane } from './automation.js';
import { paramsOf, fromNorm } from '../params.js';

// controller value as the panel shows it
const formatValue = (e, p, v) => (p.format ? p.format(v, e.values) : p.options ? p.options[v] : String(+v.toFixed(3)));
import { capture, clamp } from './surface.js';
import { createHoverToolbar } from './toolbar.js';

const NO_COLOR = '#8a8a92';

// engine: Engine (song, root patch); transport: Transport; getTarget(moduleNumber) -> instance;
// defaultTarget() -> module number for new clips; defaultAutoTarget() -> module number (or null)
// for new automation clips; onChange() after every edit.
// getSong() / getPatch(): the layer shown (a Patch has its own TimeLine for its own modules);
// default: the main song and patch. Call setLayer() after the shown layer changed.
export function createSequencer({ engine, transport, getSong = null, getPatch = null, getTarget, liveTarget = () => null, defaultTarget, defaultAutoTarget = () => null, onChange, undoHistory }) {
  const $ = (id) => document.getElementById(id);
  const seq = $('seq');
  const ui = {
    play: $('seq-play'), pos: $('seq-pos'), name: $('seq-name'), target: $('seq-target'),
    base: $('seq-snap-base'), div: $('seq-snap-div'), free: $('seq-free-time'),
    ctl: $('seq-ctl'), ctlField: $('seq-ctl-field'), targetField: $('seq-target-field'),
  };
  const song = () => getSong?.() ?? engine.song;
  const patch = () => getPatch?.() ?? engine.root;
  const clip = () => getClip(song(), song().selected);
  const entryOf = (id) => (id === null ? null : patch().modules.get(id) ?? null);
  // the module's name in the patcher: its custom name, else the default for its type
  const nameOf = (e) => e.name || (e.def.isOutput ? 'Output' : e.def.type === 'PATCH' ? 'Patch' : e.def.type);

  const ctx = {
    song,
    clip,
    transport,
    color: (c) => entryOf(c.target)?.def.color ?? NO_COLOR,
    targetLabel(c) {
      if (c.target === null) return '→ none';
      const e = entryOf(c.target);
      if (!e) return `→ #${c.target} (missing)`;
      if (!isAuto(c)) return `→ #${c.target} ${nameOf(e)}`;
      const p = paramsOf(e)[c.controller];
      return `→ #${c.target} ${nameOf(e)} · ${c.controller} ${p?.label ?? '(missing)'}`;
    },
    defaultTarget: () => (isAuto(clip()) ? null : clip()?.target) ?? defaultTarget(),
    defaultAutoTarget: () => defaultAutoTarget() ?? (isAuto(clip()) ? clip().target : null),
    // the controller an automation clip drives: { p, format(norm) } or null
    autoParam(c) {
      const e = entryOf(c?.target ?? null);
      const p = e ? paramsOf(e)[c.controller] : null;
      if (!p) return null;
      return { p, format: (x) => formatValue(e, p, fromNorm(p, x)) };
    },
    // scroll: false keeps the TimeLine where it is (selection made in the TimeLine itself)
    select(id, { scroll = true } = {}) {
      song().selected = id;
      roll.reveal();
      lane.reveal();
      if (scroll) arranger.reveal(id);
      sync();
      onChange();
    },
    changed() {
      undoHistory?.record();
      if (!undoHistory) record();
      onChange();
      sync();
    },
    viewChanged: () => onChange(), // view-only change (velocity strip width): saved, no undo step
    live: () => { roll.redraw(); lane.redraw(); }, // arranger drag in progress: keep the piano roll in step
    // insert / edit / remove the time signature that starts at `at` (a bar line)
    async editSig(at) {
      const sg = song();
      const existing = sg.sigs.find((x) => Math.abs(x.at - at) < 1e-9);
      const cur = existing ?? segAt(meter(sg), at);
      const r = await sigDialog({
        num: cur.num,
        den: cur.den,
        title: existing ? 'Change time signature' : 'Insert time signature',
        where: `Starts at bar ${formatPos(at, sg).split('.')[0]} and lasts until the next change.`,
        canDelete: !!existing && at > 0,
      });
      if (!r) return;
      if (r === 'delete') removeSig(sg, at);
      else setSig(sg, at, r.num, r.den);
      undoHistory?.record();
      if (!undoHistory) record();
      onChange();
      sync();
    },
    preview: {
      on(c, pitch) {
        const inst = getTarget(c.target);
        if (!inst) return null;
        engine.resume();
        const id = newNoteId();
        inst.noteOn(id, pitch, DEFAULT_VEL);
        return { inst, id };
      },
      // the on-screen keyboard plays the live MIDI module (red MIDI marker in the patcher)
      key(pitch) {
        const inst = liveTarget();
        if (!inst) return null;
        engine.resume();
        const id = newNoteId();
        inst.noteOn(id, pitch, DEFAULT_VEL);
        return { inst, id };
      },
      off(h) { h?.inst.noteOff(h.id); },
    },
  };

  // the piano roll only sees note clips, the lane only automation clips
  const roll = createPianoRoll($('roll'), { ...ctx, clip: () => (isAuto(clip()) ? null : clip()) });
  const lane = createAutomationLane($('roll'), { ...ctx, clip: () => (isAuto(clip()) ? clip() : null) });
  const arranger = createArranger($('arranger'), ctx);

  // ---- toolbar ----
  createHoverToolbar($('seq-bar'), $('seq-bar-content'));
  for (const b of SNAP_BASES) ui.base.add(new Option(SNAP_NAMES[b], b));

  function refreshTargets() {
    const c = clip();
    const auto = isAuto(c);
    const opts = [new Option('— none —', '')];
    for (const e of patch().modules.values()) {
      if (auto ? paramsOf(e).length : e.def.acceptsMidi) opts.push(new Option(`#${e.id} ${nameOf(e)}`, e.id));
    }
    if (c?.target !== null && c?.target !== undefined && !entryOf(c.target)) opts.push(new Option(`#${c.target} (missing)`, c.target));
    ui.target.replaceChildren(...opts);
    ui.target.value = c?.target ?? '';
    const color = c ? ctx.color(c) : NO_COLOR;
    $('workspace').style.setProperty('--clip-color', color);
    // automation: which controller of the target
    ui.ctlField.hidden = !auto;
    const where = patch() === engine.root ? 'main patch' : 'this Patch level';
    ui.targetField.title = auto ? `Module number (${where}) whose controller this automation clip drives` : `Module number (${where}) that plays the notes of this clip`;
    if (auto) {
      const e = entryOf(c.target);
      const params = e ? paramsOf(e) : [];
      const ctls = params.map((p, i) => new Option(`${i} · ${p.label}`, i));
      if (c.controller >= params.length) ctls.push(new Option(`${c.controller} · (missing)`, c.controller));
      ui.ctl.replaceChildren(...ctls);
      ui.ctl.value = c.controller;
      ui.ctl.disabled = c.target === null;
    }
    roll.surface.cv.style.display = auto ? 'none' : '';
    lane.surface.cv.style.display = auto ? '' : 'none';
  }

  const fmt = (v) => String(+v.toFixed(6));
  function sync() {
    if (!undoHistory) trackSong();
    const c = clip();
    for (const k of ['name', 'target']) ui[k].disabled = !c;
    if (document.activeElement !== ui.name) ui.name.value = c?.name ?? '';
    ui.base.value = song().snap.base;
    ui.div.value = song().snap.div;
    ui.div.title = `Grid step: ${fmt(snapStep(song().snap))} quarter notes`;
    ui.free.checked = song().snap.free === true;
    ui.free.disabled = isAuto(c);
    refreshTargets();
    showPos();
    roll.redraw();
    lane.redraw();
    arranger.redraw();
  }

  ui.name.addEventListener('input', () => {
    const c = clip();
    if (!c) return;
    for (const l of linkedClips(song(), c)) l.name = ui.name.value; // clones share their name
    arranger.redraw();
    onChange();
  });
  // The first click selects the whole name, so typing replaces it; clicks while editing place the caret.
  let selectOnUp = false;
  ui.name.addEventListener('pointerdown', () => { selectOnUp = document.activeElement !== ui.name; });
  ui.name.addEventListener('mouseup', (e) => {
    if (!selectOnUp) return;
    selectOnUp = false;
    if (ui.name.selectionStart !== ui.name.selectionEnd) return; // the user dragged a selection
    e.preventDefault();
    ui.name.select();
  });
  ui.name.addEventListener('focus', () => ui.name.select());
  ui.name.addEventListener('change', () => {
    undoHistory?.record();
    if (!undoHistory) record();
  });
  ui.target.addEventListener('change', () => {
    const c = clip();
    if (!c) return;
    const target = ui.target.value === '' ? null : +ui.target.value;
    for (const l of linkedClips(song(), c)) { // clones share where they send to
      l.target = target;
      if (isAuto(l)) l.controller = 0;
    }
    ctx.changed();
  });
  ui.ctl.addEventListener('change', () => {
    const c = clip();
    if (!isAuto(c)) return;
    for (const l of linkedClips(song(), c)) l.controller = +ui.ctl.value;
    ctx.changed();
  });
  ui.base.addEventListener('change', () => { song().snap.base = +ui.base.value; ctx.changed(); });
  ui.free.addEventListener('change', () => {
    if (ui.free.checked) song().snap.free = true;
    else delete song().snap.free;
    ctx.changed();
  });
  ui.div.addEventListener('input', () => {
    const v = Math.round(+ui.div.value);
    if (!Number.isFinite(v) || v < 1) return;
    song().snap.div = Math.min(64, v);
    ctx.changed();
  });
  ui.div.addEventListener('change', () => sync()); // normalise what is shown
  // Enter / Escape in a field: back to the views (so Space plays again)
  for (const el of [ui.name, ui.div]) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') el.blur(); });
  }

  // Standalone sequencer consumers keep local undo; the app supplies a project-wide history.
  const history = { owner: null, stack: [], i: -1 };
  const HISTORY_MAX = 200;
  const snapshot = () => JSON.stringify({ ...song(), selected: null });
  function trackSong() {
    if (history.owner === song()) return;
    history.owner = song();
    history.stack = [snapshot()];
    history.i = 0;
  }
  function record() {
    trackSong();
    const snap = snapshot();
    if (snap === history.stack[history.i]) return;
    history.stack.length = history.i + 1;
    history.stack.push(snap);
    if (history.stack.length > HISTORY_MAX) history.stack.shift();
    history.i = history.stack.length - 1;
  }
  function travel(d) {
    trackSong();
    const j = history.i + d;
    if (j < 0 || j >= history.stack.length) return false;
    history.i = j;
    const keep = song().selected;
    const restored = normalizeSong(JSON.parse(history.stack[j]));
    restored.selected = getClip(restored, keep) ? keep : null;
    engine.song = history.owner = restored;
    onChange();
    sync();
    return true;
  }
  function onUndoKey(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.target.closest?.('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && !(k === 'y' && !e.shiftKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const result = undoHistory ? undoHistory.travel(k === 'y' || e.shiftKey ? 1 : -1) : travel(k === 'y' || e.shiftKey ? 1 : -1);
    const label = k === 'y' || e.shiftKey ? 'Redo' : 'Undo';
    if (result && typeof result.then === 'function') {
      result.then((ok) => { $('status').textContent = ok ? label : 'Nothing to undo / redo.'; })
        .catch((err) => { $('status').textContent = `${label} failed: ${err.message}`; });
    } else $('status').textContent = result ? label : 'Nothing to undo / redo.';
  }
  seq.addEventListener('keydown', onUndoKey);
  $('seq-bar').addEventListener('keydown', onUndoKey);

  // ---- transport ----
  ui.play.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus (Space) where it is
  ui.play.onclick = () => togglePlay();
  function togglePlay(fromPointer = false) {
    engine.resume();
    if (transport.playing) {
      // pausing parks the playhead at the start of the selected clip
      transport.stop({ to: getClip(song(), song().selected)?.start ?? null });
      return;
    }
    const pointerTime = fromPointer ? roll.getPointerTime() : null;
    if (pointerTime !== null) transport.seek(pointerTime);
    if (!transport.play() && !song().clips.length) {
      $('status').textContent = 'Nothing to play: double-click in the TimeLine to create a clip.';
    }
  }
  function playSong(fromStart = false) {
    engine.resume();
    if (!transport.play({ fromStart })) {
      $('status').textContent = 'Nothing to play: double-click in the TimeLine to create a clip.';
    }
  }
  let stopArmed = false; // the last transport shortcut was ' (stop): pressing it again is a panic
  window.addEventListener('keydown', (e) => {
    if ((e.key === 's' || e.key === 'S') && !e.repeat && !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey
      && !e.target.closest?.('input, select, textarea, dialog, [contenteditable]:not([contenteditable="false"])')) {
      e.preventDefault();
      toggleRoll();
      return;
    }
    if (![' ', '/', "'", '.', ','].includes(e.key) || e.repeat || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('input, select, textarea, dialog, [contenteditable]:not([contenteditable="false"])')) return;
    if (e.key === ' ' && e.target.closest?.('button')) return;
    e.preventDefault();
    const panic = e.key === "'" && stopArmed && !transport.playing;
    stopArmed = e.key === "'";
    if (e.key === ' ') togglePlay(true);
    else if (panic) {
      engine.panic();
      $('status').textContent = 'Panic: all notes off, echo / reverb tails and other DSP state cleared.';
    } else if (e.key === "'") transport.stop();
    else if (e.key === '/') {
      engine.resume();
      if (!transport.playClip(song().selected, song())) $('status').textContent = 'Select a clip in the TimeLine to loop it.';
    } else playSong(e.key === ',');
  });
  let frame = 0;
  const loop = () => {
    frame = transport.playing ? requestAnimationFrame(loop) : 0;
    showPos();
    roll.redraw();
    lane.redraw();
    arranger.redraw();
  };
  transport.onState = () => {
    ui.play.classList.toggle('playing', transport.playing);
    ui.play.textContent = transport.playing ? '■' : '▶';
    ui.play.title = transport.playing
      ? `${transport.clipId === null ? 'Stop' : 'Stop clip loop'} and go to the selected clip's start (Space)`
      : 'Play song (.) / toggle from the piano-roll pointer (Space)';
    if (!frame) loop();
  };
  function showPos() {
    ui.pos.textContent = formatPos(transport.pos, song());
    const looping = transport.loopClip ? (transport.clipSong === song() ? transport.loopClip() : null) : getClip(song(), transport.clipId);
    ui.pos.title = looping ? `Looping ${looping.name} (/ to restart, . for the song)` : 'Play position: bar.beat.hundredths';
  }

  // Boundaries are fractions of the workspace height excluding the two divider handles.
  const defaults = { top: 0.4, bottom: 0.75, panelWidth: 280, restoreTop: 0.4, restoreBottom: 0.75 };
  const layout = { ...defaults };
  const workspace = $('workspace');
  const controller = $('panel-split');
  const upper = $('seq-split');
  const lower = $('seq-hsplit');
  // The toolbar lives on the upper divider, so both surrounding panes can collapse completely.
  const room = () => Math.max(0, (workspace.getBoundingClientRect?.().height ?? 0)
    - (upper.getBoundingClientRect?.().height ?? 0) - (lower.getBoundingClientRect?.().height ?? 0));
  function applyLayout() {
    document.body.classList.toggle('panel-collapsed', layout.panelWidth === 0);
    document.body.style.setProperty('--panel-width', `${layout.panelWidth}px`);
    workspace.style.setProperty('--roll-fr', `${layout.top}fr`);
    workspace.style.setProperty('--patch-fr', `${layout.bottom - layout.top}fr`);
    workspace.style.setProperty('--arr-fr', `${1 - layout.bottom}fr`);
    workspace.classList.toggle('roll-collapsed', layout.top <= 1e-6);
    workspace.classList.toggle('patcher-collapsed', layout.top === layout.bottom);
    workspace.classList.toggle('arranger-collapsed', layout.bottom === 1);
    for (const [handle, value] of [[upper, layout.top], [lower, layout.bottom]]) {
      handle.setAttribute('aria-valuemin', '0');
      handle.setAttribute('aria-valuemax', '100');
      handle.setAttribute('aria-valuenow', String(Math.round(value * 100)));
    }
  }
  // S maximizes the patcher, then restores both surrounding panes to their saved positions.
  function toggleRoll() {
    if (layout.top > 1e-6 || layout.bottom < 1) {
      layout.restoreTop = layout.top;
      layout.restoreBottom = layout.bottom;
      layout.top = 0;
      layout.bottom = 1;
    } else {
      const restorable = layout.restoreTop > 1e-6 || layout.restoreBottom < 1;
      layout.top = restorable ? layout.restoreTop : defaults.top;
      layout.bottom = restorable ? layout.restoreBottom : defaults.bottom;
    }
    applyLayout();
    onChange();
  }
  function moveBoundary(boundary, value) {
    layout[boundary] = clamp(value, 0, 1);
    if (boundary === 'top') layout.bottom = Math.max(layout.bottom, layout.top);
    else layout.top = Math.min(layout.top, layout.bottom);
    applyLayout();
  }
  function saveLayout(start) {
    const min = 1e-6;
    if (layout.top <= min && layout.bottom === 1 && (start.top > min || start.bottom < 1)) {
      layout.restoreTop = start.top;
      layout.restoreBottom = start.bottom;
    }
    onChange();
  }
  for (const [handle, boundary] of [[controller, 'top'], [upper, 'top'], [lower, 'bottom']]) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest?.('button, input, select, label, .spinbox')) return;
      e.preventDefault();
      const space = room();
      const panelHandle = controller.getBoundingClientRect();
      const dragBoundary = handle === controller
        ? (e.clientY > panelHandle.top + panelHandle.height / 2 ? 'bottom' : 'top')
        : boundary;
      const patcher = $('patcher').getBoundingClientRect();
      const available = Math.max(0, patcher.width - panelHandle.width);
      const panelStart = panelHandle.left - patcher.left;
      const start = { ...layout };
      const x0 = e.clientX;
      const y0 = e.clientY;
      capture(handle, e, (ev) => {
        const dx = ev.clientX - x0;
        layout.panelWidth = dx ? clamp(panelStart + dx, 0, available) : start.panelWidth;
        if (space > 0) moveBoundary(dragBoundary, start[dragBoundary] + (ev.clientY - y0) / space);
        else applyLayout();
      }, () => saveLayout(start));
    });
    if (handle === controller) continue;
    handle.addEventListener('keydown', (e) => {
      if (e.target !== handle || e.ctrlKey || e.metaKey || e.altKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const start = { ...layout };
      const step = e.shiftKey ? 0.1 : 0.02;
      const value = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : layout[boundary] + (e.key === 'ArrowUp' ? -step : step);
      moveBoundary(boundary, value);
      saveLayout(start);
    });
  }
  applyLayout();

  // module changes in the shown layer update the target lists and clip colours
  const onModules = () => { refreshTargets(); roll.redraw(); lane.redraw(); arranger.redraw(); };
  let watched = null;
  function watchLayer() {
    if (watched === patch()) return;
    watched?.listeners.delete(onModules);
    watched = patch();
    watched.listeners.add(onModules);
  }
  watchLayer();

  return {
    // after a project was loaded
    reload() {
      transport.stop();
      transport.seek(0);
      watchLayer();
      sync();
    },
    // the shown layer changed (entered / left a Patch): show its TimeLine
    setLayer() {
      watchLayer();
      sync();
    },
    viewState: () => ({ ...layout, roll: roll.getView(), lane: lane.getView(), arranger: arranger.getView() }),
    applyView(v) {
      roll.setView(v?.roll);
      if (v) {
        if (!Number.isFinite(v.top) && !Number.isFinite(v.bottom)
          && (Number.isFinite(v.width) || Number.isFinite(v.split) || v.open === false)) {
          // Migrate the old side-by-side layout, preserving each pane's share of the workspace.
          const width = Number.isFinite(v.width) ? clamp(v.width, 0, 1) : 0.5;
          const split = Number.isFinite(v.split) ? clamp(v.split, 0, 1) : 0.62;
          const restore = Number.isFinite(v.restoreWidth) && v.restoreWidth > 0 ? clamp(v.restoreWidth, 0, 1) : width || 0.5;
          layout.top = v.open === false ? 0 : width * split;
          layout.bottom = v.open === false ? 1 : 1 - width * (1 - split);
          layout.restoreTop = restore * split;
          layout.restoreBottom = 1 - restore * (1 - split);
        }
        if (Number.isFinite(v.top)) layout.top = clamp(v.top, 0, 1);
        if (Number.isFinite(v.bottom)) layout.bottom = clamp(v.bottom, 0, 1);
        layout.bottom = Math.max(layout.top, layout.bottom);
        if (Number.isFinite(v.restoreTop)) layout.restoreTop = clamp(v.restoreTop, 0, 1);
        if (Number.isFinite(v.restoreBottom)) layout.restoreBottom = clamp(v.restoreBottom, 0, 1);
        layout.restoreBottom = Math.max(layout.restoreTop, layout.restoreBottom);
        if (Number.isFinite(v.panelWidth)) layout.panelWidth = Math.max(0, v.panelWidth);
        lane.setView(v.lane);
        arranger.setView(v.arranger);
      } else Object.assign(layout, defaults);
      applyLayout();
      sync();
    },
  };
}
