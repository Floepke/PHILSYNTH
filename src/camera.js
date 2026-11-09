// Canvas camera: screen = world × z + (x, y). Module positions are stored in world units,
// so panning/zooming never changes the project, only the view.
import { wheelNotches } from './params.js';

export const ZOOM_MIN = 0.15;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 1.15; // per mouse-wheel notch

export const defaultCam = () => ({ x: 0, y: 0, z: 1 });

export function validCam(c) {
  return c && [c.x, c.y, c.z].every(Number.isFinite) && c.z > 0
    ? { x: c.x, y: c.y, z: clampZoom(c.z) }
    : defaultCam();
}

export const clampZoom = (z) => (Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) : 1);

export const toWorld = (cam, sx, sy) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z });
export const toScreen = (cam, wx, wy) => ({ x: wx * cam.z + cam.x, y: wy * cam.z + cam.y });

// Keep the same world point at the centre when the viewport changes size.
export function resizeCam(cam, oldWidth, oldHeight, width, height) {
  return { x: cam.x + (width - oldWidth) / 2, y: cam.y + (height - oldHeight) / 2, z: cam.z };
}

// Zoom by `factor` keeping the world point under screen point (sx, sy) fixed.
export function zoomAt(cam, sx, sy, factor) {
  const z = clampZoom(cam.z * factor);
  const w = toWorld(cam, sx, sy);
  return { x: sx - w.x * z, y: sy - w.y * z, z };
}

// Wheel and pinch zoom around the pointer on every platform.
export function wheelCam(cam, e, sx, sy) {
  return zoomAt(cam, sx, sy, Math.pow(ZOOM_STEP, wheelNotches(e.deltaY, e.deltaMode)));
}

// Pan limit: the world rectangle `box` ({l, t, r, b}, all the modules) may move almost out of the
// w × h view, but `keep` px of it always stay inside on each axis: panning down stops when the
// bottom edge of the lowest module is `keep` px below the top of the view, and so on for the other
// sides. Everything in between pans freely. Zoom is kept.
export function clampCam(cam, box, w, h, keep = 40) {
  if (!box || !(w > 0 && h > 0)) return cam;
  const axis = (pos, lo, hi, size) => {
    const k = Math.min(keep, size / 2);
    const min = k - hi * cam.z; // far edge of the box k px past the view's near edge
    const max = size - k - lo * cam.z; // near edge of the box k px before the view's far edge
    return Math.min(max, Math.max(min, pos));
  };
  return { x: axis(cam.x, box.l, box.r, w), y: axis(cam.y, box.t, box.b, h), z: cam.z };
}

// Camera that shows the world rectangle `box` ({l, t, r, b}) centred in a w × h view,
// never zooming in beyond `maxZoom`.
export function fitBox(box, w, h, { margin = 60, maxZoom = 1 } = {}) {
  const bw = Math.max(1, box.r - box.l);
  const bh = Math.max(1, box.b - box.t);
  const z = clampZoom(Math.min(maxZoom, (w - 2 * margin) / bw, (h - 2 * margin) / bh));
  return { x: w / 2 - ((box.l + box.r) / 2) * z, y: h / 2 - ((box.t + box.b) / 2) * z, z };
}
