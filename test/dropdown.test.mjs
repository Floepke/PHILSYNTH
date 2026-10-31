// Run on Linux: xvfb-run -a node_modules/.bin/electron test/dropdown.test.mjs
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';

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
    assert.equal(mappingStyles.text, 'rgb(244, 228, 200)');
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
    console.log('house style tests passed: all dialogs, future dialogs, menus and dropdowns use wood; rounded picker opens');
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
