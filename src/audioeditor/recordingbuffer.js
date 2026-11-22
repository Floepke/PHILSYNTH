// Single-producer/single-consumer queue. Only the producer writes or stops it;
// the audio thread never waits for the writer.
const READ = 0, WRITE = 1, STATE = 2, SIGNAL = 3, HEADER = 5;
export const RECORDING_ACTIVE = 0;
export const RECORDING_STOPPED = 1;
export const RECORDING_OVERRUN = 2;
export const RECORDING_TEMPO_CHANGED = 3;

export function createRecordingBuffer(capacity, channels) {
  if (!Number.isInteger(capacity) || capacity < 2 || ![1, 2].includes(channels)) throw new Error('Invalid recording buffer size');
  if (typeof SharedArrayBuffer !== 'function') throw new Error('Shared recording buffers are not available');
  return { capacity, channels, sab: new SharedArrayBuffer((HEADER + capacity * channels) * 4) };
}

export class RecordingBuffer {
  constructor({ sab, capacity, channels }) {
    if (!(sab instanceof SharedArrayBuffer) || !Number.isInteger(capacity) || capacity < 2 ||
        ![1, 2].includes(channels) || sab.byteLength !== (HEADER + capacity * channels) * 4) {
      throw new Error('Invalid recording buffer');
    }
    this.capacity = capacity;
    this.channels = channels;
    this.control = new Int32Array(sab, 0, HEADER);
    this.tempoValue = new Float32Array(sab, 16, 1);
    this.data = Array.from({ length: channels }, (_, ch) => new Float32Array(sab, (HEADER + ch * capacity) * 4, capacity));
  }

  get state() { return Atomics.load(this.control, STATE); }
  get signal() { return Atomics.load(this.control, SIGNAL); }
  get tempo() { return this.tempoValue[0]; }
  set tempo(value) { this.tempoValue[0] = value; }
  wake() {
    Atomics.add(this.control, SIGNAL, 1);
    Atomics.notify(this.control, SIGNAL);
  }

  write(input) {
    if (!Array.isArray(input) || input.length !== this.channels) throw new Error('Invalid recording buffer input');
    for (let channel = 0; channel < this.channels; channel++) {
      if (!(input[channel] instanceof Float32Array) || input[channel].length !== input[0].length) throw new Error('Invalid recording buffer input');
    }
    if (this.state !== RECORDING_ACTIVE) return false;
    const read = Atomics.load(this.control, READ), write = Atomics.load(this.control, WRITE);
    const available = (read - write - 1 + this.capacity) % this.capacity;
    const length = input[0].length;
    if (length > available) {
      Atomics.compareExchange(this.control, STATE, RECORDING_ACTIVE, RECORDING_OVERRUN);
      this.wake();
      return false;
    }
    const first = Math.min(length, this.capacity - write);
    for (let channel = 0; channel < this.channels; channel++) {
      const source = input[channel], target = this.data[channel];
      for (let i = 0; i < first; i++) target[write + i] = source[i];
      for (let i = first; i < length; i++) target[i - first] = source[i];
    }
    Atomics.store(this.control, WRITE, (write + length) % this.capacity);
    this.wake();
    return true;
  }

  // Copies into reusable consumer buffers; the result is the number of frames copied.
  read(output) {
    if (!Array.isArray(output) || output.length !== this.channels ||
        output.some((channel) => !(channel instanceof Float32Array) || channel.length !== output[0].length)) {
      throw new Error('Invalid recording buffer output');
    }
    const read = Atomics.load(this.control, READ), write = Atomics.load(this.control, WRITE);
    const length = Math.min(output[0].length, (write - read + this.capacity) % this.capacity);
    const first = Math.min(length, this.capacity - read);
    for (let channel = 0; channel < this.channels; channel++) {
      output[channel].set(this.data[channel].subarray(read, read + first), 0);
      output[channel].set(this.data[channel].subarray(0, length - first), first);
    }
    Atomics.store(this.control, READ, (read + length) % this.capacity);
    return length;
  }

  stop() {
    Atomics.compareExchange(this.control, STATE, RECORDING_ACTIVE, RECORDING_STOPPED);
    this.wake();
  }

  stopForTempoChange() {
    Atomics.compareExchange(this.control, STATE, RECORDING_ACTIVE, RECORDING_TEMPO_CHANGED);
    this.wake();
  }

  // Only call on the writer worker after taking a signal snapshot and checking the queue/state.
  wait(signal, timeout) { return Atomics.wait(this.control, SIGNAL, signal, timeout); }
}
