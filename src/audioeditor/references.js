import { isAudio, normalizeAudioContent } from '../song.js';

// Collect references in the root timeline and every nested Patch timeline.
export function recordingReferences(project) {
  const refs = new Map();
  const song = (value) => {
    for (const clip of value?.clips ?? []) {
      if (!isAudio(clip)) continue;
      const audio = normalizeAudioContent(clip.audio);
      const existing = refs.get(audio.id);
      if (existing && (existing.sampleRate !== audio.sampleRate ||
          existing.channels !== audio.channels || existing.frames !== audio.frames)) {
        throw new Error(`Conflicting audio clip metadata: ${audio.id}`);
      }
      if (existing) existing.clips.push(clip);
      else refs.set(audio.id, { sampleRate: audio.sampleRate, channels: audio.channels, frames: audio.frames, clips: [clip] });
    }
  };
  song(project.song);
  const pending = [project.patch];
  while (pending.length) {
    const patch = pending.pop();
    song(patch?.song);
    for (const module of patch?.modules ?? []) if (module.patch) pending.push(module.patch);
  }
  return refs;
}
