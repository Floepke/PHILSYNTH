// Builds the C++ DSP kernels (cpp/) into src/dsp/modsynth.wasm.
//   node build-wasm.mjs        (npm run build:wasm)
// Needs Zig (bundles clang, wasm-ld and wasi-libc): `zig` on PATH, ~/.local/opt/zig/zig, or the
// ZIG environment variable. The .wasm is committed, so running the app never needs a compiler.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'src/dsp/modsynth.wasm');

function findZig() {
  const candidates = [process.env.ZIG, join(homedir(), '.local/opt/zig/zig'), 'zig'].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' });
      return c;
    } catch {}
  }
  console.error('Zig not found. Install it (https://ziglang.org/download/) and put it on PATH, or set ZIG=/path/to/zig.');
  process.exit(1);
}

const zig = findZig();
const args = [
  'c++', '-target', 'wasm32-wasi', '-mexec-model=reactor',
  '-O3', '-msimd128', '-fno-exceptions', '-fno-rtti', '-nostdlib++', '-s', '-std=c++17',
  '-Wall', '-Wextra', '-Wno-unused-parameter',
  '-o', OUT, join(ROOT, 'cpp/engine.cpp'),
];
execFileSync(zig, args, { stdio: 'inherit' });

// The engine instantiates the module without imports (src/dsp/wasm.js)
const mod = new WebAssembly.Module(readFileSync(OUT));
const imports = WebAssembly.Module.imports(mod);
if (imports.length) {
  console.error('modsynth.wasm must not have imports, found:', imports.map((i) => `${i.module}.${i.name}`).join(', '));
  process.exit(1);
}
console.log(`built ${OUT.slice(ROOT.length + 1)} (${statSync(OUT).size} bytes)`);
