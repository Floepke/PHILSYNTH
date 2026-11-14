// Real-time priority for the calling thread, used by the PATCH instance workers in the desktop app
// (src/dsp/instanceworker.js; Node in workers: nodeIntegrationInWorker in electron/main.mjs).
// The AudioWorklet thread already runs at real-time priority; normal-priority workers are woken
// late by the OS now and then (most when the app is in the background), and a late worker's
// copies drop out for that block. Calls the OS through koffi (no compiled addon of our own):
// - macOS: THREAD_TIME_CONSTRAINT_POLICY, the policy Core Audio threads use, with a period of
//   one audio block
// - Windows: MMCSS task "Pro Audio" at high priority (avrt.dll)
// - Linux: SCHED_FIFO; needs an rtprio limit (e.g. the audio group), else it is refused
// requestRealtime(sampleRate, frames) -> { ok, platform, error? }; it never throws.
'use strict';

function darwin(koffi, sampleRate, frames) {
  const sys = koffi.load('/usr/lib/libSystem.B.dylib');
  const pthreadSelf = sys.func('void *pthread_self()');
  const machThread = sys.func('uint32_t pthread_mach_thread_np(void *thread)');
  const timebase = sys.func('int mach_timebase_info(_Out_ uint32_t *info)');
  const policySet = sys.func('int thread_policy_set(uint32_t thread, uint32_t flavor, uint32_t *policy, uint32_t count)');
  const tb = new Uint32Array(2); // numer, denom: mach absolute time units per nanosecond
  if (timebase(tb) !== 0 || !tb[0] || !tb[1]) throw new Error('mach_timebase_info failed');
  const ticks = (ms) => Math.round(ms * 1e6 * tb[1] / tb[0]);
  const period = frames / sampleRate * 1000;
  // period, computation (CPU time needed per period), constraint (deadline), preemptible
  const policy = new Uint32Array([ticks(period), ticks(period / 2), ticks(period), 1]);
  const THREAD_TIME_CONSTRAINT_POLICY = 2;
  const res = policySet(machThread(pthreadSelf()), THREAD_TIME_CONSTRAINT_POLICY, policy, policy.length);
  if (res !== 0) throw new Error(`thread_policy_set failed (${res})`);
}

function win32(koffi) {
  const avrt = koffi.load('avrt.dll');
  const characteristics = avrt.func('void * __stdcall AvSetMmThreadCharacteristicsW(str16 task, _Inout_ uint32_t *index)');
  const priority = avrt.func('int __stdcall AvSetMmThreadPriority(void *handle, int priority)');
  const handle = characteristics('Pro Audio', [0]);
  if (!handle) throw new Error('AvSetMmThreadCharacteristicsW failed');
  const AVRT_PRIORITY_HIGH = 1;
  if (!priority(handle, AVRT_PRIORITY_HIGH)) throw new Error('AvSetMmThreadPriority failed');
}

function linux(koffi) {
  const libc = koffi.load('libc.so.6');
  const pthreadSelf = libc.func('unsigned long pthread_self()');
  const setSched = libc.func('int pthread_setschedparam(unsigned long thread, int policy, int *param)');
  const SCHED_FIFO = 1;
  // below the audio servers (PipeWire/JACK use 20 and up)
  const res = setSched(pthreadSelf(), SCHED_FIFO, new Int32Array([10]));
  if (res !== 0) throw new Error(`pthread_setschedparam(SCHED_FIFO) refused (${res === 1 ? 'no rtprio permission' : `error ${res}`})`);
}

const PLATFORMS = { darwin, win32, linux };

exports.requestRealtime = (sampleRate, frames = 128) => {
  const platform = process.platform;
  try {
    const request = PLATFORMS[platform];
    if (!request) throw new Error('not supported on this platform');
    request(require('koffi'), sampleRate, frames);
    return { ok: true, platform };
  } catch (err) {
    return { ok: false, platform, error: String(err?.message ?? err) };
  }
};
