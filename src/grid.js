// Patcher "Snap to Grid": module boxes snap with their top-left corner to an invisible grid half a
// module high (20 px, see .module in style.css), the same distance sideways. Boxes wider than a
// grid step (long names) still snap by their left edge.
export const GRID = 20;

export const snapToGrid = (v, on = true) => (on ? Math.round(v / GRID) * GRID : Math.round(v));
