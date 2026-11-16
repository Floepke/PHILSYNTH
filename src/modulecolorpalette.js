import { hexToRgb } from './modcolor.js';

export const MODULE_COLOR_PALETTE = Object.freeze([
  '#dc7095', '#18d459', '#0f79fd', '#8e8205', '#79bbda', '#f99603', '#aa56e7', '#1f9197',
  '#ca95fe', '#eb3f06', '#a3b46e', '#8a75a8', '#04a322', '#7399fe', '#b16c55', '#fc6ad9',
  '#d341b0', '#df9e93', '#20b79b', '#c18d44', '#e8356d', '#fc7659', '#b48fbf', '#0a96d6',
  '#756de1', '#7ab303', '#6e996d', '#c970d4', '#e990c3', '#9f7dfe', '#b26387', '#d2ae05',
  '#59a5b7', '#0eb1f9', '#a39d18', '#a7aaec', '#e16d08', '#fe55a3', '#5ccb89', '#c5857d',
  '#7e90c4', '#02985f', '#08b565', '#d3595c', '#21c9ca', '#fb5668', '#e376ff', '#d3a96a',
  '#567fca', '#a8be1d', '#a074d0', '#6d9611', '#fc7d92', '#ae710f', '#b95fb1', '#2793ff',
  '#7dc2a7', '#9f90e6', '#d0528d', '#77a956', '#c75d15', '#e45cbe', '#e28c58', '#9b8c52',
  '#75b5fe', '#c068f9', '#caa1d0', '#27a28a', '#c851d4', '#558eb0', '#be77aa', '#23be34',
  '#77ad87', '#12b8d5', '#d68ba1', '#6280fb', '#68a3e1', '#8d63fa', '#ea86e7', '#fb7c01',
  '#e2726d', '#7cca29', '#ef73b7', '#8181d6', '#ab9f64', '#c56e7c', '#85be5f', '#d19a22',
  '#d087cb', '#f95f24', '#638f49', '#fd8c7d', '#bf7945', '#4c9076', '#64b5b1', '#5b6cfd',
  '#0e82e1', '#e95685', '#c580fc', '#58a936', '#ff8f51', '#e263e0', '#139cb6', '#9c84c3',
  '#25c2f5', '#e6419a', '#9d67b2', '#48a870', '#859543', '#e1897e', '#d26a49', '#eb364a',
  '#22a6d5', '#c99a70', '#19cdac', '#ba84de', '#b08418', '#df870a', '#8570c3', '#05c288',
  '#5b92e7', '#d267a9', '#80854c', '#54bf5c', '#6c7eb1', '#90a3d8', '#a4749a', '#ba99e3',
]);

export function nearestModuleColorIndex(color) {
  const [r, g, b] = hexToRgb(color);
  let best = 0;
  let distance = Infinity;
  for (let i = 0; i < MODULE_COLOR_PALETTE.length; i++) {
    const [pr, pg, pb] = hexToRgb(MODULE_COLOR_PALETTE[i]);
    const mean = (r + pr) / 2;
    const dr = r - pr;
    const dg = g - pg;
    const db = b - pb;
    const next = (2 + mean / 256) * dr ** 2 + 4 * dg ** 2 + (2 + (255 - mean) / 256) * db ** 2;
    if (next < distance) { best = i; distance = next; }
  }
  return best;
}
