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

//--- CIFRAS Y FECHAS (hora de Venezuela) ---//
const TZ = 'America/Caracas';
export const num = (n) => nf.format(Number(n) || 0);
export const entero = (n) => new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 }).format(Number(n) || 0);
export const porcentaje = (n) => `${nf.format(Number(n) || 0)} %`;
/** AAAA-MM-DD de hoy en Venezuela (no en la zona del dispositivo). */
export const hoyISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
/** Suma días a un AAAA-MM-DD sin pasar por zonas horarias. */
export const sumarDias = (iso, dias) => {
    const [a, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
};
export const fechaHora = (iso) => (iso ? new Date(iso).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short', timeZone: TZ }) : '—');
export const soloHora = (iso) => (iso ? new Date(iso).toLocaleTimeString(LOCALE, { timeStyle: 'short', timeZone: TZ }) : '—');
/** AAAA-MM-DD -> 05/10/2026 */
export const fechaISO = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

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
