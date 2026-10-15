import { usd, round2, hoyISO, sumarDias, soloHora } from './utils/format.js';
import { conAutorizacion } from './autorizacion.js';

const API = '/api/inventario';
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
function el(tag, props = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) (k in n && k !== 'list' ? (n[k] = v) : n.setAttribute(k, v));
    n.append(...hijos.flat().filter((h) => h != null && h !== false));
    return n;
}
const icono = (c) => el('i', { className: c, 'aria-hidden': 'true' });

const TIPOS = {
    REGISTRO: ['Registro', 1, 'fa-box-open'], LLEGADA: ['Llegada', 1, 'fa-truck-ramp-box'],
    SALIDA_VENTA: ['Venta', -1, 'fa-receipt'], SALIDA_OTRO: ['Salida por otro motivo', -1, 'fa-arrow-right-from-bracket'],
    AJUSTE_ENTRADA: ['Ajuste de entrada', 1, 'fa-sliders'], AJUSTE_SALIDA: ['Ajuste de salida', -1, 'fa-sliders'],
    DEVOLUCION_CLIENTE: ['Devolución de cliente', 1, 'fa-rotate-left'], DEVOLUCION_PROVEEDOR: ['Devolución a proveedor', -1, 'fa-rotate-left'],
};
const MOTIVOS = {
    salida: ['Daño', 'Vencimiento', 'Obsequio', 'Muestra', 'Pérdida', 'Uso interno', 'Otro'],
    ajuste: ['Conteo físico', 'Error de registro', 'Otro'],
};
// Campos que se escriben una vez (bloque «Precios» y «Control de stock») y cada variante hereda;
// cada variante puede cambiarlos en «Precios o stock distintos». [clave, etiqueta, tipo]
const PROPIOS = [
    ['precio_costo', 'Costo', 'dec'], ['precio_detal', 'Precio detal', 'dec'],
    ['precio_mayor', 'Precio mayor', 'dec'], ['cantidad_mayor', 'Mayor desde', 'int'],
    ['precio_gran_mayor', 'Precio gran mayor', 'dec'], ['cantidad_gran_mayor', 'Gran mayor desde', 'int'],
    ['cantidad_minima', 'Mínimo', 'int'], ['cantidad_maxima', 'Máximo', 'int'],
];
const MAX_NUM = 1_000_000;

const state = { items: [], admin: false, kVar: null, alerta: '', seqLista: 0, seqK: 0, truncado: false, proveedores: [] };
let uid = 0, avisoT;

const chipsDe = (p) => [p.color && el('span', { className: 'vchip color', textContent: p.color }), p.talla && el('span', { className: 'vchip talla', textContent: p.talla })].filter(Boolean);
const nombreVar = (p) => [p.nombre, p.color, p.talla].filter(Boolean).join(' - ');
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const norm = (s) => String(s || '').trim().toLowerCase();
const TZ = 'America/Caracas';
const diaClave = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
function diaTitulo(iso) {
    const clave = diaClave(iso), hoy = hoyISO();
    if (clave === hoy) return 'Hoy';
    if (clave === sumarDias(hoy, -1)) return 'Ayer';
    const t = new Date(iso).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
    return t.charAt(0).toUpperCase() + t.slice(1);
}

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
    if (r.status === 403 && (await fetch('/api/sesion', { credentials: 'same-origin', cache: 'no-store' })
        .then((x) => (x.ok ? x.json() : null)).then((s) => !!s?.debe_cambiar_clave).catch(() => false))) {
        location.replace('/cambiar-clave.html'); // clave temporal: el servidor bloquea todo hasta cambiarla
        throw new Error('Debes cambiar tu contraseña antes de continuar.');
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
function cargando(lista, on) {
    const w = $(lista);
    w.setAttribute('aria-busy', String(on)); w.classList.toggle('cargando', on);
}
function nota(id, truncado, n) {
    const p = $(id); p.hidden = !truncado;
    if (truncado) p.textContent = `Se muestran los primeros ${n} resultados. Afina la búsqueda o los filtros para ver el resto.`;
}
/** Sustituye los <tbody> de una tabla (el <thead> se conserva). */
function ponerCuerpos(tabla, cuerpos) {
    $$('tbody', tabla).forEach((b) => b.remove());
    tabla.append(...cuerpos);
}
function esqueleto(tabla, columnas) {
    const tb = el('tbody', { className: 'esq', 'aria-hidden': 'true' });
    for (let i = 0; i < 5; i++) tb.append(el('tr', {}, el('td', { colSpan: columnas }, el('span'))));
    ponerCuerpos(tabla, [tb]);
}
const metrica = (valor, texto, clase = '') => el('span', { className: `m ${clase}` }, el('b', { textContent: String(valor) }), ` ${texto}`);

//--- EXISTENCIAS ---//
const filtrosActivos = () => !!($('#fBuscar').value.trim() || $('#fSeccion').value || state.alerta);

async function cargarLista() {
    const n = ++state.seqLista;                  // si llega una respuesta más vieja que la última pedida, se descarta
    cargando('#listaInv', true);
    if (!state.items.length) esqueleto($('#tablaInv'), state.admin ? 8 : 7);
    try {
        const d = await consulta('lista', { q: $('#fBuscar').value.trim(), seccion: $('#fSeccion').value, alerta: state.alerta });
        if (n !== state.seqLista) return;
        state.items = d.data; state.truncado = !!d.truncado;
        pintarLista();
    } catch (e) {
        if (n === state.seqLista) { aviso(e.message, true); if (!state.items.length) ponerCuerpos($('#tablaInv'), []); }
    } finally { if (n === state.seqLista) cargando('#listaInv', false); }
}

function celda(etq, props, ...hijos) {
    const td = el('td', props, ...hijos);
    td.setAttribute('data-label', etq);
    return td;
}
function nivel(p) {
    if (Number(p.cantidad) <= 0) return ['agotado', 'Agotado'];
    if (p.alerta === 'bajo') return ['bajo', 'Stock bajo'];
    if (p.alerta === 'alto') return ['alto', 'Stock alto'];
    return ['', ''];
}
/** Barra de nivel: solo si el producto tiene máximo (compara contra él). */
function medidor(p, clase = '') {
    const max = Number(p.cantidad_maxima) || 0;
    if (max <= 0) return null;
    const pct = Math.max(0, Math.min(100, (Number(p.cantidad) / max) * 100));
    const m = el('div', { className: `medidor ${clase || nivel(p)[0]}`, 'aria-hidden': 'true' }, el('i'));
    m.firstChild.style.setProperty('--w', `${pct}%`);
    return m;
}
function celdaStock(p) {
    const [clase, texto] = nivel(p);
    const cont = el('div', { className: 'stock-cel' }, el('span', { className: 'stock-num', textContent: String(p.cantidad) }), medidor(p, clase));
    if (texto) cont.append(el('span', { className: `est ${clase}`, textContent: texto }));
    return celda('Stock', { className: 'n c-stock' }, cont);
}
const celdaDinero = (etq, valor, cls = '') => celda(etq, { className: `n precio ${cls}` }, el('span', { className: 'monto', textContent: usd(Number(valor)) }));
function celdaEscalon(etq, precio, desde) {
    if (!(Number(precio) > 0 && Number(desde) > 0)) return celda(etq, { className: 'n precio' }, el('span', { className: 'vacio-celda', textContent: '—' }));
    return celda(etq, { className: 'n precio' }, el('span', { className: 'monto', textContent: usd(Number(precio)) }), el('span', { className: 'sub', textContent: `desde ${desde} unid.` }));
}
function botonVer(p) {
    return el('button', { type: 'button', className: 'btn-ver', title: `Ver ficha de ${nombreVar(p)}`, 'aria-label': `Ver ficha de ${nombreVar(p)}` },
        icono('fas fa-chevron-right'), el('span', { className: 'ver-txt', textContent: 'Ver ficha' }));
}

function agrupar(items) {
    const m = new Map();
    for (const p of items) {
        const k = p.producto_id ?? `v${p.id}`;
        if (!m.has(k)) m.set(k, { nombre: p.nombre, marca: p.marca, seccion: p.seccion, vars: [] });
        m.get(k).vars.push(p);
    }
    for (const g of m.values()) g.vars.sort((a, b) => norm(a.color).localeCompare(norm(b.color), 'es') || a.id - b.id);
    return [...m.values()];
}

function filaVariante(p, simple) {
    const [clase] = nivel(p);
    const meta = [p.marca, p.seccion].filter(Boolean).join(' · ');
    const prod = simple
        ? celda('Producto', { className: 'c-prod' }, el('div', { className: 'prod-nombre', textContent: p.nombre }), meta && el('div', { className: 'muted', textContent: meta }))
        : celda('Variante', { className: 'c-prod' }, chipsDe(p).length ? el('div', { className: 'chips' }, ...chipsDe(p)) : el('span', { className: 'sin-var', textContent: 'Sin color ni talla' }));
    const tr = el('tr', { className: `${simple ? 'simple' : 'var'} ${clase}`.trim() }, prod, celda('Código', { className: 'c-cod', textContent: p.codigo_barras }), celdaStock(p));
    if (state.admin) tr.append(celdaDinero('Costo', p.precio_costo || 0));
    tr.append(celdaDinero('Detal', p.precio_detal), celdaEscalon('Mayor', p.precio_mayor, p.cantidad_mayor), celdaEscalon('Gran mayor', p.precio_gran_mayor, p.cantidad_gran_mayor));
    const ir = botonVer(p);
    tr.append(celda('Ficha', { className: 'c-go' }, ir));
    const abrir = () => abrirFicha(p);
    tr.addEventListener('click', (e) => { if (!e.target.closest('button')) abrir(); });
    ir.addEventListener('click', abrir);
    return tr;
}

function pintarLista() {
    const cols = state.admin ? 8 : 7;
    const cuerpos = agrupar(state.items).map((g) => {
        const simple = g.vars.length === 1 && !g.vars[0].color && !g.vars[0].talla;
        const tb = el('tbody', { className: 'prod-grupo' });
        if (!simple) {
            const total = g.vars.reduce((s, v) => s + Number(v.cantidad), 0);
            const meta = [g.marca, g.seccion].filter(Boolean).join(' · ');
            tb.append(el('tr', { className: 'grupo-cab' }, el('th', { scope: 'rowgroup', colSpan: cols },
                el('div', { className: 'cab-fila' }, el('span', { className: 'cab-nombre', textContent: g.nombre }), meta && el('span', { className: 'cab-meta', textContent: meta }),
                    el('span', { className: 'cab-total', textContent: `${plural(total, 'unidad', 'unidades')} · ${plural(g.vars.length, 'variante', 'variantes')}` })))));
        }
        for (const v of g.vars) tb.append(filaVariante(v, simple));
        return tb;
    });
    ponerCuerpos($('#tablaInv'), cuerpos);

    const filtrado = filtrosActivos();
    const vacio = state.items.length === 0;
    $('#vacioInv').hidden = !vacio;
    $('#fLimpiar').hidden = !filtrado;
    $('#tablaInv').hidden = vacio;
    const acts = $('#vacioActs'); acts.replaceChildren();
    if (vacio) {
        $('#vacioTxt').textContent = filtrado ? 'No hay productos con estos filtros.'
            : state.admin ? 'Aún no hay productos. Crea el primero o registra una entrada de mercancía.' : 'Aún no hay productos registrados.';
        if (filtrado) acts.append(el('button', { type: 'button', className: 'btn btn-ghost', textContent: 'Quitar filtros', onclick: limpiarFiltros }));
        else if (state.admin) acts.append(el('button', { type: 'button', className: 'btn btn-primary', onclick: () => abrirProducto() }, icono('fas fa-plus'), ' Nuevo producto'));
    }
    nota('#notaInv', state.truncado, state.items.length);

    const it = state.items;
    const agotados = it.filter((p) => Number(p.cantidad) <= 0).length;
    const bajos = it.filter((p) => Number(p.cantidad) > 0 && p.alerta === 'bajo').length;
    const m = $('#resumenInv'); m.replaceChildren();
    if (!vacio) {
        m.append(metrica(state.truncado ? `${it.length}+` : it.length, it.length === 1 && !state.truncado ? 'variante' : 'variantes'));
        if (!state.truncado) {
            m.append(metrica(it.reduce((s, p) => s + Number(p.cantidad), 0), 'unidades'));
            if (state.admin) {
                m.append(metrica(usd(round2(it.reduce((s, p) => s + Number(p.cantidad) * Number(p.precio_costo || 0), 0))), 'a costo'),
                    metrica(usd(round2(it.reduce((s, p) => s + Number(p.cantidad) * Number(p.precio_detal || 0), 0))), 'a precio detal'));
            }
        }
        if (agotados) m.append(metrica(agotados, agotados === 1 ? 'agotado' : 'agotados', 'm-alerta'));
        if (bajos) m.append(metrica(bajos, 'en stock bajo', 'm-bajo'));
    }
}

function fijarAlerta(v) {
    state.alerta = v;
    for (const b of $$('.filtro[data-alerta]')) b.setAttribute('aria-pressed', String(b.dataset.alerta === v));
}
function limpiarFiltros() {
    $('#fBuscar').value = ''; $('#fSeccion').value = ''; fijarAlerta('');
    cargarLista();
}

//--- FICHA DE VARIANTE ---//
function abrirFicha(p) {
    const [clase, texto] = nivel(p);
    const min = Number(p.cantidad_minima) || 0, max = Number(p.cantidad_maxima) || 0;
    const meta = [p.marca, p.seccion].filter(Boolean).join(' · ');
    const costo = Number(p.precio_costo) || 0, detal = Number(p.precio_detal) || 0;
    const dd = (...h) => el('dd', {}, ...h);
    const precio = (nombre, valor, extra, nulo = false) => el('div', { className: nulo ? 'nulo' : '' }, el('dt', { textContent: nombre }), dd(nulo ? '—' : usd(Number(valor)), extra && el('small', { textContent: extra })));
    const precios = [];
    if (state.admin) precios.push(precio('Costo', costo, null, !p.precio_costo));
    precios.push(precio('Precio detal', detal, state.admin && costo > 0 && detal > 0 ? `Ganancia ${usd(round2(detal - costo))} (${Math.round(((detal - costo) / detal) * 100)} %)` : null));
    const tiene = (pr, c) => Number(pr) > 0 && Number(c) > 0;
    precios.push(tiene(p.precio_mayor, p.cantidad_mayor) ? precio('Precio mayor', p.precio_mayor, `desde ${p.cantidad_mayor} unid.`) : precio('Precio mayor', 0, null, true));
    precios.push(tiene(p.precio_gran_mayor, p.cantidad_gran_mayor) ? precio('Precio gran mayor', p.precio_gran_mayor, `desde ${p.cantidad_gran_mayor} unid.`) : precio('Precio gran mayor', 0, null, true));

    const limites = [min > 0 && `Mínimo ${min}`, max > 0 && `Máximo ${max}`].filter(Boolean).join(' · ');
    const acts = [];
    if (state.admin) acts.push(el('button', { type: 'button', className: 'btn btn-primary', onclick: () => { $('#dlgFicha').close(); abrirEntrada([p]); } }, icono('fas fa-truck-ramp-box'), ' Dar entrada'));
    acts.push(
        el('button', { type: 'button', className: 'btn btn-ghost', onclick: () => { $('#dlgFicha').close(); abrirMov(p, 'salida'); } }, icono('fas fa-arrow-right-from-bracket'), ' Registrar salida'),
        el('button', { type: 'button', className: 'btn btn-ghost', onclick: () => { $('#dlgFicha').close(); abrirMov(p, 'ajuste'); } }, icono('fas fa-sliders'), ' Ajustar stock'),
        el('button', { type: 'button', className: 'btn btn-ghost', onclick: () => { $('#dlgFicha').close(); verKardex(p); } }, icono('fas fa-clock-rotate-left'), ' Ver kardex'));

    $('#fichaCuerpo').replaceChildren(
        el('header', { className: 'inv-cab' },
            el('div', { className: 'ficha-cab-t' }, meta && el('p', { className: 'muted', textContent: meta }), el('h2', { id: 'hFicha', textContent: p.nombre }), chipsDe(p).length ? el('div', { className: 'chips' }, ...chipsDe(p)) : null),
            el('button', { type: 'button', className: 'inv-x', 'aria-label': 'Cerrar', onclick: () => $('#dlgFicha').close() }, icono('fas fa-xmark'))),
        el('div', { className: 'inv-cuerpo' },
            el('section', { className: 'ficha-stock' },
                el('div', { className: 'stock-grande' }, el('strong', { textContent: String(p.cantidad) }), el('span', { className: 'muted', textContent: Number(p.cantidad) === 1 ? 'unidad en stock' : 'unidades en stock' }), texto && el('span', { className: `est ${clase}`, textContent: texto })),
                medidor(p, clase), limites && el('p', { className: 'muted', textContent: limites })),
            el('section', { className: 'seccion' }, el('h3', { textContent: 'Precios en USD' }), el('dl', { className: 'dl-grid' }, ...precios)),
            el('section', { className: 'seccion' }, el('h3', { textContent: 'Datos' }), el('dl', { className: 'dl-datos' },
                el('dt', { textContent: 'Código de barras' }), el('dd', { textContent: p.codigo_barras }),
                el('dt', { textContent: 'Sección' }), el('dd', { textContent: p.seccion || '—' }),
                el('dt', { textContent: 'Lotes y vencimiento' }), el('dd', { textContent: p.maneja_lotes ? 'Sí' : 'No' })))),
        el('footer', { className: 'inv-pie' }, el('div', { className: 'ficha-acts' }, ...acts)));
    cerrarAlPulsarFuera($('#dlgFicha'));
    $('#dlgFicha').showModal();
}

//--- KARDEX ---//
const kFiltrosCambiaron = () => { marcarPreset(); cargarKardex(); };
function aplicarPreset(p) {
    const hoy = hoyISO();
    const rango = { hoy: [hoy, hoy], '7d': [sumarDias(hoy, -6), hoy], mes: [`${hoy.slice(0, 8)}01`, hoy], todo: ['', ''] }[p];
    $('#kDesde').value = rango[0]; $('#kHasta').value = rango[1];
    $('#kHasta').min = rango[0]; $('#kDesde').max = rango[1];
    marcarPreset(); cargarKardex();
}
function marcarPreset() {
    const hoy = hoyISO(), d = $('#kDesde').value, h = $('#kHasta').value;
    const actual = !d && !h ? 'todo' : d === hoy && h === hoy ? 'hoy' : d === sumarDias(hoy, -6) && h === hoy ? '7d' : d === `${hoy.slice(0, 8)}01` && h === hoy ? 'mes' : '';
    for (const b of $$('.filtro[data-preset]')) b.setAttribute('aria-pressed', String(b.dataset.preset === actual));
}

function filaMov(m) {
    const [nombre, signo, ic] = TIPOS[m.tipo] || [m.tipo, 0, 'fa-circle'];
    const dir = signo > 0 ? 'entra' : 'sale';
    const prod = celda('Producto', { className: 'c-prod' }, el('div', { className: 'prod-nombre', textContent: m.producto }),
        (m.color || m.talla) && el('div', { className: 'chips' }, ...chipsDe({ color: m.color, talla: m.talla })), m.lote && el('div', { className: 'muted', textContent: `Lote ${m.lote}` }));
    const tr = el('tr', { className: 'mov' },
        celda('Hora', { className: 'hora', textContent: soloHora(m.creado_en) }), prod,
        celda('Movimiento', { className: 'c-mov' }, el('span', { className: `mov-tag ${dir}` }, icono(`fas ${ic}`), nombre)),
        celda('Cantidad', { className: `n c-cant` }, el('span', { className: `cant-k ${dir}`, textContent: `${signo > 0 ? '+' : '−'}${m.cantidad}` })),
        celda('Saldo', { className: 'n c-saldo' }, el('span', { className: 'monto', textContent: String(m.saldo_nuevo) }), el('span', { className: 'sub', textContent: `antes ${m.saldo_anterior}` })));
    if (state.admin) tr.append(celda('Costo', { className: 'n c-costo', textContent: m.costo_unitario == null ? '—' : usd(Number(m.costo_unitario)) }));
    tr.append(celda('Usuario', { className: 'c-user', textContent: m.usuario || '—' }),
        celda('Detalle', { className: 'detalle-k c-det', textContent: [m.motivo, m.referencia && `Ref. ${m.referencia}`].filter(Boolean).join(' - ') }));
    return tr;
}

async function cargarKardex() {
    const desde = $('#kDesde').value, hasta = $('#kHasta').value;
    if (desde && hasta && desde > hasta) return aviso('La fecha «Desde» no puede ser posterior a «Hasta».', true);
    const n = ++state.seqK;
    cargando('#listaK', true);
    try {
        const d = await consulta('kardex', { variante: state.kVar?.id, seccion: $('#kSeccion').value, tipo: $('#kTipo').value, desde, hasta });
        if (n !== state.seqK) return;
        const filas = d.data, cols = state.admin ? 8 : 7, cuerpos = [];
        let dia = '', tb = null, ent = 0, sal = 0;
        for (const m of filas) {
            const clave = diaClave(m.creado_en);
            if (clave !== dia) {
                dia = clave; tb = el('tbody', { className: 'dia' });
                tb.append(el('tr', { className: 'dia-cab' }, el('th', { scope: 'rowgroup', colSpan: cols, textContent: diaTitulo(m.creado_en) })));
                cuerpos.push(tb);
            }
            tb.append(filaMov(m));
            ((TIPOS[m.tipo]?.[1] || 0) > 0 ? (ent += Number(m.cantidad)) : (sal += Number(m.cantidad)));
        }
        ponerCuerpos($('#tablaK'), cuerpos);
        $('#tablaK').hidden = !filas.length;
        $('#vacioK').hidden = filas.length > 0;
        nota('#notaK', !!d.truncado, filas.length);
        const r = $('#resumenK'); r.replaceChildren();
        if (filas.length) {
            r.append(metrica(d.truncado ? `${filas.length}+` : filas.length, filas.length === 1 && !d.truncado ? 'movimiento' : 'movimientos'));
            if (!d.truncado) r.append(metrica(`+${ent}`, 'entradas', 'entra'), metrica(`−${sal}`, 'salidas', 'sale'));
        }
    } catch (e) { if (n === state.seqK) aviso(e.message, true); }
    finally { if (n === state.seqK) cargando('#listaK', false); }
}

function verKardex(p) {
    state.kVar = p;
    $('#kSeccion').value = '';                   // la variante ya acota el resultado; una sección distinta lo dejaría vacío
    $('#kVarTxt').textContent = nombreVar(p);
    $('#kFiltroVar').hidden = false;
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

//--- ENVÍO COMÚN ---//
/** `cuerpo` puede ser un objeto o una función (async) que lo calcula; así el botón ya está bloqueado mientras se prepara. */
async function enviar(form, err, cuerpo, despues) {
    const btn = $('[type="submit"]', form), txt = btn.textContent;
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
        const d = await api(API, typeof cuerpo === 'function' ? await cuerpo() : cuerpo);
        form.closest('dialog').close();
        aviso(d.message || 'Listo.');
        await Promise.all([cargarLista(), $('#panKardex').hidden ? null : cargarKardex()]);
        if (despues) await despues(d);
    } catch (x) { mostrarError(err, x.message); }
    finally { btn.disabled = false; btn.textContent = txt; }
}

//--- PRODUCTO NUEVO ---//
let prodCtx = {};
const base = (k) => $(`[data-base="${k}"]`);
/** El valor propio de la variante manda; si lo dejó vacío, vale el general. */
const propio = (fs, k) => $(`[data-k="${k}"]`, fs);
const valorDe = (fs, k) => propio(fs, k).value.trim() || base(k).value.trim();
const objetivo = (fs, k) => (propio(fs, k).value.trim() ? propio(fs, k) : base(k));

function sincronizarVariantes() {
    $$('#variantes .vfila').forEach((fs) => {
        for (const [k] of PROPIOS) propio(fs, k).placeholder = base(k).value.trim() || 'General';
    });
    const filas = $$('#variantes .vfila');
    $('#contVar').textContent = filas.length;
    filas.forEach((fs, i) => {
        $('.vfila-t', fs).textContent = filas.length > 1 ? `Variante ${i + 1}` : 'Variante única';
        $('.quitar', fs).hidden = filas.length === 1;
    });
}
function actualizarMargen() {
    const costo = Number(base('precio_costo').value), detal = Number(base('precio_detal').value), p = $('#margenProd');
    p.className = 'hint';
    if (costo > 0 && detal > 0) {
        const gan = round2(detal - costo);
        if (gan < 0) { p.classList.add('mal'); p.textContent = `El precio detal está ${usd(-gan)} por debajo del costo. Revisa los precios.`; }
        else { p.classList.add('ok'); p.textContent = `Ganancia por unidad en detal: ${usd(gan)} (${Math.round((gan / detal) * 100)} % del precio).`; }
    } else p.textContent = 'Mayor y gran mayor son opcionales: indica el precio y desde cuántas unidades aplica.';
}
function actualizarLotesFila(fs) {
    const verLote = $('#pLotes').checked && !prodCtx.desdeEntrada && Number($('[data-k="cantidad_inicial"]', fs).value) > 0;
    const cont = $('.vcampos.lote', fs);
    cont.hidden = !verLote;
    $$('input', cont).forEach((i) => (i.disabled = !verLote));
}
const actualizarLotes = () => $$('#variantes .vfila').forEach(actualizarLotesFila);

function filaVar(pre = {}) {
    const n = ++uid;
    const fs = el('div', { className: 'vfila' });
    const mk = (k, texto, props) => { const f = campo(`v${n}${k}`, texto, props); $('input', f).setAttribute('data-k', k); return f; };
    const cabecera = el('div', { className: 'vfila-cab' }, el('span', { className: 'vfila-t' }));
    const dup = el('button', { type: 'button', className: 'vbtn', title: 'Crear otra variante con el mismo color' }, icono('fas fa-clone'), 'Duplicar');
    const quitar = el('button', { type: 'button', className: 'vbtn peligro quitar' }, icono('fas fa-trash-can'), 'Quitar');
    cabecera.append(dup, quitar);
    const stockEtq = prodCtx.desdeEntrada ? 'Cantidad que llegó' : 'Stock inicial';
    const principales = el('div', { className: 'vcampos' },
        mk('color', 'Color', { type: 'text', maxLength: 40, autocomplete: 'off', value: pre.color || '' }),
        mk('talla_presentacion', 'Talla o presentación', { type: 'text', maxLength: 40, autocomplete: 'off', value: pre.talla || '' }),
        mk('codigo_barras', 'Código de barras', { type: 'text', maxLength: 32, autocomplete: 'off', placeholder: 'Se genera solo', value: pre.codigo || '' }),
        mk('cantidad_inicial', stockEtq, { type: 'number', min: 0, max: MAX_NUM, step: '1', inputMode: 'numeric', value: pre.cant || '' }));
    const lote = el('div', { className: 'vcampos lote', hidden: true },
        mk('lote', 'Lote del stock inicial', { type: 'text', maxLength: 40, disabled: true }),
        mk('vencimiento', 'Vencimiento', { type: 'date', disabled: true }));
    const propios = el('details', { className: 'propios' }, el('summary', {}, 'Precios o stock distintos para esta variante ', el('span', { className: 'n-propios', hidden: true })),
        el('div', { className: 'vcampos' }, ...PROPIOS.map(([k, t, tipo]) => mk(k, t, { type: 'number', min: 0, max: MAX_NUM, step: tipo === 'dec' ? '0.01' : '1', inputMode: tipo === 'dec' ? 'decimal' : 'numeric' }))));
    fs.append(cabecera, principales, lote, propios);

    quitar.addEventListener('click', () => { fs.remove(); sincronizarVariantes(); });
    dup.addEventListener('click', () => {
        const nueva = filaVar({ color: $('[data-k="color"]', fs).value });
        for (const [k] of PROPIOS) propio(nueva, k).value = propio(fs, k).value;
        fs.after(nueva); sincronizarVariantes(); actualizarLotes();
        $('[data-k="talla_presentacion"]', nueva).focus();
    });
    fs.addEventListener('input', () => {
        const usados = PROPIOS.filter(([k]) => propio(fs, k).value.trim()).length, b = $('.n-propios', fs);
        b.hidden = !usados; b.textContent = String(usados);
        actualizarLotesFila(fs);
    });
    return fs;
}
function agregarVariante(pre) {
    const fs = filaVar(pre);
    $('#variantes').append(fs);
    sincronizarVariantes(); actualizarLotesFila(fs);
    return fs;
}

function abrirProducto(ctx = {}) {
    prodCtx = ctx;
    const f = $('#formProducto');
    f.reset(); mostrarError($('#errProd'), '');
    $('#variantes').replaceChildren();
    $('#hProd').textContent = ctx.desdeEntrada ? 'Producto nuevo' : 'Nuevo producto';
    $('#subProd').textContent = ctx.desdeEntrada ? 'Al guardarlo se agrega a la entrada de mercancía que estás registrando.' : 'Escribe los datos una sola vez: todas las variantes los heredan.';
    $('#btnGuardarProd').textContent = ctx.desdeEntrada ? 'Crear y agregar a la entrada' : 'Guardar producto';
    if (ctx.nombre) $('#pNom').value = ctx.nombre;
    agregarVariante({ codigo: ctx.codigo });
    actualizarMargen();
    $('#dlgProducto').showModal();
    (ctx.nombre ? base('precio_costo') : $('#pNom')).focus();
}

const etiquetaDe = (inp) => (inp.labels?.[0]?.textContent || inp.name || 'campo').replace(/\s*\(.*\)\s*/g, '').replace(/\s*\*$/, '').trim();

async function guardarProducto(e) {
    e.preventDefault();
    const err = $('#errProd'); mostrarError(err, '');
    const f = e.target.elements;
    if (!f.nombre.value.trim()) return falla(err, 'Escribe el nombre del producto.', f.nombre);
    if (!f.seccion_id.value) return falla(err, 'Elige la sección.', f.seccion_id);
    const maloBase = $$('[data-base]').find((x) => !x.checkValidity());
    if (maloBase) return falla(err, maloBase.validity.valueMissing ? `Indica ${etiquetaDe(maloBase).toLowerCase()}.` : `${etiquetaDe(maloBase)}: ${maloBase.validationMessage}`, maloBase);

    const variantes = [], claves = new Set(), barras = new Set(), llegadas = [];
    const filas = $$('#variantes .vfila');
    for (const [i, fs] of filas.entries()) {
        const pre = filas.length > 1 ? `Variante ${i + 1}: ` : '', obj = (k) => objetivo(fs, k), inp = (k) => $(`[data-k="${k}"]`, fs);
        const malo = $$('input', fs).find((x) => !x.disabled && !x.checkValidity());
        if (malo) return falla(err, `${pre}${etiquetaDe(malo)}: ${malo.validationMessage}`, malo);
        const v = {};
        for (const k of ['color', 'talla_presentacion', 'codigo_barras']) if (inp(k).value.trim()) v[k] = inp(k).value.trim();
        for (const [k, , tipo] of PROPIOS) {
            const val = valorDe(fs, k);
            if (val === '') continue;
            v[k] = Number(val);
            if (tipo === 'int' && !Number.isInteger(v[k])) return falla(err, `${pre}${k.includes('cantidad') ? 'las cantidades' : 'el valor'} deben ser enteros.`, obj(k));
        }
        if (!(v.precio_detal >= 0.01)) return falla(err, `${pre}el precio detal debe ser mayor que cero.`, obj('precio_detal'));
        for (const [precio, cant, etq] of [['precio_mayor', 'cantidad_mayor', 'mayor'], ['precio_gran_mayor', 'cantidad_gran_mayor', 'gran mayor']]) {
            if (!(v[precio] > 0)) delete v[precio];          // un 0 escrito equivale a «sin precio por volumen»
            if (!(v[cant] > 0)) delete v[cant];
            if ((precio in v) !== (cant in v)) return falla(err, `${pre}el precio ${etq} y su cantidad «desde» se indican juntos.`, obj(precio in v ? cant : precio));
        }
        if (v.cantidad_gran_mayor <= v.cantidad_mayor) return falla(err, `${pre}«gran mayor» debe empezar en una cantidad superior a la de «mayor».`, obj('cantidad_gran_mayor'));
        if (v.cantidad_minima > v.cantidad_maxima) return falla(err, `${pre}el mínimo no puede ser mayor que el máximo.`, obj('cantidad_minima'));
        const cant = Number(inp('cantidad_inicial').value) || 0;
        if ($('#pLotes').checked) v.maneja_lotes = true;
        if (prodCtx.desdeEntrada) llegadas.push(cant);
        else {
            if (cant > 0) v.cantidad_inicial = cant;
            if (v.maneja_lotes && cant > 0) {
                if (!(inp('lote').value.trim() && inp('vencimiento').value)) return falla(err, `${pre}indica lote y vencimiento del stock inicial.`, inp('lote').value.trim() ? inp('vencimiento') : inp('lote'));
                v.lote = inp('lote').value.trim(); v.vencimiento = inp('vencimiento').value;
            }
        }
        const clave = `${norm(v.color)}|${norm(v.talla_presentacion)}`;
        if (claves.has(clave)) return falla(err, `${pre}repite el color y la talla de otra variante.`, inp('color'));
        claves.add(clave);
        if (v.codigo_barras) {
            if (barras.has(v.codigo_barras)) return falla(err, `${pre}el código de barras está repetido en otra variante.`, inp('codigo_barras'));
            barras.add(v.codigo_barras);
        }
        variantes.push(v);
    }
    const nombre = f.nombre.value.trim(), ctx = prodCtx;
    await enviar(e.target, err, { accion: 'crear', producto: { nombre, marca: f.marca.value.trim(), seccion_id: Number(f.seccion_id.value) }, variantes },
        ctx.desdeEntrada ? () => agregarCreadosAEntrada(nombre, variantes, llegadas, ctx.linea) : null);
}

/** Tras crear un producto desde la entrada: busca las variantes nuevas y las agrega como líneas. */
async function agregarCreadosAEntrada(nombre, variantes, cantidades, origen) {
    if (origen?.isConnected && !origen._item) origen._i.p.value = '';   // la línea desde donde se pidió «crear» se reutiliza
    let encontrados = [];
    try { encontrados = (await consulta('lista', { q: nombre })).data.filter((p) => norm(p.nombre) === norm(nombre)); } catch { /* se avisa abajo */ }
    let faltan = 0;
    variantes.forEach((v, i) => {
        const item = encontrados.filter((p) => norm(p.color) === norm(v.color) && norm(p.talla) === norm(v.talla_presentacion)).sort((a, b) => b.id - a.id)[0];
        if (item) agregarLinea(item, cantidades[i] || '', false); else faltan++;
    });
    if (faltan) aviso('El producto se creó, pero no se pudo agregar a la entrada. Búscalo por nombre en la línea.', true);
    const ult = $('#lineas').lastElementChild;
    ($('.l-cant input', ult) || $('.l-prod input', ult))?.focus();
    totalizar();
}

//--- ENTRADA DE MERCANCÍA ---//
function combo(input, { alElegir, alCrear, alEscribir }) {
    const lista = el('ul', { className: 'sugs', role: 'listbox', hidden: true, id: `sg${++uid}` });
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', lista.id);
    input.after(lista);
    let datos = [], activo = -1, seq = 0, timer, ultimaQ = '';
    const opciones = () => $$('li[role="option"]', lista);
    const cerrar = () => { lista.hidden = true; input.setAttribute('aria-expanded', 'false'); activo = -1; };
    const marcar = (i) => {
        const ops = opciones(); activo = ops.length ? (i + ops.length) % ops.length : -1;
        ops.forEach((o, k) => { o.classList.toggle('activo', k === activo); o.setAttribute('aria-selected', String(k === activo)); });
        if (activo >= 0) { input.setAttribute('aria-activedescendant', ops[activo].id); ops[activo].scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
    };
    const elegir = (item) => { cerrar(); alElegir(item); };
    const pintar = (q) => {
        lista.replaceChildren();
        datos.slice(0, 8).forEach((p, i) => {
            const li = el('li', { role: 'option', id: `${lista.id}o${i}` },
                el('div', { className: 's-t' }, p.nombre, ...chipsDe(p)),
                el('div', { className: 's-m', textContent: [p.marca, p.codigo_barras, `stock ${p.cantidad}`].filter(Boolean).join(' · ') }));
            li.addEventListener('mousedown', (e) => { e.preventDefault(); elegir(p); });
            lista.append(li);
        });
        if (!datos.length) lista.append(el('li', { className: 'nada', textContent: 'No hay productos con ese nombre o código.' }));
        if (alCrear) {
            const li = el('li', { role: 'option', id: `${lista.id}c`, className: 'crear' }, icono('fas fa-plus'), ` Crear «${q}» como producto nuevo`);
            li.addEventListener('mousedown', (e) => { e.preventDefault(); cerrar(); alCrear(q); });
            li.dataset.crear = '1';
            lista.append(li);
        }
        lista.hidden = false; input.setAttribute('aria-expanded', 'true'); activo = -1;
        lista.scrollIntoView({ block: 'nearest' });
    };
    const buscar = async () => {
        const q = input.value.trim();
        if (q.length < 2) { cerrar(); return null; }
        const mi = ++seq; ultimaQ = q;
        try {
            const { data } = await consulta('lista', { q });
            if (mi !== seq) return null;
            datos = data; pintar(q);
            const exacto = /^\d{6,}$/.test(q) ? data.filter((p) => p.codigo_barras === q) : [];
            if (exacto.length === 1) elegir(exacto[0]);      // código de barras exacto: se elige solo
            return data;
        } catch (e) { if (mi === seq) { cerrar(); aviso(e.message, true); } return null; }
    };
    input.addEventListener('input', () => { alEscribir?.(); clearTimeout(timer); timer = setTimeout(buscar, 250); });
    input.addEventListener('keydown', async (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (lista.hidden) return;
            e.preventDefault(); marcar(activo + (e.key === 'ArrowDown' ? 1 : -1));
        } else if (e.key === 'Escape' && !lista.hidden) {
            e.preventDefault(); e.stopPropagation(); cerrar();
        } else if (e.key === 'Enter') {
            e.preventDefault();       // el lector de códigos termina con Enter: no debe enviar el formulario a medio llenar
            clearTimeout(timer);
            if (input.value.trim() !== ultimaQ || lista.hidden) await buscar();
            if (lista.hidden) return;
            const ops = opciones();
            if (activo >= 0) return ops[activo].dispatchEvent(new MouseEvent('mousedown', { cancelable: true }));
            if (datos.length === 1) return elegir(datos[0]);
            if (!datos.length && alCrear && /^\d{6,}$/.test(input.value.trim())) { cerrar(); return alCrear(input.value.trim()); }
            marcar(datos.length ? 0 : ops.length - 1);
        }
    });
    input.addEventListener('blur', () => setTimeout(cerrar, 120));
}

const lineas = () => $$('#lineas .linea');
const puestoDe = (fs) => lineas().indexOf(fs) + 1;

function nuevaLinea() {
    const n = ++uid;
    const fs = el('div', { className: 'linea' });
    const prod = campo(`l${n}p`, 'Producto o código de barras', { type: 'text', autocomplete: 'off', placeholder: 'Escribe o escanea el código' });
    prod.className = 'field l-prod';
    const wrap = el('div', { className: 'combo' }, $('input', prod)); prod.append(wrap);
    const cant = campo(`l${n}c`, 'Cantidad', { type: 'number', min: 1, max: 100000, step: '1', inputMode: 'numeric' }); cant.classList.add('l-cant');
    const costo = campo(`l${n}k`, 'Costo unitario (USD)', { type: 'number', min: 0.01, max: MAX_NUM, step: '0.01', inputMode: 'decimal' }); costo.classList.add('l-costo');
    const sub = el('div', { className: 'l-sub', textContent: usd(0) });
    const quitar = el('button', { type: 'button', className: 'l-x', 'aria-label': 'Quitar línea', title: 'Quitar línea' }, icono('fas fa-trash-can'));
    const info = el('p', { className: 'l-info', hidden: true });
    const lote = campo(`l${n}l`, 'Lote', { type: 'text', maxLength: 40, autocomplete: 'off' });
    const venc = campo(`l${n}v`, 'Vencimiento', { type: 'date' });
    const loteBox = el('div', { className: 'l-lote', hidden: true }, lote, venc);
    $('input', lote).disabled = $('input', venc).disabled = true;
    fs.append(prod, cant, costo, sub, quitar, info, loteBox);
    const i = { p: $('input', prod), c: $('input', cant), k: $('input', costo), l: $('input', lote), v: $('input', venc) };
    for (const [k, x] of Object.entries(i)) x.setAttribute('data-k', k);
    fs._i = i; fs._sub = sub; fs._item = null; fs._auto = '';

    fs._poner = (item) => {                      // deja la línea apuntando a este producto
        fs._item = item;
        i.p.value = item ? nombreVar(item) : i.p.value;
        const lotes = !!item?.maneja_lotes;
        loteBox.hidden = !lotes; i.l.disabled = i.v.disabled = !lotes;
        if (!lotes) i.l.value = i.v.value = '';
        const ult = Number(item?.precio_costo);
        info.hidden = !item;
        info.textContent = item ? [`Stock actual: ${item.cantidad}`, ult > 0 && `Último costo: ${usd(ult)}`, lotes && 'Maneja lotes y vencimiento'].filter(Boolean).join(' · ') : '';
        if (item && ult > 0 && (!i.k.value || i.k.value === fs._auto)) { fs._auto = String(item.precio_costo); i.k.value = fs._auto; }
        totalizar();
    };
    combo(i.p, {
        alElegir: (item) => elegirEnLinea(fs, item),
        alCrear: (q) => abrirProducto({ desdeEntrada: true, linea: fs, ...(/^\d{6,}$/.test(q) ? { codigo: q } : { nombre: q }) }),
        alEscribir: () => { if (fs._item) fs._poner(null); },
    });
    quitar.addEventListener('click', () => {
        fs.remove();
        if (!lineas().length) agregarLinea();
        totalizar();
    });
    // Enter avanza campo a campo y, al terminar, abre la línea siguiente (flujo de escáner).
    const siguiente = (desde) => {
        const orden = [i.c, i.k, ...(loteBox.hidden ? [] : [i.l, i.v])];
        const sig = orden.slice(orden.indexOf(desde) + 1).find((x) => !x.value);
        if (sig) return sig.focus();
        proximaLinea();
    };
    for (const x of [i.c, i.k, i.l, i.v]) x.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); siguiente(x); } });
    return fs;
}
function elegirEnLinea(fs, item) {
    const otra = lineas().find((l) => l !== fs && l._item?.id === item.id);
    if (otra) {                                  // el mismo producto otra vez: se suma a su línea (escanear varias veces = más unidades)
        const c = $('.l-cant input', otra);
        c.value = String((Number(c.value) || 0) + 1);
        otra.classList.remove('dup'); void otra.offsetWidth; otra.classList.add('dup');
        aviso(`${nombreVar(item)}: se sumó 1 unidad en la línea ${puestoDe(otra)}.`);
        fs._i.p.value = ''; fs._poner(null); fs._i.p.focus(); totalizar();
        return;
    }
    fs._poner(item);
    fs._i.c.focus(); fs._i.c.select?.();
}
function agregarLinea(item, cant, enfocar = true) {
    const vacia = lineas().find((l) => !l._item && !l._i.p.value.trim() && !l._i.c.value);
    const fs = vacia && item ? vacia : nuevaLinea();
    if (!fs.isConnected) $('#lineas').append(fs);
    if (item) { fs._poner(item); if (cant) fs._i.c.value = String(cant); }
    if (enfocar) (item && !cant ? fs._i.c : fs._i.p).focus();
    totalizar();
    return fs;
}
function proximaLinea() {
    const ult = lineas().at(-1);
    if (ult && !ult._item && !ult._i.p.value.trim()) return ult._i.p.focus();
    agregarLinea();
}

function totalizar() {
    let uds = 0, total = 0;
    for (const fs of lineas()) {
        const c = Number(fs._i.c.value), k = Number(fs._i.k.value);
        fs._sub.textContent = usd(c > 0 && k > 0 ? round2(c * k) : 0);
        if (c > 0) { uds += c; if (k > 0) total += c * k; }
    }
    $('#totalEntrada').textContent = `${plural(uds, 'unidad', 'unidades')} · ${usd(round2(total))}`;
}

async function cargarProveedores() {
    const { data } = await consulta('proveedores');
    state.proveedores = data;
    const sel = $('#lProv'), actual = sel.value;
    sel.replaceChildren(el('option', { value: '', textContent: 'Sin proveedor' }), ...data.map((p) => el('option', { value: p.id, textContent: p.nombre })), el('option', { value: '__nuevo', textContent: '＋ Proveedor nuevo…' }));
    if ([...sel.options].some((o) => o.value === actual)) sel.value = actual;
}
/** Devuelve el id del proveedor, creándolo solo si no existe (un reintento tras un fallo no lo duplica). */
async function asegurarProveedor(nombre) {
    const buscar = () => [...$('#lProv').options].find((o) => o.value && o.value !== '__nuevo' && o.textContent.trim().toLowerCase() === nombre.toLowerCase());
    let op = buscar();
    let creado = '';
    if (!op) { const r = await api(API, { accion: 'proveedor', nombre }); creado = r.proveedor_id ? String(r.proveedor_id) : ''; await cargarProveedores(); op = buscar(); }
    if (!op) { if (creado) { $('#filaNuevoProv').hidden = true; $('#lNuevoProv').value = ''; } return creado; }
    $('#lProv').value = op.value; $('#filaNuevoProv').hidden = true; $('#lNuevoProv').value = '';
    return op.value;
}

function abrirEntrada(items = []) {
    const f = $('#formEntrada');
    f.reset(); mostrarError($('#errEntrada'), '');
    $('#filaNuevoProv').hidden = true;
    $('#lineas').replaceChildren();
    if (items.length) items.forEach((it) => agregarLinea(it, '', false)); else agregarLinea(null, '', false);
    totalizar();
    $('#dlgEntrada').showModal();
    (items.length ? lineas()[0]._i.c : lineas()[0]._i.p).focus();
}

async function guardarEntrada(e) {
    e.preventDefault();
    const err = $('#errEntrada'); mostrarError(err, '');
    const prov = $('#lProv').value;
    if (prov === '__nuevo' && !$('#lNuevoProv').value.trim()) return falla(err, 'Escribe el nombre del proveedor nuevo.', $('#lNuevoProv'));
    const out = [];
    const llenas = lineas().filter((fs) => fs._item || fs._i.p.value.trim() || fs._i.c.value);   // una línea totalmente vacía se ignora
    if (!llenas.length) return falla(err, 'Agrega al menos un producto a la entrada.', lineas()[0]._i.p);
    for (const fs of llenas) {
        const i = fs._i, pre = lineas().length > 1 ? `Línea ${puestoDe(fs)}: ` : '', item = fs._item;
        const c = Number(i.c.value), k = Number(i.k.value);
        if (!item) return falla(err, `${pre}elige un producto de la lista.`, i.p);
        if (!Number.isInteger(c) || c < 1) return falla(err, `${pre}la cantidad debe ser un entero mayor que cero.`, i.c);
        if (!(k > 0)) return falla(err, `${pre}indica el costo unitario.`, i.k);
        if (item.maneja_lotes && !(i.l.value.trim() && i.v.value)) return falla(err, `${pre}indica lote y vencimiento.`, i.l.value.trim() ? i.v : i.l);
        out.push({ variante_id: item.id, cantidad: c, costo: k, lote: i.l.value.trim() || undefined, vencimiento: i.v.value || undefined });
    }
    await enviar(e.target, err, async () => {
        const nuevo = prov === '__nuevo' ? $('#lNuevoProv').value.trim() : '';
        const id = nuevo ? await asegurarProveedor(nuevo) : prov;
        return { accion: 'llegada', proveedor_id: id ? Number(id) : null, numero_factura: $('#lFact').value.trim(), lineas: out };
    });
}

//--- SALIDA / AJUSTE ---//
let movActual = null;
const sentidoActual = () => $('input[name="sentido"]:checked').value;
const restaStock = () => movActual.tipo === 'salida' || sentidoActual() === 'salida';
function previewMov() {
    if (!movActual) return;
    const cant = Number($('#mCant').value), stock = Number(movActual.p.cantidad), out = $('#movPreview');
    const valida = Number.isInteger(cant) && cant >= 1;
    const nuevo = stock + (restaStock() ? -cant : cant);
    out.classList.toggle('mal', valida && nuevo < 0);
    if (!valida) return out.replaceChildren();
    if (nuevo < 0) return out.replaceChildren(`Solo hay ${stock} en stock: no se pueden restar ${cant}.`);
    out.replaceChildren('Stock después:', el('b', { textContent: String(nuevo) }), el('span', { className: 'antes', textContent: `(ahora ${stock})` }));
}
function abrirMov(p, tipo) {
    movActual = { p, tipo };
    const ajuste = tipo === 'ajuste';
    $('#hMov').textContent = ajuste ? 'Ajustar stock' : 'Registrar salida';
    $('#btnMov').textContent = !state.admin ? 'Pedir autorización' : ajuste ? 'Registrar ajuste' : 'Registrar salida';
    $('#movProducto').replaceChildren(el('strong', { textContent: p.nombre }), chipsDe(p).length ? el('div', { className: 'chips' }, ...chipsDe(p)) : null, el('span', { className: 'muted', textContent: `Stock actual: ${p.cantidad}` }));
    $('#filaSentido').hidden = !ajuste;
    $('#mMotivo').replaceChildren(...MOTIVOS[tipo].map((m) => el('option', { value: m, textContent: m })));
    $('#formMov').reset(); mostrarError($('#errMov'), '');
    detalleSegunMotivo(); previewMov();
    $('#dlgMov').showModal();
    $('#mCant').focus();
}
function detalleSegunMotivo() {
    const otro = $('#mMotivo').value === 'Otro';
    $('#lblDetalle').replaceChildren('Detalle ', el('span', { className: 'opc', textContent: otro ? '(obligatorio: explica el motivo)' : '(opcional)' }));
}

async function guardarMov(e) {
    e.preventDefault();
    const err = $('#errMov'); mostrarError(err, '');
    const cant = Number($('#mCant').value), detalle = $('#mDetalle').value.trim(), motivo = $('#mMotivo').value;
    if (!Number.isInteger(cant) || cant < 1) return falla(err, 'La cantidad debe ser un entero mayor que cero.', $('#mCant'));
    if (motivo === 'Otro' && detalle.length < 3) return falla(err, 'Describe el motivo en el detalle.', $('#mDetalle'));
    const cuerpo = {
        accion: movActual.tipo, variante_id: movActual.p.id, cantidad: cant,
        motivo: motivo === 'Otro' ? detalle : detalle ? `${motivo} - ${detalle}` : motivo,
        ...(movActual.tipo === 'ajuste' ? { sentido: sentidoActual() } : {}),
    };
    if (restaStock() && Number(movActual.p.cantidad) - cant < 0) return falla(err, `Solo hay ${movActual.p.cantidad} en stock: no se pueden restar ${cant}.`, $('#mCant'));
    if (state.admin) return enviar(e.target, err, cuerpo);
    await enviarConAutorizacion(e.target, cuerpo);
}

/** Quien no es admin: solicita el código a un admin y la operación se ejecuta al escribirlo (js/autorizacion.js). */
async function enviarConAutorizacion(form, cuerpo) {
    const { p, tipo } = movActual, sentido = tipo === 'ajuste' ? cuerpo.sentido : 'salida';
    const resumen = `${tipo === 'ajuste' ? `Ajuste de ${sentido}` : 'Salida'} de ${cuerpo.cantidad} × ${nombreVar(p)} (stock actual: ${p.cantidad})`;
    form.closest('dialog').close();
    try {
        const d = await conAutorizacion({
            accion: tipo, objetivo: p.id, detalle: { cantidad: cuerpo.cantidad, sentido },
            titulo: tipo === 'ajuste' ? 'Ajustar stock' : 'Registrar salida', motivo: cuerpo.motivo, resumen,
            ejecutar: (autorizacion) => api(API, { ...cuerpo, autorizacion }),
        });
        if (!d) return;                          // canceló la solicitud
        aviso(d.message || 'Listo.');
        await Promise.all([cargarLista(), $('#panKardex').hidden ? null : cargarKardex()]);
    } catch (x) { aviso(x.message, true); }
}

/** Cierra un diálogo sin datos que perder al pulsar fuera; exige que el clic también empiece fuera. */
function cerrarAlPulsarFuera(dlg) {
    if (dlg._fuera) return;
    dlg._fuera = true;
    let pulso = false;
    dlg.addEventListener('mousedown', (e) => { pulso = e.target === dlg; });
    dlg.addEventListener('click', (e) => { if (pulso && e.target === dlg) dlg.close(); });
}

//--- ARRANQUE ---//
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
    for (const b of $$('.filtro[data-alerta]')) b.addEventListener('click', () => { fijarAlerta(b.dataset.alerta); cargarLista(); });
    $('#fLimpiar').addEventListener('click', limpiarFiltros);
    for (const id of ['#kSeccion', '#kTipo']) $(id).addEventListener('change', cargarKardex);
    for (const id of ['#kDesde', '#kHasta']) $(id).addEventListener('change', () => {
        $('#kHasta').min = $('#kDesde').value; $('#kDesde').max = $('#kHasta').value; kFiltrosCambiaron();
    });
    for (const b of $$('.filtro[data-preset]')) b.addEventListener('click', () => aplicarPreset(b.dataset.preset));
    $('#kQuitar').addEventListener('click', () => { state.kVar = null; $('#kFiltroVar').hidden = true; cargarKardex(); });
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
    cerrarAlPulsarFuera($('#dlgMov'));

    // Producto nuevo
    $('#btnNuevo')?.addEventListener('click', () => abrirProducto());
    $('#btnOtraVar').addEventListener('click', () => { const fs = agregarVariante(); $('input', fs).focus(); });
    $('#formProducto').addEventListener('submit', guardarProducto);
    $('#formProducto').addEventListener('input', (e) => {
        if (e.target.matches('[data-base]')) { sincronizarVariantes(); actualizarMargen(); }
        if (e.target.id === 'pLotes') actualizarLotes();
    });
    $('#pLotes').addEventListener('change', actualizarLotes);

    // Entrada de mercancía
    $('#btnEntrada')?.addEventListener('click', () => abrirEntrada());
    $('#btnOtraLinea').addEventListener('click', () => agregarLinea());
    $('#lineas').addEventListener('input', totalizar);
    $('#lProv').addEventListener('change', () => {
        const nuevo = $('#lProv').value === '__nuevo';
        $('#filaNuevoProv').hidden = !nuevo;
        if (nuevo) $('#lNuevoProv').focus();
    });
    $('#formEntrada').addEventListener('submit', guardarEntrada);

    // Salida / ajuste
    $('#mCant').addEventListener('input', previewMov);
    $$('input[name="sentido"]').forEach((r) => r.addEventListener('change', previewMov));
    $('#mMotivo').addEventListener('change', detalleSegunMotivo);
    $('#formMov').addEventListener('submit', guardarMov);

    await cargarLista();
}

init();
