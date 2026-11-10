// Linux: xvfb-run -a node_modules/.bin/electron test/panelscroll-ui.test.mjs --no-sandbox
import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

app.whenReady().then(async () => {
  let win;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><link rel="stylesheet" href="/style.css">
          <div id="panel-shell" style="width:300px;height:400px">
            <aside id="panel"><div id="panel-content"><div style="height:2000px">Controllers<input id="field"></div></div></aside>
            <div id="panel-scroll" role="scrollbar" tabindex="0" aria-controls="panel" aria-orientation="vertical" aria-valuemin="0">
              <div id="panel-scroll-thumb"></div>
            </div>
          </div><script type="module">
            import { initPanelScroll } from '/src/panelscroll.js';
            initPanelScroll(document.getElementById('panel'), document.getElementById('panel-scroll'), document.getElementById('panel-scroll-thumb'));
            window.ready = true;
          </script>`);
        return;
      }
      if (!['/style.css', '/src/panelscroll.js'].includes(req.url)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(new URL('..' + req.url, import.meta.url)));
    } catch (error) {
      console.error(error);
      res.writeHead(500);
      res.end(String(error));
    }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    win = new BrowserWindow({ show: true, width: 800, height: 700, webPreferences: { backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const run = (code) => win.webContents.executeJavaScript(code);
    const wait = () => new Promise(resolve => setTimeout(resolve, 80));
    await wait();
    assert.equal(await run('window.ready'), true);
    const metrics = () => run(`(() => {
      const p = document.getElementById('panel'), t = document.getElementById('panel-scroll'), h = document.getElementById('panel-scroll-thumb');
      const r = t.getBoundingClientRect(), b = h.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: r.top, height: r.height, size: b.height, thumbY: b.top,
        scroll: p.scrollTop, max: p.scrollHeight - p.clientHeight, hidden: t.hidden, aria: Number(t.getAttribute('aria-valuenow')) };
    })()`);
    const mouse = (type, x, y) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    const click = async (x, y) => { mouse('mouseDown', x, y); mouse('mouseUp', x, y); await wait(); };
    let m = await metrics();
    assert.equal(m.hidden, false);
    await run("document.getElementById('field').focus()");
    await click(m.x, m.y + m.height * 0.75);
    m = await metrics();
    const expected = (m.height * 0.75 - m.size / 2) / (m.height - m.size) * m.max;
    assert.ok(Math.abs(m.scroll - expected) < 2, 'track click centres the handle at the clicked position');
    assert.equal(await run("document.activeElement.id"), 'field', 'track clicking preserves controller focus');
    assert.ok(Math.abs(m.aria - m.scroll) < 1);
    await run("document.getElementById('panel').scrollTop = 0");
    await wait();
    mouse('mouseDown', m.x, m.y + m.height * 0.6);
    mouse('mouseMove', m.x, m.y + m.height * 0.7);
    mouse('mouseUp', m.x, m.y + m.height * 0.7);
    await wait();
    assert.ok(Math.abs((await metrics()).scroll - (m.height * 0.7 - m.size / 2) / (m.height - m.size) * m.max) < 2,
      'holding after a track jump continues dragging from the clicked point');
    await click(m.x, m.y + 1);
    assert.equal((await metrics()).scroll, 0, 'top track click reaches the beginning');
    m = await metrics();
    mouse('mouseDown', m.x, m.thumbY + m.size / 3);
    mouse('mouseMove', m.x, m.thumbY + m.size / 3 + 50);
    mouse('mouseUp', m.x, m.thumbY + m.size / 3 + 50);
    await wait();
    assert.ok(Math.abs((await metrics()).scroll - 50 / (m.height - m.size) * m.max) < 2, 'thumb dragging keeps its grab offset');
    m = await metrics();
    await click(m.x, m.y + m.height - 1);
    assert.equal((await metrics()).scroll, m.max, 'bottom track click reaches the end');
    await run(`document.getElementById('panel-scroll').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))`);
    await wait();
    assert.equal((await metrics()).scroll, 0, 'keyboard navigation works');
    await run(`document.getElementById('panel-scroll').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }))`);
    await wait();
    assert.equal((await metrics()).scroll, 100, 'wheel over the track scrolls the content');
    await run("document.getElementById('panel').scrollTop = 500");
    await wait();
    m = await metrics();
    assert.ok(Math.abs(m.thumbY - m.y - 500 / m.max * (m.height - m.size)) < 1, 'programmatic/native content scrolling updates the thumb');
    await run("document.getElementById('panel-shell').style.height = '250px'");
    await wait();
    assert.equal((await metrics()).height, 250, 'divider resizing updates the track geometry');
    await run("document.querySelector('#panel-content > div').style.height = '20px'");
    await wait();
    assert.equal((await metrics()).hidden, true, 'short module content hides the scrollbar');
    await run("document.querySelector('#panel-content > div').style.height = '3000px'");
    await wait();
    assert.equal((await metrics()).hidden, false, 'new module content restores the scrollbar');
    assert.deepEqual(errors, []);
    console.log('Controller-panel jump scrollbar UI tests passed');
  } finally {
    win?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });
