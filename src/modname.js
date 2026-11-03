// Name of a module as shown on its box in the patcher: its custom name (Rename…) or the default
// from its type ("Output", "Patch", else the type, e.g. "OSC").
export const defaultName = (def) => (def.isOutput ? 'Output' : def.type === 'PATCH' ? 'Patch' : def.type);
export const moduleName = (m) => m.name || defaultName(m.def);
