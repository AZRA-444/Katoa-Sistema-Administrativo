import { DESCUENTOS } from './config.js';
import { round2 } from './format.js';

export const totalLinea = (p) => round2(p.cantidad * p.precioUnitario);

export function precioUnitario(cantidad, { precioDetal, precioMayor, cantidadMayor }) {
  return precioMayor > 0 && cantidadMayor > 0 && cantidad >= cantidadMayor ? precioMayor : precioDetal;
}

export const porcentajeDescuento = (base) => DESCUENTOS.find(([min]) => base > min)?.[1] ?? 0;

// Solo se guarda USD; los Bs se derivan de la tasa vigente (sin recalcular por producto).
export function calcularTotales(items, tasa) {
  const suma = (lista) => round2(lista.reduce((a, p) => a + totalLinea(p), 0));
  const subtotal = suma(items);
  const porcentaje = porcentajeDescuento(suma(items.filter((p) => !p.excluidoDescuento)));
  const base = suma(items.filter((p) => !p.excluidoDescuento));
  const descuento = round2((base * porcentaje) / 100);
  const total = round2(subtotal - descuento);
  const aBs = (n) => round2(n * tasa);
  return { subtotal, porcentaje, descuento, total, subtotalBs: aBs(subtotal), descuentoBs: aBs(descuento), totalBs: aBs(total) };
}
