export const RENDER_BLOCK = 128;
const HEADER = 8;

export function createRenderQueue(sampleRate, latencyMs = 20, inputCount = 4) {
  const delay = Math.max(2, Math.ceil(sampleRate * latencyMs / 1000 / RENDER_BLOCK));
  const slots = delay + 32;
  const channels = inputCount * 2 + 2;
  const sab = new SharedArrayBuffer((HEADER + slots * 2) * 4 + slots * channels * RENDER_BLOCK * 4);
  return { sab, slots, delay, inputCount };
}

export class RenderQueue {
  constructor({ sab, slots, delay, inputCount }) {
    this.slots = slots;
    this.delay = delay;
    this.inputCount = inputCount;
    this.ctrl = new Int32Array(sab, 0, HEADER);
    this.inputStamp = new Int32Array(sab, HEADER * 4, slots);
    this.outputStamp = new Int32Array(sab, (HEADER + slots) * 4, slots);
    const audioOffset = (HEADER + slots * 2) * 4;
    this.audio = Array.from({ length: slots }, (_, slot) => Array.from({ length: inputCount * 2 + 2 }, (_, channel) =>
      new Float32Array(sab, audioOffset + (slot * (inputCount * 2 + 2) + channel) * RENDER_BLOCK * 4, RENDER_BLOCK)));
    this.inputs = Array.from({ length: inputCount }, () => [new Float32Array(RENDER_BLOCK), new Float32Array(RENDER_BLOCK)]);
  }

  capture(block, inputs) {
    const slot = (block - 1) % this.slots;
    Atomics.store(this.inputStamp, slot, 0);
    for (let input = 0; input < this.inputCount; input++) for (let channel = 0; channel < 2; channel++) {
      const buffer = this.audio[slot][input * 2 + channel];
      const source = inputs[input]?.[channel] ?? inputs[input]?.[0];
      if (source) buffer.set(source);
      else buffer.fill(0);
    }
    Atomics.store(this.inputStamp, slot, block);
    Atomics.store(this.ctrl, 0, block);
    Atomics.notify(this.ctrl, 0);
  }

  readInput(block) {
    const slot = (block - 1) % this.slots;
    if (Atomics.load(this.inputStamp, slot) !== block) return false;
    for (let input = 0; input < this.inputCount; input++) for (let channel = 0; channel < 2; channel++) {
      this.inputs[input][channel].set(this.audio[slot][input * 2 + channel]);
    }
    return Atomics.load(this.inputStamp, slot) === block;
  }

  publish(block, outputs) {
    const slot = (block - 1) % this.slots;
    Atomics.store(this.outputStamp, slot, 0);
    this.audio[slot][this.inputCount * 2].set(outputs[0]);
    this.audio[slot][this.inputCount * 2 + 1].set(outputs[1]);
    Atomics.store(this.outputStamp, slot, block);
  }

  consume(block, outputs) {
    const wanted = block - this.delay;
    for (const output of outputs) output.fill(0);
    if (wanted <= Atomics.load(this.ctrl, 6)) return false;
    const slot = (wanted - 1) % this.slots;
    if (Atomics.load(this.outputStamp, slot) !== wanted) {
      Atomics.add(this.ctrl, 1, 1);
      return false;
    }
    outputs[0].set(this.audio[slot][this.inputCount * 2]);
    if (outputs[1]) outputs[1].set(this.audio[slot][this.inputCount * 2 + 1]);
    return true;
  }

  flush() {
    Atomics.store(this.ctrl, 6, Atomics.load(this.ctrl, 0));
  }
}