// Content-keyed, reference-counted image preparation. Worklet messages clone RGB arrays, so
// identity alone cannot share images across Patch instances. Compare bytes after hashing.
export function imageCache(create, destroy = () => {}) {
  const buckets = new Map();
  return {
    acquire(width, height, rgb) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || !(rgb instanceof Uint8Array) || rgb.length !== width * height * 3) return null;
      let hash = 2166136261;
      for (let i = 0; i < rgb.length; i++) hash = Math.imul(hash ^ rgb[i], 16777619);
      const key = `${width}:${height}:${hash}`;
      const bucket = buckets.get(key) ?? [];
      let entry = bucket.find((e) => e.rgb.every((v, i) => v === rgb[i]));
      if (!entry) {
        entry = { key, rgb: rgb.slice(), value: create(width, height, rgb), refs: 0 };
        bucket.push(entry);
        buckets.set(key, bucket);
      }
      entry.refs++;
      return entry;
    },
    release(entry) {
      if (!entry || --entry.refs) return;
      const bucket = buckets.get(entry.key);
      bucket.splice(bucket.indexOf(entry), 1);
      if (!bucket.length) buckets.delete(entry.key);
      destroy(entry.value);
    },
  };
}
