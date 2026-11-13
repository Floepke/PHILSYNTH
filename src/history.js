const DEFAULT_LIMIT = 200;
const DEFAULT_DELAY = 300;

// key(state): what counts as a change; a snapshot with the same key as the current step is no new step
export function createHistory({ capture, restore, key = (state) => JSON.stringify(state), limit = DEFAULT_LIMIT, delay = DEFAULT_DELAY }) {
  let stack = [];
  let index = -1;
  let timer = null;
  let suspended = 0;
  let restoring = false;
  let groups = 0;
  let pending = false;

  const snapshot = () => {
    const state = capture();
    return { json: JSON.stringify(state), key: key(state) };
  };
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const commit = () => {
    const next = snapshot();
    if (next.key === stack[index]?.key) return;
    stack.length = index + 1;
    stack.push(next);
    if (stack.length > limit) stack.shift();
    index = stack.length - 1;
  };

  return {
    reset() {
      clearTimer();
      pending = false;
      groups = 0;
      stack = [snapshot()];
      index = 0;
    },
    record() {
      if (suspended || restoring || index < 0) return;
      if (groups) {
        pending = true;
        return;
      }
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        commit();
      }, delay);
    },
    flush() {
      if (timer === null) return;
      clearTimer();
      commit();
    },
    begin() {
      if (groups === 0) this.flush();
      groups++;
    },
    end() {
      if (!groups) return;
      groups--;
      if (!groups && pending) {
        pending = false;
        commit();
      }
    },
    async group(action) {
      this.begin();
      try {
        return await action();
      } finally {
        this.end();
      }
    },
    async travel(direction) {
      if (restoring) return false;
      this.flush();
      const next = index + direction;
      if (next < 0 || next >= stack.length) return false;
      restoring = true;
      try {
        await restore(JSON.parse(stack[next].json));
        index = next;
        return true;
      } finally {
        restoring = false;
      }
    },
    async suspend(action) {
      this.flush();
      clearTimer();
      suspended++;
      try {
        return await action();
      } finally {
        suspended--;
      }
    },
  };
}
