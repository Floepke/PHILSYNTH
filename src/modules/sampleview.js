// Panel display of SAMPLER / WAVETABLE (below the controllers): the Load button, what is loaded,
// and a picture of it (sampler: the whole sample; wavetable: the frame Wave Select points at,
// following live modulation). Dropping an audio file on it loads it too.
import { addSample, decodeAudioFile, getSample, sampleFromFile, tableFromFile, MAX_SECONDS, onSample } from '../samples.js';
import { BLOCK_SIZES, DEFAULT_FRAME, builtinTable } from './wavetable.dsp.js';

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
    if (s) info.textContent = `${entry.state.name} · ${seconds(s.length, s.rate)} · ${s.channels.length > 1 ? 'stereo' : 'mono'} · ${s.rate} Hz`;
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
    cv.setAttribute('aria-label', `Sample waveform, ${entry.state.name}`);
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
      api.endEdit?.();
      show();
      if (audio.cut) info.textContent += table ? ' (cut to 256 × 4096 samples)' : ` (cut to ${MAX_SECONDS} s)`;
    } catch (err) {
      info.textContent = `Loading ${file.name} failed: ${err.message}`;
      info.classList.add('error');
    }
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
      const changed = v.position !== values.position || v.block !== values.block;
      values = { ...v };
      if (changed) show();
    },
    modulate(id, v) {
      if (!table || id !== 'position' || v === modPos) return;
      modPos = v;
      show();
    },
  };
}
