/* ============================================================================
 * Facturación — Katoa
 * Flujo: 1) datos del cliente  2) tasa y productos  3) pago  4) enviar
 * Formateadores → utils/format.js · Llamadas al servidor → utils/api.js
 * ========================================================================== */
import { FORMATTERS, usd, bs, round2, soloDigitos, telefonoE164 } from './utils/format.js';
import { buscarProductos, buscarCliente, guardarCliente, obtenerTasa, obtenerTasaUsdt, enviarFactura } from './utils/api.js';
import { METODOS_COMPROBANTE, METODOS_USD, $, calcularTotales, el, fechaLimiteCredito, precioUnitario, pulso, totalLinea, validarCliente, mostrarEstado, mostrarPagoError, crearPagoMixto } from './utils/venta.js';

//--- CONSTANTES ---//
const STORAGE = { vendedor: 'vendedorActual', tasa: 'tasaFacturacion', tasaUsdt: 'tasaUsdtFacturacion' };

//--- ESTADO ---//
const state = {
    items: [],            // productos de la factura
    tasa: 0,              // Bs por $
    tasaManual: false,    // true si el vendedor la escribió a mano
    tasaUsdt: 0,          // Bs por USDT (para cobros en dólares)
    tasaUsdtManual: false,
    descuentoUsd: true,   // interruptor: aplicar la conversión USDT en pagos en dólares
    cliente: null,        // datos ya validados del cliente
    comprobante: null,    // foto del pago Zelle/Binance (data URL JPEG comprimido)
    pagosMixtos: [],      // líneas del pago combinado
    mixtoSeq: 0,          // contador de ids de esas líneas
    idFactura: null,      // se conserva entre reintentos para no duplicar la factura
    nuevoId: null,        // fila recién agregada (para resaltarla una vez)
    enviando: false,
    factura: null,        // factura ya guardada: { id, telefono, pdf, whatsapp } (pantalla final)
};

// Funciones del pago combinado y del cobro en dólares (compartidas con pedidos; cada módulo pasa su propio estado).
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
    obtenerItems: () => state.items,
    invalidarId: () => { state.idFactura = null; },   // cambió el cobro: el próximo envío usa un id nuevo
    renderResumen: () => renderResumen(),
    deDocumento: 'de la factura',
});
let seq = 0;

//--- CÁLCULOS (funciones puras, sin DOM) ---//

const nuevoIdFactura = () => `FAC-${Date.now().toString().slice(-8)}-${Math.random().toString(36).slice(2, 8)}`;

//--- 1. DATOS DEL CLIENTE ---//
export const abrirCliente = () => {
    const dlg = $('#dlgCliente');
    if (dlg && !dlg.open) dlg.showModal();
};

function initCliente() {
    const dlg = $('#dlgCliente');
    const form = $('#formCliente');
    const err = $('#clienteError');
    const f = form.elements;
    let timer;
    f.vendedor.value = localStorage.getItem(STORAGE.vendedor) || '';

    const mostrarError = (msg) => { err.textContent = msg; err.hidden = false; };

    // Autorrelleno: usa buscarCliente() de utils/api.js (cédula en dígitos, teléfono guardado en E.164).
    let rellenoAuto = false; // true si los campos los llenó el autorrelleno (se pueden volver a pisar)
    const aTelefonoLocal = (tel) => {
        const d = soloDigitos(tel);
        return d.startsWith('58') && d.length === 12 ? '0' + d.slice(2) : d;
    };
    const ponerValor = (campo, valor) => {
        const formatear = FORMATTERS[campo.dataset.format];
        campo.value = formatear ? formatear(valor) : valor;
    };

    async function autorrellenar(digitos) {
        const cli = await buscarCliente(digitos);
        if (!cli || soloDigitos(f.cedula.value) !== digitos) return; // no encontrado, o la cédula ya cambió
        const vacio = !f.nombre.value && !f.apellido.value && !f.telefono.value;
        if (!vacio && !rellenoAuto) return; // no pisar lo que escribió el vendedor
        ponerValor(f.nombre, cli.nombre || '');
        ponerValor(f.apellido, cli.apellido || '');
        ponerValor(f.telefono, aTelefonoLocal(cli.telefono || ''));
        rellenoAuto = true;
        err.hidden = true;
        for (const campo of [f.nombre, f.apellido, f.telefono]) {
            campo.classList.remove('autorrelleno');
            void campo.offsetWidth;
            campo.classList.add('autorrelleno');
        }
    }

    form.addEventListener('input', (e) => {
        err.hidden = true;
        const formatear = FORMATTERS[e.target.dataset.format];
        if (formatear) e.target.value = formatear(e.target.value);
        if (['nombre', 'apellido', 'telefono'].includes(e.target.name)) rellenoAuto = false; // edición manual
        if (e.target === f.cedula) {
            clearTimeout(timer);
            const digitos = soloDigitos(f.cedula.value);
            if (digitos.length >= 6 && digitos.length <= 8) timer = setTimeout(() => autorrellenar(digitos), 400);
        }
    });

    // El cliente es obligatorio: con Esc no se puede cerrar hasta haberlo guardado.
    dlg.addEventListener('cancel', (e) => {
        if (!state.cliente) {
            e.preventDefault();
            mostrarError('Debes registrar los datos del cliente para continuar con la factura.');
        }
    });

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = Object.fromEntries([...new FormData(form)].map(([k, x]) => [k, x.trim()]));
        const fallo = validarCliente(v);
        if (fallo) { mostrarError(fallo.mensaje); f[fallo.campo].focus(); return; }

        // El cliente se guarda en Supabase al enviar la factura (finalizarCompra → guardarCliente).
        localStorage.setItem(STORAGE.vendedor, v.vendedor);
        state.cliente = v;
        renderCliente();
        dlg.close();
    });

    abrirCliente();
}

function renderCliente() {
    const c = state.cliente;
    const chip = $('#chipCliente');
    chip.textContent = c ? 'Cliente listo' : 'Cliente pendiente';
    chip.dataset.ok = String(!!c);
    $('#clienteDatos').hidden = !c;
    $('#clienteVacio').hidden = !!c;
    $('#txtEditar').textContent = c ? 'Editar' : 'Completar';
    if (!c) return;
    $('#cNombre').textContent = `${c.nombre} ${c.apellido}`;
    $('#cCedula').textContent = c.cedula;
    $('#cTelefono').textContent = c.telefono;
    $('#cVendedor').textContent = c.vendedor;
}

//--- 2a. TASA DEL DÍA ---//
function initTasa() {
    const input = $('#tasa');
    const fijar = (v, manual = false) => {
        state.tasa = v;
        state.tasaManual ||= manual;
        localStorage.setItem(STORAGE.tasa, v);
        renderFactura();
    };

    const guardada = Number(localStorage.getItem(STORAGE.tasa)) || 0;
    if (guardada) { input.value = guardada.toFixed(2); state.tasa = guardada; }

    input.addEventListener('input', () => fijar(Number(input.value) || 0, true));

    // La tasa en línea no pisa lo que el vendedor escribió a mano, ni cambia con el pago en pantalla.
    obtenerTasa().then((v) => {
        if (v > 0 && !state.tasaManual && !input.readOnly) { input.value = v.toFixed(2); fijar(v); }
    });
}

function initTasaUsdt() {
    const input = $('#tasaUsdt');
    const fijar = (v, manual = false) => {
        state.tasaUsdt = v;
        state.tasaUsdtManual ||= manual;
        state.idFactura = null; // cambió el cobro: el próximo envío usa un id nuevo
        localStorage.setItem(STORAGE.tasaUsdt, v);
    };

    const guardada = Number(localStorage.getItem(STORAGE.tasaUsdt)) || 0;
    if (guardada) { input.value = guardada.toFixed(2); state.tasaUsdt = guardada; }

    input.addEventListener('input', () => fijar(Number(input.value) || 0, true));

    // Igual que la tasa BCV: la tasa en línea no pisa lo escrito a mano ni cambia con el pago en pantalla.
    obtenerTasaUsdt().then((v) => {
        if (v > 0 && !state.tasaUsdtManual && !input.readOnly) { input.value = v.toFixed(2); fijar(v); }
    });
}

//--- 2b. AGREGAR PRODUCTOS (con búsqueda en inventario) ---//
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
        const items = [...lista.children];
        items.forEach((li, n) => { li.classList.toggle('active', n === i); li.setAttribute('aria-selected', n === i); });
        activo = i;
        items[i]?.scrollIntoView({ block: 'nearest' });
    };
    const etiqueta = (p) => [p.nombre, p.color, p.talla].filter(Boolean).join(' - ');

    // Autoselección: si lo escrito/escaneado coincide EXACTAMENTE con el código de barras de UNA variante, se elige sola.
    const norm = (s) => String(s ?? '').trim().toLowerCase();
    const coincidenciaExacta = (resultados, q) => {
        const exactos = resultados.filter((p) => p?.id != null && norm(p.codigo_barras) === norm(q));
        return exactos.length === 1 ? exactos[0] : null;
    };

    function elegir(p, { auto = false } = {}) {
        sel = {
            id: p.id, stock: Number(p.cantidad) || 0, precioDetal: Number(p.precio_detal) || 0,
            precioMayor: Number(p.precio_mayor) || 0, cantidadMayor: Number(p.cantidad_mayor) || 0,
            precioGranMayor: Number(p.precio_gran_mayor) || 0, cantidadGranMayor: Number(p.cantidad_gran_mayor) || 0,
        };
        nombre.value = etiqueta(p);
        if (!(Number(cant.value) > 0)) cant.value = 1;
        precio.value = precioUnitario(Number(cant.value), sel).toFixed(2);
        actualizarTotal(); cerrar(); cant.select();

        if (auto) { // feedback visual: el producto se seleccionó solo
            for (const campo of [nombre, precio]) {
                campo.classList.remove('autorrelleno');
                void campo.offsetWidth;
                campo.classList.add('autorrelleno');
            }
        }
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

    async function buscar(q) {
        ctrl?.abort(); ctrl = new AbortController();
        try {
            const r = await buscarProductos(q, ctrl.signal);
            if (nombre.value.trim() !== q) return;          // el texto cambió mientras tanto
            const exacto = coincidenciaExacta(r, q);
            if (exacto) return elegir(exacto, { auto: true });
            pintar(r, q);
        } catch (e) { if (e.name !== 'AbortError') cerrar(); }
    }

    nombre.addEventListener('input', () => {
        sel = null; clearTimeout(timer); ctrl?.abort();
        const q = nombre.value.trim();
        if (q.length < 2) return cerrar();
        timer = setTimeout(() => buscar(q), 300);
    });

    nombre.addEventListener('keydown', (e) => {
        // Enter sin opción marcada (p. ej. lector de códigos de barras): busca ya, sin esperar el debounce.
        if (e.key === 'Enter' && (lista.hidden || activo < 0)) {
            const q = nombre.value.trim();
            if (q.length >= 2 && !sel) {
                e.preventDefault();
                clearTimeout(timer);
                buscar(q);
            }
            return;
        }
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
        // Al cambiar la cantidad de un producto del inventario se aplica su precio (detal o mayor).
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
        state.items.push({
            id: ++seq, idInventario: sel?.id ?? null, nombre: n, cantidad: c, precioUnitario: pu,
            stock: sel ? sel.stock : null,
        });
        state.nuevoId = seq;
        renderFactura();
        form.reset(); sel = null; total.value = '—'; cerrar(); nombre.focus();
    });
}

//--- 2c. TABLA Y TOTALES ---//
function initFactura() {
    const tbody = $('#filas');
    const dlg = $('#dlgEditar'), form = $('#formEditar'), err = $('#editarError');
    let editId = null;

    tbody.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const id = Number(b.closest('tr').dataset.id);
        const p = state.items.find((x) => x.id === id);
        if (b.dataset.act === 'del') {
            state.items = state.items.filter((x) => x.id !== id);
            renderFactura();
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
        Object.assign(state.items.find((x) => x.id === editId), { cantidad: c, nombre: n, precioUnitario: pu });
        renderFactura();
        dlg.close();
    });
    $('#btnEditarCancelar').addEventListener('click', () => dlg.close());
}

/** Total que muestra el resumen: en pagos en dólares refleja el descuento (si está activo). */
function totalResumen(t) {
    const enPago = !$('#seccionPago').hidden;
    return enPago && METODOS_USD.has($('#metodoPago').value) ? aPagarUsd(t) : t.total;
}

/** Repinta solo los totales del aside (lista, o monto con descuento al pagar en dólares). */
function renderResumen() {
    const t = calcularTotales(state.items, state.tasa);
    const aCobrar = totalResumen(t);
    $('#tEtiqueta').textContent = aCobrar < t.total ? 'Total a pagar' : 'Total';
    pulso($('#tTotal'), usd(aCobrar));
    pulso($('#tTotalBs'), bs(t.totalBs));
}

/** Repinta tabla y totales. Se llama tras cualquier cambio de productos o tasa. */
function renderFactura() {
    const t = calcularTotales(state.items, state.tasa);
    state.idFactura = null; // la factura cambió: el próximo envío usa un id nuevo
    $('#filas').replaceChildren(...state.items.map(filaProducto));
    state.nuevoId = null;
    $('#tablaWrap').hidden = !state.items.length;
    $('#vacio').hidden = !!state.items.length;
    pulso($('#cuenta'), String(state.items.length));
    renderResumen();
    $('#btnProcesar').disabled = !state.items.length;
}

//--- 3. SECCIÓN DE PAGO ---//
function mostrarSeccionPago() {
    if (!state.items.length) return;
    if (!state.cliente) return abrirCliente();
    if (!(state.tasa > 0)) {
        const err = $('#productoError');
        err.textContent = 'Ingresa la tasa del día antes de procesar la compra.';
        err.hidden = false;
        return $('#tasa').focus();
    }
    $('#seccionProducto').hidden = true;
    $('#seccionFactura').hidden = true;
    $('#seccionPago').hidden = false;
    $('#btnProcesar').hidden = true;
    $('#tasa').readOnly = $('#tasaUsdt').readOnly = true; // con las tasas fijas, los montos del pago no cambian
    selectMetodoPago($('#metodoPago').value);
}

function ocultarSeccionPagos() {
    $('#seccionProducto').hidden = false;
    $('#seccionFactura').hidden = false;
    $('#seccionPago').hidden = true;
    $('#btnProcesar').hidden = false;
    $('#tasa').readOnly = $('#tasaUsdt').readOnly = false;
    renderResumen(); // de vuelta a productos, el aside muestra el total de lista
}

//--- PAGO COMBINADO (varios métodos, repetibles) ---//

//--- 4. ENVIAR LA FACTURA ---//

async function finalizarCompra() {
    if (state.enviando) return;
    const c = state.cliente;
    if (!c) return abrirCliente();

    const lectura = leerPago();
    if (lectura.error) return mostrarPagoError(lectura.error, lectura.campo);

    const t = calcularTotales(state.items, state.tasa);
    const telefono = telefonoE164(c.telefono);
    state.idFactura ||= nuevoIdFactura();

    const payload = {
        id_factura: state.idFactura,
        nombre: c.nombre, apellido: c.apellido, cedula: soloDigitos(c.cedula), telefono, vendedor: c.vendedor,
        tasa_cambio: state.tasa,
        subtotal_usd: t.total, total_usd: t.total, // precio de lista (BCV); el cobro en dólares viaja en monto_usd
        subtotal_bs: t.totalBs, total_bs: t.totalBs,
        ...lectura.pago,
        comprobante: METODOS_COMPROBANTE.has(lectura.pago.metodo_pago) ? state.comprobante : null,
        productos: state.items.map((p) => ({
            nombre: p.nombre, cantidad: p.cantidad, precioUnitario: p.precioUnitario,
            precioTotal: totalLinea(p), idInventario: p.idInventario,
        })),
    };

    state.enviando = true;
    $('#btnFinalizar').disabled = true;
    $('#pagoError').hidden = true;
    mostrarEstado('cargando');
    try {
        const res = await enviarFactura(payload);
        guardarCliente({ cedula: soloDigitos(c.cedula), nombre: c.nombre, apellido: c.apellido, telefono });
        state.items = []; // sin productos, el aviso de salida ya no aplica
        // whatsapp: null si la factura ya estaba registrada (reintento): no se sabe si llegó
        state.factura = {
            id: payload.id_factura, telefono, pdf: res.pdf === true, whatsapp: res.whatsapp ?? null,
            credito: payload.plazo_dias ? { dias: payload.plazo_dias, vence: fechaLimiteCredito(payload.plazo_dias) } : null,
        };
        pintarExito();
        mostrarEstado('exito');
    } catch (e) {
        console.error('Error en finalizarCompra:', e);
        mostrarEstado('error', e.message);
        state.enviando = false;
        $('#btnFinalizar').disabled = false;
    }
}

//--- 5. FACTURA LISTA: WhatsApp o impresión ---//

//--- INICIO ---//
async function init() {
    // auth-guard.js redirige a /login.html si no hay sesión
    if (window.Auth && !(await window.Auth.listo)) return;

    if (window.Auth?.credito?.permitido === false) $('#metodoPago option[value="CREDITO"]')?.remove();

    initTasa();
    initTasaUsdt();
    initCliente();
    initProducto();
    initFactura();
    renderFactura();

    $('#btnProcesar').addEventListener('click', mostrarSeccionPago);
    $('#btnVolver').addEventListener('click', ocultarSeccionPagos);
    $('#btnFinalizar').addEventListener('click', finalizarCompra);
    $('#metodoPago').addEventListener('change', (e) => selectMetodoPago(e.target.value));
    $('#descUsdt').addEventListener('change', (e) => alternarDescuento(e.target.checked));

    const dlgEstado = $('#dlgEstado');
    dlgEstado.addEventListener('cancel', (e) => { if (state.enviando) e.preventDefault(); });
    $('#btnEstadoCerrar').addEventListener('click', () => dlgEstado.close());
    $('#btnImprimir').addEventListener('click', imprimirFactura);
    $('#btnReenviarWa').addEventListener('click', reintentarWhatsapp);
    $('#btnNuevaFactura').addEventListener('click', () => dlgEstado.close());
    // Al cerrar la pantalla final (botón o Esc) se empieza una factura nueva en limpio.
    dlgEstado.addEventListener('close', () => { if (state.factura) location.reload(); });

    document.addEventListener('click', (e) => { if (e.target.closest('[data-open-cliente]')) abrirCliente(); });
    window.addEventListener('beforeunload', (e) => {
        if (state.items.length) { e.preventDefault(); e.returnValue = ''; }
    });
}

// En el navegador arranca solo; en Node (tests) solo se importan las funciones puras.
if (typeof document !== 'undefined') init();