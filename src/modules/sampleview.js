// Panel display of SAMPLER / WAVETABLE (below the controllers): the Load button, what is loaded,
// and a picture of it (sampler: the whole sample; wavetable: the frame Wave Select points at,
// following live modulation). Dropping an audio file on it loads it too.
// SAMPLER sample editor (mouse + keys on the waveform):
//   drag                 select a region = the playback region (Selection Start / Length)
//   drag a region edge   trim that edge
//   double-click         select the whole sample
//   Backspace / Delete   cut the selected region out of the sample (the sample gets shorter)
// A live-modulated region is outlined dashed. All edits are undoable.
import { addSample, decodeAudioFile, getSample, sampleFromFile, tableFromFile, MAX_SECONDS, onSample } from '../samples.js';
import { BLOCK_SIZES, DEFAULT_FRAME, builtinTable } from './wavetable.dsp.js';

const EDGE_PX = 6; // grab distance of a region edge

// Audio of `s` without samples [a, b) (null if nothing would be left)
export function cutRegion(s, a, b) {
  a = Math.max(0, Math.min(s.length, Math.round(a)));
  b = Math.max(a, Math.min(s.length, Math.round(b)));
  const length = s.length - (b - a);
  if (length <= 0) return null;
  return {
    rate: s.rate,
    channels: s.channels.map((c) => {
      const out = new Float32Array(length);
      out.set(c.subarray(0, a));
      out.set(c.subarray(b), a);
      return out;
    }),
  };
}

const seconds = (n, rate) => `${(n / rate).toFixed(n / rate < 10 ? 2 : 1)} s`;

// table: true for WAVETABLE. Returns a def.view() result.
export function createSampleView(entry, api, { table = false } = {}) {
  const el = document.createElement('div');
  el.className = 'sample-view';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sample-load';
  button.textContent = table ? 'Load Wavetable' : 'Load Sample';
  const input = Object.assign(document.createElement('input'), {
    type: 'file',
    hidden: true,
    accept: table ? '.wav,.wt,audio/*' : 'audio/*,.wav,.aif,.aiff,.flac,.ogg,.mp3',
  });
  const info = document.createElement('div');
  info.className = 'sample-info';
  const box = document.createElement('div');
  box.className = 'wave-view';
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  box.append(cv);
  el.append(button, input, info, box);
  const g = cv.getContext('2d');
  let values = { ...entry.values };
  let modPos = null;
  const modSel = { selStart: null, selLength: null };
  // the selection as fractions of the sample (base values, or the modulated ones)
  const selection = (live = false) => {
    const st = (live ? modSel.selStart ?? values.selStart : values.selStart) ?? 0;
    const ln = (live ? modSel.selLength ?? values.selLength : values.selLength) ?? 100;
    const a = Math.max(0, Math.min(1, st / 100));
    return { a, b: Math.max(a, Math.min(1, a + Math.max(0, ln) / 100)) };
  };

  const tableNow = () => {
    const s = getSample(entry.state?.sampleId);
    return s ? { data: s.channels[0], frame: entry.state.frame || DEFAULT_FRAME, name: entry.state.name } : { ...builtinTable(), name: 'Built-in (sine → triangle → saw → square)' };
  };
  const layout = (t) => {
    const want = BLOCK_SIZES[values.block | 0] || t.frame;
    const size = Math.max(1, Math.min(want, t.data.length));
    return { size, frames: Math.max(1, Math.floor(t.data.length / size)) };
  };

  const describe = () => {
    info.classList.remove('error');
    if (table) {
      const t = tableNow();
      const { size, frames } = layout(t);
      const pos = (modPos ?? values.position) / 100;
      info.textContent = `${t.name} · ${frames} frame${frames > 1 ? 's' : ''} × ${size} · frame ${(pos * (frames - 1) + 1).toFixed(1)}`;
      return;
    }
    const s = getSample(entry.state?.sampleId);
    if (s) {
      const { a, b } = selection();
      const whole = a === 0 && b === 1;
      info.textContent = `${entry.state.name} · ${seconds(s.length, s.rate)} · ${s.channels.length > 1 ? 'stereo' : 'mono'} · ${s.rate} Hz`
        + (whole ? '' : ` · selected ${seconds(a * s.length, s.rate)} – ${seconds(b * s.length, s.rate)}`);
    }
    else if (entry.state?.sampleId) info.textContent = `${entry.state.name}: sample data missing, load it again`;
    else info.textContent = 'No sample loaded: notes stay silent.';
  };

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
    const pad = 6;
    g.strokeStyle = '#2c2c32';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, Math.round(h / 2) + 0.5);
    g.lineTo(w, Math.round(h / 2) + 0.5);
    g.stroke();
    g.strokeStyle = api.color;
    g.fillStyle = api.color;
    if (table) {
      const t = tableNow();
      const { size, frames } = layout(t);
      const fp = ((modPos ?? values.position) / 100) * (frames - 1);
      const f0 = Math.floor(fp);
      const f1 = Math.min(frames - 1, f0 + 1);
      const at = (f, x) => t.data[f * size + Math.min(size - 1, Math.floor(x * size))];
      const amp = h / 2 - pad;
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.beginPath();
      const n = Math.max(64, Math.round(w * 2));
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1);
        const y = at(f0, x) + (at(f1, x) - at(f0, x)) * (fp - f0);
        const px = x * w;
        const py = h / 2 - Math.max(-1, Math.min(1, y)) * amp;
        if (i) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.stroke();
      cv.setAttribute('aria-label', `Wavetable frame ${f0 + 1} of ${frames}`);
      return;
    }
    const s = getSample(entry.state?.sampleId);
    if (!s) { cv.setAttribute('aria-label', 'No sample'); return; }
    const rows = s.channels.length;
    const rh = h / rows;
    for (let c = 0; c < rows; c++) {
      const d = s.channels[c];
      const mid = rh * c + rh / 2;
      const amp = rh / 2 - 3;
      for (let x = 0; x < w; x++) {
        const a = Math.floor((x / w) * s.length);
        const b = Math.max(a + 1, Math.floor(((x + 1) / w) * s.length));
        let lo = 0;
        let hi = 0;
        for (let i = a; i < b; i += Math.max(1, ((b - a) / 64) | 0)) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
        g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    }
    // selection: dim what is outside, edges with grab handles; a modulated window dashed
    const { a, b } = selection();
    const xa = a * w;
    const xb = b * w;
    g.fillStyle = 'rgba(0, 0, 0, 0.55)';
    g.fillRect(0, 0, xa, h);
    g.fillRect(xb, 0, w - xb, h);
    g.fillStyle = 'rgba(255, 255, 255, 0.06)';
    g.fillRect(xa, 0, xb - xa, h);
    g.fillStyle = '#fff';
    for (const x of [xa, xb]) {
      const px = Math.max(0.5, Math.min(w - 0.5, Math.round(x) + 0.5));
      g.fillRect(px - 0.5, 0, 1, h);
      g.fillRect(px - 3, 0, 6, 6);
      g.fillRect(px - 3, h - 6, 6, 6);
    }
    if (modSel.selStart !== null || modSel.selLength !== null) {
      const m = selection(true);
      g.strokeStyle = '#fff';
      g.setLineDash([4, 3]);
      g.strokeRect(m.a * w + 0.5, 1.5, Math.max(1, (m.b - m.a) * w - 1), h - 3);
      g.setLineDash([]);
    }
    cv.setAttribute('aria-label', `Sample waveform, ${entry.state.name}, selected ${Math.round(a * 1000) / 10} % to ${Math.round(b * 1000) / 10} %`);
  };

  const show = () => { describe(); draw(); };

  async function load(file) {
    if (!file) return;
    info.classList.remove('error');
    info.textContent = `Loading ${file.name}…`;
    try {
      const decoded = await decodeAudioFile(await file.arrayBuffer());
      const audio = table ? tableFromFile(decoded) : sampleFromFile(decoded);
      const sampleId = addSample(audio);
      const name = file.name.replace(/\.[^.]+$/, '');
      api.beginEdit?.();
      api.setState(table ? { sampleId, name, frame: audio.frame } : { sampleId, name });
      if (!table) setSelection(0, 1); // a new sample plays whole
      api.endEdit?.();
      show();
      if (audio.cut) info.textContent += table ? ' (cut to 256 × 4096 samples)' : ` (cut to ${MAX_SECONDS} s)`;
    } catch (err) {
      info.textContent = `Loading ${file.name} failed: ${err.message}`;
      info.classList.add('error');
    }
  }

  // ---- SAMPLER sample editor ----
  const setSelection = (a, b) => {
    a = Math.max(0, Math.min(1, a));
    b = Math.max(a, Math.min(1, b));
    api.setParam?.('selStart', a * 100);
    api.setParam?.('selLength', (b - a) * 100);
    values = { ...values, selStart: a * 100, selLength: (b - a) * 100 };
    show();
  };

  function cut() {
    const s = getSample(entry.state?.sampleId);
    if (!s) return;
    const { a, b } = selection();
    if (b - a <= 0) return;
    const rest = cutRegion(s, a * s.length, b * s.length);
    if (!rest) {
      info.textContent = 'The whole sample is selected: select a part of it to delete.';
      info.classList.add('error');
      return;
    }
    const sampleId = addSample(rest);
    api.beginEdit?.();
    api.setState({ ...entry.state, sampleId });
    setSelection(0, 1);
    api.endEdit?.();
    show();
  }

  if (!table) {
    cv.tabIndex = 0; // focus for Backspace (keeps it away from the patcher, which would delete the module)
    cv.classList.add('sample-edit');
    const fracAt = (e) => {
      const r = cv.getBoundingClientRect();
      return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
    };
    const edgeAt = (e) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left;
      const { a, b } = selection();
      const da = Math.abs(x - a * r.width);
      const db = Math.abs(x - b * r.width);
      if (Math.min(da, db) > EDGE_PX) return null;
      return db < da || (db === da && x > b * r.width) ? 'b' : 'a';
    };
    cv.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      cv.style.cursor = getSample(entry.state?.sampleId) && edgeAt(e) ? 'ew-resize' : 'text';
    });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      cv.focus({ preventScroll: true });
      if (!getSample(entry.state?.sampleId)) return;
      e.preventDefault();
      const edge = edgeAt(e);
      const start = selection();
      const anchor = edge === 'a' ? start.b : edge === 'b' ? start.a : fracAt(e);
      const x0 = e.clientX;
      let editing = false;
      cv.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!editing) {
          if (!edge && Math.abs(ev.clientX - x0) < 3) return; // a click keeps the selection
          editing = true;
          api.beginEdit?.();
        }
        const f = fracAt(ev);
        setSelection(Math.min(anchor, f), Math.max(anchor, f));
      };
      const up = () => {
        cv.removeEventListener('pointermove', move);
        cv.removeEventListener('pointerup', up);
        cv.removeEventListener('pointercancel', up);
        if (editing) api.endEdit?.();
      };
      cv.addEventListener('pointermove', move);
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
    });
    cv.addEventListener('dblclick', () => {
      if (!getSample(entry.state?.sampleId)) return;
      api.beginEdit?.();
      setSelection(0, 1);
      api.endEdit?.();
    });
    cv.addEventListener('keydown', (e) => {
      const command = (e.ctrlKey || e.metaKey) && !e.altKey;
      if ((e.key === 'Backspace' || e.key === 'Delete') && !command) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) cut();
      } else if (command && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        e.stopPropagation();
        api.beginEdit?.();
        setSelection(0, 1);
        api.endEdit?.();
      }
    });
  }

  button.onclick = () => input.click();
  input.onchange = () => { load(input.files[0]); input.value = ''; };
  el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop');
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    e.preventDefault();
    load(file);
  });
  new ResizeObserver(draw).observe(cv);
  let off = null;
  off = onSample((id) => {
    if (!el.isConnected) { off(); return; } // panel closed: stop listening
    if (id === entry.state?.sampleId) show();
  });
  describe();

  return {
    el,
    refresh(v) {
      const changed = v.position !== values.position || v.block !== values.block
        || v.selStart !== values.selStart || v.selLength !== values.selLength;
      values = { ...v };
      if (changed) show();
    },
    modulate(id, v) {
      if (!table) {
        if (!(id in modSel) || modSel[id] === v) return;
        modSel[id] = v;
        draw();
        return;
      }
      if (id !== 'position' || v === modPos) return;
      modPos = v;
      show();
    },
  };
}
