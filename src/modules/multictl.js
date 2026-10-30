// MULTICTL: one controller (Value) that drives any number of controllers of the modules it is
// cabled to (control cables, Shift + drag). Unlike the LFO's single Out Controller, every
// connected module gets its own list of routed controllers, picked in the panel below Value:
// e.g. one MULTICTL cabled to three OSCs sets all three Decays at once.
//   Value: 0..100 %, mapped through Out Min..Out Max (% of each target's slider range).
//   state.routes: [{ to: module id, param: controller id }], saved with the project.
// Connecting it to a module of a type it already routes (another OSC) copies those routes, and
// picking a controller for one module also routes it on connected modules of the same type that
// have none yet, so "all Decays" takes one pick.
// DSP: multictl.dsp.js (the engine graph applies the value, like for the LFO).
import { outParams } from './modtarget.js';
import { fromNorm, paramsOf, toNorm } from '../params.js';

const pct1 = (v) => `${(+v).toFixed(1)} %`;
const OUT = outParams().filter((p) => p.id !== 'outController'); // Out Min, Out Max

export function normalizeRoutes(state) {
  const seen = new Set();
  const routes = [];
  for (const r of Array.isArray(state?.routes) ? state.routes : []) {
    const to = Number(r?.to);
    if (!Number.isInteger(to) || to < 0 || typeof r.param !== 'string') continue;
    const key = `${to}\u0000${r.param}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ to, param: r.param });
  }
  return { routes };
}

const has = (t, pid) => paramsOf(t).some((p) => p.id === pid);

// Routes for target `t` after a new cable: keep its still-valid routes, else copy the routes of
// a connected module of the same type.
export function routesOnConnect(state, entry, t, targets) {
  const routes = state.routes.filter((r) => r.to !== t.id || has(t, r.param));
  if (routes.some((r) => r.to === t.id)) return { routes };
  for (const o of targets) {
    if (o === t || o.def.type !== t.def.type) continue;
    const copy = routes.filter((r) => r.to === o.id && has(t, r.param));
    if (copy.length) return { routes: [...routes, ...copy.map((r) => ({ to: t.id, param: r.param }))] };
  }
  return { routes };
}

const labelOf = (m) => m.name || (m.def.isOutput ? 'Output' : m.def.type);

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// Panel part below the controllers: one card per connected module with its routed controllers.
function routesView(entry, api) {
  const box = el('div', 'mc-view');
  const save = (routes) => {
    const before = entry.state.routes.length;
    api.setState({ routes });
    api.refresh?.();
    // the first route: start Value at that controller's current position, so nothing jumps
    if (!before && routes.length) {
      const r = routes[0];
      const t = entry.inst.getTargets().find((m) => m.id === r.to);
      const p = t && paramsOf(t).find((q) => q.id === r.param);
      if (p) {
        const { outMin = 0, outMax = 100 } = entry.values;
        const pos = toNorm(p, t.values[p.id]) * 100;
        const v = outMax === outMin ? 50 : ((pos - outMin) / (outMax - outMin)) * 100;
        api.setParam('value', Math.max(0, Math.min(100, +v.toFixed(1))));
      }
    }
    render();
  };
  const render = () => {
    box.replaceChildren(el('h4', 'mc-title', 'Routes'));
    const targets = entry.inst.getTargets().sort((a, b) => a.id - b.id);
    if (!targets.length) {
      box.append(el('p', 'hint', 'Not connected. Shift + drag from this module over the modules it should control.'));
      return;
    }
    const routes = entry.state.routes;
    for (const t of targets) {
      const card = el('div', 'mc-target');
      if (t.def.color) card.style.setProperty('--mod-color', t.def.color);
      const head = el('div', 'mc-head');
      const num = el('span', 'ctl-num', String(t.id));
      head.append(num, el('span', 'mc-name', labelOf(t)));
      card.append(head);
      const params = paramsOf(t);
      const mine = routes.filter((r) => r.to === t.id);
      const pick = (current) => {
        const s = el('select', 'mc-select');
        s.append(new Option(current ? '— remove —' : '+ route to controller…', ''));
        params.forEach((p, i) => {
          const o = new Option(`${i} · ${p.label}`, p.id);
          o.disabled = p.id !== current && mine.some((r) => r.param === p.id);
          s.append(o);
        });
        s.value = current ?? '';
        if (!current) s.classList.add('mc-add');
        s.setAttribute('aria-label', current ? `Routed controller of ${labelOf(t)} #${t.id}` : `Add a controller of ${labelOf(t)} #${t.id}`);
        s.onchange = () => {
          let next = routes.filter((r) => !(r.to === t.id && r.param === current));
          if (s.value) {
            next.push({ to: t.id, param: s.value });
            // same controller on connected modules of this type that route nothing yet
            if (!current) for (const o of targets) {
              if (o !== t && o.def.type === t.def.type && !next.some((r) => r.to === o.id) && has(o, s.value)) next.push({ to: o.id, param: s.value });
            }
          }
          save(next);
        };
        return s;
      };
      for (const r of mine) {
        const row = el('div', 'mc-route');
        row.append(pick(r.param));
        card.append(row);
      }
      if (mine.length < params.length) card.append(pick(null));
      box.append(card);
    }
  };
  render();
  return { el: box };
}

export default {
  type: 'MULTICTL',
  color: '#e8c547',
  label: 'MULTICTL (one controller → many)',
  acceptsMidi: false,
  hasInput: false,
  hasOutput: true,
  modulator: true,
  params: [
    { id: 'value', label: 'Value', min: 0, max: 100, default: 50, format: pct1 },
    ...OUT,
  ],
  defaultState: () => ({ routes: [] }),
  normalizeState: normalizeRoutes,
  // used by the patch (src/patch.js): controllers it drives on target `t`, and cable bookkeeping
  routeParams: (entry, t) => entry.state.routes.filter((r) => r.to === t.id).map((r) => r.param),
  connected(entry, t, targets) { entry.state = routesOnConnect(entry.state, entry, t, targets); },
  disconnected(entry, t) { entry.state = { routes: entry.state.routes.filter((r) => r.to !== t.id) }; },
  // copies of a group: routes follow the copied modules; routes to modules outside it are dropped
  remapState: (state, ids) => ({ routes: state.routes.filter((r) => ids.has(r.to)).map((r) => ({ ...r, to: ids.get(r.to) })) }),
  view: routesView,
  create(_ctx, def, host) {
    const node = host.dsp.create('multictl');
    const inst = {
      node,
      input: null,
      getTargets: () => [], // set by the patch: modules this module is cabled to
      entry: null,
      attach(entry) { inst.entry = entry; },
      // Value shows the routed controller's value too when every route drives the same one
      params() {
        const e = inst.entry;
        if (!e) return def.params;
        const format = (v, values) => {
          const pos = ((values.outMin ?? 0) + ((values.outMax ?? 100) - (values.outMin ?? 0)) * (v / 100)) / 100;
          const hits = [];
          for (const t of inst.getTargets()) {
            for (const pid of def.routeParams(e, t)) {
              const p = paramsOf(t).find((q) => q.id === pid);
              if (p) hits.push({ t, p });
            }
          }
          if (!hits.length) return `${pct1(v)} · (no routes)`;
          const labels = new Set(hits.map((h) => h.p.label));
          if (labels.size > 1) return `${pct1(v)} → ${hits.length} controllers`;
          const { t, p } = hits[0];
          const x = fromNorm(p, pos);
          const shown = p.format ? p.format(x, t.values) : p.options ? p.options[x] : String(+x.toFixed(3));
          return `${shown} · ${p.label}${hits.length > 1 ? ` ×${hits.length}` : ''}`;
        };
        return def.params.map((p) => (p.id === 'value' ? { ...p, format } : p));
      },
      setParam: (id, v) => node.param(id, v),
      destroy: () => node.destroy(),
    };
    return inst;
  },
};
