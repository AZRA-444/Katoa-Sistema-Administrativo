/* ============================================================================
 * Pedidos — Katoa
 * Igual que facturación (mismo backend: /api/enviar-factura guarda la factura, genera el PDF
 * y lo manda por WhatsApp), pero pensado para atender varias compras a la vez por WhatsApp:
 *   · varios pedidos abiertos (pestañas) con autoguardado: sobreviven a recargas y cortes
 *   · mensaje de resumen para el cliente (copiar o abrir el chat de WhatsApp)
 *   · cobro con los mismos métodos de pago que facturación (incluido el pago combinado)
 * Este módulo es independiente: no depende de facturacion.js ni le envía nada.
 * Formateadores → utils/format.js · Llamadas al servidor → utils/api.js
 * ========================================================================== */
import { FORMATTERS, usd, bs, round2, soloDigitos, telefonoE164 } from './utils/format.js';
import { buscarProductos, buscarCliente, guardarCliente, obtenerTasa, obtenerTasaUsdt, enviarFactura } from './utils/api.js';
import { METODOS_COMPROBANTE, METODOS_USD, BANCOS, $, calcularTotales, el, esc, fechaLimiteCredito, montoEnDolares, precioUnitario, pulso, totalLinea, validarCliente, mostrarEstado, mostrarPagoError, crearPagoMixto } from './utils/venta.js';

//--- CONSTANTES ---//
// Las tasas y el vendedor comparten clave con facturación: lo que se escribe en un módulo aparece en el otro.
const STORAGE = { vendedor: 'vendedorActual', tasa: 'tasaFacturacion', tasaUsdt: 'tasaUsdtFacturacion', borrador: 'pedidosKatoaBorrador' };
// Datos de cobro que se incluyen en el mensaje de WhatsApp. Si el teléfono queda vacío, esa sección no se muestra.
const DATOS_PAGO_MOVIL = { telefono: '', cedula: '' };
const NOMBRE_EMPRESA = 'Corporación Katoa Global';
const MAX_PEDIDOS = 30;
const CAMPOS_CLIENTE = ['nombre', 'apellido', 'cedula', 'telefono', 'vendedor'];

//--- ESTADO ---//
const state = {
    pedidos: [],          // pedidos abiertos: { id, idFactura, cliente:{…}, items:[…] }
    actualId: null,       // pedido seleccionado
    pedidoSeq: 0,         // contador de "Pedido #n"
    itemSeq: 0,           // contador de ids de producto
    tasa: 0,              // Bs por $
    tasaManual: false,    // true si el vendedor la escribió a mano
    tasaUsdt: 0,          // Bs por USDT (para cobros en dólares)
    tasaUsdtManual: false,
    descuentoUsd: true,   // interruptor: aplicar la conversión USDT en pagos en dólares
    rellenoAuto: false,   // true si nombre/apellido/teléfono los llenó el autorrelleno (se pueden volver a pisar)
    comprobante: null,    // foto del pago Zelle/Binance (data URL JPEG comprimido)
    pagosMixtos: [],      // líneas del pago combinado
    mixtoSeq: 0,          // contador de ids de esas líneas
    nuevoId: null,        // fila recién agregada (para resaltarla una vez)
    mensaje: '',          // último mensaje de WhatsApp generado
    enviando: false,
    factura: null,        // factura ya guardada: { id, telefono, pdf, whatsapp } (pantalla final)
};

// Funciones del pago combinado y del cobro en dólares (compartidas con facturación; cada módulo pasa su propio estado).
const {
    aPagarUsd,
    selectMetodoPago,
    leerPago,
    alternarDescuento,
    filaProducto,
    pintarExito,
    reintentarWhatsapp,
    imprimirFactura,
} = crearPagoMixto(state, {
    obtenerItems: () => items(),
    invalidarId: () => invalidarId(),
    renderResumen: () => renderResumen(),
    deDocumento: 'del pedido',
});

//--- CÁLCULOS (funciones puras, sin DOM; iguales a las de facturación y al servidor) ---//

const nuevoIdFactura = () => `PED-${Date.now().toString().slice(-8)}-${Math.random().toString(36).slice(2, 8)}`;

/** Número nacional de 10 dígitos (sin 58 ni 0 inicial) para wa.me/58…, o null si no es válido. */
export function numeroWhatsApp(valor) {
    const d = soloDigitos(valor).replace(/^58/, '').replace(/^0/, '');
    return d.length === 10 ? d : null;
}

/** Texto del resumen que se le manda al cliente por WhatsApp (formato *negrita* de WhatsApp). */
export function mensajeWhatsApp(pedido, { tasa, tasaUsdt = 0, descuentoUsd = true, fecha = new Date() }) {
    const c = pedido.cliente;
    const t = calcularTotales(pedido.items, tasa);
    const nombre = [c.nombre, c.apellido].filter(Boolean).join(' ') || 'Cliente';
    const enDolares = montoEnDolares(t, tasaUsdt, descuentoUsd);
    const cuando = `${fecha.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${fecha.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}`;
    const pagoMovil = DATOS_PAGO_MOVIL.telefono
        ? [
            '',
            '💳 *Datos del pago móvil*',
            `Teléfono: ${DATOS_PAGO_MOVIL.telefono}`,
            DATOS_PAGO_MOVIL.cedula ? `Cédula: ${DATOS_PAGO_MOVIL.cedula}` : null,
            `Bancos: ${BANCOS.map(([, nombreBanco, codigo]) => `${nombreBanco} (${codigo})`).join(', ')}`,
        ]
        : [];
    return [
        `🛒 *RESUMEN DE PEDIDO — ${NOMBRE_EMPRESA}*`,
        `📅 ${cuando}`,
        '',
        `👤 *Cliente:* ${nombre}`,
        c.cedula ? `🪪 *Cédula:* ${c.cedula}` : null,
        '',
        '📦 *Productos:*',
        ...pedido.items.map((p) => `• ${p.cantidad} x ${p.nombre} — ${usd(p.precioUnitario)} c/u — ${usd(totalLinea(p))}`),
        '',
        `✅ *TOTAL:* ${usd(t.total)}`,
        `🇻🇪 *TOTAL Bs:* ${bs(t.totalBs)}`,
        `📈 *Tasa:* ${tasa.toFixed(2).replace('.', ',')} Bs/$`,
        enDolares < t.total ? `💵 *Pagando en divisas (efectivo, Zelle o Binance):* ${usd(enDolares)}` : null,
        ...pagoMovil,
        c.vendedor ? '' : null,
        c.vendedor ? `🙋 *Atendido por:* ${c.vendedor}` : null,
        '',
        `_Gracias por tu compra en ${NOMBRE_EMPRESA}_ 🙏`,
    ].filter((l) => l !== null).join('\n');
}

//--- PEDIDOS (varios abiertos a la vez) ---//
const clienteVacio = () => ({ nombre: '', apellido: '', cedula: '', telefono: '', vendedor: localStorage.getItem(STORAGE.vendedor) || '' });
const pedidoVacio = () => ({ id: ++state.pedidoSeq, idFactura: null, cliente: clienteVacio(), items: [] });
const actual = () => state.pedidos.find((p) => p.id === state.actualId);
const items = () => actual()?.items ?? [];
const nombreCompleto = (c) => [c.nombre, c.apellido].filter(Boolean).join(' ');
const tieneDatos = (p) => p.items.length > 0 || ['nombre', 'apellido', 'cedula', 'telefono'].some((k) => p.cliente[k]);

/** El pedido cambió: el próximo envío usa un id nuevo (así nunca se reintenta con datos distintos bajo el mismo id). */
const invalidarId = (p = actual()) => { if (p) p.idFactura = null; };
const invalidarTodos = () => state.pedidos.forEach((p) => invalidarId(p));

function crearPedido(conFoco = true) {
    if (state.pedidos.length >= MAX_PEDIDOS) return alert(`Máximo ${MAX_PEDIDOS} pedidos abiertos a la vez.`);
    const p = pedidoVacio();
    state.pedidos.push(p);
    seleccionar(p.id);
    if (conFoco) $('#cNombreIn').focus();
}

function seleccionar(id) {
    state.actualId = id;
    cargarClienteEnForm();
    limpiarProducto();
    renderTodo();
    guardarBorrador();
}

function eliminarPedido(id, confirmar = true) {
    const i = state.pedidos.findIndex((p) => p.id === id);
    if (i < 0) return;
    if (confirmar && tieneDatos(state.pedidos[i]) && !confirm('¿Eliminar este pedido? Se perderán sus productos y datos.')) return;
    state.pedidos.splice(i, 1);
    if (!state.pedidos.length) {
        const nuevo = pedidoVacio();
        state.pedidos.push(nuevo);
        return seleccionar(nuevo.id);
    }
    if (state.actualId === id) return seleccionar(state.pedidos[Math.min(i, state.pedidos.length - 1)].id);
    renderLista();
    guardarBorrador();
}

/** Pestañas: una por pedido, más el botón de pedido nuevo. */
function renderLista() {
    const nodos = state.pedidos.map((p) => {
        const nombre = nombreCompleto(p.cliente) || 'Sin nombre';
        const t = calcularTotales(p.items, state.tasa);
        const sel = el('button', { type: 'button', className: 'ped-tab-sel', title: nombre },
            el('span', { className: 'ped-tab-num', textContent: `Pedido #${p.id}` }),
            el('span', { className: 'ped-tab-nombre', textContent: nombre }),
            el('span', { className: 'ped-tab-meta', textContent: `${p.items.length} prod. · ${usd(t.total)}` }));
        const quitar = el('button', { type: 'button', className: 'ped-tab-x', title: 'Eliminar pedido', 'aria-label': `Eliminar el pedido ${p.id}` },
            el('i', { className: 'fas fa-xmark' }));
        const tab = el('div', { className: 'ped-tab' }, sel, quitar);
        tab.dataset.id = p.id;
        if (p.id === state.actualId) tab.setAttribute('aria-current', 'true');
        return tab;
    });
    const nuevo = el('button', { type: 'button', className: 'btn btn-ghost ped-nuevo' }, el('i', { className: 'fas fa-plus' }), ' Nuevo pedido');
    $('#pedTabs').replaceChildren(...nodos, nuevo);
    $('#pedTabs [aria-current]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function initPestanas() {
    $('#pedTabs').addEventListener('click', (e) => {
        if (e.target.closest('.ped-nuevo')) return crearPedido();
        const tab = e.target.closest('.ped-tab');
        if (!tab) return;
        const id = Number(tab.dataset.id);
        if (e.target.closest('.ped-tab-x')) eliminarPedido(id);
        else if (id !== state.actualId) seleccionar(id);
    });
}

//--- AUTOGUARDADO: un pedido en curso no se pierde por recargar, cerrar o quedarse sin conexión ---//
// Lleva datos de clientes (nombre, cédula, teléfono): se marca con el usuario y la hora para no mostrárselo a
// otra persona que use el mismo equipo ni conservarlo días; además Auth.cerrarSesion() lo borra.
const BORRADOR_VIGENCIA_MS = 12 * 60 * 60 * 1000;
function guardarBorrador() {
    try {
        localStorage.setItem(STORAGE.borrador, JSON.stringify({
            uid: window.Auth?.usuario?.id || null, guardado: Date.now(),
            pedidos: state.pedidos, actualId: state.actualId, pedidoSeq: state.pedidoSeq, itemSeq: state.itemSeq,
        }));
    } catch { /* sin espacio o modo privado: se sigue trabajando sin autoguardado */ }
}
let temporizadorBorrador;
function guardarBorradorDebounced() {
    clearTimeout(temporizadorBorrador);
    temporizadorBorrador = setTimeout(guardarBorrador, 400);
}

const itemValido = (i) => i && Number.isInteger(i.id) && typeof i.nombre === 'string' && i.nombre
    && Number.isFinite(i.cantidad) && i.cantidad > 0 && Number.isFinite(i.precioUnitario) && i.precioUnitario > 0;

/** Recupera los pedidos guardados. Devuelve true si había alguno con datos reales. */
function restaurarBorrador() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(STORAGE.borrador)); } catch { /* borrador corrupto: se ignora */ }
    if (!d || !Array.isArray(d.pedidos)) return false;
    // Solo el mismo usuario y de las últimas horas; de lo contrario se descarta (y se borra).
    const uid = window.Auth?.usuario?.id;
    if (!uid || d.uid !== uid || !(Date.now() - Number(d.guardado) < BORRADOR_VIGENCIA_MS)) {
        try { localStorage.removeItem(STORAGE.borrador); } catch { /* sin acceso al almacenamiento */ }
        return false;
    }
    const pedidos = d.pedidos
        .filter((p) => p && Number.isInteger(p.id) && p.cliente && typeof p.cliente === 'object' && Array.isArray(p.items))
        .map((p) => ({
            id: p.id,
            // El id se conserva: si la respuesta del servidor se perdió, reintentar no duplica la factura.
            idFactura: typeof p.idFactura === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(p.idFactura) ? p.idFactura : null,
            cliente: Object.fromEntries(CAMPOS_CLIENTE.map((k) => [k, typeof p.cliente[k] === 'string' ? p.cliente[k] : ''])),
            items: p.items.filter(itemValido).map((i) => ({
                id: i.id, idInventario: Number.isInteger(i.idInventario) ? i.idInventario : null, nombre: i.nombre,
                cantidad: i.cantidad, precioUnitario: i.precioUnitario, stock: Number.isFinite(i.stock) ? i.stock : null,
            })),
        }));
    if (!pedidos.some(tieneDatos)) return false;
    state.pedidos = pedidos;
    state.pedidoSeq = Math.max(Number(d.pedidoSeq) || 0, ...pedidos.map((p) => p.id));
    state.itemSeq = Math.max(Number(d.itemSeq) || 0, ...pedidos.flatMap((p) => p.items.map((i) => i.id)));
    state.actualId = pedidos.some((p) => p.id === d.actualId) ? d.actualId : pedidos[0].id;
    return true;
}

//--- 1. DATOS DEL CLIENTE (del pedido seleccionado) ---//
function cargarClienteEnForm() {
    const f = $('#formCliente').elements;
    const c = actual().cliente;
    for (const k of CAMPOS_CLIENTE) f[k].value = c[k] || '';
    state.rellenoAuto = false;
    $('#clienteError').hidden = true;
}

function initCliente() {
    const form = $('#formCliente');
    const f = form.elements;
    const err = $('#clienteError');
    let timer;

    const aTelefonoLocal = (tel) => {
        const d = soloDigitos(tel);
        return d.startsWith('58') && d.length === 12 ? '0' + d.slice(2) : d;
    };
    const ponerValor = (campo, valor) => {
        const formatear = FORMATTERS[campo.dataset.format];
        campo.value = formatear ? formatear(valor) : valor;
    };

    // Autorrelleno: usa buscarCliente() de utils/api.js (cédula en dígitos, teléfono guardado en E.164).
    async function autorrellenar(digitos) {
        const pid = state.actualId;
        const cli = await buscarCliente(digitos);
        const p = actual();
        if (!cli || !p || p.id !== pid || soloDigitos(f.cedula.value) !== digitos) return; // no encontrado, o ya cambió de pedido o de cédula
        const vacio = !f.nombre.value && !f.apellido.value && !f.telefono.value;
        if (!vacio && !state.rellenoAuto) return; // no pisar lo que escribió el vendedor
        ponerValor(f.nombre, cli.nombre || '');
        ponerValor(f.apellido, cli.apellido || '');
        ponerValor(f.telefono, aTelefonoLocal(cli.telefono || ''));
        for (const k of ['nombre', 'apellido', 'telefono']) p.cliente[k] = f[k].value.trim();
        state.rellenoAuto = true;
        err.hidden = true;
        for (const campo of [f.nombre, f.apellido, f.telefono]) {
            campo.classList.remove('autorrelleno');
            void campo.offsetWidth;
            campo.classList.add('autorrelleno');
        }
        invalidarId(p);
        renderCliente();
        renderLista();
        guardarBorradorDebounced();
    }

    form.addEventListener('submit', (e) => e.preventDefault());
    form.addEventListener('input', (e) => {
        const campo = e.target.name;
        const p = actual();
        if (!p || !CAMPOS_CLIENTE.includes(campo)) return;
        err.hidden = true;
        const formatear = FORMATTERS[e.target.dataset.format];
        if (formatear) e.target.value = formatear(e.target.value);
        p.cliente[campo] = e.target.value.trim();
        if (campo === 'vendedor' && p.cliente.vendedor) localStorage.setItem(STORAGE.vendedor, p.cliente.vendedor);
        if (['nombre', 'apellido', 'telefono'].includes(campo)) state.rellenoAuto = false; // edición manual
        invalidarId(p);
        if (e.target === f.cedula) {
            clearTimeout(timer);
            const digitos = soloDigitos(f.cedula.value);
            if (digitos.length >= 6 && digitos.length <= 8) timer = setTimeout(() => autorrellenar(digitos), 400);
        }
        renderCliente();
        renderLista();
        guardarBorradorDebounced();
    });
}

function renderCliente() {
    const p = actual();
    const ok = !!p && !validarCliente(p.cliente);
    const chip = $('#chipCliente');
    chip.textContent = ok ? 'Cliente listo' : 'Cliente pendiente';
    chip.dataset.ok = String(ok);
}

/** Muestra el error del cliente y lleva el foco al campo que falla. */
function errorCliente(fallo) {
    const err = $('#clienteError');
    err.textContent = fallo.mensaje;
    err.hidden = false;
    $('#formCliente').elements[fallo.campo].focus();
}

/** Aviso general (tasa, etc.) bajo el formulario de producto. */
function avisar(msg, campo) {
    const err = $('#productoError');
    err.textContent = msg;
    err.hidden = false;
    campo?.focus();
}

//--- 2a. TASAS ---//
function initTasa() {
    const input = $('#tasa');
    const fijar = (v, manual = false) => {
        if (v !== state.tasa) invalidarTodos(); // cambió el total en Bs: los ids pendientes ya no valen
        state.tasa = v;
        state.tasaManual ||= manual;
        localStorage.setItem(STORAGE.tasa, v);
        renderTodo();
        guardarBorradorDebounced();
    };

    const guardada = Number(localStorage.getItem(STORAGE.tasa)) || 0;
    if (guardada) { input.value = guardada.toFixed(2); state.tasa = guardada; }

    input.addEventListener('input', () => fijar(Number(input.value) || 0, true));

    // La tasa en línea no pisa lo que el vendedor escribió a mano, ni cambia con el pago en pantalla.
    obtenerTasa().then((v) => {
        if (v > 0 && !state.tasaManual && !$('#dlgPago').open) { input.value = v.toFixed(2); fijar(v); }
    });
}

function initTasaUsdt() {
    const input = $('#tasaUsdt');
    const fijar = (v, manual = false) => {
        if (v !== state.tasaUsdt) invalidarTodos(); // cambió el cobro: el próximo envío usa un id nuevo
        state.tasaUsdt = v;
        state.tasaUsdtManual ||= manual;
        localStorage.setItem(STORAGE.tasaUsdt, v);
        guardarBorradorDebounced();
    };

    const guardada = Number(localStorage.getItem(STORAGE.tasaUsdt)) || 0;
    if (guardada) { input.value = guardada.toFixed(2); state.tasaUsdt = guardada; }

    input.addEventListener('input', () => fijar(Number(input.value) || 0, true));

    obtenerTasaUsdt().then((v) => {
        if (v > 0 && !state.tasaUsdtManual && !$('#dlgPago').open) { input.value = v.toFixed(2); fijar(v); }
    });
}

//--- 2b. AGREGAR PRODUCTOS (con búsqueda en inventario) ---//
let limpiarProducto = () => { }; // la define initProducto; se usa al cambiar de pedido

function initProducto() {
    const form = $('#formProducto');
    const nombre = $('#pNombre'), cant = $('#pCant'), precio = $('#pPrecio'), total = $('#pTotal');
    const lista = $('#sugerencias'), err = $('#productoError');
    let sel = null, timer, ctrl, activo = -1;

    const error = (msg, campo) => {
        err.textContent = msg; err.hidden = false;
        campo.setAttribute('aria-invalid', 'true'); campo.focus();
    };
    const limpiarError = () => {
        err.hidden = true;
        form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
    };
    const actualizarTotal = () => {
        const c = Number(cant.value), pu = Number(precio.value);
        total.value = c > 0 && pu > 0 ? usd(round2(c * pu)) : '—';
    };

    // Autocompletado
    const cerrar = () => {
        lista.hidden = true; lista.replaceChildren(); activo = -1;
        nombre.setAttribute('aria-expanded', 'false');
    };
    const marcar = (i) => {
        const opciones = [...lista.children];
        opciones.forEach((li, n) => { li.classList.toggle('active', n === i); li.setAttribute('aria-selected', n === i); });
        activo = i;
        opciones[i]?.scrollIntoView({ block: 'nearest' });
    };
    const etiqueta = (p) => [p.nombre, p.color, p.talla].filter(Boolean).join(' - ');

    limpiarProducto = () => {
        clearTimeout(timer); ctrl?.abort();
        form.reset(); sel = null; total.value = '—'; cerrar(); limpiarError();
    };

    function elegir(p) {
        sel = {
            id: p.id, stock: Number(p.cantidad) || 0, precioDetal: Number(p.precio_detal) || 0,
            precioMayor: Number(p.precio_mayor) || 0, cantidadMayor: Number(p.cantidad_mayor) || 0,
            precioGranMayor: Number(p.precio_gran_mayor) || 0, cantidadGranMayor: Number(p.cantidad_gran_mayor) || 0,
        };
        nombre.value = etiqueta(p);
        if (!(Number(cant.value) > 0)) cant.value = 1;
        precio.value = precioUnitario(Number(cant.value), sel).toFixed(2);
        actualizarTotal(); cerrar(); cant.select();
    }

    function pintar(resultados, texto) {
        const opciones = resultados.filter((p) => p?.id != null && etiqueta(p)).map((p) => {
            const mayor = Number(p.precio_mayor) > 0 && Number(p.cantidad_mayor) > 0;
            const gran = Number(p.precio_gran_mayor) > 0 && Number(p.cantidad_gran_mayor) > 0;
            const stock = Number(p.cantidad) > 0 ? `Stock ${p.cantidad}` : 'Sin stock';
            const meta = `${usd(Number(p.precio_detal) || 0)}${mayor ? ` · mayor ${usd(p.precio_mayor)} desde ${p.cantidad_mayor}` : ''}${gran ? ` · gran mayor ${usd(p.precio_gran_mayor)} desde ${p.cantidad_gran_mayor}` : ''} · ${stock}`;
            const li = el('li', { className: 'opt' + (Number(p.cantidad) > 0 ? '' : ' sin-stock'), role: 'option' },
                el('span', { className: 'opt-nombre', textContent: etiqueta(p) }),
                el('span', { className: 'opt-meta', textContent: meta }));
            li.addEventListener('mousedown', (e) => { e.preventDefault(); elegir(p); });
            return li;
        });
        const manual = el('li', { className: 'opt manual', role: 'option' },
            el('span', { className: 'opt-nombre', textContent: `Agregar «${texto}» sin inventario` }),
            el('span', { className: 'opt-meta', textContent: 'Escribe el precio a mano' }));
        manual.addEventListener('mousedown', (e) => { e.preventDefault(); cerrar(); precio.focus(); });
        lista.replaceChildren(...opciones, manual);
        lista.hidden = false; activo = -1;
        nombre.setAttribute('aria-expanded', 'true');
    }

    nombre.addEventListener('input', () => {
        sel = null; clearTimeout(timer); ctrl?.abort();
        const q = nombre.value.trim();
        if (q.length < 2) return cerrar();
        timer = setTimeout(async () => {
            ctrl = new AbortController();
            try {
                const r = await buscarProductos(q, ctrl.signal);
                if (nombre.value.trim() === q) pintar(r, q);
            } catch (e) { if (e.name !== 'AbortError') cerrar(); }
        }, 300);
    });

    nombre.addEventListener('keydown', (e) => {
        if (lista.hidden) return;
        const n = lista.children.length;
        if (e.key === 'ArrowDown') { e.preventDefault(); marcar((activo + 1) % n); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); marcar((activo - 1 + n) % n); }
        else if (e.key === 'Enter' && activo >= 0) {
            e.preventDefault();
            lista.children[activo].dispatchEvent(new MouseEvent('mousedown', { cancelable: true }));
        } else if (e.key === 'Escape') cerrar();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.combo')) cerrar(); });

    form.addEventListener('input', (e) => {
        limpiarError();
        // Al cambiar la cantidad de un producto del inventario se aplica su precio (detal, mayor o gran mayor).
        if (e.target === cant && sel && Number(cant.value) > 0) precio.value = precioUnitario(Number(cant.value), sel).toFixed(2);
        if (e.target !== nombre) actualizarTotal();
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        limpiarError();
        const c = Number(cant.value), pu = Number(precio.value), n = nombre.value.trim();
        if (!(state.tasa > 0)) return error('Ingresa la tasa del día antes de agregar productos.', $('#tasa'));
        if (!n) return error('Escribe el nombre del producto.', nombre);
        if (!(c > 0)) return error('La cantidad debe ser mayor que cero.', cant);
        if (!(pu > 0)) return error('El precio unitario debe ser mayor que cero.', precio);
        const id = ++state.itemSeq;
        actual().items.push({ id, idInventario: sel?.id ?? null, nombre: n, cantidad: c, precioUnitario: pu, stock: sel ? sel.stock : null });
        state.nuevoId = id;
        cambioPedido();
        limpiarProducto();
        nombre.focus();
    });
}

//--- 2c. TABLA Y TOTALES ---//
function initDetalle() {
    const tbody = $('#filas');
    const dlg = $('#dlgEditar'), form = $('#formEditar'), err = $('#editarError');
    let editId = null;

    tbody.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const id = Number(b.closest('tr').dataset.id);
        const p = items().find((x) => x.id === id);
        if (!p) return;
        if (b.dataset.act === 'del') {
            actual().items = items().filter((x) => x.id !== id);
            cambioPedido();
        } else {
            editId = id;
            form.elements.cant.value = p.cantidad;
            form.elements.nombre.value = p.nombre;
            form.elements.precio.value = p.precioUnitario;
            err.hidden = true;
            dlg.showModal();
        }
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const c = Number(form.elements.cant.value), pu = Number(form.elements.precio.value);
        const n = form.elements.nombre.value.trim();
        if (!n || !(c > 0) || !(pu > 0)) {
            err.textContent = 'Completa correctamente cantidad, nombre y precio unitario.'; err.hidden = false; return;
        }
        Object.assign(items().find((x) => x.id === editId), { cantidad: c, nombre: n, precioUnitario: pu });
        cambioPedido();
        dlg.close();
    });
    $('#btnEditarCancelar').addEventListener('click', () => dlg.close());
}

/** Total que muestra el resumen: en pagos en dólares refleja el descuento (si está activo). */
function totalResumen(t) {
    const enPago = $('#dlgPago').open;
    return enPago && METODOS_USD.has($('#metodoPago').value) ? aPagarUsd(t) : t.total;
}

/** Repinta solo los totales del aside (lista, o monto con descuento al pagar en dólares). */
function renderResumen() {
    const t = calcularTotales(items(), state.tasa);
    const aCobrar = totalResumen(t);
    $('#tEtiqueta').textContent = aCobrar < t.total ? 'Total a pagar' : 'Total';
    pulso($('#tTotal'), usd(aCobrar));
    pulso($('#tTotalBs'), bs(t.totalBs));
}

/** Repinta tabla, totales y botones del pedido seleccionado. */
function renderPedido() {
    const p = actual();
    $('#filas').replaceChildren(...p.items.map(filaProducto));
    state.nuevoId = null;
    $('#tablaWrap').hidden = !p.items.length;
    $('#vacio').hidden = !!p.items.length;
    pulso($('#cuenta'), String(p.items.length));
    renderResumen();
    $('#btnProcesar').disabled = $('#btnMensaje').disabled = !p.items.length;
    renderCliente();
}

const renderTodo = () => { renderLista(); renderPedido(); };

/** Se llama tras cualquier cambio de productos del pedido seleccionado. */
function cambioPedido() {
    invalidarId();
    renderTodo();
    guardarBorrador();
}

//--- 3. MENSAJE DE WHATSAPP PARA EL CLIENTE ---//
function initMensaje() {
    const dlg = $('#dlgMensaje');
    const tel = $('#waTelefono');
    const err = $('#waError');
    const btnCopiar = $('#btnCopiarMensaje');
    const textoCopiar = btnCopiar.innerHTML;
    let temporizador;

    $('#btnMensaje').addEventListener('click', () => {
        const p = actual();
        if (!p.items.length) return;
        if (!(state.tasa > 0)) return avisar('Ingresa la tasa del día antes de armar el mensaje.', $('#tasa'));
        state.mensaje = mensajeWhatsApp(p, { tasa: state.tasa, tasaUsdt: state.tasaUsdt, descuentoUsd: state.descuentoUsd });
        // Se escapa primero y luego se aplica la negrita/cursiva de WhatsApp, para que el texto del cliente nunca sea HTML.
        $('#waBurbuja').innerHTML = esc(state.mensaje)
            .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
            .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<em>$2</em>');
        tel.value = numeroWhatsApp(p.cliente.telefono) ?? '';
        err.hidden = true;
        clearTimeout(temporizador);
        btnCopiar.innerHTML = textoCopiar;
        dlg.showModal();
    });

    tel.addEventListener('input', () => { tel.value = soloDigitos(tel.value).slice(0, 13); err.hidden = true; });
    $('#btnMensajeCerrar').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // clic en el fondo

    btnCopiar.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(state.mensaje);
            btnCopiar.innerHTML = '<i class="fas fa-check"></i> ¡Copiado!';
            clearTimeout(temporizador);
            temporizador = setTimeout(() => { btnCopiar.innerHTML = textoCopiar; }, 2500);
        } catch {
            err.textContent = 'No se pudo copiar. Selecciona el texto y cópialo a mano.';
            err.hidden = false;
        }
    });

    $('#btnAbrirWa').addEventListener('click', () => {
        const numero = numeroWhatsApp(tel.value);
        if (!numero) {
            err.textContent = 'Ingresa un número de WhatsApp válido (10 dígitos, ej: 4121234567).';
            err.hidden = false;
            return tel.focus();
        }
        // El chat es con el número del cliente: se guarda también en sus datos (a él se le envía la factura).
        const p = actual();
        p.cliente.telefono = FORMATTERS.phone('0' + numero);
        $('#formCliente').elements.telefono.value = p.cliente.telefono;
        invalidarId(p);
        renderCliente();
        guardarBorrador();
        window.open(`https://wa.me/58${numero}?text=${encodeURIComponent(state.mensaje)}`, '_blank', 'noopener');
        dlg.close();
    });
}

//--- 4. PAGO ---//
function abrirPago() {
    const p = actual();
    if (!p.items.length) return;
    const fallo = validarCliente(p.cliente);
    if (fallo) return errorCliente(fallo);
    if (!(state.tasa > 0)) return avisar('Ingresa la tasa del día antes de cobrar el pedido.', $('#tasa'));
    $('#pagoError').hidden = true;
    $('#dlgPago').showModal();
    selectMetodoPago($('#metodoPago').value);
    renderResumen();
}

//--- PAGO COMBINADO (varios métodos, repetibles) ---//

//--- 5. ENVIAR LA FACTURA ---//

async function finalizarCompra() {
    if (state.enviando) return;
    const p = actual();
    const fallo = validarCliente(p.cliente);
    if (fallo) { $('#dlgPago').close(); return errorCliente(fallo); }

    const lectura = leerPago();
    if (lectura.error) return mostrarPagoError(lectura.error, lectura.campo);

    const c = p.cliente;
    const t = calcularTotales(p.items, state.tasa);
    const telefono = telefonoE164(c.telefono);
    p.idFactura ||= nuevoIdFactura();
    guardarBorrador(); // el id queda guardado: si la respuesta se pierde, reintentar no duplica la factura

    const payload = {
        id_factura: p.idFactura,
        nombre: c.nombre, apellido: c.apellido, cedula: soloDigitos(c.cedula), telefono, vendedor: c.vendedor,
        tasa_cambio: state.tasa,
        subtotal_usd: t.total, total_usd: t.total, // precio de lista (BCV); el cobro en dólares viaja en monto_usd
        subtotal_bs: t.totalBs, total_bs: t.totalBs,
        ...lectura.pago,
        comprobante: METODOS_COMPROBANTE.has(lectura.pago.metodo_pago) ? state.comprobante : null,
        productos: p.items.map((i) => ({
            nombre: i.nombre, cantidad: i.cantidad, precioUnitario: i.precioUnitario,
            precioTotal: totalLinea(i), idInventario: i.idInventario,
        })),
    };

    state.enviando = true;
    $('#btnFinalizar').disabled = true;
    $('#pagoError').hidden = true;
    mostrarEstado('cargando');
    try {
        const res = await enviarFactura(payload);
        guardarCliente({ cedula: soloDigitos(c.cedula), nombre: c.nombre, apellido: c.apellido, telefono });
        // whatsapp: null si la factura ya estaba registrada (reintento): no se sabe si llegó
        state.factura = {
            id: payload.id_factura, telefono, pdf: res.pdf === true, whatsapp: res.whatsapp ?? null,
            credito: payload.plazo_dias ? { dias: payload.plazo_dias, vence: fechaLimiteCredito(payload.plazo_dias) } : null,
        };
        eliminarPedido(p.id, false); // ya está cobrado: sale de los pedidos abiertos
        $('#dlgPago').close();
        pintarExito();
        mostrarEstado('exito');
    } catch (e) {
        console.error('Error en finalizarCompra:', e);
        mostrarEstado('error', e.message);
    } finally {
        state.enviando = false;
        $('#btnFinalizar').disabled = false;
    }
}

//--- 6. PEDIDO COBRADO: WhatsApp o impresión ---//

//--- INICIO ---//
async function init() {
    // auth-guard.js redirige a /login.html si no hay sesión
    if (window.Auth && !(await window.Auth.listo)) return;

    if (!restaurarBorrador()) {
        const p = pedidoVacio();
        state.pedidos = [p];
        state.actualId = p.id;
    }

    if (window.Auth?.credito?.permitido === false) $('#metodoPago option[value="CREDITO"]')?.remove();

    initTasa();
    initTasaUsdt();
    initPestanas();
    initCliente();
    initProducto();
    initDetalle();
    initMensaje();
    cargarClienteEnForm();
    renderTodo();

    // Pago
    const dlgPago = $('#dlgPago');
    $('#btnProcesar').addEventListener('click', abrirPago);
    $('#btnVolver').addEventListener('click', () => dlgPago.close());
    $('#btnFinalizar').addEventListener('click', finalizarCompra);
    $('#metodoPago').addEventListener('change', (e) => selectMetodoPago(e.target.value));
    $('#descUsdt').addEventListener('change', (e) => alternarDescuento(e.target.checked));
    dlgPago.addEventListener('cancel', (e) => { if (state.enviando) e.preventDefault(); });
    dlgPago.addEventListener('close', renderResumen); // fuera del pago, el aside vuelve al total de lista

    // Estado final
    const dlgEstado = $('#dlgEstado');
    dlgEstado.addEventListener('cancel', (e) => { if (state.enviando) e.preventDefault(); });
    $('#btnEstadoCerrar').addEventListener('click', () => dlgEstado.close());
    $('#btnImprimir').addEventListener('click', imprimirFactura);
    $('#btnReenviarWa').addEventListener('click', reintentarWhatsapp);
    $('#btnNuevaFactura').addEventListener('click', () => dlgEstado.close());
    dlgEstado.addEventListener('close', () => { state.factura = null; });

    // Lo último que se escribió queda guardado aunque el debounce no haya terminado
    window.addEventListener('pagehide', guardarBorrador);
    window.addEventListener('beforeunload', guardarBorrador);
}

// En el navegador arranca solo; en Node (tests) solo se importan las funciones puras.
if (typeof document !== 'undefined') init();
