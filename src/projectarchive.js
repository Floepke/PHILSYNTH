import { PROJECT_FORMAT, isProject, jsonFileText } from './fileformat.js';
import { getSample, sampleIds } from './samples.js';
import { encodeProjectAudio, decodeProjectAudio, encodeProjectImage, decodeProjectImage } from './projectmedia.js';
import { MAX_PROJECT_BYTES, isProjectZip, readZip, writeZip } from './projectzip.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export async function readProjectBytes(file) {
  if (file.size > MAX_PROJECT_BYTES) throw new Error('Project file is too large');
  return new Uint8Array(await file.arrayBuffer());
}

function checkProject(data, version) {
  if (!isProject(data) || !Array.isArray(data.patch?.modules)) throw new Error('Not a PHILSYNTH project file');
  if (version === 1 ? data.version != null && data.version !== 1 : data.version !== 2) {
    throw new Error(`Unsupported PHILSYNTH project version: ${data.version ?? 'missing'}`);
  }
}

// Capture the model now; encode only after the save destination is chosen. Pool bytes are immutable.
export function prepareProjectArchive(project, lookupSample = getSample) {
  const { samples: _samples, ...model } = project;
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
  const manifest = jsonFileText({ ...model, format: PROJECT_FORMAT, version: 2, assets });
  return async () => {
    const entries = new Map([['project.json', encoder.encode(manifest)]]);
    for (const { path, sample, image } of media) {
      entries.set(path, image ? await encodeProjectImage(sample) : encodeProjectAudio(sample));
    }
    return writeZip(entries);
  };
}

export async function readProjectArchive(bytes) {
  if (bytes.length > MAX_PROJECT_BYTES) throw new Error('Project file is too large');
  if (!isProjectZip(bytes)) {
    const data = JSON.parse(decoder.decode(bytes));
    checkProject(data, 1);
    return { data, version: 1 };
  }
  const entries = readZip(bytes);
  const manifest = entries.get('project.json');
  if (!manifest) throw new Error('PHILSYNTH ZIP has no project.json');
  const { assets, ...data } = JSON.parse(decoder.decode(manifest)) ?? {};
  checkProject(data, 2);
  if (data.format !== PROJECT_FORMAT || Object.hasOwn(data, 'samples') ||
      !assets || typeof assets !== 'object' || Array.isArray(assets)) throw new Error('Invalid PHILSYNTH ZIP manifest');
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
