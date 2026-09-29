const state = { items: [], tasa: 0, tasaManual: false, cliente: null };
const subs = new Set();

export const getState = () => state;
export const subscribe = (fn) => (subs.add(fn), () => subs.delete(fn));
export function update(mutar) {
  mutar(state);
  subs.forEach((fn) => fn(state));
}
