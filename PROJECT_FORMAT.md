# PHILSYNTH project data

This is a map for developers changing saved project data. The implementation is
the source of truth; this document is not a separate schema or a validator.
Keep it and the persistence tests up to date when adding or changing fields.

## Runtime snapshot and disk manifests

[`Engine.saveProject()`](src/engine.js) calls
[`createProjectSnapshot()`](src/projectdata.js), returning
`{ format: "philsynth", version: 1, patch, song }`. This is a runtime snapshot,
not the ZIP manifest. The v1 envelope remains for compatibility with JSON
autosaves and existing snapshot consumers; it does not describe the version of
a manual save. `patch` comes from `PatchRuntime.toJSON()`; `song` is the live
root song, so callers must serialize or copy it when they need a frozen state.
The UI adds `view` for saves and also `doc` for autosaves.

[`projectdata.js`](src/projectdata.js) owns the envelope conversion and
validation entry points for project and module manifests. A v3 project
manifest preserves model fields, replaces inline `samples` with media indexes,
and sets the disk `format` and `version`. The reader validates the envelope
and returns the model and indexes separately; archive loading then resolves the
media before passing the model to the engine. Module-specific state remains
owned by its module, patch serialization by `PatchRuntime`, and song
normalization by `normalizeSong()`. ZIP I/O, checksums and streaming remain in
the archive and media layers.

## Project envelope

New `.phproject` saves are ZIP archives with a `project.json` manifest:

```text
{
  format: "philsynth", version: 3,
  patch: { modules, cables, ... },
  song: { clips, sigs, selected, snap, nextId, mutes, solos, ... },
  view: { path, cams, cameraSize, seq, analyse, layers, panelScrolls },
  assets: { "<asset id>": { kind: "image", path: "media/images/1.png" }, ... },
  audioFiles: { "<audio id>": { path: "media/audioFiles/1.wav" }, ... }
}
```

The diagram omits many fields and uses JavaScript notation, not valid JSON.
The manual save path in [`projectarchive.js`](src/projectarchive.js) collects
the media, converts the snapshot to a manifest, and writes the archive. PNG
stores the prepared RGB8 pixels without color conversion; WAV
stores interleaved little-endian Int16 PCM. Audio index entries also carry
`rate`, so the pool rate is preserved even if the WAV header rounds it.
Each referenced ID is written once. All new saves use **version 3**, a
stored-entry ZIP64 archive, whether or not they contain audio clips.
ZIP entry timestamps record the archive save time in local time (with ZIP's
two-second precision), not the original import or recording time.
Audio clips play through their selected audio destination and may be recorded from a RECORDER module.
The `audioFiles` index maps each referenced audio ID to a WAV under
`media/audioFiles/`; linked and independent clips using the same audio file
store it once. Imported and recorded audio are 24-bit mono or stereo PCM WAVs. The
[`projectzipstream.js`](src/projectzipstream.js) profile validates paths, offsets
and checksums and streams these files in bounded chunks. Opening a v3 project
copies its audio files into working storage and remaps their IDs. Desktop saves
and File System Access saves stream to the destination; desktop opens stage the
archive in origin-private storage. Browsers without File System Access can
download audio-free v3 projects (buffered, limited to 512 MiB) but cannot yet
save projects containing audio clips. Older app versions cannot read v3.

Open detects the container by its bytes, not its extension. Version 2 stored ZIP
archives remain readable. Standalone JSON
is v1 (including older files with no version and the `modsynth` format name).
Its first save uses **Save As** to preserve the original. Older app versions
cannot open v2. Undo keeps model snapshots in memory; autosave remains JSON
with inline Base64 media when needed (`samples`). Autosave also
stores document metadata (`doc`), which is not part of a manual save.
Preferences are stored separately.

On load, [`Engine.loadProject()`](src/engine.js) checks the format and patch,
imports samples, reconstructs the patch, normalizes the song, and synchronizes
playback. The UI applies `view` separately. The disk reader checks the version
and decodes and validates archive media before handing it to the engine.

To batch-convert v1 projects, run `node convert-projects.mjs --dry-run`
from the repository, then omit `--dry-run` to write the converted files.
The [converter](convert-projects.mjs) defaults to `pCloud Drive/PHILSYNTH`
and `pCloud Drive/PHILSYNTH2` inside your home directory; you can also pass a
source and destination folder as two arguments. Both must exist. It preserves
subfolders and filenames, skips v2/v3 files and existing output files, writes v3, and
reports failed conversions without stopping the rest of the batch.

## Module files

New `.phmod` saves use the same stored-entry ZIP64 profile as v3 projects,
with `module.json` containing `format: "philsynth-module"`, `version: 3`,
`modules`, `cables`, `assets`, and `audioFiles`. Referenced sampler audio and
images use the same WAV and PNG entries as projects; nested PATCH timelines'
audio uses `media/audioFiles/` and is stored once per referenced ID. Desktop
and File System Access saves stream, while browsers without File System Access
can download audio-free archives only. Module previews and insertion support
the new archives and older JSON `.phmod` / `.synth` files. Older app versions
cannot open the new archives.

## Patch and modules

[`PatchRuntime`](src/patch.js) owns each patch level. `toJSON()` saves:

- `modules`: each module's `id`, `type`, position (`x`, `y`), controller
  `values`, and `color`; optional `name`, module-specific `state`, and nested
  `patch` are included when applicable. Module ID 0 is the output.
- `cables`: module connections with `from` and `to` IDs.
- Optional `midiLock` and nested-layer `song`. The root song lives at the
  project top level; a PATCH module's own timeline lives in its nested patch.
  An empty nested timeline can be omitted; its selection is not saved there.
- Optional `tempoStep: 0.01`: patches without this marker retain legacy
  whole-BPM automation/modulation precision. Do not silently add it to old patches.

Module definitions under [`src/modules/`](src/modules/) declare `params` and
their defaults. Patch creation initializes each value from the saved ID or the
parameter default. Non-controller data uses a module's `defaultState` and
`normalizeState`, and is saved as `state`. Nested patches serialize recursively.
For samples and images, module state stores IDs; [`samples.js`](src/samples.js)
imports media into the pool before module state is restored.

## Song, clips, and notes

[`song.js`](src/song.js) documents and implements the song model. Song time and
lengths are in **quarter notes**; note and automation times are relative to the
clip. `y` is a timeline lane position in pixels, with negative `y` denoting
idea storage.

- A song has `clips`, time-signature `sigs`, grid `snap`, `selected`, `nextId`,
  lane `mutes` and `solos`, and optionally `restart`.
- A MIDI clip has `id`, `name`, `start`, `length`, `y`, `target`, `color`, and
  `notes`. A null color inherits the target module color. Notes have `pitch`,
  `start`, `length`, and `vel`; optional `vels` and `bends` hold curves.
- An automation clip adds `kind: "auto"`, `controller`, and `points`, with an
  empty notes array. `editorView` is optional per-clip editor view state.
- An audio clip has `kind: "audio"` and an `audio` object with `id`, `sampleRate`,
  `channels`, `frames`, `span`, and `offset`. `span` is the full asset's length
  in quarter notes; `offset` is the clip start's position in that asset, in
  quarter notes. The ID refers to an immutable working WAV. The standalone
  `.clip` format does not yet support audio.
- Linked clips have a `link` identifying their source. Each clip's content is
  present in the file; `normalizeSong()` restores shared notes, points, or audio
  content in memory. Positions and lengths remain per clip.

`emptySong()` and `addClip()` create defaults; `normalizeSong()` rebuilds and
validates loaded data rather than copying all unknown fields. Consequently, a
new saved song, clip, note, or signature field must also be handled by the
corresponding normalization path, or it can disappear after load or undo.

## Changing a field

1. Decide whether it belongs in the project, a patch, module state, song, clip,
   note, view, or local preferences. Initialize it where new objects are made.
2. Update the appropriate save **and** load/normalization paths. For nested
   timeline fields, check `songJSON()`'s empty-song omission as well. If a
   module parameter is added, set its default to preserve older projects.
3. Give missing fields in old files a compatible meaning. Where old and new
   behavior differ, use an explicit marker or migration as needed; test that
   resaving does not accidentally change old behavior. Older app versions may
   discard fields they do not recognize.
4. Check copying, linked clones, standalone clip/module files, undo/redo, and
   the audio-side model where applicable. [`playbackmodel.js`](src/playbackmodel.js)
   and [`dsp/playback.js`](src/dsp/playback.js) build and normalize playback
   copies; data that affects sound must reach those copies too. View-only
   fields should not accidentally count as edits or change audio.
5. Add focused tests for the new field: real save/load round trip, missing-field
   legacy behavior, and relevant copy/undo/playback paths. Update this document
   when the project structure or compatibility rules change.

Existing entry points include [`test/projectfile.test.mjs`](test/projectfile.test.mjs)
for project persistence and legacy loading, [`test/song.test.mjs`](test/song.test.mjs)
for timeline normalization and copies, [`test/patch.test.mjs`](test/patch.test.mjs)
for patch/module persistence, and
[`test/audiotransport.test.mjs`](test/audiotransport.test.mjs) for audio-side
playback. Run the tests relevant to the changed field.
