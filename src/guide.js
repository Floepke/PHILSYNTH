// The manual shown in the controller panel when nothing is selected: About, Interface, Patcher,
// Pianoroll and Timeline, Automation and Workspace. Each is { id, title, intro, steps: [{ title, items: [html] }],
// keys: [[keys html, action html]] }. Static HTML strings only (rendered with innerHTML).
// Keep them in step with the code when interactions or shortcuts change.

const k = (...keys) => keys.map((x) => `<kbd>${x}</kbd>`).join(' + ');
const CMD = 'Ctrl/Cmd';

export const GUIDE = [
  {
    id: 'about',
    title: 'About — a note from the author',
    intro: 'Welcome to <b>PHILSYNTH</b>! I am building this app to bring expressive note editing and modular sound design together: a place to write music, build instruments and explore how every note can come alive.',
    steps: [
      {
        title: 'Expression belongs to every note',
        items: [
          'A note can be more than a pitch, a starting velocity and a duration. PHILSYNTH’s internal <b>MULTIMIDI</b> system brings together <b>micropitch</b>, independent <b>pitch bends</b> and <b>velocity fading for every note</b>. Notes sounding together can each follow their own pitch and velocity curves, rather than all moving as one.',
          'For me, the exciting part is what happens when an instrument responds to velocity with changes in <b>sound colour</b>, not just loudness. A fading note can soften in character, another can grow brighter, and each voice can bend independently. Instruments designed around that response can be wonderfully expressive.',
        ],
      },
      {
        title: 'A different way to see music',
        items: [
          'The pianoroll’s design is inspired by <b>Klavarskribo</b>, a music notation that relates pitches directly to the piano keyboard. Here, time runs downward and pitches follow the keys from left to right, with a stave built around the black keys.',
          'I wanted an editor where the relationship between the notes and the keyboard feels visible and direct, while leaving room to shape the details: tiny tuning differences, individual bends and changing velocity throughout a note.',
        ],
      },
      {
        title: 'Why go beyond traditional MIDI?',
        items: [
          'I have always felt a limitation in traditional MIDI: note velocity is normally a value at the start, not a curve that fades while the note sounds, and pitch bend belongs to a channel rather than an individual note. That makes independently expressive voices awkward to work with.',
          'I know about <b>MPE</b>, which makes per-note expression possible by assigning notes to separate channels, but not every plugin supports it. I wanted these expressive possibilities to be a natural part of the editor and its internal instruments, rather than something dependent on each plugin’s compatibility.',
        ],
      },
      {
        title: 'Instruments I hope to return to',
        items: [
          'Another motivation is the life of a project. Plugins evolve, their internal designs change, and older versions can disappear or stop running. I worry about opening a piece ten years from now and finding that its instruments can no longer be loaded.',
          'Keeping the instruments and their modular designs together in one app is my way of working toward something more self-contained and easier to return to. It is a goal, not a promise that software will never change, but it strongly shapes the project.',
        ],
      },
      {
        title: 'Inspired by SunVox, built through exploration',
        items: [
          'PHILSYNTH is deeply inspired by <b>SunVox</b>, the original software by <b>Alexander Zolotov</b>. Its modular approach to building instruments is a major inspiration. My starting wish was simple: I wanted to work in a pianoroll editor with the kind of modular sound-design workflow I enjoyed in SunVox.',
          'That wish led me to try building this app, making extensive use of modern development tools. PHILSYNTH is its own project, not SunVox with a different editor, but I want to acknowledge that inspiration with gratitude.',
          'The process itself is part of the pleasure: refining each module, listening carefully, and discovering how the modules can work together as instruments. There is always another interaction to improve or a new sound to find. I hope that curiosity comes through when you make music here.',
        ],
      },
    ],
    keys: [],
  },
  {
    id: 'interface',
    title: 'Interface',
    intro: 'This space is the controller area for modules selected in the patcher. Click empty space in the patcher to deselect them and show this manual. Open a heading below to read a section.',
    steps: [
      {
        title: 'Find your way',
        items: [
          'The <b>piano roll</b> at the top edits notes, the <b>patcher</b> in the middle builds instruments, and the <b>TimeLine</b> at the bottom arranges clips. Keyboard shortcuts act on the area you last clicked: for example, Delete removes selected notes in the piano roll or selected modules in the patcher.',
          'Select a module to replace this manual with its controllers, descriptions and usage notes. Click empty space in the patcher to return to the manual. Your reading position and open / closed chapters are remembered on this device, including after reopening the app, separately from your project. Drag the dividers to resize or hide areas.',
          'Click <b>PHILSYNTH</b> for project commands and <b>Preferences…</b>. Preferences are saved on this device, separately from your project.',
        ],
      },
      {
        title: 'Make your own shortcuts',
        items: [
          '<b>Right-click a button</b>, or open a right-click menu and <b>right-click an action inside it</b>, to open <b>Learn keyboard shortcut</b>. Press the key or key combination you want; an available combination is saved automatically.',
          'If the combination is already in use, the dialog explains the conflict so you can choose another. <b>Cancel</b> or Escape leaves it unchanged.',
          'Your custom shortcut replaces the default. Right-click the same action again and choose <b>Restore default</b> to reset it. Reset all mappings under <b>Preferences… > Keyboard > Custom shortcuts</b>. Shortcuts are remembered on this device.',
        ],
      },
    ],
    keys: [],
  },
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
          'In the desktop Load module file picker, switch on <b>Preview Instrument</b> to play the selected file with your MIDI keyboard through a temporary, dry Output. The current project stays unchanged. Selecting another file replaces the preview; switching it off, changing folders or closing the picker stops it. Preview starts switched off.',
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
          'Click a module to select it: the controller panel shows its controllers, their descriptions and usage notes. Mini editors have matching section headings. Module and editor titles stay on one line as you resize the panel; hover a shortened title to read its full name.',
          `Drag on empty canvas or use the mouse <b>Forward</b> button + drag to draw a selection rectangle; ${k('Shift')} + drag on empty canvas pans the view (also on a trackpad). Forward-drag can also start over a module. ${k(CMD)} + drag adds to the selection, ${k(CMD)} + click toggles one module, ${k(CMD, 'A')} selects all.`,
        ],
      },
      {
        title: 'Move and arrange',
        items: [
          'Drag a module (or any module of a selection) to move it or the whole selection. Near / past the edge of the patcher the view pans along (also while duplicating, Shift-wiring or drawing a selection rectangle).',
          '<b>Snap to Grid</b> (right-click menu, a checkbox): moved and duplicated modules snap with their left edge and top to an invisible 20 px grid (half a module high), the same step sideways. Remembered on this computer.',
          `${k('Shift')} + drag on empty canvas or ${k('Middle mouse')} + drag (also over modules) pans the canvas. The mouse wheel or two-finger trackpad scrolling zooms around the pointer on every platform; pinch or ${k(CMD)} + wheel also zooms. The spectrum icon (top right) switches the spectrogram on or off. Drag the dividers to resize or hide the piano roll and TimeLine.`,
        ],
      },
      {
        title: 'Copy, duplicate and delete',
        items: [
          `${k('Alt')} + drag a module to duplicate it (or the whole selection, with the cables between the copies).`,
          `${k(CMD)} + ${k('X')} / ${k('C')} / ${k('V')} cut, copy and paste; paste lands at the mouse pointer. The same commands are in the right-click menu (or the keyboard menu key).`,
          `${k('Backspace')} / ${k('Delete')} deletes the selection; the Output module always stays.`,
          `${k(CMD, 'Z')} undoes, ${k(CMD, 'Shift', 'Z')} (or ${k('Ctrl', 'Y')}) redoes; this covers the patcher and the sequencer. Each completed sequencer edit is a separate undo step, including notes edited quickly in succession.`,
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
          `Drag a controller, scroll it, or ${k('Double-click')} the number to type a value (${k('Tab')} moves on). Scroll a dropdown to change it one option at a time, even with accelerated scrolling. The keyboard focus stays where it was, so ${k('Space')} still plays.`,
          'Modulators (LFO, ADSR, ENVELOPE, VELOCITY2CTL, PHASE2CTL, PITCH2CTL, SOUND2CTL) drive a controller of the modules they are cabled to: pick it with <b>Out Controller</b>, trim the range with <b>Out Min</b> / <b>Out Max</b>. PHASE2CTL uses the newest note\'s start phase, with the same smoothing and note-off actions as VELOCITY2CTL. A MULTICTL picks its controllers under <b>Routes</b>.',
          'OSC / OPERATOR / ADSR: with <b>Sustain</b> at 0, <b>Decay</b> and <b>Release</b> are linked (their Curves too).',
          'OSC / OPERATOR / ADSR: <b>Attack/Decay/Release Curve</b> bend each stage (0 = linear, +100 % = analog). Or drag the handles of the ADSR graph in the panel: the peak, the decay corner, the release end and the round curve dots. Right-click the graph to <b>Copy ADSR</b> and <b>Paste ADSR</b> it into another module.',
          '<b>OPERATOR</b> builds FM instruments with sine phase modulation: send MIDI to both operators, then cable audio A → B → Output. <b>Modulation Amount</b> scales input phase depth (100 % = one cycle at amplitude 1); <b>Feedback</b> adds internal self-modulation. Use MULTIMIDI OVERTONE for ratios and TUNING for tuning. Each operator is monophonic; use <b>Patch Instances</b> for separate polyphonic copies of the whole network.',
          '<b>TRILL</b> turns held keys into a human-like trill: two keys alternate, more keys follow <b>Order</b>. <b>Note Separation</b> and <b>Note Length</b> are whole-note divisions at the BPM (16 = 1/16, 12 = 1/8 triplet; higher = faster / shorter); <b>Humanize</b> adds timing, length and velocity variation. <kbd>Shift</kbd> + drag it to the sound module.',
        ],
      },
      {
        title: 'Play live',
        items: [
          'Notes from your MIDI controller, the piano-roll keyboard and the computer keyboard play the module with the <b>MIDI</b> badge: the last selected MIDI module. Click the badge to lock MIDI to it (red), again to unlock. Every patch level has its own MIDI module and lock.',
          `Computer keyboard: ${k('Q')} … ${k('P')} are the white keys C4–E5, the number row above them (${k('2')} ${k('3')} ${k('5')} ${k('6')} ${k('7')} ${k('9')} ${k('0')}) the black keys. In a focused piano roll ${k('Shift', 'Q')} quantizes; plain ${k('Q')} still plays C4.`,
          'Choose the MIDI controller under <b>Preferences… > MIDI > MIDI Input</b> in the main menu.',
        ],
      },
      {
        title: 'Patches (modules inside a module)',
        items: [
          `Select a Patch and click <b>Edit Patch...</b> beside <b>Controllers…</b> to enter it (or ${k('Double-click')}, press ${k('Enter')}, or right-click → <b>Open patch</b>); ${k('Esc')}, the mouse <b>back</b> button or the patch path (<b>Main</b> / …, left on the lower divider) goes up and selects the Patch module you returned from.`,
          'While inside an uncabled Patch, its Output is heard directly through the main Output. Once the Patch is cabled, its normal connections are used instead.',
          'Audio, MIDI and modulation cabled into a Patch go to its <b>Input Module</b> (default <kbd>1</kbd>: the first module inserted inside; <kbd>0</kbd> = straight to the inner Output). <b>Instances</b> plays notes round-robin over copies of the contents.',
          '<b>Controllers…</b> (in the panel of a selected Patch) maps controllers of modules inside onto the Patch module, so they can be set, modulated and automated from outside.',
          'Custom MIDI / modulation modules: inside a Patch, cable a MULTIMIDI, STRUM or TRILL into the Output to send notes out of the Patch, or a modulator to send modulation out; cable the Patch module to modules outside to play / drive them.',
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
      [`${k('Shift')} + drag empty canvas / ${k('Middle mouse')} drag, wheel`, 'pan, zoom'],
      ['drag empty canvas / Forward button + drag', 'selection rectangle'],
      ['Wheel / two-finger scroll / pinch', 'zoom around the pointer'],
      [`${k('Right-click')}`, 'menu: cut, copy, paste, delete, open, save / load module, rename, Snap to Grid'],
    ],
  },
  {
    id: 'timeline',
    title: 'Pianoroll and Timeline',
    intro: 'The <b>TimeLine</b> (bottom pane) arranges the song: time runs left to right, and clips sit on numbered lanes. Select a <b>note clip</b> to edit its notes in the <b>pianoroll</b> above the patcher, where time runs down. These are two views of the same clip: edit its notes above, then arrange it in the song below. Automation clips (marked ∿) use the same TimeLine but open a controller-curve editor instead; see the Automation chapter.',
    steps: [
      {
        title: 'Create a note clip',
        items: [
          `${k('Double-click')} empty TimeLine space: a one-bar clip appears on that lane, at the grid position under the pointer, and opens in the piano roll.`,
          'Pick the module that plays it under <b>Send to</b> in the upper divider (the bar between the piano roll and the patcher). With multiple MIDI clips selected in the TimeLine, this changes all their destinations in one undoable edit; selected automation clips are left unchanged. Linked clones still share their destination.',
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
          '<b>TimeLine:</b> inserting, moving, trimming and resizing clips and pasting snap to the grid step (the edges of neighbouring clips take priority). The restart marker instead snaps to barlines (whole measures), independently of the Input Grid.',
          '<b>Piano roll:</b> new notes start on the grid line at or before the pointer; dragging lengths and moving notes, pasting, the clip-end line, the velocity-curve point times, the arrow-key nudges and <b>Quantize</b> (Shift + Q) all use the grid step. The light / dark bands show it.',
          '<b>Automation editor:</b> the times of new and moved points snap to the grid step.',
          '<b>Free timing</b> (the checkbox beside the Grid) frees piano-roll notes and velocity-curve times from the grid; the bands stay as a guide and Quantize still snaps. Press <kbd>F</kbd> to toggle it, or right-click the checkbox or its label to assign a custom shortcut. The TimeLine and the automation editor keep snapping.',
          'The Grid and Free timing are saved per sequencer, so every Patch level has its own.',
        ],
      },
      {
        title: 'Read the pianoroll',
        items: [
          'Our one-of-a-kind pianoroll combines a stave with a piano keyboard. Time runs <b>down</b>, and pitch runs left to right across all 128 MIDI notes. The vertical stave lines connect to the <b>black keys</b> of the keyboard at the bottom. Each notehead reflects its key’s colour—black or white—so you can relate notes to the keyboard at a glance. The strip on the left shows note velocity.',
          'Selecting a note also makes the pianoroll the active editor: Delete then removes selected notes, and the arrow keys move them, rather than editing modules or clips in another pane.',
        ],
      },
      {
        title: 'Pianoroll: write notes',
        items: [
          'Click empty space to insert a note at that pitch, starting on the grid line at or before the pointer, with the last used length; move more than 10 pixels while holding to start setting its duration.',
          'Click / drag the keyboard at the bottom to audition pitches on the live MIDI module without writing notes. Keys held on your MIDI controller or the computer keyboard light up blue there, so you can read what you play. During playback the notes under the playhead light up their keys in the clip colour, so you can read the harmony.',
          'Drag the empty cell to the left or right of the keyboard up or down to make the keyboard taller or shorter; double-click a cell to reset it. The height is remembered on this computer, not saved in the project.',
        ],
      },
      {
        title: 'Pianoroll: select notes',
        items: [
          `Click a note to select it, ${k(CMD)} + click toggles it without moving or resizing it, just as for modules and clips. ${k('Shift')} + drag (starting off a note\'s circle) or ${k('right')} + drag draws a selection rectangle; while dragging, scroll the wheel or move past the top / bottom edge to extend it over the whole clip.`,
          `${k(CMD, 'A')} selects all notes; ${k('Esc')} clears the selection. Selected notes are filled blue.`,
          'Dragging any selected note moves or resizes the whole selection.',
        ],
      },
      {
        title: 'Pianoroll: edit notes',
        items: [
          'Drag a note\'s coloured <b>body</b> more than 10 pixels to start setting its length. One note\'s end jumps to the snapped pointer; with several notes selected, dragging increases or decreases every duration by the same amount, preserving their length differences. Shortening stops when the shortest note reaches the minimum length. Drag a note\'s <b>circle</b> to change pitch (sideways) and start time (up / down).',
          'Every drag along time (note lengths and moves, bend and velocity points, the clip end, selection rectangles, automation points) scrolls the view along when you hold the pointer near / past the top or bottom edge, faster further out; the wheel scrolls along too.',
          `${k('Alt')} + drag a note (body or circle) moves a clone of it.`,
          `<b>Micropitch</b>: ${k('Shift')} + drag a note\'s circle sideways to tune it up or down (slowly, in 0.1 cent steps); a slider shows the cents while you drag and the note sounds along. With several notes selected, all of them change by the same amount. The note stays on its key (from −50 to just under +50 cents); the whole note (circle and coloured body) shifts sideways to show the tuning; menu → <b>Reset tuning</b> puts the selection back on its keys.`,
          `<b>Pitch bend</b>: select a note and double-click its coloured body to add a bend point (keep the second press held to drag it right away). The note becomes a thick line through its bend points and glides along them while it plays. Pitch snaps to whole notes; hold ${k('Shift')} for free pitch editing sideways. Point times snap to the grid unless <b>Free timing</b> is on; Shift only frees pitch, not time. Points stay between their neighbours and inside the note. Scroll on a point to round its corner, right-click a point to delete it; menu → <b>Reset bend</b> straightens the selection. Moving, transposing or tuning a note takes its bend along.`,
          `${k('Left')} / ${k('Right')} transpose the selection by a semitone, ${k('Up')} / ${k('Down')} move it by one grid step; with ${k('Shift')}: an octave / a bar.`,
          'A short right-click deletes the note under the pointer.',
        ],
      },
      {
        title: 'Pianoroll: clip length',
        items: [
          'Drag the thick end line of the clip up or down to shorten or lengthen the clip (snapped, never into the next clip on its lane); the wheel or the top / bottom edge scrolls along, <kbd>Esc</kbd> cancels. This changes the length of the clip in the TimeLine too.',
          'Past the end the grid is shaded: notes there do not play.',
        ],
      },
      {
        title: 'Pianoroll: velocity',
        items: [
          'The strip left of the notes shows each note\'s velocity (stick) and how it changes while the note sounds. Dragging a selected start dot sets every selected note to the same start velocity, regardless of start time. Each curve shifts by its own start-velocity change, clamping points at 0 or 100 %; point times and rounding stay unchanged.',
          `${k('Double-click')} inside a selected note adds a point for every selected note at the same offset from its start (clamped to shorter notes\' ends). Dragging an existing point edits points at the same timeline time (${k('Shift')} = fine), creating missing points in selected notes sounding then, never changing start velocities or other points. The wheel rounds same-time points. Select just one note to edit it alone.`,
          'Right-drag in the velocity strip to draw a selection rectangle: enclosing start dots selects their notes; enclosing curve points selects those individual points. Drag a selected point to move the selected points together in time and velocity. The wheel or dragging past the top / bottom edge extends the rectangle; Escape cancels. Right-click a point for <b>Delete point</b>.',
          '<b>Preferences… > Pianoroll > Snap velocity values to 16 step grid.</b> enables 1/16-step velocity snapping, shown as alternating light/dark bands. This is a device preference, not part of the project, and does not quantize existing values.',
          'Drag the bar ruler beside the strip sideways to resize the velocity editor and vertically to zoom time (up zooms in, down zooms out). Zoom stays anchored at the original grab position; both axes work simultaneously during diagonal drags. In Electron the cursor locks during ruler drags and returns to its press position on release; web browsers use ordinary cursor dragging. Double-click resets the width; the wheel still scrolls time.',
        ],
      },
      {
        title: 'Pianoroll: menu and clipboard',
        items: [
          'Right-click empty space to open the menu (cut, copy, paste, delete, duplicate, quantize, octave, reset tuning, reset bend). On an existing note, hold the right mouse button still to open it instead of deleting the note; releasing after the menu opened never deletes it. Left-click outside the menu to close it without editing notes; the next click works normally. Right-drag still draws a selection rectangle.',
          `${k(CMD)} + ${k('X')} / ${k('C')} / ${k('V')} cut, copy and paste notes at the pointer\'s snapped time (pitches and timing are kept); ${k(CMD, 'D')} duplicates the selection right after itself; ${k('Shift', 'Q')} quantizes note starts and ends to the Input Grid (the selection, else all), even with Free timing on. Notes keep at least one grid step of length.`,
        ],
      },
      {
        title: 'Pianoroll: navigate',
        items: [
          `The wheel or trackpad scrolls smoothly (scroll up past beat zero for some free room; with the pitch zoomed in, swiping sideways pans the keys); ${k(CMD)} + wheel zooms time, ${k('Middle mouse')} + drag pans. The scrollbar on the right (the TimeLine\'s look) spans the clip: drag it, or click its track to jump there.`,
          `${k('Shift')} + wheel zooms pitch around the pointer: the stave and the keyboard widen together, so micropitch leans and bends are easier to place. Zoomed in, a horizontal scrollbar shows just above the keyboard, ${k('Middle mouse')} + drag also pans sideways, and moving notes, bend points or a selection rectangle past the left / right edge scrolls along. Notes stop growing at 48 px wide. Zoom fully out to see all keys again; the view is saved with the project and restored on startup.`,
          `${k('Space')} over the note grid plays the song from that (snapped) time. The shared transport and recording controls are described under <b>Play and record</b> below.`,
        ],
      },
      {
        title: 'Timeline: arrange clips',
        items: [
          `Click a clip to select it (when stopped the playhead jumps to its start). Double-click a clip to focus its editor and maximize the piano roll area by moving both dividers to the bottom; drag the dividers back to show the other panes. Drag on empty space or use the mouse <b>Forward</b> button + drag to draw a selection rectangle (${k(CMD)} + drag adds); ${k('Shift')} + drag on empty space pans the view (like the patcher). Forward-drag can also start over a clip. ${k(CMD)} + click toggles a clip. One clip always stays selected (a new project starts with one empty bar, selected), so the piano roll always shows a clip.`,
          `Drag a clip (or the selection) to move it in time and up / down over the lanes; drag its left / right edge to trim the start / set the length. ${k(CMD)} + drag an edge time-stretches the clip instead: the notes inside (with their velocity and bend curves, or the automation points) scale along, the other edge stays put; linked clones stretch together. ${k(CMD)} + click without dragging still toggles the selection. Every drag (clips, the selection rectangle, the restart marker, scrubbing, the M / S buttons) scrolls the TimeLine along near / past an edge of the view.`,
          'A new clip (double-click empty TimeLine space or <b>Insert clip</b>) plays the module selected in the patcher. When none is selected, or the selected one takes no notes (Filter, Output…), it plays the last selected module of this patch level that does.',
          'Clips never overlap: a moved, pasted or new clip snaps to the nearest free position, and resizing stops at neighbours. Use separate lanes for clips that play together.',
          `${k('Alt')} + drag copies; ${k('Shift')} + drag makes <i>linked clones</i> (hatched, ⧉) that share their notes: editing one edits all. ${k(CMD, 'D')} clones the selection right after itself, ${k(CMD, 'Shift', 'D')} duplicates it.`,
          'The TimeLine starts at the first measure (time zero): scrolling, zooming and clip placement cannot go earlier. Clips saved before time zero in older projects are kept, but their negative-time portions are outside the view. Use idea storage above the lanes for source clips and unused ideas.',
          '<b>Idea storage</b>: scroll up above lane 1. Clips there sit wherever you drop them (no grid, no lanes, overlaps allowed) and are never played by the song; <kbd>/</kbd> loops an idea solo, without the lane clips around it. Drag an idea onto a lane to play it; it snaps like any clip.',
          'Pan the TimeLine with the wheel (sideways), Shift + wheel (lanes), Shift + drag on empty space, middle-drag or the scrollbars below and right of it. The bottom scrollbar also zooms time when dragged vertically (up zooms in, down zooms out), simultaneously with horizontal scrolling. Electron locks the cursor during this gesture; web browsers use ordinary cursor dragging. Upward scrolling stops when the idea-storage message reaches the bottom of the view; the scrollbars bring you back to your clips.',
          'The <b>M</b> / <b>S</b> buttons left of a lane number mute / solo it; drag over a column of buttons to switch many lanes. Mute wins over solo; a silenced clip shows a big M in its editor.',
        ],
      },
      {
        title: 'Timeline: clip menu and files',
        items: [
          '<b>Right-click</b> a clip: cut, copy, paste, delete, duplicate, clone, detach (a clone becomes standalone), go to source, <i>Consolidate</i> (selected clips on one lane become one clip), <i>Split at playhead</i> (S while the TimeLine is focused) and <i>Save Clip…</i> (a <b>.clip</b> file).',
          '<b>Right-click</b> empty space: paste, insert a clip, or <i>Load Clip…</i> to place the clips of a .clip file there.',
          '<i>Import MIDI…</i> imports a Standard MIDI File (.mid or .midi, formats 0, 1 or 2) as one unassigned note clip per track, including empty tracks. Assign a <i>Send to</i> module to hear each clip. Tracks start together at the clicked time; occupied lanes are skipped. Imports into idea storage stay there and do not play unless looped.',
          'Choose Yes to import tempo into an automation clip targeting Output BPM; No keeps the current tempo and MIDI beat positions. Tempo changes are abrupt, and fractional BPM values are rounded to whole BPM while clip timing is adjusted to preserve elapsed time. Tempos outside the Output BPM range are limited and reported. Format 2 uses the first track’s tempo, with other tracks aligned by elapsed time. Imported automation in idea storage does not play unless looped.',
          'MIDI notes, velocities and track names are imported. MIDI channels are combined within each track; controllers, programs, pitch bends and time signatures are not imported. PPQN timing uses MIDI beats when tempo is not imported; SMPTE timing uses MIDI tempo events (120 BPM before the first tempo). Unmatched note-offs are ignored; unfinished or zero-length notes are repaired and reported in the status bar.',
          'File dialogs remember their folder per kind (projects opened, projects saved, clips, modules).',
        ],
      },
      {
        title: 'Timeline: ruler, restart point and time signatures',
        items: [
          'Drag the timeline measure ruler left/right to pan horizontally and up/down to zoom around the grabbed time; both axes act together without moving the playhead. Clicking it leaves the playhead unchanged. In Electron the cursor locks during the drag and returns to its press position on release; web browsers use ordinary cursor dragging without pointer lock. Escape cancels navigation. Restart markers still drag to change their position.',
          'Click the time signature row to set the play position; dragging there scrubs.',
          `${k('Double-click')} the time signature row to insert a time signature change at the nearest bar line (or edit it); right-click a change to remove it.`,
          'Drag a green signature flag left or right to move it by whole bars of the preceding meter. The initial signature stays at zero. Later changes snap to their nearest whole measure without reordering or overlapping; clips and notes do not move. The grid updates during the drag; Escape cancels, and release records one undo step.',
          'Choose Insert/Edit time-Signature Change… from the timeline clip, empty-space or ruler context menu to open the same dialog at the nearest bar to the right-click position. Hold right-click on an existing signature or restart marker to open this menu without removing it.',
          'The time-signature dialog includes a two-octave stave preview with time running downward. The entire measure scales to fit the available editor height. Click a numbered beat row to show or hide its piano-roll line; beat 1 controls the barline. Editing either time-signature field resets all beats to enabled. These choices repeat each measure and do not change snapping, playback or ruler marks.',
          '<b>Restart point</b>: double-click the bar numbers on the ruler, or right-click the ruler (or a clip / empty space) → <i>Insert restart point at playhead</i>. Placement and dragging snap to the nearest barline (whole measures), following time-signature changes and ignoring the Input Grid. A green <b>restart:</b> | marks it in the bar number row; drag it to move it. Song playback continues there when it reaches the end of the song, and stopping it (Space, <kbd>\'</kbd> or the stop button) returns the playhead there; the <kbd>/</kbd> clip loop ignores it. Right-click the marker (or drag it to time zero) to remove it.',
        ],
      },
      {
        title: 'Play and record',
        items: [
          `${k('Space')} plays / stops (over the piano-roll grid or automation lane: from the pointer's time). Stopping parks the playhead at the restart point (when set), else at the start of the selected clip. The playhead line is only drawn during playback; when stopped it is hidden, but its parked position still sets where play resumes.`,
          `${k('.')} plays / resumes the song, ${k(',')} restarts it at zero, ${k('/')} loops the time range of the selected clip with everything else that plays there, ${k("'")} stops (pressed again: panic, all notes and tails off).`,
          'The lower divider, left of the clock, has matching buttons: bar + play starts from the beginning, play resumes from the playhead, play + c loops the selected clip, and the square stops playback (press again for panic).',
          'While looping a clip, select another clip to switch to it when the current clip finishes. The selection at the loop boundary is the one that plays next.',
          'Starting in the middle of a note plays it for the rest of its length.',
          'The round <b>Record</b> button arms MIDI recording and flashes red at the project BPM. Create and select a MIDI clip first; recording never creates clips. Existing notes are kept.',
          'The <b>Metronome</b> toggle next to Record clicks during playback and recording: the same short sine sound as the count-in, 880 Hz at each barline and 440 Hz on the other beats. It follows the playing TimeLine’s tempo, time signatures and loops, including beats hidden from the editor grid. Switch it off to silence it; recording’s one-measure count-in still sounds independently. The metronome is a monitoring aid and is not included in exported audio.',
          `With Record armed, ${k('Space')} over the piano roll records from the pointer, or ${k('/')} records from the clip start and overdubs on every loop. Play starts with a one-measure count-in in the time signature at that position: a short 880 Hz sine blip on beat 1, then 440 Hz on the other beats. The playhead waits until the count-in finishes. Notes pressed early and still held when recording begins are recorded from the recording start; notes released entirely during the count-in are not recorded.`,
          `Play your MIDI controller to record pitches, velocities and durations without quantization. Notes are added on release; notes held across a loop are split at the boundary. The clip's Send to target monitors the input while armed. ${k("'")}, the stop button or ${k('Space')} stops and disarms recording. Normal recording continues past the original clip and song end without looping; the clip grows while recording, then ends at the first barline at or after the final note end (including existing notes). An empty take keeps the original length. Loop recording keeps its fixed clip length and overdubs on every pass. Click Record again to disarm; changing clip or Patch level ends the take. Undo removes the take, including length changes.`,
        ],
      },
    ],
    keys: [
      [k('Double-click'), 'TimeLine: insert a note clip'],
      [`${k('Alt')} + drag / ${k('Shift')} + drag`, 'TimeLine: copy / linked clone'],
      [`${k(CMD, 'D')} / ${k(CMD, 'Shift', 'D')}`, 'TimeLine: clone / duplicate the selection'],
      [`${k(CMD)} + ${k('X')} / ${k('C')} / ${k('V')}`, 'TimeLine: cut / copy / paste clips at the pointer (snapped)'],
      [k(CMD, 'A'), 'TimeLine: select all clips'],
      [`${k('Backspace')} ${k('Delete')}`, 'TimeLine: delete the selected clips (the nearest clip gets selected)'],
      [`${k('Space')} ${k('.')} ${k(',')} ${k('/')} ${k("'")}`, 'play/stop, song, restart, loop clip, stop/panic'],
      [k('M'), 'toggle metronome'],
      [k('N'), 'arm / disarm MIDI recording'],
      [`wheel / ${k('Shift')} + wheel`, 'TimeLine: scroll time / scroll lanes'],
      [`${k(CMD)} + wheel, ${k('Shift')} + drag empty space / ${k('Middle mouse')} drag`, 'TimeLine: zoom, pan'],
      ['drag empty space', 'TimeLine: selection rectangle'],
      ['click / drag', 'Pianoroll: insert a note / set its duration'],
      [`${k('Shift')} + drag, ${k('right')} + drag`, 'Pianoroll: selection rectangle'],
      [`${k(CMD)} + click`, 'Pianoroll: toggle a note in the selection'],
      [`${k('Shift')} + drag a circle sideways`, 'Pianoroll: micropitch, tune the note in cents'],
      ['double-click a selected note\'s body', 'Pianoroll: add a pitch bend point (drag it; wheel rounds it, right-click deletes it)'],
      [`${k('Alt')} + drag`, 'Pianoroll: clone and move a note'],
      ['short right-click', 'Pianoroll: delete the note (empty space: deselect)'],
      ['right-click empty space / hold right on a note', 'Pianoroll: menu'],
      [`${k('Left')} ${k('Right')} / ${k('Up')} ${k('Down')}`, 'Pianoroll: transpose / move by a grid step (Shift: octave / bar)'],
      [`${k(CMD)} + ${k('X')} / ${k('C')} / ${k('V')}`, 'Pianoroll: cut / copy / paste notes at the pointer'],
      [k(CMD, 'D'), 'Pianoroll: duplicate the selection'],
      [k('Shift', 'Q'), 'Pianoroll: quantize note starts and ends'],
      [`${k(CMD, 'A')} / ${k('Esc')}`, 'Pianoroll: select all / clear the selection'],
      [`${k('Backspace')} ${k('Delete')}`, 'Pianoroll: delete the selected notes'],
      [k('Space'), 'Pianoroll: play from the pointer'],
      [`${k(CMD)} + wheel`, 'Pianoroll: zoom time'],
      [`${k('Shift')} + wheel`, 'Pianoroll: zoom pitch (keys and stave)'],
      [`${k('Middle mouse')} drag`, 'Pianoroll: pan (sideways too when zoomed in)'],
    ],
  },
  {
    id: 'automation',
    title: 'Automation',
    intro: '<b>Automation clips</b> (marked ∿ in the TimeLine) move one module controller over time. Selecting one replaces the pianoroll with the automation editor above the patcher. Use the TimeLine to arrange it alongside note clips; use the editor to draw its controller curve.',
    steps: [
      {
        title: 'Create and target an automation clip',
        items: [
          `${k('Double right-click')} empty TimeLine space: an automation clip (<i>Automation</i>) appears and the automation editor replaces the pianoroll. You can also choose <b>Insert automation clip</b> from the empty-space menu.`,
          'In the upper divider choose the module under <b>Send to</b> and the controller it drives under <b>Controller</b>. The <b>Clip</b> field names the clip; the TimeLine shows its name followed by its destination module and controller.',
        ],
      },
      {
        title: 'Edit the controller curve',
        items: [
          'Time runs <b>down</b>, just as in the pianoroll. Values run from the controller minimum on the left to its maximum on the right.',
          `${k('Double-click')} inserts a point; drag moves it (${k('Shift')} = fine value). The wheel on a point rounds its corner; a right-click or ${k('Backspace')} deletes it.`,
          'The times of new and moved points snap to the <b>Grid</b> in the upper divider and stay within the clip, between their neighbouring points. <b>Free timing</b> only frees pianoroll notes and velocity-curve times; automation points keep snapping.',
          'Dragging points near / past the top or bottom edge scrolls the editor along; the wheel scrolls time when not over a point.',
          'Drag the thick clip-end line to shorten or lengthen the clip, just like in the pianoroll. It snaps to the Grid and stops at the next clip on the same lane. Scroll the wheel or drag past an edge to go further; Escape cancels. Shortening keeps existing points beyond the end, so extending the clip reveals them again. Points take priority when grabbing the end line.',
          'The time grid matches the pianoroll: dark barlines, dashed beat lines and alternating snap bands, with the same line widths, time-signature beat visibility and zoom-dependent line spacing.',
          'Drag the bar ruler on the left up / down to zoom time, keeping the time at the grab position anchored, just like in the pianoroll. Escape cancels the zoom.',
        ],
      },
      {
        title: 'Arrange automation with notes',
        items: [
          'Select, move, trim, copy and arrange automation clips in the TimeLine alongside note clips. The shared clip operations, Grid, lanes, ruler and transport are described in <b>Pianoroll and Timeline</b>.',
          'While playing, the clip drives the controller like an LFO; after the clip the controller keeps the last value the clip gave it.',
          'Automation goes first: a note that starts together with an automation clip (or anywhere inside it) already hears the clip\'s value, also in EXPORT WAV, so the controller does not jump just after the note starts.',
        ],
      },
      {
        title: 'Play automation',
        items: [
          `${k('Space')} over the automation lane plays the song from the pointer's snapped time; press it again to stop.`,
          `${k('/')} loops the selected clip's time range with everything else that plays there. Clips in idea storage do not play with the song; looping an idea plays it solo.`,
        ],
      },
    ],
    keys: [
      [k('Double right-click'), 'TimeLine: insert an automation clip'],
      [k('Double-click'), 'automation editor: insert a point'],
      ['drag / Shift + drag', 'move a point / fine value adjustment'],
      ['drag clip-end line', 'resize the automation clip'],
      ['drag ruler up / down', 'zoom time around the grab position'],
      ['wheel on a point', 'round its corner'],
      [`right-click / ${k('Backspace')}`, 'delete a point'],
      [k('Space'), 'play from the pointer / stop'],
      [k('/'), 'loop the selected clip'],
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
          `Click <b>PHILSYNTH</b> (in the upper divider, left side) for <b>New</b> (${k(CMD, 'N')}), <b>Open…</b> (${k(CMD, 'O')}), <b>Save</b> (${k(CMD, 'S')}), <b>Save As…</b> (${k(CMD, 'Shift', 'S')}), <b>Export…</b> (folds open to <b>Export Audio…</b> and <b>Export MIDI…</b>), <b>Preferences…</b> and <b>Exit</b>. Audio export still uses ${k(CMD, 'E')}.`,
          'Menu groups fold inline like folders, without opening a second menu. The PHILSYNTH menu opens below its button when it fits, otherwise above it; expanding a group updates its position too. Menus widen only as needed to fit labels, up to the available window width. Long menus scroll within the available space. Use Up/Down to navigate, Right/Left to expand/collapse, Enter/Space to choose, and Escape to close.',
          '<b>Preferences…</b> has a category list on the left. <b>Interface > Wood Tint</b> previews any RGB tint on the wooden frame, dividers, controls and dialogs without changing module colors. <b>OK</b> remembers it on this device; <b>Cancel</b> or Escape restores the saved tint. <b>Reset to default</b> previews the default tint.',
          'Projects are <b>.phproject</b> files (older .mds / .json projects open too). The file name shows in the status bar and the window title, with <b>•</b> for unsaved changes; New and Open ask to save them first. Every change is also autosaved, so the app starts with your latest project.',
          'Project, module and clip files are saved as compact JSON to save disk space. Older formatted files still open.',
          '<b>Preferences… > MIDI > MIDI Input</b> picks the MIDI controller; <i>Auto</i> uses every input except Linux\'s <i>Midi Through</i>, <b>Re-scan MIDI Inputs</b> finds newly plugged-in devices and retries access. Changes preview immediately; OK saves the input on this device, Cancel restores it. Disconnected saved controllers remain listed.',
          `${k('Esc')} (when nothing else is open) goes up one patch level. In the main patch it asks <b>Exit to OS?</b>: ${k('Enter')} saves and closes, ${k('Esc')} cancels.`,
        ],
      },
      {
        title: 'Custom keyboard shortcuts',
        items: [
          'Right-click a button or an action in a menu to open <b>Learn keyboard shortcut</b>. The current shortcut, if assigned, is shown in bold. Press a key or combination such as <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>A</kbd>; the first available combination is saved automatically. <b>Cancel</b> or Escape leaves the mapping unchanged.',
          'Conflicting shortcuts are explained in the dialog; choose a different combination. Editor menu actions use the current selection and pointer in the focused editor, not the item originally right-clicked. Button shortcuts operate on the currently visible button. Transport shortcuts work across workspace areas, even when a button has keyboard focus; Space plays / stops instead of activating that button. Shortcuts do not interfere with typing in text fields, except modified global menu commands, and transport shortcuts pause while a modal dialog is open.',
          'TimeLine <b>Insert clip</b>, <b>Insert automation clip</b> and <b>Load Clip…</b> shortcuts remain available with a clip selected. Move the pointer to the desired position in the TimeLine before using them.',
          'A custom shortcut replaces the action\'s default keys. Right-click the action again and choose <b>Restore default</b> to undo its mapping, or use <b>Preferences… > Keyboard > Custom shortcuts > Reset to default</b> and save to reset all mappings. Mappings are device preferences, not project data.',
          'Escape, Tab and F11 remain reserved for navigation and full screen. Unmodified piano keys assigned to actions trigger those actions instead of playing notes. Some browser and operating-system combinations cannot be captured.',
        ],
      },
      {
        title: 'Export audio',
        items: [
          'Renders the song offline from its start to the end of the last clip plus up to 10 s of tail. Choose WAV (24-bit stereo at the device sample rate), MP3 (maximum 320 kbps), or Ogg Vorbis (maximum quality 10) in the save picker, or type the corresponding extension. Browsers without a native save picker download WAV. Encoding is local and cancellable. The status bar warns when the mix clips. Export formats do not change sampler storage.',
          'After choosing the file, select <b>Original Dynamics</b> to keep the original output level (peaks above 0 dBFS clip), or <b>Peak Normalization</b> to scale the entire stereo mix to a -1 dBFS sample peak before encoding. Normalization preserves relative dynamics and stereo balance without compression; silence stays silent. It does not match perceived loudness between projects, repair existing distortion or guarantee the peak after MP3/Ogg encoding. Cancel or Escape stops the export without writing a file.',
          'The non-blocking export dialog shows rendering progress, then encoding and writing; normal playback and editing can continue. <b>Cancel</b> stops the export; <b>Export complete</b> confirms it is saved. Browser downloads show <b>Audio ready</b>; check your browser downloads for completion.',
        ],
      },
      {
        title: 'Export MIDI',
        items: [
          '<b>Export… > Export MIDI…</b> saves the currently shown TimeLine from time zero as a standard .mid file. MIDI clips from all numbered lanes (including muted lanes) are grouped by destination, one track per module number and name; idea storage and automation clips are excluded. Unassigned and missing destinations are retained as named tracks.',
          'Notes are trimmed to clip edges and time zero. Start velocity is used throughout; velocity curves are ignored and zero-velocity notes stay silent. Bends use the same rounded pitches as the on-screen keyboard, split into successive notes when the pitch changes. Overlapping notes at the same pitch/destination are merged to avoid premature note-offs.',
          'The conductor track holds the Output tempo, time-signature changes and Output song title, creator and comments. Output transpose/cents are applied to the exported pitches. Automation, synth patches and audio are not encoded; after 15 destination tracks MIDI channels are reused.',
        ],
      },
      {
        title: 'Layout',
        items: [
          'Piano roll, patcher and TimeLine are stacked top to bottom. Drag a divider up / down to resize the panes (to an edge hides a pane), left / right to resize this controller panel. The patcher keeps the same patch position centred as its viewport resizes; the TimeLine likewise keeps the same time and lane position centred, without changing zoom. Arrow keys, Home and End move a focused divider. Positions are saved with the project.',
          'In the desktop Open and Save dialogs, right-click a file or folder to cut, copy, paste, rename or delete it. Right-click a folder to paste into it, or empty space to paste into the current folder. Deletion is permanent: files require one confirmation and folders require two, including for all their contents.',
          'The upper divider holds the clip name, <i>Send to</i>, the Grid and Free timing; their names (<i>Clip:</i>, <i>Send to:</i>, <i>Input Grid:</i>) drag the divider too. When it is too narrow, move the pointer along it to reveal its controls. The lower divider shows the patch path on the left and the TimeLine transport buttons and play position immediately left of the clock on the right.',
          'The <b>Spectrum Analyser</b> icon button in the top-right corner of the patcher switches the transparent spectrogram on or off. It defaults to off for new projects. It always fills the patcher viewport, above the noise background but below modules and cables, without padding or scrolling. Switching it does not move the camera. Turning it off disables audio monitoring and spectrum processing; analysis also pauses when the patcher or application tab is hidden. All-zero spectrum windows skip FFT and colour calculations while transparent rows continue scrolling old sound out of view. The on/off state is saved with the project.',
          '<b>Preferences… > Spectrum Analyser > Spectrum Analyser FFT size</b> sets the window to 512–32768 samples in powers of two (default 4096). Larger windows distinguish nearby frequencies more precisely but respond more slowly and use more CPU. Changes preview live, preserve displayed history, and are saved for the app rather than the project; Cancel restores the saved size.',
          '<b>Preferences… > Spectrum Analyser > Spectrum Analyser speed</b> adjusts scrolling from 0.25 to 4 times normal speed (default 1), in either flow direction. The analyser updates at approximately 20 frames per second to limit CPU usage. It previews live and is saved for the app; Cancel restores the saved speed.',
          'Analyse monitors the selected audio module, even when uncabled, without routing it to the speakers. With several modules selected, it shows the first audio-capable selection; with no audio-capable module selected (including MIDI-only/controller-only selections), it shows the current Patch level’s Output after Master volume. <b>Preferences… > Spectrum Analyser > Spectrum Analyser flow direction</b> chooses Top to bottom (the default, like rain) or Bottom to top. New rows enter at the opposite edge to the flow direction. This preference previews live and is saved for the app, not the project. Frequency labels stay along the bottom of the patcher in either direction. Brightness indicates strength over a -100 to 0 dBFS range; colour follows the Wood Tint preference for new rows, and silence stays transparent. Switching modules preserves history and repeats the last spectrum rows to keep scrolling while the new input fills its spectrum window. The spectrogram, frequency grid and numbers sit above the Perlin noise background but below modules and cables. Frequency runs logarithmically from 20 Hz to 20 kHz (limited by sample rate), combining stereo energy without phase cancellation. The analyser does not change the sound. Audio cables continue to warn of clipping.',
        ],
      },
    ],
    keys: [],
  },
];

const GUIDE_STATE_KEY = 'philsynth:guide';

export function createGuideState({
  load = () => globalThis.localStorage?.getItem?.(GUIDE_STATE_KEY), // Node 25 has a method-less localStorage without --localstorage-file
  save = (text) => globalThis.localStorage?.setItem?.(GUIDE_STATE_KEY, text),
  onError = (error) => console.error('Manual reading position:', error),
} = {}) {
  let opened = new Set();
  let scrollTop = 0;
  try {
    const text = load();
    if (text != null) {
      const state = JSON.parse(text);
      if (!state || !Array.isArray(state.opened) || !state.opened.every((id) => typeof id === 'string') ||
          !Number.isFinite(state.scrollTop) || state.scrollTop < 0) {
        throw new Error('Invalid saved manual reading position');
      }
      opened = new Set(state.opened.filter((id) => GUIDE.some((chapter) => chapter.id === id)));
      scrollTop = state.scrollTop;
    }
  } catch (error) {
    onError(error);
  }
  const persist = () => {
    try { save(JSON.stringify({ opened: [...opened], scrollTop })); }
    catch (error) { onError(error); }
  };
  return {
    isOpen: (id) => opened.has(id),
    get scrollTop() { return scrollTop; },
    setOpen(id, open) {
      if (opened.has(id) === open) return;
      if (open) opened.add(id);
      else opened.delete(id);
      persist();
    },
    setScrollTop(top) {
      if (!Number.isFinite(top) || top < 0) throw new Error('Invalid manual scroll position');
      if (top === scrollTop) return;
      scrollTop = top;
      persist();
    },
  };
}

export const guideState = createGuideState();

// The panel is rebuilt on selection changes; chapter state is kept locally between renders.
export function renderGuide(doc = document, state = guideState) {
  const el = (tag, cls, html) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html; // static strings only
    return e;
  };
  const root = el('section', 'guide');
  for (const t of GUIDE) {
    const d = el('details', 'guide-part');
    d.open = state.isOpen(t.id);
    d.addEventListener('toggle', () => state.setOpen(t.id, d.open));
    d.dataset.guide = t.id;
    d.append(el('summary', null, t.title), el('p', 'guide-intro', t.intro));
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
    t.steps.forEach((step, i) => {
      d.append(el('h3', null, `<span class="ctl-num">${i + 1}</span>${step.title}`));
      const ul = el('ul', 'guide-steps');
      for (const item of step.items) ul.append(el('li', null, item));
      d.append(ul);
    });
    root.append(d);
  }
  return root;
}
