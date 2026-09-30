/* ============================================================================
 * Pepidos — Katoa
 * Flujo: 1) datos del cliente  2) tasa y productos  3) pago  4) enviar
 * Formateadores → utils/format.js · Llamadas al servidor → utils/api.js
 * ========================================================================== */
import { FORMATTERS, usd, bs, round2, soloDigitos, telefonoE164 } from './utils/format.js';
import { buscarProductos, buscarCliente, guardarCliente, obtenerTasa, obtenerTasaUsdt, enviarFactura, urlPdfFactura, reenviarWhatsapp } from './utils/api.js';

