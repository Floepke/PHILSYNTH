import { renderSong, encodeWav } from './render.js';
import { importSamples } from './samples.js';

self.onmessage = async ({ data: { project, sampleRate, wasm } }) => {
  try {
    importSamples(project.samples);
    const out = await renderSong(project, {
      sampleRate, wasm,
      onProgress: (fraction) => self.postMessage({ type: 'progress', fraction }),
    });
    self.postMessage({ type: 'encoding' });
    const wav = encodeWav(out.left, out.right, sampleRate);
    self.postMessage({ type: 'complete', wav, seconds: out.seconds, peak: out.peak }, [wav]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
