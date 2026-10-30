// Right-click menu for the sequencer views (DOM overlay, closes on any outside press, Escape,
// scrolling or window blur). Arrow keys + Enter work too.
//   showMenu({ x, y (client px), items: [{ label, shortcut?, disabled?, action() } | '-'] }) -> close()
let current = null;

const MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
// Shortcut label for Ctrl/Cmd + key ('⇧D' = with Shift).
export const shortcut = (key) => (MAC ? `⌘${key}` : `Ctrl+${key.replace('⇧', 'Shift+')}`);

export function closeMenu() {
  current?.();
}

export function showMenu({ x, y, items }) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.setAttribute('role', 'menu');
  el.tabIndex = -1;
  const buttons = [];
  for (const item of items) {
    if (item === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      el.append(sep);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item';
    b.setAttribute('role', 'menuitem');
    b.disabled = !!item.disabled;
    const label = document.createElement('span');
    label.textContent = item.label;
    const key = document.createElement('kbd');
    key.textContent = item.shortcut ?? '';
    b.append(label, key);
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the view
    b.addEventListener('click', () => {
      close();
      item.action();
    });
    if (!b.disabled) buttons.push(b);
    el.append(b);
  }
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  document.body.append(el);
  // just right/below the pointer (so a quick second right-click lands on the view again), kept on screen
  const r = el.getBoundingClientRect();
  const left = x + 2 + r.width > window.innerWidth ? Math.max(0, x - 2 - r.width) : x + 2;
  const top = y + 2 + r.height > window.innerHeight ? Math.max(0, y - 2 - r.height) : y + 2;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const outside = (e) => { if (!el.contains(e.target)) close(); };
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key) || !buttons.length) return;
    e.preventDefault();
    e.stopPropagation();
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Enter') { if (i >= 0) buttons[i].click(); return; }
    const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i <= 0 ? buttons.length - 1 : i - 1);
    buttons[next].focus();
  };
  const away = () => close();
  window.addEventListener('pointerdown', outside, true);
  window.addEventListener('keydown', keys, true);
  window.addEventListener('wheel', away, true);
  window.addEventListener('blur', away);
  window.addEventListener('resize', away);
  function close() {
    if (current !== close) return;
    current = null;
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', keys, true);
    window.removeEventListener('wheel', away, true);
    window.removeEventListener('blur', away);
    window.removeEventListener('resize', away);
    el.remove();
  }
  current = close;
  return close;
}
