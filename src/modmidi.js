// MODMIDI: ModSynth's internal note language. Like MIDI, but every note is an object of its own
// that can be changed while it sounds:
//   id        unique number per played note (newNoteId), also when the same key is hit twice
//   pitch     float in MIDI note numbers: 60 = middle C, 60.5 = middle C + 50 cents
//   velocity  float 0..1
//   phase     float 0..1: where in its waveform cycle the oscillator starts the note (0 = start
//             of the cycle, 0.5 = halfway). Optional, default 0; only OSC uses it (noise ignores it)
// Modules that play notes (acceptsMidi) implement:
//   noteOn(id, pitch, velocity, phase = 0)   start a note
//   noteMod(id, pitch, velocity)  change pitch/velocity of a sounding (or releasing) note; the
//                                 synth glides to the new values, so it never clicks
//   noteOff(id)                   release a note
//   allOff()                      silence everything
// MIDI processors (MULTIMIDI) receive MODMIDI, change it, and send MODMIDI on with their own ids.
let lastId = 0;
export const newNoteId = () => ++lastId;
