export const MOUSE_BACK = 3;
export const MOUSE_FORWARD = 4;

// Pointer events can suppress compatibility mouse events; handle either without firing twice.
export function initMouseNavigation(target, goBack) {
  let backPressed = false;
  const sideButton = (e) => e.button === MOUSE_BACK || e.button === MOUSE_FORWARD;
  const down = (e) => {
    if (!sideButton(e)) return;
    e.preventDefault();
    if (e.button === MOUSE_BACK) backPressed = true;
  };
  const up = (e) => {
    if (!sideButton(e)) return;
    e.preventDefault();
    if (e.button === MOUSE_BACK && backPressed) {
      backPressed = false;
      goBack();
    }
  };
  for (const type of ['pointerdown', 'mousedown']) target.addEventListener(type, down, true);
  for (const type of ['pointerup', 'mouseup']) target.addEventListener(type, up, true);
  target.addEventListener('auxclick', (e) => { if (sideButton(e)) e.preventDefault(); }, true);
  for (const type of ['pointercancel', 'blur']) target.addEventListener(type, () => { backPressed = false; }, true);
}
