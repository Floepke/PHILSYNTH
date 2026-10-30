// Double-press detection for the curve editors (WAVESHAPER curve, velocity strip, automation lane):
// down, up, DOWN counts as a double click already on the second press, so that press can create a
// point and keep dragging it without releasing first.
//   const dbl = doublePress();  dbl.press(e) -> true on the second press (call on every left press)
//   dbl.reset()  forget the last press (e.g. after it became a drag)
export function doublePress({ ms = 400, px = 6 } = {}) {
  let last = null;
  return {
    press(e) {
      const hit = !!last && e.timeStamp - last.time < ms && Math.hypot(e.clientX - last.x, e.clientY - last.y) < px;
      last = hit ? null : { time: e.timeStamp, x: e.clientX, y: e.clientY };
      return hit;
    },
    reset() { last = null; },
  };
}
