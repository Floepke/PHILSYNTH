// PHILSYNTH file formats: the "format" field of the JSON inside each kind of file, and the file
// extensions. Files from before the rename (format 'modsynth…', .mds / .synth) still open.
export const PROJECT_FORMAT = 'philsynth';
export const MODULE_FORMAT = 'philsynth-module';
export const CLIP_FORMAT = 'philsynth-clip';
const LEGACY = { [PROJECT_FORMAT]: 'modsynth', [MODULE_FORMAT]: 'modsynth-module', [CLIP_FORMAT]: 'modsynth-clip' };

// true for the current format name and the one used before the rename
export const isFormat = (value, format) => value === format || value === LEGACY[format];
export const isProject = (data) => isFormat(data?.format, PROJECT_FORMAT);

// Compact JSON for saved project, module, clip and autosave files.
export const jsonFileText = (data) => JSON.stringify(data);

export const PROJECT_EXT = '.phproject';
export const MODULE_EXT = '.phmod';
export const CLIP_EXT = '.clip';
// older extensions that still open (a project opened from one is saved as a new .phproject)
export const PROJECT_OPEN_EXTS = [PROJECT_EXT, '.mds', '.json'];
export const MODULE_OPEN_EXTS = [MODULE_EXT, '.synth'];
// media the modules load (SAMPLER / WAVETABLE / IMAGE SAMPLER): what the desktop app's dialog lists
export const AUDIO_OPEN_EXTS = ['.wav', '.aif', '.aiff', '.flac', '.ogg', '.oga', '.opus', '.mp3', '.m4a', '.aac', '.webm'];
export const WAVETABLE_OPEN_EXTS = ['.wav', '.wt', ...AUDIO_OPEN_EXTS.slice(1)];
export const IMAGE_OPEN_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'];
export const MIDI_OPEN_EXTS = ['.mid', '.midi'];
export const MAX_MIDI_BYTES = 32 * 1024 * 1024;
