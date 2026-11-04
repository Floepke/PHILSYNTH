// Register stock modules here. Add a new file + one line to extend, and describe the module and
// every controller in src/moduledocs.js (test/moduledocs.test.mjs fails otherwise).
import out from './out.js';
import osc from './osc.js';
import operator from './operator.js';
import sampler from './sampler.js';
import wavetable from './wavetable.js';
import imagesampler from './imagesampler.js';
import multimidi from './multimidi.js';
import strum from './strum.js';
import trill from './trill.js';
import tuning from './tuning.js';
import filter from './filter.js';
import amp from './amp.js';
import dcblock from './dcblock.js';
import eq from './eq.js';
import reverb from './reverb.js';
import lfo from './lfo.js';
import adsr from './adsr.js';
import envelope from './envelope.js';
import waveshaper from './waveshaper.js';
import distortion from './distortion.js';
import vibrato from './vibrato.js';
import velocity2ctl from './velocity2ctl.js';
import pitch2ctl from './pitch2ctl.js';
import sound2ctl from './sound2ctl.js';
import multictl from './multictl.js';
import patch from './patch.js';
import delay from './delay.js';
import echo from './echo.js';
import modulator from './modulator.js';
import input from './input.js';
import compressor from './compressor.js';

const all = [out, osc, operator, sampler, wavetable, imagesampler, input, multimidi, strum, trill, tuning, filter, eq, waveshaper, distortion, amp, compressor, dcblock, delay, echo, vibrato, modulator, reverb, lfo, adsr, envelope, velocity2ctl, pitch2ctl, sound2ctl, multictl, patch];

export const getModule = (type) => all.find((m) => m.type === type);
// Modules offered in the insert dialog (system modules like OUT are excluded)
export const modules = all.filter((m) => !m.system);
