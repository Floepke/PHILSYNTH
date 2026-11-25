import { jsonFileText } from './fileformat.js';
import { CURRENT_ARCHIVE_VERSION, checkProjectData, createProjectManifest, readProjectManifest, createModuleManifest, readModuleManifest } from './projectdata.js';
import { getSample, sampleIds } from './samples.js';
import { encodeProjectAudio, decodeProjectAudio, encodeProjectImage, decodeProjectImage } from './projectmedia.js';
import { MAX_PROJECT_BYTES, isProjectZip, readZip, writeZip } from './projectzip.js';
import { recordingReferences } from './audioeditor/references.js';
import { inspectRecordingBlob } from './audioeditor/recordingfile.js';
import { copyZipEntry, readZipStream, writeZipStream } from './projectzipstream.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export async function readProjectBytes(file) {
  if (file.size > MAX_PROJECT_BYTES) throw new Error('Project file is too large');
  return new Uint8Array(await file.arrayBuffer());
}

// Capture the model now; encode only after the save destination is chosen. Pool bytes are immutable.
export function prepareProjectArchive(project, lookupSample = getSample) {
  const { samples: _samples, ...model } = project;
  if (recordingReferences(model).size) throw new Error('Audio clips cannot yet be saved in project files');
  const assets = Object.create(null), media = [];
  let mediaBytes = 0;
  for (const id of sampleIds(model)) {
    const sample = lookupSample(id);
    if (!sample) throw new Error(`Project media is missing: ${id}`);
    const image = sample.kind === 'image';
    const path = `media/${image ? 'images' : 'audio'}/${media.length + 1}.${image ? 'png' : 'wav'}`;
    assets[id] = image ? { path, kind: 'image' } : { path, kind: 'audio', rate: sample.rate };
    media.push({ path, sample, image });
    mediaBytes += image ? sample.rgb.length : sample.pcm.byteLength;
    if (mediaBytes > MAX_PROJECT_BYTES) throw new Error('Project media is too large');
  }
  const manifest = jsonFileText(createProjectManifest(model, 2, assets));
  return async () => {
    const entries = new Map([['project.json', encoder.encode(manifest)]]);
    for (const { path, sample, image } of media) {
      entries.set(path, image ? await encodeProjectImage(sample) : encodeProjectAudio(sample));
    }
    return writeZip(entries);
  };
}

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const sameRecording = (a, b) => a.sampleRate === b.sampleRate && a.channels === b.channels && a.frames === b.frames;

// Capture the model and pool references before opening a destination; WAV files remain on disk.
function prepareStreamedArchive(project, audioAssets, lookupSample, moduleFile = false) {
  const { samples: _samples, ...model } = project;
  const audioRefs = recordingReferences(moduleFile ? { patch: model } : model);
  if (audioRefs.size && (!audioAssets || typeof audioAssets.file !== 'function')) throw new Error('Audio storage is unavailable');
  const assets = Object.create(null), audioFiles = Object.create(null), media = [];
  let mediaBytes = 0;
  for (const id of sampleIds(model)) {
    const sample = lookupSample(id);
    if (!sample) throw new Error(`Project media is missing: ${id}`);
    const image = sample.kind === 'image';
    const path = `media/${image ? 'images' : 'audio'}/${media.length + 1}.${image ? 'png' : 'wav'}`;
    assets[id] = image ? { path, kind: 'image' } : { path, kind: 'audio', rate: sample.rate };
    media.push({ path, sample, image });
    mediaBytes += image ? sample.rgb.length : sample.pcm.byteLength;
    if (mediaBytes > MAX_PROJECT_BYTES) throw new Error('Project media is too large');
  }
  let audioIndex = 0;
  for (const [id] of audioRefs) audioFiles[id] = { path: `media/audioFiles/${++audioIndex}.wav` };
  const manifestData = moduleFile
    ? createModuleManifest(model, assets, audioFiles)
    : createProjectManifest(model, CURRENT_ARCHIVE_VERSION, assets, audioFiles);
  const manifest = encoder.encode(jsonFileText(manifestData));
  if (manifest.length > MAX_MANIFEST_BYTES) throw new Error('Project manifest is too large');
  return async (write, options) => {
    const entries = [{ path: moduleFile ? 'module.json' : 'project.json', blob: new Blob([manifest]) }];
    for (const { path, sample, image } of media) {
      entries.push({ path, blob: new Blob([image ? await encodeProjectImage(sample) : encodeProjectAudio(sample)]) });
    }
    for (const [id, metadata] of audioRefs) {
      const blob = await audioAssets.file(id);
      if (!sameRecording(metadata, await inspectRecordingBlob(blob))) throw new Error(`Audio clip metadata does not match its WAV: ${id}`);
      entries.push({ path: audioFiles[id].path, blob });
    }
    await writeZipStream(entries, write, options);
  };
}

export function prepareStreamedProjectArchive(project, audioAssets, lookupSample = getSample) {
  return prepareStreamedArchive(project, audioAssets, lookupSample);
}

function bufferedArchive(writeTo, hasRecordings, kind) {
  const encode = async () => {
    if (hasRecordings) throw new Error('Saving audio clips requires a browser with file system access or the desktop app');
    const chunks = [];
    let size = 0;
    await writeTo((bytes) => {
      size += bytes.length;
      if (size > MAX_PROJECT_BYTES) throw new Error(`${kind} file is too large for a browser download`);
      chunks.push(bytes.slice());
    });
    return new Blob(chunks, { type: 'application/octet-stream' });
  };
  return Object.assign(encode, { writeTo, downloadable: !hasRecordings });
}

export function prepareModuleArchive(module, audioAssets = null, lookupSample = getSample) {
  const hasRecordings = recordingReferences({ patch: module }).size > 0;
  return bufferedArchive(prepareStreamedArchive(module, audioAssets, lookupSample, true), hasRecordings, 'Module');
}

// Audio-free projects can still be downloaded by browsers without a streaming file picker.
export function prepareCurrentProjectArchive(project, audioAssets = null, lookupSample = getSample) {
  const hasRecordings = recordingReferences(project).size > 0;
  return Object.assign(bufferedArchive(prepareStreamedProjectArchive(project, audioAssets, lookupSample), hasRecordings, 'Project'), { diskVersion: CURRENT_ARCHIVE_VERSION });
}

async function entryBytes(entry, limit) {
  if (!entry || entry.blob.size > limit) throw new Error('Project entry is missing or too large');
  const bytes = new Uint8Array(entry.blob.size);
  let at = 0;
  await copyZipEntry(entry, (part) => { bytes.set(part, at); at += part.length; });
  return bytes;
}

// Imported IDs belong to the caller on success; failed imports are removed here.
async function readStreamedArchive(file, audioAssets, moduleFile = false) {
  const entries = await readZipStream(file);
  const manifestName = moduleFile ? 'module.json' : 'project.json';
  const manifest = await entryBytes(entries.get(manifestName), MAX_MANIFEST_BYTES);
  entries.delete(manifestName);
  const manifestData = JSON.parse(decoder.decode(manifest));
  const { data, assets, audioFiles } = moduleFile
    ? readModuleManifest(manifestData)
    : readProjectManifest(manifestData, CURRENT_ARCHIVE_VERSION);
  const ids = sampleIds(data), refs = recordingReferences(moduleFile ? { patch: data } : data);
  if (refs.size && typeof audioAssets === 'function') audioAssets = audioAssets();
  if (refs.size && (!audioAssets || typeof audioAssets.importEntry !== 'function' || typeof audioAssets.discard !== 'function')) {
    throw new Error('Audio storage is unavailable');
  }
  if (ids.size !== Object.keys(assets).length || refs.size !== Object.keys(audioFiles).length) {
    throw new Error('Project media index does not match the project');
  }
  const samples = new Map();
  let mediaBytes = 0;
  for (const id of ids) {
    const asset = Object.hasOwn(assets, id) ? assets[id] : null;
    const entry = entries.get(asset?.path);
    if (!entry) throw new Error(`Project media is missing or listed twice: ${id}`);
    const bytes = await entryBytes(entry, MAX_PROJECT_BYTES - mediaBytes);
    let sample;
    if (asset.kind === 'image' && /^media\/images\/[^/]+\.png$/.test(asset.path)) {
      sample = await decodeProjectImage(bytes);
      mediaBytes += sample.rgb.length;
    } else if (asset.kind === 'audio' && /^media\/audio\/[^/]+\.wav$/.test(asset.path)) {
      sample = decodeProjectAudio(bytes, asset.rate);
      mediaBytes += sample.pcm.byteLength;
    } else throw new Error(`Invalid project media entry: ${id}`);
    if (mediaBytes > MAX_PROJECT_BYTES) throw new Error('Project media is too large');
    samples.set(id, sample);
    entries.delete(asset.path);
  }
  for (const [id] of refs) {
    const item = Object.hasOwn(audioFiles, id) ? audioFiles[id] : null;
    if (!/^media\/audioFiles\/[^/]+\.wav$/.test(item?.path ?? '') || !entries.has(item.path)) {
      throw new Error(`Project audio file is missing or listed twice: ${id}`);
    }
  }
  const imported = [];
  try {
    for (const [id, ref] of refs) {
      const path = audioFiles[id].path;
      const entry = entries.get(path);
      if (!entry) throw new Error(`Project audio file is missing or listed twice: ${id}`);
      const result = await audioAssets.importEntry(entry);
      imported.push(result.id);
      if (!sameRecording(ref, result)) throw new Error(`Audio clip metadata does not match its WAV: ${id}`);
      for (const clip of ref.clips) clip.audio.id = result.id;
      entries.delete(path);
    }
    if (entries.size) throw new Error('PHILSYNTH ZIP contains unlisted files');
    return { data: { ...data, samples }, version: CURRENT_ARCHIVE_VERSION, imported };
  } catch (error) {
    const failures = [error];
    for (const id of imported) {
      try { await audioAssets.discard(id); } catch (cleanupError) { failures.push(cleanupError); }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Project load and audio cleanup failed');
    throw error;
  }
}

export const readStreamedProjectArchive = (file, audioAssets) => readStreamedArchive(file, audioAssets);
export const readModuleArchive = (file, audioAssets) => readStreamedArchive(file, audioAssets, true);

export async function readProjectArchive(bytes) {
  if (bytes.length > MAX_PROJECT_BYTES) throw new Error('Project file is too large');
  if (!isProjectZip(bytes)) {
    const data = JSON.parse(decoder.decode(bytes));
    checkProjectData(data, 1);
    if (recordingReferences(data).size) throw new Error('Audio clips require a version 3 project');
    return { data, version: 1 };
  }
  const entries = readZip(bytes);
  const manifest = entries.get('project.json');
  if (!manifest) throw new Error('PHILSYNTH ZIP has no project.json');
  const { data, assets } = readProjectManifest(JSON.parse(decoder.decode(manifest)), 2);
  if (recordingReferences(data).size) throw new Error('Audio clips require a version 3 project');
  entries.delete('project.json');
  const ids = sampleIds(data);
  if (ids.size !== Object.keys(assets).length) throw new Error('Project media index does not match the project');
  const samples = new Map();
  let mediaBytes = 0;
  for (const id of ids) {
    const asset = Object.hasOwn(assets, id) ? assets[id] : null;
    const bytes = entries.get(asset?.path);
    if (!bytes) throw new Error(`Project media is missing or listed twice: ${id}`);
    let sample;
    if (asset.kind === 'image' && /^media\/images\/[^/]+\.png$/.test(asset.path)) {
      sample = await decodeProjectImage(bytes);
      mediaBytes += sample.rgb.length;
    } else if (asset.kind === 'audio' && /^media\/audio\/[^/]+\.wav$/.test(asset.path)) {
      sample = decodeProjectAudio(bytes, asset.rate);
      mediaBytes += sample.pcm.byteLength;
    } else throw new Error(`Invalid project media entry: ${id}`);
    if (mediaBytes > MAX_PROJECT_BYTES) throw new Error('Project media is too large');
    samples.set(id, sample);
    entries.delete(asset.path);
  }
  if (entries.size) throw new Error('PHILSYNTH ZIP contains unlisted files');
  return { data: { ...data, samples }, version: 2 };
}
