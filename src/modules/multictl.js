// MULTICTL: one controller (Value) that drives any number of controllers of the modules it is
// cabled to (control cables, Shift + drag). Unlike the LFO's single Out Controller, every
// connected module gets its own list of routed controllers, picked in the panel below Value:
// e.g. one MULTICTL cabled to three OSCs sets all three Decays at once.
//   Value: 0..100 %, mapped through Out Min..Out Max (% of each target's slider range).
//   state.routes: [{ to: module id, param: controller id, key }], saved with the project.
// Every route has its own range too: controllers r<key>Min / r<key>Max (numbered after Out Max,
// in route order, so automation clips and LFOs can drive them) map Out Min..Out Max once more
// onto that route's part of the target's range (0..100 % = unchanged; Min > Max inverts it).
// Connecting it to a module of a type it already routes (another OSC) copies those routes, and
// picking a controller for one module also routes it on connected modules of the same type that
// have none yet, so "all Decays" takes one pick.
// DSP: multictl.dsp.js (the engine graph applies the value, like for the LFO).
import { outParams } from './modtarget.js';
import { fromNorm, paramsOf, toNorm, controllerNumber } from '../params.js';
import { colorOf } from '../modcolor.js';
import { moduleName as labelOf } from '../modname.js';
import { createController } from '../controller.js';

const pct1 = (v) => `${(+v).toFixed(1)} %`;
const OUT = outParams().filter((p) => p.id === 'outMin' || p.id === 'outMax'); // preserve dynamic route controller numbers

const RANGE_ID = /^r(\d+)(Min|Max)$/;
export const rangeIds = (key) => [`r${key}Min`, `r${key}Max`];

// unused route key: above every key in `routes` and every range controller left in `values`
// (copies keep stale ones for a moment), so a new route never inherits an old range
export function nextRouteKey(routes, values = {}) {
  let n = 1;
  for (const r of routes) if (Number.isInteger(r.key)) n = Math.max(n, r.key + 1);
  for (const k of Object.keys(values)) {
    const m = RANGE_ID.exec(k);
    if (m) n = Math.max(n, +m[1] + 1);
  }
  return n;
}

export function normalizeRoutes(state) {
  const seen = new Set();
  const keys = new Set();
  const routes = [];
  for (const r of Array.isArray(state?.routes) ? state.routes : []) {
    const to = Number(r?.to);
    if (!Number.isInteger(to) || to < 0 || typeof r.param !== 'string') continue;
    const id = `${to}\u0000${r.param}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const key = Number.isInteger(r.key) && r.key > 0 && !keys.has(r.key) ? r.key : undefined;
    if (key) keys.add(key);
    routes.push({ to, param: r.param, key });
  }
  // routes without (a unique) key, e.g. from projects saved before route ranges, get new ones
  let next = nextRouteKey(routes);
  for (const r of routes) r.key ??= next++;
  return { routes };
}

const has = (t, pid) => paramsOf(t).some((p) => p.id === pid);

// Routes for target `t` after a new cable: keep its still-valid routes, else copy the routes of
// a connected module of the same type (with their ranges, when `values` are given).
export function routesOnConnect(state, values, t, targets) {
  const routes = state.routes.filter((r) => r.to !== t.id || has(t, r.param));
  if (routes.some((r) => r.to === t.id)) return { routes };
  for (const o of targets) {
    if (o === t || o.def.type !== t.def.type) continue;
    const copy = routes.filter((r) => r.to === o.id && has(t, r.param));
    if (!copy.length) continue;
    let key = nextRouteKey(routes, values);
    return {
      routes: [...routes, ...copy.map((r) => {
        const k = key++;
        if (values) rangeIds(k).forEach((id, i) => { values[id] = values[rangeIds(r.key)[i]] ?? (i ? 100 : 0); });
        return { to: t.id, param: r.param, key: k };
      })],
    };
  }
  return { routes };
}

// keeps the route range controllers in entry.values in step with the routes: new routes get
// 0..100 %, removed ones are dropped. `send(id, v)` passes new values on to the DSP.
export function syncRanges(entry, send) {
  const keep = new Set();
  for (const r of entry.state.routes) {
    rangeIds(r.key).forEach((id, i) => {
      keep.add(id);
      if (!Number.isFinite(entry.values[id])) {
        entry.values[id] = i ? 100 : 0;
        send?.(id, entry.values[id]);
      }
    });
  }
  for (const k of Object.keys(entry.values)) if (RANGE_ID.test(k) && !keep.has(k)) delete entry.values[k];
}

const clamp100 = (v) => Math.max(0, Math.min(100, v));

// the route range controllers, numbered after Out Max in route order (hidden from the controller
// list of the panel: the Routes view shows them next to their route)
let naming = false; // two MULTICTLs cabled into each other would name each other's ranges forever
function rangeParams(entry, targets) {
  const out = [];
  const nested = naming;
  naming = true;
  try {
    for (const r of entry.state.routes) {
      const t = targets.find((m) => m.id === r.to);
      const p = t && !nested ? paramsOf(t).find((q) => q.id === r.param) : null;
      const name = `#${r.to} ${p?.label ?? r.param}`;
      const [lo, hi] = rangeIds(r.key);
      out.push(
        { id: lo, label: `${name} Min`, short: 'Min', min: 0, max: 100, default: 0, format: pct1, panel: false, route: r },
        { id: hi, label: `${name} Max`, short: 'Max', min: 0, max: 100, default: 100, format: pct1, panel: false, route: r },
      );
    }
  } finally {
    naming = nested;
  }
  return out;
}

// position 0..1 of route `r` on its target's slider for Value `v` (0..100 %)
function routePos(values, r, v) {
  const pos = ((values.outMin ?? 0) + ((values.outMax ?? 100) - (values.outMin ?? 0)) * (v / 100)) / 100;
  const [lo, hi] = rangeIds(r.key).map((id, i) => values[id] ?? (i ? 100 : 0));
  return (lo + (hi - lo) * pos) / 100;
}



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
  let minis = []; // the route range controllers shown: { id, show }
  const render = () => {
    minis = [];
    box.replaceChildren(el('h4', 'mc-title', 'Routes'));
    const targets = entry.inst.getTargets().sort((a, b) => a.id - b.id);
    if (!targets.length) {
      box.append(el('p', 'hint', 'Not connected. Shift + drag from this module over the modules it should control.'));
      return;
    }
    const routes = entry.state.routes;
    for (const t of targets) {
      const card = el('div', 'mc-target');
      if (colorOf(t)) card.style.setProperty('--mod-color', colorOf(t));
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
          const o = new Option(`${controllerNumber(p, i)} · ${p.label}`, p.id);
          o.disabled = p.id !== current && mine.some((r) => r.param === p.id);
          s.append(o);
        });
        s.value = current ?? '';
        if (!current) s.classList.add('mc-add');
        s.setAttribute('aria-label', current ? `Routed controller of ${labelOf(t)} #${t.id}` : `Add a controller of ${labelOf(t)} #${t.id}`);
        s.onchange = () => {
          let next;
          if (current && s.value) {
            // another controller for this route: it keeps its key, so its range and number stay
            next = routes.map((r) => (r.to === t.id && r.param === current ? { ...r, param: s.value } : r));
          } else {
            next = routes.filter((r) => !(r.to === t.id && r.param === current));
            if (s.value) {
              let key = nextRouteKey(next, entry.values);
              next.push({ to: t.id, param: s.value, key: key++ });
              // same controller on connected modules of this type that route nothing yet
              for (const o of targets) {
                if (o !== t && o.def.type === t.def.type && !next.some((r) => r.to === o.id) && has(o, s.value)) next.push({ to: o.id, param: s.value, key: key++ });
              }
            }
          }
          save(next);
        };
        return s;
      };
      const own = entry.inst.params();
      for (const r of mine) {
        const row = el('div', 'mc-route');
        row.append(pick(r.param));
        // this route's Out Min / Out Max: tiny controllers, automatable like any other
        for (const id of rangeIds(r.key)) {
          const index = own.findIndex((q) => q.id === id);
          if (index < 0) continue;
          const p = own[index];
          const ctl = createController({ ...p, label: p.short }, {
            index,
            value: entry.values[id],
            format: (v) => `${+(+v).toFixed(1)}%`, // compact: the tiny controllers are narrow
            onBegin: () => api.beginEdit?.(),
            onEnd: () => api.endEdit?.(),
            onInput: (v) => api.setParam(id, v),
          });
          ctl.el.classList.add('mc-mini');
          ctl.el.title = `${p.label} (controller ${index}) — this route's part of its controller's range; drag sideways or scroll (Shift: fine), double-click: reset`;
          if (colorOf(t)) ctl.el.style.setProperty('--mod-color', colorOf(t));
          minis.push({ id, show: ctl.show });
          row.append(ctl.el);
        }
        card.append(row);
      }
      if (mine.length < params.length) card.append(pick(null));
      box.append(card);
    }
  };
  render();
  // driven values (automation, LFO) and undo move the tiny controllers too
  const refresh = (values) => {
    for (const m of minis) if (Number.isFinite(values[m.id])) m.show(values[m.id]);
  };
  return { el: box, refresh };
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
  // the range controllers of the route to controller `pid` of `t` (the engine graph maps with them)
  routeRange(entry, t, pid) {
    const r = entry.state.routes.find((x) => x.to === t.id && x.param === pid);
    if (!r) return null;
    const [lo, hi] = rangeIds(r.key);
    return { lo, hi };
  },
  connected(entry, t, targets) {
    const before = new Set(entry.state.routes.map((r) => r.key));
    entry.state = routesOnConnect(entry.state, entry.values, t, targets);
    syncRanges(entry);
    // copied routes bring the range of the route they copy
    for (const r of entry.state.routes) if (!before.has(r.key)) for (const id of rangeIds(r.key)) entry.inst.setParam(id, entry.values[id]);
  },
  disconnected(entry, t) {
    entry.state = { routes: entry.state.routes.filter((r) => r.to !== t.id) };
    syncRanges(entry);
  },
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
      // Value shows the routed controller's value too when every route drives the same one;
      // the route range controllers follow Out Max (see rangeParams)
      params() {
        const e = inst.entry;
        if (!e) return def.params;
        const targets = inst.getTargets();
        const format = (v, values) => {
          const hits = [];
          for (const r of e.state.routes) {
            const t = targets.find((m) => m.id === r.to);
            const p = t && paramsOf(t).find((q) => q.id === r.param);
            if (p) hits.push({ t, p, x: fromNorm(p, routePos(values, r, v)) });
          }
          if (!hits.length) return `${pct1(v)} · (no routes)`;
          const labels = new Set(hits.map((h) => h.p.label));
          if (labels.size > 1) return `${pct1(v)} → ${hits.length} controllers`;
          const { t, p, x } = hits[0];
          if (hits.some((h) => h.x !== x)) return `${pct1(v)} → ${p.label} ×${hits.length}`; // own ranges
          const shown = p.format ? p.format(x, t.values) : p.options ? p.options[x] : String(+x.toFixed(3));
          return `${shown} · ${p.label}${hits.length > 1 ? ` ×${hits.length}` : ''}`;
        };
        return [...def.params.map((p) => (p.id === 'value' ? { ...p, format } : p)), ...rangeParams(e, targets)];
      },
      // routes changed (patch.setState, also on undo / Patch instance copies): their range controllers too
      setState() { if (inst.entry) syncRanges(inst.entry, (id, v) => node.param(id, v)); },
      // saved range values (addModule calls this after setState)
      restoreValues(values) {
        const e = inst.entry;
        if (!e || !values) return;
        for (const r of e.state.routes) {
          for (const id of rangeIds(r.key)) {
            if (!Number.isFinite(values[id])) continue;
            e.values[id] = clamp100(values[id]);
            node.param(id, e.values[id]);
          }
        }
      },
      setParam: (id, v) => node.param(id, v),
      destroy: () => node.destroy(),
    };
    return inst;
  },
};
