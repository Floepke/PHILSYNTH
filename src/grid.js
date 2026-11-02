// Patcher "Snap to Grid": module boxes snap with their top-left corner to an invisible grid one
// module high (40 px, see .module in style.css), the same distance sideways. Boxes wider than a
// grid step (long names) still snap by their left edge.
export const GRID = 40;

export const snapToGrid = (v, on = true) => (on ? Math.round(v / GRID) * GRID : Math.round(v));
