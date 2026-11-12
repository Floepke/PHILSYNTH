// Run with Electron: xvfb-run -a node_modules/.bin/electron test/filepicker-ui.test.mjs
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { registerProjectFiles } from '../electron/projectfiles.mjs';
import { exportMidi } from '../src/midiexport.js';
import { emptySong } from '../src/song.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
const temp = await mkdtemp(join(tmpdir(), 'filepicker-ui-'));
const data = join(temp, 'data');
const files = join(temp, 'files');
await mkdir(data);
await mkdir(files);
await mkdir(join(files, 'Folder'));
await writeFile(join(files, 'Folder', '.hidden'), 'hidden');
await writeFile(join(files, 'one.phproject'), 'original');
await writeFile(join(files, 'song.MIDI'), Buffer.from([0, 128, 255]));
const instrument = (wave) => JSON.stringify({
  format: 'philsynth-module', version: 1,
  modules: [{ id: 1, type: 'OSC', x: 0, y: 0, values: { wave } }], cables: [],
});
await writeFile(join(files, 'lead.phmod'), instrument(0));
await writeFile(join(files, 'bass.phmod'), instrument(1));
await writeFile(join(files, 'broken.phmod'), '{');
app.setPath('userData', data);
app.setPath('documents', files);

let server;
let win;
try {
  registerProjectFiles(() => true);
  const index = (await readFile(join(root, 'index.html'), 'utf8'))
    .replace('<script type="module" src="src/main.js"></script>', `<script type="module">
      import { pickFile } from '/src/filepicker.js';
      import { openMidiFile } from '/src/filedialog.js';
      import { openTextFile } from '/src/filedialog.js';
      import { createModulePreview } from '/src/modulepreview.js';
      import { dspTestHost } from '/test/dsphost.mjs';
      import { initMidi } from '/src/midi.js';
      import { AUDIO_FORMATS, encodeAudio } from '/src/audioformat.js';
      window.encodeAudio = encodeAudio;
      window.saveAudioPicker = () => { window.audioSaveResult = pickFile(window.modsynthFiles,
        { mode: 'save', dialog: 'audio', formats: AUDIO_FORMATS, exts: AUDIO_FORMATS.map(f => f.ext), saveExt: '.wav', suggestedName: 'song.wav' }); };
      window.openPicker = mode => { window.pickResult = pickFile(window.modsynthFiles,
        { mode, dialog: 'project-open', exts: ['.phproject'], saveExt: '.phproject' }); };
      window.openMidi = () => { window.midiResult = openMidiFile(); };
      window.saveMidiPicker = () => { window.midiSaveResult = pickFile(window.modsynthFiles,
        { mode: 'save', dialog: 'midi', exts: ['.mid'], saveExt: '.mid', suggestedName: 'export.mid' }); };
      const audio = dspTestHost();
      const preview = createModulePreview({ ctx: { currentTime: 0 }, dsp: audio.dsp, resume() {} },
        path => window.modsynthFiles.openFile('module', path));
      const input = Object.assign(new EventTarget(), { id: 'preview-keys', name: 'Preview keys', state: 'connected' });
      Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => Object.assign(new EventTarget(), { inputs: new Map([[input.id, input]]) }) });
      const midi = initMidi({ getTarget: () => preview.target, onStatus() {} });
      await midi.enable();
      window.previewAudio = audio;
      window.previewNote = (on) => {
        const event = new Event('midimessage');
        event.data = [on ? 0x90 : 0x80, 60, on ? 100 : 0];
        input.dispatchEvent(event);
      };
      window.openModulePicker = () => { window.moduleResult = openTextFile('module', window,
        (files, opts) => pickFile(files, { ...opts, preview: preview.select })); };
    </script>`);
  server = http.createServer(async (req, res) => {
    try {
      const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
      if (path !== root && !path.startsWith(root + sep)) throw new Error('Invalid path');
      const body = path === root ? index : await readFile(path);
      res.writeHead(200, { 'Content-Type': /\.(m?js)$/.test(path) ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  win = new BrowserWindow({ show: false, webPreferences: {
    preload: join(root, 'electron', 'preload.cjs'), sandbox: true, contextIsolation: true,
  } });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(`Renderer: ${event.message}`);
  });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const run = async (code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (err) { throw new Error(`${err.message}\nRenderer script: ${code}`, { cause: err }); }
  };
  const wait = async (condition) => {
    for (let i = 0; i < 100; i++) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for picker');
  };
  const visible = (name) => run(`Array.from(document.querySelectorAll('.fd-row .fd-file')).some(el => el.textContent === ${JSON.stringify(name)})`);
  const open = async (mode) => {
    await run(`window.openPicker(${JSON.stringify(mode)}); true`);
    await wait(async () => await run("document.querySelector('#file-dialog').open") && await visible('one.phproject'));
  };
  const context = async (name) => {
    await wait(() => run(`(() => {
      const row = [...document.querySelectorAll('.fd-row')].find(el => el.querySelector('.fd-file')?.textContent === ${JSON.stringify(name)});
      if (!row) throw new Error('Missing row');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }));
      return !!document.querySelector('#file-dialog .fd-context-menu');
    })()`));
    assert.equal(await run("!!document.querySelector('#file-dialog .fd-context-menu')"), true, 'menu appears inside the modal dialog');
    assert.equal(await run(`(() => {
      const menu = document.querySelector('.fd-context-menu').getBoundingClientRect();
      const dialog = document.querySelector('#file-dialog').getBoundingClientRect();
      return menu.left >= dialog.left && menu.right <= dialog.right && menu.top >= dialog.top && menu.bottom <= dialog.bottom;
    })()`), true, 'menu stays inside the dialog');
  };
  const choose = (label) => run(`(() => {
    const button = [...document.querySelectorAll('.fd-context-menu button')].find(el => el.textContent === ${JSON.stringify(label)});
    if (!button || button.disabled) throw new Error('Menu item unavailable');
    button.click();
  })()`);
  const confirm = async (expected, answer) => {
    await wait(() => run("document.querySelector('#confirm-dialog').open"));
    assert.match(await run("document.querySelector('#confirm-text').textContent"), expected);
    assert.deepEqual(await run("[document.querySelector('#confirm-ok').textContent, document.querySelector('#confirm-cancel').textContent]"), ['Yes', 'No']);
    assert.equal(await run("document.activeElement.id"), 'confirm-cancel', 'No is focused by default');
    await run(`document.querySelector('#confirm-dialog').close(${JSON.stringify(answer)})`);
  };
  const contextBackground = () => run(`document.querySelector('#fd-list').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }))`);

  await wait(() => run("typeof window.openPicker === 'function' && typeof window.openModulePicker === 'function'"));
  await open('open');
  await run(`window.modsynthFiles.saveAs(${JSON.stringify(join(files, 'one.phproject'))}, 'original')`);
  await writeFile(join(files, 'Folder', 'one.phproject'), 'do not overwrite');
  await context('one.phproject');
  await choose('Cut');
  await context('Folder');
  await choose('Paste');
  await wait(() => run("document.querySelector('#fd-error').textContent.includes('Cannot paste')"));
  assert.equal(await readFile(join(files, 'one.phproject'), 'utf8'), 'original');
  assert.equal(await readFile(join(files, 'Folder', 'one.phproject'), 'utf8'), 'do not overwrite');
  await rm(join(files, 'Folder', 'one.phproject'));
  await context('Folder');
  await choose('Copy');
  await contextBackground();
  await choose('Paste');
  await wait(() => visible('Folder copy'));
  assert.equal(await readFile(join(files, 'Folder copy', '.hidden'), 'utf8'), 'hidden');
  await context('Folder copy');
  await choose('Rename');
  await run(`(() => {
    const input = document.querySelector('[aria-label="New name"]');
    input.value = 'Folder renamed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await wait(() => visible('Folder renamed'));
  await context('Folder renamed');
  await choose('Cut');
  await context('Folder');
  await choose('Paste');
  await wait(async () => (await readFile(join(files, 'Folder', 'Folder renamed', '.hidden'), 'utf8').catch(() => null)) === 'hidden');
  await context('one.phproject');
  await choose('Copy');
  await context('one.phproject');
  await choose('Paste');
  await wait(() => visible('one copy.phproject'));
  assert.equal(await readFile(join(files, 'one copy.phproject'), 'utf8'), 'original');
  await context('one copy.phproject');
  await choose('Rename');
  await run(`(() => {
    const input = document.querySelector('[aria-label="New name"]');
    input.value = 'renamed.phproject';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);
  await wait(() => visible('renamed.phproject'));
  await context('renamed.phproject');
  await choose('Cut');
  await context('Folder');
  await choose('Paste');
  await wait(async () => (await readFile(join(files, 'Folder', 'renamed.phproject'), 'utf8').catch(() => null)) === 'original');
  await context('Folder');
  await choose('Delete');
  await confirm(/all its contents/, 'ok');
  await confirm(/absolutely sure/, 'cancel');
  assert.equal(await readFile(join(files, 'Folder', '.hidden'), 'utf8'), 'hidden', 'second No preserves the folder');
  await context('Folder');
  await choose('Delete');
  await confirm(/all its contents/, 'ok');
  await confirm(/absolutely sure/, 'ok');
  await wait(async () => !(await visible('Folder')));
  assert.equal(await readFile(join(files, 'Folder', '.hidden'), 'utf8').catch(() => null), null);
  await run("document.querySelector('#fd-cancel').click(); window.pickResult");

  await open('save');
  await context('one.phproject');
  await choose('Delete');
  await confirm(/Permanently delete file/, 'cancel');
  assert.equal(await readFile(join(files, 'one.phproject'), 'utf8'), 'original');
  await context('one.phproject');
  await choose('Delete');
  await confirm(/Permanently delete file/, 'ok');
  await wait(async () => !(await visible('one.phproject')));
  assert.equal(await run("document.querySelector('#confirm-dialog').open"), false, 'file deletion needs only one confirmation');
  assert.equal(await run(`window.modsynthFiles.save(${JSON.stringify(join(files, 'one.phproject'))}, 'recreated')`), null, 'saving a deleted project asks for a new file');
  assert.equal(await readFile(join(files, 'one.phproject'), 'utf8').catch(() => null), null);
  await run("document.querySelector('#fd-cancel').click(); window.pickResult");
  await run('window.openMidi(); true');
  await wait(() => visible('song.MIDI'));
  await run(`(() => {
    const row = [...document.querySelectorAll('.fd-row')].find(el => el.querySelector('.fd-file')?.textContent === 'song.MIDI');
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  assert.deepEqual(await run('window.midiResult.then(f => ({ name: f.name, bytes: Array.from(f.data) }))'),
    { name: 'song.MIDI', bytes: [0, 128, 255] });
  assert.equal((await run("window.modsynthFiles.start('midi')")).dir, files, 'MIDI picker remembers its folder');
  const midiBytes = exportMidi(emptySong()).bytes;
  const midiPath = join(files, 'export.mid');
  await run('window.saveMidiPicker(); true');
  await wait(() => run("document.querySelector('#file-dialog').open && document.querySelector('#fd-name').value === 'export.mid'"));
  await run("document.querySelector('#fd-ok').click()");
  await wait(() => run("!document.querySelector('#file-dialog').open"));
  assert.equal((await run('window.midiSaveResult')).path, midiPath, 'MIDI save picker accepts .mid instead of reporting Invalid extension');
  const saveTarget = await run(`window.modsynthFiles.target(${JSON.stringify(files)}, 'export.mid', '.mid')`);
  assert.equal(saveTarget.path, midiPath, 'desktop picker accepts MIDI save extensions');
  await run(`window.modsynthFiles.saveMidi(${JSON.stringify(midiPath)}, new Uint8Array(${JSON.stringify([...midiBytes])}))`);
  assert.deepEqual(new Uint8Array(await readFile(midiPath)), midiBytes, 'desktop writes a valid binary MIDI atomically');
  await assert.rejects(run(`window.modsynthFiles.saveMidi(${JSON.stringify(midiPath)}, new Uint8Array([1, 2]))`), /Invalid MIDI data/);
  for (const [extension, typed] of [['.mp3', false], ['.ogg', true]]) {
    await run('window.saveAudioPicker(); true');
    await wait(() => run("document.querySelector('#file-dialog').open && !!document.querySelector('[aria-label=\"Audio file format\"]')"));
    if (typed) await run("document.querySelector('#fd-name').value = 'typed.ogg'");
    else await run(`(() => {
      const select = document.querySelector('[aria-label="Audio file format"]');
      select.value = '.mp3'; select.dispatchEvent(new Event('change'));
    })()`);
    await run("document.querySelector('#fd-ok').click()");
    await wait(() => run("!document.querySelector('#file-dialog').open"));
    const result = await run('window.audioSaveResult');
    assert.ok(result.path.endsWith(extension), 'dropdown and typed audio extensions select the correct format');
  }
  const decoded = await run(`(async () => {
    const pcm = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 48000) * 0.5);
    const context = new AudioContext({ sampleRate: 48000 });
    try {
      const results = [];
      for (const ext of ['.mp3', '.ogg']) {
        const bytes = await window.encodeAudio(pcm, pcm.map(value => value * 0.5), 48000, ext);
        const audio = await context.decodeAudioData(bytes);
        const channel = audio.getChannelData(0);
        const rms = Math.sqrt(channel.reduce((sum, value) => sum + value * value, 0) / channel.length);
        const right = audio.getChannelData(1);
        const rightRms = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0) / right.length);
        results.push({ ext, duration: audio.duration, channels: audio.numberOfChannels, rms, rightRms });
      }
      return results;
    } finally { await context.close(); }
  })()`);
  for (const audio of decoded) {
    assert.ok(Math.abs(audio.duration - 1) < 0.1, `${audio.ext} duration survives encoding`);
    assert.equal(audio.channels, 2);
    assert.ok(audio.rms > 0.30 && audio.rms < 0.40, `${audio.ext} retains the audio signal`);
    assert.ok(Math.abs(audio.rightRms / audio.rms - 0.5) < 0.03, `${audio.ext} preserves independent stereo channels`);
  }
  const selectFile = (name, type = 'click') => run(`(() => {
    const row = [...document.querySelectorAll('.fd-row')].find(el => el.querySelector('.fd-file')?.textContent === ${JSON.stringify(name)});
    if (!row) throw new Error('Missing file');
    row.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true }));
  })()`);
  const previewNodes = () => run('window.previewAudio.graph.nodes.size');
  const isAudible = () => run('window.previewAudio.render(10).L.some(v => Math.abs(v) > 0.00001)');
  await mkdir(join(files, 'Preview instruments'));
  await run('window.openModulePicker(); true');
  await wait(async () => await run("document.querySelector('#file-dialog').open") && await visible('lead.phmod'));
  assert.equal(await run("document.querySelector('#fd-preview').hidden"), false, 'module picker offers instrument preview');
  assert.equal(await run("document.querySelector('#fd-preview').getAttribute('aria-checked')"), 'false', 'preview defaults off');
  await selectFile('lead.phmod');
  assert.equal(await previewNodes(), 1, 'selecting with preview off does not create an instrument');
  await run("document.querySelector('#fd-preview').click()");
  await wait(async () => await previewNodes() === 4);
  assert.equal(await run("document.querySelector('#fd-preview').getAttribute('aria-checked')"), 'true');
  await run('window.previewNote(true)');
  assert.equal(await isAudible(), true, 'a MIDI keyboard plays the selected file while the modal picker remains open');
  assert.equal(await run("document.querySelector('#file-dialog').open"), true);
  await selectFile('bass.phmod');
  await wait(() => run("[...window.previewAudio.graph.nodes.values()].some(n => n.kind === 'osc' && n.k.p.wave === 1)"));
  assert.equal(await previewNodes(), 4, 'switching files replaces rather than layers instruments');
  assert.equal(await isAudible(), false, 'switching files stops notes held on the previous instrument');
  await run('window.previewNote(false); window.previewNote(true)');
  assert.equal(await isAudible(), true);
  await run("document.querySelector('#fd-preview').click()");
  assert.equal(await previewNodes(), 1, 'switching preview off disposes the instrument');
  assert.equal(await isAudible(), false);
  await run("document.querySelector('#fd-preview').click()");
  await wait(async () => await previewNodes() === 4);
  await selectFile('broken.phmod');
  await wait(() => run("document.querySelector('#fd-error').textContent.includes('Cannot preview instrument')"));
  assert.equal(await previewNodes(), 1, 'invalid files stop the old instrument and show an error');
  await selectFile('lead.phmod');
  await wait(async () => await previewNodes() === 4);
  assert.equal(await run("document.querySelector('#fd-error').textContent"), '');
  await selectFile('Preview instruments');
  await wait(() => run("!!document.querySelector('.fd-empty')"));
  assert.equal(await previewNodes(), 1, 'a single click opens a folder and stops instrument preview');
  await run("document.querySelector('#fd-up').click()");
  await wait(() => visible('lead.phmod'));
  await run("document.querySelector('#fd-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))");
  await wait(async () => await previewNodes() === 4);
  await run("document.querySelector('#fd-cancel').click()");
  await wait(() => run("!document.querySelector('#file-dialog').open"));
  assert.equal(await previewNodes(), 1, 'Cancel removes the preview');
  assert.equal(await run('window.moduleResult'), null);
  await run('window.openModulePicker(); true');
  await wait(async () => await run("document.querySelector('#file-dialog').open") && await visible('lead.phmod'));
  assert.equal(await run("document.querySelector('#fd-preview').getAttribute('aria-checked')"), 'false', 'a new picker resets preview to off');
  await selectFile('lead.phmod');
  await run("document.querySelector('#fd-preview').click()");
  await wait(async () => await previewNodes() === 4);
  await run("document.querySelector('#fd-ok').click()");
  await wait(() => run("!document.querySelector('#file-dialog').open"));
  assert.equal(await previewNodes(), 1, 'Open removes the temporary instrument too');
  assert.equal((await run('window.moduleResult')).name, 'lead.phmod', 'Open still returns the selected file for insertion');
  await run("window.openPicker('open'); true");
  await wait(() => run("document.querySelector('#file-dialog').open"));
  assert.equal(await run("document.querySelector('#fd-preview').hidden"), true, 'other file pickers do not show instrument preview');
  await run("document.querySelector('#fd-cancel').click()");
  console.log('file picker UI tests passed');
} finally {
  win?.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
}).then(() => app.quit()).catch((err) => { console.error(err); app.exit(1); });
