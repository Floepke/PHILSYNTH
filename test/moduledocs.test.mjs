import assert from 'node:assert/strict';
import { modules, getModule } from '../src/modules/index.js';
import { DOCS, paramDoc, moduleDocs } from '../src/moduledocs.js';

// every module type (the Output included) has a summary and a description for every controller
const all = [getModule('OUT'), ...modules];
for (const def of all) {
  const d = DOCS[def.type];
  assert.ok(d, `${def.type} has docs`);
  assert.ok(d.summary?.length > 40, `${def.type} has a summary`);
  assert.ok(Array.isArray(d.notes), `${def.type} notes is a list`);
  for (const p of def.params ?? []) assert.ok(paramDoc(def.type, p)?.length > 10, `${def.type}.${p.id} is described`);
  // no stale entries for controllers that no longer exist
  for (const id of Object.keys(d.params)) assert.ok(def.params.some((p) => p.id === id), `${def.type}.${id} exists`);
}
assert.deepEqual(Object.keys(DOCS).sort(), all.map((d) => d.type).sort(), 'no docs for unknown module types');

// Patch: mapped controllers (map1, map2 …) get the generic mapped text
assert.match(paramDoc('PATCH', { id: 'map3', label: 'Cutoff' }), /Mapped controller/);
assert.equal(paramDoc('NOPE', { id: 'x' }), null);

{
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ children: [], append(...children) { this.children.push(...children); } }),
  };
  try {
    const docs = moduleDocs(getModule('PATCH'), [
      ...getModule('PATCH').params, { id: 'map1', label: 'Cutoff', number: 11 },
    ]);
    const list = docs.children.find((e) => e.className === 'md-params');
    assert.deepEqual(list.children.filter((_, i) => i % 2 === 0).map((e) => e.children[0].textContent), [0, 1, 11]);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

console.log('moduledocs tests passed');
