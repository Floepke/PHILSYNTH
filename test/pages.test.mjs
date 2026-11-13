import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const output = await mkdtemp(join(tmpdir(), 'philsynth-pages-'));
try {
  for (const version of ['old-release', 'new-release']) {
    execFileSync(process.execPath, ['build-pages.mjs', version, output]);
    const html = await readFile(join(output, 'index.html'), 'utf8');
    const base = `assets/${version}/`;
    assert.ok(html.includes(`src="${base}src/main.js"`));
    assert.ok(html.includes(`href="${base}style.css"`));
    assert.ok(html.includes(`href="${base}src/icon.svg"`));
    assert.ok(!html.includes('src="src/main.js"'), 'no unversioned module entry point');
    for (const path of ['src/main.js', 'src/engine.worklet.js', 'src/dsp/modsynth.wasm',
      'src/spectrumanalyserpanel.js', 'src/exportworker.js', 'style.css',
      'node_modules/wasm-media-encoders/dist/esnext/index.mjs']) {
      assert.ok((await stat(join(output, base, path))).isFile(), `${path} resolves within the deployment version`);
    }
    assert.equal(await readFile(join(output, base, 'src/main.js'), 'utf8'),
      await readFile(new URL('../src/main.js', import.meta.url), 'utf8'));
  }
  assert.ok((await stat(join(output, '.nojekyll'))).isFile());
  assert.equal(await readFile(join(output, 'coi-sw.js'), 'utf8'),
    await readFile(new URL('../coi-sw.js', import.meta.url), 'utf8'), 'isolation service worker at the site root');
  assert.ok((await readFile(join(output, 'index.html'), 'utf8')).includes("register('coi-sw.js')"));
} finally {
  await rm(output, { recursive: true, force: true });
}
console.log('Versioned Pages deployment tests passed');
