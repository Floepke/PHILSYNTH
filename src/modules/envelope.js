// ENVELOPE: a drawn envelope that modulates one controller of every module it is cabled to
// (control cable, like the ADSR). Every note plays the curve once from its start (select it and
// play, send a clip to it, or cable a MULTIMIDI into it); afterwards it holds the curve's end value.
//   Envelope Length: duration of the whole curve (0..10000 ms; 0 jumps straight to the end).
//   Out Controller / Out Min / Out Max: see modtarget.js (curve bottom = Out Min, top = Out Max).
// The curve is module state (saved with the project) edited like the WAVESHAPER curve
// (src/curveeditor.js): x is time, y is the output level. While the envelope plays, a white dot
// rides the curve as its playhead.
import { defaultEnvelope, normalizeCurve } from '../curve.js';
import { createCurveEditor } from '../curveeditor.js';
import { modulatorParams, outParams } from './modtarget.js';

const ms = (v) => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);

export default {
  type: 'ENVELOPE',
  color: '#c4609a',
  label: 'Envelope (drawn modulator)',
  acceptsMidi: true, // notes trigger the envelope
  hasInput: false,
  hasOutput: true,
  modulator: true,
  params: [
    { id: 'length', label: 'Envelope Length', min: 0, max: 10000, default: 1000, step: 1, format: ms },
    ...outParams(),
  ],
  defaultState: defaultEnvelope,
  normalizeState: normalizeCurve,
  // panel editor (src/main.js): api.setState(curve) stores the curve; refresh() follows controllers
  editor(entry, api) {
    let length = entry.values.length;
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
      ed.setPlayhead(length > 0 ? p.pos + (performance.now() - p.t) / length : 1);
      raf = requestAnimationFrame(frame);
    };
    entry.inst.onPlayhead = () => { if (!raf) raf = requestAnimationFrame(frame); };
    if (entry.inst.playhead) entry.inst.onPlayhead();
    return {
      el: ed.el,
      refresh(values) { if (values.length !== length) { length = values.length; ed.setLabels(labels()); } },
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
      noteOn: (id) => node.send({ type: 'noteOn', id }),
      noteMod() {},
      noteOff() {},
      allOff() {},
      destroy: () => node.destroy(),
    };
    node.onMeter = (pos) => {
      inst.playhead = pos >= 0 ? { pos, t: performance.now() } : null;
      inst.onPlayhead?.();
    };
    return inst;
  },
};
