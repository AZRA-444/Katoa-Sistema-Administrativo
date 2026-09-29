import { $, el } from './dom.js';
import { buscarProductos } from './api.js';
import { precioUnitario } from './pricing.js';
import { usd, round2 } from './format.js';
import { getState, update } from './store.js';

let seq = 0;

export function initProducto() {
  const form = $('#formProducto');
  const nombre = $('#pNombre'), cant = $('#pCant'), precio = $('#pPrecio'), total = $('#pTotal');
  const lista = $('#sugerencias'), err = $('#productoError');
  let sel = null, timer, ctrl, activo = -1;

  const error = (msg, campo) => {
    err.textContent = msg; err.hidden = false;
    campo.setAttribute('aria-invalid', 'true'); campo.focus();
  };
  const limpiarError = () => {
    err.hidden = true;
    form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
  };
  const recalcular = () => {
    const c = Number(cant.value);
    if (sel && c > 0) precio.value = precioUnitario(c, sel).toFixed(2);
    total.value = c > 0 && Number(precio.value) > 0 ? usd(round2(c * precio.value)) : '—';
  };

  // ── Autocompletado ──
  const cerrar = () => {
    lista.hidden = true; lista.replaceChildren(); activo = -1;
    nombre.setAttribute('aria-expanded', 'false');
  };
  const marcar = (i) => {
    const items = [...lista.children];
    items.forEach((li, n) => { li.classList.toggle('active', n === i); li.setAttribute('aria-selected', n === i); });
    activo = i;
    items[i]?.scrollIntoView({ block: 'nearest' });
  };
  const etiqueta = (p) => [p.nombre, p.color, p.calibre].filter(Boolean).join(' - ');

  function elegir(p) {
    sel = {
      id: p.id, stock: Number(p.cantidad) || 0, precioDetal: Number(p.precio_detal) || 0,
      precioMayor: Number(p.precio_mayor) || 0, cantidadMayor: Number(p.cantidad_mayor) || 0,
    };
    nombre.value = etiqueta(p);
    if (!(Number(cant.value) > 0)) cant.value = 1;
    recalcular(); cerrar(); cant.select();
  }

  function pintar(resultados, texto) {
    const opciones = resultados.filter((p) => p?.id != null && etiqueta(p)).map((p) => {
      const mayor = Number(p.precio_mayor) > 0 && Number(p.cantidad_mayor) > 0;
      const stock = Number(p.cantidad) > 0 ? `Stock ${p.cantidad}` : 'Sin stock';
      const meta = `${usd(Number(p.precio_detal) || 0)}${mayor ? ` · mayor ${usd(p.precio_mayor)} desde ${p.cantidad_mayor}` : ''} · ${stock}`;
      const li = el('li', { className: 'opt' + (Number(p.cantidad) > 0 ? '' : ' sin-stock'), role: 'option' },
        el('span', { className: 'opt-nombre', textContent: etiqueta(p) }),
        el('span', { className: 'opt-meta', textContent: meta }));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); elegir(p); });
      return li;
    });
    const manual = el('li', { className: 'opt manual', role: 'option' },
      el('span', { className: 'opt-nombre', textContent: `Agregar «${texto}» sin inventario` }),
      el('span', { className: 'opt-meta', textContent: 'Escribe el precio a mano' }));
    manual.addEventListener('mousedown', (e) => { e.preventDefault(); cerrar(); precio.focus(); });
    lista.replaceChildren(...opciones, manual);
    lista.hidden = false; activo = -1;
    nombre.setAttribute('aria-expanded', 'true');
  }

  nombre.addEventListener('input', () => {
    sel = null; clearTimeout(timer); ctrl?.abort();
    const q = nombre.value.trim();
    if (q.length < 2) return cerrar();
    timer = setTimeout(async () => {
      ctrl = new AbortController();
      try {
        const r = await buscarProductos(q, ctrl.signal);
        if (nombre.value.trim() === q) pintar(r, q);
      } catch (e) { if (e.name !== 'AbortError') cerrar(); }
    }, 300);
  });

  nombre.addEventListener('keydown', (e) => {
    if (lista.hidden) return;
    const n = lista.children.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); marcar((activo + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); marcar((activo - 1 + n) % n); }
    else if (e.key === 'Enter' && activo >= 0) { e.preventDefault(); lista.children[activo].dispatchEvent(new MouseEvent('mousedown', { cancelable: true })); }
    else if (e.key === 'Escape') cerrar();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.combo')) cerrar(); });

  // ── Formulario ──
  form.addEventListener('input', (e) => { limpiarError(); if (e.target !== nombre) recalcular(); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    limpiarError();
    const c = Number(cant.value), pu = Number(precio.value), n = nombre.value.trim();
    if (!(getState().tasa > 0)) return error('Ingresa la tasa del día antes de agregar productos.', $('#tasa'));
    if (!n) return error('Escribe el nombre del producto.', nombre);
    if (!(c > 0)) return error('La cantidad debe ser mayor que cero.', cant);
    if (!(pu > 0)) return error('El precio unitario debe ser mayor que cero.', precio);
    update((s) => s.items.push({
      id: ++seq, idInventario: sel?.id ?? null, nombre: n, cantidad: c, precioUnitario: pu,
      stock: sel ? sel.stock : null, excluidoDescuento: false,
    }));
    form.reset(); sel = null; total.value = '—'; cerrar(); nombre.focus();
  });
}
