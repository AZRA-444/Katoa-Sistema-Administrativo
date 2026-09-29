export const API = {
  inventario: '/api/inventario',
  clientes: '/api/clientes',
  factura: '/api/precargar-factura',
  tasa: 'https://open.er-api.com/v6/latest/USD',
};
// [monto base en USD (exclusivo), % de descuento] — orden descendente
export const DESCUENTOS = [[500, 35], [300, 30], [200, 25], [100, 20], [50, 15], [20, 10], [10, 5]];
export const STORAGE = { vendedor: 'vendedorActual', tasa: 'tasaFacturacion' };
export const LOCALE = 'es-VE';
