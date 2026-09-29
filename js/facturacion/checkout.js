import { $ } from './dom.js';
import { enviarFactura, guardarCliente } from './api.js';
import { calcularTotales, totalLinea } from './pricing.js';
import { getState, update } from './store.js';
import { abrirCliente } from './ui-cliente.js';

const idFactura = () => `FAC-${Date.now().toString().slice(-8)}-${Math.random().toString(36).slice(2, 8)}`;

function mostrar(estado, mensaje) {
  const d = $('#dlgEstado');
  d.querySelectorAll('[data-estado]').forEach((s) => { s.hidden = s.dataset.estado !== estado; });
  if (mensaje) $('#estadoMsg').textContent = mensaje;
  if (!d.open) d.showModal();
}

export function initCheckout() {
  const dlg = $('#dlgEstado');
  let enCurso = false;
  dlg.addEventListener('cancel', (e) => { if (enCurso) e.preventDefault(); });
  $('#btnEstadoCerrar').addEventListener('click', () => dlg.close());
  $('#btnProcesar').addEventListener('click', procesar);

  async function procesar() {
    const s = getState();
    const c = s.cliente;
    if (!c) return abrirCliente();

    const t = calcularTotales(s.items, s.tasa);
    const telefono = c.telefono.replace(/\D/g, '').replace(/^0/, '+58');
    const payload = {
      id_factura: idFactura(),
      nombre: c.nombre, apellido: c.apellido, cedula: c.cedula, telefono, vendedor: c.vendedor,
      tasa_cambio: s.tasa,
      subtotal_usd: t.subtotal, descuento_usd: t.descuento, total_usd: t.total,
      subtotal_bs: t.subtotalBs, descuento_bs: t.descuentoBs, total_bs: t.totalBs,
      productos: s.items.map((p) => ({
        nombre: p.nombre, cantidad: p.cantidad, precioUnitario: p.precioUnitario,
        precioTotal: totalLinea(p), excluidoDescuento: p.excluidoDescuento, idInventario: p.idInventario,
      })),
    };

    enCurso = true;
    $('#btnProcesar').disabled = true;
    mostrar('cargando');
    try {
      await enviarFactura(payload);
      mostrar('exito');
      guardarCliente({ cedula: c.cedula.replace(/\D/g, ''), nombre: c.nombre, apellido: c.apellido, telefono });
      update((st) => { st.items = []; });   // sin productos, el aviso de salida ya no aplica
      setTimeout(() => location.reload(), 1800);
    } catch (e) {
      mostrar('error', e.message);
      $('#btnProcesar').disabled = false;
    } finally {
      enCurso = false;
    }
  }
}
