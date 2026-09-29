/* Formateadores y utilidades numéricas. Sin dependencias del DOM. */

const LOCALE = 'es-VE';
const nf = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

//--- DINERO ---//
/** Redondeo a 2 decimales "half-up" sin el ruido de coma flotante (igual que el servidor: 4,725 → 4,73). */
export const round2 = (n) => {
    const s = String(Number(n.toPrecision(15)));
    return s.includes('e') ? Math.round(n * 100) / 100 : Number(Math.round(`${s}e2`) + 'e-2');
};
export const usd = (n) => '$ ' + nf.format(n);
export const bs = (n) => 'Bs ' + nf.format(n);

//--- TEXTO / DOCUMENTOS ---//
export const soloDigitos = (v) => String(v).replace(/\D/g, '');

/** Solo letras y espacios, cada palabra con mayúscula inicial. */
export const formatText = (v) =>
    v.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑüÜ ]/g, '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

/** Cédula: 12345678 → 12.345.678 (máx. 8 dígitos). */
export const formatDoc = (v) =>
    soloDigitos(v).slice(0, 8).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Teléfono: 04123456789 → 0412-345-6789. */
export const formatPhone = (v) => {
    const d = soloDigitos(v).slice(0, 11);
    if (d.length > 7) return `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
    return d.length > 4 ? `${d.slice(0, 4)}-${d.slice(4)}` : d;
};

/** 0412-345-6789 → +584123456789 (formato que espera el backend). */
export const telefonoE164 = (v) => soloDigitos(v).replace(/^0/, '+58');

/** Se usan desde los inputs con data-format="text|doc|phone". */
export const FORMATTERS = { text: formatText, doc: formatDoc, phone: formatPhone };