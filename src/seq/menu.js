// Right-click menu for the sequencer views (DOM overlay, closes on any outside press, Escape,
// outside scrolling or window blur). Nested children fold inline; menus grow to fit and scroll within the window.
//   showMenu({ x, y (client px), items: [{ label, shortcut?, disabled?, checked?, action?, children? } | '-'], className?, onClose?, container? }) -> close()
let current = null;

const MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
// Shortcut label for Ctrl/Cmd + key ('⇧D' = with Shift).
export const shortcut = (key) => (MAC ? `⌘${key}` : `Ctrl+${key.replace('⇧', 'Shift+')}`);

export function closeMenu() {
  current?.();
}

export function showMenu({ x, y, items, className = '', onClose = null, container = document.body }) {
  closeMenu();
  const el = document.createElement('div');
  el.className = className ? `ctx-menu ${className}` : 'ctx-menu';
  el.setAttribute('role', 'menu');
  el.tabIndex = -1;
  const entries = [];
  function appendItems(items, parent, depth = 0, ancestors = []) {
    for (const item of items) {
      if (item === '-') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        parent.append(sep);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item';
      b.style.paddingLeft = `${10 + depth * 16}px`;
      const checkbox = typeof item.checked === 'boolean';
      b.setAttribute('role', checkbox ? 'menuitemcheckbox' : 'menuitem');
      if (checkbox) b.setAttribute('aria-checked', String(item.checked));
      b.disabled = !!item.disabled;
      const label = document.createElement('span');
      label.textContent = item.label;
      let group = null;
      const entry = { button: b, ancestors, parent: ancestors.at(-1), group: null };
      if (item.children) {
        b.setAttribute('aria-expanded', 'false');
        const fold = document.createElement('span');
        fold.className = 'ctx-fold';
        fold.textContent = '▸';
        fold.setAttribute('aria-hidden', 'true');
        label.prepend(fold);
        group = document.createElement('div');
        group.className = 'ctx-group';
        group.setAttribute('role', 'group');
        group.hidden = true;
        entry.group = group;
        entry.fold = fold;
      }
      if (checkbox) {
        const check = document.createElement('span');
        check.className = 'ctx-check';
        check.setAttribute('aria-hidden', 'true');
        label.prepend(check);
      }
      const key = document.createElement('kbd');
      key.textContent = item.shortcut ?? '';
      b.append(label, key);
      b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the view
      b.addEventListener('click', () => {
        if (b.disabled) return;
        if (group) { toggle(entry); b.focus(); return; }
        close();
        item.action();
      });
      entries.push(entry);
      parent.append(b);
      if (group) {
        parent.append(group);
        appendItems(item.children, group, depth + 1, [...ancestors, entry]);
      }
    }
  }
  appendItems(items, el);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  container.append(el);
  // just right/below the pointer (so a quick second right-click lands on the view again), kept on screen
  const bounds = () => container === document.body
    ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    : container.getBoundingClientRect();
  const initialBounds = bounds();
  if (initialBounds.right - initialBounds.left < 180) el.style.minWidth = '0';
  el.style.maxWidth = `${Math.max(0, initialBounds.right - initialBounds.left)}px`;
  el.style.width = `${Math.min(el.getBoundingClientRect().width, initialBounds.right - initialBounds.left)}px`;
  function layout() {
    const area = bounds();
    el.style.maxHeight = `${Math.max(0, area.bottom - area.top)}px`;
    const previousWidth = el.getBoundingClientRect().width;
    el.style.width = 'max-content';
    const neededWidth = el.getBoundingClientRect().width;
    el.style.width = `${Math.min(area.right - area.left, Math.max(previousWidth, neededWidth))}px`;
    const r = el.getBoundingClientRect();
    const left = Math.max(area.left, Math.min(area.right - r.width, x + 2 + r.width > area.right ? x - 2 - r.width : x + 2));
    const top = Math.max(area.top, Math.min(area.bottom - r.height, y + 2));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
  layout();
  function toggle(entry, expanded = entry.group.hidden) {
    entry.group.hidden = !expanded;
    entry.button.setAttribute('aria-expanded', String(expanded));
    entry.fold.textContent = expanded ? '▾' : '▸';
    layout();
  }
  const visibleEntries = () => entries.filter(entry => !entry.button.disabled && entry.ancestors.every(parent => !parent.group.hidden));

  const outside = (e) => { if (!el.contains(e.target)) close(); };
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    const visible = visibleEntries();
    const buttons = visible.map(entry => entry.button);
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(e.key) || !buttons.length) return;
    e.preventDefault();
    e.stopPropagation();
    const i = buttons.indexOf(document.activeElement);
    const entry = visible[i];
    if (e.key === 'ArrowRight') {
      if (entry?.group) {
        if (entry.group.hidden) toggle(entry, true);
        else visibleEntries().find(child => child.parent === entry)?.button.focus();
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      if (entry?.group && !entry.group.hidden) toggle(entry, false);
      else if (entry?.parent) { toggle(entry.parent, false); entry.parent.button.focus(); }
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') { if (i >= 0) buttons[i].click(); return; }
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
      : e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i <= 0 ? buttons.length - 1 : i - 1);
    buttons[next].focus();
    buttons[next].scrollIntoView?.({ block: 'nearest' });
  };
  const away = () => close();
  const wheel = e => {
    if (el.contains(e.target)) e.stopPropagation();
    else close();
  };
  window.addEventListener('pointerdown', outside, true);
  window.addEventListener('keydown', keys, true);
  window.addEventListener('wheel', wheel, true);
  window.addEventListener('blur', away);
  window.addEventListener('resize', away);
  function close() {
    if (current !== close) return;
    current = null;
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', keys, true);
    window.removeEventListener('wheel', wheel, true);
    window.removeEventListener('blur', away);
    window.removeEventListener('resize', away);
    el.remove();
    onClose?.();
  }
  current = close;
  return close;
}
