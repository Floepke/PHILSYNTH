import assert from 'node:assert/strict';
import { noiseUniforms, NOISE } from '../src/noisebg.js';

// the shader works in world units: the top-left pixel is the world point under the screen origin,
// one device pixel covers 1 / (zoom × dpr) world units
assert.deepEqual(noiseUniforms({ x: 0, y: 0, z: 1 }), { origin: [-0, -0], step: 1 });
assert.deepEqual(noiseUniforms({ x: 100, y: -50, z: 2 }, 2), { origin: [-50, 25], step: 0.25 });
// panning by d screen px moves the origin by d / z world px (the noise moves with the modules)
const a = noiseUniforms({ x: 10, y: 10, z: 0.5 }), b = noiseUniforms({ x: 30, y: 10, z: 0.5 });
assert.equal(a.origin[0] - b.origin[0], 40);
// blackish: the brightest spot stays dark
assert.ok(Math.max(...NOISE.base) + NOISE.depth < 0.08);
{
  const { perlin, noiseAt } = await import('../src/noisebg.js');
  assert.ok(Math.abs(perlin(3, 7)) < 1e-12, 'Perlin noise is 0 on the lattice');
  let lo = 1, hi = 0;
  const t = performance.now();
  for (let i = 0; i < 100000; i++) { const v = noiseAt(i * 3.7, i * 1.3, 4); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(lo >= 0 && hi <= 1 && hi - lo > 0.4, `varied but bounded (${lo}..${hi})`);
  console.log(`  CPU fallback: 100k samples in ${Math.round(performance.now() - t)} ms`);
  // continuity: neighbouring pixels differ only a little (no hard edges)
  assert.ok(Math.abs(noiseAt(1000, 500, 1) - noiseAt(1001, 500, 1)) < 0.05);
}
console.log('noisebg tests passed');
