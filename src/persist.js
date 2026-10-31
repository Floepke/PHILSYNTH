// Autosave: every change is written to localStorage (always) and to the dev server's
// projects/autosave.json (when served by server.mjs). On boot the newest copy wins.
// Static hosts (GitHub Pages) have no API: only responses marked by server.mjs count as a disk.
const LS_KEY = 'modsynth:autosave';
// relative: the app may live in a subfolder (https://user.github.io/REPO/)
const API = 'api/autosave';
const SERVER_HEADER = 'X-ModSynth-Server';
let serverFound = false;
const DEBOUNCE_MS = 300;

export function createPersistence({ getState, onSaved }) {
  let timer = null;
  let paused = 1; // starts paused: nothing is written until the saved project has been restored
  let disk = null; // null = unknown, true = server reachable, false = no server

  async function putDisk(json) {
    if (disk === false) return;
    try {
      const res = await fetch(API, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: json.length < 60000 });
      disk = res.ok && res.headers.get(SERVER_HEADER) === '1';
    } catch {
      disk = false;
    }
  }

  async function flush() {
    clearTimeout(timer);
    timer = null;
    const state = { ...getState(), savedAt: Date.now() };
    const json = JSON.stringify(state);
    let local = true;
    try { localStorage.setItem(LS_KEY, json); } catch { local = false; }
    await putDisk(json);
    const result = { local, disk: disk === true, at: state.savedAt };
    onSaved?.(result);
    return result;
  }

  return {
    schedule() {
      if (paused) return;
      clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    },
    flush,
    // write pending changes synchronously (localStorage) + best-effort to disk, e.g. before a reload
    flushNow() {
      if (timer) flush();
    },
    async pause(fn) {
      paused++;
      try { return await fn(); } finally { paused--; }
    },
    start() {
      if (paused > 0) paused--;
    },
    // Saved copies, newest first: [{ state, source: 'disk' | 'browser' }]
    async loadAll() {
      let local = null;
      let server = null;
      try { local = JSON.parse(localStorage.getItem(LS_KEY)); } catch { /* corrupt or blocked */ }
      try {
        const res = await fetch(API, { cache: 'no-store' });
        disk = res.headers.get(SERVER_HEADER) === '1' && (res.ok || res.status === 404);
        serverFound = disk;
        if (disk && res.ok) server = await res.json();
      } catch {
        disk = false;
      }
      const copies = [{ state: server, source: 'disk' }, { state: local, source: 'browser' }]
        .filter((c) => c.state?.format === 'modsynth')
        .sort((a, b) => (b.state.savedAt ?? 0) - (a.state.savedAt ?? 0));
      return { copies, disk: disk === true };
    },
    // Keep an unreadable autosave around so it is not silently overwritten.
    keepBroken(state) {
      try { localStorage.setItem(`${LS_KEY}:broken`, JSON.stringify(state)); } catch { /* full */ }
    },
    get diskAvailable() { return disk === true; },
  };
}

// Live reload from server.mjs: CSS is hot-swapped, everything else reloads the page.
// Call after loadAll(): without server.mjs (static hosting) nothing is requested.
export function connectLiveReload(beforeReload) {
  if (!window.EventSource || !serverFound) return;
  const es = new EventSource('api/live');
  let opened = false;
  es.addEventListener('open', () => (opened = true));
  es.addEventListener('error', () => { if (!opened) es.close(); }); // no live server: stop retrying
  es.addEventListener('reload', () => {
    beforeReload();
    location.reload();
  });
  es.addEventListener('css', () => {
    for (const link of document.querySelectorAll('link[rel=stylesheet]')) {
      const url = new URL(link.href);
      url.searchParams.set('v', Date.now());
      link.href = url.href;
    }
  });
}
