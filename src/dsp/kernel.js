// Base class of a DSP kernel: the audio-thread half of a module, run by the engine graph
// (src/dsp/graph.js) inside the single engine AudioWorklet (src/engine.worklet.js).
//
//   constructor(opts)        opts from DspHost.create(kind, opts) (e.g. { salt })
//   param(id, value)         controller change (from the panel, automation or modulation)
//   message(m)               any other message from the main-thread module (notes, curves, ...)
//   process(inputs, outputs) one render quantum, Web Audio shapes: inputs[0] = [L, R] or [] when
//                            nothing is connected, outputs[0] = [L, R]. Return false when the
//                            output is silent (the graph then skips it as a source).
//   value                    modulators (static modulator = true): 0..1, or null for "no value";
//                            the graph maps it onto the controllers their cables point to.
// Static flags: modulator (no audio, runs first every block), audio = false (never rendered),
// passive (memoryless: skipped while all of its inputs are silent).
// audioInput + modulator: runs in audio dependency order; value controls the next quantum.
// carrierInput: inputs[0] is the source selected by the kernel's `carrier` index; inputs[1]
// is the sum of all other sources. Silent sources keep their positions in the input list.
// Kernels use the AudioWorkletGlobalScope global `sampleRate`.
export class Kernel {
  param() {}

  message(m) {
    if (m.type === 'param') this.param(m.id, m.value);
  }

  process() {
    return false;
  }
}

// Signal bus: output = sum of the inputs. Used for patch inputs/outputs and the master output.
export class BusKernel extends Kernel {
  static passive = true;

  process(inputs, outputs) {
    const i = inputs[0];
    const o = outputs[0];
    if (!i || !i.length) return false;
    o[0].set(i[0]);
    o[1].set(i[1] ?? i[0]);
    return true;
  }
}

// No DSP at all: gives modules without audio (MULTIMIDI, ...) a node that controllers can be
// modulated on (the value is reported back to the main thread).
export class NoneKernel extends Kernel {
  static audio = false;
}
