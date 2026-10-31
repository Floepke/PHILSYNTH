const TYPES = ['Amp modulation', 'Phase modulation', 'Phase modulation absolute',
  'Add', 'Subtract', 'Min', 'Max', 'Bitwise AND', 'Bitwise XOR', 'Min abs', 'Max abs'];

export default {
  type: 'MODULATOR',
  color: '#bb7298',
  label: 'Modulator (audio)',
  acceptsMidi: false,
  hasInput: true,
  hasOutput: true,
  params: [
    { id: 'type', label: 'Modulation Type', min: 0, max: TYPES.length - 1, default: 0, step: 1, options: TYPES },
    { id: 'carrier', label: 'Carrier', min: 0, max: 0, default: 0, step: 1 },
    { id: 'interpolation', label: 'Phase Modulation Interpolation', min: 0, max: 2, default: 1, step: 1, options: ['Off', 'Linear', 'Spline'] },
  ],
  create(_ctx, def, host) {
    const node = host.dsp.create('modulator');
    let entry;
    let patch;
    return {
      node,
      input: node,
      attach(e, rt) { entry = e; patch = rt; },
      params() {
        const inputs = [...node.inputs];
        return def.params.map((p) => p.id !== 'carrier' ? p : {
          ...p,
          max: Math.max(0, inputs.length - 1, entry?.values.carrier | 0),
          format(v) {
            const source = inputs[v | 0];
            if (!source) return `Input ${v + 1} (not connected)`;
            const m = [...patch.modules.values()].find((e) => e.inst.node === source);
            return m ? `Input ${v + 1}: #${m.id} ${m.name || m.def.type}` : `Input ${v + 1} (patch input)`;
          },
        });
      },
      setParam: (id, value) => node.param(id, value),
      destroy: () => node.destroy(),
    };
  },
};
