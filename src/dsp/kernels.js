// Kernel registry: kind name (DspHost.create(kind)) -> kernel class. Everything imported here
// is loaded into the AudioWorkletGlobalScope, so it must not touch the DOM or main-thread APIs.
import { BusKernel, NoneKernel } from './kernel.js';
import OscKernel from '../modules/osc.dsp.js';
import FilterKernel from '../modules/filter.dsp.js';
import ReverbKernel from '../modules/reverb.dsp.js';
import AmpKernel from '../modules/amp.dsp.js';
import DcBlockKernel from '../modules/dcblock.dsp.js';
import EqKernel from '../modules/eq.dsp.js';
import WaveshaperKernel from '../modules/waveshaper.dsp.js';
import OutKernel from '../modules/out.dsp.js';
import LfoKernel from '../modules/lfo.dsp.js';
import AdsrKernel from '../modules/adsr.dsp.js';
import Velocity2CtlKernel from '../modules/velocity2ctl.dsp.js';

export const KERNELS = {
  bus: BusKernel,
  none: NoneKernel,
  osc: OscKernel,
  filter: FilterKernel,
  reverb: ReverbKernel,
  amp: AmpKernel,
  dcblock: DcBlockKernel,
  eq: EqKernel,
  waveshaper: WaveshaperKernel,
  out: OutKernel,
  lfo: LfoKernel,
  adsr: AdsrKernel,
  velocity2ctl: Velocity2CtlKernel,
};
