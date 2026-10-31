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

## Development

```sh
npm start           # Electron
npm run serve       # Browser at http://localhost:8080
npm test
```

Rebuilding the WASM DSP engine uses `npm run build:wasm`.
macOS packaging uses `npm run build:mac` on macOS.
