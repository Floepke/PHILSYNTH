import velocity2ctl from './velocity2ctl.js';
import { modulatorParams } from './modtarget.js';

export default {
  ...velocity2ctl,
  type: 'PHASE2CTL',
  color: '#ad65ce',
  label: 'PHASE2CTL (phase → controller)',
  create(_ctx, def, host) {
    const node = host.dsp.create('phase2ctl');
    const send = m => node.send(m);
    const inst = {
      node,
      input: null,
      getTargets: () => [],
      params: () => modulatorParams(inst, def),
      setParam: (id, v) => node.param(id, v),
      noteOn: (id, _pitch, _velocity, phase = 0) => send({ type: 'noteOn', id, phase }),
      noteMod() {},
      noteOff: id => send({ type: 'noteOff', id }),
      allOff: () => send({ type: 'allOff' }),
      destroy: () => node.destroy(),
    };
    return inst;
  },
};
