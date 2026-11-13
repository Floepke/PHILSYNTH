// Run on Linux: xvfb-run -a node_modules/.bin/electron test/dropdown.test.mjs
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    await win.loadURL(`data:text/html,${encodeURIComponent(`<style>${css}</style><div id="seq-bar"><select id="choice"><option>A</option><option>B</option></select></div><dialog id="map-dialog"><p>Controllers</p><div class="map-list"><button class="map-row">Controller</button></div><menu><button class="primary">Done</button></menu></dialog>`)}`);
    const styles = await win.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('choice');
      return {
        supported: CSS.supports('appearance', 'base-select'),
        appearance: getComputedStyle(select).appearance,
        radius: getComputedStyle(select, '::picker(select)').borderRadius,
        alignment: getComputedStyle(select).alignItems,
      };
    })()`);
    assert.equal(styles.supported, true);
    assert.equal(styles.appearance, 'base-select');
    assert.equal(styles.radius, '12px');
    assert.equal(styles.alignment, 'center', 'selected text is vertically centred in fixed-height toolbar fields');
    const menuInsets = await win.webContents.executeJavaScript(`(() => {
      const button = document.createElement('button');
      button.className = 'brand';
      document.body.append(button);
      const css = getComputedStyle(button);
      return { top: css.top, right: css.right };
    })()`);
    assert.equal(menuInsets.top, menuInsets.right, 'main menu has equal top and right spacing');
    const mappingStyles = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.getElementById('map-dialog');
      return {
        wood: getComputedStyle(dialog).backgroundImage.includes('data:image/svg+xml'),
        doneWood: getComputedStyle(dialog.querySelector('menu button')).backgroundImage.includes('data:image/svg+xml'),
        rowWood: getComputedStyle(dialog.querySelector('.map-row')).backgroundImage.includes('data:image/svg+xml'),
        text: getComputedStyle(dialog.querySelector('p')).color,
      };
    })()`);
    assert.equal(mappingStyles.wood, true);
    assert.equal(mappingStyles.doneWood, true);
    assert.equal(mappingStyles.rowWood, false, 'controller rows retain their selection styling');
    assert.equal(mappingStyles.text, 'rgb(229, 229, 229)');
    const houseStyles = await win.webContents.executeJavaScript(`(() => {
      const results = [];
      for (const id of ['insert-dialog', 'confirm-dialog', 'unsaved-dialog', 'sig-dialog', 'future-dialog']) {
        const dialog = document.createElement('dialog');
        dialog.id = id;
        dialog.innerHTML = '<menu><button class="primary">OK</button></menu>';
        document.body.append(dialog);
        results.push({
          id,
          wood: getComputedStyle(dialog).backgroundImage.includes('data:image/svg+xml'),
          buttonWood: getComputedStyle(dialog.querySelector('button')).backgroundImage.includes('data:image/svg+xml'),
        });
      }
      const menu = document.createElement('div');
      menu.className = 'ctx-menu';
      document.body.append(menu);
      results.push({ id: 'context-menu', wood: getComputedStyle(menu).backgroundImage.includes('data:image/svg+xml'), buttonWood: true });
      results.push({ id: 'dropdown', wood: getComputedStyle(document.getElementById('choice'), '::picker(select)').backgroundImage.includes('data:image/svg+xml'), buttonWood: true });
      return results;
    })()`);
    for (const result of houseStyles) {
      assert.equal(result.wood, true, result.id + ' has wooden surface');
      assert.equal(result.buttonWood, true, result.id + ' has wooden action buttons');
    }
    await win.webContents.executeJavaScript("document.getElementById('choice').showPicker()", true);
    assert.equal(await win.webContents.executeJavaScript("document.getElementById('choice').matches(':open')"), true);

    // initWidgets: a second click closes the list, the list uses the window's height before it
    // scrolls, and the dropdown is as wide as its widest choice
    const dir = mkdtempSync(join(tmpdir(), 'dropdown-'));
    const page = join(dir, 'page.html');
    writeFileSync(page, `<!doctype html><style>${css}</style><body><div id="seq-bar" style="position:absolute;top:100px;left:100px"><select id="choice"></select></div>
<script type="module">
import { initWidgets } from ${JSON.stringify(new URL('../src/widgets.js', import.meta.url).href)};
const s = document.getElementById('choice');
for (let i = 0; i < 60; i++) s.add(new Option(i % 7 ? 'M' + i : 'Module number ' + i, i));
initWidgets(document);
window.ready = true;
</script>`);
    const tall = new BrowserWindow({ width: 600, height: 900, useContentSize: true, show: false, webPreferences: { webSecurity: false } });
    await tall.loadFile(page);
    const run = (code) => tall.webContents.executeJavaScript(code, true);
    while (!(await run('window.ready === true'))) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    const box = await run(`(() => { const b = document.getElementById('choice').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), bottom: b.bottom }; })()`);
    const click = async () => {
      for (const type of ['mouseDown', 'mouseUp']) tall.webContents.sendInputEvent({ type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 300));
    };
    const isOpen = () => run(`document.getElementById('choice').matches(':open')`);
    await click();
    assert.equal(await isOpen(), true, 'a click opens the list');
    const height = parseFloat(await run(`getComputedStyle(document.getElementById('choice'), '::picker(select)').height`));
    assert.ok(height > 900 - box.bottom - 2 && height <= 900 - box.bottom, `the list fills the space below the dropdown (${height}px)`);
    await click();
    assert.equal(await isOpen(), false, 'a second click closes it');
    await click();
    assert.equal(await isOpen(), true, 'and a third opens it again');
    await click();
    const widths = await run(`(async () => {
      const s = document.getElementById('choice');
      const widths = new Set();
      for (const i of [0, 1, 7, 59]) { s.selectedIndex = i; widths.add(s.getBoundingClientRect().width); }
      const before = s.getBoundingClientRect().width;
      s.add(new Option('A much longer module name than the others', 'x'));
      await new Promise((r) => setTimeout(r, 50));
      return { widths: [...widths], before, after: s.getBoundingClientRect().width };
    })()`);
    assert.equal(widths.widths.length, 1, 'every choice gives the same width');
    assert.ok(widths.after > widths.before, 'a longer new choice widens the dropdown');
    tall.destroy();
    rmSync(dir, { recursive: true, force: true });
    console.log('house style tests passed: all dialogs, future dialogs, menus and dropdowns use wood; rounded picker opens');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
