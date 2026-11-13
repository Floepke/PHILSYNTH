// Mouse-operated controls leave focus in the editor. Tab/double-click still allow typing.
import { wheelAccumulator, wheelDelta } from './params.js';
import { clean } from './song.js';

export function initWidgets(root, { numberStep = () => 1 } = {}) {
  const releaseWidgetFocus = () => {
    const active = document.activeElement;
    if (!active?.closest('dialog') && active?.matches('input, select, textarea, button, [contenteditable]')) active.blur();
  };
  const notify = (el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const wheel = (el, change) => {
    const take = wheelAccumulator({ whole: true });
    el.addEventListener('wheel', (e) => {
      if (el.disabled || el.readOnly || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      releaseWidgetFocus();
      const { dx, dy } = wheelDelta(e);
      const steps = take(e, dy || dx);
      if (steps) change(steps);
    }, { passive: false });
  };

  // whether a select's picker is open (:open); null where the browser cannot tell
  const isOpen = (el) => { try { return el.matches(':open'); } catch { return null; } };
  // The customizable picker is an auto popover: showing another auto popover closes it (toggling
  // disabled, blur or Escape events do not).
  const closePicker = () => {
    try {
      const closer = document.createElement('div');
      closer.popover = 'auto';
      closer.style.display = 'none';
      document.body.append(closer);
      closer.showPopover();
      closer.hidePopover();
      closer.remove();
    } catch { /* no popover API */ }
  };

  // A dropdown is as wide as its widest choice, so it does not change width with the choice.
  // Content-sized selects only: those that are as wide for every choice (width: 100% …) are left.
  const fitted = new WeakMap(); // select -> option labels it was fitted to
  const fitWidth = (select) => {
    if (!select.isConnected || typeof select.getBoundingClientRect !== 'function') return true;
    const labels = [...select.options].map((o) => (o.hidden ? '' : o.label)).join('\n');
    if (fitted.get(select) === labels) return true;
    select.style.minWidth = '';
    const index = select.selectedIndex;
    const widths = [];
    for (let i = 0; i < select.options.length; i++) {
      select.selectedIndex = i;
      widths.push(select.getBoundingClientRect().width);
    }
    select.selectedIndex = index;
    if (!widths.length || !Math.max(...widths)) return false; // not rendered yet
    const widest = Math.max(...widths);
    fitted.set(select, labels);
    if (widest - Math.min(...widths) > 0.5) select.style.minWidth = `${Math.ceil(widest)}px`;
    return true;
  };
  const unfitted = new Set();
  const refit = () => {
    for (const select of [...unfitted]) if (fitWidth(select)) unfitted.delete(select);
  };
  let refitQueued = false;
  const queueFit = (select) => {
    unfitted.add(select);
    if (refitQueued) return;
    refitQueued = true;
    queueMicrotask(() => { refitQueued = false; refit(); });
  };
  const observers = typeof MutationObserver === 'function' && typeof ResizeObserver === 'function';
  // option lists change (modules added, renamed …) and hidden selects measure once they are shown
  const optionsChanged = observers && new MutationObserver((records) => {
    for (const { target } of records) {
      const select = (target.nodeType === 1 ? target : target.parentElement)?.closest('select');
      if (select) queueFit(select);
    }
  });
  const sized = observers && new ResizeObserver((entries) => {
    for (const { target } of entries) if (unfitted.has(target) && fitWidth(target)) unfitted.delete(target);
  });
  if (observers) document.fonts?.ready.then(() => { for (const s of root.querySelectorAll('select')) { fitted.delete(s); queueFit(s); } });

  const selects = new WeakSet();
  const enhanceSelect = (select, { scroll = true } = {}) => {
    if (selects.has(select)) return;
    selects.add(select);
    if (observers && !select.multiple && !(select.size > 1)) {
      optionsChanged.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['label', 'hidden'] });
      sized.observe(select);
      queueFit(select);
    }
    let mouse = false;
    // A click on the select while its list is open closes it. Chromium keeps the list open until
    // the click arrives (then it is closed here); a browser that closes it first is covered by
    // `shown`, which remembers it was open (checked every frame; Escape, a pick or a click
    // elsewhere end it), so the click then does not open it again.
    let shown = false;
    const watch = () => {
      if (!shown) return;
      if (isOpen(select) === false) shown = false;
      else requestAnimationFrame(watch);
    };
    select.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || select.disabled) return;
      if (e.target.closest?.('option, optgroup')) return;
      releaseWidgetFocus();
      mouse = true;
      const open = isOpen(select);
      if (shown || open) {
        shown = false;
        e.preventDefault();
        if (open) closePicker(); // still open: close it
        return;
      }
      // showPicker opens the native, scrollable list without focusing the closed control.
      if (select.showPicker) {
        e.preventDefault();
        select.showPicker();
        if (isOpen(select) !== null && typeof requestAnimationFrame === 'function') {
          shown = true;
          requestAnimationFrame(watch);
        }
      }
    });
    select.addEventListener('keydown', () => { mouse = false; });
    select.addEventListener('change', () => { if (mouse) select.blur(); });
    if (scroll) wheel(select, (steps) => {
      const options = [...select.options].filter((o) => !o.disabled && !o.hidden && !o.parentElement?.disabled);
      if (!options.length) return;
      const index = options.indexOf(select.selectedOptions[0]);
      // Browser wheel acceleration must not skip options; the accumulator still handles trackpads and bursts.
      const next = options[Math.max(0, Math.min(options.length - 1, index - Math.sign(steps)))];
      if (next.selected) return;
      next.selected = true;
      notify(select);
    });
  };
  for (const select of root.querySelectorAll('select')) enhanceSelect(select);
  // dropdowns built later (module panels, Preferences, the file dialog) behave the same
  if (observers && root.nodeType === 9) {
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'SELECT') enhanceSelect(node, { scroll: false });
          else for (const select of node.querySelectorAll('select')) enhanceSelect(select, { scroll: false });
        }
      }
    }).observe(root.documentElement, { childList: true, subtree: true });
  }

  for (const input of root.querySelectorAll('input[type="number"]')) {
    const wrapper = document.createElement('span');
    wrapper.className = 'spinbox';
    input.before(wrapper);
    wrapper.append(input);
    const name = input.getAttribute('aria-label') || input.labels?.[0]?.textContent.trim() || input.id;
    input.setAttribute('aria-label', name);
    input.title = `${input.title ? `${input.title}. ` : ''}Scroll or use arrows; double-click to type`;
    const change = (steps) => {
      if (input.disabled || input.readOnly) return;
      if (!input.validity.badInput) {
        const before = input.value;
        if (input.step === 'any') {
          const min = input.min === '' ? -Infinity : +input.min;
          const max = input.max === '' ? Infinity : +input.max;
          const value = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : Math.max(0, min);
          input.value = clean(Math.max(min, Math.min(max, value + numberStep(input) * steps)));
        } else if (steps > 0) input.stepUp(steps);
        else input.stepDown(-steps);
        if (input.value !== before) notify(input);
      } else input.reportValidity();
    };
    const buttons = document.createElement('span');
    buttons.className = 'spin-buttons';
    for (const [steps, label, glyph] of [[1, 'Increase', '\u25b2'], [-1, 'Decrease', '\u25bc']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.textContent = glyph;
      button.setAttribute('aria-label', `${label} ${name}`);
      button.title = label;
      button.addEventListener('mousedown', (e) => { e.preventDefault(); releaseWidgetFocus(); });
      button.addEventListener('click', (e) => { e.preventDefault(); input.blur(); change(steps); });
      buttons.append(button);
    }
    wrapper.append(buttons);
    input.addEventListener('mousedown', (e) => {
      if (e.button === 0 && document.activeElement !== input) { e.preventDefault(); releaseWidgetFocus(); }
    });
    input.addEventListener('dblclick', () => {
      if (!input.disabled) { input.focus(); input.select(); }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') input.blur();
    });
    wheel(input, change);
  }
}
