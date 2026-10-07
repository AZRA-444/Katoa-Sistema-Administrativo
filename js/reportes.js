import { obtenerReporte, obtenerSecciones, urlPdfFactura, reenviarWhatsapp } from './utils/api.js';
import { usd, bs, entero, porcentaje, hoyISO, sumarDias, fechaHora, soloHora, fechaISO, telefonoE164 } from './utils/format.js';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
function el(tag, props = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) (k in n && k !== 'list' ? (n[k] = v) : n.setAttribute(k, v));
    n.append(...hijos);
    return n;
}

const TIPOS_KARDEX = {
    REGISTRO: 'Registro de producto', LLEGADA: 'Llegada de mercancía', SALIDA_VENTA: 'Venta',
    SALIDA_OTRO: 'Salida por otro motivo', AJUSTE_ENTRADA: 'Ajuste de entrada', AJUSTE_SALIDA: 'Ajuste de salida',
    DEVOLUCION_CLIENTE: 'Devolución de cliente', DEVOLUCION_PROVEEDOR: 'Devolución a proveedor',
};
const METODOS = [
    ['ED', 'Efectivo en dólares'], ['EBS', 'Efectivo en bolívares'], ['PM', 'Pago móvil'], ['PVD', 'Punto de venta (débito)'],
    ['PVC', 'Punto de venta (crédito)'], ['ZELLE', 'Zelle'], ['BINANCE', 'Binance (USDT)'], ['OTROS', 'Otros'], ['MIXTO', 'Pago combinado'],
];
const PRESETS = [['hoy', 'Hoy'], ['ayer', 'Ayer'], ['7d', '7 días'], ['30d', '30 días'], ['mes', 'Este mes'], ['mespasado', 'Mes pasado']];
const DIAS_OPCIONES = [['15', '15 días'], ['30', '30 días'], ['60', '60 días'], ['90', '90 días'], ['180', '6 meses'], ['365', '1 año']];
const MONEDA = { USD: usd, BS: bs };
const NUMERICOS = ['usd', 'bs', 'num', 'pct'];
const FMT = {
    usd: (v) => (v == null ? '—' : usd(v)), bs: (v) => (v == null ? '—' : bs(v)),
    num: (v) => (v == null ? '—' : entero(v)), pct: (v) => (v == null ? '—' : porcentaje(v)),
    fecha: (v) => (v ? fechaISO(v) : '—'), fechaHora: (v) => fechaHora(v), hora: (v) => soloHora(v),
    txt: (v) => (v == null || v === '' ? '—' : String(v)),
};

const state = { tab: 'cierre', vals: {}, meta: null, tablas: [], seq: 0, vendedores: null, secciones: null, factura: null };
let avisoT, buscarT;

//--- UTILIDADES ---//
function aviso(msg, error = false) {
    const n = $('#aviso');
    n.textContent = msg; n.hidden = false;
    n.classList.toggle('error', error);
    clearTimeout(avisoT); avisoT = setTimeout(() => (n.hidden = true), error ? 7000 : 4500);
}
$('#aviso').addEventListener('click', (e) => (e.currentTarget.hidden = true));

function rangoPreset(id) {
    const h = hoyISO(), ini = h.slice(0, 8) + '01';
    switch (id) {
        case 'ayer': { const a = sumarDias(h, -1); return [a, a]; }
        case '7d': return [sumarDias(h, -6), h];
        case '30d': return [sumarDias(h, -29), h];
        case 'mes': return [ini, h];
        case 'mespasado': { const fin = sumarDias(ini, -1); return [fin.slice(0, 8) + '01', fin]; }
        default: return [h, h];
    }
}
const plural = (n, uno, varios) => `${entero(n)} ${n === 1 ? uno : varios}`;
const nombreFiltro = (lista, valor) => (lista.find(([k]) => k === valor) || [])[1];

//--- BLOQUES DE PANTALLA ---//
function kpis(items) {
    return el('div', { className: 'kpis' }, ...items.filter(Boolean).map((k) =>
        el('div', { className: 'kpi' + (k.tono ? ' ' + k.tono : '') },
            el('span', { className: 'kpi-t', textContent: k.t }), el('span', { className: 'kpi-v', textContent: k.v }),
            k.s ? el('span', { className: 'kpi-s', textContent: k.s }) : '')));
}
function sec(titulo, sub, ...nodos) {
    return el('section', { className: 'rep-sec' }, el('h3', { textContent: titulo }), sub ? el('p', { className: 'sub', textContent: sub }) : '', ...nodos);
}
const nota = (texto) => el('p', { className: 'nota-rep', textContent: texto });
const vacio = (texto) => el('p', { className: 'empty-inline', textContent: texto });

/** Columna: { t, k, m (usd|bs|num|pct|fecha|fechaHora|hora|txt), f (nodo o texto propio), v (valor para CSV), n (alinear a la derecha), titulo, sinCsv } */
const numerica = (c) => c.n ?? NUMERICOS.includes(c.m);
const FECHAS = ['fecha', 'fechaHora', 'hora'];
const valorCsv = (c, r) => (c.v ? c.v(r) : FECHAS.includes(c.m) ? FMT[c.m](r[c.k]) : r[c.k] ?? '');

function tabla(titulo, cols, filas, { sinDatos = 'Sin datos para este período.', pie } = {}) {
    state.tablas.push({
        titulo, cols: cols.filter((c) => !c.sinCsv).map((c) => c.t),
        filas: filas.map((r) => cols.filter((c) => !c.sinCsv).map((c) => valorCsv(c, r))),
    });
    if (!filas.length) return vacio(sinDatos);
    const celdaDe = (c, r) => {
        const td = el('td', { className: [numerica(c) ? 'n' : '', c.titulo ? 'celda-titulo' : '', c.cls || ''].filter(Boolean).join(' ') });
        td.setAttribute('data-label', c.t);
        const contenido = c.f ? c.f(r) : FMT[c.m || 'txt'](r[c.k]);
        td.append(contenido);
        return td;
    };
    const t = el('table', { className: 'tabla-resp' },
        el('caption', { className: 'sr-only', textContent: titulo }),
        el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { scope: 'col', className: [numerica(c) ? 'n' : '', c.sinCsv ? 'acciones-col' : ''].filter(Boolean).join(' '), textContent: c.t })))),
        el('tbody', {}, ...filas.map((r) => el('tr', {}, ...cols.map((c) => celdaDe(c, r))))));
    if (pie) {
        t.append(el('tfoot', {}, el('tr', {}, ...cols.map((c, i) => {
            const td = el('td', { className: numerica(c) ? 'n' : '', textContent: pie[i] ?? '' });
            td.setAttribute('data-label', c.t);
            return td;
        }))));
    }
    return el('div', { className: 'table-wrap' + (filas.length > 25 ? ' largo' : '') }, t);
}
const suma = (filas, k) => filas.reduce((a, r) => a + (Number(r[k]) || 0), 0);

/** Barras horizontales: {etq, valor, texto}. La barra es decorativa; el texto lleva la cifra. */
function barras(items) {
    const max = Math.max(...items.map((i) => i.valor), 0) || 1;
    return el('ul', { className: 'barras' }, ...items.map((i) => el('li', {},
        el('span', { className: 'b-etq', textContent: i.etq, title: i.etq }),
        el('span', { className: 'b-pista', 'aria-hidden': 'true' }, el('span', { className: 'b-fill', style: `width:${Math.max((i.valor / max) * 100, 1)}%` })),
        el('span', { className: 'b-val', textContent: i.texto }))));
}
/** Columnas verticales (la tabla de al lado tiene los mismos datos, por eso es decorativa). */
function columnas(items, etqIni, etqFin) {
    const max = Math.max(...items.map((i) => i.valor), 0) || 1;
    return el('div', { className: 'cols-wrap', 'aria-hidden': 'true' },
        el('div', { className: 'cols' }, ...items.map((i) => el('div', { className: 'col', title: i.tip },
            el('span', { style: `height:${Math.max((i.valor / max) * 100, 1)}%` })))),
        el('div', { className: 'cols-eje' }, el('span', { textContent: etqIni }), el('span', { textContent: etqFin })));
}

//--- REPORTES ---//
const colMetodo = [
    { t: 'Método', k: 'etiqueta', titulo: true }, { t: 'Moneda', f: (r) => (r.moneda === 'USD' ? 'Dólares' : 'Bolívares'), v: (r) => r.moneda },
    { t: 'Facturas', k: 'facturas', m: 'num' }, { t: 'Cobrado', f: (r) => MONEDA[r.moneda](r.monto), v: (r) => r.monto, n: true },
];

function rCierre(d) {
    const s = d.resumen;
    const nodos = [kpis([
        { t: 'Facturas', v: entero(s.facturas), s: s.facturas ? `Ticket promedio ${usd(s.ticket_promedio)}` : 'Sin ventas en este período' },
        { t: 'Ventas a precio de lista', v: usd(s.lista_usd), tono: 'destacada' },
        { t: 'Cobrado en dólares', v: usd(s.cobrado_usd), s: 'Efectivo, Zelle, Binance y partes en $' },
        { t: 'Cobrado en bolívares', v: bs(s.cobrado_bs), s: 'Pago móvil, punto de venta y efectivo en Bs' },
        { t: 'Efectivo en caja ($)', v: usd(s.efectivo_usd), s: 'Para contar los dólares' },
        { t: 'Efectivo en caja (Bs)', v: bs(s.efectivo_bs), s: 'Para contar los bolívares' },
    ])];
    if (s.facturas) {
        nodos.push(nota([
            s.primera ? `Primera factura ${soloHora(s.primera)} · última ${soloHora(s.ultima)}.` : '',
            s.tasa_min != null ? (s.tasa_min === s.tasa_max ? `Tasa del período: ${bs(s.tasa_min)} por $.` : `Tasa del período: de ${bs(s.tasa_min)} a ${bs(s.tasa_max)} por $.`) : '',
            'Los dólares y los bolívares son monedas distintas: no se suman entre sí.',
        ].filter(Boolean).join(' ')));
    }
    nodos.push(sec('Por método de pago', 'Un pago combinado cuenta en cada método que usó.',
        tabla('Por método de pago', [...colMetodo, { t: 'Equivalente a precio de lista', k: 'lista_usd', m: 'usd' }], d.por_metodo,
            { sinDatos: 'No hay pagos en este período.' })));
    nodos.push(sec('Por vendedor', null, tabla('Por vendedor', [
        { t: 'Vendedor', k: 'vendedor', titulo: true }, { t: 'Facturas', k: 'facturas', m: 'num' }, { t: 'Ventas a precio de lista', k: 'lista_usd', m: 'usd' },
        { t: 'Cobrado en $', k: 'cobrado_usd', m: 'usd' }, { t: 'Cobrado en Bs', k: 'cobrado_bs', m: 'bs' },
    ], d.por_vendedor, {
        sinDatos: 'No hay ventas en este período.',
        pie: d.por_vendedor.length > 1 ? ['Total', entero(s.facturas), usd(s.lista_usd), usd(s.cobrado_usd), bs(s.cobrado_bs)] : null,
    })));
    nodos.push(sec('Conciliación: pago móvil, Zelle y Binance', 'Compara cada referencia con tu estado de cuenta o tu billetera.', tabla('Conciliación', [
        { t: 'Hora', k: 'hora', m: 'hora', v: (r) => fechaHora(r.hora) }, { t: 'Factura', k: 'id_factura', cls: 'mono' }, { t: 'Método', k: 'etiqueta' },
        { t: 'Banco', k: 'banco' }, { t: 'Referencia', k: 'referencia', cls: 'mono' }, { t: 'Monto', f: (r) => MONEDA[r.moneda](r.monto), v: (r) => r.monto, n: true },
    ], d.conciliacion, { sinDatos: 'No hubo pagos con referencia en este período.' })));
    if (d.conciliacion_total > d.conciliacion.length) nodos.push(nota(`Se muestran ${entero(d.conciliacion.length)} de ${entero(d.conciliacion_total)} pagos. Acorta el rango para ver el resto.`));
    return nodos;
}

function abrirPdf(id) { window.open(urlPdfFactura(id), '_blank', 'noopener'); }
function boton(icono, texto, fn) {
    const b = el('button', { type: 'button', title: texto });
    b.setAttribute('aria-label', texto);
    b.append(el('i', { className: icono }), el('span', { className: 'lbl', textContent: texto }));
    b.addEventListener('click', fn);
    return b;
}

function rFacturas(d) {
    const nodos = [tabla('Facturas', [
        { t: 'Fecha', k: 'creado', m: 'fechaHora' }, { t: 'Factura', k: 'id_factura', cls: 'mono' },
        { t: 'Cliente', titulo: true, f: (r) => el('div', {}, el('div', { className: 'prod-nombre', textContent: r.cliente }), el('div', { className: 'muted', textContent: [r.cedula, r.telefono].filter(Boolean).join(' · ') })), v: (r) => r.cliente },
        { t: 'Vendedor', k: 'vendedor' }, { t: 'Pago', k: 'etiqueta' },
        { t: 'Total $', k: 'total_usd', m: 'usd' }, { t: 'Total Bs', k: 'total_bs', m: 'bs' },
        { t: 'Acciones', sinCsv: true, f: (r) => el('div', { className: 'acts' }, boton('fas fa-eye', 'Ver detalle', () => verFactura(r)), boton('fas fa-print', 'Reimprimir', () => abrirPdf(r.id_factura))) },
    ], d.filas, { sinDatos: 'No se encontraron facturas con estos filtros.' })];
    if (d.truncado) nodos.push(el('p', { className: 'nota', textContent: `Se muestran las ${d.limite} más recientes. Afina la búsqueda o el rango de fechas para ver el resto.` }));
    return nodos;
}

function rVentas(d) {
    const s = d.resumen, md = s.mejor_dia;
    const nodos = [kpis([
        { t: 'Ventas a precio de lista', v: usd(s.ventas_usd), tono: 'destacada', s: `${plural(s.facturas, 'factura', 'facturas')}` },
        { t: 'Ticket promedio', v: usd(s.ticket_promedio), s: 'Por factura' },
        { t: 'Promedio por día con ventas', v: usd(s.promedio_diario), s: `${s.dias_con_ventas} de ${plural(s.dias, 'día', 'días')} con ventas` },
        md && { t: 'Mejor día', v: usd(md.ventas_usd), s: `${fechaISO(md.dia)} · ${plural(md.facturas, 'factura', 'facturas')}` },
    ])];
    if (!s.facturas) { nodos.push(vacio('No hay ventas en este período.')); return nodos; }
    nodos.push(sec('Ventas por día', null,
        d.por_dia.length > 1 ? columnas(d.por_dia.map((x) => ({ valor: x.ventas_usd, tip: `${fechaISO(x.dia)}: ${usd(x.ventas_usd)}` })), fechaISO(d.por_dia[0].dia), fechaISO(d.por_dia.at(-1).dia)) : '',
        tabla('Ventas por día', [
            { t: 'Día', k: 'dia', m: 'fecha', titulo: true, v: (r) => r.dia }, { t: 'Facturas', k: 'facturas', m: 'num' }, { t: 'Ventas $', k: 'ventas_usd', m: 'usd' },
            { t: 'Ventas Bs', k: 'ventas_bs', m: 'bs' }, { t: 'Ticket promedio', k: 'ticket_promedio', m: 'usd' },
        ], d.por_dia.filter((x) => x.facturas || d.por_dia.length <= 31), {
            pie: ['Total', entero(s.facturas), usd(s.ventas_usd), bs(suma(d.por_dia, 'ventas_bs')), usd(s.ticket_promedio)],
        })));
    nodos.push(sec('Por vendedor', null, tabla('Ventas por vendedor', [
        { t: 'Vendedor', k: 'vendedor', titulo: true }, { t: 'Facturas', k: 'facturas', m: 'num' }, { t: 'Ventas $', k: 'ventas_usd', m: 'usd' },
        { t: 'Ticket promedio', k: 'ticket_promedio', m: 'usd' }, { t: 'Participación', k: 'participacion', m: 'pct' },
    ], d.por_vendedor)));
    nodos.push(sec('Horas con más ventas', 'Hora de Venezuela.', barras(d.por_hora.map((x) => ({ etq: `${String(x.hora).padStart(2, '0')}:00`, valor: x.ventas_usd, texto: `${usd(x.ventas_usd)} · ${x.facturas}` })))));
    state.tablas.push({ titulo: 'Ventas por hora', cols: ['Hora', 'Facturas', 'Ventas $'], filas: d.por_hora.map((x) => [`${String(x.hora).padStart(2, '0')}:00`, x.facturas, x.ventas_usd]) });
    nodos.push(sec('Días de la semana', null, barras(d.por_dia_semana.map((x) => ({ etq: x.dia, valor: x.ventas_usd, texto: `${usd(x.ventas_usd)} · ${x.facturas}` })))));
    state.tablas.push({ titulo: 'Ventas por día de la semana', cols: ['Día', 'Facturas', 'Ventas $'], filas: d.por_dia_semana.map((x) => [x.dia, x.facturas, x.ventas_usd]) });
    return nodos;
}

function rProductos(d) {
    const s = d.resumen;
    const nodos = [kpis([
        { t: 'Productos vendidos', v: entero(s.productos), s: 'Distintos en el período' }, { t: 'Unidades', v: entero(s.unidades) },
        { t: 'Monto vendido', v: usd(s.monto_usd), tono: 'destacada' },
    ])];
    nodos.push(sec('Más vendidos', s.productos > s.mostrados ? `Los ${s.mostrados} primeros de ${entero(s.productos)}.` : null, tabla('Productos más vendidos', [
        { t: '#', f: (r) => String(d.filas.indexOf(r) + 1), v: (r) => d.filas.indexOf(r) + 1, n: true },
        { t: 'Producto', k: 'producto', titulo: true }, { t: 'Unidades', k: 'cantidad', m: 'num' }, { t: 'Monto', k: 'monto_usd', m: 'usd' },
        { t: 'Facturas', k: 'facturas', m: 'num' }, { t: 'Precio promedio', k: 'precio_promedio', m: 'usd' }, { t: 'Del total', k: 'participacion', m: 'pct' },
    ], d.filas, { sinDatos: 'No hay productos vendidos en este período.' })));
    return nodos;
}

function rClientes(d) {
    const s = d.resumen;
    const nodos = [kpis([
        { t: 'Clientes', v: entero(s.clientes), s: 'Distintos en el período' }, { t: 'Clientes recurrentes', v: entero(s.recurrentes), s: 'Compraron 2 veces o más' },
        { t: 'Compras', v: usd(s.compras_usd), tono: 'destacada', s: plural(s.facturas, 'factura', 'facturas') },
    ])];
    nodos.push(sec('Mejores clientes', s.clientes > s.mostrados ? `Los ${s.mostrados} primeros de ${entero(s.clientes)}.` : null, tabla('Mejores clientes', [
        { t: '#', f: (r) => String(d.filas.indexOf(r) + 1), v: (r) => d.filas.indexOf(r) + 1, n: true },
        { t: 'Cliente', k: 'cliente', titulo: true }, { t: 'Cédula', k: 'cedula' }, { t: 'Teléfono', k: 'telefono' }, { t: 'Facturas', k: 'facturas', m: 'num' },
        { t: 'Compras', k: 'compras_usd', m: 'usd' }, { t: 'Ticket promedio', k: 'ticket_promedio', m: 'usd' }, { t: 'Última compra', k: 'ultima', m: 'fechaHora' }, { t: 'Del total', k: 'participacion', m: 'pct' },
    ], d.filas, { sinDatos: 'No hay compras en este período.' })));
    return nodos;
}

const etiquetaPeriodo = (p, agrupar) => (agrupar === 'mes' ? `${p.slice(5)}/${p.slice(0, 4)}` : agrupar === 'semana' ? `Sem. ${fechaISO(p)}` : fechaISO(p));

function rFinanzas(d) {
    const s = d.resumen, pp = d.periodo_previo;
    const v = s.variacion_pct;
    const nodos = [kpis([
        { t: 'Ingresos por ventas', v: usd(s.ventas_usd), tono: 'destacada', s: `${plural(s.facturas, 'factura', 'facturas')} · ${bs(s.ventas_bs)}` },
        { t: 'Frente al período anterior', v: v == null ? 'Sin datos' : `${v > 0 ? '+' : ''}${porcentaje(v)}`, tono: v == null ? '' : v >= 0 ? 'ok' : 'mal',
            s: `Antes (${fechaISO(pp.desde)} a ${fechaISO(pp.hasta)}): ${usd(s.previo_ventas_usd)}, ${plural(s.previo_facturas, 'factura', 'facturas')}` },
        { t: 'Ticket promedio', v: usd(s.ticket_promedio) },
        { t: 'Cobrado en dólares', v: usd(s.cobrado_usd) }, { t: 'Cobrado en bolívares', v: bs(s.cobrado_bs) },
    ])];
    nodos.push(nota('Este reporte incluye solo los ingresos por ventas facturadas: los egresos y la utilidad no están aquí. Los dólares y los bolívares cobrados son monedas distintas y no se suman.'));
    if (!s.facturas) { nodos.push(vacio('No hay ventas en este período.')); return nodos; }
    const porNombre = { dia: 'día', semana: 'semana', mes: 'mes' }[d.agrupar];
    const pp_ = d.por_periodo;
    nodos.push(sec(`Ingresos por ${porNombre}`, null,
        pp_.length > 1 ? columnas(pp_.map((x) => ({ valor: x.ventas_usd, tip: `${etiquetaPeriodo(x.periodo, d.agrupar)}: ${usd(x.ventas_usd)}` })), etiquetaPeriodo(pp_[0].periodo, d.agrupar), etiquetaPeriodo(pp_.at(-1).periodo, d.agrupar)) : '',
        tabla(`Ingresos por ${porNombre}`, [
            { t: d.agrupar === 'mes' ? 'Mes' : d.agrupar === 'semana' ? 'Semana desde' : 'Día', f: (r) => etiquetaPeriodo(r.periodo, d.agrupar), v: (r) => r.periodo, titulo: true },
            { t: 'Facturas', k: 'facturas', m: 'num' }, { t: 'Ventas $', k: 'ventas_usd', m: 'usd' }, { t: 'Ventas Bs', k: 'ventas_bs', m: 'bs' },
        ], pp_, { pie: ['Total', entero(s.facturas), usd(s.ventas_usd), bs(s.ventas_bs)] })));
    nodos.push(sec('Por método de pago', 'Participación sobre las ventas a precio de lista.', tabla('Ingresos por método de pago', [
        ...colMetodo, { t: 'Equivalente a precio de lista', k: 'lista_usd', m: 'usd' }, { t: 'Participación', k: 'participacion', m: 'pct' },
    ], d.por_metodo)));
    return nodos;
}

const ESTADO = { agotado: 'Agotado', bajo: 'Stock bajo' };
function colProducto(extra = []) {
    return [{ t: 'Producto', k: 'producto', titulo: true }, { t: 'Sección', k: 'seccion' }, ...extra];
}

function rInventario(d, admin) {
    const s = d.resumen;
    const nodos = [kpis([
        { t: 'Productos activos', v: entero(s.variantes), s: `${entero(s.unidades)} unidades en existencia` },
        { t: 'Valor a precio detal', v: usd(s.valor_detal), tono: 'destacada' },
        admin && { t: 'Valor a costo', v: usd(s.valor_costo), tono: 'destacada', s: 'Lo que costó la mercancía en existencia' },
        { t: 'Agotados', v: entero(s.agotados), tono: s.agotados ? 'mal' : '' }, { t: 'Stock bajo', v: entero(s.bajos), tono: s.bajos ? 'aviso-k' : '', s: 'En el mínimo o por debajo' },
        { t: 'Stock alto', v: entero(s.altos), s: 'En el máximo o por encima' },
    ])];
    nodos.push(sec('Por sección', null, tabla('Inventario por sección', [
        { t: 'Sección', k: 'seccion', titulo: true }, { t: 'Productos', k: 'variantes', m: 'num' }, { t: 'Unidades', k: 'unidades', m: 'num' }, { t: 'Valor detal', k: 'valor_detal', m: 'usd' },
        ...(admin ? [{ t: 'Valor costo', k: 'valor_costo', m: 'usd' }] : []),
    ], d.por_seccion, { pie: ['Total', entero(s.variantes), entero(s.unidades), usd(s.valor_detal), ...(admin ? [usd(s.valor_costo)] : [])] })));
    nodos.push(sec('Lista de reposición', 'Productos agotados o por debajo del mínimo. «Sugerido» llega hasta el máximo configurado.', tabla('Lista de reposición', [
        ...colProducto([{ t: 'Estado', f: (r) => ESTADO[r.estado], v: (r) => ESTADO[r.estado] }, { t: 'Stock', k: 'cantidad', m: 'num' }, { t: 'Mínimo', k: 'minimo', m: 'num' }, { t: 'Máximo', k: 'maximo', m: 'num' },
            { t: 'Sugerido', k: 'sugerido', m: 'num' }, ...(admin ? [{ t: 'Costo de reponer', k: 'costo_reposicion', m: 'usd' }] : [])]),
    ], d.reposicion, {
        sinDatos: 'No hay productos por reponer.',
        pie: admin && d.reposicion.length > 1 ? ['Total', '', '', '', '', '', '', usd(suma(d.reposicion, 'costo_reposicion'))] : null,
    })));
    if (d.reposicion_total > d.reposicion.length) nodos.push(nota(`Se muestran ${entero(d.reposicion.length)} de ${entero(d.reposicion_total)} productos. Filtra por sección para ver el resto.`));
    nodos.push(sec('Sobrestock', 'Productos en el máximo o por encima.', tabla('Sobrestock', [
        ...colProducto([{ t: 'Stock', k: 'cantidad', m: 'num' }, { t: 'Máximo', k: 'maximo', m: 'num' }, { t: 'Exceso', k: 'exceso', m: 'num' }]),
    ], d.sobrestock, { sinDatos: 'No hay productos en sobrestock.' })));
    if (d.sobrestock_total > d.sobrestock.length) nodos.push(nota(`Se muestran ${entero(d.sobrestock.length)} de ${entero(d.sobrestock_total)} productos.`));
    nodos.push(sec('Donde está el dinero', 'Los 20 productos con más valor en existencia.', tabla('Productos con más valor en existencia', [
        ...colProducto([{ t: 'Stock', k: 'cantidad', m: 'num' }, { t: 'Precio detal', k: 'precio_detal', m: 'usd' }, { t: 'Valor detal', k: 'valor_detal', m: 'usd' },
            ...(admin ? [{ t: 'Valor costo', k: 'valor_costo', m: 'usd' }] : [])]),
    ], d.top_valor)));
    return nodos;
}

function rMovimientos(d, admin) {
    const s = d.resumen;
    const nodos = [kpis([
        { t: 'Movimientos', v: entero(s.movimientos) }, { t: 'Unidades que entraron', v: entero(s.entradas), tono: 'ok' },
        { t: 'Unidades que salieron', v: entero(s.salidas), tono: s.salidas ? 'mal' : '' },
        { t: 'Saldo neto', v: `${s.neto > 0 ? '+' : ''}${entero(s.neto)}`, s: 'Entradas menos salidas' },
    ])];
    nodos.push(sec('Por tipo de movimiento', null, tabla('Movimientos por tipo', [
        { t: 'Movimiento', f: (r) => TIPOS_KARDEX[r.tipo] || r.tipo, v: (r) => TIPOS_KARDEX[r.tipo] || r.tipo, titulo: true },
        { t: 'Movimientos', k: 'movimientos', m: 'num' },
        { t: 'Unidades', f: (r) => `${r.signo > 0 ? '+' : '−'}${entero(r.unidades)}`, v: (r) => r.signo * r.unidades, n: true },
        ...(admin ? [{ t: 'Costo total', k: 'costo_total', m: 'usd' }] : []),
    ], d.por_tipo, { sinDatos: 'No hubo movimientos en este período.' })));
    nodos.push(nota('Para ver cada movimiento con su saldo y su responsable, usa el Kardex del Inventario.'));
    return nodos;
}

function rSinMovimiento(d, admin) {
    const s = d.resumen;
    const nodos = [kpis([
        { t: 'Productos sin ventas', v: entero(s.productos), tono: s.productos ? 'aviso-k' : '', s: 'Con stock y sin ninguna venta en el período' }, { t: 'Unidades paradas', v: entero(s.unidades) },
        { t: 'Valor a precio detal', v: usd(s.valor_detal), tono: 'destacada' }, admin && { t: 'Valor a costo', v: usd(s.valor_costo), tono: 'destacada', s: 'Dinero detenido en mercancía' },
    ])];
    nodos.push(sec('Productos sin ventas', s.productos > s.mostrados ? `Los ${s.mostrados} de mayor valor, de ${entero(s.productos)}.` : null, tabla('Productos sin ventas', [
        ...colProducto([{ t: 'Stock', k: 'cantidad', m: 'num' }, { t: 'Valor detal', k: 'valor_detal', m: 'usd' }, ...(admin ? [{ t: 'Valor costo', k: 'valor_costo', m: 'usd' }] : [])]),
    ], d.filas, { sinDatos: 'Todos los productos con stock tuvieron ventas en este período.' })));
    return nodos;
}

const REPORTES = [
    { id: 'cierre', nombre: 'Cierre de caja', icono: 'fa-cash-register', filtros: ['rango', 'vendedor'], rango: 'hoy', render: rCierre,
        sub: 'Lo cobrado en el período por método de pago y vendedor, listo para imprimir.' },
    { id: 'facturas', nombre: 'Facturas', icono: 'fa-receipt', filtros: ['rango', 'buscar', 'vendedor', 'metodo'], rango: 'hoy', render: rFacturas,
        sub: 'Busca una factura para ver su detalle o reimprimirla.' },
    { id: 'ventas', nombre: 'Ventas', icono: 'fa-chart-column', filtros: ['rango', 'vendedor'], rango: '7d', render: rVentas,
        sub: 'Cómo se comportan las ventas por día, hora y vendedor.' },
    { id: 'productos', nombre: 'Productos', icono: 'fa-ranking-star', filtros: ['rango', 'orden'], rango: '30d', render: rProductos,
        sub: 'Qué se vende más, por unidades o por monto.' },
    { id: 'clientes', nombre: 'Clientes', icono: 'fa-users', filtros: ['rango'], rango: '30d', render: rClientes,
        sub: 'Quiénes compran más y cuántos regresan.' },
    { id: 'finanzas', nombre: 'Finanzas', icono: 'fa-coins', filtros: ['rango', 'agrupar'], rango: 'mes', render: rFinanzas,
        sub: 'Ingresos por período y método de pago, comparados con el período anterior.' },
    { id: 'inventario', nombre: 'Inventario', icono: 'fa-boxes-stacked', filtros: ['seccion'], render: rInventario,
        sub: 'Existencias valoradas, lista de reposición y sobrestock a hoy.' },
    { id: 'movimientos', nombre: 'Movimientos', icono: 'fa-clock-rotate-left', filtros: ['rango', 'seccion'], rango: '30d', render: rMovimientos,
        sub: 'Entradas y salidas de inventario por tipo de movimiento.' },
    { id: 'sin_movimiento', nombre: 'Sin ventas', icono: 'fa-hourglass-half', filtros: ['dias', 'seccion'], render: rSinMovimiento,
        sub: 'Productos con stock que no se han vendido: mercancía detenida.' },
];
const reporteActual = () => REPORTES.find((r) => r.id === state.tab);

//--- FILTROS ---//
const valoresIniciales = (rep) => {
    const [desde, hasta] = rangoPreset(rep.rango || 'hoy');
    return { desde, hasta, vendedor: '', metodo: '', q: '', orden: 'cantidad', agrupar: 'dia', seccion: '', dias: '30' };
};
function campo(id, texto, control, clase = '') {
    return el('div', { className: ('field ' + clase).trim() }, el('label', { htmlFor: id, textContent: texto }), control);
}
function selector(id, opciones, valor, clave) {
    const s = el('select', { id });
    s.append(...opciones.map(([v, t]) => el('option', { value: v, textContent: t })));
    s.value = valor;
    s.addEventListener('change', () => { vals()[clave] = s.value; cargar(); });
    return s;
}
const vals = () => state.vals[state.tab];
const opcionesVendedor = () => [['', 'Todos'], ...(state.vendedores || []).map((n) => [n, n])];
const opcionesSeccion = () => [['', 'Todas'], ...(state.secciones || []).map((x) => [String(x.id), x.nombre])];

function marcarPresets() {
    const v = vals();
    for (const b of $$('.rango-rapido .filtro')) {
        const [d, h] = rangoPreset(b.dataset.preset);
        b.setAttribute('aria-pressed', String(v.desde === d && v.hasta === h));
    }
}
const FILTROS = {
    rango() {
        const v = vals();
        const fecha = (id, clave) => {
            const i = el('input', { id, type: 'date', value: v[clave], max: hoyISO() });
            i.addEventListener('change', () => { v[clave] = i.value; marcarPresets(); if (v.desde && v.hasta) cargar(); });
            return i;
        };
        const chips = el('div', { className: 'rango-rapido', role: 'group' }, ...PRESETS.map(([id, t]) => {
            const b = el('button', { type: 'button', className: 'filtro', textContent: t });
            b.dataset.preset = id;
            b.addEventListener('click', () => {
                [v.desde, v.hasta] = rangoPreset(id);
                $('#fDesde').value = v.desde; $('#fHasta').value = v.hasta;
                marcarPresets(); cargar();
            });
            return b;
        }));
        chips.setAttribute('aria-label', 'Rango rápido');
        return [campo('fDesde', 'Desde', fecha('fDesde', 'desde')), campo('fHasta', 'Hasta', fecha('fHasta', 'hasta')), el('div', { className: 'field ancho' }, chips)];
    },
    vendedor: () => [campo('fVendedor', 'Vendedor', selector('fVendedor', opcionesVendedor(), vals().vendedor, 'vendedor'))],
    metodo: () => [campo('fMetodo', 'Método de pago', selector('fMetodo', [['', 'Todos'], ...METODOS], vals().metodo, 'metodo'))],
    orden: () => [campo('fOrden', 'Ordenar por', selector('fOrden', [['cantidad', 'Unidades vendidas'], ['monto', 'Monto vendido']], vals().orden, 'orden'))],
    agrupar: () => [campo('fAgrupar', 'Agrupar por', selector('fAgrupar', [['dia', 'Día'], ['semana', 'Semana'], ['mes', 'Mes']], vals().agrupar, 'agrupar'))],
    seccion: () => [campo('fSeccion', 'Sección', selector('fSeccion', opcionesSeccion(), vals().seccion, 'seccion'))],
    dias: () => [campo('fDias', 'Sin ventas en los últimos', selector('fDias', DIAS_OPCIONES, vals().dias, 'dias'))],
    buscar() {
        const i = el('input', { id: 'fBuscar', type: 'search', placeholder: 'Factura, cliente, cédula o teléfono', maxLength: 60, autocomplete: 'off', value: vals().q });
        i.addEventListener('input', () => { vals().q = i.value; clearTimeout(buscarT); buscarT = setTimeout(cargar, 350); });
        return [campo('fBuscar', 'Buscar', i, 'grow')];
    },
};

function construirFiltros(rep) {
    const f = $('#filtros');
    f.replaceChildren(...rep.filtros.flatMap((k) => FILTROS[k]()));
    f.hidden = !rep.filtros.length;
    marcarPresets();
}
/** Las listas de vendedores y secciones se piden una sola vez; al llegar, se rellenan los selectores abiertos. */
async function precargarListas() {
    const pedir = async (clave, fn) => { if (state[clave] === null) { try { state[clave] = await fn(); } catch { state[clave] = []; } } };
    await Promise.all([pedir('vendedores', async () => (await obtenerReporte('vendedores')).data), pedir('secciones', obtenerSecciones)]);
    for (const [id, opts, clave] of [['#fVendedor', opcionesVendedor(), 'vendedor'], ['#fSeccion', opcionesSeccion(), 'seccion']]) {
        const s = $(id);
        if (!s) continue;
        s.replaceChildren(...opts.map(([v, t]) => el('option', { value: v, textContent: t })));
        s.value = opts.some(([v]) => v === vals()[clave]) ? vals()[clave] : '';
    }
}

//--- CARGA ---//
function parametros(rep) {
    const v = vals(), p = {};
    if (rep.filtros.includes('rango')) {
        if (!v.desde || !v.hasta) { aviso('Indica las fechas «Desde» y «Hasta».', true); return null; }
        if (v.desde > v.hasta) { aviso('La fecha «Desde» no puede ser posterior a «Hasta».', true); return null; }
        p.desde = v.desde; p.hasta = v.hasta;
    }
    if (rep.filtros.includes('vendedor')) p.vendedor = v.vendedor;
    if (rep.filtros.includes('metodo')) p.metodo = v.metodo;
    if (rep.filtros.includes('buscar')) p.q = v.q.trim();
    if (rep.filtros.includes('orden')) p.orden = v.orden;
    if (rep.filtros.includes('agrupar')) p.agrupar = v.agrupar;
    if (rep.filtros.includes('seccion')) p.seccion = v.seccion;
    if (rep.filtros.includes('dias')) p.dias = v.dias;
    return p;
}

function describirPeriodo(rep, meta) {
    if (rep.id === 'inventario') return `Existencias al ${fechaISO(meta.generado.slice(0, 10))}`;
    if (!meta.desde) return '';
    const sin = rep.id === 'sin_movimiento' ? `Sin ventas desde el ${fechaISO(meta.desde)} hasta el ${fechaISO(meta.hasta)}` : null;
    if (sin) return sin;
    return meta.desde === meta.hasta ? `Fecha: ${fechaISO(meta.desde)}` : `Del ${fechaISO(meta.desde)} al ${fechaISO(meta.hasta)}`;
}
function describirFiltros(rep) {
    const v = vals(), partes = [];
    if (rep.filtros.includes('vendedor') && v.vendedor) partes.push(`Vendedor: ${v.vendedor}`);
    if (rep.filtros.includes('metodo') && v.metodo) partes.push(`Pago: ${nombreFiltro(METODOS, v.metodo)}`);
    if (rep.filtros.includes('buscar') && v.q.trim()) partes.push(`Búsqueda: ${v.q.trim()}`);
    if (rep.filtros.includes('seccion') && v.seccion) partes.push(`Sección: ${(state.secciones || []).find((x) => String(x.id) === v.seccion)?.nombre || v.seccion}`);
    if (rep.filtros.includes('orden')) partes.push(`Orden: ${v.orden === 'monto' ? 'monto vendido' : 'unidades vendidas'}`);
    if (rep.filtros.includes('agrupar')) partes.push(`Agrupado por ${{ dia: 'día', semana: 'semana', mes: 'mes' }[v.agrupar]}`);
    return partes.join(' · ');
}
function pintarEncabezado(rep, meta) {
    $('#tituloRep').textContent = rep.nombre;
    $('#subRep').textContent = rep.sub;
    $('#phTitulo').textContent = rep.nombre;
    $('#phPeriodo').textContent = meta ? describirPeriodo(rep, meta) : '';
    $('#phFiltros').textContent = describirFiltros(rep);
    $('#phGenerado').textContent = meta ? `Generado el ${fechaHora(meta.generado)}${meta.usuario ? ' por ' + meta.usuario : ''}` : '';
}

async function cargar() {
    const rep = reporteActual(), p = parametros(rep);
    if (!p) return;
    const n = ++state.seq, caja = $('#resultado');
    caja.setAttribute('aria-busy', 'true');
    caja.classList.add('cargando');
    if (!caja.children.length) caja.replaceChildren(vacio('Generando reporte…'));
    try {
        const d = await obtenerReporte(rep.id, p);
        if (n !== state.seq) return;                 // llegó una respuesta más vieja que la última pedida
        state.meta = d.meta; state.tablas = [];
        pintarEncabezado(rep, d.meta);
        caja.replaceChildren(...rep.render(d.data, d.meta.admin).filter(Boolean));
    } catch (e) {
        if (n !== state.seq) return;
        state.meta = null; state.tablas = [];
        pintarEncabezado(rep, null);
        caja.replaceChildren(el('p', { className: 'rep-error', role: 'alert', textContent: e.message }));
    } finally {
        if (n === state.seq) { caja.setAttribute('aria-busy', 'false'); caja.classList.remove('cargando'); }
    }
}

//--- PESTAÑAS ---//
function construirTabs() {
    $('#tabs').replaceChildren(...REPORTES.map((r) => {
        const b = el('button', { type: 'button', className: 'tab', id: 'tab-' + r.id, tabIndex: -1 }, el('i', { className: 'fas ' + r.icono }), r.nombre);
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', 'false');
        b.setAttribute('aria-controls', 'panReporte');
        b.addEventListener('click', () => cambiarTab(r.id));
        return b;
    }));
}
function cambiarTab(id, foco = false) {
    const rep = REPORTES.find((r) => r.id === id) || REPORTES[0];
    state.tab = rep.id;
    state.vals[rep.id] ??= valoresIniciales(rep);
    for (const r of REPORTES) {
        const b = $('#tab-' + r.id), on = r.id === rep.id;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
    }
    $('#panReporte').setAttribute('aria-labelledby', 'tab-' + rep.id);
    history.replaceState(null, '', '#' + rep.id);
    $('#resultado').replaceChildren();
    construirFiltros(rep);
    pintarEncabezado(rep, null);
    $('#tab-' + rep.id).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (foco) $('#tab-' + rep.id).focus();
    precargarListas();
    cargar();
}

//--- DETALLE DE FACTURA ---//
function filaDato(t, v) { return [el('dt', { textContent: t }), el('dd', { textContent: v || '—' })]; }
async function verFactura(r) {
    state.factura = { id: r.id_factura, telefono: r.telefono };
    $('#hFactura').textContent = `Factura ${r.id_factura}`;
    $('#detalleError').hidden = true;
    $('#detalleCuerpo').replaceChildren(vacio('Cargando…'));
    $('#dWs').disabled = true; $('#dPdf').disabled = true;
    $('#dlgFactura').showModal();
    try {
        const d = (await obtenerReporte('detalle', { id: r.id_factura })).data, f = d.factura;
        if (state.factura?.id !== r.id_factura) return;
        state.factura.telefono = f.telefono;
        const colsItem = [
            { t: 'Producto', k: 'producto', titulo: true }, { t: 'Cant.', k: 'cantidad', m: 'num' }, { t: 'Precio', k: 'precio_unitario', m: 'usd' }, { t: 'Total', k: 'precio_total', m: 'usd' }];
        const tablaDetalle = (cols, filas, pie) => {
            const n = state.tablas.length;                  // las tablas del diálogo no forman parte del CSV del reporte
            const nodo = tabla('Detalle', cols, filas, { pie });
            state.tablas.length = n;
            return nodo;
        };
        $('#detalleCuerpo').replaceChildren(
            el('dl', { className: 'det-grid' }, ...filaDato('Fecha', fechaHora(f.creado)), ...filaDato('Cliente', f.cliente), ...filaDato('Cédula', f.cedula),
                ...filaDato('Teléfono', f.telefono), ...filaDato('Vendedor', f.vendedor), ...filaDato('Forma de pago', f.etiqueta),
                ...filaDato('Total', `${usd(f.total_usd)} · ${bs(f.total_bs)}`), ...filaDato('Tasa', f.tasa_cambio ? bs(f.tasa_cambio) : null),
                ...(f.observaciones ? filaDato('Observaciones', f.observaciones) : [])),
            sec('Productos', null, tablaDetalle(colsItem, d.items, ['Total', '', '', usd(suma(d.items, 'precio_total'))])),
            sec('Pagos', null, tablaDetalle([
                { t: 'Método', k: 'etiqueta', titulo: true }, { t: 'Banco', k: 'banco' }, { t: 'Referencia', k: 'referencia', cls: 'mono' },
                { t: 'Monto', f: (p) => MONEDA[p.moneda](p.monto), v: (p) => p.monto, n: true }], d.pagos)));
        $('#dPdf').disabled = false;
        $('#dWs').disabled = !f.telefono;
    } catch (e) {
        $('#detalleCuerpo').replaceChildren();
        $('#detalleError').textContent = e.message; $('#detalleError').hidden = false;
    }
}
$('#dPdf').addEventListener('click', () => state.factura && abrirPdf(state.factura.id));
$('#dWs').addEventListener('click', async () => {
    const b = $('#dWs'), err = $('#detalleError');
    if (!state.factura?.telefono) return;
    b.disabled = true; err.hidden = true;
    try {
        const r = await reenviarWhatsapp(state.factura.id, telefonoE164(state.factura.telefono));
        const msg = { enviado: 'Factura enviada por WhatsApp.', sin_whatsapp: 'Ese número no tiene WhatsApp.', no_disponible: 'WhatsApp no está disponible ahora. Inténtalo en un momento.', no_configurado: 'El envío por WhatsApp no está configurado.' }[r];
        aviso(msg || 'Solicitud procesada.', r !== 'enviado');
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    finally { b.disabled = false; }
});
$('#dlgFactura').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

//--- EXPORTAR E IMPRIMIR ---//
const celdaCsv = (v) => {
    if (v == null) return '';
    if (typeof v === 'number') return String(v).replace('.', ',');           // coma decimal: Excel en español
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                                // evita que Excel lo trate como fórmula
    return /[";\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
function exportarCsv() {
    if (!state.meta || !state.tablas.length) return aviso('No hay datos para exportar.', true);
    const rep = reporteActual(), lineas = [`${celdaCsv('Corporación Katoa Global')};${celdaCsv(rep.nombre)}`, celdaCsv($('#phPeriodo').textContent), celdaCsv($('#phFiltros').textContent), ''];
    for (const t of state.tablas) {
        lineas.push(celdaCsv(t.titulo), t.cols.map(celdaCsv).join(';'), ...t.filas.map((f) => f.map(celdaCsv).join(';')), '');
    }
    const m = state.meta, periodo = m.desde ? (m.desde === m.hasta ? m.desde : `${m.desde}_${m.hasta}`) : m.generado.slice(0, 10);
    const a = el('a', { href: URL.createObjectURL(new Blob(['\uFEFF' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8' })), download: `katoa-${rep.id}-${periodo}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
function imprimir() {
    if (!state.meta) return aviso('Espera a que cargue el reporte para imprimirlo.', true);
    const antes = document.title;
    document.title = `${reporteActual().nombre} — Katoa`;
    window.addEventListener('afterprint', () => (document.title = antes), { once: true });
    window.print();
}

//--- INICIO ---//
function init() {
    construirTabs();
    $('#tabs').addEventListener('keydown', (e) => {
        const i = REPORTES.findIndex((r) => r.id === state.tab);
        const sig = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: REPORTES.length - 1 }[e.key];
        if (sig === undefined) return;
        e.preventDefault();
        cambiarTab(REPORTES[(sig + REPORTES.length) % REPORTES.length].id, true);
    });
    $('#filtros').addEventListener('submit', (e) => e.preventDefault());
    $('#btnCsv').addEventListener('click', exportarCsv);
    $('#btnImprimir').addEventListener('click', imprimir);
    cambiarTab(location.hash.slice(1));
}
init();
