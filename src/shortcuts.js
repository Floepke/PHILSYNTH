// Providers rebuild actions from live editor state; saved mappings never retain menu callbacks.
const MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
export const SHORTCUTS_ID = 'keyboard.shortcuts';
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const RESERVED = new Set(['Escape', 'Tab', 'F11']);
const TYPING = 'input, select, textarea, [contenteditable]:not([contenteditable="false"])';
const keyName = (key) => ({ ' ': 'Space', '+': 'Plus', Esc: 'Escape', Del: 'Delete', '⌫': 'Backspace', '↵': 'Enter',
  '→': 'ArrowRight', '←': 'ArrowLeft', '↑': 'ArrowUp', '↓': 'ArrowDown' })[key] ?? (key.length === 1 ? key.toLowerCase() : key);

export function keyCombination(event) {
  if (event.isComposing || event.getModifierState?.('AltGraph') ||
      ['Control', 'Alt', 'Shift', 'Meta', 'Dead', 'Unidentified', 'Process'].includes(event.key)) return null;
  const key = keyName(event.key);
  return [...MODIFIERS.filter((_, i) => [event.ctrlKey, event.altKey, event.shiftKey, event.metaKey][i]), key].join('+');
}

export function parseShortcut(label) {
  if (!label) return null;
  const text = label.replaceAll('⌘', 'Meta+').replaceAll('⇧', 'Shift+');
  const parts = text.split('+');
  const key = keyName(parts.pop());
  if (parts.some((p) => !MODIFIERS.includes(p)) || !key) return null;
  return [...MODIFIERS.filter((m) => parts.includes(m)), key].join('+');
}

export function formatShortcut(binding) {
  if (!binding) return '';
  return binding.split('+').map((p) => p === 'Meta' ? (MAC ? 'Cmd' : 'Meta') : p.length === 1 ? p.toUpperCase() : p).join('+');
}

function defaultKeys(labels) {
  return labels.flatMap((label) => {
    const key = parseShortcut(label);
    if (!key || RESERVED.has(key.split('+').at(-1))) return [];
    if (key.includes('Ctrl+') && !key.includes('Meta+')) return [key, parseShortcut(key.replace('Ctrl+', 'Meta+'))];
    if (key.includes('Meta+') && !key.includes('Ctrl+')) return [key, parseShortcut(key.replace('Meta+', 'Ctrl+'))];
    return [key];
  });
}

export function validShortcutBindings(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([id, binding]) => id.length > 0 && id.length < 300 &&
      typeof binding === 'string' && parseShortcut(binding) === binding && !RESERVED.has(binding.split('+').at(-1)));
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const menuActionId = (scope, item, path = []) => `${scope}/${[...path, item.id ?? slug(item.label)].join('/')}`;

export function createShortcutRegistry() {
  const providers = new Map();
  let bindings = {};
  const actions = () => [...providers.values()].flatMap((provider) => provider());
  const keys = (action) => Object.hasOwn(bindings, action.id) ? [bindings[action.id]] : action.keys ?? [];
  return {
    register(id, provider) {
      providers.set(id, provider);
      return () => { if (providers.get(id) === provider) providers.delete(id); };
    },
    setBindings(value) {
      if (!validShortcutBindings(value)) throw new Error('Invalid keyboard shortcut mappings');
      bindings = { ...value };
    },
    bindings: () => ({ ...bindings }),
    binding: (id) => bindings[id],
    label: (id, fallback = '') => Object.hasOwn(bindings, id) ? formatShortcut(bindings[id]) : fallback,
    actions,
    conflict(action, binding) {
      const current = actions();
      const missing = Object.entries(bindings).filter(([id]) => !current.some((a) => a.id === id))
        .map(([id, key]) => ({
          id, label: id, keys: [key],
          scope: /^(button|history|transport)\//.test(id) ? 'global' : id.startsWith('velocity/') ? 'pianoroll' : id.split('/')[0],
        }));
      return [...current, ...missing].find((other) => other.id !== action.id && keys(other).includes(binding) &&
        (action.scope === 'global' || other.scope === 'global' || action.scope === other.scope));
    },
    resolve(binding, { typing = false, dialog = null } = {}) {
      const available = actions().filter((a) => a.active() &&
        (!typing || (a.allowTyping && /(^|\+)(Ctrl|Meta)\+/.test(binding))) && (!dialog || a.dialog === dialog));
      const action = available.find((a) => keys(a).includes(binding));
      if (action) return { action, handled: true };
      return { action: null, handled: available.some((a) =>
        Object.hasOwn(bindings, a.id) && a.keys?.includes(binding)) };
    },
  };
}

export const shortcutRegistry = createShortcutRegistry();

export function registerShortcutMenu(scope, getItems, { active = () => true, allowTyping = false, dialog = null, context = scope } = {}) {
  return shortcutRegistry.register(scope, () => {
    const result = [];
    const walk = (items, path = []) => {
      for (const item of items) {
        if (item === '-') continue;
        if (item.children) walk(item.children, [...path, item.id ?? slug(item.label)]);
        else if (item.action) result.push({
          id: menuActionId(scope, item, path), label: item.label, scope: context, active, allowTyping, dialog,
          keys: defaultKeys(item.shortcuts ?? [item.shortcut]),
          enabled: () => !item.disabled, run: item.action,
        });
      }
    };
    walk(getItems());
    return result;
  });
}

export function registerShortcutAction(action) {
  return shortcutRegistry.register(action.id, () => [{
    scope: 'global', active: () => true, enabled: () => true, ...action,
  }]);
}

export function registerShortcutPreferences(preferences) {
  preferences.register({
    id: SHORTCUTS_ID, category: 'Keyboard', label: 'Custom shortcuts', type: 'shortcuts', defaultValue: {},
    validate: validShortcutBindings,
    description: 'Right-click a button or menu action to learn a shortcut. Mappings apply to the current editor and are saved on this computer, not in projects. Reset here to restore all default shortcuts.',
    apply: (bindings) => shortcutRegistry.setBindings(bindings),
  });
}

export function initShortcuts({ preferences, root = document, win = window, closeMenu = () => {}, notify = console.error }) {
  const dialog = root.getElementById('shortcut-dialog');
  const description = root.getElementById('shortcut-description');
  const currentShortcut = root.getElementById('shortcut-current');
  const currentShortcutValue = root.getElementById('shortcut-current-value');
  const message = root.getElementById('shortcut-message');
  const cancel = root.getElementById('shortcut-cancel');
  const reset = root.getElementById('shortcut-reset');
  let learning = null;
  let saving = false;
  let returnFocus = null;
  let released = null;
  const topDialog = () => [...root.querySelectorAll('dialog[open]')].at(-1);
  const defaultButtonKeys = new WeakMap();
  const buttonHints = new WeakMap();
  const controlSelector = 'button, input[type="checkbox"][data-shortcut-control]';
  const controlAt = (target) => target.closest?.(controlSelector)
    ?? target.closest?.('label')?.querySelector('input[type="checkbox"][data-shortcut-control]');
  const visible = (el) => el.isConnected && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const buttonAction = (button) => {
    if (button.closest('#shortcut-dialog, .ctx-menu') || button.dataset.shortcutIgnore !== undefined) return null;
    const label = button.getAttribute('aria-label') || button.textContent.trim() || button.title || button.dataset.tip;
    if (!label) return null;
    const container = button.closest('[data-shortcut-scope], dialog, #panel-content, #crumbs, #seq, #arranger');
    const scope = container?.dataset.shortcutScope || container?.id || 'global';
    const id = button.dataset.shortcutAction || (button.id ? `button/${button.id}` : `button/${scope}/${slug(label)}`);
    if (!defaultButtonKeys.has(button)) defaultButtonKeys.set(button, button.getAttribute('aria-keyshortcuts'));
    const binding = shortcutRegistry.binding(id);
    const display = binding ? formatShortcut(binding) : defaultButtonKeys.get(button);
    if (display) {
      if (button.getAttribute('aria-keyshortcuts') !== display) button.setAttribute('aria-keyshortcuts', display);
    } else button.removeAttribute('aria-keyshortcuts');
    return {
      id, label, scope: button.closest('dialog')?.id ?? 'global',
      dialog: button.closest('dialog')?.id,
      keys: [parseShortcut(defaultButtonKeys.get(button))].filter(Boolean),
      active: () => visible(button) && (!topDialog() || topDialog().contains(button)),
      enabled: () => !button.disabled && button.getAttribute('aria-disabled') !== 'true',
      run: () => button.click(),
    };
  };
  const unregister = shortcutRegistry.register('buttons', () => {
    const unique = new Map();
    for (const button of root.querySelectorAll(controlSelector)) {
      const action = buttonAction(button);
      if (action && visible(button) && !unique.has(action.id)) unique.set(action.id, action);
    }
    return [...unique.values()];
  });
  const consume = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const fail = (error) => {
    console.error('Keyboard shortcut:', error);
    notify(`Keyboard shortcut failed: ${error.message}`);
  };
  async function save(next) {
    saving = true;
    cancel.disabled = true;
    reset.disabled = true;
    message.textContent = 'Saving shortcut...';
    try {
      await preferences.save({ [SHORTCUTS_ID]: next });
      notify('Keyboard shortcut saved.');
      learning = null;
      dialog.close();
    } catch (error) {
      message.textContent = `Could not save shortcut: ${error.message}. Try again or cancel.`;
      fail(error);
    } finally {
      saving = false;
      cancel.disabled = false;
      reset.disabled = false;
    }
  }
  function learn(action) {
    if (learning || saving) return;
    returnFocus = root.activeElement;
    closeMenu();
    learning = action;
    description.textContent = `Set a custom shortcut for action "${action.label}". Press a key or key combination, for example Ctrl+A or Ctrl+Shift+A.`;
    const custom = shortcutRegistry.binding(action.id);
    const bindings = custom ? [custom] : action.keys ?? [];
    currentShortcutValue.textContent = [...new Set(bindings)].map(formatShortcut).join(' / ');
    currentShortcut.hidden = !bindings.length;
    message.textContent = 'The first available combination is saved automatically. Escape cancels. Some system shortcuts cannot be captured.';
    reset.hidden = !custom;
    dialog.showModal();
    dialog.focus();
  }
  const context = (e) => {
    if (e.type === 'pointerdown' && e.button !== 2) return;
    const button = controlAt(e.target);
    if (!button || button.closest('#shortcut-dialog')) return;
    let action;
    if (button.dataset.shortcutAction) action = shortcutRegistry.actions().find((a) => a.id === button.dataset.shortcutAction);
    else action = buttonAction(button);
    if (!action) return;
    consume(e);
    if (e.type === 'contextmenu') learn(action);
  };
  const hint = (e) => {
    const button = controlAt(e.target);
    if (!button) return;
    const action = buttonAction(button);
    const binding = action && shortcutRegistry.binding(action.id);
    const current = button.getAttribute('title') ?? button.dataset.tip ?? '';
    const previous = buttonHints.get(button);
    if (binding) {
      const base = previous && current === previous.shown ? previous.base : current;
      const shown = `${action.label}. Shortcut: ${formatShortcut(binding)}. Right-click to change.`;
      buttonHints.set(button, { base, shown });
      button.title = shown;
    } else if (previous) {
      if (current === previous.shown) button.title = previous.base;
      buttonHints.delete(button);
    }
  };
  const keydown = (e) => {
    if (learning) {
      if (e.key === 'Tab' || (['Enter', ' '].includes(e.key) && [cancel, reset].includes(e.target))) return;
      consume(e);
      if (saving || e.repeat) return;
      if (e.key === 'Escape') { learning = null; dialog.close(); return; }
      const binding = keyCombination(e);
      if (!binding) return;
      if (RESERVED.has(binding.split('+').at(-1))) {
        message.textContent = 'Escape, Tab and F11 are reserved for navigation and full screen. Choose another combination.';
        return;
      }
      const conflict = shortcutRegistry.conflict(learning, binding);
      if (conflict) {
        message.textContent = `${formatShortcut(binding)} is already assigned to "${conflict.label}". Choose another combination.`;
        return;
      }
      released = e.code || e.key;
      save({ ...shortcutRegistry.bindings(), [learning.id]: binding });
      return;
    }
    if (released && released === (e.code || e.key)) { consume(e); return; }
    if (e.defaultPrevented || e.isComposing || topDialog() === dialog) return;
    const binding = keyCombination(e);
    if (!binding) return;
    // Modal buttons remain available inside their own dialog; editor actions do not.
    const result = shortcutRegistry.resolve(binding, { typing: !!e.target.closest?.(TYPING), dialog: topDialog()?.id ?? null });
    if (!result.handled) return;
    consume(e);
    if (!result.action || e.repeat || !result.action.enabled()) return;
    closeMenu();
    try {
      const pending = result.action.run();
      if (pending?.catch) pending.catch(fail);
    } catch (error) { fail(error); }
  };
  const keyup = (e) => {
    if (released === (e.code || e.key)) released = null;
  };
  const onClose = () => {
    learning = null;
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  };
  const onCancel = (e) => { if (saving) e.preventDefault(); };
  const onReset = () => {
    for (const binding of learning.keys ?? []) {
      const conflict = shortcutRegistry.conflict(learning, binding);
      if (conflict) {
        message.textContent = `Cannot restore ${formatShortcut(binding)}: it is now assigned to "${conflict.label}". Change that action first, or reset all mappings in Preferences > Keyboard.`;
        return;
      }
    }
    const next = shortcutRegistry.bindings();
    delete next[learning.id];
    save(next);
  };
  const onCancelClick = () => { if (!saving) { learning = null; dialog.close(); } };
  const onBlur = () => { released = null; };
  win.addEventListener('keydown', keydown, true);
  win.addEventListener('keyup', keyup, true);
  win.addEventListener('pointerdown', context, true);
  win.addEventListener('contextmenu', context, true);
  win.addEventListener('pointerover', hint, true);
  win.addEventListener('blur', onBlur);
  dialog.addEventListener('close', onClose);
  dialog.addEventListener('cancel', onCancel);
  cancel.addEventListener('click', onCancelClick);
  reset.addEventListener('click', onReset);
  return {
    learn,
    destroy() {
      unregister();
      win.removeEventListener('keydown', keydown, true);
      win.removeEventListener('keyup', keyup, true);
      win.removeEventListener('pointerdown', context, true);
      win.removeEventListener('contextmenu', context, true);
      win.removeEventListener('pointerover', hint, true);
      win.removeEventListener('blur', onBlur);
      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('cancel', onCancel);
      cancel.removeEventListener('click', onCancelClick);
      reset.removeEventListener('click', onReset);
    },
  };
}
