// COMPRESSOR: stereo-linked feed-forward compressor with side chain. DSP: compressor.dsp.js.
// The view draws the static curve (input level -> output level, with Threshold, Slope, Knee and
// Makeup) and a live gain reduction meter.
import { MODES, HPF_OFF, ratioText, gainReduction } from './compressor.dsp.js';
import { createMeter } from './meter.js';

const db = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
const ms = (v) => (v < 10 ? `${v.toFixed(2)} ms` : v < 1000 ? `${v.toFixed(1)} ms` : `${(v / 1000).toFixed(2)} s`);
const GR_MAX = 24;
const RANGE = 60; // dB shown by the curve (-60..0)

export default {
  type: 'COMPRESSOR',
  color: '#c9a27a',
  label: 'Compressor (side chain)',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'threshold', label: 'Threshold', min: -60, max: 0, default: -18, step: 0.1, format: db },
    { id: 'slope', label: 'Slope', min: 0, max: 1, default: 0.75, step: 0.01, format: (v) => `${v.toFixed(2)} (${ratioText(v)})` },
    { id: 'attack', label: 'Attack', min: 0.05, max: 200, default: 10, scale: 'log', format: ms },
    { id: 'release', label: 'Release', min: 5, max: 3000, default: 150, scale: 'log', format: ms },
    { id: 'mode', label: 'Mode', min: 0, max: MODES.length - 1, default: 0, step: 1, options: MODES },
    { id: 'sidechain', label: 'Side Chain', min: 0, max: 0, default: 0, step: 1, format: (v) => (v ? `Input ${v}` : 'Off') },
    { id: 'knee', label: 'Knee', min: 0, max: 24, default: 6, step: 0.1, format: (v) => (v ? `${v.toFixed(1)} dB` : 'Hard') },
    { id: 'makeup', label: 'Makeup Gain', min: -12, max: 36, default: 0, step: 0.1, format: db },
    { id: 'mix', label: 'Mix', min: 0, max: 100, default: 100, step: 1, format: (v) => `${v} % wet` },
    { id: 'scHpf', label: 'Side Chain HPF', min: HPF_OFF, max: 1000, default: HPF_OFF, scale: 'log', format: (v) => (v <= HPF_OFF + 0.5 ? 'Off' : `${Math.round(v)} Hz`) },
  ],
  view(entry, api) {
    const el = document.createElement('div');
    el.className = 'comp-view';
    const wrap = document.createElement('div');
    wrap.className = 'wave-view comp-curve';
    const cv = document.createElement('canvas');
    cv.setAttribute('role', 'img');
    wrap.append(cv);
    const meter = createMeter({ label: 'Gain Reduction', min: 0, max: GR_MAX, color: api.color, text: (v) => `${v < 0.05 ? '0.0' : `-${v.toFixed(1)}`} dB` });
    el.append(wrap, meter.el);
    const g = cv.getContext('2d');
    let values = entry.values;
    const val = (id) => values[id];
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) return;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const X = (d) => ((d + RANGE) / RANGE) * w;
      const Y = (d) => h - ((d + RANGE) / RANGE) * h;
      g.strokeStyle = '#2c2c32';
      g.lineWidth = 1;
      g.beginPath();
      for (let d = -RANGE + 12; d < 0; d += 12) {
        g.moveTo(Math.round(X(d)) + 0.5, 0); g.lineTo(Math.round(X(d)) + 0.5, h);
        g.moveTo(0, Math.round(Y(d)) + 0.5); g.lineTo(w, Math.round(Y(d)) + 0.5);
      }
      g.stroke();
      g.strokeStyle = '#4a4a52';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(X(-RANGE), Y(-RANGE)); g.lineTo(X(0), Y(0)); // 1:1
      const t = val('threshold');
      g.moveTo(Math.round(X(t)) + 0.5, 0); g.lineTo(Math.round(X(t)) + 0.5, h);
      g.stroke();
      g.setLineDash([]);
      const s = val('slope');
      const k = val('knee');
      const mk = val('makeup');
      g.strokeStyle = api.color;
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i <= w; i++) {
        const d = (i / w) * RANGE - RANGE;
        const y = Y(d - gainReduction(d, t, s, k) + mk);
        if (i) g.lineTo(i, y); else g.moveTo(i, y);
      }
      g.stroke();
      cv.setAttribute('aria-label', `Compressor curve: threshold ${t.toFixed(1)} dB, ratio ${ratioText(s)}, knee ${k.toFixed(1)} dB, makeup ${mk.toFixed(1)} dB`);
    };
    new ResizeObserver(draw).observe(cv);
    entry.inst.onMeter = (v) => meter.set(v);
    meter.set(entry.inst.gr);
    return {
      el,
      refresh(v) { values = v; draw(); },
    };
  },
  create(_ctx, def, host) {
    const node = host.dsp.create('compressor');
    let entry;
    let patch;
    const inst = {
      node,
      input: node,
      gr: 0,
      onMeter: null,
      attach(e, rt) { entry = e; patch = rt; },
      params() {
        const inputs = [...node.inputs];
        return def.params.map((p) => p.id !== 'sidechain' ? p : {
          ...p,
          max: Math.max(0, inputs.length, entry?.values.sidechain | 0),
          format(v) {
            if (!v) return 'Off (own input)';
            const source = inputs[v - 1];
            if (!source) return `Input ${v} (not connected)`;
            const m = [...patch.modules.values()].find((e) => e.inst.node === source);
            return m ? `Key: input ${v}: #${m.id} ${m.name || m.def.type}` : `Key: input ${v} (patch input)`;
          },
        });
      },
      setParam: (id, value) => node.param(id, value),
      destroy: () => node.destroy(),
    };
    node.onMeter = (v) => { inst.gr = v; inst.onMeter?.(v); };
    return inst;
  },
};
