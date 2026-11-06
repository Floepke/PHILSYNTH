import { captureMidiTrace, withMidiTrace } from './modmidi.js';

const SVGNS = 'http://www.w3.org/2000/svg';
export const MIDI_TRAVEL_MS = 100;

export class MidiCableAnimation {
  constructor() {
    this.cables = new Map();
    this.pulses = [];
    this.roots = new Map();
    this.frameId = null;
    this.frame = this.frame.bind(this);
  }

  // Cable objects survive layout redraws; their SVG groups and endpoints do not.
  setCables(list) {
    this.cables = new Map(list.map((view) => [view.cable, view]));
    this.paint(performance.now());
  }

  transmit(cable, id, send) {
    if (document.hidden || !this.cables.has(cable)) return send();
    let trace = captureMidiTrace() ?? this.roots.get(id);
    if (!trace) {
      trace = { end: 0 };
      this.roots.set(id, trace);
      queueMicrotask(() => this.roots.delete(id));
    }
    const start = Math.max(performance.now(), trace.end);
    trace.end = start + MIDI_TRAVEL_MS;
    this.pulses.push({ cable, start, end: trace.end, dot: null });
    if (this.frameId === null) this.frameId = requestAnimationFrame(this.frame);
    return withMidiTrace(trace, send);
  }

  paint(now) {
    this.pulses = this.pulses.filter((pulse) => {
      const view = this.cables.get(pulse.cable);
      if (!view || now >= pulse.end) {
        pulse.dot?.remove();
        return false;
      }
      if (now < pulse.start) return true;
      if (!pulse.dot) {
        pulse.dot = document.createElementNS(SVGNS, 'circle');
        pulse.dot.classList.add('midi-dot');
        pulse.dot.setAttribute('r', '4');
      }
      if (pulse.dot.parentNode !== view.g) view.g.append(pulse.dot);
      const t = (now - pulse.start) / MIDI_TRAVEL_MS;
      pulse.dot.setAttribute('cx', view.from.x + (view.to.x - view.from.x) * t);
      pulse.dot.setAttribute('cy', view.from.y + (view.to.y - view.from.y) * t);
      return true;
    });
  }

  frame(now) {
    this.frameId = null;
    this.paint(now);
    if (this.pulses.length) this.frameId = requestAnimationFrame(this.frame);
  }

  clear() {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    for (const pulse of this.pulses) pulse.dot?.remove();
    this.pulses = [];
    this.roots.clear();
  }
}
