// Patch module: "Controllers…" button below its controllers and the dialog that maps controllers
// of modules inside the patch to extra controllers of the Patch module (see modules/patch.js).
//   left:  every module inside with its controllers; click one to map / unmap it
//   right: the mapped controllers in order (their controller numbers), rename, reorder, remove
// Changes apply immediately; Done (or Esc) closes.
import { paramsOf } from './params.js';
import { nextMapKey } from './modules/patch.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const moduleName = (m) => (m.def.isOutput ? 'Output' : m.def.label);
const valueText = (m, p) => {
  const v = m.values[p.id];
  if (v === undefined) return '';
  return p.format ? p.format(v, m.values) : p.options ? p.options[v] : String(+(+v).toFixed(3));
};

// Panel part of a Patch module: the button + a line about its mapped controllers.
export function patchControllersView(entry, { open }) {
  const box = el('div', 'map-view');
  const info = el('p', 'hint');
  const btn = el('button', 'map-open', 'Controllers…');
  btn.title = 'Map controllers of modules inside this patch to controllers of this Patch module';
  btn.onclick = open;
  const n = entry.state?.maps?.length ?? 0;
  info.textContent = n
    ? `${n} controller${n === 1 ? '' : 's'} from inside mapped (numbered after Instances). The panel, LFOs and automation clips drive them from outside.`
    : 'Map controllers of modules inside this patch to this module, to control them from outside.';
  box.append(btn, info);
  return { el: box };
}

let dialog = null;
function build() {
  dialog = el('dialog', 'map-dialog');
  dialog.id = 'map-dialog';
  const form = el('form');
  form.method = 'dialog';
  const title = el('h3');
  const note = el('p', 'map-note', 'Click a controller inside the patch to map it to a controller of this Patch module. A mapped controller shows and sets the inner value; LFOs and automation clips on it drive the inner controller (in every instance). For modules deeper down, map them in that inner Patch first.');
  const search = el('input', 'map-search');
  search.type = 'search';
  search.placeholder = 'Filter modules and controllers…';
  search.setAttribute('aria-label', 'Filter modules and controllers');
  const cols = el('div', 'map-cols');
  const leftCol = el('section', 'map-col');
  const rightCol = el('section', 'map-col');
  const inside = el('div', 'map-list map-inside');
  const mapped = el('div', 'map-list map-mapped');
  leftCol.append(el('h4', null, 'Inside the patch'), search, inside);
  rightCol.append(el('h4', null, 'Patch module controllers'), mapped);
  cols.append(leftCol, rightCol);
  const menu = el('menu');
  const done = el('button', 'primary', 'Done');
  done.value = 'ok';
  menu.append(done);
  form.append(title, note, cols, menu);
  // Enter in the filter / a name field must not submit (close) the dialog
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) e.preventDefault();
  });
  dialog.append(form);
  document.body.append(dialog);
  dialog.parts = { title, search, inside, mapped };
}

// Opens the dialog for Patch module `entry`. setState(state) stores new mappings (applied at
// once); resolves when the dialog closes.
export function openMapDialog(entry, { setState }) {
  if (!dialog) build();
  const { title, search, inside, mapped } = dialog.parts;
  const patch = entry.inst.patch;
  title.textContent = `Patch #${entry.id} — controllers`;
  search.value = '';
  const maps = () => entry.state?.maps ?? [];
  const store = (list) => setState({ ...entry.state, maps: list });
  const numberOf = (key) => paramsOf(entry).findIndex((p) => p.id === key);

  function toggle(m, p) {
    const list = maps();
    const at = list.findIndex((x) => x.module === m.id && x.param === p.id);
    if (at >= 0) store(list.filter((_, i) => i !== at));
    else store([...list, { key: nextMapKey(list), module: m.id, param: p.id, label: '' }]);
    render();
  }

  function renderInside() {
    const q = search.value.trim().toLowerCase();
    const list = maps();
    inside.replaceChildren();
    for (const m of [...patch.modules.values()].sort((a, b) => a.id - b.id)) {
      const name = `#${m.id} ${moduleName(m)} ${m.def.type}`.toLowerCase();
      const params = paramsOf(m).filter((p) => !q || name.includes(q) || p.label.toLowerCase().includes(q));
      if (!params.length) continue;
      const group = el('div', 'map-group');
      group.style.setProperty('--c', m.def.color ?? '#888');
      const head = el('div', 'map-group-head');
      head.append(el('span', 'swatch'), el('b', null, `#${m.id}`), el('span', null, moduleName(m)));
      group.append(head);
      for (const p of params) {
        const on = list.find((x) => x.module === m.id && x.param === p.id);
        const row = el('button', 'map-row');
        row.type = 'button';
        row.setAttribute('aria-pressed', on ? 'true' : 'false');
        row.title = on ? `Mapped to controller ${numberOf(on.key)} — click to unmap` : 'Click to map it to a controller of this Patch module';
        row.append(
          el('span', 'map-badge', on ? String(numberOf(on.key)) : '+'),
          el('span', 'map-label', p.label),
          el('span', 'map-value', valueText(m, p)),
        );
        row.onclick = () => toggle(m, p);
        group.append(row);
      }
      inside.append(group);
    }
    if (!inside.children.length) inside.append(el('p', 'map-empty', q ? 'Nothing matches the filter.' : 'This patch has no controllers.'));
  }

  function renderMapped() {
    mapped.replaceChildren();
    const list = maps();
    list.forEach((mp, i) => {
      const m = patch.modules.get(mp.module);
      const p = m && paramsOf(m).find((x) => x.id === mp.param);
      const row = el('div', 'map-item');
      row.style.setProperty('--c', m?.def.color ?? '#666');
      row.classList.toggle('missing', !p);
      const num = el('span', 'map-badge', p ? String(numberOf(mp.key)) : '!');
      num.title = p ? `Controller ${numberOf(mp.key)} of Patch #${entry.id}` : 'Its module or controller no longer exists';
      const name = el('input', 'map-name');
      name.type = 'text';
      name.maxLength = 40;
      name.value = mp.label;
      name.placeholder = p?.label ?? mp.param;
      name.setAttribute('aria-label', 'Controller name (empty: the inner name)');
      name.oninput = () => store(maps().map((x) => (x.key === mp.key ? { ...x, label: name.value } : x)));
      const src = el('span', 'map-src', p ? `#${m.id} ${moduleName(m)} · ${p.label}` : `#${mp.module} · ${mp.param} (missing)`);
      const btn = (text, label, fn, disabled = false) => {
        const b = el('button', 'map-btn', text);
        b.type = 'button';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.disabled = disabled;
        b.onclick = fn;
        return b;
      };
      const move = (d) => {
        const next = [...maps()];
        [next[i], next[i + d]] = [next[i + d], next[i]];
        store(next);
        render();
      };
      const tools = el('span', 'map-tools');
      tools.append(
        btn('↑', 'Move up', () => move(-1), i === 0),
        btn('↓', 'Move down', () => move(1), i === list.length - 1),
        btn('×', 'Remove mapping', () => { store(maps().filter((x) => x.key !== mp.key)); render(); }),
      );
      const text = el('span', 'map-text');
      text.append(name, src);
      row.append(num, text, tools);
      mapped.append(row);
    });
    if (!list.length) mapped.append(el('p', 'map-empty', 'Nothing mapped yet: click controllers on the left.'));
  }

  function render() {
    renderInside();
    renderMapped();
  }
  search.oninput = renderInside;
  render();

  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(), { once: true });
    dialog.showModal();
    setTimeout(() => search.focus());
  });
}
