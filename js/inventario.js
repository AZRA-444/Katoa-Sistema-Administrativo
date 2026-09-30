import { usd } from './utils/format.js';

const API = '/api/inventario';
const $ = (sel, raiz = document) => raiz.querySelector(sel);
function el(tag, props = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) (k in n && k !== 'list' ? (n[k] = v) : n.setAttribute(k, v));
    n.append(...hijos);
    return n;
}

const TIPOS = {
    REGISTRO: ['Registro', 1], LLEGADA: ['Llegada', 1], SALIDA_VENTA: ['Venta', -1],
    SALIDA_OTRO: ['Salida por otro motivo', -1], AJUSTE_ENTRADA: ['Ajuste de entrada', 1],
    AJUSTE_SALIDA: ['Ajuste de salida', -1], DEVOLUCION_CLIENTE: ['Devolución de cliente', 1],
    DEVOLUCION_PROVEEDOR: ['Devolución a proveedor', -1],
};
const MOTIVOS = {
    salida: ['Daño', 'Vencimiento', 'Obsequio', 'Muestra', 'Pérdida', 'Uso interno', 'Otro'],
    ajuste: ['Conteo físico', 'Error de registro', 'Otro'],
};
const CAMPOS = [
    ['color', 'Color (opcional)', 'text'], ['talla_presentacion', 'Talla o presentación (opcional)', 'text'],
    ['codigo_barras', 'Código de barras (se genera si queda vacío)', 'text'],
    ['precio_costo', 'Costo (USD)', 'dec'], ['precio_detal', 'Precio detal (USD)', 'dec'],
    ['precio_mayor', 'Precio mayor (USD)', 'dec'], ['cantidad_mayor', 'Mayor desde (unidades)', 'int'],
    ['precio_gran_mayor', 'Precio gran mayor (USD)', 'dec'], ['cantidad_gran_mayor', 'Gran mayor desde (unidades)', 'int'],
    ['cantidad_inicial', 'Stock inicial', 'int'], ['cantidad_minima', 'Mínimo', 'int'], ['cantidad_maxima', 'Máximo', 'int'],
];

const state = { items: [], admin: false, kVar: null, cache: new Map() };
let uid = 0, avisoT;

const nombreVar = (p) => [p.nombre, p.color, p.talla].filter(Boolean).join(' - ');
const etiqueta = (p) => `${nombreVar(p)} (${p.codigo_barras})`;
const fecha = (iso) => new Date(iso).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' });

function aviso(msg, error = false) {
    const n = $('#aviso');
    n.textContent = msg; n.hidden = false; n.style.background = error ? 'var(--danger)' : '';
    clearTimeout(avisoT); avisoT = setTimeout(() => (n.hidden = true), 4500);
}

async function api(url, cuerpo, reintentar = true) {
    const r = await fetch(url, {
        credentials: 'same-origin', method: cuerpo ? 'POST' : 'GET',
        headers: { Accept: 'application/json', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    if (r.status === 401) {
        if (reintentar && (await fetch('/api/sesion', { credentials: 'same-origin', cache: 'no-store' }).then((x) => x.ok).catch(() => false)))
            return api(url, cuerpo, false);
        location.replace('/login.html?next=' + encodeURIComponent(location.pathname));
        throw new Error('Sesión expirada');
    }
    const d = await r.json().catch(() => null);
    if (!r.ok || d?.status !== 'ok') throw new Error(d?.message || 'No se pudo completar la operación.');
    return d;
}
const consulta = (modo, params = {}) => {
    const qs = new URLSearchParams({ modo });
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return api(`${API}?${qs}`).then((d) => d.data);
};

function campo(id, texto, props) {
    return el('div', { className: 'field' }, el('label', { htmlFor: id, textContent: texto }), el('input', { id, ...props }));
}
function mostrarError(nodo, msg) { nodo.textContent = msg; nodo.hidden = !msg; }

//--- EXISTENCIAS ---//
async function cargarLista() {
    try {
        state.items = await consulta('lista', { q: $('#fBuscar').value.trim(), seccion: $('#fSeccion').value, alerta: $('#fAlerta').value });
        for (const p of state.items) state.cache.set(etiqueta(p), p);
        pintarLista();
    } catch (e) { aviso(e.message, true); }
}

function celdaPrecios(p) {
    const td = el('td', { className: 'precios' }, el('div', { textContent: `Detal ${usd(Number(p.precio_detal))}` }));
    if (p.precio_mayor > 0 && p.cantidad_mayor > 0) td.append(el('div', { textContent: `Mayor ${usd(Number(p.precio_mayor))} desde ${p.cantidad_mayor}` }));
    if (p.precio_gran_mayor > 0 && p.cantidad_gran_mayor > 0) td.append(el('div', { textContent: `Gran mayor ${usd(Number(p.precio_gran_mayor))} desde ${p.cantidad_gran_mayor}` }));
    return td;
}
function boton(icono, texto, fn, extra = '') {
    const b = el('button', { type: 'button', title: texto, className: extra });
    b.setAttribute('aria-label', texto);
    b.append(el('i', { className: icono }));
    b.addEventListener('click', fn);
    return b;
}

function pintarLista() {
    const filas = state.items.map((p) => {
        const stock = el('td', { className: 'n' }, String(p.cantidad));
        if (p.alerta !== 'ok') stock.append(el('span', { className: 'badge ' + (p.alerta === 'bajo' ? 'warn' : 'alto'), textContent: p.alerta === 'bajo' ? 'Mínimo' : 'Máximo' }));
        const nombre = el('td', {}, el('div', { className: 'prod-nombre', textContent: nombreVar(p) }),
            el('div', { className: 'muted', textContent: [p.marca, p.seccion].filter(Boolean).join(' - ') }));
        const tr = el('tr', {}, nombre, el('td', { textContent: p.codigo_barras }), stock, celdaPrecios(p));
        if (state.admin) {
            tr.append(el('td', { className: 'n', textContent: usd(Number(p.precio_costo)) }),
                el('td', {}, el('div', { className: 'acts' },
                    boton('fas fa-arrow-right-from-bracket', 'Registrar salida', () => abrirMov(p, 'salida')),
                    boton('fas fa-sliders', 'Ajustar stock', () => abrirMov(p, 'ajuste')),
                    boton('fas fa-clock-rotate-left', 'Ver kardex', () => verKardex(p)))));
        } else {
            tr.append(el('td', {}, el('div', { className: 'acts' }, boton('fas fa-clock-rotate-left', 'Ver kardex', () => verKardex(p)))));
        }
        return tr;
    });
    $('#filasInv').replaceChildren(...filas);
    $('#vacioInv').hidden = filas.length > 0;
    $('#contInv').textContent = filas.length;
}

//--- KARDEX ---//
async function cargarKardex() {
    try {
        const filas = await consulta('kardex', {
            variante: state.kVar?.id, seccion: $('#fSeccion').value, tipo: $('#kTipo').value,
            desde: $('#kDesde').value, hasta: $('#kHasta').value,
        });
        $('#filasK').replaceChildren(...filas.map((m) => {
            const [nombre, signo] = TIPOS[m.tipo] || [m.tipo, 0];
            const prod = el('td', {}, el('div', { className: 'prod-nombre', textContent: [m.producto, m.color, m.talla].filter(Boolean).join(' - ') }));
            if (m.lote) prod.append(el('div', { className: 'muted', textContent: `Lote ${m.lote}` }));
            return el('tr', {},
                el('td', { textContent: fecha(m.creado_en) }), prod, el('td', { textContent: nombre }),
                el('td', { className: 'n ' + (signo > 0 ? 'entra' : 'sale'), textContent: `${signo > 0 ? '+' : '−'}${m.cantidad}` }),
                el('td', { className: 'n' }, String(m.saldo_nuevo), el('span', { className: 'saldo-flecha', textContent: ` (antes ${m.saldo_anterior})` })),
                el('td', { className: 'n', textContent: m.costo_unitario == null ? '—' : usd(Number(m.costo_unitario)) }),
                el('td', { textContent: m.usuario || '—' }),
                el('td', { className: 'detalle-k', textContent: [m.motivo, m.referencia && `Ref. ${m.referencia}`].filter(Boolean).join(' - ') || '—' }));
        }));
        $('#contK').textContent = filas.length;
        $('#vacioK').hidden = filas.length > 0;
    } catch (e) { aviso(e.message, true); }
}

function verKardex(p) {
    state.kVar = p;
    $('#kQuitar').textContent = `Quitar filtro: ${nombreVar(p)}`;
    $('#kQuitar').hidden = false;
    cambiarTab('kardex');
}
function cambiarTab(cual) {
    const k = cual === 'kardex';
    $('#tabExist').setAttribute('aria-selected', String(!k));
    $('#tabKardex').setAttribute('aria-selected', String(k));
    $('#panExist').hidden = k; $('#panKardex').hidden = !k;
    if (k) cargarKardex();
}

//--- PRODUCTO NUEVO ---//
function filaVariante() {
    const n = ++uid;
    const fs = el('fieldset', { className: 'vrow' }, el('legend', { textContent: 'Variante' }));
    for (const [k, texto, tipo] of CAMPOS) {
        const props = { name: k, type: tipo === 'text' ? 'text' : 'number', maxLength: 32 };
        if (tipo !== 'text') Object.assign(props, { min: 0, step: tipo === 'dec' ? '0.01' : '1', inputMode: tipo === 'dec' ? 'decimal' : 'numeric' });
        const f = campo(`v${n}${k}`, texto, props);
        $('input', f).setAttribute('data-k', k);
        fs.append(f);
    }
    const lotes = el('input', { id: `v${n}lotes`, type: 'checkbox' });
    lotes.setAttribute('data-k', 'maneja_lotes');
    fs.append(el('div', { className: 'check' }, lotes, el('label', { htmlFor: `v${n}lotes`, textContent: 'Maneja lotes y vencimiento' })));
    const lote = campo(`v${n}lote`, 'Lote del stock inicial', { type: 'text', maxLength: 40, disabled: true });
    const venc = campo(`v${n}venc`, 'Vencimiento', { type: 'date', disabled: true });
    $('input', lote).setAttribute('data-k', 'lote'); $('input', venc).setAttribute('data-k', 'vencimiento');
    lotes.addEventListener('change', () => { $('input', lote).disabled = $('input', venc).disabled = !lotes.checked; });
    fs.append(lote, venc);
    if ($('#variantes').children.length) {
        const q = el('button', { type: 'button', className: 'btn btn-ghost quitar', textContent: 'Quitar variante' });
        q.addEventListener('click', () => fs.remove());
        fs.append(q);
    }
    return fs;
}

function leerFila(fs) {
    const v = {};
    for (const inp of fs.querySelectorAll('[data-k]')) {
        if (inp.disabled) continue;
        const val = inp.type === 'checkbox' ? inp.checked : inp.value.trim();
        if (val === '' || val === false) continue;
        v[inp.getAttribute('data-k')] = inp.type === 'number' ? Number(val) : val;
    }
    return v;
}

async function guardarProducto(e) {
    e.preventDefault();
    const err = $('#errProd'); mostrarError(err, '');
    const f = e.target.elements;
    const variantes = [...$('#variantes').children].map(leerFila);
    if (!f.nombre.value.trim()) return mostrarError(err, 'Escribe el nombre del producto.');
    if (!f.seccion_id.value) return mostrarError(err, 'Elige la sección.');
    for (const [i, v] of variantes.entries()) {
        if (!(v.precio_detal > 0)) return mostrarError(err, `Variante ${i + 1}: indica el precio detal.`);
        if (v.maneja_lotes && v.cantidad_inicial > 0 && !(v.lote && v.vencimiento)) return mostrarError(err, `Variante ${i + 1}: indica lote y vencimiento del stock inicial.`);
    }
    await enviar(e.target, err, { accion: 'crear', producto: { nombre: f.nombre.value, marca: f.marca.value, seccion_id: Number(f.seccion_id.value) }, variantes });
}

//--- LLEGADA ---//
let busquedaT;
function filaLinea() {
    const n = ++uid;
    const fs = el('fieldset', { className: 'vrow' }, el('legend', { textContent: 'Producto que llega' }));
    const prod = campo(`l${n}p`, 'Producto o código de barras', { type: 'text', autocomplete: 'off', placeholder: 'Escribe o escanea' });
    const pi = $('input', prod);
    pi.setAttribute('list', 'dlVariantes'); pi.setAttribute('data-k', 'p');
    const cant = campo(`l${n}c`, 'Cantidad', { type: 'number', min: 1, step: '1', inputMode: 'numeric' });
    const costo = campo(`l${n}k`, 'Costo unitario (USD)', { type: 'number', min: 0, step: '0.01', inputMode: 'decimal' });
    const lote = campo(`l${n}l`, 'Lote', { type: 'text', maxLength: 40, disabled: true });
    const venc = campo(`l${n}v`, 'Vencimiento', { type: 'date', disabled: true });
    [cant, costo, lote, venc].forEach((f, i) => $('input', f).setAttribute('data-k', ['c', 'k', 'l', 'v'][i]));
    pi.addEventListener('input', () => {
        clearTimeout(busquedaT);
        const item = state.cache.get(pi.value);
        if (item) {
            $('input', lote).disabled = $('input', venc).disabled = !item.maneja_lotes;
            if (!$('input', costo).value && Number(item.precio_costo) > 0) $('input', costo).value = item.precio_costo;
            return;
        }
        const q = pi.value.trim();
        if (q.length < 2) return;
        busquedaT = setTimeout(async () => {
            try {
                const r = await consulta('lista', { q });
                r.forEach((p) => state.cache.set(etiqueta(p), p));
                $('#dlVariantes').replaceChildren(...r.map((p) => el('option', { value: etiqueta(p) })));
            } catch { /* el aviso ya se muestra en cargarLista */ }
        }, 300);
    });
    fs.append(prod, cant, costo, lote, venc);
    if ($('#lineas').children.length) {
        const q = el('button', { type: 'button', className: 'btn btn-ghost quitar', textContent: 'Quitar línea' });
        q.addEventListener('click', () => fs.remove());
        fs.append(q);
    }
    return fs;
}

async function guardarLlegada(e) {
    e.preventDefault();
    const err = $('#errLleg'); mostrarError(err, '');
    const lineas = [];
    for (const [i, fs] of [...$('#lineas').children].entries()) {
        const v = leerFila(fs), item = state.cache.get(v.p || '');
        if (!item) return mostrarError(err, `Línea ${i + 1}: elige un producto de la lista.`);
        if (!(v.c >= 1) || !Number.isInteger(v.c)) return mostrarError(err, `Línea ${i + 1}: la cantidad debe ser un entero mayor que cero.`);
        if (!(v.k > 0)) return mostrarError(err, `Línea ${i + 1}: indica el costo unitario.`);
        if (item.maneja_lotes && !(v.l && v.v)) return mostrarError(err, `Línea ${i + 1}: indica lote y vencimiento.`);
        lineas.push({ variante_id: item.id, cantidad: v.c, costo: v.k, lote: v.l, vencimiento: v.v });
    }
    try {
        let prov = $('#lProv').value;
        const nuevo = $('#lNuevoProv').value.trim();
        if (nuevo) {
            await api(API, { accion: 'proveedor', nombre: nuevo });
            await cargarProveedores();
            prov = [...$('#lProv').options].find((o) => o.textContent.toLowerCase() === nuevo.toLowerCase())?.value || '';
        }
        await enviar(e.target, err, { accion: 'llegada', proveedor_id: prov ? Number(prov) : null, numero_factura: $('#lFact').value, lineas });
    } catch (x) { mostrarError(err, x.message); }
}

//--- SALIDA / AJUSTE ---//
let movActual = null;
function abrirMov(p, tipo) {
    movActual = { p, tipo };
    const ajuste = tipo === 'ajuste';
    $('#hMov').textContent = ajuste ? 'Ajustar stock' : 'Registrar salida';
    $('#btnMov').textContent = ajuste ? 'Registrar ajuste' : 'Registrar salida';
    $('#movProducto').textContent = `${nombreVar(p)} — stock actual: ${p.cantidad}`;
    $('#filaSentido').hidden = !ajuste;
    $('#mMotivo').replaceChildren(...MOTIVOS[tipo].map((m) => el('option', { value: m, textContent: m })));
    $('#formMov').reset(); mostrarError($('#errMov'), '');
    $('#dlgMov').showModal();
}

async function guardarMov(e) {
    e.preventDefault();
    const err = $('#errMov'); mostrarError(err, '');
    const cant = Number($('#mCant').value), detalle = $('#mDetalle').value.trim(), motivo = $('#mMotivo').value;
    if (!Number.isInteger(cant) || cant < 1) return mostrarError(err, 'La cantidad debe ser un entero mayor que cero.');
    if (motivo === 'Otro' && detalle.length < 3) return mostrarError(err, 'Describe el motivo en el detalle.');
    await enviar(e.target, err, {
        accion: movActual.tipo, variante_id: movActual.p.id, cantidad: cant,
        motivo: motivo === 'Otro' ? detalle : detalle ? `${motivo} - ${detalle}` : motivo,
        ...(movActual.tipo === 'ajuste' ? { sentido: $('#mSentido').value } : {}),
    });
}

//--- ENVÍO COMÚN ---//
async function enviar(form, err, cuerpo) {
    const btn = $('[type="submit"]', form); btn.disabled = true;
    try {
        const d = await api(API, cuerpo);
        form.closest('dialog').close();
        aviso(d.message || 'Listo.');
        await cargarLista();
        if (!$('#panKardex').hidden) await cargarKardex();
    } catch (x) { mostrarError(err, x.message); }
    finally { btn.disabled = false; }
}

//--- ARRANQUE ---//
async function cargarProveedores() {
    const r = await consulta('proveedores');
    $('#lProv').replaceChildren(el('option', { value: '', textContent: 'Sin proveedor' }), ...r.map((p) => el('option', { value: p.id, textContent: p.nombre })));
}

async function init() {
    if (window.Auth && !(await window.Auth.listo)) return;
    state.admin = !!window.Auth?.tieneNivel('admin');
    try {
        const secciones = await consulta('secciones');
        for (const s of secciones) {
            $('#fSeccion').append(el('option', { value: s.id, textContent: s.nombre }));
            $('#pSec').append(el('option', { value: s.id, textContent: s.nombre }));
        }
        if (state.admin) await cargarProveedores();
    } catch (e) { aviso(e.message, true); }
    $('#kTipo').append(...Object.entries(TIPOS).map(([v, [t]]) => el('option', { value: v, textContent: t })));

    let t;
    $('#fBuscar').addEventListener('input', () => { clearTimeout(t); t = setTimeout(cargarLista, 300); });
    for (const id of ['#fSeccion', '#fAlerta']) $(id).addEventListener('change', () => { cargarLista(); if (!$('#panKardex').hidden) cargarKardex(); });
    for (const id of ['#kTipo', '#kDesde', '#kHasta']) $(id).addEventListener('change', cargarKardex);
    $('#kQuitar').addEventListener('click', () => { state.kVar = null; $('#kQuitar').hidden = true; cargarKardex(); });
    $('#tabExist').addEventListener('click', () => cambiarTab('exist'));
    $('#tabKardex').addEventListener('click', () => cambiarTab('kardex'));
    document.addEventListener('click', (e) => { if (e.target.closest('[data-cerrar]')) e.target.closest('dialog').close(); });

    $('#btnNuevo')?.addEventListener('click', () => {
        $('#formProducto').reset(); mostrarError($('#errProd'), '');
        $('#variantes').replaceChildren(filaVariante());
        $('#dlgProducto').showModal();
    });
    $('#btnOtraVar')?.addEventListener('click', () => $('#variantes').append(filaVariante()));
    $('#formProducto').addEventListener('submit', guardarProducto);
    $('#btnLlegada')?.addEventListener('click', () => {
        $('#formLlegada').reset(); mostrarError($('#errLleg'), '');
        $('#lineas').replaceChildren(filaLinea());
        $('#dlgLlegada').showModal();
    });
    $('#btnOtraLinea').addEventListener('click', () => $('#lineas').append(filaLinea()));
    $('#formLlegada').addEventListener('submit', guardarLlegada);
    $('#formMov').addEventListener('submit', guardarMov);

    await cargarLista();
}

init();
