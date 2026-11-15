import { RenderQueue, RENDER_BLOCK } from './renderqueue.js';

self.onmessage = async e => {
  self.onmessage = null;
  const { queue: settings, port, wasm, sampleRate } = e.data;
  globalThis.sampleRate = sampleRate;
  globalThis.modsynthBlockingWait = true;
  try {
    const [{ EngineRenderer }, pool] = await Promise.all([
      import('./enginerenderer.js'), import('./instancepool.js'),
    ]);
    const queue = new RenderQueue(settings);
    const renderer = new EngineRenderer(port, { wasm });
    renderer.onReset = () => queue.flush();
    const outputs = [new Float32Array(RENDER_BLOCK), new Float32Array(RENDER_BLOCK)];
    let block = 0;
    self.postMessage({ ready: true });
    while (!Atomics.load(queue.ctrl, 3)) {
      await renderer.controlQueue;
      if (block >= Atomics.load(queue.ctrl, 0)) Atomics.wait(queue.ctrl, 0, block, 20);
      else {
        if (!queue.readInput(++block)) {
          for (const input of queue.inputs) for (const channel of input) channel.fill(0);
          Atomics.add(queue.ctrl, 2, 1);
        }
        const time = (Atomics.load(queue.ctrl, 4) + (block - 1) * RENDER_BLOCK) / sampleRate;
        renderer.process(queue.inputs, [outputs], time);
        queue.publish(block, outputs);
        Atomics.store(queue.ctrl, 5, block);
      }
      if (!(block % 4) || block >= Atomics.load(queue.ctrl, 0)) await pool.yieldOnce();
    }
  } catch (error) { self.postMessage({ error: String(error?.stack ?? error) }); }
};