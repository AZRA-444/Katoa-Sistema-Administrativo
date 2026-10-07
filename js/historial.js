/* ==========================================================================
 * Facturas de hoy — Katoa
 * Lista las facturas del día con su previa y un detalle con acciones:
 * ver/imprimir PDF, reenviar por WhatsApp, ver comprobante y anular (solo admin).
 * Servidor: /api/historial (lista, comprobante, anular) y /api/factura-pdf (PDF y WhatsApp).
 * ========================================================================== */
import { usd, bs, round2 } from './utils/format.js';
import { urlPdfFactura, reenviarWhatsapp } from './utils/api.js';

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
const AVISOS_WA = {
    enviado: ['La factura se envió por WhatsApp al cliente.', false],
    sin_whatsapp: ['Este número no tiene WhatsApp. Imprime la factura en formato carta.', true],
    no_disponible: ['No se pudo enviar por WhatsApp en este momento. Inténtalo de nuevo.', true],
    no_configurado: ['El envío por WhatsApp no está configurado en el servidor.', true],
};

const state = { items: [], estado: '', q: '', actual: null, seq: 0, admin: false };
let avisoT;

const metodo = (m) => METODOS[m] ?? m ?? '—';
const hora = (iso) => new Date(iso).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Caracas' });
const fechaHora = (iso) => new Date(iso).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' });
const nombreCliente = (f) => [f.nombre, f.apellido].filter(Boolean).join(' ');
const dato = (v) => (v && v !== 'N/A' ? v : null);
const normal = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const soloDig = (s) => String(s ?? '').replace(/\D/g, '');

function aviso(msg, error = false) {
    const n = $('#aviso');
    n.textContent = msg; n.hidden = false;
    n.classList.toggle('error', error);
    n.setAttribute('aria-live', error ? 'assertive' : 'polite');
    clearTimeout(avisoT); avisoT = setTimeout(() => (n.hidden = true), error ? 7000 : 4500);
}

async function api(url, cuerpo, reintentar = true) {
    let r;
    try {
        r = await fetch(url, {
            credentials: 'same-origin', method: cuerpo ? 'POST' : 'GET',
            headers: { Accept: 'application/json', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
            body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        });
    } catch {
        throw new Error('Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo.');
    }
    if (r.status === 401) {
        if (reintentar && (await fetch('/api/sesion', { credentials: 'same-origin', cache: 'no-store' }).then((x) => x.ok).catch(() => false)))
            return api(url, cuerpo, false);
        location.replace('/login.html?next=' + encodeURIComponent(location.pathname));
        throw new Error('Sesión expirada');
    }
    const d = await r.json().catch(() => null);
    if (!r.ok || d?.status !== 'ok') throw new Error(d?.message || d?.error || 'No se pudo completar la operación.');
    return d;
}

//--- LISTA ---//
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
        if (d.truncado) nota.textContent = 'Hay más facturas hoy de las que se pueden mostrar. Se listan las 300 más recientes.';
        pintarResumen(); pintarLista();
        if (state.actual) {                    // refresca el detalle abierto (p. ej. tras anular)
            const f = state.items.find((x) => x.id_factura === state.actual);
            if (f && $('#dlgFactura').open) abrirDetalle(f); else if (!f) $('#dlgFactura').close();
        }
    } catch (e) {
        if (seq === state.seq) aviso(e.message, true);
    } finally {
        if (seq === state.seq) { $('#lista').classList.remove('cargando'); $('#lista').setAttribute('aria-busy', 'false'); }
    }
}

//--- DETALLE ---//
function linea(rotulo, valor) {
    return valor ? el('div', {}, el('dt', { textContent: rotulo }), el('dd', { textContent: valor })) : null;
}

function abrirDetalle(f) {
    state.actual = f.id_factura;
    const anulada = f.estado === 'anulada';
    $('#hFac').textContent = `Factura ${f.id_factura}`;
    $('#detSub').textContent = fechaHora(f.created_at);

    const banner = $('#detAnulada');
    banner.hidden = !anulada;
    if (anulada) {
        banner.textContent = `Anulada el ${fechaHora(f.anulada_en)}${f.anulada_por_nombre ? ` por ${f.anulada_por_nombre}` : ''}. Motivo: ${f.motivo_anulacion}`;
    }

    $('#detDatos').replaceChildren(...[
        linea('Cliente', nombreCliente(f)), linea('Cédula', dato(f.cedula)), linea('Teléfono', dato(f.telefono)),
        linea('Vendedor', f.vendedor), linea('Método de pago', metodo(f.metodo_pago)),
        f.metodo_pago !== 'MIXTO' ? linea('Banco', dato(f.banco)) : null,
        f.metodo_pago !== 'MIXTO' ? linea('Referencia', dato(f.referencia)) : null,
        linea('Tasa de cambio', f.tasa_cambio ? `Bs ${Number(f.tasa_cambio).toLocaleString('es-VE', { minimumFractionDigits: 2 })}` : null),
    ].filter(Boolean));

    $('#detProductos').replaceChildren(...f.factura_detalles.map((d) => el('tr', {},
        el('td', { textContent: d.nombre_producto }),
        el('td', { className: 'n', textContent: String(Number(d.cantidad)) }),
        el('td', { className: 'n', textContent: usd(Number(d.precio_unitario)) }),
        el('td', { className: 'n', textContent: usd(Number(d.precio_total)) }))));

    const pagos = $('#detPagos');
    pagos.replaceChildren();
    if (f.metodo_pago === 'MIXTO') {
        pagos.append(el('h3', { textContent: 'Forma de pago · combinado' }));
        if (Array.isArray(f.pagos_combinados) && f.pagos_combinados.length) {
            for (const p of f.pagos_combinados) {
                const extra = [dato(p.banco) && `Banco: ${p.banco}`, dato(p.referencia) && `Ref.: ${p.referencia}`, dato(p.observaciones)].filter(Boolean).join(' · ');
                pagos.append(el('div', { className: 'pago-lin' },
                    el('span', { textContent: metodo(p.metodo) }),
                    el('strong', { textContent: `${p.moneda === 'USD' ? usd(Number(p.monto)) : bs(Number(p.monto))}  (abona ${usd(Number(p.abono_usd))})` }),
                    ...(extra ? [el('small', { textContent: extra })] : [])));
            }
        } else {
            pagos.append(el('p', { className: 'muted', textContent: 'El desglose de este pago combinado no quedó guardado (factura registrada antes de la corrección). El PDF sí lo muestra.' }));
        }
    }

    $('#detTotales').replaceChildren(
        el('span', { textContent: `Subtotal: ${usd(Number(f.subtotal_usd))}` }),
        el('strong', { textContent: `Total: ${usd(Number(f.total_usd))}` }),
        el('strong', { textContent: bs(Number(f.total_bs)) }));
    const obs = $('#detObs');
    obs.hidden = !f.observaciones;
    obs.textContent = f.observaciones ? `Observaciones: ${f.observaciones}` : '';

    // Una factura anulada no se imprime ni se reenvía (el PDF no dice «anulada»).
    $('#btnPdf').hidden = anulada;
    $('#btnWa').hidden = anulada || !soloDig(f.telefono);
    $('#btnComp').hidden = !f.tiene_comprobante;
    const btnAn = $('#btnAnular');
    if (btnAn) btnAn.hidden = anulada;

    if (!$('#dlgFactura').open) $('#dlgFactura').showModal();
}

const actual = () => state.items.find((f) => f.id_factura === state.actual);

function verPdf() {
    const f = actual();
    if (f) window.open(urlPdfFactura(f.id_factura), '_blank', 'noopener');
}

async function reenviar() {
    const f = actual(); const btn = $('#btnWa');
    if (!f || btn.disabled) return;
    btn.disabled = true;
    try {
        const estado = await reenviarWhatsapp(f.id_factura, f.telefono);
        const [msg, error] = AVISOS_WA[estado] ?? AVISOS_WA.no_disponible;
        aviso(msg, error);
    } catch (e) {
        aviso(e.message, true);
    } finally { btn.disabled = false; }
}

function verComprobante() {
    const f = actual();
    if (!f) return;
    const img = $('#compImg'), estado = $('#compEstado');
    img.hidden = true; img.removeAttribute('src');
    estado.hidden = false; estado.textContent = 'Cargando comprobante…';
    img.onload = () => { estado.hidden = true; img.hidden = false; };
    img.onerror = () => { estado.textContent = 'No se pudo cargar el comprobante.'; };
    img.src = `${API}?modo=comprobante&id=${encodeURIComponent(f.id_factura)}`;
    $('#dlgComp').showModal();
}

//--- ANULAR ---//
function abrirAnular() {
    const f = actual();
    if (!f) return;
    $('#formAnular').reset();
    $('#errAnular').hidden = true;
    $('#aMotivo').removeAttribute('aria-invalid');
    $('#anularInfo').textContent = `${f.id_factura} · ${nombreCliente(f)} · ${usd(Number(f.total_usd))}`;
    $('#dlgAnular').showModal();
    $('#aMotivo').focus();
}

async function confirmarAnular(e) {
    e.preventDefault();
    const f = actual(); const btn = $('#btnConfirmarAnular'); const err = $('#errAnular');
    const motivo = $('#aMotivo').value.replace(/\s+/g, ' ').trim();
    if (motivo.length < 3) {
        $('#aMotivo').setAttribute('aria-invalid', 'true');
        err.textContent = 'Escribe el motivo de la anulación (mínimo 3 caracteres).'; err.hidden = false;
        return $('#aMotivo').focus();
    }
    if (!f || btn.disabled) return;
    btn.disabled = true; err.hidden = true;
    try {
        const d = await api(API, { accion: 'anular', id_factura: f.id_factura, motivo });
        $('#dlgAnular').close();
        aviso(d.message);
        await cargar();
    } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
    } finally { btn.disabled = false; }
}

//--- INICIO ---//
async function init() {
    if (window.Auth && !(await window.Auth.listo)) return;
    state.admin = !!window.Auth?.tieneNivel('admin');

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
        if (f) abrirDetalle(f);
    });
    $('#btnActualizar').addEventListener('click', cargar);
    $('#btnPdf').addEventListener('click', verPdf);
    $('#btnWa').addEventListener('click', reenviar);
    $('#btnComp').addEventListener('click', verComprobante);
    $('#btnAnular')?.addEventListener('click', abrirAnular);
    $('#formAnular').addEventListener('submit', confirmarAnular);
    $('#aMotivo').addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));
    $('#aviso').addEventListener('click', () => ($('#aviso').hidden = true));
    document.addEventListener('click', (e) => { if (e.target.closest('[data-cerrar]')) e.target.closest('dialog').close(); });
    $('#dlgFactura').addEventListener('close', () => { state.actual = null; });
    $('#dlgComp').addEventListener('close', () => { const i = $('#compImg'); i.removeAttribute('src'); i.hidden = true; });

    await cargar();
}

init();
