// PHILSYNTH file formats: the "format" field of the JSON inside each kind of file, and the file
// extensions. Files from before the rename (format 'modsynth…', .mds / .synth) still open.
export const PROJECT_FORMAT = 'philsynth';
export const MODULE_FORMAT = 'philsynth-module';
export const CLIP_FORMAT = 'philsynth-clip';
const LEGACY = { [PROJECT_FORMAT]: 'modsynth', [MODULE_FORMAT]: 'modsynth-module', [CLIP_FORMAT]: 'modsynth-clip' };

// true for the current format name and the one used before the rename
export const isFormat = (value, format) => value === format || value === LEGACY[format];
export const isProject = (data) => isFormat(data?.format, PROJECT_FORMAT);

export const PROJECT_EXT = '.phproject';
export const MODULE_EXT = '.phmod';
export const CLIP_EXT = '.clip';
// older extensions that still open (a project opened from one is saved as a new .phproject)
export const PROJECT_OPEN_EXTS = [PROJECT_EXT, '.mds', '.json'];
export const MODULE_OPEN_EXTS = [MODULE_EXT, '.synth'];
