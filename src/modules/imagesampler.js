// IMAGE SAMPLER: a polyphonic synth that plays an image. A scanner (a line on the photo below the
// controllers) is read once per cycle of every note: the colours along it are the waveform, red
// mixed onto the speakers by a Pan and a Level per colour (DSP: imagesampler.dsp.js, maths:
// imagescan.js). Scanner Type picks the scanner; X / Y are shared by every type (Length by Line and
// Propellor), the controllers of one type only (Rotation, Propellor Speed, the Oval's Width /
// Height / Rotation) follow them and show for that type (fixed numbers, hidden when another type
// is chosen). Then the colour Levels and Pans, the envelope with its curves, and Gain last.
// Load Image (or drop a picture on the photo): it is scaled to 256 px at most and saved with the
// project (sample pool, src/samples.js). ADSR with stage curves and the ADSR editor as OSC.
import { linkDecayRelease } from './envlink.js';
import { curveParams } from './adsrcurve.js';
import { SCAN, SCAN_TYPES } from './imagescan.js';
import { createImageView } from './imageview.js';
import { sampleFeeder, noteMessages } from './sampler.js';

const percent = (v) => `${v.toFixed(1)} %`;
const panText = (v) => (Math.abs(v) < 0.5 ? 'Centre' : `${Math.abs(v).toFixed(0)} % ${v < 0 ? 'L' : 'R'}`);
const levelText = (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)} %${v < 0 ? ' (inverted)' : ''}`;
const colorParams = () => [
  { id: 'redLevel', label: 'Red Level', min: -100, max: 100, default: 100, step: 1, format: levelText },
  { id: 'greenLevel', label: 'Green Level', min: -100, max: 100, default: 100, step: 1, format: levelText },
  { id: 'blueLevel', label: 'Blue Level', min: -100, max: 100, default: 100, step: 1, format: levelText },
  { id: 'redPan', label: 'Red Pan', min: -100, max: 100, default: -100, step: 1, format: panText },
  { id: 'greenPan', label: 'Green Pan', min: -100, max: 100, default: 0, step: 1, format: panText },
  { id: 'bluePan', label: 'Blue Pan', min: -100, max: 100, default: 100, step: 1, format: panText },
];

export const imageState = (s) => ({ imageId: typeof s?.imageId === 'string' ? s.imageId : null, name: String(s?.name ?? '') });

export default {
  type: 'IMAGESAMPLER',
  color: '#46c9c9',
  label: 'Image Sampler (poly synth)',
  acceptsMidi: true,
  hasInput: false,
  hasOutput: true,
  params: [
    { id: 'polyphony', label: 'Polyphony', min: 1, max: 32, default: 8, step: 1 },
    { id: 'scanType', label: 'Scanner Type', min: 0, max: SCAN_TYPES.length - 1, default: 0, step: 1, options: SCAN_TYPES },
    { id: 'x', label: 'X', min: 0, max: 100, default: 50, step: 0.1, format: percent },
    { id: 'y', label: 'Y', min: 0, max: 100, default: 50, step: 0.1, format: percent },
    { id: 'length', label: 'Length', min: 0, max: 100, default: 70, step: 0.1, format: percent, visible: (v) => (v.scanType | 0) !== SCAN.OVAL },
    // per scanner type (below the shared ones)
    { id: 'rotation', label: 'Rotation', min: -180, max: 180, default: 0, step: 0.1, format: (v) => `${+v.toFixed(1)}°`, visible: (v) => (v.scanType | 0) === SCAN.LINE },
    { id: 'speed', label: 'Propellor Speed', min: -20, max: 20, default: 0.5, step: 0.01, format: (v) => `${v > 0 ? '+' : ''}${+v.toFixed(2)} turns/s`, visible: (v) => (v.scanType | 0) === SCAN.PROPELLOR },
    { id: 'ovalWidth', label: 'Width', min: 0, max: 100, default: 60, step: 0.1, format: percent, visible: (v) => (v.scanType | 0) === SCAN.OVAL },
    { id: 'ovalHeight', label: 'Height', min: 0, max: 100, default: 60, step: 0.1, format: percent, visible: (v) => (v.scanType | 0) === SCAN.OVAL },
    { id: 'ovalRotation', label: 'Rotation', min: -180, max: 180, default: 0, step: 0.1, format: (v) => `${+v.toFixed(1)}°`, visible: (v) => (v.scanType | 0) === SCAN.OVAL },
    ...colorParams(),
    { id: 'attack', label: 'Attack (s)', min: 0.001, max: 10, default: 0.01, step: 0.001 },
    { id: 'decay', label: 'Decay (s)', min: 0.001, max: 10, default: 0.2, step: 0.001 },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 1, step: 0.01 },
    { id: 'release', label: 'Release (s)', min: 0.001, max: 10, default: 0.3, step: 0.001 },
    ...curveParams(),
    { id: 'gain', label: 'Gain', min: 0, max: 1, default: 0.5, step: 0.01 },
  ],
  linked: linkDecayRelease,
  defaultState: () => imageState(null),
  normalizeState: imageState,
  view: (entry, api) => createImageView(entry, api),
  create(_ctx, _def, host) {
    const node = host.dsp.create('imagesampler'); // DSP: imagesampler.dsp.js
    const send = (m) => node.send(m);
    const feed = sampleFeeder((s) => send(s?.kind === 'image'
      ? { type: 'image', width: s.width, height: s.height, rgb: s.rgb }
      : { type: 'image', width: 0, height: 0, rgb: null }));
    return {
      node,
      input: null,
      setParam: (id, value) => send({ type: 'param', id, value }),
      setState: (st) => feed.set(st?.imageId ?? null),
      ...noteMessages(send),
      destroy: () => { feed.destroy(); node.destroy(); },
    };
  },
};
