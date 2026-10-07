/* ==========================================================================
 * Facturas de hoy — Katoa
 * Lista las facturas del día con su previa. Al tocar una tarjeta se abre la vista previa
 * (js/factura-modal.js): PDF, WhatsApp, comprobante y anular.
 * Servidor: /api/historial
 * ========================================================================== */
import { usd, bs, round2 } from './utils/format.js';
import { abrirFactura, api, aviso } from './factura-modal.js';

const API = '/api/historial';
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
function el(tag, props = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) (k in n && k !== 'list' ? (n[k] = v) : n.setAttribute(k, v));
    n.append(...hijos);
    return n;
}

const METODOS = {
    MIXTO: 'Pago combinado', PM: 'Pago móvil', PVD: 'Punto de venta (débito)', PVC: 'Punto de venta (crédito)',
    ED: 'Efectivo en dólares', EBS: 'Efectivo en bolívares', ZELLE: 'Zelle', BINANCE: 'Binance', OTROS: 'Otros',
};
const state = { items: [], estado: '', q: '', seq: 0 };

const metodo = (m) => METODOS[m] ?? m ?? '—';
const hora = (iso) => new Date(iso).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Caracas' });
const nombreCliente = (f) => [f.nombre, f.apellido].filter(Boolean).join(' ');
const normal = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const soloDig = (s) => String(s ?? '').replace(/\D/g, '');

function visibles() {
    const q = normal(state.q).trim();
    const dig = soloDig(state.q);
    return state.items.filter((f) => {
        if (state.estado && f.estado !== state.estado) return false;
        if (!q) return true;
        return normal(`${f.id_factura} ${nombreCliente(f)}`).includes(q)
            || (dig.length >= 3 && (soloDig(f.cedula).includes(dig) || soloDig(f.telefono).includes(dig)));
    });
}

function pintarResumen() {
    const activas = state.items.filter((f) => f.estado !== 'anulada');
    // Se suma en centavos enteros para no arrastrar error de coma flotante.
    const suma = (campo) => activas.reduce((s, f) => s + Math.round(Number(f[campo]) * 100), 0) / 100;
    $('#kCant').textContent = String(activas.length);
    $('#kUsd').textContent = usd(round2(suma('total_usd')));
    $('#kBs').textContent = bs(round2(suma('total_bs')));
    const anuladas = state.items.length - activas.length;
    $('#kpiAnuladas').hidden = anuladas === 0;
    $('#kAnul').textContent = String(anuladas);
}

function tarjeta(f) {
    const anulada = f.estado === 'anulada';
    const productos = f.factura_detalles.map((d) => `${Number(d.cantidad)} × ${d.nombre_producto}`).join(' · ');
    const b = el('button', { type: 'button', className: `fac${anulada ? ' anulada' : ''}` });
    b.dataset.id = f.id_factura;
    b.append(
        el('div', { className: 'fac-top' },
            el('span', { className: 'fac-id', textContent: f.id_factura }),
            el('span', { className: 'fac-hora', textContent: hora(f.created_at) })),
        el('div', { className: 'fac-cliente', textContent: nombreCliente(f) || 'Sin nombre' }),
        el('div', { className: 'fac-meta' },
            el('span', { className: 'badge metodo', textContent: metodo(f.metodo_pago) }),
            el('span', { textContent: `Vendedor: ${f.vendedor}` }),
            ...(anulada ? [el('span', { className: 'badge anulada', textContent: 'Anulada' })] : [])),
        el('div', { className: 'fac-items', textContent: productos || 'Sin productos' }),
        el('div', { className: 'fac-total' },
            el('strong', { textContent: usd(Number(f.total_usd)) }),
            el('span', { textContent: bs(Number(f.total_bs)) })));
    return b;
}

function pintarLista() {
    const filas = visibles();
    $('#lista').replaceChildren(...filas.map(tarjeta));
    $('#cont').textContent = String(filas.length);
    $('#vacio').hidden = filas.length > 0;
    $('#vacioTxt').textContent = state.items.length === 0
        ? 'Hoy todavía no hay facturas.' : 'Ninguna factura coincide con la búsqueda o el filtro.';
}

async function cargar() {
    const seq = ++state.seq;
    $('#lista').classList.add('cargando'); $('#lista').setAttribute('aria-busy', 'true');
    try {
        const d = await api(API);
        if (seq !== state.seq) return;
        state.items = d.data;
        const nota = $('#nota');
        nota.hidden = !d.truncado;
        if (d.truncado) nota.textContent = `Hay más facturas hoy de las que se pueden mostrar. Se listan las ${d.limite} más recientes.`;
        pintarResumen(); pintarLista();
    } catch (e) {
        if (seq === state.seq) aviso(e.message, true);
    } finally {
        if (seq === state.seq) { $('#lista').classList.remove('cargando'); $('#lista').setAttribute('aria-busy', 'false'); }
    }
}

async function init() {
    if (window.Auth && !(await window.Auth.listo)) return;
    let t;
    $('#fBuscar').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; pintarLista(); }, 200); });
    for (const b of $$('.filtro')) b.addEventListener('click', () => {
        state.estado = b.dataset.estado;
        for (const x of $$('.filtro')) x.setAttribute('aria-pressed', String(x === b));
        pintarLista();
    });
    $('#lista').addEventListener('click', (e) => {
        const b = e.target.closest('.fac');
        const f = b && state.items.find((x) => x.id_factura === b.dataset.id);
        if (f) abrirFactura(f.id_factura, { onAnulada: cargar });   // se consulta de nuevo: siempre el dato actual
    });
    $('#btnActualizar').addEventListener('click', cargar);
    await cargar();
}

init();
