import { LOCALE } from './config.js';

const nf = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const usd = (n) => '$ ' + nf.format(n);
export const bs = (n) => 'Bs ' + nf.format(n);
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const formatText = (v) =>
  v.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑüÜ ]/g, '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
export const formatDoc = (v) =>
  v.replace(/\D/g, '').slice(0, 8).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
export const formatPhone = (v) => {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length > 7) return `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  return d.length > 4 ? `${d.slice(0, 4)}-${d.slice(4)}` : d;
};
export const FORMATTERS = { text: formatText, doc: formatDoc, phone: formatPhone };
