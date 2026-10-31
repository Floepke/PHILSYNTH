import assert from 'node:assert/strict';
import { showMenu, closeMenu } from '../src/seq/menu.js';

class Element extends EventTarget {
  children = [];
  attributes = {};
  style = {};
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  prepend(node) { node.parent = this; this.children.unshift(node); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getBoundingClientRect() { return { width: 220, height: 80 }; }
  contains(node) { return node === this || this.children.some((c) => c.contains(node)); }
  remove() { this.parent.children = this.parent.children.filter((c) => c !== this); }
  focus() { document.activeElement = this; }
  click() { this.dispatchEvent(new Event('click')); }
}
globalThis.document = { createElement: () => new Element(), body: new Element(), activeElement: null };
globalThis.window = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 });
const key = (value) => {
  const e = new Event('keydown', { cancelable: true });
  e.key = value;
  window.dispatchEvent(e);
  return e;
};

for (const checked of [false, true]) {
  let toggled = false;
  showMenu({ x: 10, y: 20, items: [
    { label: 'Snap velocity values', checked, action() { toggled = true; } },
    { label: 'Delete point', disabled: true, action() { assert.fail('disabled action'); } },
  ] });
  const menu = document.body.children[0];
  const [toggle, normal] = menu.children;
  assert.equal(menu.attributes.role, 'menu');
  assert.equal(toggle.attributes.role, 'menuitemcheckbox');
  assert.equal(toggle.attributes['aria-checked'], String(checked));
  assert.equal(toggle.children[0].children[0].className, 'ctx-check', 'visible checkbox');
  assert.equal(toggle.children[0].children[0].attributes['aria-hidden'], 'true');
  assert.equal(normal.attributes.role, 'menuitem');
  assert.equal(normal.attributes['aria-checked'], undefined, 'regular items remain unchanged');
  assert.equal(key('ArrowDown').defaultPrevented, true);
  assert.equal(document.activeElement, toggle);
  key('ArrowDown');
  assert.equal(document.activeElement, toggle, 'disabled item skipped');
  assert.equal(key(checked ? 'Enter' : ' ').defaultPrevented, true);
  assert.equal(toggled, true);
  assert.equal(document.body.children.length, 0, 'menu closes after choosing');
}
showMenu({ x: 10, y: 20, items: [{ label: 'Snap velocity values', checked: true, action() { assert.fail('cancel must not toggle'); } }] });
assert.equal(key('Escape').defaultPrevented, true);
assert.equal(document.body.children.length, 0);
closeMenu();
console.log('context menu tests passed');
