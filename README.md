# PHILSYNTH

Modular synthesizer for the browser and Electron.

## Linux AppImage

On an x86-64 or ARM64 Linux machine with Node.js 22 or newer:

```sh
npm ci
npm run build:linux
```

The build downloads Electron and AppImage packaging tools as needed and writes
`~/Desktop/PHILSYNTH.AppImage` for the build machine's architecture. The app
includes the committed WASM DSP engine; no C++ toolchain is needed.
Local projects, development dependencies, and tests are not bundled.
Rebuilding replaces the Desktop AppImage atomically, even while the previous
version is running. Restart the app to use the new build.

Launch it with:

```sh
~/Desktop/PHILSYNTH.AppImage
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

The piano-roll toolbar's **Grid** controls set the alternating dark/light time
guide. Enable **Free timing** to draw, move, resize, and paste notes at unsnapped
times; velocity-curve timing is free too. Pitch and velocity-value snapping are
unchanged. The guide remains visible, and a click-created note initially uses
the last drawn length (or one grid step); dragging sets its free duration.
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

## ENVELOPE modulator

Insert **ENVELOPE** and draw its shape in the panel's curve editor (same editing
as the WAVESHAPER curve): left to right is time, bottom to top is the output.
Notes trigger it (select it and play, send a clip to it, or Shift + drag a
MULTIMIDI into it). Shift + drag from it to a module to modulate that module.

- **Envelope Length**: 0–10000 ms, the duration of the whole curve.
- **Out Controller**: which controller of the cabled module(s) is modulated.
- **Out Min / Out Max**: trim the output range (% of that controller's range).
- **Mode**:
  - *Note ON Trigger* (default): each note restarts the curve, which plays once
    and then holds its last value; note-off is ignored.
  - *Notes ON/OFF Loop*: the first note starts the curve and it repeats while any
    note is held. Releasing the last note stops it where it is (the value holds);
    the next note starts over from the beginning.
  - *Notes ON/OFF Loop Forward/Backwards*: like the loop, but the playhead runs
    forward and then back (ping-pong).

## Custom MIDI and modulation modules (Patch)

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

## Clip files

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

`.github/workflows/pages.yml` tests and publishes `index.html`, `style.css` and
`src/` on every push to `main`. To enable it once, open
**Settings → Pages** in the repository and choose **Source: GitHub Actions**.
The app then runs at `https://floepke.github.io/MODSYNTH/`.

Without `server.mjs` the web version autosaves to browser storage only and has no
live reload. Projects still open and save as files (Chromium browsers) or downloads.
Web MIDI works because Pages is served over HTTPS.

## App icon

The original icon in [src/icon.svg](src/icon.svg) combines a wooden synth case,
mint waveform, patch cable, knobs, and piano keys. It is used for the browser
favicon, Electron window, and Linux/macOS application bundles.
`npm run build:icon` regenerates the runtime PNG, Linux icon sizes, and macOS
ICNS using the existing Electron dependency. Both packaging commands regenerate
icons automatically. On headless Linux, run `xvfb-run -a npm run build:linux`
(or `xvfb-run -a npm run build:icon`) to provide a display for the renderer.
