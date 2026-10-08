/* ==========================================================================
 * Devoluciones de productos — Katoa (solo admin y sysadmin)
 * Lista las devoluciones del periodo y permite registrar una nueva sobre una factura NO anulada
 * (total o parcial). El stock vuelve por el kardex en el servidor (/api/administrador → api/_devoluciones.py → registrar_devolucion).
 * Se puede abrir directo con  devoluciones.html?factura=FAC-123
 * ========================================================================== */
import { usd, bs, num, round2, fechaHora, hoyISO, sumarDias } from './utils/format.js';
import { abrirFactura, api, aviso } from './factura-modal.js';

const API = '/api/administrador';   // devoluciones vive dentro de esta función (límite de funciones de Vercel)
const $ = (sel, raiz = document) => raiz.querySelector(sel);
function el(tag, props = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) (k in n && k !== 'list' ? (n[k] = v) : n.setAttribute(k, v));
    n.append(...hijos);
    return n;
}

const state = { items: [], q: '', seq: 0, factura: null, enviando: false, abierta: null };

const nombreCliente = (f) => [f?.nombre, f?.apellido].filter(Boolean).join(' ');
const normal = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const cantTxt = (n) => num(n).replace(/,00$/, '');          // 2,00 → 2
const resumenProductos = (ds) => ds.map((d) => `${cantTxt(d.cantidad)} × ${d.nombre_producto}`).join(' · ');
const cen = (n) => Math.round(Number(n) * 100);              // dinero en centavos enteros

//--- Lista ---//
function visibles() {
    const q = normal(state.q).trim();
    if (!q) return state.items;
    return state.items.filter((d) =>
        normal(`${d.id} ${d.id_factura} ${nombreCliente(d.factura)} ${d.motivo} ${d.registrada_por ?? ''} ${resumenProductos(d.detalles)}`).includes(q));
}

function pintarResumen(filas) {
    const suma = (campo) => filas.reduce((s, d) => s + cen(d[campo]), 0) / 100;
    $('#kCant').textContent = String(filas.length);
    $('#kUni').textContent = cantTxt(filas.reduce((s, d) => s + d.detalles.reduce((t, x) => t + Number(x.cantidad), 0), 0));
    $('#kUsd').textContent = usd(round2(suma('total_reembolso_usd')));
    $('#kBs').textContent = bs(round2(suma('total_reembolso_bs')));
}

function fila(d) {
    const tr = el('tr', { className: 'fila-dev', tabIndex: 0 });
    tr.dataset.id = String(d.id);
    const btnFactura = el('button', { type: 'button', className: 'btn-enlace', textContent: d.id_factura, title: 'Ver factura' });
    btnFactura.dataset.verFactura = d.id_factura;     // lo abre factura-modal.js
    tr.append(
        el('td', { textContent: fechaHora(d.created_at) }),
        el('td', { textContent: `#${d.id}` }),
        el('td', {}, btnFactura),
        el('td', { textContent: nombreCliente(d.factura) || '—' }),
        el('td', { className: 'cel-prod', textContent: resumenProductos(d.detalles) || '—' }),
        el('td', { className: 'n' }, el('strong', { textContent: usd(Number(d.total_reembolso_usd)) }), el('br'),
            el('small', { className: 'muted', textContent: bs(Number(d.total_reembolso_bs)) })),
        el('td', { textContent: d.registrada_por || '—' }));
    return tr;
}

function pintarLista() {
    const filas = visibles();
    $('#filas').replaceChildren(...filas.map(fila));
    $('#cont').textContent = String(filas.length);
    $('#vacio').hidden = filas.length > 0;
    $('#vacioTxt').textContent = state.items.length === 0
        ? 'No hay devoluciones en este periodo.' : 'Ninguna devolución coincide con la búsqueda.';
    pintarResumen(filas);
}

async function cargar() {
    const seq = ++state.seq;
    const desde = $('#fDesde').value, hasta = $('#fHasta').value;
    $('#filas').closest('.table-wrap').classList.add('cargando');
    try {
        const qs = new URLSearchParams({ modo: 'dev_lista' });
        if (desde) qs.set('desde', desde);
        if (hasta) qs.set('hasta', hasta);
        const d = await api(`${API}?${qs}`);
        if (seq !== state.seq) return;
        state.items = d.data;
        if (!desde) $('#fDesde').value = d.desde;
        if (!hasta) $('#fHasta').value = d.hasta;
        const nota = $('#nota');
        nota.hidden = !d.truncado;
        if (d.truncado) nota.textContent = `Hay más devoluciones de las que se pueden mostrar. Se listan las ${d.limite} más recientes: acorta las fechas.`;
        pintarLista();
    } catch (e) {
        if (seq === state.seq) aviso(e.message, true);
    } finally {
        if (seq === state.seq) $('#filas').closest('.table-wrap').classList.remove('cargando');
    }
}

//--- Detalle de una devolución ---//
function abrirDetalle(d) {
    state.abierta = d;
    $('#hDetalle').textContent = `Devolución #${d.id}`;
    $('#xSub').textContent = fechaHora(d.created_at);
    const dato = (k, v) => el('div', {}, el('dt', { textContent: k }), el('dd', { textContent: v || '—' }));
    $('#xDatos').replaceChildren(
        dato('Factura', d.id_factura), dato('Cliente', nombreCliente(d.factura)),
        dato('Registrada por', d.registrada_por), dato('Motivo', d.motivo));
    $('#xLineas').replaceChildren(...d.detalles.map((x) => el('tr', {},
        el('td', { textContent: x.nombre_producto }),
        el('td', { className: 'n', textContent: cantTxt(x.cantidad) }),
        el('td', { className: 'n', textContent: usd(Number(x.precio_unitario)) }),
        el('td', { className: 'n', textContent: usd(Number(x.precio_total)) }),
        el('td', { className: 'c' }, x.reingresa_stock
            ? el('span', { className: 'badge', textContent: 'Reingresó' })
            : el('span', { className: 'badge sin-stock', textContent: 'No reingresó' })))));
    $('#xTotales').replaceChildren(
        el('span', { textContent: `A precio de lista: ${usd(Number(d.total_lista_usd))}` }),
        el('strong', { textContent: `Reembolso: ${usd(Number(d.total_reembolso_usd))}` }),
        el('strong', { textContent: bs(Number(d.total_reembolso_bs)) }));
    $('#dlgDetalle').showModal();
}

//--- Nueva devolución ---//
function paso(n) {
    $('#paso1').hidden = n !== 1;
    $('#paso2').hidden = n !== 2;
    $('#btnRegistrar').hidden = n !== 2;
    $('#dTotales').hidden = n !== 2;
    $('#dError').hidden = true;
}

function abrirNueva() {
    state.factura = null;
    $('#formNueva').reset();
    $('#resFac').replaceChildren();
    $('#bHint').hidden = false;
    paso(1);
    $('#dlgNueva').showModal();
    $('#bFactura').focus();
}

let tBusca;
async function buscarFacturas() {
    const q = $('#bFactura').value.trim();
    const seq = ++state.seq;
    if (q.length < 2) {
        $('#resFac').replaceChildren();
        $('#bHint').textContent = 'Escribe al menos 2 caracteres. Las facturas anuladas no aparecen.';
        $('#bHint').hidden = false;
        return;
    }
    try {
        const d = await api(`${API}?modo=dev_buscar&q=${encodeURIComponent(q)}`);
        if (seq !== state.seq) return;
        $('#bHint').textContent = 'No se encontraron facturas (las anuladas no aparecen).';
        $('#bHint').hidden = d.data.length > 0;
        $('#resFac').replaceChildren(...d.data.map((f) => {
            const b = el('button', { type: 'button' },
                el('span', { className: 'r-top' }, el('span', { textContent: f.id_factura }), el('span', { textContent: usd(Number(f.total_usd)) })),
                el('span', { className: 'r-sub', textContent: `${nombreCliente(f) || 'Sin nombre'} · ${fechaHora(f.created_at)} · Vendedor: ${f.vendedor}` }));
            b.dataset.id = f.id_factura;
            return el('li', {}, b);
        }));
    } catch (e) { if (seq === state.seq) { $('#dError').textContent = e.message; $('#dError').hidden = false; } }
}

async function elegirFactura(id) {
    try {
        const f = (await api(`${API}?modo=dev_factura&id=${encodeURIComponent(id)}`)).data;
        if (f.estado === 'anulada') throw new Error('Esta factura está anulada: no admite devoluciones.');
        if (!f.detalles.some((d) => d.disponible > 0)) throw new Error('Todos los productos de esta factura ya fueron devueltos.');
        state.factura = f;
        pintarLineas();
        paso(2);
        if (!$('#dlgNueva').open) $('#dlgNueva').showModal();
        $('#dlgNueva').querySelector('#dLineas input:not(:disabled)')?.focus();
    } catch (e) { aviso(e.message, true); }
}

function pintarLineas() {
    const f = state.factura;
    $('#dFactura').textContent = `Factura ${f.id_factura} · ${usd(Number(f.total_usd))}`;
    $('#dCliente').textContent = `${nombreCliente(f) || 'Sin nombre'} · ${fechaHora(f.created_at)} · Vendedor: ${f.vendedor}`;
    $('#dLineas').replaceChildren(...f.detalles.map((d) => {
        const agotada = d.disponible <= 0;
        const tr = el('tr', { className: agotada ? 'agotada' : '' });
        tr.dataset.id = String(d.id);
        const cant = el('input', {
            type: 'number', min: '0', max: String(d.disponible), step: d.en_inventario ? '1' : 'any',
            inputMode: d.en_inventario ? 'numeric' : 'decimal', value: '', placeholder: '0', disabled: agotada,
        });
        cant.setAttribute('aria-label', `Cantidad a devolver de ${d.nombre_producto}`);
        const chk = el('input', { type: 'checkbox', checked: d.en_inventario && !agotada, disabled: agotada || !d.en_inventario });
        chk.setAttribute('aria-label', `${d.nombre_producto} vuelve al inventario`);
        tr.append(
            el('td', {}, d.nombre_producto, ...(!d.en_inventario ? [el('span', { className: 'libre', textContent: 'Producto libre: no maneja stock' })] : [])),
            el('td', { className: 'n', textContent: cantTxt(d.cantidad) }),
            el('td', { className: 'n', textContent: cantTxt(d.devuelto) }),
            el('td', { className: 'n' }, agotada ? el('span', { textContent: '—' }) : cant),
            el('td', { className: 'c' }, chk));
        return tr;
    }));
    recalcular();
}

/** Líneas con cantidad > 0. `error` = primera cantidad inválida (se marca en rojo). */
function leerLineas() {
    const lineas = [];
    let error = null;
    for (const tr of $('#dLineas').children) {
        const d = state.factura.detalles.find((x) => String(x.id) === tr.dataset.id);
        const inp = tr.querySelector('input[type="number"]');
        if (!d || !inp || inp.disabled) continue;
        const v = inp.value.trim() === '' ? 0 : Number(inp.value);
        const mal = !Number.isFinite(v) || v < 0 || v > d.disponible + 1e-9 || (d.en_inventario && v !== Math.trunc(v));
        inp.setAttribute('aria-invalid', String(mal));
        if (mal && !error) error = { inp, texto: d.en_inventario
            ? `«${d.nombre_producto}»: devuelve entre 0 y ${cantTxt(d.disponible)} unidades enteras.`
            : `«${d.nombre_producto}»: devuelve entre 0 y ${cantTxt(d.disponible)}.` };
        if (!mal && v > 0) lineas.push({ d, cantidad: v, reingresa: tr.querySelector('input[type="checkbox"]').checked });
    }
    return { lineas, error };
}

function recalcular() {
    const f = state.factura;
    if (!f) return;
    const { lineas } = leerLineas();
    const lista = lineas.reduce((s, l) => s + cen(round2(Number(l.d.precio_unitario) * l.cantidad)), 0) / 100;
    const factor = Number(f.subtotal_usd) > 0 ? Number(f.total_usd) / Number(f.subtotal_usd) : 1;
    const reembolso = Math.min(round2(lista * factor), Number(f.total_usd));
    const uni = lineas.reduce((s, l) => s + l.cantidad, 0);
    $('#dTotales').replaceChildren(
        el('span', { textContent: `Unidades: ${cantTxt(uni)}` }),
        el('span', { textContent: `A precio de lista: ${usd(round2(lista))}` }),
        el('strong', { textContent: `Reembolso estimado: ${usd(reembolso)} · ${bs(round2(reembolso * Number(f.tasa_cambio || 0)))}` }));
}

async function registrar(e) {
    e.preventDefault();
    const err = $('#dError');
    err.hidden = true;
    if (state.enviando || !state.factura) return;
    const { lineas, error } = leerLineas();
    const falla = (txt, foco) => { err.textContent = txt; err.hidden = false; foco?.focus(); };
    if (error) return falla(error.texto, error.inp);
    if (!lineas.length) return falla('Indica la cantidad a devolver de al menos un producto.', $('#dLineas input:not(:disabled)'));
    const motivo = $('#dMotivo').value.replace(/\s+/g, ' ').trim();
    if (motivo.length < 3) { $('#dMotivo').setAttribute('aria-invalid', 'true'); return falla('Escribe el motivo de la devolución (mínimo 3 caracteres).', $('#dMotivo')); }
    $('#dMotivo').removeAttribute('aria-invalid');

    const f = state.factura;
    const sinStock = lineas.filter((l) => !l.reingresa).length;
    const msg = `¿Registrar la devolución de ${lineas.length} producto(s) de la factura ${f.id_factura}?\n`
        + `${$('#dTotales').textContent}\n`
        + (sinStock ? `${sinStock} producto(s) NO volverán al inventario.\n` : 'Todo volverá al inventario.\n')
        + 'Esto no se puede deshacer.';
    if (!window.confirm(msg)) return;

    const btn = $('#btnRegistrar');
    state.enviando = true; btn.disabled = true;
    try {
        const d = await api(API, {
            accion: 'devolucion_registrar', id_factura: f.id_factura, motivo,
            lineas: lineas.map((l) => ({ detalle_id: l.d.id, cantidad: l.cantidad, reingresa: l.reingresa })),
        });
        $('#dlgNueva').close();
        aviso(d.message);
        document.dispatchEvent(new CustomEvent('devolucion:registrada', { detail: { id: d.id, id_factura: f.id_factura } }));
        cargar();
    } catch (ex) {
        falla(ex.message);
    } finally { state.enviando = false; btn.disabled = false; }
}

//--- Inicio ---//
async function init() {
    if (window.Auth && !(await window.Auth.listo)) return;
    if (!window.Auth?.tieneNivel('admin')) return;     // la página ya quedó vacía (data-admin-only); el servidor también lo exige

    $('#fHasta').value = hoyISO();
    $('#fDesde').value = sumarDias(hoyISO(), -29);

    let t;
    $('#fBuscar').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; pintarLista(); }, 200); });
    for (const id of ['#fDesde', '#fHasta']) $(id).addEventListener('change', cargar);
    $('#btnActualizar').addEventListener('click', cargar);
    $('#btnNueva').addEventListener('click', abrirNueva);

    const abrir = (tr) => { const d = state.items.find((x) => String(x.id) === tr?.dataset.id); if (d) abrirDetalle(d); };
    $('#filas').addEventListener('click', (e) => { if (!e.target.closest('[data-ver-factura]')) abrir(e.target.closest('tr')); });
    $('#filas').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('tr')) abrir(e.target); });
    $('#xFactura').addEventListener('click', () => state.abierta && abrirFactura(state.abierta.id_factura));

    document.addEventListener('click', (e) => { if (e.target.closest('[data-cerrar]')) e.target.closest('dialog').close(); });
    $('#bFactura').addEventListener('input', () => { clearTimeout(tBusca); tBusca = setTimeout(buscarFacturas, 300); });
    $('#resFac').addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) elegirFactura(b.dataset.id); });
    $('#btnOtra').addEventListener('click', () => { state.factura = null; paso(1); $('#bFactura').focus(); });
    $('#dLineas').addEventListener('input', recalcular);
    $('#dLineas').addEventListener('change', recalcular);
    $('#formNueva').addEventListener('submit', registrar);
    $('#dMotivo').addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));

    await cargar();

    const previa = new URLSearchParams(location.search).get('factura');
    if (previa && /^[A-Za-z0-9-]{1,64}$/.test(previa)) { abrirNueva(); elegirFactura(previa); }
}

init();
