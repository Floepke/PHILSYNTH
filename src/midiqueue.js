// Stable, indexed min-heap for MIDI deadlines. Removing an expiry before extending it avoids
// accumulating stale cleanup entries while release-tail pitch/velocity updates keep arriving.
export class MidiQueue {
  constructor() { this.items = []; this.order = 0; }
  get first() { return this.items[0]; }
  before(a, b) { return a.due < b.due || (a.due === b.due && a.order < b.order); }
  put(i, item) { this.items[i] = item; item.index = i; }
  up(i, item) {
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (!this.before(item, this.items[parent])) break;
      this.put(i, this.items[parent]);
      i = parent;
    }
    this.put(i, item);
  }
  down(i, item) {
    const n = this.items.length;
    while (2 * i + 1 < n) {
      let child = 2 * i + 1;
      if (child + 1 < n && this.before(this.items[child + 1], this.items[child])) child++;
      if (!this.before(this.items[child], item)) break;
      this.put(i, this.items[child]);
      i = child;
    }
    this.put(i, item);
  }
  push(item) {
    item.order = this.order++;
    this.up(this.items.length, item);
    return item;
  }
  remove(item) {
    const i = item?.index;
    if (i === undefined || i < 0 || this.items[i] !== item) return;
    const last = this.items.pop();
    item.index = -1;
    if (last === item) return;
    if (i > 0 && this.before(last, this.items[(i - 1) >>> 1])) this.up(i, last);
    else this.down(i, last);
  }
  pop() {
    const item = this.first;
    this.remove(item);
    return item;
  }
  clear() {
    for (const item of this.items) item.index = -1;
    this.items = [];
    this.order = 0;
  }
}
