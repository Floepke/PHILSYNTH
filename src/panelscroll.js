// Keep native content scrolling (wheel, focus, scrollIntoView), with a jump-to-click track.
export function initPanelScroll(panel, track, thumb) {
  let geometry = null;
  let pending = false;
  let drag = null;
  const update = () => {
    pending = false;
    const height = panel.clientHeight;
    const max = Math.max(0, panel.scrollHeight - height);
    track.hidden = max === 0 || height === 0;
    const size = Math.min(height, Math.max(48, height * height / Math.max(1, panel.scrollHeight)));
    const travel = Math.max(0, height - size);
    geometry = { max, size, travel };
    thumb.style.height = `${size}px`;
    thumb.style.transform = `translateY(${max ? panel.scrollTop / max * travel : 0}px)`;
    track.setAttribute('aria-valuemax', String(max));
    track.setAttribute('aria-valuenow', String(Math.round(panel.scrollTop)));
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(update);
  };
  panel.classList.add('jump-scroll');
  panel.addEventListener('scroll', schedule, { passive: true });
  const observer = new ResizeObserver(schedule);
  observer.observe(panel);
  observer.observe(panel.firstElementChild);
  track.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    update();
    const { max, size, travel } = geometry;
    if (!travel || !max) return;
    const y = event.clientY - track.getBoundingClientRect().top;
    const top = panel.scrollTop / max * travel;
    const offset = event.target === thumb ? y - top : size / 2;
    drag = { id: event.pointerId, offset };
    track.setPointerCapture(event.pointerId);
    track.classList.add('dragging');
    move(event);
  });
  function move(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const { max, travel } = geometry;
    const y = event.clientY - track.getBoundingClientRect().top - drag.offset;
    panel.scrollTop = travel ? Math.max(0, Math.min(1, y / travel)) * max : 0;
    schedule();
  }
  track.addEventListener('pointermove', move);
  const stop = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    track.classList.remove('dragging');
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) track.addEventListener(type, stop);
  track.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey || !event.deltaY) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? panel.clientHeight : 1;
    panel.scrollTop += event.deltaY * unit;
    schedule();
  }, { passive: false });
  track.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const values = {
      ArrowUp: panel.scrollTop - 40, ArrowDown: panel.scrollTop + 40,
      PageUp: panel.scrollTop - panel.clientHeight, PageDown: panel.scrollTop + panel.clientHeight,
      Home: 0, End: panel.scrollHeight,
    };
    if (!(event.key in values)) return;
    event.preventDefault();
    panel.scrollTop = values[event.key];
    schedule();
  });
  update();
}
