// Module reference shown in the controller panel below the controllers / editors (see main.js
// select()): per module type a short summary, one description per controller (what it does to
// the module's output) and usage notes. Static HTML only (no user text).
// test/moduledocs.test.mjs checks that every controller of every stock module is described.

// ---- shared texts ----
const OUT_CONTROLLER = 'Picks the controller (by number) of the modules this module is cabled to that it drives. The value shows the number and the controller name of the connected module(s).';
const OUT_MIN = 'Lowest value the controlled controller reaches, in % of that controller\'s range.';
const OUT_MAX = 'Highest value the controlled controller reaches, in % of that controller\'s range. Out Max below Out Min inverts the modulation.';
const MOD_PARAMS = { outController: OUT_CONTROLLER, outMin: OUT_MIN, outMax: OUT_MAX };
const MOD_CABLE = '<kbd>Shift</kbd> + drag from this module to the module to control (control cables are dashed). One modulator can drive several modules; each gets the same controller number.';
const NOTES_IN = 'Notes trigger it: select it and play the MIDI keyboard, send a clip to it, or <kbd>Shift</kbd> + drag a MULTIMIDI into it.';

const POLYPHONY = 'Number of voices (notes that can sound at once). A new note beyond this steals the oldest voice.';
const ENV_CURVES = {
  atkCurve: 'Shape of the attack. 0 = Linear (a straight rise); +100 % = the analog RC charge curve (fast start that slows into the peak, as charging toward 1.5); negative values give the inverse, a slow start that shoots up at the end. The attack time stays exact.',
  decCurve: 'Shape of the decay toward Sustain. 0 = Linear; +100 % = analog exponential (falls fast, then eases into the sustain level, -60 dB of the distance at the end of the Decay time); negative = the inverse (holds, then drops). With Sustain at 0 it moves together with Release Curve.',
  relCurve: 'Shape of the release, like Decay Curve: 0 = Linear, +100 % = analog exponential fade (-60 dB at the end of the Release time), negative = holds and then drops off.',
};
const ADSR_EDITOR = 'drag the peak (Attack time), the corner (Decay time and Sustain level), the end (Release time) or the round dot in the middle of a stage (up/down sets its Curve). It moves the real controllers, so the graph and the sliders always agree; double-click a handle to reset it. The time axis is logarithmic per stage (1 ms up to the controller\'s maximum), the sustain plateau has a fixed width.';
const VOICE_ENV = {
  attack: 'Time for each note to rise from silence to full level.',
  decay: 'Time to fall from full level to the Sustain level.',
  sustain: 'Level held while the key is down, relative to the peak. At 0 the envelope is a pure decay and Decay / Release move together.',
  release: 'Time to fade out after the key is released.',
  gain: 'Output level of the module.',
};
const INTERPOLATION = 'How sample values between table points are read: Off = nearest sample (gritty, lo-fi), Linear, Spline = smooth cubic (cleanest).';
const SYNC_UNIT = 'Time base of the delay: ms gives 0–10,000 milliseconds; 1/4, 1/8 or 1/16 turns the delay slider into musical lengths (1/4 up to 64 of that note value, dotted and triplet lengths included), synced to the BPM of this patch level\'s Output.';

export const DOCS = {
  OUT: {
    summary: 'The Output of the patch level: every audio cable into it is summed and played (at the top level) or sent out of the Patch module (inside a Patch). It also holds the tempo and the global tuning of this level. It cannot be deleted.',
    params: {
      volume: 'Master volume: scales the summed audio before it leaves this level.',
      bpm: 'Tempo of this patch level: the sequencer plays at it when this level is played, and synced LFOs, DELAY and ECHO times on this level follow it.',
      transpose: 'Shifts every note entering this patch level by whole semitones (−48…+48).',
      cents: 'Fine-tunes every note entering this patch level by up to ±100 cents.',
    },
    notes: [
      'Below the controllers: <b>Song/Patch Name</b>, <b>Creator</b> (the name of whoever made it) and a <b>Comments</b> box for notes about the song or patch; all are saved with the project.',
      'Inside a Patch, MIDI cables (MULTIMIDI, STRUM, TRILL) and modulator cables (LFO, ADSR, ENVELOPE, VELOCITY2CTL, PITCH2CTL, SOUND2CTL) into the Output pass out over the Patch module\'s cables. At the top level a modulator cabled into the Output drives the Output\'s own controllers.',
    ],
  },

  OSC: {
    summary: 'Polyphonic oscillator synthesizer: every incoming note plays its own voice with the chosen waveform, shaped by a per-voice ADSR envelope and the note velocity.',
    params: {
      polyphony: POLYPHONY,
      wave: 'Waveform of every voice: Sine, Tri/Saw (a triangle that morphs into a saw with Duty Cycle), Saw, Square, Half sine, or one of five noise colours (White, Pink, Brown, Blue, Violet: dark to bright). Noise ignores the note pitch.',
      ...VOICE_ENV,
      duty: 'Reshapes the waveform within each cycle (50 % = the classic shape): the pulse width of Square, the rise/fall balance of Tri/Saw, the bow length of Half sine (100 % fills the period, 0 % is silent). Hidden for noise.',
      ...ENV_CURVES,
    },
    notes: [
      NOTES_IN,
      'The waveform preview below the controllers shows the current shape (two cycles).',
      `<b>ADSR editor</b> (below the waveform): ${ADSR_EDITOR}`,
      'The Attack/Decay/Release Curves start at +100 % (analog RC shapes); set them to 0 for straight linear stages.',
    ],
  },

  OPERATOR: {
    summary: 'Monophonic sine operator for custom FM instruments, using phase modulation. MIDI triggers its ADSR; audio input changes its waveform phase. Chain operators as modulators and carriers, or send several carriers to the Output.',
    params: {
      modulation: 'Scales the incoming audio, not the output volume. At 100 %, input amplitude 1 shifts the sine phase by one full cycle (2 pi radians); at 0 the input is ignored. Range 0–1000 %. Stereo is averaged and multiple audio inputs are summed. Quieter source audio gives less modulation.',
      feedback: 'Internal self-modulation: feeds the previous oversampled sine value back into its phase, before the envelope and output level. At 100 % the phase depth is one cycle. Higher values produce bright or noisy timbres. This is a one-internal-sample delay, not a block-delayed cable.',
      ...VOICE_ENV,
      ...ENV_CURVES,
      velocity: 'How much MIDI velocity changes output level (and hence downstream modulation strength): 0 % ignores velocity; 100 % follows it fully.',
    },
    notes: [
      NOTES_IN,
      'Follows fractional MIDI pitch and live changes from TUNING and MULTIMIDI, including cent offsets and OVERTONE ratios. No separate tuning or ratio controls.',
      'Example: MULTIMIDI sends notes to A and B; audio A → B → Output. A shapes B\'s timbre. Send A through its own MULTIMIDI for a different OVERTONE ratio. MIDI cables do not automatically follow audio cables.',
      'One voice per OPERATOR (a new note replaces the previous one). For polyphonic FM, put the entire network in a Patch and raise Instances. Pick an OPERATOR or a MIDI-only module such as MULTIMIDI as the Input Module; notes play separate copies of the whole network.',
      'Each operator uses 4× oversampling, interpolated input and a low-pass downsampling filter to reduce aliasing; it does not eliminate all aliasing. The filter delays audio by about eight samples per operator. Audio feedback cable loops are not supported; use Feedback for self-modulation.',
      'Input audio alone makes no sound and is never mixed directly into the output. Level and ADSR shape both audible loudness and the modulation sent to another operator.',
      `<b>ADSR editor</b>: ${ADSR_EDITOR}`,
    ],
  },

  SAMPLER: {
    summary: 'Polyphonic sample player: one loaded audio sample is spread over the keyboard. C4 (MIDI 60) plays it at its own pitch; every semitone up plays it faster and higher. Each note is shaped by an ADSR envelope.',
    params: {
      polyphony: POLYPHONY,
      ...VOICE_ENV,
      transpose: 'Shifts the sample\'s pitch in semitones; use it (with Finetune) to put the sample\'s own pitch on C4.',
      finetune: 'Fine pitch correction of the sample, ±100 cents.',
      interpolation: INTERPOLATION,
      selStart: 'Start of the playback region, in % of the sample. Modulate it to move the window through the sample.',
      selLength: 'Length of the playback region, in % of the sample.',
      playMode: 'How each note plays the region: Forward (once), Reverse (once backwards), Ping Pong (back and forth while the note sounds), Forward Loop / Reverse Loop (repeat while the note sounds).',
    },
    notes: [
      NOTES_IN,
      '<b>Load Sample</b> (or drop an audio file on the picture): WAV, AIFF, FLAC, MP3, OGG… up to 60 s, mono or stereo. The audio is saved inside the project and .phmod files.',
      '<b>Sample editor:</b> drag to select the region, drag its edges to trim; double-click (or <kbd>Ctrl/Cmd</kbd> + <kbd>A</kbd>) selects everything. <kbd>Backspace</kbd> / <kbd>Delete</kbd> or a short right-click inside the region cuts it out (undo with <kbd>Ctrl/Cmd</kbd> + <kbd>Z</kbd>). Hold the right button for 250 ms for <b>Normalize</b> (peak to full scale) and <b>Center</b> (removes DC offset) on the selected region.',
    ],
  },

  WAVETABLE: {
    summary: 'Polyphonic wavetable synthesizer: a wavetable is a row of single-cycle waveforms (frames). Every note plays the table at its pitch, crossfading between neighbouring frames, and is shaped by an ADSR envelope.',
    params: {
      polyphony: POLYPHONY,
      ...VOICE_ENV,
      position: 'Position in the table (0–100 %). Moves smoothly through the frames; route an LFO or ADSR to it for the typical wavetable movement.',
      block: 'Samples per frame. Auto reads it from the file (Serum / Vital WAV: 2048, Surge .wt / WaveEdit: 256) or guesses it; set it by hand for raw WAV tables.',
      interpolation: INTERPOLATION,
    },
    notes: [
      NOTES_IN,
      '<b>Load Wavetable</b> (or drop a .wav / .wt on the picture) replaces the built-in table (sine → triangle → saw → square). High notes play band-limited copies of each frame, so they do not alias.',
    ],
  },

  IMAGESAMPLER: {
    summary: 'Polyphonic synthesizer that plays a picture: a scanner lies on the image and every note reads the colours along it once per cycle at its pitch, so the colours are the waveform. Red, green and blue are read separately; each speaker plays its own + or − amount of every colour. Each note is shaped by an ADSR envelope with stage curves.',
    params: {
      polyphony: POLYPHONY,
      ...VOICE_ENV,
      ...ENV_CURVES,
      redLeft: 'How much red the left speaker plays, −100…+100 %: positive plays the colour as it is, negative inverted (bright pulls the wave down instead of up), 0 = no red on the left. Default: +100 %.',
      greenLeft: 'How much green the left speaker plays, −100…+100 % (negative = inverted, 0 = off). Default: +50 %.',
      blueLeft: 'How much blue the left speaker plays, −100…+100 % (negative = inverted, 0 = off). Default: off.',
      redRight: 'How much red the right speaker plays, −100…+100 % (negative = inverted, 0 = off). Default: off.',
      greenRight: 'How much green the right speaker plays, −100…+100 % (negative = inverted, 0 = off). Default: +50 %.',
      blueRight: 'How much blue the right speaker plays, −100…+100 % (negative = inverted, 0 = off). Default: +100 %.',
      scanType: 'Shape of the scanner: <b>Line</b> = a straight line at Rotation; <b>Propellor</b> = a line that spins around its centre at Propellor Speed, so the waveform keeps changing; <b>Oval</b> = an ellipse (Width / Height / Rotation) scanned once around per cycle, counterclockwise from the end of its width axis: a closed path, so the waveform has no jump and sounds softer; <b>Triangle</b> = the triangle through its three corners (X1 / Y1, X2 / Y2, X3 / Y3), scanned from corner 1 to 2 to 3 and back; <b>Rectangle</b> = a rectangle (Width / Height / Rotation as the Oval) scanned once around, counterclockwise from the middle of its width side. Triangle and Rectangle are closed paths too, run at an even speed along their edges; their corners give the wave sharper bends than the Oval. The controllers of the chosen type appear below the shared ones.',
      x: 'Horizontal position of the scanner\'s centre on the image (0 % = left edge, 100 % = right edge). Shared by every scanner type except the Triangle, which has its own corners.',
      y: 'Vertical position of the scanner\'s centre on the image (0 % = top edge, 100 % = bottom edge). Shared by every scanner type except the Triangle, which has its own corners.',
      length: 'Length of the scanner. Line: in % of the image measured edge to edge in the Line\'s direction, so a centred Line at 100 % (the default) reaches exactly both edges: the full width when horizontal, the full height when vertical, corner to corner on the diagonal. Propellor: in % of the image diagonal, tip to tip (so it keeps its length while it spins). Longer scanners cross more of the picture: more detail and more harmonics in the waveform. Line and Propellor only.',
      rotation: 'Line scanner: its angle in degrees (0° = horizontal, scanning left to right; positive turns it counterclockwise).',
      ovalWidth: 'Oval and Rectangle scanner: the length of its width axis (the one at Rotation, where every cycle starts), in % of the image width.',
      ovalHeight: 'Oval and Rectangle scanner: the length of its height axis (square to the width axis), in % of the image height. Width or Height 0 flattens the shape into a line that is scanned there and back.',
      ovalRotation: 'Oval and Rectangle scanner: its angle in degrees (0° = the width axis horizontal, positive turns it counterclockwise).',
      triX1: 'Triangle scanner: horizontal position of corner 1, where every cycle starts and ends (0 % = left edge, 100 % = right edge).',
      triY1: 'Triangle scanner: vertical position of corner 1 (0 % = top edge, 100 % = bottom edge).',
      triX2: 'Triangle scanner: horizontal position of corner 2, the second corner the scan passes.',
      triY2: 'Triangle scanner: vertical position of corner 2.',
      triX3: 'Triangle scanner: horizontal position of corner 3, the last corner before the scan returns to corner 1.',
      triY3: 'Triangle scanner: vertical position of corner 3. All three corners on one line flatten the triangle into a line that is scanned there and back.',
      speed: 'Propellor scanner: turns per second (negative = clockwise). Slow speeds sweep the timbre; tens of turns per second give a buzzing, audio-rate movement. All voices spin at the same speed; a note\'s start phase (from a MULTIMIDI\'s Phase / Random Phase, 0–100 % = 0–360°) turns its own propellor ahead by that angle, so with Random Phase every voice of a chord plays its own spinning propellor (a wide, chorus-like sound). Notes at phase 0 share one propellor.',
      resolution: 'How many points along the scanner make the waveform, 2…1024 (default 64; the slider is logarithmic). Older projects above 1024 are capped at 1024. The colours are read at those points, evenly spaced, and the wave runs in straight lines between them; each point takes the average colour of its stretch of the scanner. Few points give a coarse, simple wave that jumps between shapes as the scanner moves (2 points = a triangle); many points give all the detail of the picture, sharper and more intense. The dots on the scanner show the points (up to 128). The points are read once and shared by all voices, and only again when the scanner moves, so fewer points also cost less CPU while a Propellor spins.',
    },
    notes: [
      NOTES_IN,
      '<b>Stock wavetable</b>: without a picture of its own the module plays the built-in stock picture (it is not saved in files). Every row is one full wave cycle from the left to the right edge, and from top to bottom the rows morph through sine, triangle, organ (harmonics), formant (vocal), square, saw, hard sync, narrow pulse, stepped (bitcrushed) and two noisy waves. The default Line (Y 50 %) plays the saw in the middle (with green\'s octave saw mixed in by the default colour amounts); moving Y (by hand, LFO or automation) sweeps from soft to bright to gritty. Green holds the same waves an octave up and blue a step further in the morph and a quarter cycle later, so the colour amounts mix octave, timbre and stereo; Oval, Triangle, Rectangle and a turned Line cross several rows and play mixtures.',
      '<b>Load Image</b> (or drop a picture on the photo): PNG, JPEG, WebP… It is scaled to 256 px on its longest side and saved inside the project and .phmod files. <b>Stock Image</b> (next to it while an own picture is loaded) goes back to the stock wavetable.',
      'Scanner/table generation and voice playback run in C++/Wasm when available, with a JavaScript fallback. Identical images share one prepared image pyramid across Patch instances; each instance keeps its own scanner, waveform tables and notes.',
      '<b>Scanner editor</b> (on the photo): drag the centre dot or click anywhere to move the scanner (X / Y); drag an end to set Length (and Rotation for the Line). Double-click the centre to reset X / Y, an end to reset Length / Rotation. The arrow shows the scan direction: every cycle runs from the round start to the arrow. <b>Oval</b> and <b>Rectangle</b>: drag the square handles to set Width and Height, and the ring on the stalk beyond the Width handle around the centre to set Rotation (double-click a handle to reset it); the arrow shows the way round. <b>Triangle</b>: drag a numbered corner to place it, the centre dot (or click anywhere) to move the whole triangle; double-click a corner to reset it, the centre to reset all three.',
      '<b>Colour mix:</b> each speaker has its own + / − amount of red, green and blue and plays their sum, scaled down when the amounts add up to more than 100 % (all three at +100 % play their average), so no setting clips. A negative amount inverts that colour, so e.g. red +100 % and blue −100 % on one side play the colour <i>difference</i>, which cancels the brightness both share; the same colour at + on the left and − on the right gives a wide stereo image. In natural photos red, green and blue mostly follow the brightness, so flipping signs is a quick way to search for very different sounds. The amounts glide, so an LFO on them is click-free.',
      'The average colour along the scanner is removed (no DC offset), and high notes play a smoothed copy of the waveform, so they do not alias harshly. When the scanner or Resolution changes while notes sound, the old and new waveform crossfade, so moving it is click-free.',
      `<b>ADSR editor</b> (below the photo): ${ADSR_EDITOR}`,
    ],
  },

  INPUT: {
    summary: 'Audio input of the computer (microphone, line in, audio interface) as a sound source in the patch.',
    params: {
      mic: 'Input device. The list appears once microphone access is granted; <i>System default</i> follows the system setting.',
      gain: 'Input level trim, −24…+24 dB. Watch the meter: 0 dB is full scale.',
      channel: 'Which input channels play: Stereo, Left or Right only (on both sides), or Mono (L + R summed).',
    },
    notes: [
      'Echo cancellation, noise suppression and auto gain are off. Use headphones: a microphone near the speakers feeds back.',
      'Inputs are silent in WAV exports.',
    ],
  },

  MULTIMIDI: {
    summary: 'MIDI note processor: transposes, detunes, drifts, scales and distributes incoming notes, and sends them through its MIDI cables to sound modules (OSC, SAMPLER, Patch, …) or other MIDI modules. It makes no sound itself.',
    params: {
      transpose: 'Shifts every outgoing note by whole semitones (−48…+48).',
      finetune: 'Detunes every outgoing note by up to ±100 cents.',
      drift: 'Depth of a slow random pitch wander per note, up to ±100 cents. Every note starts at its own random offset and keeps moving, so chords drift apart like analog voices.',
      driftFreq: 'Speed of the pitch drift: how often (per second) it heads for a new random value. 0 holds each note\'s initial offset.',
      velDrift: 'Depth of a random velocity (loudness) wander per note: reduces the velocity by up to this percentage.',
      velDriftFreq: 'Speed of the velocity drift. 0 holds each note\'s initial offset.',
      randomPhase: 'Adds a random offset to every note\'s start point in the waveform cycle, on top of <b>Phase</b>: 0 % = no random offset, 100 % = anywhere in the cycle.',
      randomDelay: 'Delays every note by a random time between 0 and this value (0–5000 ms). The note\'s velocity changes and note-off get the same delay, so its length is kept.',
      velocity: 'Overall level: scales every outgoing velocity (100 % = unchanged, 0 % = silent).',
      overtone: 'Plays the n-th overtone of the harmonic series instead of the note: (n + 1) × its frequency. 0 = the fundamental, 1 = octave, 2 = octave + fifth, 3 = two octaves … up to 128.',
      velSense: '<i>On</i> (default): the played velocity is passed on, scaled by <b>Velocity</b>. <i>Off (fixed)</i>: velocity detection is off, every note gets exactly the <b>Velocity</b> value however hard it was played (Velocity Drift still applies).',
      routeMode: 'Which MIDI cables each note goes out of: <i>Sent to All</i> (every cable), <i>Round Robin</i> (the next cable in turn, in the order they were made), <i>Random</i> (one random cable), <i>Random (no repeat)</i> (random, never the same cable twice in a row).',
      phase: 'The point of the waveform cycle every note starts at (0–100 % = 0–360°), sent with the note to OSCs and LFOs; an ENVELOPE starts its curve at that position, and an IMAGE SAMPLER\'s Propellor scanner is turned by that angle for the note. <b>Random Phase</b> adds a random offset on top.',
    },
    notes: [
      'Notes arrive when it is selected and the MIDI keyboard is played, from a clip sent to it, or from another MULTIMIDI cabled into it. <kbd>Shift</kbd> + drag from it to an OSC, SAMPLER, Patch, ADSR or another MIDI module to send them on.',
      'Several MULTIMIDIs can feed one synth in parallel (each plays its own copy of the note); chained MULTIMIDIs add up their transposition, delays and phases.',
    ],
  },

  STRUM: {
    summary: 'Chord strummer: notes that start at the same time (a chord) are spread out in time like a strummed guitar, then sent through its MIDI cables. Notes with different start times pass unchanged.',
    params: {
      strumType: 'Order of the strum: upwards (lowest note first), downwards (highest first) or random order.',
      duration: 'Time from the first to the last note of the chord (0–5000 ms). A single note is not delayed.',
      humanize: 'Random variation of the timing of the notes in between (0 % = evenly spaced); the first and last note and the order are kept.',
    },
    notes: [
      'Send chord notes from a sequencer clip to STRUM, then <kbd>Shift</kbd> + drag it to an OSC, Patch or another MIDI module.',
      'Note-off and velocity changes follow each note\'s delay, so note lengths are kept. Panic cancels pending strums.',
    ],
  },

  TRILL: {
    summary: 'Human-like trill: while keys are held it plays them one after another, again and again, and sends the notes through its MIDI cables. Two keys alternate like a classic trill; with more keys the notes follow the chosen order (random by default). It makes no sound itself.',
    params: {
      order: 'Order of the held notes: random (never the same note twice in a row), up (low to high, then wraps), down (high to low) or up-down (back and forth). With two keys every order alternates.',
      separation: 'Time from one note start to the next, as a division of a whole note at the BPM of this patch level\'s Output: 16 = 1/16 note, 8 = 1/8; 3, 6, 12, 24 are triplets. Higher = faster trill (at 120 BPM, 32 = 62.5 ms).',
      length: 'Length of every played note, also a whole-note division (higher = shorter). Longer than the separation makes the notes overlap; a note that comes back cuts its previous copy.',
      humanize: 'Random human variation. 0 % plays exactly on the separation grid with exact lengths and the key velocities; 100 % moves every note up to ±40 % of the separation earlier or later and varies its length by ±30 % and velocity by ±20 %. The variation never builds up into drift.',
    },
    notes: [
      'The trill starts at once on the first key you press and stops when all keys are released; the last notes ring for their Note Length. Keys pressed or released during the trill join or leave it.',
      'Play it live or send held notes / chords from a clip, then <kbd>Shift</kbd> + drag it to an OSC, SAMPLER, Patch or another MIDI module. Pitch bends of a held key follow on its trill notes.',
      'Timing runs on the audio clock with about 5 ms resolution. Panic stops the trill.',
    ],
  },

  TUNING: {
    summary: 'Microtonal tuning: retunes the notes passing through it to a <a href="https://www.huygens-fokker.org/scala/" target="_blank" rel="noopener">Scala</a> scale (.scl) and sends them on through its MIDI cables. It has no controllers: the scale is the text in its panel.',
    params: {},
    notes: [
      'Paste or type the contents of a Scala file into the text box, click <b>Load Tuning</b> to open a .scl file, or <b>Load Tuning from PHILSYNTH Library</b> to pick a built-in scale: equal temperaments (5 … 53 notes), Bohlen–Pierce and Wendy Carlos (non-octave), Werckmeister, Kirnberger, Vallotti, Young and Bach/Lehman well temperaments, meantone (1/3 … 1/6 comma) and Pythagorean, and just scales (5-limit, harmonic series, Partch 43, 22 shruti). The line above the box names the scale, or shows where the text has an error (notes then pass untuned). The scale is saved with the project.',
      'Scala format: lines starting with <code>!</code> are comments; the first other line is a description, the next the number of notes, then one pitch per line: a value with a period is in cents (<code>701.955</code>), otherwise a ratio (<code>3/2</code>) or a whole number. The 1/1 is implied; the last pitch is the period where the scale repeats (usually <code>2/1</code>, the octave).',
      'A .scl file holds only intervals, no frequency. Here C4 (key 60) stays at its normal pitch (261.63 Hz with A4 = 440 Hz) and is degree 0 of the scale, so in a historical temperament on C the A is slightly off 440 Hz. Keyboard mapping: C4 (key 60) plays degree 0, each key up or down is the next scale degree, so a scale with more or fewer than 12 notes spreads over more or fewer keys per period. A 12-tone equal temperament scale changes nothing. Micropitch from the piano roll or a MULTIMIDI before it is kept on top of the tuned pitch.',
      'Notes arrive when it is selected and the MIDI keyboard is played, from a clip sent to it, or from another MIDI module cabled into it. <kbd>Shift</kbd> + drag from it to an OSC, SAMPLER, Patch or another MIDI module to play the tuned notes. Sounding notes glide to a new scale as you edit it.',
    ],
  },

  FILTER: {
    summary: 'Multi-mode filter that shapes the frequency content of the audio: state-variable filters (12–48 dB/oct), EQ bell and shelves, a Moog-style ladder, comb filters and a vowel formant filter, with a built-in LFO on the cutoff.',
    params: {
      type: 'Filter type: Low-pass, High-pass, Band-pass, Notch, Peak, All-pass, Bell (EQ), Low shelf, High shelf, Ladder LP 24 dB, Comb + / Comb − (resonant tones at the cutoff frequency and its harmonics), Formant (vowel sounds).',
      slope: 'Steepness of the filter, 12–48 dB per octave. Only for Low-pass … All-pass.',
      cutoff: 'Corner (or centre) frequency, 20 Hz–20 kHz. Hidden for Formant.',
      vowel: 'Vowel of the Formant filter, sweeping A → E → I → O → U. Only for Formant.',
      resonance: 'Emphasis at the cutoff frequency (Q): high values ring or whistle. For the comb filters it sets the feedback, i.e. how long the comb tones ring.',
      gain: 'Boost or cut of the Bell and shelf types, ±24 dB. Only for the EQ types.',
      drive: 'Soft saturation of the input before the filter: warms and thickens the sound (0 = clean).',
      lfoShape: 'Waveform of the built-in cutoff LFO: Sine, Triangle, Saw, Square, Sample & hold or Random.',
      lfoRate: 'Speed of the built-in LFO, 0.02–20 Hz.',
      lfoDepth: 'How far the LFO moves the cutoff, in octaves (0 = LFO off).',
      mix: 'Balance between the unfiltered (dry) and the filtered (wet) signal.',
      level: 'Output level after the filter (0–2×).',
    },
    notes: [],
  },

  EQ: {
    summary: '16-band graphic equalizer: boosts or cuts fixed frequency bands, 2/3 octave apart from 20 Hz to 20 kHz.',
    params: Object.fromEntries([
      ...['20 Hz', '32 Hz', '50 Hz', '80 Hz', '125 Hz', '200 Hz', '315 Hz', '500 Hz', '800 Hz', '1.25 kHz', '2 kHz', '3.15 kHz', '5 kHz', '8 kHz', '12.5 kHz', '20 kHz']
        .map((f, i) => [`b${i}`, `Boost or cut around ${f}, ±12 dB.`]),
      ['q', 'Bandwidth of all bands: low Q = wide, gentle bands; high Q = narrow, precise bands.'],
      ['level', 'Output level after the equalizer, −24…+12 dB.'],
    ]),
    notes: ['The graph below the controllers shows the frequency response: drag a band up or down (or sweep across several), double-click a band to reset it to 0 dB.'],
  },

  WAVESHAPER: {
    summary: 'Waveshaping distortion: every incoming sample is remapped along a curve you draw. The diagonal changes nothing; bends add harmonics, from soft saturation to hard clipping and wave folding.',
    params: {
      drive: 'Input gain before the curve (−12…+36 dB): pushes more of the wave into the outer part of the curve, for more distortion.',
      range: 'Symmetric: the curve covers 0…max and is mirrored for the negative half (odd harmonics, the classic shaper). Full −/+: the curve spans −max…+max, so both halves can be shaped differently (adds even harmonics).',
      oversample: 'Processes at 2× or 4× the sample rate to reduce aliasing (harsh, inharmonic tones) at the cost of CPU.',
      mix: 'Balance between the clean (dry) and the shaped (wet) signal.',
      level: 'Output level after shaping (0–2×).',
    },
    notes: ['<b>Curve editor</b> (below the controllers): the horizontal axis is the input level, the vertical axis the output level. The curve is saved with the project.'],
  },

  DISTORTION: {
    summary: 'Distortion with twelve transfer types, input gain, bit crushing and sample-rate reduction. Both stereo channels are shaped independently, with a shared sample-and-hold clock.',
    params: {
      type: 'Original passes the amplified signal unchanged. Clipping limits it to ±1. Foldback repeatedly reflects at ±1; Foldback2 folds twice as fast beyond ±1; Foldback3 folds magnitude between 0 and 1 without reversing polarity. Overflow wraps magnitude to 0 beyond 1; Overflow2 wraps between −1 and +1. Saturation + foldback uses 1.5x − 0.5x³ (limited to ±1); the sin variant uses sin(x). Saturation3 uses sign(x) × (1 − (1 − min(|x|, 1))²); Saturation4 uses x / sqrt(1 + x²); Saturation5 uses x / (1 + |x|).',
      power: 'Input gain before shaping, 0–100×: 1× leaves the level unchanged, higher values push the signal further into distortion, 0× mutes it. Changes are smoothed over about 10 ms.',
      bits: 'Signed PCM bit crushing after shaping, 1–16 bits. 16 bypasses quantization and keeps the engine’s floating-point precision. Lower settings quantize and clip to the signed PCM range; 1 bit has levels −1 and 0 and can introduce DC.',
      frequency: 'Sample-and-hold updates per second, 1–48000 Hz. Lower values hold each processed sample longer for a lo-fi effect. 0 (Off) disables sample-rate reduction. Values at or above the actual audio engine sample rate process every sample; this does not change the engine sample rate.',
    },
    notes: [
      'Cable an audio source → <b>DISTORTION</b> → Output. Defaults: Clipping, Power 1×, Bit Depth 16, Frequency 48000 Hz.',
      '<b>Type chart</b> (below the controllers): every row is one Type, fed by a sine that grows from 0.25× to 4× from left to right (one cycle per band). The selected Type is highlighted, the dashed line marks the current Power (clamped to the chart range) and the current Bit Depth is applied. Click a row to select that Type.',
      'The types follow the supplied distortion chart; the fold and wrap variants are defined above, not a claim of bit-identical emulation of another synthesizer.',
      'Shaping, bit crushing and sample-rate reduction deliberately allow aliasing. Use a FILTER afterwards to tame harshness and a DC BLOCKER if the output has DC offset. Original can exceed ±1 when amplified.',
    ],
  },

  AMP: {
    summary: 'Amplifier: sets the level, the stereo position and the polarity of the audio. Mono input is spread to both channels.',
    params: {
      amp: 'Gain, 0–4× (1× = unchanged).',
      pan: 'Stereo balance: centre leaves both channels untouched; panning left fades the right channel out (and vice versa) without boosting the other side.',
      inverse: 'Flips the polarity of the signal (multiplies it by −1). Useful to cancel or combine signals.',
      fine: 'Extra volume factor, 0–100 % in 2 × 16384 steps (multiplied with Amplification). Automate or modulate it for smooth fades: near silence its steps stay inaudible where Amplification\'s 0.01 steps are heard.',
    },
    notes: [],
  },

  COMPRESSOR: {
    summary: 'Stereo-linked dynamics compressor with side chain: reduces the level of loud passages so the sound is more even and punchy, optionally keyed by another input (ducking).',
    params: {
      threshold: 'Level above which compression starts, −60…0 dB.',
      slope: 'Amount of reduction above the threshold, as 1 − 1/ratio: 0.5 = 2:1, 0.75 = 4:1, 1 = limiter.',
      attack: 'How fast the gain reduction reacts once the level exceeds the threshold (0.05–200 ms).',
      release: 'How fast the gain recovers when the level drops (5–3000 ms).',
      mode: 'Level detection: Peak follows the peaks with a 5 ms look-ahead (the audio is delayed 5 ms so transients are caught), RMS follows the loudness (10 ms average), Peak Zero Latency follows the peaks without delay.',
      sidechain: 'Off compresses the audio by its own level. Pick an input to use it as the key (e.g. a kick drum ducking a bass): it is only listened to, not played. Inputs are numbered in cable connection order.',
      knee: 'Softens the bend around the threshold over this many dB, for a gentler onset.',
      makeup: 'Gain after compression, to restore the level (−12…+36 dB).',
      mix: 'Blend of the dry signal with the compressed one (parallel compression): 100 % = fully compressed.',
      scHpf: 'High-pass filter on the key signal, so bass does not pump the compressor (20–1000 Hz).',
    },
    notes: ['The graph below shows the static curve (input level → output level) and a live gain-reduction meter.'],
  },

  'DC BLOCKER': {
    summary: 'Removes DC offset and sub-audio drift (below about 20 Hz) from the signal, recentring the waveform on zero: a constant offset glides back to zero in about 40 ms, without a click. Use it after asymmetric distortion or modulation (e.g. a half sine). It has no controllers.',
    params: {},
    notes: [],
  },

  DELAY: {
    summary: 'Pure delay for audio and MIDI: delays the left and right audio channels and every passing note, with no dry signal and no feedback. Use it to shift timing, for Haas stereo widening or to delay notes into other modules.',
    params: {
      left: 'Delay of the left audio channel and of every MIDI message (0–10,000 ms, or a note length).',
      right: 'Delay of the right audio channel (0–10,000 ms, or a note length). Not used for MIDI.',
      unit: SYNC_UNIT,
    },
    notes: [
      'Its cables carry audio, MIDI, or both, depending on the destination. Notes keep their pitch, velocity and start phase.',
      'Changing the delay affects new messages, not those already queued; audio delay changes glide to avoid clicks.',
    ],
  },

  ECHO: {
    summary: 'Feedback echo: repeats the audio at a set delay, each repeat quieter, in stereo or ping-pong, with an optional filter in the feedback path.',
    params: {
      dry: 'Level of the original signal.',
      wet: 'Level of the echoes.',
      feedback: 'Amount of each echo fed back for the next repeat: more feedback = more, longer-lasting repeats (max 99 %).',
      delay: 'Time between repeats (0–10,000 ms, or a note length).',
      unit: SYNC_UNIT,
      mode: 'STEREO repeats left and right together, keeping their separation. PINGPONG sums the input and bounces the repeats left, right, left …',
      filter: 'Low-pass or high-pass filter (12–48 dB/oct) on the first echo and every repeat, so repeats get darker (LP) or thinner (HP). The dry signal is not filtered.',
      cutoff: 'Cutoff frequency of the echo filter, 20 Hz–20 kHz.',
    },
    notes: [],
  },

  VIBRATO: {
    summary: 'Audio pitch vibrato: a short, constantly changing delay makes the pitch of any audio go up and down. Audio in, audio out; no MIDI.',
    params: {
      wave: 'Shape the pitch follows. <i>Sine</i> sweeps smoothly and slows down at the top and bottom. <i>Triangle</i> moves the pitch at a constant speed and turns sharply at the top and bottom.',
      unit: '<i>Hz</i>: Frequency is in cycles per second. <i>1/4, 1/8, 1/16</i>: Frequency picks a length in note values, synced to the BPM of this patch\'s Output, like the LFO.',
      freq: 'Vibrato rate, 0.01–50 Hz (or a synced note length with Frequency Unit; the slider then snaps to the note lengths).',
      phase: 'Where in its cycle the vibrato starts (0–100 % = 0–360°; 0 % = centre pitch, rising; 25 % = top). Applied when the project loads and after a panic (<kbd>\'</kbd> twice: stop, then panic), so a song always starts the vibrato at the same point. Turning it while running does not jump.',
      amp: 'Pitch depth, 0–200 cents up and about as much down (100 cents = one semitone). The depth stays the same at any Frequency.',
    },
    notes: [
      'A vibrato delays the sound slightly: on average half of its delay swing. At the default 5 Hz and ±25 cents that is about 0.5 ms; ±100 cents at 1 Hz is about 10 ms. Very slow, deep settings would need a swing over 2 s; there the depth is limited.',
      'Changes of Amp, Frequency, BPM and Waveform glide over about 50 ms, so they do not click.',
    ],
  },

  MODULATOR: {
    summary: 'Combines audio signals: one input is the carrier, all other inputs together are the modulator. Ring / amplitude modulation, phase modulation, arithmetic and bitwise combinations.',
    params: {
      type: 'How carrier and modulator are combined: Amp modulation (multiply; no modulator = silence), Phase modulation (modulator −1…+1 delays the carrier 0…40 ms), Phase modulation absolute (uses the modulator\'s magnitude, 0…40 ms), Add, Subtract, Min, Max, Bitwise AND / XOR (on 16-bit samples), Min abs / Max abs (chosen by magnitude, keeping the sign).',
      carrier: 'Which audio input is the carrier. Inputs are numbered in cable connection order; changing cables can renumber them.',
      interpolation: 'Read quality of the phase-modulation delay: Off = nearest sample, Linear, Spline = smooth cubic.',
    },
    notes: ['Left and right are processed separately.'],
  },

  REVERB: {
    summary: 'Algorithmic stereo reverb: simulates a room or hall with pre-delay, early reflections, diffusion and a 16-line feedback delay network.',
    params: {
      mix: 'Balance between the dry signal and the reverb.',
      size: 'Room size: scales all reflection and delay lengths, from a small room to a large hall.',
      decay: 'Reverb time (RT60): how long the tail takes to fade by 60 dB, 0.1–30 s.',
      damp: 'How much faster the high frequencies die away than the lows: higher = darker, softer room.',
      seed: 'Picks the room\'s delay lengths, reflection pattern and modulation: every seed is a different room.',
      predelay: 'Gap between the dry sound and the start of the reverb (0–500 ms).',
      early: 'Level of the early reflections (the first echoes off the walls).',
      diffusion: 'How quickly the reflections smear into a dense tail: low = grainy echoes, high = smooth wash.',
      mod: 'Slow movement of the delay lines, which avoids metallic ringing and adds a chorus-like shimmer.',
      lowCut: 'Removes lows below this frequency from the reverb input (20–1000 Hz), so the tail does not get muddy.',
      highCut: 'Removes highs above this frequency from the reverb input (1–20 kHz).',
      width: 'Stereo width of the reverb: 0 % = mono, 100 % = full stereo.',
      freeze: 'On: the current tail sustains forever and new input is ignored, for pads and drones.',
      level: 'Output level (0–2×).',
    },
    notes: ['With Patch Instances, every instance gets its own room for the same Seed.'],
  },

  LFO: {
    summary: 'Low-frequency oscillator: a repeating control wave that modulates one controller of every module it is cabled to (vibrato, tremolo, filter sweeps, …). With audio cabled into it, it is a tremolo: it passes that sound on with its volume following the wave.',
    params: {
      freq: 'Speed of the wave: 0.01–50 Hz, or (with a synced Frequency Unit) a cycle length in note values, which the slider snaps to. Ignored with Frequency Unit MIDI Pitch.',
      unit: 'Hz runs freely; 1/4, 1/8 or 1/16 syncs the cycle to note lengths at the BPM of this patch level\'s Output. <i>MIDI Pitch</i> runs the wave at the frequency of the incoming note (A4 = 440 Hz), following pitch bends; Frequency is ignored. Notes come from a clip sent to the LFO or a MULTIMIDI (or other MIDI module) cabled into it. With no note held it keeps the last pitch; before the first note it stands still.',
      wave: 'Shape of the wave: Sine, Triangle, Saw, Square, or Random (glides smoothly to a new random value every cycle).',
      ...MOD_PARAMS,
      amp: 'Depth of the wave around its centre: 100 % = full swing between Out Min and Out Max, 0 % = steady in the middle.',
      phase: 'Where in its cycle the wave starts (0–100 % = 0–360°). The LFO jumps there when the project loads, after a panic (<kbd>\'</kbd> twice: stop, then panic) and on every incoming note; a note\'s own phase (from a MULTIMIDI\'s Phase / Random Phase) is added to it. Turning it while running does not make the wave jump.',
    },
    notes: [MOD_CABLE, 'Tremolo: cable a sound module into the LFO. Its cables to modules that take audio (effects, the Output, …) then carry that sound, its volume following the wave: Amplitude sets the depth, Out Min / Out Max the volume range (0–100 %). Cables to modules without an audio input stay control cables, and so does a cable that would close an audio loop. The wave is computed for every sample, so with Frequency Unit <i>MIDI Pitch</i> and notes cabled in, the sound pulses at the note frequency (audio-rate amplitude modulation). Square and Saw edges take about 1 ms, so slow ones do not click.', 'Control cables: modulation is applied once per 128-sample block (~375 times a second), so with MIDI Pitch only low notes (below about 90 Hz, F♯2) give a clean wave; higher notes alias into a slower, stepped movement.'],
  },

  ADSR: {
    summary: 'Envelope generator triggered by notes: Attack, Decay, Sustain and Release shape a control curve that modulates one controller of every module it is cabled to (e.g. a filter sweep per note). It makes no sound.',
    params: {
      attack: 'Time to rise from Out Min to the peak after a note starts.',
      decay: 'Time to fall from the peak to the Sustain level.',
      sustain: 'Level held while notes are down, in % of the peak. At 0 Decay and Release move together.',
      release: 'Time to fall back to Out Min after the last note ends.',
      ...MOD_PARAMS,
      trigger: 'Every note: each new note restarts the attack (from the current level, without jumps). Legato: only a note played when no other note is held restarts it.',
      velocity: 'How much the note velocity scales the peak: 0 % = always full, 100 % = fully velocity dependent.',
      ...ENV_CURVES,
    },
    notes: [
      MOD_CABLE,
      NOTES_IN,
      'Example: MULTIMIDI → OSC and MULTIMIDI → ADSR → OSC, so every note also sweeps a controller of the synth.',
      `<b>ADSR editor</b> (below the controllers): ${ADSR_EDITOR} A retriggered attack continues from the current level along the Attack Curve.`,
    ],
  },

  ENVELOPE: {
    summary: 'Drawn envelope triggered by notes: plays a freely drawn curve over a set time and uses it to modulate one controller of every module it is cabled to. It makes no sound.',
    params: {
      length: 'Duration of the whole curve, 0–10,000 ms (0 jumps straight to the end).',
      ...MOD_PARAMS,
      mode: '<i>Note ON Trigger</i>: every note plays the curve once from the start and then holds the last value; note-off is ignored. <i>Notes ON/OFF Loop</i>: the first note starts it, it repeats while any note is held, and releasing the last note stops it where it is; the next note starts over. <i>Notes ON/OFF Loop Forward/Backwards</i>: the same, but the curve plays forwards and backwards in turn (ping-pong).',
    },
    notes: [
      '<b>Curve editor</b> (below the controllers): left to right is time over Envelope Length, bottom = Out Min, top = Out Max. While the envelope plays, a white dot follows the curve.',
      '<b>Start phase</b>: a note starts the curve at its phase (from a MULTIMIDI\'s Phase / Random Phase): 0 % = the start of the curve, 50 % = halfway. Notes without a phase start at the beginning. In the loop modes only the note that starts the loop sets it.',
      MOD_CABLE, NOTES_IN,
    ],
  },

  VELOCITY2CTL: {
    summary: 'Turns the velocity of incoming notes into a controller value: the harder a note is played, the further it moves the controlled controller. It makes no sound.',
    params: {
      outController: OUT_CONTROLLER,
      outMin: `${OUT_MIN} Velocity 0 gives this value.`,
      outMax: `${OUT_MAX} Velocity 127 gives this value.`,
      noteOffAction: 'What happens when the newest note ends: Do Nothing holds the value until the next note, Control Down moves it to Out Min, Control Up to Out Max.',
      smooth: 'Glide time to every new value, 0–5000 ms: instead of jumping, the controller moves in a straight line from where it is to the new value in this time (for a new note, the velocity curve and the Noteoff Action alike). A new value during a glide starts a new glide from the current position. 0 (default, <i>Off</i>) jumps. The very first note jumps, as there is nothing to glide from.',
    },
    notes: [
      MOD_CABLE,
      'The newest note wins, including its velocity curve while it sounds. Notes come from clips sent to it or a MULTIMIDI cabled into it; the MIDI keyboard keeps playing the current synth.',
    ],
  },

  PITCH2CTL: {
    summary: 'Turns the pitch of incoming notes into a controller value through a key map you draw: every MIDI key gets its own value, so a filter can open up the keyboard, or an instrument can get a custom value per key (key tracking for any controller). It makes no sound.',
    params: {
      outController: OUT_CONTROLLER,
      outMin: `${OUT_MIN} The bottom of the key map.`,
      outMax: `${OUT_MAX} The top of the key map.`,
      noteOffAction: 'What happens when the newest note ends: Do Nothing holds the value until the next note, Control Down moves it to Out Min, Control Up to Out Max.',
      smooth: 'Glide time to every new value, 0–5000 ms: instead of jumping, the controller moves in a straight line from where it is to the new value in this time (like portamento for the controller). 0 (default, <i>Off</i>) jumps. The very first note jumps, as there is nothing to glide from.',
    },
    notes: [
      '<b>Key map</b> (below the controllers): one column per MIDI key, all 128 (C-1 … G9; middle C = C4 = 60), above a key strip. The height of a column is that key\'s value: bottom Out Min, top Out Max. Default: a straight line over the 88-key piano, A0 (21) = Out Min … C8 (108) = Out Max, flat outside it.',
      '<b>Drag</b> to draw the keys freehand (a fast stroke fills every key it passes). <b>Shift+drag</b> draws a straight dashed line; on release the keys under it snap onto it. <b>Reset</b> brings back the default line, <b>Invert</b> flips the map upside down. Every stroke is one undoable edit; the map is saved with the project.',
      '<b>Zoom</b> to set single keys precisely: <b>−</b> / <b>+</b> or <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + wheel over the map (down to one octave across). Scroll with <kbd>Shift</kbd> + wheel (or a sideways wheel) or by dragging the key strip; the bar under the octave names shows which part of the keys you see. Widening the controller panel gives every key more room too.',
      'Between two keys (micro-pitch, pitch glides) the value moves in a straight line from one key\'s value to the next, along the line drawn through the columns. The newest sounding note is marked at its exact pitch; the line below the map names the hovered key and its value.',
      MOD_CABLE,
      'The newest note wins, including its pitch curve while it sounds. Notes come from clips sent to it or a MULTIMIDI cabled into it; the MIDI keyboard keeps playing the current synth. Editing the map moves a held value along.',
    ],
  },

  SOUND2CTL: {
    summary: 'Turns an audio signal into a controller value: the voltage of the incoming audio drives a controller, either at audio speed (e.g. an oscillator modulating a filter) or sampled slowly and optionally smoothed (e.g. a random or stepped modulation taken from a sound). It makes no sound.',
    params: {
      outController: OUT_CONTROLLER,
      outMin: `${OUT_MIN} Audio voltage −1 gives this value.`,
      outMax: `${OUT_MAX} Audio voltage +1 gives this value; silence (0) is halfway.`,
      rate: 'How many times a second a new value is taken from the audio (0.01 Hz … audio rate). At the maximum (default) it follows the audio as fast as controllers can change: once per 128-sample block, about 375 times a second at 48 kHz, so any rate above that behaves the same. Lower rates sample and hold: at 1 Hz the controller gets a new value once a second.',
      smooth: 'How gradually the controller moves to each new value: the glide takes this percentage of the time between two values. 0 % (default) jumps straight to it; 100 % glides the whole time and arrives just as the next value is taken (at 1 Hz a one-second glide). Has no effect when the glide would be shorter than one block (e.g. at the maximum Audio Rate).',
    },
    notes: [
      'Cable an audio source into it, then <kbd>Shift</kbd> + drag it to the module to control.',
      'Stereo is averaged and clamped to −1…+1. It is a direct voltage conversion, not an envelope follower: each value is the audio sample at that moment, not its loudness. The value controls the next 128-sample block.',
    ],
  },

  MULTICTL: {
    summary: 'One knob for many controllers: a single Value drives any number of controllers on the modules it is cabled to, e.g. the Decay of three OSCs at once. Automate or modulate it to move them all together.',
    params: {
      value: 'The shared value, 0–100 %, mapped onto Out Min…Out Max of every routed controller.',
      outMin: 'Value of every routed controller when Value is 0 %, in % of its range.',
      outMax: 'Value of every routed controller when Value is 100 %, in % of its range.',
    },
    notes: [
      '<kbd>Shift</kbd> + drag over the modules to control, then pick their controllers under <b>Routes</b> (below the controllers).',
      'A controller picked on one module is also routed on connected modules of the same type that have no route yet, and newly connected modules of that type copy it.',
      'Each route has its own tiny <b>Min</b> / <b>Max</b> controllers next to its controller: Out Min…Out Max is mapped once more onto that part of the routed controller\'s range (Min above Max turns it around). They are numbered after Out Max, in route order, so automation clips and LFOs can drive them too.',
    ],
  },

  PATCH: {
    summary: 'A folder holding a complete sub-patch with its own Output: it groups modules into one reusable module. Audio and notes go in, its inner Output comes out. It can also run several copies (Instances) and pass notes and modulation out, to act as a custom MIDI or modulation module.',
    params: {
      inputModule: 'The number of the module inside that receives the audio/midi/modulation cabled into the Patch. Defaults to 1, so the first module you insert inside gets the input right away; 0 passes the input straight to the inner Output.',
      instances: 'Number of copies of the contents (1–16). With more than one, and an OPERATOR or MIDI-only Input Module (OSC, MULTIMIDI), incoming notes go round-robin over the copies, free copies first. Every copy has its own random generators.',
    },
    mapped: 'Mapped controller: sets this controller inside the Patch (every instance follows). It can be modulated and automated from outside like any other controller.',
    notes: [
      'Click <b>Edit Patch...</b> beside <b>Controllers…</b> to open the Patch (or <kbd>Double-click</kbd> it, or select it and press <kbd>Enter</kbd>); the mouse <b>back</b> button or the patch path goes up again.',
      '<b>Controllers…</b> maps controllers of modules inside to extra controllers of this module.',
      'Inside, cable a MULTIMIDI, STRUM or TRILL into the Output to send notes out, or an LFO, ADSR, ENVELOPE, VELOCITY2CTL, PITCH2CTL or SOUND2CTL to send modulation out; the inner modulator\'s Out Controller then picks a controller of the modules this Patch is cabled to.',
    ],
  },
};

export const docsFor = (type) => DOCS[type] ?? null;

// Description of controller `p` of a module of type `type` (null if none).
export function paramDoc(type, p) {
  const d = DOCS[type];
  if (!d) return null;
  return d.params[p.id] ?? (d.mapped && p.id.startsWith('map') ? d.mapped : null);
}

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html; // static strings only
  return e;
};

// The panel section: About (summary), Controllers (number, name, description), Usage (notes).
export function moduleDocs(def, params) {
  const d = DOCS[def.type];
  if (!d) return null;
  const root = el('section', 'module-docs');
  root.append(el('h3', null, 'About'), el('p', 'md-summary', d.summary));
  if (params.length) {
    root.append(el('h3', null, 'Controllers'));
    const list = el('dl', 'md-params');
    params.forEach((p, i) => {
      if (p.panel === false) return; // documented with its module's notes (MULTICTL route ranges)
      const dt = el('dt');
      const num = el('span', 'ctl-num');
      num.textContent = i;
      const name = el('span', 'md-name');
      name.textContent = p.label;
      dt.append(num, name);
      list.append(dt, el('dd', null, paramDoc(def.type, p) ?? ''));
    });
    root.append(list);
  }
  if (d.notes.length) {
    root.append(el('h3', null, 'Usage'));
    const ul = el('ul', 'md-notes');
    for (const n of d.notes) ul.append(el('li', null, n));
    root.append(ul);
  }
  return root;
}
