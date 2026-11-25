import { PROJECT_FORMAT, MODULE_FORMAT, isProject } from './fileformat.js';

/**
 * @typedef {object} ProjectSnapshot
 * @property {string} format Runtime project identifier.
 * @property {number} version Legacy JSON envelope version, not the ZIP version.
 * @property {object} patch Serialized patch, owned by PatchRuntime.
 * @property {object} song Root song model.
 * @property {object} [view] Optional UI state, added by the caller.
 *
 * A project ZIP manifest preserves snapshot fields, replaces samples with assets, and uses the
 * disk version. V3 also contains audioFiles; a module manifest has modules/cables in place of
 * patch/song. The indexes map media IDs to paths and metadata, not media bytes.
 */
export const CURRENT_ARCHIVE_VERSION = 3;

// The runtime snapshot retains the v1 envelope used by autosave and undo; it is not a disk manifest.
// The patch is serialized by its runtime; the song is the live model until the caller serializes it.
/** @returns {ProjectSnapshot} */
export function createProjectSnapshot(patch, song) {
  return { format: PROJECT_FORMAT, version: 1, patch, song };
}

export function checkProjectShape(data) {
  if (!isProject(data) || !Array.isArray(data.patch?.modules)) throw new Error('Not a PHILSYNTH project file');
}

export function checkProjectData(data, version) {
  checkProjectShape(data);
  if (version === 1 ? data.version != null && data.version !== 1 : data.version !== version) {
    throw new Error(`Unsupported PHILSYNTH project version: ${data.version ?? 'missing'}`);
  }
}

// Preserve model fields while replacing inline samples and file-format metadata with an asset index.
export function createProjectManifest(snapshot, version, assets, audioFiles) {
  if (version !== 2 && version !== CURRENT_ARCHIVE_VERSION) throw new Error(`Unsupported PHILSYNTH project version: ${version}`);
  const { samples: _samples, ...model } = snapshot;
  return version === 2
    ? { ...model, format: PROJECT_FORMAT, version, assets }
    : { ...model, format: PROJECT_FORMAT, version, assets, audioFiles };
}

export function createModuleManifest(snapshot, assets, audioFiles) {
  const { samples: _samples, ...model } = snapshot;
  return { ...model, format: MODULE_FORMAT, version: CURRENT_ARCHIVE_VERSION, assets, audioFiles };
}

const isIndex = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

export function readProjectManifest(manifest, version) {
  const { assets, ...data } = manifest ?? {};
  checkProjectData(data, version);
  if (data.format !== PROJECT_FORMAT || Object.hasOwn(data, 'samples') || !isIndex(assets)) {
    throw new Error('Invalid PHILSYNTH ZIP manifest');
  }
  if (version === 2) return { data, assets };
  const { audioFiles, ...model } = data;
  if (Object.hasOwn(model, 'recordings') || !isIndex(audioFiles)) throw new Error('Invalid PHILSYNTH ZIP manifest');
  return { data: model, assets, audioFiles };
}

export function readModuleManifest(manifest) {
  const { assets, audioFiles, ...data } = manifest ?? {};
  if (data.format !== MODULE_FORMAT || data.version !== CURRENT_ARCHIVE_VERSION || !Array.isArray(data.modules)) {
    throw new Error('Invalid PHILSYNTH module manifest');
  }
  if (Object.hasOwn(data, 'samples') || Object.hasOwn(data, 'recordings') || !isIndex(assets) || !isIndex(audioFiles)) {
    throw new Error('Invalid PHILSYNTH ZIP manifest');
  }
  return { data, assets, audioFiles };
}
