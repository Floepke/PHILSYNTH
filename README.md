# PHILSYNTH

Modular synthesizer for the browser and Electron.

The frame, dividers, toolbar controls, menus, and dialogs default to dark
wood. Main menu > Preferences > Interface > Wood Tint opens live RGB controls for any tint, preserving
grain and bevel shading while keeping signal and module colors unchanged.
OK saves the tint locally for this browser or app (not in the project); Cancel
or Escape restores the previous tint, and Reset to default previews the default.
Extreme black/white channel values are softened to preserve visible grain.

## Preferences

PHILSYNTH > Preferences opens the categorized preferences dialog. The listbox on
the left selects a category; OK saves all changes, while Cancel or Escape undoes
live previews. Preferences are independent of projects.
Each setting has its own labeled groupbox to clearly separate its controls.

Interface > Controller Panel Divider Width sets only the divider between the
controller panel and patcher, in CSS px (10–128; default 48). The 10 px minimum
fits its 6 px grip with padding. App scaling still applies; the widget-bearing
horizontal dividers keep their existing size.
Click the controller-panel scrollbar track to jump directly to that position.
Dragging the handle and wheel scrolling still work normally.

Divider dragging updates the layout at most once per animation frame. Sequencer
canvas resizing shares the playback redraw instead of painting again inside
resize notifications. This reduces UI-thread work during playback in large projects;
view-only changes do not resend the song to the audio engine.

Interface > Launch in full screen is enabled by default. Uncheck it to launch
the Electron app as a maximized window instead. Changes apply on the next launch;
F11 still toggles full screen while running. This setting does not affect browsers.

Timeline > Show Input Grid toggles the alternating light/dark input-grid bands
without changing snapping. Timeline > Show Vertical Barlines toggles barlines
and time-signature lines in the clip lanes, but keeps ruler marks and labels.
Both default to checked and support live preview, Cancel, and saved preferences.

The desktop app stores a versioned JSON document in `preferences.json` in its
Electron user-data directory (development: `modsynth-dev`; packaged: `PHILSYNTH`).
Writes use a temporary file and atomic rename. Browsers, including GitHub Pages,
store the same JSON document under `philsynth:preferences` in localStorage.
Existing Wood Tint settings are migrated automatically without changing the tint.
Load errors are reported in the status bar, console and preferences dialog;
save errors keep the dialog open.

Register settings with `preferencesManager.register()` from
[`src/preferences.js`](src/preferences.js):

```js
preferencesManager.register({
  id: 'interface.example',
  category: 'Interface',
  label: 'Example',
  type: 'boolean',
  defaultValue: false,
  apply: (value) => { /* update the interface */ },
});
```

Supported controls are `color` (`#rrggbb`), `boolean`, `number` (with `min`, `max`
and optional `step`), and `select` (with `{ value, label }` string options).
Optional `description` and `validate(value)` provide help and extra validation.
`apply(value)` must accept both preview and restored values. The manager exposes
`get(id)`, `load()`, `save(changes)`, `preview(id, value)` and `restore()`.
Unregistered JSON values are retained for future settings.

## Playback timing

Timeline playback runs in the AudioWorklet alongside the existing DSP graph.
Notes, note releases, automation, and timed MIDI processors (including STRUM,
TRILL, delays, and nested Patch instances) advance on the audio clock, not on
GUI timers. Divider dragging or a blocked GUI can delay the displayed playhead,
but does not hold up scheduled notes. Timing resolution is one audio block
(128 samples, about 2.7 ms at 48 kHz), for both JavaScript and C++/Wasm DSP.
Control copies reuse existing DSP nodes and sample data; unrelated module edits
preserve held playback notes. Live keyboard/MIDI input still enters through the
UI, and offline export keeps its existing virtual-clock transport.

Adding Patch instances still requires GUI-side DSP allocation. Instance-count
automation uses the instances already provisioned until the GUI creates and
binds additional ones. Project/model edits synchronize with the audio engine;
unlike divider movement, those edits can incur audio-thread preparation work.

`npm test` includes headless audio-clock transport and MIDI-routing regressions.
For a real AudioWorklet test on Linux, run:

```sh
xvfb-run -a node_modules/.bin/electron test/audiotransport-ui.test.mjs --no-sandbox
```

It verifies actual note onset and release during a 200 ms GUI-thread stall in a
32,001-note project, using both DSP backends.

## Module CPU benchmarks

OPERATOR retains its 4x oversampling and 65-tap anti-aliasing FIR. Both playback
backends traverse the FIR history in two contiguous spans, avoiding per-tap
modulo operations while preserving coefficients and summation order.
VIBRATO skips delay interpolation during silent input once all retained audio
is beyond the current smoothed delay's reach. Buffer clearing, phase and depth
smoothing continue; increasing the delay can still recover older buffered audio.
This avoids unnecessary two-second tail processing without cutting audible tails.
Audio graphs skip dormant OPERATORs only after envelope and FIR tails finish,
with no incoming audio and no controller settling left. Notes, controller
changes and incoming audio automatically resume processing. This does not
suspend PATCH clocks, free-running modulators or pending MIDI events.

Run `npm run bench:modules` for every registered module, including Output.
It compares isolated DSP kernels in JavaScript and C++/Wasm where available,
with active input, sample/image fixtures, and one/eight-voice synth workloads.
Additional cases exercise 32 voices, filter modes, distortion types,
oversampling, image-scanner resolution, sample interpolation, wavetable
crossfading and non-flat EQ bands.
MIDI processors are measured separately with eight-key chords and a 32-key
stress workload, pitch updates and audio-clock callbacks. PATCH is a container:
its separate graph comparison measures an empty folder versus a direct
OSC-to-Output connection, not the cost of arbitrary contents.

The benchmark warms up each case, alternates backend order and reports five
repeats of five simulated audio seconds (median and min/max). MIDI warmup also
fills the schedulers' six-second release-history window. Results are
milliseconds of execution per simulated audio second: **10 ms/s = 1% of one
core**, not total system CPU. DSP timings exclude graph routing, control-target
updates, UI, IPC, loading and initialisation. Node timings are estimates, not
browser audio-thread deadline guarantees; repeat on an otherwise idle machine.
Only modules with native kernels get Wasm results; the others still use JS.
Avoid treating tiny timings or overlapping ranges as meaningful rankings.

Use `npm run bench:modules -- --quick` for fixture/coverage validation, not
performance conclusions. To save all measurements and machine metadata as JSON:
`npm run --silent bench:modules -- --json > module-bench.json`.
No project files are changed. The older `npm run bench` still measures selected
kernels and large end-to-end graphs.

SAMPLER and WAVETABLE have native C++/Wasm playback kernels, including every
playback/interpolation mode, pitch/velocity smoothing and the original ADSR.
Wavetable FFT mipmaps preserve the existing anti-aliasing. Equal PCM uploads and
wavetable mipmaps are shared across native instances and freed with their last
owner. Mipmap storage and FFT workspace are allocated on upload or Block Size
changes, never inside the audio-processing loop; frame transforms are still
prepared lazily on first use. The built-in
table is generated with the existing JS routine. JavaScript playback remains the
fallback when Wasm is unavailable. Rebuild the committed binary after C++ changes
with `npm run build:wasm`; `node test/wasm.test.mjs` checks native/JS audio parity.

STRUM, TUNING, MULTIMIDI and DELAY use stable deadline queues for MIDI delivery
and release-history expiry, instead of scanning all retained notes on every
message or clock tick. Equal-time events remain in arrival order, six seconds
of release history still allow tail modulation, and pending-event checks are
constant-time. STRUM/TUNING/MULTIMIDI retain each note's original delay; DELAY
still captures its current delay separately for every arriving message.
MULTIMIDI's actual release-tail pitch drift remains active. Run
`node test/midischedule.test.mjs` for ordering, lifetime and scaling regressions.
MULTIMIDI pauses each random drift generator when its amount is zero. When both
pitch and velocity drift are zero, clock ticks skip the note-update loop unless
a controller changed; incoming note updates and deadline-based release cleanup
still work. Re-enabling drift resumes its paused random trajectory.

## Linux AppImage

On an x86-64 or ARM64 Linux machine with Node.js 22 or newer:

```sh
npm ci
npm run build:linux
```

The build downloads Electron and AppImage packaging tools as needed and writes
`PHILSYNTH.AppImage` in the project root for the build machine's architecture. The app
includes the committed WASM DSP engine; no C++ toolchain is needed.
Local projects, development dependencies, and tests are not bundled.
Rebuilding replaces the project-root AppImage atomically, even while the previous
version is running. Restart the app to use the new build.

The build also installs a **PHILSYNTH** launcher in your user application menu,
including its icon. Search for **PHILSYNTH** in the Linux menu to launch it—no
sudo or system-wide installation is needed. The launcher is saved as
`~/.local/share/applications/PHILSYNTH.desktop` (or
`$XDG_DATA_HOME/applications/PHILSYNTH.desktop` when set to an absolute path).
Rebuilding updates the launcher and icon. Keep the AppImage at its project-root
location; moving or deleting it breaks the menu launcher. If your desktop
environment does not show a new launcher immediately, log out and back in.

Alternatively, launch it with:

```sh
./PHILSYNTH.AppImage
```

Copy the AppImage to another Linux machine with the same architecture and make
it executable with `chmod +x PHILSYNTH.AppImage`. The desktop environment must
provide Electron's normal system libraries. If FUSE is unavailable, launch with
`./PHILSYNTH.AppImage --appimage-extract-and-run` instead.

Projects autosave under Electron's user-data directory, normally
`~/.config/PHILSYNTH/projects` (or `$XDG_CONFIG_HOME/PHILSYNTH/projects`).
The AppImage itself stays read-only. F11 toggles fullscreen, F12 opens developer
tools, and Ctrl+Q quits.
Window-manager Close, Alt+F4, and Ctrl/Cmd+Q first show the same "Exit to OS?"
confirmation as the Exit menu item. Yes saves before quitting; No keeps the app open.
In a focused TimeLine or piano roll, Escape clears an existing selection first;
the next Escape opens the exit confirmation, without needing to move focus.
In the piano roll, Ctrl-click a note (Cmd-click on macOS) to add it to the
selection; clicking an already selected note with the same modifier removes it.
This works on the note's head or body without editing it. Shift-click also
keeps its existing selection-toggle behavior.
The overflow toolbar reaches its scroll endpoints before either edge widget's
centre, so its outer controls are fully visible when hovered.
Dropdown option popups have rounded corners in Electron and browsers supporting
customizable selects; older browsers retain their native dropdowns.
All in-app dialogs (including module insertion, confirmations, time signatures,
and Patch controller mapping), context menus, and supported dropdown popups share
the wooden house style. Native operating-system open/save dialogs are unchanged.
Dropdown choice text is vertically centered. Piano-roll grid lines use the stave
color, with doubled thickness and 12px dashes separated by 12px gaps. The first
barline uses the same thickness as ordinary barlines. Barlines leave half-semitone
clearance beyond both edges of notes crossing or touching them; musical-time
comparisons tolerate rounding errors up to 0.0000001 quarter notes.

## MIDI chord processing

MIDI note-ons light up a traveling dot on each connection they actually take.
Each dot travels from sender to receiver in 100 ms. Parallel branches animate
one after another, and downstream dots follow their upstream arrivals, including
through delayed MIDI processors. This is visualization only: MIDI and audio keep
their original timing. Separate notes can animate at the same time.

The piano-roll toolbar's **Grid** controls set the alternating dark/light time
guide. Enable **Free timing** to draw, move, resize, and paste notes at unsnapped
times; velocity-curve timing is free too. Pitch and velocity-value snapping are
unchanged. The guide remains visible, and a click-created note initially uses
the last drawn/resized length (or one grid step); dragging sets its free duration.
New notes also use the last starting velocity used in the velocity editor (default
80%), with a flat velocity curve. Clicking a velocity handle adopts its value;
group edits use the grabbed note's starting velocity, and straight-line edits use
the covered note start nearest the release. Cancelled gestures do not update
either memory. Moving, selecting, copying or pasting notes does not change them.
Both memories last for the piano-roll instance, carry across clip switches, and
are not saved in the project.
Explicit Quantize (Q), keyboard time nudges, timeline and automation editing
still use the grid. Free timing is saved per sequencer/Patch level with the project.

Insert **STRUM**, target it with a sequencer clip, and MIDI-cable its output to an
OSC, Patch, or another MIDI-capable module. Notes sharing a start time form a
chord; nearby but different starts stay independent.

- **Strum Type**: strum upwards (low to high), strum downwards (high to low), or
  strum random order.
- **Strum Duration**: 0–5000 ms from the first note to the last (default 100 ms).
  A single note has no strum delay.
- **Timing Humanize**: 0–100%; zero gives evenly spaced notes, higher values vary
  the interior timing while preserving order and the duration endpoints.

Insert **TUNING** for microtonal scales: paste or type a
[Scala](https://www.huygens-fokker.org/scala/) `.scl` file into its panel, or click
**Load Tuning** (a file) or **Load Tuning from PHILSYNTH Library** (built-in
equal, Bohlen–Pierce, Werckmeister / Kirnberger / Vallotti well, meantone and just
scales), then MIDI-cable it to an OSC, Patch, or another MIDI module. It
has no controllers. Key 60 (C4) plays degree 0 at its normal pitch; each key up
or down is the next scale degree, and the last pitch (usually `2/1`) is the
period. A 12-tone equal temperament scale changes nothing, micropitch is kept on
top, and sounding notes glide to an edited scale. The scale is saved with the project.

**MULTIMIDI / Velocity** scales every outgoing note velocity (0–100 %, default
100 % = unchanged), so trimming it down makes the notes it sends quieter; held
notes follow changes and it can be modulated like any other controller.

**MULTIMIDI / Overtone** (0–128, default 0 = fundamental) shifts every note to
its n-th overtone of the natural harmonic series: n + 1 times the frequency,
i.e. 12·log2(n + 1) semitones up (1 = octave, 2 = octave + fifth at +19.02 st,
3 = two octaves, …). The interval is exact, not rounded to semitones.

**MULTIMIDI / Route Mode** chooses which outgoing MIDI cables a note takes:
- **Sent to All** (default): every connected module plays its own copy.
- **Round Robin**: one cable per note, cycling through the cables in the order they
  were connected (1st note → 1st cable, 2nd → 2nd, …, then the 1st again).
- **Random**: one random cable per note.
- **Random (no repeat)**: one random cable per note, never the same one twice in a row.

A note's velocity / pitch updates and its note-off follow the cable its note-on took.

**MULTIMIDI / Random Delay** delays each note independently by a random amount
from zero to the chosen maximum (0–5000 ms, default zero). Both processors delay
note-off and velocity updates by the same per-note amount, preserving note
lengths even for very short notes. MIDI phase and onset metadata survive chaining.
Cable removal, module deletion, and Panic cancel pending notes and release only
the processor's own voices. WAV export includes delayed MIDI in its bounded tail.

## CTL2NOTE generator

The LFO offers **Random (linear)** (straight ramps between random targets) and
**Random (steps)** (sample-and-hold, a new value each Frequency cycle).
The original mode, now named **Random (smooth step)**, retains its smoothstep curves and saved index.
The live plot below its controllers shows the last five seconds of actual DSP
output after Amplitude and Out Min/Max, before each destination's Out Smooth.
It also works without a control cable connected.

The LFO's **LFO On/Off** controller defaults to On. Off pauses its cycle and
holds the output level (also for audio tremolo), while output trimming remains
live. On resumes at the remembered phase. A MIDI note received while paused
still resets the phase to Phase plus the incoming note phase. The controller
can be automated or driven by VELOCITY2CTL to start/stop a controller machine.

**CTL2NOTE** generates one MIDI note from controllers, with no incoming MIDI or
audio. Shift + drag its output to a synth, MIDI processor or Patch.

- **MIDI Pitch**: 0-127, snapped to whole MIDI pitches.
- **Note State**: Off (default) releases the note; switching to On starts it.
- **Finetune**: -100 to +100 cents, added to MIDI Pitch.
- **Velocity**: 0-100%; zero is silent but keeps the note On.
- **Phase**: 0-100%, captured only at note-on, not changed while the note sounds.

Pitch, finetune and velocity update the existing note live without retriggering.
All controllers can be automated or modulated. Values from one modulation report
are applied together at the audio clock. Saved On notes start after cables are
restored; removing a cable releases the note on that target. Panic stops the note
until Note State is switched Off then On again.

## ENVELOPE modulator

All single **Out Controller** modulators (LFO, ADSR, ENVELOPE, VELOCITY2CTL,
PITCH2CTL and SOUND2CTL) have **Out Smooth** (0–5000 ms). It softens controller
jumps after Out Min / Out Max and amplitude mapping, including MIDI retriggers
and modulation of those trims. 0 ms is off and preserves existing patches.
The time is an exponential smoothing constant: a step moves about 63% toward
its target in that time. Try 20–50 ms for duty-cycle jumps.
Each control route smooths independently from the connected controller's current
value; logarithmic and stepped controllers retain their normal mapping/snapping.
The setting is saved with the project and can itself be modulated.
Existing **Smooth** controls on the converter modules still smooth their source
values separately. **Out Smooth** affects control cables, not LFO audio tremolo.

Insert **ENVELOPE** and draw its shape in the panel's curve editor (same editing
as the WAVESHAPER curve): left to right is time, bottom to top is the output.
Notes trigger it (select it and play, send a clip to it, or Shift + drag a
MULTIMIDI into it). Shift + drag from it to a module to modulate that module.

- **Envelope Length**: 0–10000 ms, the duration of the whole curve.
- **Out Controller**: which controller of the cabled module(s) is modulated.
- **Out Min / Out Max**: trim the output range (% of that controller's range).
  Before the first trigger and after a hard reset, the envelope holds its curve's
  starting level (Out Min for the default curve). Trimming, including modulation
  of Out Min / Out Max, updates connected controllers even while idle.
- **Mode**:
  - *Note ON Trigger* (default): each note restarts the curve, which plays once
    and then holds its last value; note-off is ignored.
  - *Notes ON/OFF Loop*: the first note starts the curve and it repeats while any
    note is held. Releasing the last note stops it where it is (the value holds);
    the next note starts over from the beginning.
  - *Notes ON/OFF Loop Forward/Backwards*: like the loop, but the playhead runs
    forward and then back (ping-pong).

## Custom MIDI and modulation modules (Patch)

Mapped PATCH controllers start at controller **11**, leaving room below for native
PATCH controllers. Input Module and Instances keep their existing numbers.
This also applies to older projects: saved modulation and automation controller
numbers are not migrated, so projects targeting mapped controllers may sound
different until those targets are adjusted.

A Patch can pass notes and modulation out through its Output, so stock modules can be
combined into your own MIDI processor or modulator:

- **MIDI**: inside a Patch, cable a MULTIMIDI or STRUM (or a Patch that sends notes) into
  the Output. Cable the Patch module to OSC, SAMPLER, ADSR, … outside: they get the notes.
  A DELAY cabled into the Output stays an audio cable.
- **Modulation**: inside a Patch, cable an LFO, ADSR, ENVELOPE, VELOCITY2CTL, PITCH2CTL or SOUND2CTL
  into the Output. Cable the Patch module to any module outside. The inner modulator's
  **Out Controller** picks which controller of those modules it drives (its list shows their
  names); **Out Min** / **Out Max** trim the range.
- This also works through several nested Patches (Output → Patch → Output → …).
- A Patch cable carries what the inside sends out: audio to modules with an audio input,
  notes to MIDI modules, modulation to controllers. It is drawn as a control (dashed) or
  MIDI cable when the inside sends no sound.
- At the top level the Output has no outside: a modulator cabled into it modulates the
  Output's own controllers (Master volume, BPM, …), and it takes no MIDI. A MULTICTL into an
  Output always drives that Output's controllers.

## Menus and export

MIDI input selection is under **PHILSYNTH > Preferences… > MIDI > MIDI Input**.
Auto uses every input except MIDI Through ports; **Re-scan MIDI Inputs** refreshes
the device list and retries MIDI access. Changes preview immediately, OK saves
to the JSON preferences, and Cancel restores the saved device. Existing input
selections are migrated, and disconnected controllers remain listed.

All context menus use `showMenu()` in `src/seq/menu.js`. A menu item with
`children: [...]` folds inline like a file-explorer folder; leaf items use
`action()`. Existing `checked`, `disabled`, `shortcut` and separator (`'-'`)
options still work. Groups widen the menu only as needed to fit their labels,
up to the available window width; long menus expand
within the window and scroll vertically. Arrow keys navigate, Right/Left
expand/collapse, Enter/Space activate, Home/End jump, and Escape closes.

**PHILSYNTH > Export…** folds open to **Export Audio…** and **Export MIDI…**.
The audio shortcut remains Ctrl/Cmd+E. Audio export offers 24-bit stereo WAV,
maximum-bitrate MP3 (320 kbps), and Ogg Vorbis (maximum quality 10).
Choose the audio format in the desktop save dialog or the browser's native save
picker; typing `.wav`, `.mp3` or `.ogg` in the filename selects that format.
Browsers without a native save picker download WAV. Encoding runs locally in the
render worker and can be cancelled; no external encoder service is used.
Restart Electron after updating to enable the new audio save extensions.
Sampler project storage remains lossless PCM: export formats do not change
sample storage or its 60-second loading limit.

MIDI export writes a standard format-1
`.mid` file at 960 ticks per quarter from the currently shown TimeLine:

- All MIDI clips in numbered lanes are grouped by destination, not lane,
  with track names `#<module number> <module name>`. Muted lanes are included;
  ideas and automation clips are excluded. Missing/unassigned destinations
  are retained with explanatory track names.
- Notes are clipped to clip edges and time zero. Only start velocities are
  exported; velocity curves are ignored, and zero start velocity stays silent.
- Pitch bends use the playback polyline and split at each rounded-pitch
  transition. Global Output transpose/cents are applied, and notes at the same
  pitch/destination that overlap merge into a sustained note.
- A conductor track stores Output BPM, all time signatures, and the Output's
  song title, creator and comments. Synth patches, audio, grid-beat visibility
  and automation are not MIDI data. Channels avoid the percussion channel;
  more than 15 destination tracks reuse channels.
- Electron uses the in-app save dialog and atomic binary writes. Browsers use
  a native save picker when available or download the file. Restart Electron
  after updating main-process file handlers to enable `.mid` saves.

## Time-signature grid

The piano-roll ruler supports simultaneous horizontal velocity-width resizing
and vertical time zoom (up zooms in, down zooms out). The timeline measure ruler
supports horizontal panning and the same vertical zoom gesture; a click still
positions the playhead and restart markers retain their position drag.
Ruler and timeline horizontal-scrollbar drags use pointer lock only in Electron,
so the cursor returns to its press position on release. Web versions use ordinary
cursor dragging without requesting pointer lock. If Electron refuses pointer
lock, ordinary dragging remains available with a console warning.
Escape cancels the gesture.

The timeline's time-signature row and measure ruler each match a normal clip
lane's height, with enlarged signature flags and measure numbers.

Drag a purple time-signature flag horizontally to move it to a whole bar of the
preceding meter. The initial signature stays at zero. Later changes realign to
the nearest whole measure, keeping their order and at least one measure between
changes; clips and notes stay in place. The grid updates live. Returning the
pointer restores the original alignment, cancellation restores all positions,
and releasing records one undo step.

Choose **Insert/Edit time-Signature Change…** from the timeline or ruler context menu
to open the time-signature dialog at the nearest bar to the right-click position.
Double-clicking the signature row still works; hold right-click on existing
signature/restart markers to open the menu without removing them.

The time-signature dialog includes a two-octave measure preview (time downward).
It uses the piano roll's black-key stave lines, including thicker three-line
groups and the dashed central pair. All beats fit a fixed editor area that
expands with the window; changing the numerator does not resize the dialog.
Click each numbered beat row to toggle its piano-roll beat/grid line. Beat 1
controls the measure barline. Each signature saves zero-based `gridBeats`, e.g.
`[0, 2, 4]` in 7/8; all seven lines are `[0, 1, 2, 3, 4, 5, 6]`.
An empty list hides all musical beat/bar lines. Clip boundaries, ruler labels,
input-grid shading, snapping, playback and timeline lines remain unchanged.
Older projects without this field enable all beats. Editing either the beats-per-bar
spinbox or the beat-note-value dropdown resets the measure to all beats enabled.

## Clip files

Clip looping chases notes already sounding at the loop start on every pass,
including notes in overlapping clips and notes beginning before a trimmed
clip's left edge. Chased notes resume at their current velocity and bent pitch
and stop at their normal end (or the loop boundary).

TimeLine > right-click > Consolidate combines selected MIDI clips across lanes
and destinations. The result uses the first selected clip's name, destination
and lane, preserving note timing and trimming notes at their original clip ends.
If that lane is blocked by an unselected clip, the result moves to a free lane
below without changing its time. Mixed MIDI/automation or automation-only
selections cannot be consolidated. At least two clips are required.

In the piano-roll velocity editor, dragging a start handle sets every selected
note's start velocity to the dragged value, regardless of its start time.
Each note's curve shifts by its own start-velocity change, with points clamped
to 0–100%; point times and rounding are unchanged. Use Ctrl/Cmd + drag to draw
a time-based ramp through selected note starts and curve points instead.
Editing a curve
point changes only points at the same timeline time in selected notes, never
start velocities or other points. Missing points are created only in selected
notes sounding at that time; differing note starts do not prevent synchronized edits.
Point velocities clamp individually at 0–100% without blocking the group. During
a drag, moving back restores their original differences; releasing commits the
visible values, so points flattened to one level move together on the next drag.
Double-clicking inside a selected note creates a point for every selected note
at the same offset from its start; offsets beyond shorter notes are clamped to
their ends. Dragging an existing point creates missing same-time points
immediately. Select a single note to edit only that note. Cancel restores the
original curves, including removing points created by a cancelled point drag.

TimeLine clips show full-height beamed eighth notes (♫) for MIDI and a wave (∿) for
automation, before the clip name and target.
Labels are vertically centered and left-aligned, staying clear of the type icon.
When a clip starts off-screen, its label follows the viewport's left edge,
remaining clipped inside the clip. MIDI note previews use the full clip height
with a small inset from the border.

Right-click a clip in the TimeLine and choose **Save Clip…** to store the selected
clips as a `.clip` file (JSON: `{ "format": "philsynth-clip", "version": 1, "clips": [...] }`).
Right-click empty TimeLine space and choose **Load Clip…** to place them there again,
also in another project. A clip plays the same module when it still exists, otherwise
the first module of the same type, otherwise the default MIDI module.

The file dialogs remember the last folder per kind: opening projects, saving projects,
clips and modules (`.phmod`). The desktop app stores these folders in `dialog-dirs.json`
in its user data folder. Chromium browsers remember them per site.

On Linux the desktop app sends KDE's "folder changed" signal (`org.kde.KDirNotify.FilesAdded`
via `dbus-send`) for the start folder before each dialog opens and after each save. KDE's
dialog would otherwise show a cached listing on folders without change notifications (FUSE
mounts such as pCloud), and new files would only appear after F5.

## Development

```sh
npm start           # Electron
npm run serve       # Browser at http://localhost:8080
npm test
```

Rebuilding the WASM DSP engine uses `npm run build:wasm`.

Every module's panel ends with a reference (About, Controllers, Usage) from
`src/moduledocs.js`. When adding a module or controller, describe it there;
`npm test` checks that every controller is documented.
macOS packaging uses `npm run build:mac` on macOS.

## GitHub Pages

`.github/workflows/pages.yml` installs runtime dependencies, tests, and publishes
`index.html`, `style.css`, `src/`, and the local MP3/Ogg encoder dependency on every
push to `main`. Electron and packaging tools are not installed for this build.
To enable it once, open
**Settings → Pages** in the repository and choose **Source: GitHub Actions**.
The app then runs at `https://floepke.github.io/MODSYNTH/`.

Without `server.mjs` the web version autosaves to browser storage only and has no
live reload. Projects still open and save as files (Chromium browsers) or downloads.
Web MIDI works because Pages is served over HTTPS.

## PHASE2CTL

**PHASE2CTL** converts the newest note's start phase into a controller value,
with the same Smooth, Noteoff Action, Out Controller, Out Min/Max and Out Smooth
controls as VELOCITY2CTL. Phase 0 maps to Out Min and 0.5 to the middle.
Phase wraps at 1; notes without phase use 0. Pitch/velocity curves do not change
the captured phase. Use MULTIMIDI Phase / Random Phase to supply it.

## Module names

Module boxes grow horizontally to fit their complete names without truncation
or a maximum width, even when a name is wider than the viewport.

## App icon

The original icon in [src/icon.svg](src/icon.svg) combines a wooden synth case,
mint waveform, patch cable, knobs, and piano keys. It is used for the browser
favicon, Electron window, and Linux/macOS application bundles.
`npm run build:icon` regenerates the runtime PNG, Linux icon sizes, and macOS
ICNS using the existing Electron dependency. Both packaging commands regenerate
icons automatically. On headless Linux, run `xvfb-run -a npm run build:linux`
(or `xvfb-run -a npm run build:icon`) to provide a display for the renderer.
