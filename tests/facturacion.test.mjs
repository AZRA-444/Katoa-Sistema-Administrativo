import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularTotales, precioUnitario, porcentajeDescuento } from '../js/facturacion/pricing.js';
import { formatDoc, formatPhone, formatText } from '../js/facturacion/format.js';

test('descuento escalonado (umbrales exclusivos)', () => {
  assert.equal(porcentajeDescuento(10), 0);
  assert.equal(porcentajeDescuento(10.01), 5);
  assert.equal(porcentajeDescuento(501), 35);
});
test('los productos excluidos no generan ni reciben descuento', () => {
  const t = calcularTotales([
    { cantidad: 1, precioUnitario: 100, excluidoDescuento: false },
    { cantidad: 1, precioUnitario: 100, excluidoDescuento: true },
  ], 10);
  assert.deepEqual([t.porcentaje, t.descuento, t.total, t.totalBs], [15, 15, 185, 1850]);
});
test('precio mayor al alcanzar el umbral', () => {
  const p = { precioDetal: 3, precioMayor: 2, cantidadMayor: 10 };
  assert.equal(precioUnitario(10, p), 2);
  assert.equal(precioUnitario(9, p), 3);
});
test('formateadores', () => {
  assert.equal(formatDoc('12345678'), '12.345.678');
  assert.equal(formatPhone('04123456789'), '0412-345-6789');
  assert.equal(formatText('juan perez'), 'Juan Perez');
});
