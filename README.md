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

**MULTIMIDI / Random Delay** delays each note independently by a random amount
from zero to the chosen maximum (0–5000 ms, default zero). Both processors delay
note-off and velocity updates by the same per-note amount, preserving note
lengths even for very short notes. MIDI phase and onset metadata survive chaining.
Cable removal, module deletion, and Panic cancel pending notes and release only
the processor's own voices. WAV export includes delayed MIDI in its bounded tail.

## Development

```sh
npm start           # Electron
npm run serve       # Browser at http://localhost:8080
npm test
```

Rebuilding the WASM DSP engine uses `npm run build:wasm`.
macOS packaging uses `npm run build:mac` on macOS.

## App icon

The original icon in [src/icon.svg](src/icon.svg) combines a wooden synth case,
mint waveform, patch cable, knobs, and piano keys. It is used for the browser
favicon, Electron window, and Linux/macOS application bundles.
`npm run build:icon` regenerates the runtime PNG, Linux icon sizes, and macOS
ICNS using the existing Electron dependency. Both packaging commands regenerate
icons automatically. On headless Linux, run `xvfb-run -a npm run build:linux`
(or `xvfb-run -a npm run build:icon`) to provide a display for the renderer.
