// The audio thread owns page allocation; the disk worker only publishes finished pages.
export const AUDIO_PAGE_FRAMES = 8192;
export const AUDIO_CACHE_PAGES = 256;
const META = AUDIO_CACHE_PAGES;
const PAGE_SAMPLES = AUDIO_PAGE_FRAMES * 2;

export function createAudioPageMemory() {
  if (typeof SharedArrayBuffer !== 'function') throw new Error('Audio playback requires shared memory');
  return new SharedArrayBuffer((META + AUDIO_CACHE_PAGES * PAGE_SAMPLES) * 4);
}

export class AudioPageCache {
  constructor(memory, port) {
    if (!(memory instanceof SharedArrayBuffer) || memory.byteLength !== (META + AUDIO_CACHE_PAGES * PAGE_SAMPLES) * 4) {
      throw new Error('Invalid audio playback cache');
    }
    this.states = new Int32Array(memory, 0, META);
    this.samples = new Float32Array(memory, META * 4);
    this.port = port;
    this.pages = new Map();
    this.slots = Array(AUDIO_CACHE_PAGES).fill(null);
    this.sequence = 0;
    this.clock = 0;
    this.pass = 0;
    this.error = null;
    port.onmessage = ({ data }) => {
      const entry = this.slots[data.slot];
      if (!entry || entry.sequence !== data.sequence) return;
      if (data.error) {
        entry.error = new Error(data.error);
        this.error = entry.error;
        for (const waiter of entry.waiters) waiter.reject(entry.error);
      } else {
        for (const waiter of entry.waiters) waiter.resolve();
      }
      entry.waiters.length = 0;
    };
    port.start?.();
  }

  beginPass() { this.pass++; }

  clearError() {
    this.error = null;
    for (let i = 0; i < this.slots.length; i++) {
      const entry = this.slots[i];
      if (!entry?.error) continue;
      this.pages.delete(entry.key);
      this.slots[i] = null;
      Atomics.store(this.states, i, 0);
    }
  }

  fail(error) {
    this.error = error instanceof Error ? error : new Error(String(error));
    for (const entry of this.slots) {
      if (!entry || Atomics.load(this.states, entry.slot) !== 1) continue;
      entry.error = this.error;
      for (const waiter of entry.waiters) waiter.reject(this.error);
      entry.waiters.length = 0;
    }
  }

  waitPending() {
    if (this.error) return Promise.reject(this.error);
    return Promise.all(this.slots.filter((entry) => entry && Atomics.load(this.states, entry.slot) === 1)
      .map((entry) => new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }))));
  }

  request(audio, page) {
    if (!Number.isInteger(page) || page < 0) throw new Error('Invalid audio page');
    if (this.error) throw this.error;
    const key = `${audio.id}:${page}`;
    let entry = this.pages.get(key);
    if (entry) {
      entry.used = ++this.clock;
      entry.pass = this.pass;
      return entry;
    }
    let slot = -1, oldest = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const candidate = this.slots[i];
      if (!candidate) { slot = i; break; }
      if (Atomics.load(this.states, i) === 2 && !candidate.waiters.length &&
          (!this.pass || candidate.pass !== this.pass) && candidate.used < oldest) {
        oldest = candidate.used;
        slot = i;
      }
    }
    if (slot < 0) throw new Error('Audio playback cache is saturated');
    if (this.slots[slot]) this.pages.delete(this.slots[slot].key);
    Atomics.store(this.states, slot, 1);
    entry = { key, slot, sequence: ++this.sequence, used: ++this.clock, pass: this.pass, waiters: [], error: null };
    this.slots[slot] = entry;
    this.pages.set(key, entry);
    this.port.postMessage({ type: 'page', audio, page, slot, sequence: entry.sequence });
    return entry;
  }

  ready(audio, page) {
    const entry = this.request(audio, page);
    if (Atomics.load(this.states, entry.slot) === 2) return Promise.resolve();
    return new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }));
  }

  page(audio, page) {
    const entry = this.request(audio, page);
    if (Atomics.load(this.states, entry.slot) !== 2) return null;
    return entry.slot * PAGE_SAMPLES;
  }
}

export async function fillAudioPage(memory, { file, channels, frames }, page, slot) {
  if (!(file instanceof Blob) || ![1, 2].includes(channels) || !Number.isInteger(frames) || frames < 1 ||
      !Number.isInteger(page) || page < 0 || !Number.isInteger(slot) || slot < 0 || slot >= AUDIO_CACHE_PAGES) {
    throw new Error('Invalid audio playback page');
  }
  const first = page * AUDIO_PAGE_FRAMES;
  if (first >= frames) throw new Error('Audio page is outside the recording');
  const count = Math.min(AUDIO_PAGE_FRAMES, frames - first);
  const bytes = new Uint8Array(await file.slice(44 + first * channels * 3, 44 + (first + count) * channels * 3).arrayBuffer());
  if (bytes.length !== count * channels * 3) throw new Error('Recording is truncated');
  const samples = new Float32Array(memory, META * 4 + slot * PAGE_SAMPLES * 4, PAGE_SAMPLES);
  samples.fill(0);
  for (let i = 0; i < count; i++) for (let ch = 0; ch < channels; ch++) {
    const at = (i * channels + ch) * 3;
    const value = bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16;
    samples[ch * AUDIO_PAGE_FRAMES + i] = (value & 0x800000 ? value - 0x1000000 : value) / 0x800000;
  }
  if (channels === 1) samples.copyWithin(AUDIO_PAGE_FRAMES, 0, AUDIO_PAGE_FRAMES);
  Atomics.store(new Int32Array(memory, 0, META), slot, 2);
}
