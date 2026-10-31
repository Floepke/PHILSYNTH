// Cytomic / A. Simper ZDF state-variable tick, shared by FILTER and ECHO.
export const newSvf = () => ({ ic1: 0, ic2: 0, band: 0, low: 0 });

export function tickSvf(st, input, a1, a2, a3) {
  const v3 = input - st.ic2;
  const v1 = a1 * st.ic1 + a2 * v3;
  const v2 = st.ic2 + a2 * st.ic1 + a3 * v3;
  st.ic1 = 2 * v1 - st.ic1;
  st.ic2 = 2 * v2 - st.ic2;
  st.band = v1;
  st.low = v2;
}
