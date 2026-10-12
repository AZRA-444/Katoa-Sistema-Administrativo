import { usd } from './utils/format.js';

const API = '/api/administrador';
const TZ = 'America/Caracas';
const PAGINA = 100;
const METODOS = {
    PM: 'Pago móvil', PVD: 'Punto débito', PVC: 'Punto crédito', ED: 'Efectivo $', EBS: 'Efectivo Bs',
    ZELLE: 'Zelle', BINANCE: 'Binance', OTROS: 'Otros', MIXTO: 'Pago combinado', CREDITO: 'Crédito (fiado)',
};
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, ...hijos) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...hijos); return n; };
const nm = (m) => METODOS[m] || m || '—';
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const dia = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const fechaHora = (iso) => new Date(iso).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ });
const fechaDia = (d) => d.split('-').reverse().join('/');
const suma = (a, f) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);

const S = { mes: hoy().slice(0, 7), ventas: [], egresos: [], costo: null, cats: [], verV: PAGINA, verE: PAGINA, com: null, pct: null, pago: null };
let avisoT;

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

//--- CÁLCULOS ---//
/** Reparte cada factura entre sus métodos (los pagos combinados se prorratean por abono). */
function porMetodo(ventas) {
    const m = new Map();
    const sumar = (k, v) => m.set(k, (m.get(k) || 0) + v);
    for (const f of ventas) {
        const t = Number(f.total_usd) || 0, p = f.pagos_combinados;
        if (f.metodo_pago === 'MIXTO' && Array.isArray(p) && p.length) {
            const base = suma(p, (x) => x.abono_usd) || 1;
            for (const x of p) sumar(x.metodo, (t * (Number(x.abono_usd) || 0)) / base);
        } else sumar(f.metodo_pago, t);
    }
    return m;
}
function agrupar(filas, clave, valor) {
    const m = new Map();
    for (const f of filas) m.set(clave(f), (m.get(clave(f)) || 0) + (Number(valor(f)) || 0));
    return m;
}
const ordenado = (m) => [...m].sort((a, b) => b[1] - a[1]);

//--- COMPONENTES ---//
function kpis(cont, items) {
    cont.replaceChildren(...items.map(([t, v, sub, clase]) =>
        el('div', { className: `kpi ${clase || ''}` }, el('span', { textContent: t }), el('strong', { textContent: v }),
            sub ? el('small', { textContent: sub }) : '')));
}
function barras(cont, filas) {
    cont.replaceChildren();
    if (!filas.length) return cont.append(el('p', { className: 'muted', textContent: 'Sin datos para mostrar.' }));
    const max = Math.max(...filas.map((f) => f[1])) || 1;
    for (const [k, v, extra] of filas) {
        const b = el('div', { className: 'bar' });
        b.style.width = `${Math.max(2, (v / max) * 100)}%`;
        cont.append(el('div', { className: 'bl' },
            el('div', { className: 'bl-t' }, el('span', { textContent: k }), el('strong', { textContent: usd(v) + (extra ? ` · ${extra}` : '') })),
            el('div', { className: 'bl-pista' }, b)));
    }
}
function columnas(cont, series, resaltar) {
    cont.replaceChildren();
    const [y, m] = S.mes.split('-').map(Number), n = new Date(y, m, 0).getDate();
    const max = Math.max(1, ...series.flatMap((s) => [...s.mapa.values()]));
    const top = resaltar ? ordenado(series[0].mapa)[0]?.[0] : null;
    for (let d = 1; d <= n; d++) {
        const k = `${S.mes}-${String(d).padStart(2, '0')}`, pista = el('div', { className: 'dpista' });
        for (const s of series) {
            const v = s.mapa.get(k) || 0, b = el('div', { className: `dbar ${s.clase}${k === top ? ' top' : ''}`, title: `${d}: ${usd(v)}` });
            b.style.height = `${(v / max) * 100}%`;
            pista.append(b);
        }
        cont.append(el('div', { className: 'dcol' }, pista, el('span', { textContent: d })));
    }
}
function vacio(sel, hay) { $(`#vacio${sel}`).hidden = hay; $(`#filas${sel}`).closest('.table-wrap').hidden = !hay; }

//--- VENTAS ---//
/** Abre el modal de js/factura-modal.js (PDF, WhatsApp, comprobante y anular). */
function botonVistaPrevia(id) {
    const b = el('button', { type: 'button', className: 'btn btn-ghost btn-mini', title: 'Vista previa de la factura', ariaLabel: `Vista previa de la factura ${id}` },
        el('i', { className: 'fas fa-eye' }), ' Vista previa');
    b.dataset.verFactura = id;
    return b;
}
function ventasFiltradas() {
    const q = $('#fBuscar').value.trim().toLowerCase(), m = $('#fMetodo').value, v = $('#fVendedor').value;
    return S.ventas.filter((f) =>
        (!v || f.vendedor === v) &&
        (!m || f.metodo_pago === m || (f.pagos_combinados || []).some((x) => x.metodo === m)) &&
        (!q || [f.id_factura, f.nombre, f.apellido, f.cedula, f.vendedor].join(' ').toLowerCase().includes(q)));
}
function pintarVentas() {
    const v = ventasFiltradas(), total = suma(v, (f) => f.total_usd), porDia = agrupar(v, (f) => dia(f.fecha), (f) => f.total_usd);
    const mejor = ordenado(porDia)[0];
    kpis($('#kVentas'), [
        ['Total vendido', usd(total)], ['Facturas', String(v.length)],
        ['Ticket promedio', usd(v.length ? total / v.length : 0)],
        ['Mejor día', mejor ? fechaDia(mejor[0]).slice(0, 5) : '—', mejor ? usd(mejor[1]) : ''],
    ]);
    $('#mejorDia').textContent = mejor ? `Más ventas: ${fechaDia(mejor[0])} · ${usd(mejor[1])}` : '';
    columnas($('#gDias'), [{ mapa: porDia, clase: 'ing' }], true);
    barras($('#gMetodos'), ordenado(porMetodo(v)).map(([k, x]) => [nm(k), x]));
    const nVend = agrupar(v, (f) => f.vendedor, () => 1);
    barras($('#gVend'), ordenado(agrupar(v, (f) => f.vendedor, (f) => f.total_usd)).map(([k, x]) => [k, x, `${nVend.get(k)} fact.`]));

    $('#contV').textContent = v.length;
    vacio('V', v.length > 0);
    $('#filasV').replaceChildren(...v.slice(0, S.verV).map((f) => el('tr', {},
        el('td', { textContent: fechaHora(f.fecha) }), el('td', { textContent: f.id_factura }),
        el('td', {}, `${f.nombre || ''} ${f.apellido || ''}`.trim(), el('span', { className: 'sub', textContent: f.cedula || '' })),
        el('td', { textContent: f.vendedor }),
        el('td', {}, el('span', { className: 'pill', textContent: nm(f.metodo_pago) })),
        el('td', { className: 'n', textContent: usd(f.total_usd) }),
        el('td', { className: 'c' }, botonVistaPrevia(f.id_factura)))));
    $('#masV').hidden = v.length <= S.verV;
}

//--- EGRESOS ---//
function egresosFiltrados() {
    const q = $('#fBuscarE').value.trim().toLowerCase(), c = $('#fCat').value;
    return S.egresos.filter((e) => (!c || e.categoria === c) && (!q || `${e.descripcion} ${e.proveedor || ''}`.toLowerCase().includes(q)));
}
function filaEgreso(e, borrar) {
    const tr = el('tr', {}, el('td', { textContent: fechaDia(e.fecha) }), el('td', {}, el('span', { className: 'pill', textContent: e.categoria })),
        el('td', {}, e.descripcion, e.proveedor ? el('span', { className: 'sub', textContent: e.proveedor }) : ''),
        el('td', { className: 'n', textContent: usd(e.monto_usd) }));
    if (borrar) {
        const b = el('button', { type: 'button', className: 'btn btn-ghost btn-mini', title: 'Eliminar egreso', ariaLabel: 'Eliminar egreso' }, el('i', { className: 'fas fa-trash' }));
        b.dataset.id = e.id;
        tr.append(el('td', { className: 'c' }, b));
    }
    return tr;
}
function pintarEgresos() {
    const e = egresosFiltrados(), total = suma(e, (x) => x.monto_usd), porCat = agrupar(e, (x) => x.categoria, (x) => x.monto_usd);
    const top = ordenado(porCat)[0];
    kpis($('#kEgresos'), [['Total egresos', usd(total)], ['Registros', String(e.length)], ['Mayor categoría', top ? top[0] : '—', top ? usd(top[1]) : '']]);
    barras($('#gCats'), ordenado(porCat).map(([k, v]) => [k, v, `${total ? Math.round((v / total) * 100) : 0}%`]));
    $('#contE').textContent = e.length;
    vacio('E', e.length > 0);
    $('#filasE').replaceChildren(...e.slice(0, S.verE).map((x) => filaEgreso(x, true)));
    $('#masE').hidden = e.length <= S.verE;
}

//--- FINANZAS ---//
function pintarFinanzas() {
    const ingresos = suma(S.ventas, (f) => f.total_usd), egresos = suma(S.egresos, (e) => e.monto_usd);
    const costo = S.costo ?? 0, bruta = ingresos - costo, neta = bruta - egresos;
    const margen = ingresos ? (neta / ingresos) * 100 : 0;
    kpis($('#kFin'), [
        ['Ingresos', usd(ingresos), `${S.ventas.length} facturas`], ['Gastos totales', usd(costo + egresos), 'Mercancía + egresos'],
        ['Ganancia neta', usd(neta), '', neta >= 0 ? 'pos' : 'neg'], ['Margen neto', `${margen.toFixed(1)} %`, '', neta >= 0 ? 'pos' : 'neg'],
    ]);
    const fila = (t, v, clase = '', nota = '') => el('div', { className: clase }, el('span', {}, t, nota ? el('small', { textContent: nota }) : ''), el('strong', { textContent: usd(v) }));
    $('#estado').replaceChildren(
        fila('Ingresos por ventas', ingresos),
        fila('(−) Costo de la mercancía vendida', costo, '', S.costo == null ? 'No disponible: revisa el kardex' : 'Según el kardex'),
        fila('Ganancia bruta', bruta, 'tot'),
        fila('(−) Egresos operativos', egresos),
        fila('Ganancia neta', neta, `tot ${neta >= 0 ? 'pos' : 'neg'}`));
    const porCat = ordenado(agrupar(S.egresos, (e) => e.categoria, (e) => e.monto_usd)).map(([k, v]) => [k, v]);
    if (S.costo) porCat.unshift(['Mercancía vendida', S.costo]);
    barras($('#gCatsF'), porCat.sort((a, b) => b[1] - a[1]));
    columnas($('#gFin'), [
        { mapa: agrupar(S.ventas, (f) => dia(f.fecha), (f) => f.total_usd), clase: 'ing' },
        { mapa: agrupar(S.egresos, (e) => e.fecha, (e) => e.monto_usd), clase: 'egr' },
    ], false);
    $('#contG').textContent = S.egresos.length;
    vacio('G', S.egresos.length > 0);
    $('#filasG').replaceChildren(...S.egresos.map((e) => filaEgreso(e, false)));
}

//--- CARGA ---//
function llenar(sel, valores, etiqueta = (x) => x) {
    const actual = sel.value;
    const base = sel.options[0]?.value === '' ? [sel.options[0]] : [];
    sel.replaceChildren(...base, ...valores.map((v) => el('option', { value: v, textContent: etiqueta(v) })));
    sel.value = valores.includes(actual) ? actual : '';
}
function pintar() { pintarVentas(); pintarEgresos(); pintarFinanzas(); }

//--- COMISIONES ---//
function pintarComisiones() {
    const d = S.com, cuerpo = $('#filasC');
    $('#errCom').hidden = true;
    if (!d) return;
    $('#comDefecto').textContent = `${d.porcentaje_defecto} % (se aplica a los vendedores sin porcentaje propio)`;
    kpis($('#kCom'), [
        ['Comisiones del mes', usd(d.totales.comision_usd), `${d.vendedores.length} vendedor${d.vendedores.length === 1 ? '' : 'es'}`],
        ['Pagado', usd(d.totales.pagado_usd), null, 'pos'],
        ['Pendiente de pago', usd(d.totales.pendiente_usd), null, d.totales.pendiente_usd > 0 ? 'neg' : ''],
    ]);
    $('#contC').textContent = String(d.vendedores.length);
    $('#vacioC').hidden = d.vendedores.length > 0;
    $('#filasC').closest('.table-wrap').hidden = !d.vendedores.length;
    cuerpo.replaceChildren(...d.vendedores.map((v) => {
        const td = (t, n) => el('td', { className: n ? 'n' : '', textContent: t });
        const pct = el('td', { className: 'n', textContent: `${v.porcentaje} %${v.porcentaje_propio ? '' : '*'}` });
        const bPct = el('button', { type: 'button', className: 'btn btn-ghost btn-mini', textContent: '%' });
        bPct.title = `Cambiar el porcentaje de ${v.vendedor}`; bPct.dataset.accion = 'pct'; bPct.dataset.v = v.vendedor;
        const bPagar = el('button', { type: 'button', className: 'btn btn-primary btn-mini', textContent: 'Pagar' });
        bPagar.dataset.accion = 'pagar'; bPagar.dataset.v = v.vendedor; bPagar.disabled = !(v.pendiente_usd > 0);
        const nom = el('td', {}, el('strong', { textContent: v.vendedor }),
            v.credito_pendiente_usd > 0 ? el('small', { className: 'muted', textContent: ` · crédito sin cobrar ${usd(v.credito_pendiente_usd)}` }) : '');
        return el('tr', {}, nom, td(usd(v.ventas_usd), 1), td(usd(v.devoluciones_usd), 1), td(usd(v.abonos_usd), 1), td(usd(v.base_usd), 1),
            pct, td(usd(v.comision_usd), 1), td(usd(v.pagado_usd), 1), td(usd(v.pendiente_usd), 1), el('td', { className: 'c' }, bPct, ' ', bPagar));
    }));
}

async function cargarComisiones() {
    try {
        S.com = (await api(`${API}?modo=com_resumen&mes=${S.mes}`));
        pintarComisiones();
    } catch (e) {
        S.com = null;
        $('#errCom').textContent = e.message; $('#errCom').hidden = false;
    }
}

function abrirPct(vendedor) {
    const v = S.com.vendedores.find((x) => x.vendedor === vendedor);
    const defecto = vendedor === '*';
    S.pct = vendedor;
    $('#hPct').textContent = defecto ? 'Porcentaje por defecto' : `Porcentaje de ${vendedor}`;
    $('#pctSub').textContent = defecto ? 'Se aplica a todos los vendedores que no tengan uno propio.' : `Hoy: ${v.porcentaje} %${v.porcentaje_propio ? '' : ' (por defecto)'}`;
    $('#pValor').value = defecto ? S.com.porcentaje_defecto : v.porcentaje;
    $('#btnQuitarPct').hidden = defecto || !v.porcentaje_propio;
    $('#errPct').hidden = true; $('#dlgPct').showModal();
}

async function guardarPct(ev, quitar = false) {
    ev?.preventDefault();
    const err = $('#errPct'), valor = $('#pValor').value === '' ? NaN : Number($('#pValor').value);
    if (!quitar && !(valor >= 0 && valor <= 100)) { err.textContent = 'Escribe un porcentaje entre 0 y 100.'; err.hidden = false; return; }
    try {
        await api(API, { accion: 'com_config', vendedor: S.pct, porcentaje: quitar ? null : valor });
        $('#dlgPct').close(); aviso('Porcentaje guardado.'); cargarComisiones();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
}

function abrirPago(vendedor) {
    const v = S.com.vendedores.find((x) => x.vendedor === vendedor);
    S.pago = vendedor;
    $('#pagoSub').textContent = `${vendedor} · ${S.mes} · pendiente ${usd(v.pendiente_usd)}`;
    $('#cMonto').value = v.pendiente_usd; $('#cMonto').max = v.pendiente_usd;
    $('#errPago').hidden = true; $('#dlgPagoCom').showModal();
}

async function guardarPago(ev) {
    ev.preventDefault();
    const err = $('#errPago'), monto = Number($('#cMonto').value);
    if (!(monto > 0)) { err.textContent = 'Indica un monto mayor que cero.'; err.hidden = false; return; }
    const btn = ev.submitter; if (btn) btn.disabled = true;
    try {
        await api(API, { accion: 'com_pagar', mes: S.mes, vendedor: S.pago, monto_usd: monto });
        $('#dlgPagoCom').close(); aviso('Pago de comisión registrado.');
        cargar();                       // refresca también egresos y finanzas
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { if (btn) btn.disabled = false; }
}

async function cargar() {
    cargarComisiones();
    try {
        const d = await api(`${API}?mes=${S.mes}`);
        Object.assign(S, { ventas: d.ventas, egresos: d.egresos, costo: d.costo_ventas, cats: d.categorias, verV: PAGINA, verE: PAGINA });
        const metodos = new Set(S.ventas.flatMap((f) => [f.metodo_pago, ...(f.pagos_combinados || []).map((x) => x.metodo)]));
        llenar($('#fMetodo'), Object.keys(METODOS).filter((m) => metodos.has(m)), nm);
        llenar($('#fVendedor'), [...new Set(S.ventas.map((f) => f.vendedor))].sort());
        llenar($('#fCat'), S.cats);
        pintar();
    } catch (e) { aviso(e.message, true); }
}

function cambiarTab(id) {
    for (const [t, p] of [['Ventas', 'panVentas'], ['Egresos', 'panEgresos'], ['Finanzas', 'panFinanzas'], ['Comisiones', 'panComisiones']]) {
        $(`#tab${t}`).setAttribute('aria-selected', String(t === id));
        $(`#${p}`).hidden = t !== id;
    }
}

//--- NUEVO / ELIMINAR EGRESO ---//
async function guardarEgreso(ev) {
    ev.preventDefault();
    const err = $('#errEg'), monto = Number($('#eMonto').value);
    const error = (m) => { err.textContent = m; err.hidden = false; };
    if (!$('#eFecha').value) return error('Indica la fecha.');
    if ($('#eDesc').value.trim().length < 3) return error('Describe el egreso (mínimo 3 caracteres).');
    if (!(monto > 0)) return error('Indica un monto mayor que cero.');
    try {
        await api(API, { accion: 'egreso_crear', fecha: $('#eFecha').value, categoria: $('#eCat').value, descripcion: $('#eDesc').value, proveedor: $('#eProv').value, monto_usd: monto });
        $('#dlgEgreso').close();
        aviso('Egreso registrado.');
        cargar();
    } catch (e) { error(e.message); }
}

(async () => {
    const usuario = await Auth.listo;
    if (!usuario) return;
    if (!Auth.tieneNivel('admin')) return location.replace('../../index.html');

    const mes = $('#fMes');
    mes.value = S.mes; mes.max = S.mes;
    mes.addEventListener('change', () => { if (mes.value) { S.mes = mes.value; cargar(); } });
    document.addEventListener('factura:anulada', cargar);   // una factura anulada sale de ventas, KPIs y finanzas
    $('#tabVentas').addEventListener('click', () => cambiarTab('Ventas'));
    $('#tabEgresos').addEventListener('click', () => cambiarTab('Egresos'));
    $('#tabFinanzas').addEventListener('click', () => cambiarTab('Finanzas'));
    $('#tabComisiones').addEventListener('click', () => cambiarTab('Comisiones'));
    $('#btnDefecto').addEventListener('click', () => S.com && abrirPct('*'));
    $('#formPct').addEventListener('submit', (ev) => guardarPct(ev));
    $('#btnQuitarPct').addEventListener('click', () => guardarPct(null, true));
    $('#formPagoCom').addEventListener('submit', guardarPago);
    for (const d of ['#dlgPct', '#dlgPagoCom']) $(`${d} [data-cerrar]`).addEventListener('click', () => $(d).close());
    $('#filasC').addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-accion]');
        if (!b || !S.com) return;
        if (b.dataset.accion === 'pct') abrirPct(b.dataset.v); else abrirPago(b.dataset.v);
    });
    for (const id of ['#fBuscar', '#fMetodo', '#fVendedor']) $(id).addEventListener('input', () => { S.verV = PAGINA; pintarVentas(); });
    for (const id of ['#fBuscarE', '#fCat']) $(id).addEventListener('input', () => { S.verE = PAGINA; pintarEgresos(); });
    $('#masV').addEventListener('click', () => { S.verV += PAGINA; pintarVentas(); });
    $('#masE').addEventListener('click', () => { S.verE += PAGINA; pintarEgresos(); });

    $('#btnEgreso').addEventListener('click', () => {
        $('#formEgreso').reset(); $('#errEg').hidden = true;
        llenar($('#eCat'), S.cats); $('#eCat').value = S.cats[0] || '';
        $('#eFecha').value = hoy(); $('#dlgEgreso').showModal();
    });
    $('#formEgreso').addEventListener('submit', guardarEgreso);
    $('#dlgEgreso [data-cerrar]').addEventListener('click', () => $('#dlgEgreso').close());
    $('#filasE').addEventListener('click', async (ev) => {
        const b = ev.target.closest('button[data-id]');
        if (!b || !confirm('¿Eliminar este egreso? Esta acción no se puede deshacer.')) return;
        try { await api(API, { accion: 'egreso_eliminar', id: Number(b.dataset.id) }); aviso('Egreso eliminado.'); cargar(); }
        catch (e) { aviso(e.message, true); }
    });

    await cargar();
    document.body.classList.add('is-ready');
})();
