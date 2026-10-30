// Canvas camera: screen = world × z + (x, y). Module positions are stored in world units,
// so panning/zooming never changes the project, only the view.
export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 1.15; // per mouse-wheel notch

export const defaultCam = () => ({ x: 0, y: 0, z: 1 });

export function validCam(c) {
  return c && [c.x, c.y, c.z].every(Number.isFinite) && c.z > 0
    ? { x: c.x, y: c.y, z: clampZoom(c.z) }
    : defaultCam();
}

export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

export const toWorld = (cam, sx, sy) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z });
export const toScreen = (cam, wx, wy) => ({ x: wx * cam.z + cam.x, y: wy * cam.z + cam.y });

// Zoom by `factor` keeping the world point under screen point (sx, sy) fixed.
export function zoomAt(cam, sx, sy, factor) {
  const z = clampZoom(cam.z * factor);
  const w = toWorld(cam, sx, sy);
  return { x: sx - w.x * z, y: sy - w.y * z, z };
}

// Camera that shows the world rectangle `box` ({l, t, r, b}) centred in a w × h view,
// never zooming in beyond `maxZoom`.
export function fitBox(box, w, h, { margin = 60, maxZoom = 1 } = {}) {
  const bw = Math.max(1, box.r - box.l);
  const bh = Math.max(1, box.b - box.t);
  const z = clampZoom(Math.min(maxZoom, (w - 2 * margin) / bw, (h - 2 * margin) / bh));
  return { x: w / 2 - ((box.l + box.r) / 2) * z, y: h / 2 - ((box.t + box.b) / 2) * z, z };
}
