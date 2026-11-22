import { addAudioClip, LANE_H, meter, segAt } from '../song.js';
import { createRecordingBuffer, RecordingBuffer } from './recordingbuffer.js';

export class AudioRecorder {
  constructor({ engine, transport, song, patch, assets, onCommit, onState, onError }) {
    Object.assign(this, { engine, transport, song, patch, assets, onCommit, onState, onError });
    this.armed = false;
    this.sessions = new Set();
    this.token = 0;
  }

  inputs() {
    return [...this.patch().modules.values()].filter((entry) => entry.def.type === 'RECORDER' && entry.values.armed);
  }

  arm() {
    if (this.sessions.size) { this.onError('Wait for the previous audio recording to finish.'); return; }
    if (!this.inputs().length) { this.onError('Arm a RECORDER module first.'); return; }
    this.armed = true;
    this.onState();
  }

  start({ loop = false, fromStart = false } = {}) {
    if (this.sessions.size) { this.onError('Audio recording is already starting or running.'); return false; }
    if (loop) { this.onError('Audio recording uses song playback, not clip looping.'); return false; }
    const owner = this.song(), patch = this.patch();
    const from = fromStart ? 0 : this.transport.pos;
    const entries = this.inputs();
    const lanes = entries.map((entry) => entry.values.lane - 1);
    if (!entries.length) { this.onError('Arm a RECORDER module first.'); return false; }
    if (new Set(lanes).size !== lanes.length) { this.onError('Armed recorders must use different lanes.'); return false; }
    if (lanes.some((lane) => owner.clips.some((clip) => clip.y === lane * LANE_H && clip.start <= from && from < clip.start + clip.length))) {
      this.onError('Choose an empty recording lane at the playhead.');
      return false;
    }
    if (!globalThis.crossOriginIsolated) { this.onError('Audio recording requires cross-origin isolation.'); return false; }
    const token = ++this.token;
    const scope = this.transport.getScope();
    const rate = this.engine.ctx.sampleRate;
    const prepare = async () => {
      const sessions = entries.map((entry) => this.createSession({
        entry, lane: entry.values.lane - 1, channels: entry.values.channels + 1,
        owner, patch, from, rate, scope,
      }));
      await Promise.all(sessions.map((session) => session.ready));
      if (token !== this.token || !this.armed || this.song() !== owner || this.patch() !== patch) {
        for (const session of sessions) session.ring.stop();
        return;
      }
      for (const session of sessions) {
        this.engine.dsp.post(['audioRecord', { handle: session.entry.inst.input.h, buffer: session.buffer,
          lane: session.lane, scope, from }]);
        session.attached = true;
      }
      const sig = segAt(meter(owner), from);
      this.transport.clipId = null;
      this.transport.clipSong = null;
      this.transport.start(from, { countIn: { beats: sig.num, beat: sig.beat }, continuous: true, fromStart });
      this.generation = this.transport.generation;
      this.onState();
    };
    prepare().catch((error) => {
      this.finish();
      this.onError(`Audio recording failed: ${error.message}`);
    });
    return true;
  }

  createSession(data) {
    const buffer = createRecordingBuffer(Math.ceil(data.rate * 2) + 1, data.channels);
    const ring = new RecordingBuffer(buffer);
    const worker = new Worker(new URL('./recordingworker.js', import.meta.url), { type: 'module', name: 'Audio recorder' });
    const session = { ...data, buffer, ring, worker, attached: false, done: false };
    this.sessions.add(session);
    session.ready = new Promise((resolve, reject) => {
      let ready = false;
      worker.onmessage = ({ data: message }) => {
        if (message.type === 'ready') { ready = true; resolve(); }
        else if (message.type === 'complete' || message.type === 'error') {
          if (!ready) reject(new Error(message.message || 'Audio recorder could not start'));
          this.settle(session, message);
        }
      };
      worker.onerror = (event) => {
        const message = event.message || 'Audio recorder worker failed';
        if (!ready) reject(new Error(message));
        this.settle(session, { type: 'error', message });
      };
      worker.postMessage({ buffer, sampleRate: data.rate });
    });
    return session;
  }

  async settle(session, result) {
    if (session.done) return;
    session.done = true;
    session.ring.stop();
    if (session.attached) this.engine.dsp.post(['record', session.entry.inst.input.h, null]);
    session.worker.terminate();
    this.sessions.delete(session);
    try {
      if (result.id && result.frames > 0) {
        if (this.song() !== session.owner || this.patch() !== session.patch) {
          throw new Error(`Recorded audio was kept for recovery (${result.id}) because the project or layer changed`);
        }
        const next = session.owner.clips.filter((clip) => clip.y === session.lane * LANE_H &&
          clip.start + clip.length > session.from).reduce((end, clip) => Math.min(end, clip.start), Infinity);
        const duration = Math.min(result.frames / result.sampleRate * session.ring.tempo / 60, next - session.from);
        if (!(duration > 0)) throw new Error(`Recorded audio was kept for recovery (${result.id}) because the lane is occupied`);
        const clip = addAudioClip(session.owner, {
          start: session.from, y: session.lane * LANE_H, target: 0, name: `Recording ${session.lane + 1}`,
          audio: { ...result, span: duration },
        });
        session.owner.selected = clip.id;
        this.onCommit();
      } else if (result.id && result.type === 'complete') await this.assets().discard(result.id);
      if (result.type === 'error') this.onError(`Audio recording stopped: ${result.message}${result.id ? ` (take ${result.id})` : ''}`);
    } catch (error) {
      this.onError(`Audio recording failed: ${error.message}`);
    } finally {
      if (!this.sessions.size && this.armed) {
        this.armed = false;
        this.transport.setContinuous(false);
        this.onState();
      }
    }
  }

  update() {
    if (this.sessions.size && this.generation !== undefined &&
        (!this.transport.playing || this.transport.generation !== this.generation)) this.finish();
  }

  input() {}

  finish({ disarm = true } = {}) {
    this.token++;
    this.generation = undefined;
    for (const session of this.sessions) {
      session.ring.stop();
      if (session.attached) this.engine.dsp.post(['record', session.entry.inst.input.h, null]);
    }
    if (disarm) this.armed = false;
    this.transport.setContinuous(false);
    this.onState();
  }
}
