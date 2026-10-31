// Tooltips in the status bar: the text of a `title` attribute is shown at the bottom of the window
// while the pointer is over the element, instead of the browser's popup at the pointer.
// Every title (also ones set later, e.g. `el.title = …` while the pointer moves over a canvas) is
// moved to data-tip, so the browser shows no popup. Inside modal dialogs the status bar is covered
// by the backdrop, so titles there stay normal popups.
const TIP = 'data-tip';

export function initStatusTips({ root = document, tipEl, statusEl }) {
  let hovered = null; // element under the pointer

  const inDialog = (el) => !!el.closest?.('dialog');
  function adopt(el) {
    if (!el.hasAttribute?.('title') || inDialog(el)) return;
    const text = el.getAttribute('title');
    el.removeAttribute('title');
    el.setAttribute(TIP, text);
    // screen readers keep the hint
    if (text) el.setAttribute('aria-description', text);
    else el.removeAttribute('aria-description');
  }
  // a tipped element that moved into a dialog gets its normal popup back
  function release(el) {
    if (!el.hasAttribute(TIP)) return;
    el.setAttribute('title', el.getAttribute(TIP));
    el.removeAttribute(TIP);
  }

  function show() {
    if (hovered && !hovered.isConnected) hovered = null; // removed under the pointer (e.g. re-render)
    const el = hovered?.closest?.(`[${TIP}], [title]`);
    const text = el && !inDialog(el) ? el.getAttribute(TIP) ?? '' : '';
    // only touch the DOM on a change: the observer below also sees these writes
    if (tipEl.textContent !== text) tipEl.textContent = text;
    if (tipEl.hidden !== !text) tipEl.hidden = !text;
    if (statusEl.hidden !== !!text) statusEl.hidden = !!text;
  }

  root.querySelectorAll('[title]').forEach(adopt);
  new MutationObserver((records) => {
    let refresh = false;
    for (const r of records) {
      if (r.target === tipEl || tipEl.contains(r.target)) continue; // our own writes
      if (r.type === 'attributes') {
        adopt(r.target);
        refresh ||= !!hovered && r.target.contains?.(hovered);
      } else {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          adopt(n);
          n.querySelectorAll('[title]').forEach(adopt);
        }
        refresh ||= !!hovered && !hovered.isConnected;
      }
    }
    if (refresh) show();
  }).observe(root.documentElement ?? root, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  const win = root.defaultView ?? window;
  win.addEventListener('pointerover', (e) => {
    hovered = e.target;
    const d = hovered.closest?.('dialog');
    if (d) d.querySelectorAll(`[${TIP}]`).forEach(release);
    show();
  }, true);
  // pointer left the window
  root.documentElement.addEventListener('pointerleave', () => {
    hovered = null;
    show();
  });
  win.addEventListener('blur', () => {
    hovered = null;
    show();
  });
}
