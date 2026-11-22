import { createSurface, capture, clamp } from '../seq/surface.js';
import { showMenu } from '../seq/menu.js';

const TOP_MARGIN = 128;
const MIN_WIDTH = 80;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4096;

// audio(clip) -> { frames, rate, channels, revision }; readPeaks returns one Float32Array
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
  const surface = createSurface(host, paint);
  const { cv } = surface;
  const info = () => {
    const clip = ctx.clip();
    const audio = clip && ctx.audio(clip);
    if (!audio || !Number.isInteger(audio.frames) || audio.frames < 1 ||
        !Number.isFinite(audio.rate) || audio.rate <= 0 || ![1, 2].includes(audio.channels)) return null;
    return { clip, ...audio };
  };
  const margin = () => clamp(ctx.margin?.() ?? 0, 0, Math.max(0, (surface.w - MIN_WIDTH) / 2));
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
  const invalidate = () => { key = ''; waveform = null; request++; surface.redraw(); };

  function load(audio, start, end, bins) {
    const next = `${audio.clip.id}:${audio.revision}:${audio.frames}:${audio.rate}:${audio.channels}:${start}:${end}:${bins}`;
    if (key === next) return;
    key = next;
    waveform = null;
    const serial = ++request;
    Promise.resolve().then(() => ctx.readPeaks(audio.clip, start, end, bins)).then((peaks) => {
      if (serial !== request) return;
      if (!Array.isArray(peaks) || peaks.length !== audio.channels ||
          peaks.some((channel) => !(channel instanceof Float32Array) || channel.length !== bins * 2)) {
        throw new Error('Invalid audio waveform data');
      }
      waveform = { start, end, bins, peaks };
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
      if (key) { key = ''; waveform = null; request++; lastClip = null; }
      return;
    }
    if (audio.clip !== lastClip) {
      lastClip = audio.clip;
      key = '';
      waveform = null;
      request++;
    }
    const maxScroll = Math.max(-TOP_MARGIN, audio.frames / audio.rate * view.pixelsPerSecond - height);
    view.sy = clamp(view.sy, -TOP_MARGIN, maxScroll);
    const start = clamp(Math.floor(view.sy / view.pixelsPerSecond * audio.rate), 0, audio.frames);
    const end = clamp(Math.ceil((view.sy + height) / view.pixelsPerSecond * audio.rate), 0, audio.frames);
    if (end <= start) return;
    const bins = Math.max(1, Math.min(2048, Math.ceil(frameY(end, audio.rate) - frameY(start, audio.rate))));
    load(audio, start, end, bins);
    g.strokeStyle = ctx.color?.(audio.clip) ?? '#eee';
    g.lineWidth = 1;
    for (let channel = 0; channel < audio.channels; channel++) {
      const b = bounds(audio.channels, channel);
      const middle = b.left + b.width / 2;
      g.beginPath();
      g.moveTo(middle, Math.max(0, frameY(0, audio.rate)));
      g.lineTo(middle, Math.min(height, frameY(audio.frames, audio.rate)));
      g.stroke();
      if (!waveform) continue;
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
    const stroke = drag ?? pending;
    if (stroke?.clip === audio.clip) {
      const b = bounds(audio.channels, stroke.channel);
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
    if (event.button !== 0 || !drawing || !audio || busy || drag) return;
    const p = surface.local(event);
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
      view.pixelsPerSecond = clamp(view.pixelsPerSecond * Math.exp(-event.deltaY * 0.002), MIN_ZOOM, MAX_ZOOM);
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
      if (Number.isFinite(next?.pixelsPerSecond)) view.pixelsPerSecond = clamp(next.pixelsPerSecond, MIN_ZOOM, MAX_ZOOM);
      surface.redraw();
    },
    getPointerTime: () => null,
  };
}
