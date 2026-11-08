import Velocity2CtlKernel from './velocity2ctl.dsp.js';
import { startPhase } from './osc.dsp.js';

export default class Phase2CtlKernel extends Velocity2CtlKernel {
  message(m) {
    if (m.type === 'noteOn') {
      this.lastId = m.id;
      this.set(startPhase(m.phase));
    } else if (m.type !== 'noteMod') super.message(m);
  }
}
