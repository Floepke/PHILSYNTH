import { Transport } from './transport.js';

// UI facade: no notes or timers here. The worklet owns playback and reports its audio position.
export class AudioTransport extends Transport {
  constructor(options, { dsp, sync, onError, audioTime }) {
    super({ ...options, ticker: () => ({ start() {}, stop() {} }) });
    this.dsp = dsp;
    this.sync = sync;
    this.onError = onError;
    this.audioTime = audioTime;
    this.revision = 0;
  }
  tick() {}
  send(type) {
    const revision = type === 'continuous' ? this.revision : ++this.revision;
    const data = {
      type, revision, pos: this.pos, scope: this.scope,
      clipId: this.clipId, chase: this.chase,
      countIn: this.countIn, endAt: this.endAt, continuous: this.continuous,
    };
    if (type !== 'start') {
      this.dsp.post(['playback', 'command', data]);
      return;
    }
    this.sync().then(() => {
      if (revision === this.revision) this.dsp.post(['playback', 'command', { ...data, continuous: this.continuous }]);
    }).catch((error) => {
      if (revision !== this.revision) return;
      this.stop();
      this.onError(error);
    });
  }
  start(pos = this.pos, options) {
    this.clock = null;
    const result = super.start(pos, options);
    this.send('start');
    return result;
  }
  setContinuous(value) {
    if (this.continuous === value) return;
    super.setContinuous(value);
    this.send('continuous');
  }
  recordingTime(time) {
    if (!this.clock) return null;
    if (!this.playing) return this.elapsed;
    const lag = Number.isFinite(time) ? Math.max(0, this.now() / 1000 - time) : 0;
    const audio = this.audioTime() - lag;
    return this.clock.elapsed + (audio - this.clock.time) * this.clock.bpm / 60;
  }
  stop(options) {
    const elapsed = this.recordingTime();
    if (elapsed !== null) this.elapsed = elapsed;
    super.stop(options);
    this.clock = null;
    this.send('stop');
  }
  seek(pos) { this.clock = null; super.seek(pos); this.send(this.playing ? 'start' : 'seek'); }
  receive(state) {
    if (state.revision !== this.revision) return;
    const changed = this.playing !== state.playing || this.clipId !== state.clipId || this.countingIn !== (state.playing && state.elapsed < 0);
    this.pos = this.from = state.pos;
    this.playing = state.playing;
    this.clipId = state.clipId;
    this.elapsed = state.elapsed ?? this.elapsed;
    if (Number.isFinite(state.time) && Number.isFinite(state.elapsed)) {
      this.clock = { time: state.time, elapsed: state.elapsed, bpm: state.bpm };
    }
    if (!this.playing) this.clipSong = null;
    if (changed) this.onState?.(this);
  }
}
