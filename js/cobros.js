/* ==========================================================================
 * Cobros — Katoa
 * Cuentas por cobrar de las ventas a crédito (fiado): quién debe, cuánto, hasta cuándo, y registro de abonos.
 * Servidor: /api/historial (modos cobros_*, acciones cobro_abonar / cobro_regularizar). SQL: sql/cobros.sql
 * ========================================================================== */
import { usd, bs, round2, fechaISO, fechaHora } from './utils/format.js';
import { obtenerTasa, apiJson as api } from './utils/api.js';
import { abrirFactura, aviso } from './factura-modal.js';
import { BANCOS, METODOS_BANCO } from './utils/venta.js';

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
    PM: 'Pago móvil', TB: 'Transferencia bancaria', PVD: 'Punto de venta (débito)', PVC: 'Punto de venta (crédito)', ED: 'Efectivo en dólares',
    EBS: 'Efectivo en bolívares', ZELLE: 'Zelle', BINANCE: 'Binance', OTROS: 'Otros',
};
const METODOS_USD = new Set(['ED', 'ZELLE', 'BINANCE']);
const state = { items: [], estado: 'pendientes', q: '', seq: 0, cuenta: null, token: null, enviando: false, tasa: 0 };

const normal = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

//--- Estado de una cuenta (texto + clase) ---//
function situacion(c) {
    if (c.estado === 'pagada') return { clase: 'ok', texto: 'Pagada' };
    if (c.estado === 'anulada') return { clase: 'venc', texto: 'Anulada' };
    const d = c.dias_restantes;
    if (c.vencida) return { clase: 'venc', texto: `Vencida hace ${-d} día${d === -1 ? '' : 's'}` };
    if (d === 0) return { clase: 'pronto', texto: 'Vence hoy' };
    if (c.por_vencer) return { clase: 'pronto', texto: `Vence en ${d} día${d === 1 ? '' : 's'}` };
    return { clase: '', texto: `Faltan ${d} días` };
}

//--- Resumen ---//
function pintarResumen(r) {
    $('#kPorCobrar').textContent = usd(r.por_cobrar_usd);
    $('#kPendientes').textContent = `${r.pendientes} cuenta${r.pendientes === 1 ? '' : 's'} pendiente${r.pendientes === 1 ? '' : 's'}`;
    $('#kVencido').textContent = usd(r.vencido_usd);
    $('#kVencidas').textContent = `${r.vencidas} cuenta${r.vencidas === 1 ? '' : 's'} vencida${r.vencidas === 1 ? '' : 's'}`;
    $('#kPorVencer').textContent = String(r.por_vencer);
    $('#kHoy').textContent = usd(r.cobrado_hoy_usd);
}

//--- Lista ---//
function visibles() {
    const q = normal(state.q).trim();
    return q ? state.items.filter((c) => normal(`${c.nombre_cliente} ${c.cedula} ${c.telefono} ${c.id_factura}`).includes(q)) : state.items;
}

function tarjeta(c) {
    const s = situacion(c);
    const pct = c.total_usd > 0 ? Math.min(100, (c.abonado_usd / c.total_usd) * 100) : 0;
    const b = el('button', { type: 'button', className: `fac cuenta${c.vencida ? ' vencida' : ''}${c.estado === 'pagada' ? ' pagada' : ''}` });
    b.dataset.id = c.id;
    b.append(
        el('div', { className: 'fac-top' }, el('span', { className: 'fac-id', textContent: c.id_factura }),
            el('span', { className: `badge ${s.clase}`, textContent: s.texto })),
        el('div', { className: 'fac-cliente', textContent: c.nombre_cliente }),
        el('div', { className: 'fac-meta' }, el('span', { textContent: `C.I. ${c.cedula}` }),
            el('span', { textContent: `Vence: ${fechaISO(c.fecha_vence)}` }), el('span', { textContent: `Plazo: ${c.plazo_dias} días` })),
        el('div', { className: 'barra', 'aria-hidden': 'true' }, el('span', { style: `width:${pct}%` })),
        el('div', { className: 'fac-total' }, el('strong', { textContent: usd(c.saldo_usd) }),
            el('span', { textContent: `Abonado ${usd(c.abonado_usd)} de ${usd(c.total_usd)}` })));
    return b;
}

function pintarLista() {
    const filas = visibles();
    $('#lista').replaceChildren(...filas.map(tarjeta));
    $('#cont').textContent = String(filas.length);
    $('#vacio').hidden = filas.length > 0;
    $('#vacioTxt').textContent = state.items.length === 0
        ? { pendientes: 'No hay cuentas pendientes. 🎉', vencidas: 'No hay cuentas vencidas.', pagadas: 'Todavía no hay cuentas pagadas.', todas: 'No hay cuentas a crédito.' }[state.estado]
        : 'Ninguna cuenta coincide con la búsqueda.';
}

async function cargar() {
    const seq = ++state.seq;
    $('#lista').classList.add('cargando'); $('#lista').setAttribute('aria-busy', 'true');
    try {
        const d = await api(`${API}?modo=cobros_lista&estado=${state.estado}`);
        if (seq !== state.seq) return;
        state.items = d.data;
        pintarResumen(d.resumen);
        const nota = $('#nota');
        nota.hidden = !(d.truncado || d.resumen.truncado);
        if (!nota.hidden) nota.textContent = `Hay más cuentas de las que se pueden mostrar: se listan las ${d.limite} primeras. Los totales de arriba pueden estar incompletos.`;
        pintarLista();
    } catch (e) {
        if (seq === state.seq) aviso(e.message, true);
    } finally {
        if (seq === state.seq) { $('#lista').classList.remove('cargando'); $('#lista').setAttribute('aria-busy', 'false'); }
    }
}

//--- Facturas a crédito sin deuda registrada ---//
async function cargarSinCuenta() {
    try {
        const d = await api(`${API}?modo=cobros_sin_cuenta`);
        const n = d.data.length;
        $('#bannerSinCuenta').hidden = n === 0;
        if (!n) return;
        $('#sinCuentaTxt').textContent = n === 1 ? 'Hay 1 factura a crédito sin deuda en Cobros.' : `Hay ${n} facturas a crédito sin deuda en Cobros.`;
        const admin = window.Auth?.tieneNivel('admin');
        $('#sinCuentaLista').replaceChildren(...d.data.map((f) => {
            const fila = el('div', { className: 'sc-fila' },
                el('span', { textContent: `${f.id_factura} · ${f.cliente} · ${usd(f.total_usd)}` }));
            if (admin) {
                const b = el('button', { type: 'button', className: 'btn btn-ghost btn-mini', textContent: 'Registrar deuda' });
                b.addEventListener('click', () => regularizar(f));
                fila.append(b);
            } else fila.append(el('span', { className: 'muted', textContent: 'Avisa a un administrador.' }));
            return fila;
        }));
    } catch { /* el aviso es informativo: si falla no se muestra */ }
}

async function regularizar(f) {
    const txt = window.prompt(`¿Cuántos días tiene ${f.cliente} para pagar? (cuentan desde la fecha de la venta)`, '15');
    if (txt === null) return;
    const dias = Number(txt);
    if (!Number.isInteger(dias) || dias < 1) return aviso('Escribe un número entero de días.', true);
    try {
        const d = await api(API, { accion: 'cobro_regularizar', id_factura: f.id_factura, plazo_dias: dias });
        aviso(d.message);
        await Promise.all([cargar(), cargarSinCuenta()]);
    } catch (e) { aviso(e.message, true); }
}

//--- Detalle de la cuenta + abonos ---//
const dato = (v) => (v && v !== 'N/A' ? v : null);

function pintarCuenta(d) {
    const c = d.data; state.cuenta = c;
    const s = situacion(c);
    $('#cTitulo').textContent = c.nombre_cliente;
    $('#cSub').textContent = `C.I. ${c.cedula}${c.telefono ? ` · ${c.telefono}` : ''} · Factura ${c.id_factura}`;
    const kv = (t, v) => el('div', {}, el('dt', { textContent: t }), el('dd', { textContent: v }));
    $('#cDatos').replaceChildren(
        kv('Total', usd(c.total_usd)), kv('Abonado', usd(c.abonado_usd)), kv('Saldo', usd(c.saldo_usd)),
        kv('Fecha de venta', fechaISO(c.fecha_venta)), kv('Vence', `${fechaISO(c.fecha_vence)} (${c.plazo_dias} días)`), kv('Estado', s.texto));
    const cont = $('#cAbonos');
    if (!d.abonos.length) cont.replaceChildren(el('p', { className: 'muted', textContent: 'Todavía no hay abonos.' }));
    else {
        const filas = d.abonos.map((a) => {
            const det = [METODOS[a.metodo] ?? a.metodo, dato(a.banco), dato(a.referencia) && `Ref. ${a.referencia}`,
                a.moneda === 'BS' ? `${bs(a.monto_moneda)} a ${a.tasa_cambio}` : null, a.usuario_nombre].filter(Boolean).join(' · ');
            return el('tr', {}, el('td', { textContent: fechaHora(a.creado_en) }), el('td', { textContent: det }),
                el('td', { className: 'n', textContent: usd(Number(a.monto_usd)) }));
        });
        cont.replaceChildren(el('table', { className: 'ab-tabla' },
            el('thead', {}, el('tr', {}, el('th', { textContent: 'Fecha' }), el('th', { textContent: 'Detalle' }), el('th', { className: 'n', textContent: 'Monto' }))),
            el('tbody', {}, ...filas)));
    }
    $('#formAbono').hidden = c.estado !== 'pendiente';
}

async function abrirCuenta(id) {
    try {
        const d = await api(`${API}?modo=cobros_cuenta&id=${encodeURIComponent(id)}`);
        pintarCuenta(d);
        state.token = crypto.randomUUID();     // un envío = un token: reintentar o hacer doble clic no duplica el cobro
        $('#formAbono').reset();
        $('#aTasa').value = state.tasa ? String(state.tasa) : '';
        ajustarCampos();
        $('#aError').hidden = true;
        if (!$('#dlgCuenta').open) $('#dlgCuenta').showModal();
    } catch (e) { aviso(e.message, true); }
}

//--- Formulario de abono ---//
const monedaActual = () => {
    const m = $('#aMetodo').value;
    return m === 'OTROS' ? $('#aMoneda').value : METODOS_USD.has(m) ? 'USD' : 'BS';
};

function ajustarCampos() {
    const m = $('#aMetodo').value;
    $('#fMoneda').hidden = m !== 'OTROS';
    $('#fTasa').hidden = monedaActual() !== 'BS';
    $('#fBanco').hidden = !METODOS_BANCO.has(m);
    $('#fRef').hidden = !METODOS_BANCO.has(m) && !['ZELLE', 'BINANCE'].includes(m);
    $('#lblRef').textContent = METODOS_BANCO.has(m) ? 'Número de referencia' : m === 'ZELLE' ? 'Número de confirmación' : 'ID de orden o referencia';
    $('#aRef').placeholder = METODOS_BANCO.has(m) ? 'Últimos 4 a 12 dígitos' : '4 a 30 letras o números';
    $('#lblObs').textContent = m === 'OTROS' ? 'Observaciones (describe el pago)' : 'Observaciones (opcional)';
    equivalente();
}

function equivalente() {
    const monto = Number($('#aMonto').value), tasa = Number($('#aTasa').value);
    $('#aEquiv').textContent = monto > 0 && tasa > 0 ? `Equivale a ${bs(round2(monto * tasa))}` : '';
}

function leerAbono() {
    const c = state.cuenta, m = $('#aMetodo').value, val = (id) => $(`#${id}`).value.trim();
    const monto = Number(val('aMonto'));
    const err = (error, campo) => ({ error, campo });
    if (!(monto > 0)) return err('Escribe el monto a abonar.', 'aMonto');
    if (monto > c.saldo_usd + 0.004) return err(`El monto supera el saldo pendiente (${usd(c.saldo_usd)}).`, 'aMonto');
    const p = { accion: 'cobro_abonar', cuenta_id: c.id, monto_usd: round2(monto), metodo: m, observaciones: val('aObs'), token: state.token };
    if (m === 'OTROS') { p.moneda = $('#aMoneda').value; if (!p.observaciones) return err('Describe el método de pago en las observaciones.', 'aObs'); }
    if (monedaActual() === 'BS') {
        const tasa = Number($('#aTasa').value);
        if (!(tasa > 0)) return err('Escribe la tasa de cambio.', 'aTasa');
        p.tasa_cambio = tasa;
    }
    if (METODOS_BANCO.has(m)) {
        p.banco = $('#aBanco').value; p.referencia = val('aRef');
        if (!p.banco) return err('Selecciona el banco destino.', 'aBanco');
        if (!/^\d{4,12}$/.test(p.referencia)) return err('La referencia debe tener entre 4 y 12 dígitos.', 'aRef');
    } else if (m === 'ZELLE' || m === 'BINANCE') {
        p.referencia = val('aRef').toUpperCase();
        if (!/^[A-Z0-9]{4,30}$/.test(p.referencia)) return err('La referencia debe tener entre 4 y 30 letras o números.', 'aRef');
    }
    return { pago: p };
}

async function cobrar(e) {
    e.preventDefault();
    if (state.enviando) return;
    const l = leerAbono(), msg = $('#aError');
    if (l.error) { msg.textContent = l.error; msg.hidden = false; $(`#${l.campo}`)?.focus(); return; }
    msg.hidden = true; state.enviando = true; $('#btnCobrar').disabled = true;
    try {
        const d = await api(API, l.pago);
        aviso(d.message);
        const id = state.cuenta.id;
        await Promise.all([cargar(), cargarSinCuenta()]);
        await abrirCuenta(id);                 // refresca saldo y abonos (y genera un token nuevo)
    } catch (ex) {
        msg.textContent = ex.message; msg.hidden = false;   // el token se conserva: reintentar no duplica el cobro
    } finally { state.enviando = false; $('#btnCobrar').disabled = false; }
}

//--- Inicio ---//
async function init() {
    if (window.Auth && !(await window.Auth.listo)) return;
    $('#aBanco').append(...BANCOS.map(([v, nombre]) => el('option', { value: v, textContent: nombre })));
    let t;
    $('#fBuscar').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; pintarLista(); }, 200); });
    for (const b of $$('.filtro')) b.addEventListener('click', () => {
        state.estado = b.dataset.estado;
        for (const x of $$('.filtro')) x.setAttribute('aria-pressed', String(x === b));
        cargar();
    });
    $('#lista').addEventListener('click', (e) => { const b = e.target.closest('.cuenta'); if (b) abrirCuenta(b.dataset.id); });
    $('#btnActualizar').addEventListener('click', () => { cargar(); cargarSinCuenta(); });
    $('#btnCerrar').addEventListener('click', () => $('#dlgCuenta').close());
    $('#btnVerFactura').addEventListener('click', () => state.cuenta && abrirFactura(state.cuenta.id_factura));
    $('#aMetodo').addEventListener('change', ajustarCampos);
    $('#aMoneda').addEventListener('change', ajustarCampos);
    $('#aMonto').addEventListener('input', equivalente);
    $('#aTasa').addEventListener('input', equivalente);
    $('#aRef').addEventListener('input', (e) => { if (METODOS_BANCO.has($('#aMetodo').value)) e.target.value = e.target.value.replace(/\D/g, ''); });
    $('#btnSaldo').addEventListener('click', () => { if (state.cuenta) { $('#aMonto').value = String(state.cuenta.saldo_usd); equivalente(); } });
    $('#formAbono').addEventListener('submit', cobrar);
    state.tasa = Number(localStorage.getItem('tasaFacturacion')) || 0;   // la misma que usa Nueva venta
    obtenerTasa().then((v) => { if (v > 0) state.tasa = v; });
    await Promise.all([cargar(), cargarSinCuenta()]);
}

init();
