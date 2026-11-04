// ENVELOPE: a drawn envelope that modulates one controller of every module it is cabled to
// (control cable, like the ADSR). Notes trigger it (select it and play, send a clip to it, or
// cable a MULTIMIDI into it). A note starts the curve at its MODMIDI phase (MULTIMIDI Phase /
// Random Phase): phase 0..1 is the position on the curve.
//   Envelope Length: duration of the whole curve (0..10000 ms; 0 jumps straight to the end).
//   Mode: Note ON Trigger (every note plays the curve once from its start, then holds the end
//     value), Notes ON/OFF Loop (repeats while notes are held, stops when all are released; the
//     next note starts over) or Loop Forward/Backwards (the same, ping-pong). See envelope.dsp.js.
//   Out Controller / Out Min / Out Max: see modtarget.js (curve bottom = Out Min, top = Out Max).
// The curve is module state (saved with the project) edited like the WAVESHAPER curve
// (src/curveeditor.js): x is time, y is the output level. While the envelope plays, a white dot
// rides the curve as its playhead.
import { defaultEnvelope, normalizeCurve } from '../curve.js';
import { createCurveEditor } from '../curveeditor.js';
import { modulatorParams, outParams } from './modtarget.js';

export const MODES = ['Note ON Trigger', 'Notes ON/OFF Loop', 'Notes ON/OFF Loop Forward/Backwards'];
const ms = (v) => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);

// Where the dot is `d` (fraction of the curve) after the last report, per Mode.
export function playheadAt(p, d, mode) {
  if (mode === 1) { const u = p.pos + d; return u - Math.floor(u); }
  if (mode === 2) {
    const u = (((p.dir < 0 ? 2 - p.pos : p.pos) + d) % 2 + 2) % 2; // 0..2 around the ping-pong
    return u > 1 ? 2 - u : u;
  }
  return Math.min(1, p.pos + d);
}

export default {
  type: 'ENVELOPE',
  color: '#c4609a',
  label: 'Envelope (drawn modulator)',
  acceptsMidi: true, // notes trigger the envelope
  hasInput: false,
  hasOutput: true,
  modulator: true,
  params: [
    { id: 'mode', label: 'Mode', min: 0, max: 2, default: 0, step: 1, options: MODES },
    { id: 'length', label: 'Envelope Length', min: 0, max: 10000, default: 1000, step: 1, format: ms },
    ...outParams(),
  ],
  defaultState: defaultEnvelope,
  normalizeState: normalizeCurve,
  // panel editor (src/main.js): api.setState(curve) stores the curve; refresh() follows controllers
  editor(entry, api) {
    let length = entry.values.length;
    let mode = entry.values.mode | 0;
    const labels = () => ({ x0: '0 ms', x1: `${ms(length)} →`, y1: 'Out Max ↑' });
    const ed = createCurveEditor({
      curve: entry.state, color: api.color, labels: labels(), identity: false,
      formatX: (x) => ms(x * length), formatY: (y) => `level ${Math.round(y * 100)} %`,
      onChange: (c) => api.setState(c), beginEdit: api.beginEdit, endEdit: api.endEdit,
    });
    // playhead: the kernel reports its position every few ms (only after moving 1 %, see
    // Graph.report); in between the dot moves on at the speed of Envelope Length
    let raf = 0;
    const frame = () => {
      raf = 0;
      const p = entry.inst.playhead;
      if (!p || !ed.el.isConnected) { ed.setPlayhead(null); return; }
      ed.setPlayhead(length > 0 ? playheadAt(p, (performance.now() - p.t) / length, mode) : 1);
      raf = requestAnimationFrame(frame);
    };
    entry.inst.onPlayhead = () => { if (!raf) raf = requestAnimationFrame(frame); };
    if (entry.inst.playhead) entry.inst.onPlayhead();
    return {
      el: ed.el,
      refresh(values) {
        mode = values.mode | 0;
        if (values.length !== length) { length = values.length; ed.setLabels(labels()); }
      },
    };
  },
  create(_ctx, def, host) {
    const node = host.dsp.create('envelope'); // DSP: envelope.dsp.js
    const inst = {
      node,
      input: null,
      playhead: null, // { pos 0..1, t: performance.now() of the report } while playing
      onPlayhead: null, // set by the panel editor
      getTargets: () => [], // set by the patch: modules this ENVELOPE is cabled to
      params: () => modulatorParams(inst, def),
      setParam: (id, v) => node.param(id, v),
      setState: (curve) => node.send({ type: 'curve', curve }),
      noteOn: (id, _pitch, _velocity, phase = 0) => node.send({ type: 'noteOn', id, phase }),
      noteMod() {},
      noteOff: (id) => node.send({ type: 'noteOff', id }),
      allOff: () => node.send({ type: 'allOff' }),
      destroy: () => node.destroy(),
    };
    node.onMeter = (pos) => {
      const prev = inst.playhead;
      // ping-pong: the direction follows from the last two reports
      const dir = prev && pos >= 0 && pos !== prev.pos ? Math.sign(pos - prev.pos) : prev?.dir ?? 1;
      inst.playhead = pos >= 0 ? { pos, dir, t: performance.now() } : null;
      inst.onPlayhead?.();
    };
    return inst;
  },
};
