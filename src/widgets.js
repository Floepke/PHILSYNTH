// Mouse-operated controls leave focus in the editor. Tab/double-click still allow typing.
import { wheelAccumulator } from './params.js';
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
      const steps = take(e, e.deltaY || e.deltaX);
      if (steps) change(steps);
    }, { passive: false });
  };

  for (const select of root.querySelectorAll('select')) {
    let mouse = false;
    select.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || select.disabled) return;
      if (e.target.closest?.('option, optgroup')) return;
      releaseWidgetFocus();
      mouse = true;
      // showPicker opens the native, scrollable list without focusing the closed control.
      if (select.showPicker) {
        e.preventDefault();
        select.showPicker();
      }
    });
    select.addEventListener('keydown', () => { mouse = false; });
    select.addEventListener('change', () => { if (mouse) select.blur(); });
    wheel(select, (steps) => {
      const options = [...select.options].filter((o) => !o.disabled && !o.hidden && !o.parentElement?.disabled);
      if (!options.length) return;
      const index = options.indexOf(select.selectedOptions[0]);
      const next = options[Math.max(0, Math.min(options.length - 1, index - steps))];
      if (next.selected) return;
      next.selected = true;
      notify(select);
    });
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
