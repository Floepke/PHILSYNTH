// Run: node test/controller.test.mjs   (panel controller: snapping to fixed values)
import assert from 'node:assert/strict';

class Element extends EventTarget {
  constructor() {
    super();
    const props = {};
    const classes = new Set();
    this.children = [];
    this.attributes = {};
    this.isConnected = true;
    this.props = props;
    this.classes = classes;
    this.style = { setProperty: (k, v) => { props[k] = String(v); } };
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    };
  }
  append(...c) { this.children.push(...c); }
  setAttribute(k, v) { this.attributes[k] = v; }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  getBoundingClientRect() { return { width: 100 }; }
}
globalThis.document = { createElement: () => new Element() };
globalThis.window = new EventTarget();

const { createController } = await import('../src/controller.js');
const { getModule } = await import('../src/modules/index.js');
const { lfoRateHz, SYNCED_FREQS } = await import('../src/modules/lfo.dsp.js');

const fire = (el, type, props = {}) => {
  const e = new Event(type, { cancelable: true });
  const { timeStamp = 0, ...rest } = props;
  Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  Object.assign(e, { button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, ...rest });
  el.dispatchEvent(e);
  return e;
};

{
  const p = getModule('RECORDER').params.find((p) => p.id === 'lane');
  let lane = 12;
  const ctl = createController(p, { index: 1, value: lane, format: String, onInput: (v) => { lane = v; } });
  const wheel = fire(ctl.el, 'wheel', { deltaY: -100, timeStamp: 1000 });
  assert.equal(lane, 12, 'wheel over a controller no longer changes its value');
  assert.equal(wheel.defaultPrevented, false, 'wheel bubbles through to scroll the controller panel');
  const buttons = ctl.el.children.find((el) => el.className === 'ctl-buttons').children;
  fire(buttons[1], 'click');
  assert.equal(lane, 13, 'increase button advances exactly one custom step');
  fire(buttons[0], 'click');
  assert.equal(lane, 12, 'decrease button reverses one custom step');
}

for (const type of ['LFO', 'VIBRATO']) {
  const p = getModule(type).params.find((x) => x.id === 'freq');
  const values = { unit: 0, freq: 1 };
  const got = [];
  const ctl = createController(p, { index: 0, value: values.freq, values: () => values, format: String, onInput: (v) => { values.freq = v; got.push(v); } });
  const { el } = ctl;
  assert.equal(el.classes.has('ticked'), false, `${type}: Hz is continuous`);
  fire(el, 'pointerdown', { clientX: 0 });
  fire(el, 'pointermove', { clientX: 3 });
  fire(el, 'pointerup');
  assert.ok(!SYNCED_FREQS.includes(values.freq), `${type}: Hz drag is free`);

  // synced unit: ticks at every note value, drags and wheel clicks land on them
  values.unit = 1;
  values.freq = 1;
  ctl.show(values.freq);
  assert.equal(el.classes.has('ticked'), true, `${type}: synced shows ticks`);
  assert.equal(el.props['--tick-pos'].split(',').length, SYNCED_FREQS.length);
  fire(el, 'pointerdown', { clientX: 0 });
  for (let x = 1; x <= 40; x++) {
    fire(el, 'pointermove', { clientX: -x });
    assert.ok(SYNCED_FREQS.includes(values.freq), `${type}: drag snaps (${values.freq})`);
  }
  fire(el, 'pointerup');
  const i = SYNCED_FREQS.indexOf(values.freq);
  assert.ok(i > 0 && i < SYNCED_FREQS.length - 1, `${type}: dragged to an inner value (${values.freq})`);
  const buttons = el.children.find((el) => el.className === 'ctl-buttons').children;
  fire(buttons[1], 'click');
  assert.equal(values.freq, SYNCED_FREQS[i + 1], `${type}: increase button = next note value`);
  fire(buttons[0], 'click');
  fire(buttons[0], 'click');
  assert.equal(values.freq, SYNCED_FREQS[i - 1]);
  // every snapped value plays its own note value
  const rates = SYNCED_FREQS.map((f) => lfoRateHz(f, 1, 120));
  assert.equal(new Set(rates).size, SYNCED_FREQS.length);

  // back to Hz: continuous again
  values.unit = 0;
  ctl.show(values.freq);
  assert.equal(el.classes.has('ticked'), false);
}
{
  const p = getModule('MULTIMIDI').params.find((x) => x.id === 'drift');
  let value = 6;
  const ctl = createController(p, { index: 0, value, format: p.format, onInput: (v) => { value = v; } });
  const buttons = ctl.el.children.find((el) => el.className === 'ctl-buttons').children;
  fire(buttons[1], 'click');
  assert.equal(value, 6.0001, 'Drift: increase preserves wheelStep (0.01 cent)');
  fire(buttons[0], 'click');
  assert.equal(value, 6, 'Drift: decrease preserves wheelStep (0.01 cent)');
  value = p.max;
  ctl.show(value);
  fire(buttons[1], 'click');
  assert.equal(value, p.max, 'Drift cannot increase above 1200 cents');
}
{
  const p = { label: 'Amount', min: 0, max: 100, default: 50 };
  let value = p.default;
  const ctl = createController(p, { index: 0, value, format: String, onInput: (v) => { value = v; } });
  const buttons = ctl.el.children.find((el) => el.className === 'ctl-buttons').children;
  fire(buttons[1], 'click');
  assert.equal(value, 50.01, '0..100 controllers increment by 0.01');
  fire(buttons[0], 'click');
  assert.equal(value, 50);
}
{
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimer = 0;
  globalThis.setTimeout = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const tick = (expectedDelay) => {
    assert.equal(timers.size, 1);
    const [id, timer] = timers.entries().next().value;
    assert.equal(timer.delay, expectedDelay);
    timers.delete(id);
    timer.fn();
  };
  try {
    const p = { label: 'Amount', min: 0, max: 100, step: 0.01 };
    let value = 50;
    let begins = 0;
    let ends = 0;
    const ctl = createController(p, {
      index: 0, value, format: String, onInput: (v) => { value = v; },
      onBegin: () => begins++, onEnd: () => ends++,
    });
    const [down, up] = ctl.el.children.find((el) => el.className === 'ctl-buttons').children;
    fire(up, 'pointerdown');
    assert.equal(value, 50.01, 'press steps immediately');
    tick(350);
    tick(50);
    assert.equal(value, 50.03, 'holding repeats the configured step');
    fire(up, 'pointerup');
    fire(up, 'click', { detail: 1 });
    assert.equal(value, 50.03, 'pointer release does not add another step');
    assert.equal(timers.size, 0, 'release cancels repeat');
    assert.equal(begins, 1);
    assert.equal(ends, 1, 'a hold is one undo gesture');

    fire(down, 'pointerdown');
    tick(350);
    fire(window, 'blur');
    assert.equal(value, 50.01, 'holding decrease repeats in the other direction');
    assert.equal(timers.size, 0, 'window blur cancels repeat');
    assert.equal(ends, 2);

    fire(up, 'pointerdown');
    p.disabled = true;
    ctl.show(value);
    assert.equal(timers.size, 0, 'disabling a controller cancels repeat');
    assert.equal(ends, 3);
    p.disabled = false;
    ctl.show(value);
    fire(up, 'click', { detail: 0 });
    assert.equal(value, 50.03, 'non-pointer button activation still steps once');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}
{
  let locked = true;
  const got = [];
  let begins = 0;
  const p = {
    label: 'Instances', min: 1, default: 1, step: 1,
    get max() { return locked ? 1 : 16; },
    get disabled() { return locked; },
    disabledReason: 'Instances are managed by a parent PATCH',
  };
  const ctl = createController(p, {
    index: 1, value: 1, format: String, onInput: (v) => got.push(v), onBegin: () => begins++,
  });
  assert.equal(ctl.el.attributes['aria-disabled'], true);
  assert.match(ctl.el.title, /parent PATCH/);
  fire(ctl.el, 'pointerdown', { clientX: 0 });
  fire(ctl.el, 'pointermove', { clientX: 100 });
  fire(ctl.el, 'pointerup');
  fire(ctl.el, 'wheel', { deltaY: -100, timeStamp: 1000 });
  fire(ctl.el, 'dblclick');
  assert.deepEqual(got, [], 'locked sliders ignore drag, wheel and reset');
  assert.equal(begins, 0, 'locked sliders do not start undo gestures');
  locked = false;
  ctl.show(1);
  assert.equal(ctl.el.attributes['aria-disabled'], false);
  assert.equal(ctl.el.attributes['aria-valuemax'], 16);
  const buttons = ctl.el.children.find((el) => el.className === 'ctl-buttons').children;
  fire(buttons[1], 'click');
  assert.deepEqual(got, [2], 'unlocked slider accepts input again');
}
console.log('controller tests passed');
