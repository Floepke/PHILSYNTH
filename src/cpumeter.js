// Small DSP-load monitor in the status bar (fed by engine.onCpu, see cpu.worklet.js).

const HISTORY = 60; // one reading per second

export function initCpuMeter(engine, el = document.getElementById('cpu')) {
  const value = el.querySelector('#cpu-value');
  const canvas = el.querySelector('#cpu-graph');
  const g = canvas.getContext('2d');
  const history = [];
  let smooth = null;
  let stale = null;

  function draw() {
    const { width: w, height: h } = canvas;
    g.clearRect(0, 0, w, h);
    const color = getComputedStyle(el).getPropertyValue('--cpu-color').trim() || '#9a9aa0';
    g.fillStyle = color;
    history.forEach((v, i) => {
      const bh = Math.max(1, Math.round(v * h));
      g.globalAlpha = 0.35 + 0.65 * ((i + 1) / history.length);
      g.fillRect(w - history.length + i, h - bh, 1, bh);
    });
    g.globalAlpha = 1;
  }

  function idle(reason) {
    smooth = null;
    value.textContent = '–';
    el.classList.remove('warn', 'hot');
    el.dataset.reason = reason;
    el.title = `DSP load: ${reason}`;
  }

  engine.onCpu = ({ load, q }) => {
    clearTimeout(stale);
    stale = setTimeout(() => idle('audio is suspended (click or press a key to start it)'), 2500);
    if (load == null) return idle('not measurable with this audio driver (one quantum per callback)');
    smooth = smooth == null ? load : smooth * 0.5 + load * 0.5;
    history.push(load);
    if (history.length > HISTORY) history.shift();
    const pct = Math.round(smooth * 100);
    value.textContent = `${pct}%`;
    el.classList.toggle('warn', smooth >= 0.7 && smooth < 0.9);
    el.classList.toggle('hot', smooth >= 0.9);
    const peak = Math.round(Math.max(...history) * 100);
    const ctx = engine.ctx;
    const latency = ((ctx.baseLatency || 0) * 1000).toFixed(1);
    el.title =
      `DSP load ${pct}% of the audio thread's real-time budget (peak ${peak}% in the last ${history.length}s).\n` +
      `Above ~90% you will hear crackles. ${ctx.sampleRate} Hz, ${Math.round(q)} blocks per callback, ${latency} ms buffer.\n` +
      `DSP: ${engine.dspInfo?.dsp === 'wasm' ? 'C++ (WebAssembly)' : 'JavaScript'}`;
    draw();
  };

  idle('audio is suspended (click or press a key to start it)');
}
