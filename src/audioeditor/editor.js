import { createSurface, capture, rulerDrag, clamp, snapBands } from '../seq/surface.js';
import { showMenu } from '../seq/menu.js';
import { beatLines, meter, snapStep } from '../song.js';
import { TIME_GRID, beatsShown, spacedBars } from '../seq/timegrid.js';
import { FONT, WEIGHT } from '../font.js';

const TOP_MARGIN = 128;
const GUTTER = 36;
const MIN_WIDTH = 80;
const MIN_ZOOM = 1;
const SAMPLE_SPACING = 16;

// audio(clip) -> { frames, rate, channels, revision, span, offset }; readPeaks returns one Float32Array
// of [min, max] pairs per channel. commitStroke interpolates the frame/value points and
// commits the edit to the clip's asset; neither callback needs to load the whole asset.
export function createAudioEditor(host, ctx) {
  const view = { sy: -TOP_MARGIN, pixelsPerSecond: 120 };
  let drawing = false;
  let drag = null;
  let busy = false;
  let request = 0;
  let key = '';
  let waveform = null;
  let lastClip = null;
  let pending = null;
  let zoomDrag = null;
  let audioKey = '';
  let rasterKey = '';
  let rasterWaveform = null;
  const raster = document.createElement('canvas');
  const rasterContext = raster.getContext('2d');
  const surface = createSurface(host, paint);
  const { cv } = surface;
  const info = () => {
    const clip = ctx.clip();
    const audio = clip && ctx.audio(clip);
    if (!audio || !Number.isInteger(audio.frames) || audio.frames < 1 ||
        !Number.isFinite(audio.rate) || audio.rate <= 0 || ![1, 2].includes(audio.channels)) return null;
    return { clip, ...audio };
  };
  const maxZoom = (audio = info()) => Math.max(4096, (audio?.rate ?? 0) * SAMPLE_SPACING);
  const margin = () => clamp(ctx.margin?.() ?? 0, GUTTER, Math.max(GUTTER, (surface.w - MIN_WIDTH) / 2));
  const bounds = (count, channel) => {
    const left = margin(), width = (surface.w - 2 * left) / count;
    return { left: left + channel * width, width };
  };
  const frameY = (frame, rate) => frame / rate * view.pixelsPerSecond - view.sy;
  const frameAt = (y, audio) => clamp(Math.round((y + view.sy) / view.pixelsPerSecond * audio.rate), 0, audio.frames - 1);
  const pointAt = (p, audio, channel) => {
    const b = bounds(audio.channels, channel);
    return { frame: frameAt(p.y, audio), value: clamp(2 * (p.x - b.left) / b.width - 1, -1, 1) };
  };
  const report = (error) => ctx.onError(error);
  const invalidate = () => { key = ''; waveform = null; rasterKey = ''; request++; surface.redraw(); };

  function load(audio, start, end) {
    if (waveform && waveform.zoom === view.pixelsPerSecond && waveform.start <= start && waveform.end >= end) return;
    const extra = Math.ceil(surface.h / view.pixelsPerSecond * audio.rate / 2);
    start = Math.max(0, start - extra);
    end = Math.min(audio.frames, end + extra);
    const bins = Math.max(1, Math.min(2048, end - start, Math.ceil((end - start) / audio.rate * view.pixelsPerSecond)));
    const next = `${audio.clip.id}:${audio.revision}:${audio.frames}:${audio.rate}:${audio.channels}:${start}:${end}:${bins}`;
    if (key === next) return;
    key = next;
    const zoom = view.pixelsPerSecond;
    const serial = ++request;
    Promise.resolve().then(() => ctx.readPeaks(audio.clip, start, end, bins)).then((peaks) => {
      if (serial !== request) return;
      if (!Array.isArray(peaks) || peaks.length !== audio.channels ||
          peaks.some((channel) => !(channel instanceof Float32Array) || channel.length !== bins * 2)) {
        throw new Error('Invalid audio waveform data');
      }
      waveform = { start, end, bins, peaks, zoom };
      surface.redraw();
    }).catch((error) => {
      if (serial === request) report(error);
    });
  }

  function paint(g, width, height) {
    g.fillStyle = '#5d5e6a';
    g.fillRect(0, 0, width, height);
    const audio = info();
    if (!audio) {
      zoomDrag?.({ type: 'pointercancel' });
      if (key) { key = ''; waveform = null; request++; lastClip = null; }
      return;
    }
    const nextAudioKey = `${audio.clip.id}:${audio.revision}:${audio.frames}:${audio.rate}:${audio.channels}`;
    if (audio.clip !== lastClip || audioKey !== nextAudioKey) {
      zoomDrag?.({ type: 'pointercancel' });
      lastClip = audio.clip;
      audioKey = nextAudioKey;
      key = '';
      waveform = null;
      request++;
    }
    const maxScroll = Math.max(-TOP_MARGIN, audio.frames / audio.rate * view.pixelsPerSecond - height);
    view.sy = clamp(view.sy, -TOP_MARGIN, maxScroll);
    const start = clamp(Math.floor(view.sy / view.pixelsPerSecond * audio.rate), 0, audio.frames);
    const end = clamp(Math.ceil((view.sy + height) / view.pixelsPerSecond * audio.rate), 0, audio.frames);
    if (end > start) load(audio, start, end);
    const nextRasterKey = `${nextAudioKey}:${width}:${height}:${surface.dpr}:${view.sy}:${view.pixelsPerSecond}:${margin()}:${ctx.color?.(audio.clip)}`;
    if (g.drawImage) {
      if (rasterKey !== nextRasterKey || rasterWaveform !== waveform) {
        raster.width = Math.max(1, Math.round(width * surface.dpr));
        raster.height = Math.max(1, Math.round(height * surface.dpr));
        rasterContext.setTransform(surface.dpr, 0, 0, surface.dpr, 0, 0);
        paintWaveform(rasterContext, audio, height);
        rasterKey = nextRasterKey;
        rasterWaveform = waveform;
      }
      g.drawImage(raster, 0, 0, width, height);
    } else paintWaveform(g, audio, height);
    const stroke = drag ?? pending;
    if (stroke?.clip === audio.clip) {
      const b = bounds(audio.channels, stroke.channel);
      g.strokeStyle = ctx.color?.(audio.clip) ?? '#eee';
      g.beginPath();
      for (let i = 0; i < stroke.points.length; i++) {
        const point = stroke.points[i];
        const x = b.left + (point.value + 1) * b.width / 2;
        const y = frameY(point.frame, audio.rate);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.lineWidth = 2;
      g.stroke();
    }
    paintRuler(g, audio, height);
  }

  function paintRuler(g, audio, height) {
    g.fillStyle = '#292b31';
    g.fillRect(0, 0, GUTTER, height);
    const song = ctx.song();
    const m = meter(song);
    const off = audio.clip.start - audio.offset;
    const ppq = audio.frames / audio.rate * view.pixelsPerSecond / audio.span;
    const yOf = q => (q - off) * ppq - view.sy;
    const from = Math.max(0, off, off + view.sy / ppq);
    const to = Math.min(off + audio.span, off + (height + view.sy) / ppq);
    g.save();
    g.beginPath();
    g.rect(0, 0, GUTTER, height);
    g.clip();
    if (to >= from) {
      g.fillStyle = TIME_GRID.band;
      snapBands(snapStep(song.snap), ppq, from, to, (a, b) => {
        const top = Math.max(yOf(a), yOf(from));
        g.fillRect(0, top, GUTTER, Math.min(yOf(b), yOf(to)) - top);
      });
      g.strokeStyle = TIME_GRID.color;
      g.lineWidth = 2;
      g.beginPath();
      if (beatsShown(m, ppq)) {
        for (const q of beatLines(null, from, to, m)) {
          const y = Math.round(yOf(q)) + 0.5;
          g.moveTo(GUTTER - 6, y); g.lineTo(GUTTER, y);
        }
      }
      g.stroke();
      g.textAlign = 'right';
      g.textBaseline = 'top';
      let lastY = -Infinity;
      for (const bar of spacedBars(m, off, from, to, ppq)) {
        const y = Math.round(yOf(bar.t)) + 0.5;
        g.beginPath(); g.moveTo(0, y); g.lineTo(GUTTER, y); g.stroke();
        const change = Math.abs(bar.t - bar.seg.at) < 1e-9;
        if (y - lastY < (change ? 24 : 13)) continue;
        lastY = y;
        g.fillStyle = '#c3c7d0';
        g.font = `${WEIGHT} 10px ${FONT}`;
        g.fillText(String(bar.bar + 1), GUTTER - 4, y + 2);
        if (change) {
          g.fillStyle = '#c4b5f2';
          g.font = `${WEIGHT} 9px ${FONT}`;
          g.fillText(`${bar.seg.num}/${bar.seg.den}`, GUTTER - 4, y + 13);
        }
      }
    }
    g.restore();
    g.strokeStyle = '#34363e';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(GUTTER, 0); g.lineTo(GUTTER, height); g.stroke();
  }

  function paintWaveform(g, audio, height) {
    g.strokeStyle = ctx.color?.(audio.clip) ?? '#eee';
    g.lineWidth = 1;
    for (let channel = 0; channel < audio.channels; channel++) {
      const b = bounds(audio.channels, channel);
      const middle = b.left + b.width / 2;
      if (!waveform) continue;
      if (waveform.bins === waveform.end - waveform.start) {
        g.beginPath();
        for (let i = 0; i < waveform.bins; i++) {
          const x = middle + clamp(waveform.peaks[channel][2 * i], -1, 1) * b.width / 2;
          const y = frameY(waveform.start + i, audio.rate);
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.stroke();
        if (view.pixelsPerSecond / audio.rate < 4) continue;
        g.fillStyle = g.strokeStyle;
        g.beginPath();
        for (let i = 0; i < waveform.bins; i++) {
          const x = middle + clamp(waveform.peaks[channel][2 * i], -1, 1) * b.width / 2;
          const y = frameY(waveform.start + i, audio.rate);
          g.moveTo(x + 2.5, y);
          g.arc(x, y, 2.5, 0, Math.PI * 2);
        }
        g.fill();
        continue;
      }
      g.beginPath();
      for (let i = 0; i < waveform.bins; i++) {
        const y = frameY(waveform.start + (i + 0.5) * (waveform.end - waveform.start) / waveform.bins, audio.rate);
        const min = clamp(waveform.peaks[channel][2 * i], -1, 1);
        const max = clamp(waveform.peaks[channel][2 * i + 1], -1, 1);
        g.moveTo(middle + min * b.width / 2, y);
        g.lineTo(middle + max * b.width / 2, y);
      }
      g.stroke();
    }
    g.strokeStyle = '#000';
    for (let channel = 0; channel < audio.channels; channel++) {
      const b = bounds(audio.channels, channel);
      for (const [x, lineWidth] of [[b.left, 1], [b.left + b.width / 2, 2], [b.left + b.width, 1]]) {
        g.lineWidth = lineWidth;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, height);
        g.stroke();
      }
    }
  }

  cv.addEventListener('pointerdown', (event) => {
    if (event.button === 2) {
      event.preventDefault();
      (ctx.menu ?? showMenu)({
        x: event.clientX, y: event.clientY,
        items: [{ label: 'Drawing mode', checked: drawing, action: () => { drawing = !drawing; surface.redraw(); } }],
      });
      return;
    }
    const audio = info();
    if (event.button !== 0 || !audio || zoomDrag) return;
    const p = surface.local(event);
    if (p.x >= 0 && p.x < GUTTER) {
      event.preventDefault();
      cv.focus();
      const { sy, pixelsPerSecond } = view;
      const seconds = (sy + p.y) / pixelsPerSecond;
      zoomDrag = rulerDrag(cv, event, (_dx, dy) => {
        view.pixelsPerSecond = clamp(pixelsPerSecond * Math.pow(1.15, -dy / 48), MIN_ZOOM, maxZoom(audio));
        view.sy = seconds * view.pixelsPerSecond - p.y;
        surface.redraw();
      }, (ev) => {
        if (ev.type === 'pointercancel') Object.assign(view, { sy, pixelsPerSecond });
        zoomDrag = null;
        surface.redraw();
        if (ev.type !== 'pointercancel' && (sy !== view.sy || pixelsPerSecond !== view.pixelsPerSecond)) ctx.viewChanged?.();
      });
      return;
    }
    if (!drawing || busy || drag) return;
    const left = margin(), right = surface.w - left;
    if (p.x < left || p.x >= right || p.y < frameY(0, audio.rate) || p.y >= frameY(audio.frames, audio.rate)) return;
    const channel = Math.min(audio.channels - 1, Math.floor((p.x - left) / (right - left) * audio.channels));
    const points = [pointAt(p, audio, channel)];
    drag = { clip: audio.clip, channel, points };
    surface.redraw();
    event.preventDefault();
    cv.focus();
    capture(cv, event, (e) => {
      if (ctx.clip() === audio.clip) {
        points.push(pointAt(surface.local(e), audio, channel));
        surface.redraw();
      }
    }, (e) => {
      drag = null;
      if (e.type !== 'pointerup' || ctx.clip() !== audio.clip) { surface.redraw(); return; }
      points.push(pointAt(surface.local(e), audio, channel));
      pending = { clip: audio.clip, channel, points };
      busy = true;
      Promise.resolve().then(() => ctx.commitStroke(audio.clip, channel, points)).then(invalidate, report).finally(() => {
        busy = false;
        pending = null;
        surface.redraw();
      });
    });
  });
  cv.addEventListener('wheel', (event) => {
    const audio = info();
    if (!audio) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const y = surface.local(event).y;
      const seconds = (view.sy + y) / view.pixelsPerSecond;
      view.pixelsPerSecond = clamp(view.pixelsPerSecond * Math.exp(-event.deltaY * 0.002), MIN_ZOOM, maxZoom(audio));
      view.sy = seconds * view.pixelsPerSecond - y;
    } else view.sy += event.deltaY;
    surface.redraw();
    ctx.viewChanged?.();
  }, { passive: false });

  return {
    surface,
    redraw: () => surface.redraw(),
    invalidate,
    getView: () => ({ ...view }),
    setView(next) {
      if (Number.isFinite(next?.sy)) view.sy = next.sy;
      if (Number.isFinite(next?.pixelsPerSecond)) view.pixelsPerSecond = clamp(next.pixelsPerSecond, MIN_ZOOM, maxZoom());
      surface.redraw();
    },
    getPointerTime: () => null,
  };
}
