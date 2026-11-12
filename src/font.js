// One weight for all text; matches --font-weight in style.css.
export const WEIGHT = 600;

// Canvas font family; matches --font in style.css (bundled Fira Code).
export const FONT = "'Fira Code', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

// Canvas text only uses a web font once it has loaded, so wait for it before drawing.
export function loadFont(timeout = 1500) {
  const fonts = globalThis.document?.fonts;
  if (!fonts?.load) return Promise.resolve();
  const wait = fonts.load(`${WEIGHT} 12px 'Fira Code'`).catch(() => {});
  return Promise.race([wait, new Promise((done) => setTimeout(done, timeout))]);
}
