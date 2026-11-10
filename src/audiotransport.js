import { Transport } from './transport.js';

// UI facade: no notes or timers here. The worklet owns playback and reports its audio position.
export class AudioTransport extends Transport {
  constructor(options, { dsp, sync, onError }) {
    super({ ...options, ticker: () => ({ start() {}, stop() {} }) });
    this.dsp = dsp;
    this.sync = sync;
    this.onError = onError;
    this.revision = 0;
  }
  tick() {}
  send(type) {
    const revision = ++this.revision;
    const data = {
      type, revision, pos: this.pos, scope: this.scope,
      clipId: this.clipId, chase: this.chase,
    };
    if (type !== 'start') {
      this.dsp.post(['playback', 'command', data]);
      return;
    }
    this.sync().then(() => {
      if (revision === this.revision) this.dsp.post(['playback', 'command', data]);
    }).catch((error) => {
      if (revision !== this.revision) return;
      this.stop();
      this.onError(error);
    });
  }
  start(pos = this.pos) {
    const result = super.start(pos);
    this.send('start');
    return result;
  }
  stop(options) { super.stop(options); this.send('stop'); }
  seek(pos) { super.seek(pos); this.send(this.playing ? 'start' : 'seek'); }
  receive(state) {
    if (state.revision !== this.revision) return;
    const changed = this.playing !== state.playing || this.clipId !== state.clipId;
    this.pos = this.from = state.pos;
    this.playing = state.playing;
    this.clipId = state.clipId;
    if (!this.playing) this.clipSong = null;
    if (changed) this.onState?.(this);
  }
}
