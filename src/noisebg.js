// Patcher background: a faint Perlin-style noise in the black, drawn by a WebGL fragment shader in
// world coordinates, so it is endless (never repeats), scales with the zoom and moves when panning.
// It is only redrawn when the camera or the canvas size changes, and the GPU does the work.
// Without WebGL the same noise is computed on the CPU at 1/4 resolution (it is smooth, so the
// browser's smooth upscaling hides that) and drawn on a 2D canvas.

export const NOISE = {
  base: [0.02, 0.02, 0.022], // the black (≈ --bg)
  depth: 0.03, // how much lighter the brightest spots get
  scale: 420, // world px per noise cell of the first octave
};

const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
uniform vec2 uOrigin;   // world point at the top-left device pixel
uniform float uStep;    // world units per device pixel
uniform float uH;       // canvas height in device pixels (gl_FragCoord is bottom-up)
uniform vec3 uBase;
uniform float uDepth;
uniform float uScale;
// sin-free hash (Dave Hoskins): sin() of large arguments loses precision on some GPU drivers
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 grad(vec2 i) {
  float a = hash12(mod(i, 4096.0)) * 6.2831853;
  return vec2(cos(a), sin(a));
}
float perlin(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad(i), f);
  float b = dot(grad(i + vec2(1, 0)), f - vec2(1, 0));
  float c = dot(grad(i + vec2(0, 1)), f - vec2(0, 1));
  float d = dot(grad(i + vec2(1, 1)), f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
void main() {
  vec2 w = uOrigin + vec2(gl_FragCoord.x, uH - gl_FragCoord.y) * uStep;
  vec2 q = w / uScale;
  float n = 0.0, amp = 0.5, norm = 0.0;
  for (int o = 0; o < 5; o++) {
    // octaves finer than about two screen pixels only flicker: fade them out when zoomed out
    float cell = uScale / exp2(float(o)) / uStep;
    float k = clamp((cell - 2.0) / 6.0, 0.0, 1.0);
    n += perlin(q) * amp * k;
    norm += amp;
    amp *= 0.5;
    q = q * 2.0 + vec2(17.3, 9.1);
  }
  n = clamp(n / norm * 1.6 + 0.5, 0.0, 1.0);
  // ±1 level of dither: the whole range is only about 10 grey levels, without it gradients band
  float dither = (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  if (!(n >= 0.0 && n <= 1.0)) n = 0.5; // NaN guard: never punch black holes
  gl_FragColor = vec4(uBase + uDepth * n * n + dither, 1.0);
}`;

// shader inputs for camera {x, y, z} at device pixel ratio `dpr`
export function noiseUniforms({ x, y, z }, dpr = 1) {
  return { origin: [-x / z, -y / z], step: 1 / (z * dpr) };
}

// CPU twin of the shader for the 2D fallback: classic Perlin with a permutation table (fast; its
// pattern differs from the shader's hash but looks the same)
const PERM = new Uint8Array(512), GX = new Float32Array(256), GY = new Float32Array(256);
{
  let seed = 1234567;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  for (let i = 0; i < 256; i++) { const a = rnd() * 2 * Math.PI; GX[i] = Math.cos(a); GY[i] = Math.sin(a); }
}
export function perlin(x, y) {
  const fx0 = Math.floor(x), fy0 = Math.floor(y);
  const fx = x - fx0, fy = y - fy0;
  const ix = fx0 & 255, iy = fy0 & 255;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const h00 = PERM[PERM[ix] + iy], h10 = PERM[PERM[ix + 1] + iy];
  const h01 = PERM[PERM[ix] + iy + 1], h11 = PERM[PERM[ix + 1] + iy + 1];
  const a = GX[h00] * fx + GY[h00] * fy, b = GX[h10] * (fx - 1) + GY[h10] * fy;
  const c = GX[h01] * fx + GY[h01] * (fy - 1), d = GX[h11] * (fx - 1) + GY[h11] * (fy - 1);
  const ab = a + (b - a) * ux, cd = c + (d - c) * ux;
  return ab + (cd - ab) * uy;
}
// brightness 0..1 of world point (wx, wy) seen at `step` world units per pixel
export function noiseAt(wx, wy, step) {
  let qx = wx / NOISE.scale, qy = wy / NOISE.scale, n = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < 5; o++) {
    const cell = NOISE.scale / 2 ** o / step;
    const k = Math.min(1, Math.max(0, (cell - 2) / 6));
    if (k > 0) n += perlin(qx, qy) * amp * k;
    norm += amp;
    amp *= 0.5;
    qx = qx * 2 + 17.3;
    qy = qy * 2 + 9.1;
  }
  return Math.min(1, Math.max(0, (n / norm) * 1.6 + 0.5));
}

function cpuBackground(host, cv) {
  const ctx = cv.getContext('2d');
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d');
  const DOWN = 4;
  // dither tile (0..2 grey levels, added): breaks the banding of the few grey levels in use
  const dither = document.createElement('canvas');
  dither.width = dither.height = 128;
  {
    const d = dither.getContext('2d'), img = d.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.floor(Math.random() * 3);
      img.data[i + 3] = 255;
    }
    d.putImageData(img, 0, 0);
  }
  let pattern = null;
  let cam = { x: 0, y: 0, z: 1 };
  const render = () => {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    const sw = Math.ceil(w / DOWN) + 1, sh = Math.ceil(h / DOWN) + 1;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
    const img = sctx.createImageData(sw, sh), px = img.data;
    const { origin: [ox, oy], step } = noiseUniforms(cam, 1);
    const st = step * DOWN;
    for (let y = 0, i = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++, i += 4) {
        const n = noiseAt(ox + x * st, oy + y * st, st);
        const l = NOISE.depth * n * n;
        px[i] = (NOISE.base[0] + l) * 255 - 1; // the dither adds 1 on average
        px[i + 1] = (NOISE.base[1] + l) * 255 - 1;
        px[i + 2] = (NOISE.base[2] + l) * 255 - 1;
        px[i + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, sw * DOWN, sh * DOWN);
    pattern ??= ctx.createPattern(dither, 'repeat');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  };
  new ResizeObserver(render).observe(host);
  return { draw(c) { cam = c; render(); } };
}

// Creates the background canvas as the first child of `host`; returns { draw(cam) }.
export function createNoiseBackground(host) {
  const cv = document.createElement('canvas');
  cv.className = 'noise-bg';
  cv.setAttribute('aria-hidden', 'true');
  host.prepend(cv);
  const gl = cv.getContext('webgl', { antialias: false, depth: false, alpha: false, preserveDrawingBuffer: false });
  if (!gl) return cpuBackground(host, cv);
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { const c2 = cv.cloneNode(); cv.replaceWith(c2); return cpuBackground(host, c2); }
  gl.useProgram(prog);
  // exact clip-space quad: the usual oversized "full-screen triangle" got clipped on the AMD driver in
  // Electron, leaving a black diagonal corner
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = Object.fromEntries(['uOrigin', 'uStep', 'uH', 'uBase', 'uDepth', 'uScale'].map((n) => [n, gl.getUniformLocation(prog, n)]));
  gl.uniform3fv(U.uBase, NOISE.base);
  gl.uniform1f(U.uDepth, NOISE.depth);
  gl.uniform1f(U.uScale, NOISE.scale);

  let cam = { x: 0, y: 0, z: 1 };
  // drawn right away (one GPU draw call) so the noise never lags behind the modules while panning
  const render = () => {
    const dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(host.clientWidth * dpr)), h = Math.max(1, Math.round(host.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h);
    const u = noiseUniforms(cam, dpr);
    gl.uniform2fv(U.uOrigin, u.origin);
    gl.uniform1f(U.uStep, u.step);
    gl.uniform1f(U.uH, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  new ResizeObserver(render).observe(host);
  return { draw(c) { cam = c; render(); } };
}
