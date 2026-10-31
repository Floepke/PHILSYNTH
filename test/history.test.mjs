import assert from 'node:assert/strict';
import { createHistory } from '../src/history.js';

let state = { clips: [], modules: [] };
const restored = [];
const history = createHistory({
  capture: () => structuredClone(state),
  restore: async (snapshot) => {
    state = snapshot;
    restored.push(structuredClone(snapshot));
  },
});

history.reset();
state.clips.push('clip');
history.record();
history.flush();
assert.equal(await history.travel(-1), true);
assert.deepEqual(state.clips, []);
assert.equal(await history.travel(1), true);
assert.deepEqual(state.clips, ['clip']);
assert.equal(restored.length, 2);

state.modules.push('module');
history.record();
history.flush();
assert.equal(await history.travel(-1), true);
assert.deepEqual(state.modules, []);
state.clips.push('new branch');
history.record();
history.flush();
assert.equal(await history.travel(1), false, 'a new edit clears the redo branch');

await history.suspend(async () => {
  state.modules.push('loaded module');
  history.record();
});
assert.equal(await history.travel(-1), true);
assert.deepEqual(state.modules, []);
assert.equal(await history.travel(-1), true);
assert.equal(await history.travel(-1), false);

state = { clips: [], modules: [] };
history.reset();
history.begin();
state.clips.push('grouped clip');
history.record();
state.modules.push('grouped module');
history.record();
history.end();
assert.equal(await history.travel(-1), true);
assert.deepEqual(state, { clips: [], modules: [] }, 'a grouped gesture is one undo step');
assert.equal(await history.travel(-1), false);

console.log('project history tests passed');
