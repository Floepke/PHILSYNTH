import { noteMessages } from './sampler.js';
import { createAdsrView } from './adsrview.js';
import { curveParams } from './adsrcurve.js';
import { linkDecayRelease } from './envlink.js';
import { createSpectraEditor } from './spectraview.js';
import { defaultSpectraState, normalizeSpectraState, generateSpectraSample, randomSpectraPhases, SPECTRA_RENDER_RATE } from './spectra.sample.js';

function createSamples(ctx, host) {
  const rate = Math.max(SPECTRA_RENDER_RATE, Number.isFinite(ctx?.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : 48000);
  const nodes = new Set();
  let state = defaultSpectraState();
  let current = null;
  let next = null;
  let frame = 0;
  let sequence = 0;
  let nextFrame = 0;
  let timer = null;
  let revision = 0;
  let workerBusy = false;
  let pending = null;
  let firstState = true;
  let dead = false;
  const synchronous = !!host.dsp.clockBatch;
  const worker = synchronous || typeof Worker === 'undefined' ? null : new Worker(new URL('./spectra.worker.js', import.meta.url), { type: 'module' });
  const deliver = (data, mode) => {
    if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer === 'function') {
      const shared = new Float32Array(new SharedArrayBuffer(data.byteLength));
      shared.set(data);
      data = shared;
    }
    if (mode === 'next') { next = data; nextFrame = ++sequence; }
    else { current = data; next = null; }
    for (const node of nodes) {
      node.send({ type: mode === 'next' ? 'nextSample' : 'sample', rate, data, ...(mode === 'next' ? { frame: nextFrame } : {}) });
    }
  };
  const render = (mode) => {
    if (workerBusy) {
      if (mode === 'current' || pending !== 'current') pending = mode;
      return;
    }
    const phases = randomSpectraPhases();
    if (!worker) {
      deliver(generateSpectraSample(rate, state.levels, state.detunes, phases), mode);
      if (mode === 'current') prepareNext();
      return;
    }
    workerBusy = true;
    worker.postMessage({ revision, mode, rate, ...state, phases });
  };
  const prepareNext = () => render('next');
  const buildCurrent = () => deliver(generateSpectraSample(rate, state.levels, state.detunes, randomSpectraPhases()), 'current');
  const scheduleCurrent = () => {
    revision++;
    pending = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (synchronous) { buildCurrent(); prepareNext(); return; }
    timer = setTimeout(() => { timer = null; render('current'); }, 60);
  };
  const changed = (value) => ['levels', 'detunes'].some((key) => value[key].some((v, i) => v !== state[key][i]));
  if (worker) {
    worker.onmessage = ({ data }) => {
      workerBusy = false;
      if (dead) return;
      if (data.revision === revision) {
        deliver(data.sample, data.mode);
        if (data.mode === 'current' && pending !== 'current') pending = 'next';
      }
      if (pending && timer === null) {
        const mode = pending;
        pending = null;
        render(mode);
      }
    };
    worker.onerror = (event) => {
      workerBusy = false;
      pending = null;
      const message = `SPECTRA sample generation failed: ${event.message}`;
      console.error(message);
      host.dsp.onError?.(message);
    };
  }
  buildCurrent();
  return {
    subscribe(node) {
      nodes.add(node);
      node.send({ type: 'sample', rate, data: current });
      if (next) node.send({ type: 'nextSample', rate, data: next, frame: nextFrame });
      // A frame ID rejects late reports from other copies of the same phase refresh.
      node.onMeter = (value) => {
        if (dead || value <= frame || !next || value !== nextFrame) return;
        frame = value;
        current = next;
        next = null;
        for (const other of nodes) {
          if (other !== node) other.send({ type: 'phaseSample', rate, data: current, frame });
        }
        if (timer === null && pending !== 'current') prepareNext();
      };
      return () => {
        node.onMeter = null;
        if (!nodes.delete(node)) return;
        if (nodes.size) return;
        dead = true;
        if (timer !== null) clearTimeout(timer);
        worker?.terminate();
        current = next = null;
        host.shared?.delete('spectraSamples');
      };
    },
    setState(value) {
      const normalized = normalizeSpectraState(value);
      const initial = firstState;
      firstState = false;
      if (!changed(normalized)) { if (initial) prepareNext(); return; }
      state = normalized;
      if (initial) { revision++; buildCurrent(); prepareNext(); }
      else scheduleCurrent();
    },
    restoreValues(values) {
      const migrated = defaultSpectraState();
      for (let i = 0; i < 8; i++) {
        migrated.levels[i] = values[`amp${i + 1}`] ?? migrated.levels[i];
        migrated.detunes[i] = values[`detune${i + 1}`] ?? 0;
      }
      const normalized = normalizeSpectraState(migrated);
      if (changed(normalized)) {
        state = normalized;
        revision++;
        buildCurrent();
        prepareNext();
      }
      return normalized;
    },
  };
}

export default {
  type: 'SPECTRA',
  color: '#6785a2',
  label: 'Spectral overtone loop',
  acceptsMidi: true,
  hasInput: false,
  hasOutput: true,
  params: [
    { id: 'polyphony', label: 'Polyphony', min: 1, max: 32, default: 8, step: 1 },
    { id: 'attack', label: 'Attack (s)', min: 0.001, max: 10, default: 0.003, step: 0.001 },
    { id: 'decay', label: 'Decay (s)', min: 0.001, max: 10, default: 0.003, step: 0.001 },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 1, step: 0.01 },
    { id: 'release', label: 'Release (s)', min: 0.001, max: 10, default: 0.02, step: 0.001 },
    ...curveParams(100),
    { id: 'gain', label: 'Gain', min: 0, max: 1, default: 0.45, step: 0.01 },
  ],
  linked: linkDecayRelease,
  defaultState: defaultSpectraState,
  normalizeState: normalizeSpectraState,
  editor: createSpectraEditor,
  view(entry, api) {
    return createAdsrView({ color: api.color, values: entry.values, params: entry.def.params, ...api });
  },
  create(ctx, _def, host) {
    const node = host.dsp.create('spectra');
    const send = (m) => node.send(m);
    const midi = noteMessages(send, host.dsp);
    // Audio-thread playback binds the existing kernel; only the main instance owns its sample.
    if (host.dsp.controlOnly) {
      return {
        node,
        input: null,
        setParam: (id, value) => send({ type: 'param', id, value }),
        ...midi,
        destroy() { midi.destroyNotes(); node.destroy(); },
      };
    }
    let samples = host.shared?.get('spectraSamples');
    if (!samples) {
      samples = createSamples(ctx, host);
      host.shared?.set('spectraSamples', samples);
    }
    const unsubscribe = samples.subscribe(node);
    let entry = null;
    return {
      node,
      input: null,
      attach(value) { entry = value; },
      setParam: (id, value) => send({ type: 'param', id, value }),
      setState: (value) => samples.setState(value),
      restoreValues(values) {
        if (!values || !Object.hasOwn(values, 'amp1')) return;
        const state = samples.restoreValues(values);
        if (entry) entry.state = state;
      },
      ...midi,
      destroy() {
        unsubscribe();
        midi.destroyNotes();
        node.destroy();
      },
    };
  },
};
