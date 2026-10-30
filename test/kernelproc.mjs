// Loads a DSP kernel (src/modules/*.dsp.js) and gives it the shape the kernel tests use: the
// kernel itself plus port.onmessage({ data }) / port.postMessage(value). Modulator kernels post
// their value every 2 render quanta, like the engine graph reports them.
export async function loadKernel(file, sr = 48000) {
  globalThis.sampleRate = sr;
  const K = (await import(new URL(`../src/modules/${file}`, import.meta.url))).default;
  return class Proc {
    static Kernel = K;

    constructor(opts) {
      const k = new K(opts);
      const process = k.process.bind(k);
      let blocks = 0;
      k.port = { onmessage: ({ data }) => k.message(data), postMessage() {} };
      k.process = (inputs, outputs) => {
        const r = process(inputs, outputs);
        if (K.modulator && ++blocks >= 2) {
          blocks = 0;
          k.port.postMessage(k.value);
        }
        return r;
      };
      return k;
    }
  };
}
