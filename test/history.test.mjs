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

// only a change in the key makes a step: a modulated value moving between edits does not
let song = { notes: [], lfo: 0 };
const keyed = createHistory({
  capture: () => structuredClone(song),
  restore: async (snapshot) => { song = snapshot; },
  key: ({ notes }) => JSON.stringify(notes),
});
keyed.reset();
song.notes.push('note');
keyed.record();
keyed.flush();
song.lfo = 0.7;
keyed.record();
keyed.flush();
assert.equal(await keyed.travel(-1), true);
assert.deepEqual(song.notes, [], 'the first undo removes the note, not only the moved LFO value');
assert.equal(await keyed.travel(-1), false);
assert.equal(await keyed.travel(1), true);
assert.deepEqual(song, { notes: ['note'], lfo: 0 }, 'a step restores its full snapshot');

console.log('project history tests passed');
