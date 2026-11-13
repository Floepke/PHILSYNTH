import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const [version, output = '_site'] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_-]+$/.test(version ?? '')) throw new Error('Provide a deployment version (for example the commit SHA).');
const destination = resolve(output);
const prefix = `assets/${version}/`;
const assets = resolve(destination, prefix);
await mkdir(assets, { recursive: true });
await cp(resolve(root, 'src'), resolve(assets, 'src'), { recursive: true });
await cp(resolve(root, 'style.css'), resolve(assets, 'style.css'));
await mkdir(resolve(assets, 'node_modules'), { recursive: true });
await cp(resolve(root, 'node_modules/wasm-media-encoders'), resolve(assets, 'node_modules/wasm-media-encoders'), { recursive: true });
const html = (await readFile(resolve(root, 'index.html'), 'utf8'))
  .replaceAll('href="src/', `href="${prefix}src/`)
  .replace('href="style.css"', `href="${prefix}style.css"`)
  .replace('src="src/main.js"', `src="${prefix}src/main.js"`);
await writeFile(resolve(destination, 'index.html'), html);
// at the site root so its scope covers index.html (cross-origin isolation for the PATCH workers)
await cp(resolve(root, 'coi-sw.js'), resolve(destination, 'coi-sw.js'));
await writeFile(resolve(destination, '.nojekyll'), '');
