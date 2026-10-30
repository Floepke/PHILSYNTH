// Register stock modules here. Add a new file + one line to extend.
import out from './out.js';
import osc from './osc.js';
import multimidi from './multimidi.js';
import filter from './filter.js';
import amp from './amp.js';
import dcblock from './dcblock.js';
import eq from './eq.js';
import reverb from './reverb.js';
import lfo from './lfo.js';
import adsr from './adsr.js';
import waveshaper from './waveshaper.js';
import velocity2ctl from './velocity2ctl.js';
import multictl from './multictl.js';
import patch from './patch.js';

const all = [out, osc, multimidi, filter, eq, waveshaper, amp, dcblock, reverb, lfo, adsr, velocity2ctl, multictl, patch];

export const getModule = (type) => all.find((m) => m.type === type);
// Modules offered in the insert dialog (system modules like OUT are excluded)
export const modules = all.filter((m) => !m.system);
