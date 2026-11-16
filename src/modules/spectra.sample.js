export const SPECTRA_SAMPLE_SECONDS = 15;
export const SPECTRA_PARTIALS = 128;
export const SPECTRA_RENDER_RATE = 96000;
export const SPECTRA_CYCLE_FADE_SECONDS = 4;
export const SPECTRA_ROOT_KEY = 60;
export const SPECTRA_ROOT_HZ = 440 * 2 ** ((SPECTRA_ROOT_KEY - 69) / 12);
export const SPECTRA_TABLE_ROOT_HZ = SPECTRA_ROOT_HZ;
export const DEFAULT_SPECTRA_LEVELS = Object.freeze(Array.from({ length: SPECTRA_PARTIALS }, (_, i) => i < 8 ? 100 / (i + 1) : 0));

export function defaultSpectraState() {
  return { levels: [...DEFAULT_SPECTRA_LEVELS], detunes: Array(SPECTRA_PARTIALS).fill(0) };
}

export const randomSpectraPhases = () => Array.from({ length: SPECTRA_PARTIALS }, () => Math.random() * 100);

export function validateSpectraLength(seconds) {
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 16) throw new RangeError('SPECTRA sample length must be between 1 and 16 seconds');
}

export function normalizeSpectraState(state) {
  const defaults = defaultSpectraState();
  return Object.fromEntries(['levels', 'detunes'].map((key) => [
    key, defaults[key].map((value, i) => {
      const input = state?.[key]?.[i];
      return Number.isFinite(input) ? Math.max(key === 'detunes' ? -100 : 0, Math.min(100, input)) : value;
    }),
  ]));
}

export function generateSpectraSample(sampleRate, levels, detunes, phases = Array(SPECTRA_PARTIALS).fill(0), seconds = SPECTRA_SAMPLE_SECONDS) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('SPECTRA sample rate must be positive');
  validateSpectraLength(seconds);
  if ([levels, detunes, phases].some((values) => values?.length !== SPECTRA_PARTIALS)) throw new TypeError(`SPECTRA needs ${SPECTRA_PARTIALS} levels, detunes and phases`);
  for (let i = 0; i < SPECTRA_PARTIALS; i++) {
    if (![levels[i], detunes[i], phases[i]].every(Number.isFinite)) throw new TypeError('SPECTRA controls must be finite');
  }

  const length = Math.round(sampleRate * seconds);
  const data = new Float32Array(length);

  for (let partial = 0; partial < SPECTRA_PARTIALS; partial++) {
    const level = Math.max(0, Math.min(100, levels[partial])) / 100;
    const offset = Math.max(-100, Math.min(100, detunes[partial])) / 100;
    const frequency = (partial + 1 + offset) * SPECTRA_TABLE_ROOT_HZ;
    if (!level || frequency <= 0 || frequency >= sampleRate / 2) continue;
    const step = (2 * Math.PI * frequency) / sampleRate;
    const stepSin = Math.sin(step);
    const stepCos = Math.cos(step);
    const phase = Math.max(0, Math.min(100, phases[partial])) * 2 * Math.PI / 100;
    let headSin = Math.sin(phase);
    let headCos = Math.cos(phase);
    let tailSin = Math.sin(phase + step * length);
    let tailCos = Math.cos(phase + step * length);
    for (let i = 0; i < length; i++) {
      // Overlap consecutive segments: both loop ends meet at the raw segment boundary.
      const blend = i / length;
      data[i] += level * (tailSin * (1 - blend) + headSin * blend);
      const nextHead = headSin * stepCos + headCos * stepSin;
      headCos = headCos * stepCos - headSin * stepSin;
      headSin = nextHead;
      const nextTail = tailSin * stepCos + tailCos * stepSin;
      tailCos = tailCos * stepCos - tailSin * stepSin;
      tailSin = nextTail;
    }
  }

  let peak = 0;
  for (const sample of data) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0.9) {
    const scale = 0.9 / peak;
    for (let i = 0; i < length; i++) data[i] *= scale;
  }

  return data;
}
