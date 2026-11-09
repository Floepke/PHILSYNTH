// The activating left-click must not reach editing handlers or native controls.
export function initPaneFocus(panes) {
  let consuming = false;
  let suppressDoubleClick = false;
  const stop = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    consuming = false;
    const pane = panes.find(({ element }) => element.contains(e.target));
    if (!pane || pane.element.contains(document.activeElement)) return;
    pane.focus();
    consuming = true;
    suppressDoubleClick = true;
    stop(e);
  }, true);
  for (const type of ['mousedown', 'pointerup', 'mouseup', 'click']) {
    window.addEventListener(type, (e) => {
      if (e.button !== 0) return;
      if (consuming) {
        stop(e);
        if (type === 'click') consuming = false;
      } else if (type === 'click' && e.detail === 1) {
        suppressDoubleClick = false;
      }
    }, true);
  }
  window.addEventListener('pointermove', (e) => {
    if (consuming && (e.buttons & 1)) stop(e);
  }, true);
  window.addEventListener('dblclick', (e) => {
    if (e.button !== 0 || !suppressDoubleClick) return;
    suppressDoubleClick = false;
    stop(e);
  }, true);
  for (const type of ['pointercancel', 'blur']) {
    window.addEventListener(type, () => {
      consuming = false;
      suppressDoubleClick = false;
    });
  }
}
