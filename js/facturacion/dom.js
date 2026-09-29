export const $ = (selector, raiz = document) => raiz.querySelector(selector);

export function el(tag, props = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) (k in n ? (n[k] = v) : n.setAttribute(k, v));
  n.append(...hijos);
  return n;
}
