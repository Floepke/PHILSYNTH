import { hexToRgb, rgbToHex } from './modcolor.js';

export function createPreferencesDialog(preferencesManager, { loadError = '' } = {}) {
  const dialog = document.getElementById('preferences-dialog');
  const categories = document.getElementById('preferences-categories');
  const content = document.getElementById('preferences-content');
  const error = document.getElementById('preferences-error');
  let draft = {};
  let saving = false;
  const invalid = new Map();

  function change(item, value) {
    try {
      preferencesManager.preview(item.id, value);
      draft[item.id] = value;
      invalid.delete(item.id);
    } catch (err) {
      invalid.set(item.id, err.message);
    }
    error.textContent = [...invalid.values()].join(' ');
  }
  function render() {
    content.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = categories.value;
    content.append(heading);
    for (const item of preferencesManager.entries().filter((i) => i.category === categories.value)) {
      const section = document.createElement('fieldset');
      section.className = 'preference';
      const title = document.createElement('legend');
      title.textContent = item.label;
      section.append(title);
      const id = `pref-${item.id.replaceAll('.', '-')}`;
      let set;
      if (item.type === 'color') {
        const sliders = [];
        const outputs = [];
        const group = document.createElement('div');
        group.className = 'color-sliders';
        const note = document.createElement('p');
        note.className = 'dialog-note';
        const show = () => {
          const rgb = sliders.map((s) => +s.value);
          sliders.forEach((s, i) => {
            const lo = [...rgb]; lo[i] = 0;
            const hi = [...rgb]; hi[i] = 255;
            s.style.setProperty('--track', `linear-gradient(to right, ${rgbToHex(...lo)}, ${rgbToHex(...hi)})`);
            outputs[i].textContent = rgb[i];
          });
          note.textContent = `${item.label} ${rgbToHex(...rgb)} (live preview)`;
        };
        for (const channel of ['r', 'g', 'b']) {
          const row = document.createElement('label');
          row.className = 'color-row';
          const name = document.createElement('span');
          name.textContent = channel.toUpperCase();
          const input = document.createElement('input');
          input.id = `${id}-${channel}`;
          input.type = 'range';
          input.min = 0; input.max = 255; input.step = 1;
          input.setAttribute('aria-label', `${item.label} ${channel.toUpperCase()}`);
          const output = document.createElement('output');
          output.htmlFor = input.id;
          sliders.push(input); outputs.push(output);
          input.addEventListener('input', () => {
            show();
            change(item, rgbToHex(...sliders.map((s) => +s.value)));
          });
          row.append(name, input, output);
          group.append(row);
        }
        set = (value) => {
          hexToRgb(value).forEach((v, i) => { sliders[i].value = v; });
          show();
        };
        section.append(group, note);
      } else {
        const input = document.createElement(item.type === 'select' ? 'select' : 'input');
        input.id = id;
        input.setAttribute('aria-label', item.label);
        if (item.type === 'select') {
          for (const option of item.options) input.add(new Option(option.label, option.value));
        } else {
          input.type = item.type === 'boolean' ? 'checkbox' : 'number';
          if (item.type === 'number') {
            input.min = item.min; input.max = item.max; input.step = item.step ?? 'any';
            input.required = true;
          }
        }
        set = (value) => { if (item.type === 'boolean') input.checked = value; else input.value = value; };
        input.addEventListener('change', () => change(item,
          item.type === 'boolean' ? input.checked : item.type === 'number' ? input.valueAsNumber : input.value));
        section.append(input);
      }
      set(draft[item.id]);
      if (item.description) {
        const description = document.createElement('p');
        description.className = 'dialog-note';
        description.textContent = item.description;
        section.append(description);
      }
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'preference-reset';
      reset.textContent = 'Reset to default';
      reset.setAttribute('aria-label', `Reset ${item.label} to default`);
      reset.addEventListener('click', () => {
        set(item.defaultValue);
        change(item, item.defaultValue);
      });
      section.append(reset);
      content.append(section);
    }
  }
  categories.addEventListener('change', render);
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => preferencesManager.restore());
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    if (event.submitter?.value !== 'ok') {
      dialog.close('cancel');
      return;
    }
    if (invalid.size) return;
    saving = true;
    error.textContent = '';
    const controls = [...dialog.querySelectorAll('input, select, button')];
    controls.forEach((control) => { control.disabled = true; });
    try {
      await preferencesManager.save(draft);
      loadError = '';
      dialog.close('ok');
    } catch (err) {
      error.textContent = `Could not save preferences: ${err.message}`;
    } finally {
      saving = false;
      controls.forEach((control) => { control.disabled = false; });
    }
  });
  return () => {
    if (dialog.open) return;
    const entries = preferencesManager.entries();
    draft = Object.fromEntries(entries.map((i) => [i.id, preferencesManager.get(i.id)]));
    invalid.clear();
    const selected = categories.value;
    categories.replaceChildren(...[...new Set(entries.map((i) => i.category))].map((category) => new Option(category, category)));
    categories.value = [...categories.options].some((o) => o.value === selected) ? selected : categories.options[0]?.value ?? '';
    error.textContent = loadError;
    render();
    dialog.returnValue = '';
    dialog.showModal();
    categories.focus();
  };
}
