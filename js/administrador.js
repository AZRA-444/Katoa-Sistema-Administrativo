import { usd } from './utils/format.js';
import { apiJson as api, urlComprobanteEgreso } from './utils/api.js';

const API = '/api/administrador';
const TZ = 'America/Caracas';
const PAGINA = 100;
const METODOS = {
    PM: 'Pago móvil', PVD: 'Punto débito', PVC: 'Punto crédito', ED: 'Efectivo $', EBS: 'Efectivo Bs',
    ZELLE: 'Zelle', BINANCE: 'Binance', OTROS: 'Otros', MIXTO: 'Pago combinado', CREDITO: 'Crédito (fiado)',
};
// Resultado del envío del comprobante por WhatsApp: [mensaje, es_error]
const AVISOS_WA = {
    enviado: ['El comprobante se envió por WhatsApp.', false],
    sin_whatsapp: ['Ese número no tiene WhatsApp. Imprime el comprobante en formato carta.', true],
    no_disponible: ['No se pudo enviar por WhatsApp en este momento. Inténtalo de nuevo o imprime el comprobante.', true],
    no_configurado: ['El envío por WhatsApp no está configurado en el servidor.', true],
};
const REF_OBLIGATORIA = new Set(['Pago móvil', 'Transferencia', 'Zelle', 'Binance']);   // igual que api/_egresos.py
const TEL_RE = /^\+?\d{10,15}$/;
const normTel = (v) => String(v || '').replace(/[\s\-().]/g, '');
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, ...hijos) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...hijos); return n; };
const nm = (m) => METODOS[m] || m || '—';
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const dia = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const fechaHora = (iso) => new Date(iso).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ });
const fechaDia = (d) => d.split('-').reverse().join('/');
const suma = (a, f) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);

const S = { mes: hoy().slice(0, 7), ventas: [], egresos: [], costo: null, cats: [], metodos: [], opc: { categorias: [], metodos: [] }, comp: null, verV: PAGINA, verE: PAGINA, com: null, pct: null, pago: null, usr: null };
let avisoT;

function aviso(msg, error = false) {
    const n = $('#aviso');
    n.textContent = msg; n.hidden = false; n.style.background = error ? 'var(--danger)' : '';
    clearTimeout(avisoT); avisoT = setTimeout(() => (n.hidden = true), 4500);
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
    const v = ventasFiltradas(), total = suma(v, (f) => f.total_usd), lista = suma(v, (f) => f.lista_usd ?? f.total_usd), porDia = agrupar(v, (f) => dia(f.fecha), (f) => f.total_usd);
    const mejor = ordenado(porDia)[0];
    kpis($('#kVentas'), [
        ['Ventas (cobrado)', usd(total), lista > total ? `Lista ${usd(lista)} · descuento por divisas ${usd(lista - total)}` : 'Con descuento por divisas'],
        ['Facturas', String(v.length)],
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
function btnEgreso(accion, icono, titulo, id) {
    const b = el('button', { type: 'button', className: 'btn btn-ghost btn-mini', title: titulo, ariaLabel: titulo }, el('i', { className: icono }));
    b.dataset.accion = accion; b.dataset.id = id;
    return b;
}
/** Fila de egreso. `acciones`: en la pestaña Egresos añade método, comprobante (imprimir / WhatsApp) y eliminar. */
function filaEgreso(e, acciones) {
    const celdas = [el('td', { textContent: fechaDia(e.fecha) }), el('td', {}, el('span', { className: 'pill', textContent: e.categoria })),
        el('td', {}, e.descripcion, e.proveedor ? el('span', { className: 'sub', textContent: e.proveedor }) : '')];
    if (acciones) {
        celdas.push(el('td', {}, e.metodo_pago ? el('span', { className: 'pill', textContent: e.metodo_pago }) : '—',
            e.referencia ? el('span', { className: 'sub', textContent: `Ref. ${e.referencia}` }) : '',
            e.comprobante_whatsapp === 'enviado'
                ? el('span', { className: 'sub ok', title: e.comprobante_enviado_en ? `Enviado el ${fechaHora(e.comprobante_enviado_en)}` : '' },
                    el('i', { className: 'fab fa-whatsapp' }), ' Comprobante enviado') : ''));
    }
    celdas.push(el('td', { className: 'n', textContent: usd(e.monto_usd) }));
    if (acciones) {
        celdas.push(el('td', { className: 'c acciones' },
            btnEgreso('imprimir', 'fas fa-print', 'Ver e imprimir el comprobante', e.id), ' ',
            btnEgreso('wa', 'fab fa-whatsapp', 'Enviar el comprobante por WhatsApp', e.id), ' ',
            btnEgreso('borrar', 'fas fa-trash', 'Eliminar egreso', e.id)));
    }
    return el('tr', {}, ...celdas);
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
        ['Ingresos (ventas cobradas)', usd(ingresos), `${S.ventas.length} facturas · cobrado y fiado`], ['Gastos totales', usd(costo + egresos), 'Mercancía + egresos'],
        ['Ganancia neta', usd(neta), '', neta >= 0 ? 'pos' : 'neg'], ['Margen neto', `${margen.toFixed(1)} %`, '', neta >= 0 ? 'pos' : 'neg'],
    ]);
    const fila = (t, v, clase = '', nota = '') => el('div', { className: clase }, el('span', {}, t, nota ? el('small', { textContent: nota }) : ''), el('strong', { textContent: usd(v) }));
    $('#estado').replaceChildren(
        fila('Ingresos por ventas', ingresos, '', 'Lo cobrado y lo fiado, con descuento por pago en divisas'),
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
        Object.assign(S, { ventas: d.ventas, egresos: d.egresos, costo: d.costo_ventas, cats: d.categorias, metodos: d.metodos || [], opc: d.opciones || { categorias: [], metodos: [] }, verV: PAGINA, verE: PAGINA });
        const metodos = new Set(S.ventas.flatMap((f) => [f.metodo_pago, ...(f.pagos_combinados || []).map((x) => x.metodo)]));
        llenar($('#fMetodo'), Object.keys(METODOS).filter((m) => metodos.has(m)), nm);
        llenar($('#fVendedor'), [...new Set(S.ventas.map((f) => f.vendedor))].sort());
        // También las categorías quitadas que todavía tienen egresos este mes: si no, no se podrían filtrar.
        llenar($('#fCat'), [...new Set([...S.cats, ...S.egresos.map((e) => e.categoria)])]);
        pintar();
    } catch (e) { aviso(e.message, true); }
}

function cambiarTab(id) {
    for (const [t, p] of [['Ventas', 'panVentas'], ['Egresos', 'panEgresos'], ['Finanzas', 'panFinanzas'], ['Comisiones', 'panComisiones'], ['Usuarios', 'panUsuarios']]) {
        $(`#tab${t}`).setAttribute('aria-selected', String(t === id));
        $(`#${p}`).hidden = t !== id;
    }
    if (id === 'Usuarios') cargarUsuarios();
}

//--- USUARIOS ---//
const ROLES = { personal: 'Personal', encargado: 'Encargado', admin: 'Administrador', sysadmin: 'Sysadmin' };

async function cargarUsuarios() {
    try { S.usr = await api(`${API}?modo=usr_lista`); pintarUsuarios(); }
    catch (e) { aviso(e.message, true); }
}

function pintarUsuarios() {
    const u = S.usr.usuarios;
    $('#contU').textContent = u.length;
    $('#vacioU').hidden = u.length > 0;
    $('#filasU').closest('.table-wrap').hidden = !u.length;
    // Solo se puede actuar sobre quien tiene un rol que tú podrías asignar, y nunca sobre uno mismo (el servidor lo exige igual).
    const gestionable = (x) => x.id !== S.usr.yo && S.usr.roles.includes(String(x.rol || '').toLowerCase());
    const boton = (accion, icono, texto, x) => {
        const b = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', title: texto }, el('i', { className: `fas ${icono}` }), ` ${texto}`);
        b.dataset.accion = accion; b.dataset.id = x.id;
        return b;
    };
    $('#filasU').replaceChildren(...u.map((x) => el('tr', { className: x.activo ? '' : 'inactivo' },
        el('td', { textContent: x.nombre || '—' }),
        el('td', { textContent: x.email || '—' }),
        el('td', {}, el('span', { className: 'pill', textContent: ROLES[x.rol] || x.rol || '—' })),
        el('td', {}, x.activo ? 'Activo' : 'Inactivo',
            x.debe_cambiar_clave ? el('span', { className: 'sub', textContent: 'Pendiente de cambiar su clave' }) : ''),
        el('td', { className: 'acciones' }, ...(gestionable(x) ? [
            boton('rol', 'fa-user-gear', 'Rol', x),
            boton('clave', 'fa-key', 'Clave', x),
            boton('estado', x.activo ? 'fa-user-slash' : 'fa-user-check', x.activo ? 'Desactivar' : 'Reactivar', x),
        ] : [el('span', { className: 'sub', textContent: x.id === S.usr.yo ? 'Tu cuenta' : '' })])))));
}

/** Llama a una acción de gestión de usuarios y refresca la lista. Devuelve la respuesta o null si falló (ya avisó). */
async function gestionarUsuario(cuerpo) {
    try {
        const d = await api(API, cuerpo);
        aviso(d.message || 'Listo.');
        cargarUsuarios();
        return d;
    } catch (e) { aviso(e.message, true); return null; }
}

function abrirRol(x) {
    const permitidos = S.usr.roles.filter((r) => r !== String(x.rol || '').toLowerCase());
    if (!permitidos.length) return aviso('No hay otro rol que puedas asignar.', true);
    $('#rolSub').textContent = `${x.nombre || x.email} · rol actual: ${ROLES[x.rol] || x.rol}`;
    $('#rolNuevo').replaceChildren(...permitidos.map((r) => el('option', { value: r, textContent: ROLES[r] || r })));
    $('#dlgRol').dataset.id = x.id;
    $('#dlgRol').showModal();
}

async function accionUsuario(b) {
    const x = S.usr.usuarios.find((y) => y.id === b.dataset.id);
    if (!x) return;
    const quien = x.nombre || x.email;
    if (b.dataset.accion === 'rol') return abrirRol(x);
    if (b.dataset.accion === 'estado') {
        const activar = !x.activo;
        if (!confirm(activar ? `¿Reactivar a ${quien}? Podrá volver a entrar al sistema.`
            : `¿Desactivar a ${quien}? Dejará de poder usar el sistema de inmediato (su historial se conserva).`)) return;
        return gestionarUsuario({ accion: 'usuario_estado', id: x.id, activo: activar });
    }
    if (b.dataset.accion === 'clave') {
        if (!confirm(`¿Restablecer la clave de ${quien}? Se genera una clave temporal y sus sesiones abiertas dejan de servir hasta que la cambie.`)) return;
        const d = await gestionarUsuario({ accion: 'usuario_clave', id: x.id });
        if (d) {
            $('#hClave').textContent = 'Clave restablecida';
            $('#claveSub').textContent = `${d.usuario.nombre} · ${ROLES[d.usuario.rol] || d.usuario.rol}`;
            $('#claveTmp').value = d.usuario.clave_temporal;
            $('#dlgClave').showModal();
        }
    }
}

async function guardarRol(ev) {
    ev.preventDefault();
    const dlg = $('#dlgRol'), btn = ev.submitter; if (btn) btn.disabled = true;
    const d = await gestionarUsuario({ accion: 'usuario_rol', id: dlg.dataset.id, rol: $('#rolNuevo').value });
    if (btn) btn.disabled = false;
    if (d) dlg.close();
}

function abrirUsuario() {
    if (!S.usr) return;
    if (!S.usr.roles.length) return aviso('No tienes permiso para registrar usuarios.', true);
    $('#formUsuario').reset(); $('#errUsr').hidden = true;
    $('#uRol').replaceChildren(...S.usr.roles.map((r) => el('option', { value: r, textContent: ROLES[r] || r })));
    $('#uRol').value = S.usr.roles[0];
    $('#dlgUsuario').showModal();
}

async function guardarUsuario(ev) {
    ev.preventDefault();
    const err = $('#errUsr'), nombre = $('#uNombre').value.trim(), email = $('#uEmail').value.trim();
    const error = (m) => { err.textContent = m; err.hidden = false; };
    if (nombre.length < 2) return error('Escribe el nombre (mínimo 2 caracteres).');
    if (!$('#uEmail').checkValidity() || !email) return error('Escribe un correo válido.');
    const btn = ev.submitter; if (btn) btn.disabled = true;
    try {
        const d = await api(API, { accion: 'usuario_crear', nombre, email, rol: $('#uRol').value });
        $('#dlgUsuario').close();
        $('#claveSub').textContent = `${d.usuario.nombre} · ${d.usuario.email} · ${ROLES[d.usuario.rol] || d.usuario.rol}`;
        $('#claveTmp').value = d.usuario.clave_temporal;
        $('#hClave').textContent = 'Usuario registrado';
        $('#dlgClave').showModal();
        cargarUsuarios();
    } catch (e) { error(e.message); }
    finally { if (btn) btn.disabled = false; }
}

async function copiarClave() {
    const campo = $('#claveTmp');
    try { await navigator.clipboard.writeText(campo.value); aviso('Clave copiada.'); }
    catch { campo.select(); aviso('Selecciona y copia la clave manualmente.', true); }
}

//--- NUEVO / ELIMINAR EGRESO ---//
function actualizarRef() {
    const obligatoria = REF_OBLIGATORIA.has($('#eMetodo').value);
    $('#eRefNota').textContent = obligatoria ? '' : '(opcional)';   // si es obligatoria, ya lo marca el asterisco
    $('#eRef').required = obligatoria;
}
function actualizarEnviar() {
    const hay = $('#eTel').value.trim() !== '', caja = $('#eEnviar');
    caja.disabled = !hay;
    if (!hay) { caja.checked = false; delete caja.dataset.tocado; }
    else if (!caja.dataset.tocado) { caja.checked = true; caja.dataset.tocado = '1'; }   // al escribir el número se marca solo
}
/** Rellena los selectores del formulario sin perder lo elegido (o eligiendo lo recién creado). */
function llenarSelectoresEgreso(cat, metodo) {
    const c0 = cat ?? $('#eCat').value, m0 = metodo ?? $('#eMetodo').value;
    llenar($('#eCat'), S.cats); llenar($('#eMetodo'), S.metodos);
    $('#eCat').value = S.cats.includes(c0) ? c0 : (S.cats[0] || '');
    $('#eMetodo').value = S.metodos.includes(m0) ? m0 : '';
    actualizarRef();
}
function abrirEgreso() {
    $('#formEgreso').reset(); $('#errEg').hidden = true;
    delete $('#eEnviar').dataset.tocado; actualizarEnviar();
    llenarSelectoresEgreso(S.cats[0] || '', '');
    $('#eFecha').value = hoy(); $('#dlgEgreso').showModal();
}
async function guardarEgreso(ev) {
    ev.preventDefault();
    const err = $('#errEg'), monto = Number($('#eMonto').value);
    const error = (m) => { err.textContent = m; err.hidden = false; };
    err.hidden = true;
    const metodo = $('#eMetodo').value, ref = $('#eRef').value.trim(), tel = normTel($('#eTel').value);
    if (!$('#eFecha').value) return error('Indica la fecha.');
    if ($('#eDesc').value.trim().length < 3) return error('Describe el egreso (mínimo 3 caracteres).');
    if (!(monto > 0)) return error('Indica un monto mayor que cero.');
    if (!metodo) return error('Elige el método de pago.');
    if (REF_OBLIGATORIA.has(metodo) && !ref) return error(`Con ${metodo} la referencia es obligatoria.`);
    if (tel && !TEL_RE.test(tel)) return error('Teléfono inválido: solo números, de 10 a 15 dígitos.');
    const btn = ev.submitter; if (btn) btn.disabled = true;   // evita guardar (y enviar el WhatsApp) dos veces
    try {
        const d = await api(API, {
            accion: 'egreso_crear', fecha: $('#eFecha').value, categoria: $('#eCat').value, descripcion: $('#eDesc').value,
            proveedor: $('#eProv').value, monto_usd: monto, metodo_pago: metodo, referencia: ref, telefono: tel,
            enviar_whatsapp: !!tel && $('#eEnviar').checked,
        });
        $('#dlgEgreso').close();
        cargar();
        abrirComprobante(d.id, d.whatsapp, tel);
    } catch (e) { error(e.message); }
    finally { if (btn) btn.disabled = false; }
}

//--- COMPROBANTE (imprimir / WhatsApp) ---//
function mensajeComp(texto, error = false) {
    const p = $('#compMsg'); p.textContent = texto; p.classList.toggle('msg-error', error);
}
function abrirComprobante(id, estado, tel) {
    S.comp = { id, tel };
    const [msg, error] = estado ? (AVISOS_WA[estado] ?? AVISOS_WA.no_disponible) : ['', false];
    mensajeComp(`El egreso quedó registrado. ${msg || 'Imprime el comprobante o envíalo por WhatsApp.'}`, error);
    $('#dlgComp').showModal();
}
const imprimirComprobante = (id) => window.open(urlComprobanteEgreso(id), '_blank', 'noopener');
function abrirWa(id, tel) {
    S.comp = { id, tel };
    const e = S.egresos.find((x) => x.id === id);
    $('#waSub').textContent = e ? `${e.proveedor || e.descripcion} · ${usd(e.monto_usd)}` : `Egreso ${id}`;
    $('#wTel').value = tel || ''; $('#errWa').hidden = true;
    $('#dlgWa').showModal();
}
async function enviarWa(ev) {
    ev.preventDefault();
    const err = $('#errWa'), tel = normTel($('#wTel').value);
    if (!TEL_RE.test(tel)) { err.textContent = 'Teléfono inválido: solo números, de 10 a 15 dígitos.'; err.hidden = false; return; }
    const btn = ev.submitter; if (btn) btn.disabled = true;
    try {
        const d = await api(API, { accion: 'egreso_comprobante_enviar', id: S.comp.id, telefono: tel });
        const [msg, error] = AVISOS_WA[d.whatsapp] ?? AVISOS_WA.no_disponible;
        $('#dlgWa').close();
        if ($('#dlgComp').open) mensajeComp(msg, error); else aviso(msg, error);
        cargar();   // el egreso queda marcado como «Comprobante enviado» y con el teléfono guardado
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { if (btn) btn.disabled = false; }
}

//--- CATEGORÍAS Y MÉTODOS PERSONALIZADOS ---//
const OPC = { categoria: { lista: 'categorias', chips: '#chipsCat', lista_s: 'cats' }, metodo: { lista: 'metodos', chips: '#chipsMet', lista_s: 'metodos' } };
function pintarOpciones() {
    for (const [tipo, cfg] of Object.entries(OPC)) {
        $(cfg.chips).replaceChildren(...S.opc[cfg.lista].map((o) => {
            const chip = el('span', { className: `chip${o.id ? ' propia' : ''}`, title: o.id ? 'Personalizada' : 'De fábrica' }, o.nombre);
            if (o.id) {
                const x = el('button', { type: 'button', className: 'chip-x', title: `Quitar ${o.nombre}`, ariaLabel: `Quitar ${o.nombre}` }, el('i', { className: 'fas fa-xmark' }));
                x.dataset.id = o.id; x.dataset.tipo = tipo;
                chip.append(x);
            }
            return chip;
        }));
    }
}
function abrirOpciones() { $('#errOpc').hidden = true; pintarOpciones(); $('#dlgOpc').showModal(); }
async function agregarOpcion(ev) {
    ev.preventDefault();
    const form = ev.currentTarget, tipo = form.dataset.tipo, input = $('input', form), err = $('#errOpc');
    const nombre = input.value.trim().replace(/\s+/g, ' ');
    const error = (m) => { err.textContent = m; err.hidden = false; };
    err.hidden = true;
    if (nombre.length < 2) return error('Escribe un nombre de al menos 2 caracteres.');
    const btn = ev.submitter; if (btn) btn.disabled = true;
    try {
        const d = await api(API, { accion: 'egreso_opcion_crear', tipo, nombre });
        const cfg = OPC[tipo];
        S.opc[cfg.lista].push({ nombre, id: d.id }); S[cfg.lista_s].push(nombre);
        input.value = ''; pintarOpciones();
        // Si el formulario de egreso está debajo, deja elegida la opción nueva.
        llenarSelectoresEgreso(tipo === 'categoria' ? nombre : undefined, tipo === 'metodo' ? nombre : undefined);
        aviso(`«${nombre}» agregada.`);
    } catch (e) { error(e.message); }
    finally { if (btn) btn.disabled = false; }
}
async function quitarOpcion(x) {
    const cfg = OPC[x.dataset.tipo], id = Number(x.dataset.id), op = S.opc[cfg.lista].find((o) => o.id === id);
    if (!op || !confirm(`¿Quitar «${op.nombre}»? Los egresos que ya la usan no cambian; solo dejará de ofrecerse al registrar nuevos.`)) return;
    try {
        await api(API, { accion: 'egreso_opcion_quitar', id });
        S.opc[cfg.lista] = S.opc[cfg.lista].filter((o) => o.id !== id); S[cfg.lista_s] = S[cfg.lista_s].filter((n) => n !== op.nombre);
        pintarOpciones(); llenarSelectoresEgreso();
        $('#errOpc').hidden = true;
    } catch (e) { $('#errOpc').textContent = e.message; $('#errOpc').hidden = false; }
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
    $('#tabUsuarios').addEventListener('click', () => cambiarTab('Usuarios'));
    $('#btnUsuario').addEventListener('click', abrirUsuario);
    $('#formUsuario').addEventListener('submit', guardarUsuario);
    $('#filasU').addEventListener('click', (e) => { const b = e.target.closest('button[data-accion]'); if (b) accionUsuario(b); });
    $('#formRol').addEventListener('submit', guardarRol);
    $('#dlgRol [data-cerrar]').addEventListener('click', () => $('#dlgRol').close());
    $('#dlgUsuario [data-cerrar]').addEventListener('click', () => $('#dlgUsuario').close());
    $('#btnCopiarClave').addEventListener('click', copiarClave);
    // La clave solo se ve una vez: Esc no cierra el diálogo por accidente; se cierra con «Ya la copié».
    $('#dlgClave').addEventListener('cancel', (ev) => ev.preventDefault());
    $('#dlgClave').addEventListener('close', () => { $('#claveTmp').value = ''; });
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

    $('#btnEgreso').addEventListener('click', abrirEgreso);
    $('#formEgreso').addEventListener('submit', guardarEgreso);
    $('#dlgEgreso [data-cerrar]').addEventListener('click', () => $('#dlgEgreso').close());
    $('#eMetodo').addEventListener('change', actualizarRef);
    $('#eTel').addEventListener('input', actualizarEnviar);
    $('#btnOpciones').addEventListener('click', abrirOpciones);
    $('#btnOpc2').addEventListener('click', abrirOpciones);
    for (const f of document.querySelectorAll('.opc-add')) f.addEventListener('submit', agregarOpcion);
    $('#dlgOpc').addEventListener('click', (ev) => { const x = ev.target.closest('.chip-x'); if (x) quitarOpcion(x); });
    $('#compImprimir').addEventListener('click', () => S.comp && imprimirComprobante(S.comp.id));
    $('#compWa').addEventListener('click', () => S.comp && abrirWa(S.comp.id, S.comp.tel));
    $('#formWa').addEventListener('submit', enviarWa);
    for (const d of ['#dlgOpc', '#dlgComp', '#dlgWa']) $(`${d} [data-cerrar]`).addEventListener('click', () => $(d).close());
    $('#filasE').addEventListener('click', async (ev) => {
        const b = ev.target.closest('button[data-accion]');
        if (!b) return;
        const id = Number(b.dataset.id), e = S.egresos.find((x) => x.id === id);
        if (b.dataset.accion === 'imprimir') return imprimirComprobante(id);
        if (b.dataset.accion === 'wa') return abrirWa(id, e?.beneficiario_telefono || '');
        // Borrado lógico: el egreso deja de contarse pero queda registrado quién y cuándo lo eliminó.
        const motivo = prompt('¿Eliminar este egreso? Quedará registrado quién lo eliminó y cuándo.\n\nMotivo (opcional):', '');
        if (motivo === null) return;
        try { await api(API, { accion: 'egreso_eliminar', id, motivo: motivo.trim() }); aviso('Egreso eliminado (queda en el registro de auditoría).'); cargar(); }
        catch (err) { aviso(err.message, true); }
    });

    await cargar();
    document.body.classList.add('is-ready');
})();
