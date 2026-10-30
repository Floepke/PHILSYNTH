// The sequencer: right part of the window, split into the piano roll (top) and the TimeLine
// arranger (bottom), with a toolbar for transport, the selected clip and the snap grid.
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
// for new automation clips; onChange() after every edit
export function createSequencer({ engine, transport, getTarget, defaultTarget, defaultAutoTarget = () => null, onChange }) {
  const $ = (id) => document.getElementById(id);
  const seq = $('seq');
  const ui = {
    play: $('seq-play'), pos: $('seq-pos'), name: $('seq-name'), target: $('seq-target'),
    start: $('seq-start'), length: $('seq-length'), base: $('seq-snap-base'), div: $('seq-snap-div'),
    ctl: $('seq-ctl'), ctlField: $('seq-ctl-field'), targetField: $('seq-target-field'),
  };
  const song = () => engine.song;
  const clip = () => getClip(song(), song().selected);
  const entryOf = (id) => (id === null ? null : engine.root.modules.get(id) ?? null);

  const ctx = {
    song,
    clip,
    transport,
    color: (c) => entryOf(c.target)?.def.color ?? NO_COLOR,
    targetLabel(c) {
      if (c.target === null) return '→ none';
      const e = entryOf(c.target);
      if (!e) return `→ #${c.target} (missing)`;
      if (!isAuto(c)) return `→ #${c.target} ${e.def.type}`;
      const p = paramsOf(e)[c.controller];
      return `→ #${c.target} ${e.def.type} · ${c.controller} ${p?.label ?? '(missing)'}`;
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
      record();
      onChange();
      sync();
    },
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
      record();
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
    for (const e of engine.root.modules.values()) {
      if (auto ? paramsOf(e).length : e.def.acceptsMidi) opts.push(new Option(`#${e.id} ${e.def.type}`, e.id));
    }
    if (c?.target !== null && c?.target !== undefined && !entryOf(c.target)) opts.push(new Option(`#${c.target} (missing)`, c.target));
    ui.target.replaceChildren(...opts);
    ui.target.value = c?.target ?? '';
    const color = c ? ctx.color(c) : NO_COLOR;
    seq.style.setProperty('--clip-color', color);
    // automation: which controller of the target
    ui.ctlField.hidden = !auto;
    ui.targetField.title = auto ? 'Module number (main patch) whose controller this automation clip drives' : 'Module number (main patch) that plays the notes of this clip';
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
    trackSong();
    const c = clip();
    for (const k of ['name', 'target', 'start', 'length']) ui[k].disabled = !c;
    if (document.activeElement !== ui.name) ui.name.value = c?.name ?? '';
    if (document.activeElement !== ui.start) ui.start.value = c ? fmt(c.start) : '';
    if (document.activeElement !== ui.length) ui.length.value = c ? fmt(c.length) : '';
    ui.base.value = song().snap.base;
    ui.div.value = song().snap.div;
    ui.div.title = `Grid step: ${fmt(snapStep(song().snap))} quarter notes`;
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
  ui.name.addEventListener('change', () => record());
  ui.target.addEventListener('change', () => {
    const c = clip();
    if (!c) return;
    c.target = ui.target.value === '' ? null : +ui.target.value;
    if (isAuto(c)) c.controller = 0;
    ctx.changed();
  });
  ui.ctl.addEventListener('change', () => {
    const c = clip();
    if (!isAuto(c)) return;
    c.controller = +ui.ctl.value;
    ctx.changed();
  });
  const numberField = (input, apply) => input.addEventListener('change', () => {
    const c = clip();
    const v = parseFloat(input.value);
    if (c && Number.isFinite(v)) apply(c, v);
    input.blur();
    ctx.changed();
  });
  numberField(ui.start, (c, v) => arranger.place(c, { start: v })); // negative: parked before time zero
  numberField(ui.length, (c, v) => arranger.setLength(c, Math.max(1e-3, v)));
  ui.base.addEventListener('change', () => { song().snap.base = +ui.base.value; ctx.changed(); });
  ui.div.addEventListener('input', () => {
    const v = Math.round(+ui.div.value);
    if (!Number.isFinite(v) || v < 1) return;
    song().snap.div = Math.min(64, v);
    ctx.changed();
  });
  ui.div.addEventListener('change', () => sync()); // normalise what is shown
  // Enter / Escape in a field: back to the views (so Space plays again)
  for (const el of [ui.name, ui.start, ui.length, ui.div]) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') el.blur(); });
  }

  // ---- undo / redo of song edits: Ctrl/Cmd + Z, Ctrl/Cmd + Shift + Z or Ctrl + Y ----
  // Snapshots use the saved JSON form; normalizeSong re-shares the notes of linked clones.
  // A new project (or a loaded one) starts a new history.
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
  seq.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.target.closest?.('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && !(k === 'y' && !e.shiftKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const ok = travel(k === 'y' || e.shiftKey ? 1 : -1);
    $('status').textContent = ok ? (k === 'y' || e.shiftKey ? 'Redo (sequencer)' : 'Undo (sequencer)') : 'Nothing to undo / redo in the sequencer.';
  });

  // ---- transport ----
  ui.play.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus (Space) where it is
  ui.play.onclick = () => togglePlay();
  function togglePlay() {
    engine.resume();
    if (transport.playing) {
      // pausing parks the playhead at the start of the selected clip
      transport.stop({ to: getClip(song(), song().selected)?.start ?? null });
      return;
    }
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
    if (e.key === ' ') togglePlay();
    else if (e.key === "'") transport.stop();
    else if (e.key === '/') {
      engine.resume();
      if (!transport.playClip(song().selected)) $('status').textContent = 'Select a clip in the TimeLine to loop it.';
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
      : 'Play song (.) / toggle (Space)';
    if (!frame) loop();
  };
  function showPos() {
    ui.pos.textContent = formatPos(transport.pos, song());
    const looping = getClip(song(), transport.clipId);
    ui.pos.title = looping ? `Looping ${looping.name} (/ to restart, . for the song)` : 'Play position: bar.beat.hundredths';
  }

  // ---- layout: controller panel, sequencer width and the roll / arranger split ----
  // restoreWidth: where S brings the vertical divider back to after it hid the sequencer
  const layout = { width: 0.5, split: 0.62, panelWidth: 280, restoreWidth: 0.5 };
  function applyLayout() {
    document.body.classList.add('seq-open');
    document.body.classList.toggle('panel-collapsed', layout.panelWidth === 0);
    document.body.style.setProperty('--panel-width', `${layout.panelWidth}px`);
    document.body.style.setProperty('--seq-f', layout.width);
    seq.style.setProperty('--roll-fr', `${layout.split}fr`);
    seq.style.setProperty('--arr-fr', `${1 - layout.split}fr`);
    seq.classList.toggle('seq-collapsed', layout.width === 0);
    seq.classList.toggle('roll-collapsed', layout.split === 0);
    seq.classList.toggle('arranger-collapsed', layout.split === 1);
  }
  // S: slide the vertical divider fully right (hides piano roll + TimeLine), S again: back to where it was
  function toggleRoll() {
    if (layout.width > 0) {
      layout.restoreWidth = layout.width;
      layout.width = 0;
    } else {
      layout.width = layout.restoreWidth > 0 ? layout.restoreWidth : 0.5;
    }
    applyLayout();
    onChange();
  }
  $('panel-split').addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const divider = e.currentTarget.getBoundingClientRect();
    const offset = e.clientX - divider.left;
    const seqDivider = $('seq-split').getBoundingClientRect().width;
    const available = Math.max(0, window.innerWidth - divider.width - seqDivider);
    capture(e.currentTarget, e, (ev) => {
      layout.panelWidth = clamp(ev.clientX - offset, 0, available);
      applyLayout();
    }, () => onChange());
  });
  // Both sequencer dividers move both splits: x → sequencer width, y → roll / TimeLine split.
  // Each axis follows the pointer relative to where it was grabbed, and only once it moves on that axis.
  function dragSeqSplits(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const panelRight = $('panel-split').getBoundingClientRect().right;
    const vertical = $('seq-split').getBoundingClientRect();
    const available = Math.max(0, window.innerWidth - panelRight - vertical.width);
    const top = $('roll').getBoundingClientRect().top;
    const bottom = $('arranger').getBoundingClientRect().bottom;
    const horizontal = $('seq-hsplit').getBoundingClientRect();
    const verticalRoom = Math.max(1, bottom - top - horizontal.height);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const widthStart = layout.width;
    const splitStart = layout.split;
    capture(e.currentTarget, e, (ev) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      layout.width = dx && available > 0 ? clamp((window.innerWidth - (vertical.left + dx) - vertical.width) / available, 0, 1) : widthStart;
      layout.split = dy ? clamp((horizontal.top + dy - top) / verticalRoom, 0, 1) : splitStart;
      applyLayout();
    }, () => {
      if (layout.width === 0 && widthStart > 0) layout.restoreWidth = widthStart; // dragged shut: S reopens it there
      onChange();
    });
  }
  $('seq-split').addEventListener('pointerdown', dragSeqSplits);
  $('seq-hsplit').addEventListener('pointerdown', dragSeqSplits);
  applyLayout();

  engine.root.listeners.add(() => { refreshTargets(); roll.redraw(); lane.redraw(); arranger.redraw(); });

  return {
    // after a project was loaded
    reload() {
      transport.stop();
      transport.seek(0);
      sync();
    },
    viewState: () => ({ ...layout, roll: roll.getView(), lane: lane.getView(), arranger: arranger.getView() }),
    applyView(v) {
      if (v) {
        if (Number.isFinite(v.width)) layout.width = clamp(v.width, 0, 1);
        if (Number.isFinite(v.restoreWidth) && v.restoreWidth > 0) layout.restoreWidth = clamp(v.restoreWidth, 0, 1);
        if (v.open === false && layout.width > 0) { // older projects: Sequencer button had hidden it
          layout.restoreWidth = layout.width;
          layout.width = 0;
        }
        if (Number.isFinite(v.split)) layout.split = clamp(v.split, 0, 1);
        if (Number.isFinite(v.panelWidth)) layout.panelWidth = Math.max(0, v.panelWidth);
        roll.setView(v.roll);
        lane.setView(v.lane);
        arranger.setView(v.arranger);
      }
      applyLayout();
      sync();
    },
  };
}
