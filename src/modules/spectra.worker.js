import { generateSpectraSample } from './spectra.sample.js';

self.onmessage = ({ data }) => {
  const { revision, mode, rate, levels, detunes, phases } = data;
  const sample = generateSpectraSample(rate, levels, detunes, phases);
  self.postMessage({ revision, mode, sample }, [sample.buffer]);
};
