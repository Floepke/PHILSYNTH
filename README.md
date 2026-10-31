# MODSYNTH

Modular synthesizer for the browser and Electron.

## Linux AppImage

On an x86-64 or ARM64 Linux machine with Node.js 22 or newer:

```sh
npm ci
npm run build:linux
```

The build downloads Electron and AppImage packaging tools as needed and writes
`~/Desktop/MODSYNTH.AppImage` for the build machine's architecture. The app
includes the committed WASM DSP engine; no C++ toolchain is needed.
Local projects, development dependencies, and tests are not bundled.
Rebuilding replaces the Desktop AppImage atomically, even while the previous
version is running. Restart the app to use the new build.

Launch it with:

```sh
~/Desktop/MODSYNTH.AppImage
```

Copy the AppImage to another Linux machine with the same architecture and make
it executable with `chmod +x MODSYNTH.AppImage`. The desktop environment must
provide Electron's normal system libraries. If FUSE is unavailable, launch with
`./MODSYNTH.AppImage --appimage-extract-and-run` instead.

Projects autosave under Electron's user-data directory, normally
`~/.config/MODSYNTH/projects` (or `$XDG_CONFIG_HOME/MODSYNTH/projects`).
The AppImage itself stays read-only. F11 toggles fullscreen, F12 opens developer
tools, and Ctrl+Q quits.
Window-manager Close, Alt+F4, and Ctrl/Cmd+Q first show the same "Exit to OS?"
confirmation as the Exit menu item. Yes saves before quitting; No keeps the app open.
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

## Development

```sh
npm start           # Electron
npm run serve       # Browser at http://localhost:8080
npm test
```

Rebuilding the WASM DSP engine uses `npm run build:wasm`.
macOS packaging uses `npm run build:mac` on macOS.
