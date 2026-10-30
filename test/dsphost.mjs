// Test double of the audio side: a DspHost whose messages go synchronously into a real engine
// Graph (src/dsp/graph.js), so module code, kernels and modulation all run in node.
//   const { dsp, graph, render, kernel } = dspTestHost();   dspTestHost({ kernels, heap }): Graph options
//   render(blocks)   renders render quanta and delivers the graph's reports (modulation, clock)
//   kernel(node)     the kernel behind a DspNode (node.h)
globalThis.sampleRate ??= 48000;

const { Graph } = await import('../src/dsp/graph.js');
const { DspHost } = await import('../src/dsp/host.js');

export function dspTestHost(opts) {
  const graph = new Graph(opts);
  let time = 0;
  const port = {
    onmessage: null,
    postMessage: (batch) => graph.handle(batch),
  };
  const dsp = new DspHost(port, { sync: true });
  const L = new Float32Array(128);
  const R = new Float32Array(128);
  const render = (blocks = 1) => {
    for (let i = 0; i < blocks; i++) {
      graph.render(L, R);
      time += 128 / sampleRate;
      const r = graph.report(time);
      if (r) dsp.receive(r);
    }
    return { L, R };
  };
  const kernel = (node) => graph.nodes.get(node.h)?.k;
  return { dsp, graph, render, kernel, get time() { return time; } };
}
