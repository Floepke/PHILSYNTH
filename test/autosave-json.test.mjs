import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'philsynth-autosave-'));
process.env.MODSYNTH_PROJECTS = dir;
process.env.MODSYNTH_NO_WATCH = '1';
const { start, stop } = await import('../server.mjs');
let started = false;
try {
  const port = await start(0, '127.0.0.1');
  started = true;
  const url = `http://127.0.0.1:${port}/api/autosave`;
  const project = { format: 'philsynth', name: 'first\nproject', patch: { modules: [{ name: '  oscillator  ' }] }, song: { clips: [] } };
  const put = async (data) => {
    const response = await fetch(url, { method: 'PUT', body: JSON.stringify(data, null, 2) });
    assert.equal(response.status, 200);
  };
  await put(project);
  const first = await readFile(join(dir, 'autosave.json'), 'utf8');
  assert.equal(first, JSON.stringify(project), 'formatted input is saved as one compact line');
  assert.ok(!first.includes('\n'));
  assert.deepEqual(JSON.parse(first), project);
  const next = { ...project, name: 'second' };
  await put(next);
  assert.equal(await readFile(join(dir, 'autosave.json'), 'utf8'), JSON.stringify(next));
  assert.equal(await readFile(join(dir, 'autosave.prev.json'), 'utf8'), first, 'previous autosave remains intact');
  const response = await fetch(url);
  assert.deepEqual(await response.json(), next, 'saved project is still readable');
  console.log('compact autosave tests passed');
} finally {
  if (started) await stop();
  await rm(dir, { recursive: true, force: true });
}
