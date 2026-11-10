// MODMIDI: PHILSYNTH's internal note language. Like MIDI, but every note is an object of its own
// that can be changed while it sounds:
//   id        unique number per played note (newNoteId), also when the same key is hit twice
//   pitch     float in MIDI note numbers: 60 = middle C, 60.5 = middle C + 50 cents
//   velocity  float 0..1
//   phase     float 0..1: where in its waveform cycle the oscillator starts the note (0 = start
//             of the cycle, 0.5 = halfway). Optional, default 0; used by OSC (noise ignores it)
//             LFO (restarts its wave there, plus its own Phase) and ENVELOPE (starts its
//             curve at that position)
//   time      optional logical onset in seconds: equal values identify simultaneous notes.
//             Sequencer/device inputs preserve original onsets even in batched delivery;
//             MIDI delay processors add their per-note delay, Patch modules pass it through.
// Modules that play notes (acceptsMidi) implement:
//   noteOn(id, pitch, velocity, phase = 0, time)   start a note
//   noteMod(id, pitch, velocity)  change pitch/velocity of a sounding (or releasing) note; the
//                                 synth glides to the new values, so it never clicks
//   noteOff(id)                   release a note
//   allOff()                      silence everything
// MIDI processors (MULTIMIDI, STRUM, TUNING, DELAY) receive MODMIDI and send it on with their own ids.
// DELAY schedules each message with the current LEFT DELAY, preserving pitch, velocity and
// phase. allOff / cable removal cancel pending events and release only its own outgoing notes.
let lastId = 0;
let noteIdStep = 1;
export const newNoteId = () => (lastId += noteIdStep);
// Audio-thread generated notes cannot collide with live MIDI ids from the UI.
export const useAudioNoteIds = () => { lastId = Math.min(0, lastId); noteIdStep = -1; };

// Visual provenance follows delayed notes without changing their MIDI data or timing.
let midiTrace = null;
export const captureMidiTrace = () => midiTrace;
export function withMidiTrace(trace, send) {
  const previous = midiTrace;
  midiTrace = trace;
  try { return send(); } finally { midiTrace = previous; }
}
