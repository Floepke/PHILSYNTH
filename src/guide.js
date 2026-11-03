// The tutorials shown in the controller panel when nothing is selected: Patcher, TimeLine,
// Piano roll and Workspace. Each is { id, title, intro, steps: [{ title, items: [html] }],
// keys: [[keys html, action html]] }. Static HTML strings only (rendered with innerHTML).
// Keep them in step with the code when interactions or shortcuts change.

const k = (...keys) => keys.map((x) => `<kbd>${x}</kbd>`).join(' + ');
const CMD = 'Ctrl/Cmd';

export const GUIDE = [
  {
    id: 'patcher',
    title: 'Patcher',
    intro: 'The patcher (middle pane) is where the instrument is built. Every box is a module with a number (<b>#</b>); cables carry sound, MIDI notes or modulation from one module to the next and finally into the <b>Output</b>. Select a module to see its controllers and its reference here.',
    steps: [
      {
        title: 'Insert modules',
        items: [
          `${k('Double-click')} empty canvas (or right-click it → <b>Load module…</b>) to open the insert dialog; the module appears where you clicked.`,
          '<b>Load module…</b> in the insert dialog places a saved <b>.phmod</b> file at that spot.',
          'The module number on each box is how clips (<i>Send to</i>), Patches (<i>Input Module</i>) and modulators (<i>Out Controller</i>) refer to it.',
        ],
      },
      {
        title: 'Connect modules',
        items: [
          `${k('Shift')} + drag from a module to another to cable them. Keep moving over more modules: each one you touch is connected (or disconnected when already connected), so one source can feed many in one sweep.`,
          'Or drag a module so it overlaps another one: the dragged module is connected to it (or disconnected). Pull it off and back on to toggle again. With a selection, the grabbed module does this for every selected module in one undo step; selected modules never connect to each other.',
          'Cable styles: <b>solid</b> = audio (with a live waveform: the audio drifts slowly from the source to the destination, and a longer cable shows a longer stretch of it, so stretch a cable to read low notes), <b>dash-dot</b> = MIDI notes, <b>dotted</b> = modulation. An arrow shows the direction; two arrows point at each other on a two-way connection, each line ending at its own arrow so the two meet in the middle.',
          `Click a cable to see what it carries; ${k('Backspace')} removes it.`,
        ],
      },
      {
        title: 'Select',
        items: [
          'Click a module to select it: the controller panel shows its controllers, their descriptions and usage notes.',
          `Drag on empty canvas for a selection rectangle; ${k('Ctrl')} + drag adds to the selection, ${k('Ctrl')} + click toggles one module, ${k(CMD, 'A')} selects all.`,
        ],
      },
      {
        title: 'Move and arrange',
        items: [
          'Drag a module (or any module of a selection) to move it or the whole selection.',
          '<b>Snap to Grid</b> (right-click menu, a checkbox): moved and duplicated modules snap with their left edge and top to an invisible 20 px grid (half a module high), the same step sideways. Remembered on this computer.',
          `${k('Middle mouse')} + drag pans the canvas, the wheel zooms; click the zoom % (bottom right) to fit all modules. ${k('S')} maximizes the patcher, ${k('S')} again restores the piano roll and TimeLine.`,
        ],
      },
      {
        title: 'Copy, duplicate and delete',
        items: [
          `${k('Alt')} + drag a module to duplicate it (or the whole selection, with the cables between the copies).`,
          `${k(CMD)} + ${k('X')} / ${k('C')} / ${k('V')} cut, copy and paste; paste lands at the mouse pointer. The same commands are in the right-click menu (or the keyboard menu key).`,
          `${k('Backspace')} / ${k('Delete')} deletes the selection; the Output module always stays.`,
          `${k(CMD, 'Z')} undoes, ${k(CMD, 'Shift', 'Z')} (or ${k('Ctrl', 'Y')}) redoes; this covers the patcher and the sequencer.`,
        ],
      },
      {
        title: 'Name, save and load',
        items: [
          `${k('F2')} (or right-click → <b>Rename…</b>) gives a module its own name on its box; <b>Reset name</b> brings the type name back. The controller panel keeps showing the module type.`,
          'Right-click → <b>Set Color…</b> gives the selected modules their own colour: three R / G / B sliders with a preview of the box. <b>Reset color</b> brings back the stock colour of the module type. Cables, the controller panel and the clips sent to the module take the colour too; it is saved with the project.',
          '<b>Save module…</b> (right-click a module) writes it, or the whole selection with its cables and Patch contents, to a <b>.phmod</b> file (older .synth files load too).',
        ],
      },
      {
        title: 'Set controllers',
        items: [
          `Drag a controller, scroll it, or ${k('Double-click')} the number to type a value (${k('Tab')} moves on). Scroll a dropdown to change it. The keyboard focus stays where it was, so ${k('Space')} still plays.`,
          'Modulators (LFO, ADSR, ENVELOPE, VELOCITY2CTL, PITCH2CTL, SOUND2CTL) drive a controller of the modules they are cabled to: pick it with <b>Out Controller</b>, trim the range with <b>Out Min</b> / <b>Out Max</b>. A MULTICTL picks its controllers under <b>Routes</b>.',
          'OSC / ADSR: with <b>Sustain</b> at 0, <b>Decay</b> and <b>Release</b> are linked (their Curves too).',
          'OSC / ADSR: <b>Attack/Decay/Release Curve</b> bend each stage (0 = linear, +100 % = analog). Or drag the handles of the ADSR graph in the panel: the peak, the decay corner, the release end and the round curve dots.',
        ],
      },
      {
        title: 'Play live',
        items: [
          'Notes from your MIDI controller, the piano-roll keyboard and the computer keyboard play the module with the <b>MIDI</b> badge: the last selected MIDI module. Click the badge to lock MIDI to it (red), again to unlock. Every patch level has its own MIDI module and lock.',
          `Computer keyboard: ${k('Q')} … ${k('P')} are the white keys C4–E5, the number row above them (${k('2')} ${k('3')} ${k('5')} ${k('6')} ${k('7')} ${k('9')} ${k('0')}) the black keys. (In a focused piano roll ${k('Q')} quantizes instead.)`,
          'Choose the MIDI controller under <b>MIDI Input…</b> in the main menu.',
        ],
      },
      {
        title: 'Patches (modules inside a module)',
        items: [
          `${k('Double-click')} a Patch (or select it and press ${k('Enter')}, or right-click → <b>Open patch</b>) to enter it; the mouse <b>back</b> button or the patch path (<b>Main</b> / …, left on the lower divider) goes up.`,
          'Audio, MIDI and modulation cabled into a Patch go to its <b>Input Module</b> (default <kbd>1</kbd>: the first module inserted inside; <kbd>0</kbd> = straight to the inner Output). <b>Instances</b> plays notes round-robin over copies of the contents.',
          '<b>Controllers…</b> (in the panel of a selected Patch) maps controllers of modules inside onto the Patch module, so they can be set, modulated and automated from outside.',
          'Custom MIDI / modulation modules: inside a Patch, cable a MULTIMIDI or STRUM into the Output to send notes out of the Patch, or a modulator to send modulation out; cable the Patch module to modules outside to play / drive them.',
          'Each level has its own sequencer (piano roll and TimeLine) and its Output its own BPM, <b>Global Transpose</b> and <b>Global Cents Offset</b>. Play always plays the level you are on, so a Patch\'s TimeLine is a sketch pad that never sounds in the main song.',
        ],
      },
    ],
    keys: [
      [k('Double-click'), 'insert a module'],
      [`${k('Shift')} + drag`, 'connect / disconnect modules'],
      [`${k('Alt')} + drag`, 'duplicate'],
      [`${k('Ctrl')} + click / drag`, 'toggle / add to the selection'],
      [k(CMD, 'A'), 'select all modules'],
      [`${k(CMD)} + ${k('X')} / ${k('C')} / ${k('V')}`, 'cut / copy / paste at the pointer'],
      [`${k('Backspace')} ${k('Delete')}`, 'delete the selection or cable'],
      [k('F2'), 'rename the module'],
      [k('Enter'), 'open the selected Patch'],
      [`${k(CMD, 'Z')} / ${k(CMD, 'Shift', 'Z')}`, 'undo / redo'],
      [k('S'), 'maximize / restore the patcher'],
      [`${k('Middle mouse')} drag, wheel`, 'pan, zoom'],
      [`${k('Right-click')}`, 'menu: cut, copy, paste, delete, open, save / load module, rename, Snap to Grid'],
    ],
  },
  {
    id: 'timeline',
    title: 'TimeLine & automation',
    intro: 'The TimeLine (bottom pane) arranges the song: time runs left to right, clips sit on numbered lanes. <b>Note clips</b> play their notes into a module, <b>automation clips</b> (marked ∿) move one controller over time. The selected clip opens in the editor above the patcher.',
    steps: [
      {
        title: 'Create a note clip',
        items: [
          `${k('Double-click')} empty TimeLine space: a one-bar clip appears on that lane, at the grid position under the pointer, and opens in the piano roll.`,
          'Pick the module that plays it under <b>Send to</b> in the upper divider (the bar between the piano roll and the patcher).',
        ],
      },
      {
        title: 'Create an automation clip',
        items: [
          `${k('Double right-click')} empty TimeLine space: an automation clip (<i>Auto 1</i>, <i>Auto 2</i> …) appears and the automation editor replaces the piano roll.`,
          'In the upper divider choose the module under <b>Send to</b> and the controller it drives under <b>Controller</b>.',
          `In the automation editor (time runs down, the value left = min to right = max): ${k('Double-click')} inserts a point, drag moves it (${k('Shift')} = fine value), the wheel on a point rounds its corner, a right-click or ${k('Backspace')} deletes it.`,
          'While playing, the clip drives the controller like an LFO; outside the clip (or when stopped) the controller has its own value again.',
        ],
      },
      {
        title: 'Name a clip',
        items: [
          'The <b>Clip</b> field in the upper divider shows the name of the selected clip. Click it once to select the whole name and type the new one; it updates on the TimeLine as you type.',
          'The TimeLine shows the name followed by the module (and controller) the clip sends to. Linked clones share one name; copies keep the name of their source.',
        ],
      },
      {
        title: 'The Grid',
        items: [
          '<b>Grid</b> in the upper divider sets the snap step: a note value (Whole … 128th) divided by the number beside <b>÷</b> (1–64; e.g. Quarter ÷ 3 = eighth-note triplets). Hover the number to see the step in quarter notes.',
          '<b>TimeLine:</b> inserting, moving, trimming and resizing clips, pasting and the loop region snap to the grid step (the edges of neighbouring clips take priority).',
          '<b>Piano roll:</b> new notes start on the grid line at or before the pointer; dragging lengths and moving notes, pasting, the clip-end line, the velocity-curve point times, the arrow-key nudges, the wheel (one step per notch) and <b>Quantize</b> (Q) all use the grid step. The light / dark bands show it.',
          '<b>Automation editor:</b> the times of new and moved points snap to the grid step.',
          '<b>Free timing</b> (the checkbox beside the Grid) frees piano-roll notes and velocity-curve times from the grid; the bands stay as a guide and Quantize still snaps. The TimeLine and the automation editor keep snapping.',
          'The Grid and Free timing are saved per sequencer, so every Patch level has its own.',
        ],
      },
      {
        title: 'Arrange clips',
        items: [
          `Click a clip to select it (when stopped the playhead jumps to its start). Drag on empty space for a selection rectangle (${k(CMD)} adds); ${k(CMD)} + click toggles a clip.`,
          'Drag a clip (or the selection) to move it in time and up / down over the lanes; drag its left / right edge to trim the start / set the length. Near an edge of the view the TimeLine scrolls along.',
          'Clips never overlap: a moved, pasted or new clip snaps to the nearest free position, and resizing stops at neighbours. Use separate lanes for clips that play together.',
          `${k('Alt')} + drag copies; ${k('Shift')} + drag makes <i>linked clones</i> (hatched, ⧉) that share their notes: editing one edits all. ${k(CMD, 'D')} clones the selection right after itself, ${k(CMD, 'Shift', 'D')} duplicates it.`,
          'Park clips left of the bright zero line: they are not played by the song (<kbd>/</kbd> still auditions them), handy for source clips whose clones make up the song.',
          '<b>Idea storage</b>: scroll up above lane 1. Clips there sit wherever you drop them (no grid, no lanes, overlaps allowed) and are never played by the song; <kbd>/</kbd> loops an idea solo, without the lane clips around it. Drag an idea onto a lane to play it; it snaps like any clip.',
          'Pan the TimeLine with the wheel (sideways), Shift + wheel (lanes), middle-drag or the scrollbars below and right of it; the camera pans freely, also into empty space, and the scrollbars bring you back to your clips.',
          'The <b>M</b> / <b>S</b> buttons left of a lane number mute / solo it; drag over a column of buttons to switch many lanes. Mute wins over solo; a silenced clip shows a big M in its editor.',
        ],
      },
      {
        title: 'Clip menu and files',
        items: [
          '<b>Right-click</b> a clip: cut, copy, paste, delete, duplicate, clone, detach (a clone becomes standalone), go to source, <i>Consolidate</i> (selected clips on one lane become one clip), <i>Split at playhead</i> and <i>Save Clip…</i> (a <b>.clip</b> file).',
          '<b>Right-click</b> empty space: paste, insert a clip, or <i>Load Clip…</i> to place the clips of a .clip file there.',
          'File dialogs remember their folder per kind (projects opened, projects saved, clips, modules).',
        ],
      },
      {
        title: 'Ruler, loop and time signatures',
        items: [
          'Click the ruler to set the play position (on the signature row dragging scrubs). Drag along the ruler for a loop region (blue, snapped); song playback loops inside it. Right-click the region to remove it.',
          `${k('Double-click')} the ruler to insert a time signature change at the nearest bar line (or edit it); right-click a change to remove it.`,
        ],
      },
      {
        title: 'Play',
        items: [
          `${k('Space')} plays / stops (over the piano-roll grid: from the pointer's time). Stopping parks the playhead at the start of the selected clip.`,
          `${k('.')} plays / resumes the song, ${k(',')} restarts it at zero, ${k('/')} loops the time range of the selected clip with everything else that plays there, ${k("'")} stops (pressed again: panic, all notes and tails off).`,
          'The lower divider, left of the clock, has matching buttons: bar + play starts from the beginning, play resumes from the playhead, play + c loops the selected clip, and the square stops playback (press again for panic).',
          'While looping a clip, select another clip to switch to it when the current clip finishes. The selection at the loop boundary is the one that plays next.',
          'Starting in the middle of a note plays it for the rest of its length.',
        ],
      },
    ],
    keys: [
      [k('Double-click'), 'insert a note clip'],
      [k('Double right-click'), 'insert an automation clip'],
      [`${k('Alt')} + drag / ${k('Shift')} + drag`, 'copy / linked clone'],
      [`${k(CMD, 'D')} / ${k(CMD, 'Shift', 'D')}`, 'clone / duplicate the selection'],
      [`${k(CMD)} + ${k('X')} / ${k('C')} / ${k('V')}`, 'cut / copy / paste at the pointer (snapped)'],
      [`${k(CMD, 'A')} / ${k('Esc')}`, 'select all / clear the selection'],
      [`${k('Backspace')} ${k('Delete')}`, 'delete the selected clips'],
      [`${k('Space')} ${k('.')} ${k(',')} ${k('/')} ${k("'")}`, 'play/stop, song, restart, loop clip, stop/panic'],
      [`wheel / ${k('Shift')} + wheel`, 'scroll time / scroll lanes'],
      [`${k(CMD)} + wheel, ${k('Middle mouse')} drag`, 'zoom, pan'],
    ],
  },
  {
    id: 'pianoroll',
    title: 'Piano roll',
    intro: 'The piano roll (top pane) edits the notes of the selected note clip. Time runs <b>down</b>, pitch runs left to right over all 128 MIDI notes with the keyboard at the bottom. The strip on the left shows the velocity of every note. Click the piano roll first so it has keyboard focus.',
    steps: [
      {
        title: 'Write notes',
        items: [
          'Click empty space to insert a note at that pitch, starting on the grid line at or before the pointer, with the last used length; keep dragging to set its duration.',
          'Click / drag the keyboard at the bottom to audition pitches on the live MIDI module without writing notes. Keys held on your MIDI controller or the computer keyboard light up blue there, so you can read what you play. During playback the notes under the playhead light up their keys in the clip colour, so you can read the harmony.',
        ],
      },
      {
        title: 'Edit notes',
        items: [
          'Drag a note\'s coloured <b>body</b> to set its length (the end jumps to the snapped pointer); drag its <b>circle</b> to change pitch (sideways) and start time (up / down).',
          `${k('Alt')} + drag a note (body or circle) moves a clone of it.`,
          `<b>Micropitch</b>: ${k('Shift')} + drag a note\'s circle sideways to tune it up or down (slowly, in 0.1 cent steps); a slider shows the cents while you drag and the note sounds along. With several notes selected, all of them change by the same amount. The note stays on its key (from −50 to just under +50 cents) and its circle leans sideways to show the tuning; menu → <b>Reset tuning</b> puts the selection back on its keys.`,
          `${k('Left')} / ${k('Right')} transpose the selection by a semitone, ${k('Up')} / ${k('Down')} move it by one grid step; with ${k('Shift')}: an octave / a bar.`,
          'A short right-click deletes the note under the pointer.',
        ],
      },
      {
        title: 'Select notes',
        items: [
          `Click a note to select it, ${k('Shift')} + click toggles it. ${k('Shift')} + drag (starting off a note\'s circle) or ${k('right')} + drag draws a selection rectangle; while dragging, scroll the wheel or move past the top / bottom edge to extend it over the whole clip.`,
          `${k(CMD, 'A')} selects all notes, ${k('Esc')} or a short right-click on empty space clears the selection. Selected notes are filled blue.`,
          'Dragging any selected note moves or resizes the whole selection.',
        ],
      },
      {
        title: 'Clip length',
        items: [
          'Drag the thick end line of the clip up or down to shorten or lengthen the clip (snapped, never into the next clip on its lane); the wheel or the top / bottom edge scrolls along, <kbd>Esc</kbd> cancels.',
          'Past the end the grid is shaded: notes there do not play.',
        ],
      },
      {
        title: 'Velocity',
        items: [
          'The strip left of the notes shows each note\'s velocity (stick) and how it changes while the note sounds. Drag a note\'s dot to set its velocity; with several notes selected, dragging one dot moves the start velocity of all of them.',
          `The selected notes share one velocity curve: ${k('Double-click')} inside them adds a point, drag points (${k('Shift')} = fine), the wheel on a point rounds it. ${k('Alt')} + drag moves only the curve point.`,
          'Right-click the strip for <b>Snap velocity values</b> (1/16 steps, shown as alternating light/dark bands while on) and <b>Delete point</b>. Drag the bar ruler beside the strip to make it wider (double-click resets).',
        ],
      },
      {
        title: 'Menu and clipboard',
        items: [
          'Hold the right mouse button still for <b>250 ms</b> to open the menu (cut, copy, paste, delete, duplicate, quantize, octave, reset tuning); releasing after it opened never deletes a note.',
          `${k(CMD)} + ${k('X')} / ${k('C')} / ${k('V')} cut, copy and paste notes at the pointer\'s snapped time (pitches and timing are kept); ${k(CMD, 'D')} duplicates the selection right after itself; ${k('Q')} quantizes note starts (the selection, else all).`,
        ],
      },
      {
        title: 'Navigate and play',
        items: [
          `The wheel scrolls one grid step per notch (scroll up past beat zero for some free room); ${k(CMD)} + wheel zooms time, ${k('Middle mouse')} + drag pans.`,
          `${k('Space')} over the note grid plays the song from that (snapped) time.`,
        ],
      },
    ],
    keys: [
      ['click / drag', 'insert a note / set its duration'],
      [`${k('Shift')} + drag, ${k('right')} + drag`, 'selection rectangle'],
      [`${k('Shift')} + click`, 'toggle a note in the selection'],
      [`${k('Shift')} + drag a circle sideways`, 'micropitch: tune the note in cents'],
      [`${k('Alt')} + drag`, 'clone and move'],
      ['short right-click', 'delete the note (empty space: deselect)'],
      ['hold right 250 ms', 'menu'],
      [`${k('Left')} ${k('Right')} / ${k('Up')} ${k('Down')}`, 'transpose / move by a grid step (Shift: octave / bar)'],
      [`${k(CMD)} + ${k('X')} / ${k('C')} / ${k('V')}`, 'cut / copy / paste at the pointer'],
      [k(CMD, 'D'), 'duplicate the selection'],
      [k('Q'), 'quantize note starts'],
      [`${k(CMD, 'A')} / ${k('Esc')}`, 'select all / clear the selection'],
      [`${k('Backspace')} ${k('Delete')}`, 'delete the selected notes'],
      [k('Space'), 'play from the pointer'],
      [`${k(CMD)} + wheel`, 'zoom time'],
    ],
  },
  {
    id: 'workspace',
    title: 'Workspace & files',
    intro: 'Projects, export and the window layout.',
    steps: [
      {
        title: 'Main menu',
        items: [
          `Click <b>PHILSYNTH</b> (top-right corner) for <b>New</b> (${k(CMD, 'N')}), <b>Open…</b> (${k(CMD, 'O')}), <b>Save</b> (${k(CMD, 'S')}), <b>Save As…</b> (${k(CMD, 'Shift', 'S')}), <b>Export Audio…</b> (${k(CMD, 'E')}), <b>MIDI Input…</b> and <b>Exit</b>.`,
          'Projects are <b>.phproject</b> files (older .mds / .json projects open too). The file name shows in the status bar and the window title, with <b>•</b> for unsaved changes; New and Open ask to save them first. Every change is also autosaved, so the app starts with your latest project.',
          '<b>MIDI Input…</b> picks the MIDI controller; <i>Auto</i> uses every input except Linux\'s <i>Midi Through</i>, <b>Re-scan</b> finds newly plugged-in devices.',
          `${k('Esc')} (when nothing else is open) asks <b>Exit to OS?</b>: ${k('Enter')} saves and closes, ${k('Esc')} cancels.`,
        ],
      },
      {
        title: 'Export audio',
        items: [
          'Renders the song offline from its start to the end of the last clip (or just the loop region) plus up to 10 s of tail, to a 24-bit stereo WAV at the device sample rate. The status bar warns when the mix clips.',
        ],
      },
      {
        title: 'Layout',
        items: [
          'Piano roll, patcher and TimeLine are stacked top to bottom. Drag a divider up / down to resize the panes (to an edge hides a pane), left / right to resize this controller panel. Arrow keys, Home and End move a focused divider. Positions are saved with the project.',
          'The upper divider holds the clip name, <i>Send to</i>, the Grid and Free timing; when it is too narrow, move the pointer along it to reveal its controls. The lower divider shows the patch path on the left and the TimeLine transport buttons and play position immediately left of the clock on the right.',
        ],
      },
    ],
    keys: [],
  },
];

// <section class="guide"> with one collapsible <details> per tutorial
export function renderGuide(doc = document) {
  const el = (tag, cls, html) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html; // static strings only
    return e;
  };
  const root = el('section', 'guide');
  for (const t of GUIDE) {
    const d = el('details', 'guide-part');
    d.open = true;
    d.dataset.guide = t.id;
    d.append(el('summary', null, t.title), el('p', 'guide-intro', t.intro));
    t.steps.forEach((step, i) => {
      d.append(el('h3', null, `<span class="ctl-num">${i + 1}</span>${step.title}`));
      const ul = el('ul', 'guide-steps');
      for (const item of step.items) ul.append(el('li', null, item));
      d.append(ul);
    });
    if (t.keys.length) {
      d.append(el('h3', null, 'Shortcuts'));
      const table = el('table', 'guide-keys');
      for (const [keys, action] of t.keys) {
        const tr = el('tr');
        tr.append(el('th', null, keys), el('td', null, action));
        table.append(tr);
      }
      d.append(table);
    }
    root.append(d);
  }
  return root;
}
