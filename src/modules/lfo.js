// LFO: modulates one controller of every module it is cabled to (control cable, no audio).
//   Frequency + Frequency Unit: Hz, or cycles per note value synced to the BPM of this patch's Output,
//   or MIDI Pitch: runs at the frequency of the incoming note (Frequency ignored). Notes come from a
//   clip sent to it or a MULTIMIDI cabled into it, never from the MIDI keyboard (liveMidi: false).
//   Phase: where in its cycle the wave starts, on project load, after a panic (' twice: stop, then
//   panic), on play from start (, ; not the Random waves) and on every incoming note (plus that note's MODMIDI phase, e.g. a MULTIMIDI's Phase).
//   Amplitude: depth of the wave around its centre (100 % = full swing, 0 % = steady at the middle).
//   Out Controller: controller number (0..) of the connected module(s) to modulate.
//   Out Min / Out Max: modulation range in % of that controller's slider range (applied after Amplitude).
//   LFO On/Off: Off leaves controllers untouched and bypasses audio; On resumes the remembered phase.
//   MIDI notes still reset phase while Off.
// Mode selects controller modulation, audio amplitude modulation, or stereo panning.
import { modulatorParams, outParams, pct } from './modtarget.js';
import { syncedPeriod, MIDI_UNIT, SYNCED_FREQS } from './lfo.dsp.js';

export { lfoRateHz, syncedPeriod, pitchHz, MIDI_UNIT } from './lfo.dsp.js';

// appended last: saved Frequency Unit values keep their meaning
const UNITS = ['Hz', '1/4', '1/8', '1/16', 'MIDI Pitch (use incoming MIDI pitch)'];
const FRACTIONS = { 0.75: '3/4', 0.667: '2/3', 0.5: '1/2', 0.333: '1/3', 0.25: '1/4' };
export const phaseLabel = (v) => `${Math.round(v * 100)} % (${Math.round(v * 360)}°)`;

// Frequency with a synced Frequency Unit snaps to the note-value periods (Hz and MIDI Pitch: continuous)
export const freqSnaps = (values) => {
  const unit = values?.unit | 0;
  return unit && unit !== MIDI_UNIT ? SYNCED_FREQS : null;
};

export function formatFreq(v, values) {
  const unit = values?.unit | 0;
  if (unit === MIDI_UNIT) return 'MIDI pitch (ignored)';
  if (!unit) return `${v < 1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(1)} Hz`;
  const p = syncedPeriod(v);
  return `${FRACTIONS[+p.toFixed(3)] ?? p} × ${UNITS[unit]}`;
}


export default {
  type: 'LFO',
  color: '#05a6de',
  label: 'LFO (modulator)',
  acceptsMidi: true, // notes restart its phase; with Frequency Unit MIDI Pitch they also set the rate
  liveMidi: false, // not played by the MIDI device (selecting it does not take the keyboard)
  hasInput: true,
  hasOutput: true,
  modulator: true,
  audioThrough: true, // Mode selects whether its output carries audio or controller modulation
  params: [
    { id: 'wave', label: 'Waveform', min: 0, max: 6, default: 0, step: 1, options: ['Sine', 'Triangle', 'Saw', 'Square', 'Random (smooth step)', 'Random (steps)', 'Random (linear)'] },
    { id: 'unit', label: 'Frequency Unit', min: 0, max: UNITS.length - 1, default: 0, step: 1, options: UNITS },
    { id: 'freq', label: 'Frequency', min: 0.01, max: 50, default: 1, scale: 'log', format: formatFreq, snapValues: freqSnaps },
    { id: 'phase', label: 'Phase', min: 0, max: 1, default: 0, step: 0.01, format: phaseLabel },
    { id: 'amp', label: 'Amplitude', min: 0, max: 100, default: 100, step: 1, format: pct },
    ...outParams(),
    { id: 'enabled', label: 'LFO On/Off', min: 0, max: 1, default: 1, step: 1, options: ['Off', 'On'] },
    { id: 'mode', label: 'MODE', min: 0, max: 2, default: 0, step: 1,
      options: ['Controller Modulation', 'Amp (audio modulation)', 'Panning (audio modulation)'] },
  ],
  view(entry, api) {
    const el = document.createElement('div');
    const wrap = document.createElement('div');
    wrap.className = 'wave-view';
    wrap.setAttribute('data-editor-title', 'LFO output');
    const cv = document.createElement('canvas');
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', 'Live LFO output: last 5 seconds, 0 to 100 percent, before Out Smooth');
    const info = document.createElement('div');
    info.className = 'dialog-note';
    wrap.append(cv);
    el.append(wrap, info);
    const g = cv.getContext('2d');
    const points = [];
    let lastTime = -Infinity;
    let drawnAt = -Infinity;
    const draw = () => {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const y = value => h - 6 - value * (h - 12);
      g.strokeStyle = '#2c2c32';
      g.lineWidth = 1;
      g.beginPath();
      for (const value of [0, 0.5, 1]) { g.moveTo(0, y(value)); g.lineTo(w, y(value)); }
      for (let i = 1; i < 5; i++) { g.moveTo(w * i / 5, 0); g.lineTo(w * i / 5, h); }
      g.stroke();
      g.strokeStyle = api.color;
      g.lineWidth = 2;
      g.beginPath();
      points.forEach(([time, value], i) => {
        const x = w * (1 - (lastTime - time) / 5);
        if (i) g.lineTo(x, y(points[i - 1][1]));
        else g.moveTo(x, y(value));
        g.lineTo(x, y(value));
      });
      g.stroke();
      info.textContent = `Live output: ${(entry.inst.signal * 100).toFixed(1)} % · last 5 s · before Out Smooth`;
    };
    const observer = new ResizeObserver(draw);
    observer.observe(cv);
    const stop = entry.inst.node.host.onClock(time => {
      if (!el.isConnected || entry.inst.node.dead) { stop(); observer.disconnect(); return; }
      lastTime = time;
      points.push([time, entry.inst.signal]);
      while (points.length && points[0][0] < time - 5) points.shift();
      if (time - drawnAt >= 1 / 60) { drawnAt = time; draw(); }
    });
    return { el, refresh: draw };
  },
  create(_ctx, def, host) {
    // DSP: lfo.dsp.js; the engine graph maps its value onto the controllers it is cabled to
    const node = host.dsp.create('lfo');
    const send = (m) => node.send(m);
    const inst = {
      node,
      input: node,
      signal: 0,
      getTargets: () => [], // set by the patch: modules this LFO is cabled to
      params: () => modulatorParams(inst, def),
      setParam: (id, v) => node.param(id, v),
      setBpm: (bpm) => send({ type: 'bpm', value: bpm }),
      noteOn: (id, pitch, _velocity, phase = 0) => send({ type: 'noteOn', id, pitch, phase }),
      noteMod: (id, pitch, velocity) => send({ type: 'noteMod', notes: [[id, pitch, velocity]] }),
      noteOff: (id) => send({ type: 'noteOff', id }),
      allOff: () => send({ type: 'allOff' }),
      destroy: () => node.destroy(),
    };
    node.onMeter = value => { inst.signal = value / 100; };
    return inst;
  },
};
