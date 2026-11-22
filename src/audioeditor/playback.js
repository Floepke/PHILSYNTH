import { AUDIO_PAGE_FRAMES } from './pagecache.js';
import { isAudio } from '../song.js';

const BLOCK = 128;
const LOOKAHEAD_SECONDS = 2;

export class AudioClipPlayback {
  constructor(graph, cache, rate) {
    this.graph = graph;
    this.cache = cache;
    this.rate = rate;
    this.sources = new Map();
    this.nextHandle = -1;
  }

  clear() {
    for (const { kernel } of this.sources.values()) {
      kernel.live = false;
      kernel.left.fill(0);
      kernel.right.fill(0);
    }
  }

  destroy() {
    for (const { handle } of this.sources.values()) this.graph.remove(handle);
    this.sources.clear();
  }

  source(target) {
    let source = this.sources.get(target);
    if (source && this.graph.nodes.has(source.handle) && this.graph.nodes.has(target)) return source.kernel;
    if (source) this.graph.remove(source.handle);
    while (this.graph.nodes.has(this.nextHandle)) this.nextHandle--;
    const handle = this.nextHandle--;
    const node = this.graph.add(handle, 'audioClip');
    this.graph.connect(handle, target);
    source = { handle, kernel: node.k };
    this.sources.set(target, source);
    return source.kernel;
  }

  bounds(transport) {
    const clip = transport.loopClip();
    const [start, songEnd] = transport.songBounds();
    const end = transport.continuous && !clip ? Infinity : clip ? clip.start + clip.length : songEnd;
    const restart = !clip && transport.getSong().restart;
    const back = clip ? clip.start : Number.isFinite(restart) && restart > start && restart < end ? restart : start;
    return { start: clip ? clip.start : start, end, back, looping: !!clip || back > start };
  }

  prefetch(transport, layers) {
    this.cache.beginPass?.();
    const { end, back, looping } = this.bounds(transport);
    const from = transport.pos;
    const until = from + LOOKAHEAD_SECONDS * transport.getBpm() / 60;
    const ranges = [[from, Math.min(end, until)]];
    if (looping && until >= end) ranges.push([back, Math.min(end, back + until - end)]);
    let ready = true;
    for (const { song, rt } of layers) for (const clip of song.clips) {
      if (!isAudio(clip) || !transport.audible(clip, song)) continue;
      const target = rt.modules.get(clip.target);
      const input = target?.def.hasInput ? target.inst.input?.h : null;
      if (input == null || !this.graph.nodes.has(input)) continue;
      for (const [lo, hi] of ranges) {
        const q = Math.max(lo, clip.start, clip.start - clip.audio.offset);
        const limit = Math.min(hi, clip.start + clip.length, clip.start + clip.audio.span - clip.audio.offset);
        if (q >= limit) continue;
        const frame = Math.floor((q - clip.start + clip.audio.offset) * clip.audio.frames / clip.audio.span);
        const first = Math.floor(frame / AUDIO_PAGE_FRAMES);
        const last = Math.floor((clip.audio.frames - 1) / AUDIO_PAGE_FRAMES);
        for (let page = first; page <= Math.min(last, first + 2); page++) {
          const present = this.cache.page(clip.audio, page) !== null;
          if (!present) ready = false;
        }
      }
    }
    return ready;
  }

  sample(audio, frame, channel) {
    const page = Math.floor(frame / AUDIO_PAGE_FRAMES);
    const base = this.cache.page(audio, page);
    if (base === null) throw new Error('Audio playback stopped because the disk reader could not keep up');
    return this.cache.samples[base + channel * AUDIO_PAGE_FRAMES + frame % AUDIO_PAGE_FRAMES];
  }

  render(transport, layers) {
    this.clear();
    if (!transport.playing) { this.destroy(); return; }
    const { end, back, looping } = this.bounds(transport);
    const increment = transport.getBpm() / (60 * this.rate);
    const wait = Math.max(0, -transport.elapsed);
    for (const { song, rt } of layers) for (const clip of song.clips) {
      if (!isAudio(clip) || !transport.audible(clip, song)) continue;
      const target = rt.modules.get(clip.target);
      const input = target?.def.hasInput ? target.inst.input?.h : null;
      if (input == null || !this.graph.nodes.has(input)) continue;
      let output = null;
      for (let i = 0; i < BLOCK; i++) {
        const delta = i * increment;
        if (delta < wait) continue;
        let q = transport.pos + delta - wait;
        if (transport.endAt !== null && q >= transport.endAt) continue;
        if (q >= end) {
          if (!looping || !(end > back)) continue;
          q = back + (q - end) % (end - back);
        }
        if (q < clip.start || q >= clip.start + clip.length) continue;
        const frame = (q - clip.start + clip.audio.offset) * clip.audio.frames / clip.audio.span;
        if (frame < 0 || frame >= clip.audio.frames) continue;
        const a = Math.floor(frame), b = Math.min(a + 1, clip.audio.frames - 1), mix = frame - a;
        const left = this.sample(clip.audio, a, 0), right = this.sample(clip.audio, a, 1);
        const nextLeft = this.sample(clip.audio, b, 0), nextRight = this.sample(clip.audio, b, 1);
        output ??= this.source(input);
        output.left[i] += left + (nextLeft - left) * mix;
        output.right[i] += right + (nextRight - right) * mix;
        output.live = true;
      }
    }
    for (const [target, source] of this.sources) if (!this.graph.nodes.has(target)) {
      this.graph.remove(source.handle);
      this.sources.delete(target);
    }
  }
}
