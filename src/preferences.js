export const PREFERENCES_KEY = 'philsynth:preferences';
export const PREFERENCES_FORMAT = 'philsynth-preferences';

export function parsePreferences(text) {
  const data = JSON.parse(text);
  if (!data || data.format !== PREFERENCES_FORMAT || data.version !== 1 ||
      !data.values || typeof data.values !== 'object' || Array.isArray(data.values)) {
    throw new Error('Invalid or unsupported preferences file');
  }
  return data.values;
}

export function preferencesStorage() {
  const native = globalThis.modsynthPreferences;
  if (native) return { load: () => native.load(), save: (text) => native.save(text) };
  return {
    load: async () => localStorage.getItem(PREFERENCES_KEY),
    save: async (text) => localStorage.setItem(PREFERENCES_KEY, text),
  };
}

export function createPreferencesManager({ storage = preferencesStorage() } = {}) {
  const definitions = new Map();
  let values = {};
  let loaded = false;
  let saving = false;
  const definition = (id) => {
    const item = definitions.get(id);
    if (!item) throw new Error(`Unknown preference "${id}"`);
    return item;
  };
  function validate(item, value) {
    const valid = item.type === 'color' ? typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value)
      : item.type === 'boolean' ? typeof value === 'boolean'
        : item.type === 'number' ? Number.isFinite(value) && value >= item.min && value <= item.max
          : item.type === 'shortcuts' ? !!value && typeof value === 'object' && !Array.isArray(value)
            : item.type === 'select' && typeof value === 'string' &&
              (typeof item.options === 'function' ? item.options(value) : item.options).some((o) => o.value === value);
    if (!valid || (item.validate && !item.validate(value))) throw new Error(`Invalid value for ${item.label}`);
  }
  const get = (id) => {
    const item = definition(id);
    return Object.hasOwn(values, id) ? values[id] : item.defaultValue;
  };
  function applyAll() {
    for (const item of definitions.values()) item.apply?.(get(item.id));
  }
  return {
    register(item) {
      if (!item || !/^[a-z][a-zA-Z0-9.-]*$/.test(item.id) || !item.category?.trim() || !item.label?.trim()) {
        throw new Error('A preference needs an id, category and label');
      }
      if (definitions.has(item.id)) throw new Error(`Preference "${item.id}" is already registered`);
      if (!['color', 'boolean', 'number', 'select', 'shortcuts'].includes(item.type)) throw new Error(`Unsupported preference type "${item.type}"`);
      if (item.type === 'number' && (!Number.isFinite(item.min) || !Number.isFinite(item.max) || item.min > item.max)) {
        throw new Error('Number preferences need a valid min and max');
      }
      const options = typeof item.options === 'function' ? item.options(item.defaultValue) : item.options;
      if (item.type === 'select' && (!Array.isArray(options) || !options.length ||
          options.some((o) => typeof o.value !== 'string' || typeof o.label !== 'string'))) {
        throw new Error('Select preferences need labeled string options');
      }
      const registered = structuredClone({ ...item, apply: undefined, validate: undefined, refresh: undefined,
        options: typeof item.options === 'function' ? undefined : item.options });
      registered.apply = item.apply;
      registered.validate = item.validate;
      registered.refresh = item.refresh;
      if (typeof item.options === 'function') registered.options = item.options;
      validate(registered, registered.defaultValue);
      if (Object.hasOwn(values, item.id)) validate(registered, values[item.id]);
      definitions.set(item.id, registered);
      registered.apply?.(get(item.id));
    },
    entries: () => [...definitions.values()],
    get,
    hasStored: (id) => Object.hasOwn(values, id),
    async load() {
      if (loaded) throw new Error('Preferences have already been loaded');
      const text = await storage.load();
      const next = text === null ? {} : parsePreferences(text);
      for (const item of definitions.values()) if (Object.hasOwn(next, item.id)) validate(item, next[item.id]);
      values = next;
      loaded = true;
      applyAll();
    },
    preview(id, value) {
      const item = definition(id);
      validate(item, value);
      item.apply?.(value);
    },
    restore: applyAll,
    async save(changes) {
      if (saving) throw new Error('Preferences are already being saved');
      for (const [id, value] of Object.entries(changes)) validate(definition(id), value);
      const next = { ...values, ...changes };
      saving = true;
      try {
        await storage.save(JSON.stringify({ format: PREFERENCES_FORMAT, version: 1, values: next }, null, 2) + '\n');
        values = next;
        applyAll();
      } finally {
        saving = false;
      }
    },
  };
}
