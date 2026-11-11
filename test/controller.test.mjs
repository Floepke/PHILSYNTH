// Run: node test/controller.test.mjs   (panel controller: snapping to fixed values)
import assert from 'node:assert/strict';

class Element extends EventTarget {
  constructor() {
    super();
    const props = {};
    const classes = new Set();
    this.children = [];
    this.attributes = {};
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
};

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
  fire(el, 'wheel', { deltaY: -100, timeStamp: 1000 });
  assert.equal(values.freq, SYNCED_FREQS[i + 1], `${type}: one wheel click = next note value`);
  fire(el, 'wheel', { deltaY: 100, timeStamp: 2000 });
  fire(el, 'wheel', { deltaY: 100, timeStamp: 3000 });
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
  fire(ctl.el, 'wheel', { deltaY: -100, timeStamp: 1000 });
  assert.equal(value, 6.01, 'Drift: scroll up increases depth by one cent');
  fire(ctl.el, 'wheel', { deltaY: 100, timeStamp: 2000 });
  assert.equal(value, 6, 'Drift: scroll down decreases depth by one cent');
  fire(ctl.el, 'wheel', { deltaY: -100, shiftKey: true, timeStamp: 3000 });
  assert.equal(value, 6.01, 'Drift: Shift also moves one cent');
  value = p.max;
  ctl.show(value);
  fire(ctl.el, 'wheel', { deltaY: -100, timeStamp: 4000 });
  assert.equal(value, p.max, 'Drift cannot scroll above 1200 cents');
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
  fire(ctl.el, 'wheel', { deltaY: -100, timeStamp: 2000 });
  assert.deepEqual(got, [2], 'unlocked slider accepts input again');
}
console.log('controller tests passed');
