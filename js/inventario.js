import { usd, round2 } from './utils/format.js';

const API = '/api/inventario';
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
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
// Campos de cada variante, agrupados para que el formulario sea más fácil de recorrer.
// [clave, etiqueta, tipo]  (tipo: text | dec | int)
const GRUPOS = [
    ['Identificación', [
        ['color', 'Color (opcional)', 'text'], ['talla_presentacion', 'Talla o presentación (opcional)', 'text'],
        ['codigo_barras', 'Código de barras (se genera si queda vacío)', 'text']]],
    ['Precios en USD', [['precio_costo', 'Costo', 'dec'], ['precio_detal', 'Precio detal', 'dec']]],
    ['Venta por volumen (opcional)', [
        ['precio_mayor', 'Precio mayor', 'dec'], ['cantidad_mayor', 'Mayor desde (unidades)', 'int'],
        ['precio_gran_mayor', 'Precio gran mayor', 'dec'], ['cantidad_gran_mayor', 'Gran mayor desde (unidades)', 'int']]],
    ['Stock', [['cantidad_inicial', 'Stock inicial', 'int'], ['cantidad_minima', 'Mínimo', 'int'], ['cantidad_maxima', 'Máximo', 'int']]],
];
const MAX_NUM = 1_000_000;

const state = { items: [], admin: false, kVar: null, cache: new Map(), alerta: '', seqLista: 0, seqK: 0 };
let uid = 0, avisoT;

const nombreVar = (p) => [p.nombre, p.color, p.talla].filter(Boolean).join(' - ');
const etiqueta = (p) => `${nombreVar(p)} (${p.codigo_barras})`;
const fecha = (iso) => new Date(iso).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' });
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

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
    if (!r.ok || d?.status !== 'ok') throw new Error(d?.message || 'No se pudo completar la operación.');
    return d;
}
/** GET de lectura: devuelve la respuesta completa ({ data, truncado }). */
const consulta = (modo, params = {}) => {
    const qs = new URLSearchParams({ modo });
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return api(`${API}?${qs}`);
};

function campo(id, texto, props) {
    return el('div', { className: 'field' }, el('label', { htmlFor: id, textContent: texto }), el('input', { id, ...props }));
}
function mostrarError(nodo, msg) {
    nodo.textContent = msg; nodo.hidden = !msg;
    if (!msg) $$('[aria-invalid]', nodo.closest('form')).forEach((x) => x.removeAttribute('aria-invalid'));
}
/** Muestra el error en el pie del diálogo y lleva el foco al campo culpable (abriendo su sección si está plegada). */
function falla(err, msg, input) {
    mostrarError(err, msg);
    if (input) {
        input.setAttribute('aria-invalid', 'true');
        const d = input.closest('details'); if (d) d.open = true;
        input.focus();
        input.scrollIntoView?.({ block: 'center' });
    }
}
function cargando(panel, on) {
    const w = $('.table-wrap', $(panel));
    w.setAttribute('aria-busy', String(on)); w.classList.toggle('cargando', on);
}
function nota(id, truncado, n) {
    const p = $(id); p.hidden = !truncado;
    if (truncado) p.textContent = `Se muestran los primeros ${n} resultados. Afina la búsqueda o los filtros para ver el resto.`;
}

//--- EXISTENCIAS ---//
const filtrosActivos = () => !!($('#fBuscar').value.trim() || $('#fSeccion').value || state.alerta);

async function cargarLista() {
    const n = ++state.seqLista;                  // si llega una respuesta más vieja que la última pedida, se descarta
    cargando('#panExist', true);
    try {
        const d = await consulta('lista', { q: $('#fBuscar').value.trim(), seccion: $('#fSeccion').value, alerta: state.alerta });
        if (n !== state.seqLista) return;
        state.items = d.data; state.truncado = !!d.truncado;
        for (const p of state.items) state.cache.set(etiqueta(p), p);
        pintarLista();
    } catch (e) { if (n === state.seqLista) aviso(e.message, true); }
    finally { if (n === state.seqLista) cargando('#panExist', false); }
}

function celda(etq, props, ...hijos) {
    const td = el('td', props, ...hijos);
    td.setAttribute('data-label', etq);       // en móvil cada fila se convierte en tarjeta y usa esta etiqueta
    return td;
}
function celdaPrecios(p) {
    const td = celda('Precios', { className: 'precios' }, el('div', { textContent: `Detal ${usd(Number(p.precio_detal))}` }));
    if (p.precio_mayor > 0 && p.cantidad_mayor > 0) td.append(el('div', { textContent: `Mayor ${usd(Number(p.precio_mayor))} desde ${p.cantidad_mayor}` }));
    if (p.precio_gran_mayor > 0 && p.cantidad_gran_mayor > 0) td.append(el('div', { textContent: `Gran mayor ${usd(Number(p.precio_gran_mayor))} desde ${p.cantidad_gran_mayor}` }));
    return td;
}
function boton(icono, texto, fn) {
    const b = el('button', { type: 'button', title: texto });
    b.setAttribute('aria-label', texto);
    b.append(el('i', { className: icono }), el('span', { className: 'lbl', textContent: texto }));
    b.addEventListener('click', fn);
    return b;
}
function estadoStock(p) {
    if (Number(p.cantidad) <= 0) return ['agotado', 'Agotado', 'badge warn'];
    if (p.alerta === 'bajo') return ['bajo', 'Stock bajo', 'badge bajo'];
    if (p.alerta === 'alto') return ['alto', 'Stock alto', 'badge alto'];
    return null;
}

function filaProducto(p) {
    const est = estadoStock(p);
    const stock = celda('Stock', { className: 'n' }, el('span', { className: 'stock-num', textContent: String(p.cantidad) }));
    if (est) stock.append(el('span', { className: est[2], textContent: est[1] }));
    const nombre = celda('Producto', { className: 'celda-titulo' }, el('div', { className: 'prod-nombre', textContent: nombreVar(p) }),
        el('div', { className: 'muted', textContent: [p.marca, p.seccion].filter(Boolean).join(' - ') }));
    const acts = [boton('fas fa-clock-rotate-left', 'Ver kardex', () => verKardex(p))];
    if (state.admin) acts.unshift(
        boton('fas fa-arrow-right-from-bracket', 'Registrar salida', () => abrirMov(p, 'salida')),
        boton('fas fa-sliders', 'Ajustar stock', () => abrirMov(p, 'ajuste')));
    const tr = el('tr', est ? { className: est[0] } : {}, nombre, celda('Código', { textContent: p.codigo_barras }), stock, celdaPrecios(p));
    if (state.admin) tr.append(celda('Costo', { className: 'n', textContent: usd(Number(p.precio_costo)) }));
    tr.append(celda('Acciones', {}, el('div', { className: 'acts' }, ...acts)));
    return tr;
}

function pintarLista() {
    const filas = state.items.map(filaProducto);
    $('#filasInv').replaceChildren(...filas);
    $('#contInv').textContent = filas.length;
    const filtrado = filtrosActivos();
    $('#vacioInv').hidden = filas.length > 0;
    $('#vacioTxt').textContent = filtrado ? 'No hay productos con estos filtros. Prueba a quitar alguno.'
        : state.admin ? 'Aún no hay productos. Registra el primero con «Nuevo producto».' : 'Aún no hay productos registrados.';
    $('#fLimpiar').hidden = !filtrado;
    nota('#notaInv', state.truncado, filas.length);

    const agotados = state.items.filter((p) => Number(p.cantidad) <= 0).length;
    const bajos = state.items.filter((p) => Number(p.cantidad) > 0 && p.alerta === 'bajo').length;
    const partes = [plural(agotados, 'agotado', 'agotados'), `${bajos} en stock bajo`];
    if (state.admin && !state.truncado) partes.push(`Valor a costo: ${usd(round2(state.items.reduce((s, p) => s + Number(p.cantidad) * Number(p.precio_costo || 0), 0)))}`);
    $('#resumenInv').textContent = filas.length ? partes.join(' · ') : '';
}

function limpiarFiltros() {
    $('#fBuscar').value = ''; $('#fSeccion').value = '';
    fijarAlerta('');
    cargarLista();
    $('#fBuscar').focus();
}
function fijarAlerta(v) {
    state.alerta = v;
    for (const b of $$('.filtro')) b.setAttribute('aria-pressed', String(b.dataset.alerta === v));
}

//--- KARDEX ---//
async function cargarKardex() {
    const desde = $('#kDesde').value, hasta = $('#kHasta').value;
    if (desde && hasta && desde > hasta) return aviso('La fecha «Desde» no puede ser posterior a «Hasta».', true);
    const n = ++state.seqK;
    cargando('#panKardex', true);
    try {
        const d = await consulta('kardex', { variante: state.kVar?.id, seccion: $('#kSeccion').value, tipo: $('#kTipo').value, desde, hasta });
        if (n !== state.seqK) return;
        const filas = d.data;
        $('#filasK').replaceChildren(...filas.map((m) => {
            const [nombre, signo] = TIPOS[m.tipo] || [m.tipo, 0];
            const prod = celda('Producto', { className: 'celda-titulo' }, el('div', { className: 'prod-nombre', textContent: [m.producto, m.color, m.talla].filter(Boolean).join(' - ') }));
            if (m.lote) prod.append(el('div', { className: 'muted', textContent: `Lote ${m.lote}` }));
            return el('tr', {},
                celda('Fecha', { textContent: fecha(m.creado_en) }), prod, celda('Movimiento', { textContent: nombre }),
                celda('Cantidad', { className: 'n ' + (signo > 0 ? 'entra' : 'sale'), textContent: `${signo > 0 ? '+' : '−'}${m.cantidad}` }),
                celda('Saldo', { className: 'n' }, String(m.saldo_nuevo), el('span', { className: 'saldo-flecha', textContent: ` (antes ${m.saldo_anterior})` })),
                celda('Costo', { className: 'n', textContent: m.costo_unitario == null ? '—' : usd(Number(m.costo_unitario)) }),
                celda('Usuario', { textContent: m.usuario || '—' }),
                celda('Detalle', { className: 'detalle-k', textContent: [m.motivo, m.referencia && `Ref. ${m.referencia}`].filter(Boolean).join(' - ') || '—' }));
        }));
        $('#contK').textContent = filas.length;
        $('#vacioK').hidden = filas.length > 0;
        nota('#notaK', !!d.truncado, filas.length);
    } catch (e) { if (n === state.seqK) aviso(e.message, true); }
    finally { if (n === state.seqK) cargando('#panKardex', false); }
}

function verKardex(p) {
    state.kVar = p;
    $('#kSeccion').value = '';                   // la variante ya acota el resultado; una sección distinta lo dejaría vacío
    $('#kQuitar').textContent = `Quitar filtro: ${nombreVar(p)}`;
    $('#kQuitar').hidden = false;
    cambiarTab('kardex');
}
function cambiarTab(cual, foco = false) {
    const k = cual === 'kardex';
    for (const [t, activo] of [[$('#tabExist'), !k], [$('#tabKardex'), k]]) {
        t.setAttribute('aria-selected', String(activo)); t.tabIndex = activo ? 0 : -1;
    }
    $('#panExist').hidden = k; $('#panKardex').hidden = !k;
    if (foco) (k ? $('#tabKardex') : $('#tabExist')).focus();
    if (k) cargarKardex();
}

//--- FILAS DINÁMICAS (variantes y líneas de llegada) ---//
/** Numera las filas y oculta «Quitar» cuando solo queda una (antes la primera fila podía quitarse al reabrir el diálogo). */
function renumerar(contenedor, etq) {
    const filas = [...$(contenedor).children];
    filas.forEach((fs, i) => {
        $('legend', fs).textContent = `${etq} ${i + 1}`;
        $('.quitar', fs).hidden = filas.length === 1;
    });
}
function botonQuitar(fs, contenedor, etq, alQuitar) {
    const q = el('button', { type: 'button', className: 'btn btn-ghost quitar', textContent: `Quitar ${etq.toLowerCase()}` });
    q.addEventListener('click', () => { fs.remove(); renumerar(contenedor, etq); alQuitar?.(); });
    return q;
}
function agregarFila(contenedor, crear, etq) {
    const fs = crear();
    $(contenedor).append(fs);
    renumerar(contenedor, etq);
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

//--- PRODUCTO NUEVO ---//
function filaVariante() {
    const n = ++uid;
    const fs = el('fieldset', { className: 'vrow' }, el('legend'));
    for (const [titulo, campos] of GRUPOS) {
        const cont = el('div', { className: 'grupo-campos' });
        for (const [k, texto, tipo] of campos) {
            const props = { name: k, type: tipo === 'text' ? 'text' : 'number' };
            if (tipo === 'text') props.maxLength = k === 'codigo_barras' ? 32 : 40;
            else Object.assign(props, { min: k === 'precio_detal' ? 0.01 : 0, max: MAX_NUM, step: tipo === 'dec' ? '0.01' : '1', inputMode: tipo === 'dec' ? 'decimal' : 'numeric' });
            if (k === 'precio_detal') props.required = true;
            const f = campo(`v${n}${k}`, texto, props);
            $('input', f).setAttribute('data-k', k);
            cont.append(f);
        }
        if (titulo.startsWith('Venta por volumen')) {          // opcional: plegado para no saturar el formulario
            fs.append(el('details', { className: 'grupo' }, el('summary', { textContent: titulo }), cont));
        } else {
            fs.append(el('div', { className: 'grupo' }, el('h3', { className: 'grupo-t', textContent: titulo }), cont));
        }
    }
    const lotes = el('input', { id: `v${n}lotes`, type: 'checkbox' });
    lotes.setAttribute('data-k', 'maneja_lotes');
    const lote = campo(`v${n}lote`, 'Lote del stock inicial', { type: 'text', maxLength: 40, disabled: true });
    const venc = campo(`v${n}venc`, 'Vencimiento', { type: 'date', disabled: true });
    $('input', lote).setAttribute('data-k', 'lote'); $('input', venc).setAttribute('data-k', 'vencimiento');
    const loteBox = el('div', { className: 'grupo-campos', hidden: true }, lote, venc);
    lotes.addEventListener('change', () => { $('input', lote).disabled = $('input', venc).disabled = !lotes.checked; loteBox.hidden = !lotes.checked; });
    fs.append(el('div', { className: 'grupo' }, el('h3', { className: 'grupo-t', textContent: 'Lotes' }),
        el('div', { className: 'check' }, lotes, el('label', { htmlFor: `v${n}lotes`, textContent: 'Maneja lotes y vencimiento' })), loteBox));
    fs.append(botonQuitar(fs, '#variantes', 'Variante'));
    return fs;
}

const etiquetaDe = (inp) => (inp.labels?.[0]?.textContent || inp.name || 'campo').replace(/\s*\(.*\)\s*$/, '');

async function guardarProducto(e) {
    e.preventDefault();
    const err = $('#errProd'); mostrarError(err, '');
    const f = e.target.elements;
    if (!f.nombre.value.trim()) return falla(err, 'Escribe el nombre del producto.', f.nombre);
    if (!f.seccion_id.value) return falla(err, 'Elige la sección.', f.seccion_id);
    const variantes = [], colores = new Set(), barras = new Set();
    for (const [i, fs] of [...$('#variantes').children].entries()) {
        const pre = `Variante ${i + 1}: `, inp = (k) => $(`[data-k="${k}"]`, fs);
        // novalidate desactiva el aviso del navegador, pero checkValidity() sigue aplicando min/max/step/required
        const malo = $$('input', fs).find((x) => !x.disabled && !x.checkValidity());
        if (malo) return falla(err, malo.validity.valueMissing ? `${pre}indica ${etiquetaDe(malo).toLowerCase()}.` : `${pre}${etiquetaDe(malo)}: ${malo.validationMessage}`, malo);
        const v = leerFila(fs);
        for (const [precio, cant, etq] of [['precio_mayor', 'cantidad_mayor', 'mayor'], ['precio_gran_mayor', 'cantidad_gran_mayor', 'gran mayor']]) {
            if (!(v[precio] > 0)) delete v[precio];          // un 0 escrito equivale a «sin precio por volumen»
            if (!(v[cant] > 0)) delete v[cant];
            if ((precio in v) !== (cant in v)) return falla(err, `${pre}el precio ${etq} y su cantidad «desde» se indican juntos.`, inp(precio in v ? cant : precio));
        }
        if (v.cantidad_gran_mayor <= v.cantidad_mayor) return falla(err, `${pre}«gran mayor» debe empezar en una cantidad superior a la de «mayor».`, inp('cantidad_gran_mayor'));
        if (v.cantidad_minima > v.cantidad_maxima) return falla(err, `${pre}el mínimo no puede ser mayor que el máximo.`, inp('cantidad_minima'));
        if (v.maneja_lotes && v.cantidad_inicial > 0 && !(v.lote && v.vencimiento)) return falla(err, `${pre}indica lote y vencimiento del stock inicial.`, inp(v.lote ? 'vencimiento' : 'lote'));
        const clave = `${(v.color || '').toLowerCase()}|${(v.talla_presentacion || '').toLowerCase()}`;
        if (colores.has(clave)) return falla(err, `${pre}repite el color y la talla de otra variante.`, inp('color'));
        colores.add(clave);
        if (v.codigo_barras) {
            if (barras.has(v.codigo_barras)) return falla(err, `${pre}el código de barras está repetido en otra variante.`, inp('codigo_barras'));
            barras.add(v.codigo_barras);
        }
        variantes.push(v);
    }
    await enviar(e.target, err, { accion: 'crear', producto: { nombre: f.nombre.value.trim(), marca: f.marca.value.trim(), seccion_id: Number(f.seccion_id.value) }, variantes });
}

//--- LLEGADA ---//
function filaLinea() {
    const n = ++uid;
    const fs = el('fieldset', { className: 'vrow' }, el('legend'));
    const dl = el('datalist', { id: `dl${n}` });                 // una lista de sugerencias por línea: ya no se pisan entre sí
    const prod = campo(`l${n}p`, 'Producto o código de barras', { type: 'text', autocomplete: 'off', placeholder: 'Escribe o escanea' });
    prod.classList.add('ancho');
    const hint = el('div', { className: 'hint ancho', hidden: true });
    const cant = campo(`l${n}c`, 'Cantidad', { type: 'number', min: 1, max: 100000, step: '1', inputMode: 'numeric' });
    const costo = campo(`l${n}k`, 'Costo unitario (USD)', { type: 'number', min: 0.01, max: MAX_NUM, step: '0.01', inputMode: 'decimal' });
    const lote = campo(`l${n}l`, 'Lote', { type: 'text', maxLength: 40 });
    const venc = campo(`l${n}v`, 'Vencimiento', { type: 'date' });
    lote.hidden = venc.hidden = true;
    const i = { p: $('input', prod), c: $('input', cant), k: $('input', costo), l: $('input', lote), v: $('input', venc) };
    for (const [k, x] of Object.entries(i)) x.setAttribute('data-k', k);
    i.p.setAttribute('list', dl.id);
    i.l.disabled = i.v.disabled = true;

    let timer, seq = 0, auto = '';
    const aplicar = (item) => {
        const lotes = !!item?.maneja_lotes;
        i.l.disabled = i.v.disabled = lote.hidden = venc.hidden = !lotes;
        if (!lotes) i.l.value = i.v.value = '';
        const ult = Number(item?.precio_costo);
        hint.hidden = !item;
        hint.textContent = item ? [`Stock actual: ${item.cantidad}`, ult > 0 && `Último costo: ${usd(ult)}`, lotes && 'Maneja lotes y vencimiento'].filter(Boolean).join(' · ') : '';
        // autocompleta el costo, pero sin pisar uno que la persona escribió a mano
        if (item && ult > 0 && (!i.k.value || i.k.value === auto)) { auto = String(item.precio_costo); i.k.value = auto; }
        totalizar();
    };
    const buscar = async () => {
        const q = i.p.value.trim();
        if (q.length < 2) return null;
        const mi = ++seq;
        try {
            const { data } = await consulta('lista', { q });
            if (mi !== seq) return null;
            data.forEach((p) => state.cache.set(etiqueta(p), p));
            dl.replaceChildren(...data.map((p) => el('option', { value: etiqueta(p) })));
            return data;
        } catch { return null; }
    };
    i.p.addEventListener('input', () => {
        clearTimeout(timer);
        const item = state.cache.get(i.p.value);
        aplicar(item || null);
        if (!item) timer = setTimeout(buscar, 300);
    });
    // El lector de códigos de barras termina con Enter: sin esto enviaba el formulario a medio llenar.
    i.p.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        clearTimeout(timer);
        let item = state.cache.get(i.p.value);
        if (!item) {
            const r = await buscar();
            if (r?.length === 1) { i.p.value = etiqueta(r[0]); item = r[0]; }
        }
        if (item) { aplicar(item); i.c.focus(); }
        else aviso('No se encontró un único producto con ese texto o código.', true);
    });
    fs.append(el('div', { className: 'grupo-campos' }, prod, hint, cant, costo, lote, venc), dl, botonQuitar(fs, '#lineas', 'Producto', totalizar));
    return fs;
}

function totalizar() {
    let uds = 0, total = 0;
    for (const fs of $('#lineas').children) {
        const c = Number($('[data-k="c"]', fs).value), k = Number($('[data-k="k"]', fs).value);
        if (c > 0) { uds += c; if (k > 0) total += c * k; }
    }
    $('#totalLlegada').textContent = `${plural(uds, 'unidad', 'unidades')} · Total: ${usd(round2(total))}`;
}

/** Devuelve el id del proveedor, creándolo solo si no existe (antes un reintento tras un fallo lo volvía a crear y chocaba). */
async function asegurarProveedor(nombre) {
    const buscar = () => [...$('#lProv').options].find((o) => o.value && o.textContent.trim().toLowerCase() === nombre.toLowerCase());
    let op = buscar();
    if (!op) { await api(API, { accion: 'proveedor', nombre }); await cargarProveedores(); op = buscar(); }
    if (!op) return '';
    $('#lProv').value = op.value; $('#lProv').disabled = false; $('#lNuevoProv').value = '';
    return op.value;
}

async function guardarLlegada(e) {
    e.preventDefault();
    const err = $('#errLleg'); mostrarError(err, '');
    const lineas = [];
    for (const [i, fs] of [...$('#lineas').children].entries()) {
        const pre = `Línea ${i + 1}: `, inp = (k) => $(`[data-k="${k}"]`, fs);
        const v = leerFila(fs), item = state.cache.get(v.p || '');
        if (!item) return falla(err, `${pre}elige un producto de la lista.`, inp('p'));
        if (!Number.isInteger(v.c) || v.c < 1) return falla(err, `${pre}la cantidad debe ser un entero mayor que cero.`, inp('c'));
        if (!(v.k > 0)) return falla(err, `${pre}indica el costo unitario.`, inp('k'));
        if (item.maneja_lotes && !(v.l && v.v)) return falla(err, `${pre}indica lote y vencimiento.`, inp(v.l ? 'v' : 'l'));
        lineas.push({ variante_id: item.id, cantidad: v.c, costo: v.k, lote: v.l, vencimiento: v.v });
    }
    await enviar(e.target, err, async () => {
        const nuevo = $('#lNuevoProv').value.trim();
        const prov = nuevo ? await asegurarProveedor(nuevo) : $('#lProv').value;
        return { accion: 'llegada', proveedor_id: prov ? Number(prov) : null, numero_factura: $('#lFact').value.trim(), lineas };
    });
}

//--- SALIDA / AJUSTE ---//
let movActual = null;
const restaStock = () => movActual.tipo === 'salida' || $('#mSentido').value === 'salida';
function previewMov() {
    if (!movActual) return;
    const cant = Number($('#mCant').value), stock = Number(movActual.p.cantidad), out = $('#movPreview');
    const valida = Number.isInteger(cant) && cant >= 1;
    const nuevo = stock + (restaStock() ? -cant : cant);
    out.textContent = !valida ? '' : nuevo < 0 ? `Solo hay ${stock} en stock: no se pueden restar ${cant}.` : `Stock después del movimiento: ${nuevo}`;
    out.classList.toggle('mal', valida && nuevo < 0);
}
function abrirMov(p, tipo) {
    movActual = { p, tipo };
    const ajuste = tipo === 'ajuste';
    $('#hMov').textContent = ajuste ? 'Ajustar stock' : 'Registrar salida';
    $('#btnMov').textContent = ajuste ? 'Registrar ajuste' : 'Registrar salida';
    $('#movProducto').textContent = `${nombreVar(p)} — stock actual: ${p.cantidad}`;
    $('#filaSentido').hidden = !ajuste;
    $('#mMotivo').replaceChildren(...MOTIVOS[tipo].map((m) => el('option', { value: m, textContent: m })));
    $('#formMov').reset(); mostrarError($('#errMov'), '');
    previewMov();
    $('#dlgMov').showModal();
}

async function guardarMov(e) {
    e.preventDefault();
    const err = $('#errMov'); mostrarError(err, '');
    const cant = Number($('#mCant').value), detalle = $('#mDetalle').value.trim(), motivo = $('#mMotivo').value;
    if (!Number.isInteger(cant) || cant < 1) return falla(err, 'La cantidad debe ser un entero mayor que cero.', $('#mCant'));
    if (motivo === 'Otro' && detalle.length < 3) return falla(err, 'Describe el motivo en el detalle.', $('#mDetalle'));
    await enviar(e.target, err, {
        accion: movActual.tipo, variante_id: movActual.p.id, cantidad: cant,
        motivo: motivo === 'Otro' ? detalle : detalle ? `${motivo} - ${detalle}` : motivo,
        ...(movActual.tipo === 'ajuste' ? { sentido: $('#mSentido').value } : {}),
    });
}

//--- ENVÍO COMÚN ---//
/** `cuerpo` puede ser un objeto o una función (async) que lo calcula; así el botón ya está bloqueado mientras se prepara. */
async function enviar(form, err, cuerpo) {
    const btn = $('[type="submit"]', form), txt = btn.textContent;
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
        const d = await api(API, typeof cuerpo === 'function' ? await cuerpo() : cuerpo);
        form.closest('dialog').close();
        aviso(d.message || 'Listo.');
        await Promise.all([cargarLista(), $('#panKardex').hidden ? null : cargarKardex()]);
    } catch (x) { mostrarError(err, x.message); }
    finally { btn.disabled = false; btn.textContent = txt; }
}

//--- ARRANQUE ---//
async function cargarProveedores() {
    const { data } = await consulta('proveedores');
    $('#lProv').replaceChildren(el('option', { value: '', textContent: 'Sin proveedor' }), ...data.map((p) => el('option', { value: p.id, textContent: p.nombre })));
}

async function init() {
    if (window.Auth && !(await window.Auth.listo)) return;
    state.admin = !!window.Auth?.tieneNivel('admin');
    try {
        const { data: secciones } = await consulta('secciones');
        for (const s of secciones) for (const id of ['#fSeccion', '#pSec', '#kSeccion']) $(id).append(el('option', { value: s.id, textContent: s.nombre }));
        if (state.admin) await cargarProveedores();
    } catch (e) { aviso(e.message, true); }
    $('#kTipo').append(...Object.entries(TIPOS).map(([v, [t]]) => el('option', { value: v, textContent: t })));

    let t;
    $('#fBuscar').addEventListener('input', () => { clearTimeout(t); t = setTimeout(cargarLista, 300); });
    $('#fSeccion').addEventListener('change', cargarLista);
    for (const b of $$('.filtro')) b.addEventListener('click', () => { fijarAlerta(b.dataset.alerta); cargarLista(); });
    $('#fLimpiar').addEventListener('click', limpiarFiltros);
    for (const id of ['#kSeccion', '#kTipo', '#kDesde', '#kHasta']) $(id).addEventListener('change', cargarKardex);
    $('#kDesde').addEventListener('change', () => { $('#kHasta').min = $('#kDesde').value; });
    $('#kHasta').addEventListener('change', () => { $('#kDesde').max = $('#kHasta').value; });
    $('#kQuitar').addEventListener('click', () => { state.kVar = null; $('#kQuitar').hidden = true; cargarKardex(); });
    $('#tabExist').addEventListener('click', () => cambiarTab('exist'));
    $('#tabKardex').addEventListener('click', () => cambiarTab('kardex'));
    $('.tabs').addEventListener('keydown', (e) => {
        const enKardex = $('#tabKardex').getAttribute('aria-selected') === 'true';
        const sig = { ArrowLeft: !enKardex, ArrowRight: !enKardex, Home: false, End: true }[e.key];
        if (sig === undefined) return;
        e.preventDefault(); cambiarTab(sig ? 'kardex' : 'exist', true);
    });
    $('#aviso').addEventListener('click', () => ($('#aviso').hidden = true));
    document.addEventListener('click', (e) => { if (e.target.closest('[data-cerrar]')) e.target.closest('dialog').close(); });
    document.addEventListener('input', (e) => { if (e.target.closest?.('dialog')) e.target.removeAttribute('aria-invalid'); });
    // Cerrar el diálogo pequeño al pulsar fuera (no hay nada que perder). Exige que el clic también empiece fuera,
    // para no cerrarlo al soltar el ratón tras seleccionar texto dentro de un campo.
    const dlgMov = $('#dlgMov'); let pulsoFuera = false;
    dlgMov.addEventListener('mousedown', (e) => { pulsoFuera = e.target === dlgMov; });
    dlgMov.addEventListener('click', (e) => { if (pulsoFuera && e.target === dlgMov) dlgMov.close(); });

    $('#btnNuevo')?.addEventListener('click', () => {
        $('#formProducto').reset(); mostrarError($('#errProd'), '');
        $('#variantes').replaceChildren();
        agregarFila('#variantes', filaVariante, 'Variante');
        $('#dlgProducto').showModal();
    });
    $('#btnOtraVar')?.addEventListener('click', () => { const fs = agregarFila('#variantes', filaVariante, 'Variante'); $('input', fs).focus(); });
    $('#formProducto').addEventListener('submit', guardarProducto);

    $('#btnLlegada')?.addEventListener('click', () => {
        $('#formLlegada').reset(); mostrarError($('#errLleg'), '');
        $('#lProv').disabled = false;
        $('#lineas').replaceChildren();
        agregarFila('#lineas', filaLinea, 'Producto');
        totalizar();
        $('#dlgLlegada').showModal();
    });
    $('#btnOtraLinea')?.addEventListener('click', () => { const fs = agregarFila('#lineas', filaLinea, 'Producto'); $('input', fs).focus(); totalizar(); });
    $('#lineas').addEventListener('input', totalizar);
    $('#lNuevoProv').addEventListener('input', (e) => { $('#lProv').disabled = !!e.target.value.trim(); });   // el proveedor nuevo manda: evita elegir dos a la vez
    $('#formLlegada').addEventListener('submit', guardarLlegada);

    $('#mCant').addEventListener('input', previewMov);
    $('#mSentido').addEventListener('change', previewMov);
    $('#formMov').addEventListener('submit', guardarMov);

    await cargarLista();
}

init();
