// IMAGE SAMPLER: a polyphonic synth that plays an image. A scanner (a line on the photo below the
// controllers) is read once per cycle of every note: the colours along it are the waveform, red
// mixed onto each speaker by its own + / − amount of every colour (DSP: cpp/imagesampler.h and imagesampler.dsp.js, maths:
// imagescan.js). Scanner Type picks the scanner; X / Y (the centre) are shared by every type but
// the Triangle (Length by Line and Propellor), the controllers of one type only (Rotation,
// Propellor Speed, Width / Height / Rotation of the Oval and Rectangle, the Triangle's corners
// X1 / Y1 … X3 / Y3) follow them and show for that type (fixed numbers, hidden when another type
// is chosen). Resolution: how many points along the scanner make the waveform (2..1024, the
// straight lines between them; few = coarse and jumpy). Then the colour amounts per speaker (Left, then Right), the envelope with its curves, and Gain last.
// Load Image (or drop a picture on the photo): it is scaled to 256 px at most and saved with the
// project (sample pool, src/samples.js). Without a picture of its own (imageId null) the module
// plays the stock wavetable picture (imagestock.js; built in, not saved). ADSR with stage curves and the ADSR editor as OSC.
import { linkDecayRelease } from './envlink.js';
import { curveParams } from './adsrcurve.js';
import { SCAN, SCAN_TYPES, TRI, TRI_DEFAULT, sized, RES_MIN, RES_MAX, RES_DEFAULT, resPoints } from './imagescan.js';
import { createImageView } from './imageview.js';
import { stockImageId } from './imagestock.js';
import { sampleFeeder, noteMessages } from './sampler.js';

const percent = (v) => `${v.toFixed(1)} %`;
const amountText = (v) => (Math.abs(v) < 0.5 ? 'Off' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(0)} %${v < 0 ? ' (inverted)' : ''}`);
// how much of each colour each speaker plays (+ as it is, − inverted); default red left, green
// on both, blue right
const colorParams = () => [
  { id: 'redLeft', label: 'Red ± Left', min: -100, max: 100, default: 100, step: 1, format: amountText },
  { id: 'greenLeft', label: 'Green ± Left', min: -100, max: 100, default: 50, step: 1, format: amountText },
  { id: 'blueLeft', label: 'Blue ± Left', min: -100, max: 100, default: 0, step: 1, format: amountText },
  { id: 'redRight', label: 'Red ± Right', min: -100, max: 100, default: 0, step: 1, format: amountText },
  { id: 'greenRight', label: 'Green ± Right', min: -100, max: 100, default: 50, step: 1, format: amountText },
  { id: 'blueRight', label: 'Blue ± Right', min: -100, max: 100, default: 100, step: 1, format: amountText },
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
    { id: 'x', label: 'X', min: 0, max: 100, default: 50, step: 0.1, format: percent, visible: (v) => (v.scanType | 0) !== SCAN.TRIANGLE },
    { id: 'y', label: 'Y', min: 0, max: 100, default: 50, step: 0.1, format: percent, visible: (v) => (v.scanType | 0) !== SCAN.TRIANGLE },
    { id: 'length', label: 'Length', min: 0, max: 100, default: 100, step: 0.1, format: percent, visible: (v) => (v.scanType | 0) <= SCAN.PROPELLOR },
    // per scanner type (below the shared ones)
    { id: 'rotation', label: 'Rotation', min: -180, max: 180, default: 0, step: 0.1, format: (v) => `${+v.toFixed(1)}°`, visible: (v) => (v.scanType | 0) === SCAN.LINE },
    { id: 'speed', label: 'Propellor Speed', min: -20, max: 20, default: 0.5, step: 0.01, format: (v) => `${v > 0 ? '+' : ''}${+v.toFixed(2)} turns/s`, visible: (v) => (v.scanType | 0) === SCAN.PROPELLOR },
    // Oval and Rectangle
    { id: 'ovalWidth', label: 'Width', min: 0, max: 100, default: 60, step: 0.1, format: percent, visible: (v) => sized(v.scanType | 0) },
    { id: 'ovalHeight', label: 'Height', min: 0, max: 100, default: 60, step: 0.1, format: percent, visible: (v) => sized(v.scanType | 0) },
    { id: 'ovalRotation', label: 'Rotation', min: -180, max: 180, default: 0, step: 0.1, format: (v) => `${+v.toFixed(1)}°`, visible: (v) => sized(v.scanType | 0) },
    // Triangle corners
    ...TRI.map((id, i) => ({ id, label: `${i % 2 ? 'Y' : 'X'}${(i >> 1) + 1}`, min: 0, max: 100, default: TRI_DEFAULT[i], step: 0.1, format: percent, visible: (v) => (v.scanType | 0) === SCAN.TRIANGLE })),
    // points read along the scanner per cycle (the waveform is the lines between them)
    { id: 'resolution', label: 'Resolution', min: RES_MIN, max: RES_MAX, default: RES_DEFAULT, step: 1, scale: 'log', normalize: resPoints, format: (v) => `${resPoints(v)} points` },
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
    const midi = noteMessages(send, host.dsp);
    return {
      node,
      input: null,
      setParam: (id, value) => send({ type: 'param', id, value }),
      setState: (st) => feed.set(st?.imageId ?? stockImageId()),
      ...midi,
      destroy: () => { midi.destroyNotes(); feed.destroy(); node.destroy(); },
    };
  },
};
