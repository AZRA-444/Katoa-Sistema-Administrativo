/* ============================================================================
 * Facturación — Katoa
 * Flujo: 1) datos del cliente  2) tasa y productos  3) pago  4) enviar
 * Formateadores → utils/format.js · Llamadas al servidor → utils/api.js
 * ========================================================================== */
import { FORMATTERS, usd, bs, round2, soloDigitos, telefonoE164 } from './utils/format.js';
import { buscarProductos, buscarCliente, guardarCliente, obtenerTasa, obtenerTasaUsdt, enviarFactura, urlPdfFactura, reenviarWhatsapp } from './utils/api.js';

//--- CONSTANTES ---//
const STORAGE = { vendedor: 'vendedorActual', tasa: 'tasaFacturacion', tasaUsdt: 'tasaUsdtFacturacion' };
const BANCOS = [
    ['Banesco', 'Banesco'],
    ['Venezuela', 'Banco de Venezuela'],
    ['Provincial', 'Provincial'],
    ['Banplus', 'Banplus'],
];

// Métodos que se cobran en dólares: el total se convierte con la tasa USDT (ver montoEnDolares).
const METODOS_USD = new Set(['ED', 'ZELLE', 'BINANCE']);
const METODOS_COMPROBANTE = new Set(['ZELLE', 'BINANCE']); // el pago móvil NO sube comprobante

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
let seq = 0;

const $ = (sel, raiz = document) => raiz.querySelector(sel);
function el(tag, props = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) (k in n ? (n[k] = v) : n.setAttribute(k, v));
    n.append(...hijos);
    return n;
}

/** Cambia el texto y, solo si cambió, reinicia el "latido" (clase .pulso). */
function pulso(nodo, texto) {
    if (nodo.textContent === texto) return;
    nodo.textContent = texto;
    nodo.classList.remove('pulso');
    void nodo.offsetWidth; // reinicia la animación
    nodo.classList.add('pulso');
}

//--- CÁLCULOS (funciones puras, sin DOM) ---//
export const totalLinea = (p) => round2(p.cantidad * p.precioUnitario);

/** Precio al mayor si la cantidad alcanza el umbral; si no, precio al detal. */
export function precioUnitario(cantidad, { precioDetal, precioMayor, cantidadMayor }) {
    return precioMayor > 0 && cantidadMayor > 0 && cantidad >= cantidadMayor ? precioMayor : precioDetal;
}

/** Solo se guarda USD; los Bs se derivan de la tasa vigente. El servidor recalcula y rechaza si no cuadra. */
export function calcularTotales(items, tasa) {
    const total = round2(items.reduce((a, p) => a + totalLinea(p), 0));
    return { total, totalBs: round2(total * tasa) };
}

/**
 * Monto a cobrar cuando se paga en dólares (efectivo, Zelle, Binance):
 * total en Bs (tasa BCV) ÷ tasa USDT. Ej.: 100$ × 857,89 = 85.789 Bs ÷ 960 = 89,36$.
 * Nunca supera el total (si USDT < BCV no hay recargo). Con activo = false se cobra el total de lista, sin conversión.
 * Debe coincidir con monto_en_dolares en api/enviar-factura.py.
 */
export const montoEnDolares = (t, tasaUsdt, activo = true) =>
    activo && tasaUsdt > 0 ? Math.min(t.total, round2(t.totalBs / tasaUsdt)) : t.total;

export const calcularVuelto = (recibido, total) => (recibido >= total ? round2(recibido - total) : 0);

/** Devuelve { campo, mensaje } con el primer error, o null si los datos son válidos. */
export function validarCliente(v) {
    const reglas = [
        ['nombre', !v.nombre, 'Escribe el nombre del cliente.'],
        ['apellido', !v.apellido, 'Escribe el apellido del cliente.'],
        ['cedula', soloDigitos(v.cedula).length < 6, 'Cédula inválida: debe tener entre 6 y 8 dígitos.'],
        ['telefono', v.telefono.length < 13, 'Teléfono incompleto. Ejemplo: 0412-345-6789.'],
        ['vendedor', !v.vendedor, 'Escribe el nombre del vendedor.'],
    ];
    const fallo = reglas.find((r) => r[1]);
    return fallo ? { campo: fallo[0], mensaje: fallo[2] } : null;
}

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
    const etiqueta = (p) => [p.nombre, p.color, p.calibre].filter(Boolean).join(' - ');

    function elegir(p) {
        sel = {
            id: p.id, stock: Number(p.cantidad) || 0, precioDetal: Number(p.precio_detal) || 0,
            precioMayor: Number(p.precio_mayor) || 0, cantidadMayor: Number(p.cantidad_mayor) || 0,
        };
        nombre.value = etiqueta(p);
        if (!(Number(cant.value) > 0)) cant.value = 1;
        precio.value = precioUnitario(Number(cant.value), sel).toFixed(2);
        actualizarTotal(); cerrar(); cant.select();
    }

    function pintar(resultados, texto) {
        const opciones = resultados.filter((p) => p?.id != null && etiqueta(p)).map((p) => {
            const mayor = Number(p.precio_mayor) > 0 && Number(p.cantidad_mayor) > 0;
            const stock = Number(p.cantidad) > 0 ? `Stock ${p.cantidad}` : 'Sin stock';
            const meta = `${usd(Number(p.precio_detal) || 0)}${mayor ? ` · mayor ${usd(p.precio_mayor)} desde ${p.cantidad_mayor}` : ''} · ${stock}`;
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

function filaProducto(p) {
    const tr = $('#tplFila').content.firstElementChild.cloneNode(true);
    const t = totalLinea(p);
    const set = (k, v) => { tr.querySelector(`[data-f=${k}]`).textContent = v; };
    tr.dataset.id = p.id;
    tr.classList.toggle('fila-nueva', p.id === state.nuevoId);
    set('cant', p.cantidad); set('nombre', p.nombre); set('pu', usd(p.precioUnitario));
    set('total', usd(t)); set('totalBs', bs(round2(t * state.tasa)));
    tr.querySelector('[data-f=bStock]').hidden = !(p.stock != null && p.cantidad > p.stock);
    return tr;
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

const mostrarPagoError = (msg, campoId) => {
    const err = $('#pagoError');
    err.textContent = msg; err.hidden = false;
    if (campoId) $(`#${campoId}`)?.focus();
};

const aPagarUsd = (t) => montoEnDolares(t, state.tasaUsdt, state.descuentoUsd);

/** Caja con el monto a cobrar en dólares y el detalle de la conversión (o el aviso de descuento desactivado). */
function htmlMontoDolares(t) {
    const aPagar = aPagarUsd(t);
    const ahorro = round2(t.total - aPagar);
    let detalle = '';
    if (!state.descuentoUsd) detalle = 'Descuento desactivado: se cobra el precio de lista.';
    else if (!(state.tasaUsdt > 0)) detalle = 'Ingresa la tasa USDT para aplicar la conversión.';
    else if (ahorro > 0) detalle = `Ahorro ${usd(ahorro)} · ${usd(t.total)}`;
    return `<div id="pagoMontoUsd" class="pago-monto"><small>Monto a pagar en dólares</small><strong>${usd(aPagar)}</strong>` +
        (detalle ? `<span class="pago-ahorro">${detalle}</span>` : '') + `</div>`;
}

/** Interruptor del descuento: actualiza el monto y el vuelto sin borrar lo que el vendedor ya escribió. */
function alternarDescuento(activo) {
    state.descuentoUsd = activo;
    state.idFactura = null; // cambió el cobro: el próximo envío usa un id nuevo
    $('#pagoError').hidden = true;
    const caja = $('#pagoMontoUsd');
    if (caja) caja.outerHTML = htmlMontoDolares(calcularTotales(state.items, state.tasa));
    $('#EDMontoRecibido')?.dispatchEvent(new Event('input')); // recalcula el vuelto
    renderResumen(); // el aside refleja el descuento activado o desactivado
    if ($('#metodoPago').value === 'MIXTO') actualizarMixto(); // cambia lo que abona cada pago en dólares
}

function selectMetodoPago(valor) {
    const cont = $('#paymentDetails');
    const t = calcularTotales(state.items, state.tasa);
    state.comprobante = null;
    $('#filaDescuento').hidden = !(METODOS_USD.has(valor) || valor === 'MIXTO');
    $('#descUsdt').checked = state.descuentoUsd;
    $('#pagoError').hidden = true;
    renderResumen(); // según el método, el aside muestra el total con descuento o el de lista

    const monto = (titulo, texto) => `<div class="pago-monto"><small>${titulo}</small><strong>${texto}</strong></div>`;
    const campo = (id, etiqueta, control, clase = '') =>
        `<div class="field ${clase}"><label for="${id}">${etiqueta}</label>${control}</div>`;
    // Opcional en todos los métodos, salvo "Otro" (ahí describe cómo se pagó y es obligatoria).
    const observaciones = (id, obligatoria = false) =>
        campo(id, obligatoria ? 'Observaciones' : 'Observaciones (opcional)',
            `<textarea id="${id}" rows="3" maxlength="500" ${obligatoria ? 'required' : ''} placeholder="${obligatoria ? 'Describe el método de pago…' : 'Detalla alguna novedad…'}"></textarea>`, 'span');
    const mixto = `${usd(t.total)} / ${bs(t.totalBs)}`;

    const comprobante = `<div class="field span"><span class="lbl">Comprobante de pago (opcional)</span>
         <input id="receiptCapture" type="file" accept="image/*" capture="environment" hidden>
         <button id="btnCapture" class="btn btn-ghost" type="button"><i class="fas fa-camera"></i> Adjuntar o tomar foto</button>
         <div id="receiptPreview" class="receipt-preview" hidden></div></div>`;

    if (valor === 'PM') {
        cont.innerHTML =
            monto('Monto a transferir', mixto) +
            campo('bankSelect', 'Banco destino',
                `<select id="bankSelect"><option value="" disabled selected>Seleccione un banco</option>` +
                BANCOS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('') + `</select>`) +
            campo('pmRef', 'Número de referencia',
                `<input id="pmRef" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="Últimos 4 a 12 dígitos">`);
    } else if (valor === 'PVD' || valor === 'PVC') {
        cont.innerHTML = monto('Monto a cobrar en el punto de venta', mixto);
    } else if (valor === 'ED') {
        cont.innerHTML =
            htmlMontoDolares(t) +
            campo('EDMontoRecibido', 'Monto recibido ($)', `<input id="EDMontoRecibido" type="number" min="0" step="0.01" inputmode="decimal" placeholder="ej: 20">`) +
            campo('EDVueltoEntrega', 'Vuelto a entregar ($)', `<input id="EDVueltoEntrega" readonly placeholder="0,00">`) +
            observaciones('observacionesED');
        activarVuelto($('#EDMontoRecibido'), $('#EDVueltoEntrega'), () => aPagarUsd(calcularTotales(state.items, state.tasa)), usd);
    } else if (valor === 'ZELLE' || valor === 'BINANCE') {
        cont.innerHTML =
            htmlMontoDolares(t) +
            campo('refDigital', valor === 'ZELLE' ? 'Número de confirmación' : 'ID de orden o referencia',
                `<input id="refDigital" autocomplete="off" autocapitalize="characters" maxlength="30" placeholder="4 a 30 letras o números">`) +
            comprobante +
            observaciones('observacionesDIG');
        activarComprobante();
    } else if (valor === 'EBS') {
        cont.innerHTML =
            monto('Monto a pagar', bs(t.totalBs)) +
            campo('EBSMontoRecibido', 'Monto recibido (Bs)', `<input id="EBSMontoRecibido" type="number" min="0" step="0.01" inputmode="decimal" placeholder="ej: 2500">`) +
            campo('EBSVueltoEntrega', 'Vuelto a entregar (Bs)', `<input id="EBSVueltoEntrega" readonly placeholder="0,00">`);
        activarVuelto($('#EBSMontoRecibido'), $('#EBSVueltoEntrega'), t.totalBs, bs);
    } else if (valor === 'OTROS') {
        cont.innerHTML = monto('Monto', mixto) + observaciones('observacionesOTROS', true);
    } else if (valor === 'MIXTO') {
        iniciarMixto(cont);
    }

    $('#pmRef')?.addEventListener('input', (e) => { e.target.value = soloDigitos(e.target.value); });
    $('#refDigital')?.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); });
}

function activarVuelto(entrada, salida, total, formato) {
    entrada.addEventListener('input', () => {
        const monto = typeof total === 'function' ? total() : total;
        salida.value = entrada.value === '' ? '' : formato(calcularVuelto(Number(entrada.value) || 0, monto));
    });
}

/** Reduce la foto a JPEG de máx. 1280 px (~150 KB) antes de enviarla. */
function comprimirImagen(archivo, maxLado = 1280, calidad = 0.72) {
    return new Promise((resolve, reject) => {
        if (!archivo.type.startsWith('image/')) return reject(new Error('El comprobante debe ser una imagen.'));
        const lector = new FileReader();
        lector.onerror = () => reject(new Error('No se pudo leer la imagen.'));
        lector.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('No se pudo abrir la imagen. Prueba con otra foto.'));
            img.onload = () => {
                const k = Math.min(1, maxLado / Math.max(img.width, img.height));
                const canvas = el('canvas', { width: Math.round(img.width * k), height: Math.round(img.height * k) });
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', calidad));
            };
            img.src = lector.result;
        };
        lector.readAsDataURL(archivo);
    });
}

function activarComprobante() {
    const input = $('#receiptCapture'), preview = $('#receiptPreview');
    $('#btnCapture').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
        state.comprobante = null;
        preview.hidden = true;
        preview.style.backgroundImage = '';
        const archivo = input.files?.[0];
        if (!archivo) return;
        try {
            state.comprobante = await comprimirImagen(archivo);
            preview.style.backgroundImage = `url("${state.comprobante}")`;
            preview.hidden = false;
            $('#pagoError').hidden = true;
        } catch (e) {
            input.value = '';
            mostrarPagoError(e.message);
        }
    });
}

/** Lee y valida el formulario de pago. Devuelve { pago } o { error, campo }. */
function leerPago() {
    const metodo = $('#metodoPago').value;
    const t = calcularTotales(state.items, state.tasa);
    const val = (id) => $(`#${id}`)?.value.trim() ?? '';
    const pago = { metodo_pago: metodo, banco: 'N/A', referencia: 'N/A', observaciones: '' };
    const aPagar = aPagarUsd(t);

    if (METODOS_USD.has(metodo)) {
        pago.aplicar_descuento = state.descuentoUsd; // el servidor lo valida y lo registra
        if (state.descuentoUsd) {
            if (!(state.tasaUsdt > 0)) return { error: 'Ingresa la tasa USDT o desactiva el descuento.', campo: 'tasaUsdt' };
            if (state.tasaUsdt > state.tasa * 2) return { error: 'La tasa USDT parece incorrecta (más del doble de la tasa BCV).', campo: 'tasaUsdt' };
            pago.tasa_usdt = state.tasaUsdt;
            pago.monto_usd = aPagar; // el servidor lo recalcula y rechaza si no cuadra
        }
    }

    if (metodo === 'PM') {
        pago.banco = val('bankSelect');
        pago.referencia = val('pmRef');
        if (!pago.banco) return { error: 'Selecciona el banco destino.', campo: 'bankSelect' };
        if (!pago.referencia) return { error: 'Ingresa el número de referencia.', campo: 'pmRef' };
        if (!/^\d{4,12}$/.test(pago.referencia)) return { error: 'La referencia debe tener entre 4 y 12 dígitos.', campo: 'pmRef' };
    } else if (metodo === 'ED' || metodo === 'EBS') {
        const id = metodo === 'ED' ? 'EDMontoRecibido' : 'EBSMontoRecibido';
        const total = metodo === 'ED' ? aPagar : t.totalBs;
        if (val(id) === '') return { error: 'Ingresa el monto recibido.', campo: id };
        const recibido = Number(val(id));
        if (!Number.isFinite(recibido) || recibido <= 0) return { error: 'El monto recibido no es válido.', campo: id };
        if (!(recibido >= total)) return { error: 'El monto recibido no cubre el total a pagar.', campo: id };
        pago.monto_recibido = recibido;
        if (metodo === 'ED') pago.observaciones = val('observacionesED');
    } else if (metodo === 'ZELLE' || metodo === 'BINANCE') {
        pago.referencia = val('refDigital');
        pago.observaciones = val('observacionesDIG');
        if (!pago.referencia) return { error: metodo === 'ZELLE' ? 'Ingresa el número de confirmación.' : 'Ingresa el ID de orden o referencia.', campo: 'refDigital' };
        if (!/^[A-Z0-9]{4,30}$/.test(pago.referencia)) return { error: 'La referencia debe tener entre 4 y 30 letras o números.', campo: 'refDigital' };
    } else if (metodo === 'OTROS') {
        pago.observaciones = val('observacionesOTROS');
        if (!pago.observaciones) return { error: 'Describe el método de pago en las observaciones.', campo: 'observacionesOTROS' };
    } else if (metodo === 'MIXTO') {
        return leerMixto(pago);
    }
    return { pago };
}

//--- PAGO COMBINADO (varios métodos, repetibles) ---//
// Cada pago se convierte a "dólares de lista" (tasa BCV) y la suma debe igualar el total.
// Debe coincidir con _validar_mixto en api/enviar-factura.py.
const MIXTO_MAX = 8;
const METODOS_MIXTO = [
    ['PM', 'Pago móvil'], ['PVD', 'Punto de venta (débito)'], ['PVC', 'Punto de venta (crédito)'],
    ['ED', 'Efectivo en divisas ($)'], ['ZELLE', 'Zelle'], ['BINANCE', 'Binance (USDT)'],
    ['EBS', 'Efectivo en bolívares (Bs)'], ['OTROS', 'Otros'],
];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toleranciaMixto = (n) => 0.02 + 0.01 * n;
const monedaLinea = (l) => (l.metodo === 'OTROS' ? l.otraMoneda : METODOS_USD.has(l.metodo) ? 'USD' : 'BS');
/** Cuánto vale cada $ de los métodos en dólares frente al precio de lista (USDT ÷ BCV, nunca menos de 1). */
const factorUsd = () => (state.descuentoUsd && state.tasaUsdt > 0 ? Math.max(1, state.tasaUsdt / state.tasa) : 1);

/** Cuánto abona un pago, en dólares de lista. */
function abonoLinea(l) {
    const m = Number(l.monto);
    if (!(m > 0)) return 0;
    if (monedaLinea(l) === 'BS') return m / state.tasa;
    return m * (METODOS_USD.has(l.metodo) ? factorUsd() : 1);
}

/** Lo que falta por cubrir (en dólares de lista); negativo si los pagos se pasan. */
const restanteMixto = () =>
    round2(calcularTotales(state.items, state.tasa).total - state.pagosMixtos.reduce((a, l) => a + abonoLinea(l), 0));

const nuevaLineaMixto = (metodo) => ({ id: ++state.mixtoSeq, metodo, otraMoneda: 'USD', monto: '', banco: '', referencia: '', obs: '' });

/** Rellena el monto de un pago con lo que falta, en la moneda de ese pago. */
function completarLineaMixto(l) {
    const faltante = restanteMixto() + abonoLinea(l);
    if (!(faltante > 0)) return;
    const nativo = monedaLinea(l) === 'BS' ? faltante * state.tasa : faltante / (METODOS_USD.has(l.metodo) ? factorUsd() : 1);
    l.monto = String(round2(nativo));
}

function htmlLineaMixto(l, n) {
    const id = (c) => `mx-${l.id}-${c}`;
    const moneda = monedaLinea(l);
    const campo = (c, etiqueta, control, clase = '') =>
        `<div class="field ${clase}"><label for="${id(c)}">${etiqueta}</label>${control}</div>`;
    const opMetodos = METODOS_MIXTO.map(([v, nombre]) => `<option value="${v}"${v === l.metodo ? ' selected' : ''}>${nombre}</option>`).join('');
    const opBancos = `<option value="" disabled${l.banco ? '' : ' selected'}>Seleccione un banco</option>` +
        BANCOS.map(([v, nombre]) => `<option value="${v}"${v === l.banco ? ' selected' : ''}>${nombre}</option>`).join('');

    let campos = '';
    if (l.metodo === 'OTROS') {
        campos += campo('otraMoneda', 'Moneda',
            `<select id="${id('otraMoneda')}" data-campo="otraMoneda"><option value="USD"${moneda === 'USD' ? ' selected' : ''}>Dólares ($)</option>` +
            `<option value="BS"${moneda === 'BS' ? ' selected' : ''}>Bolívares (Bs)</option></select>`);
    }
    campos += campo('monto', moneda === 'BS' ? 'Monto (Bs)' : 'Monto ($)',
        `<input id="${id('monto')}" data-campo="monto" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0,00" value="${esc(l.monto)}">`);
    if (l.metodo === 'PM') {
        campos += campo('banco', 'Banco destino', `<select id="${id('banco')}" data-campo="banco">${opBancos}</select>`);
        campos += campo('referencia', 'Número de referencia',
            `<input id="${id('referencia')}" data-campo="referencia" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="Últimos 4 a 12 dígitos" value="${esc(l.referencia)}">`);
    } else if (l.metodo === 'ZELLE' || l.metodo === 'BINANCE') {
        campos += campo('referencia', l.metodo === 'ZELLE' ? 'Número de confirmación' : 'ID de orden o referencia',
            `<input id="${id('referencia')}" data-campo="referencia" autocomplete="off" autocapitalize="characters" maxlength="30" placeholder="4 a 30 letras o números" value="${esc(l.referencia)}">`);
    }
    if (['ED', 'ZELLE', 'BINANCE', 'OTROS'].includes(l.metodo)) {
        const obligatoria = l.metodo === 'OTROS';
        campos += campo('obs', obligatoria ? 'Observaciones' : 'Observaciones (opcional)',
            `<textarea id="${id('obs')}" data-campo="obs" rows="2" maxlength="500" placeholder="${obligatoria ? 'Describe el método de pago…' : 'Detalla alguna novedad…'}">${esc(l.obs)}</textarea>`, 'span');
    }

    const quitar = state.pagosMixtos.length > 2
        ? `<button class="btn btn-ghost btn-mini" type="button" data-quitar aria-label="Quitar el pago ${n}"><i class="fas fa-trash"></i></button>` : '';
    return `<div class="pago-linea" data-id="${l.id}">` +
        `<div class="pago-linea-cab"><strong>Pago ${n}</strong>` +
        `<select id="${id('metodo')}" data-campo="metodo" aria-label="Método del pago ${n}">${opMetodos}</select>${quitar}</div>` +
        `<div class="grid-2">${campos}</div>` +
        `<div class="pago-linea-pie"><small data-equiv></small><button class="link" type="button" data-completar>Completar con el restante</button></div>` +
        `</div>`;
}

/** Actualiza "falta por cubrir" y lo que abona cada pago, sin repintar los campos (no pierde el foco). */
function actualizarMixto() {
    state.idFactura = null; // cambió el cobro: el próximo envío usa un id nuevo
    const caja = $('#mxRestante');
    if (!caja) return;
    const rest = restanteMixto();
    const estado = rest > toleranciaMixto(state.pagosMixtos.length) ? 'falta'
        : rest < -toleranciaMixto(state.pagosMixtos.length) ? 'sobra' : 'ok';
    caja.dataset.estado = estado;
    caja.querySelector('small').textContent = { falta: 'Falta por cubrir', sobra: 'Excede el total', ok: 'Pagos cubiertos' }[estado];
    caja.querySelector('strong').textContent = estado === 'ok' ? usd(0) : `${usd(Math.abs(rest))} / ${bs(round2(Math.abs(rest) * state.tasa))}`;
    for (const fila of document.querySelectorAll('.pago-linea')) {
        const l = state.pagosMixtos.find((x) => x.id === Number(fila.dataset.id));
        const abono = l ? abonoLinea(l) : 0;
        const conDescuento = l && METODOS_USD.has(l.metodo) && factorUsd() > 1;
        fila.querySelector('[data-equiv]').textContent =
            abono > 0 ? `Abona ${usd(round2(abono))} de la factura${conDescuento ? ' (con descuento)' : ''}` : '';
    }
}

function pintarLineasMixto() {
    const cont = $('#mxLineas');
    if (!cont) return;
    cont.innerHTML = state.pagosMixtos.map((l, i) => htmlLineaMixto(l, i + 1)).join('');
    $('#mxAgregar').disabled = state.pagosMixtos.length >= MIXTO_MAX;
    actualizarMixto();
}

function iniciarMixto(cont) {
    state.pagosMixtos = [nuevaLineaMixto('PM'), nuevaLineaMixto('ED')];
    const t = calcularTotales(state.items, state.tasa);
    // Contenedor nuevo en cada entrada: así sus listeners no se acumulan al cambiar de método.
    const raiz = el('div', { className: 'span mixto' });
    raiz.innerHTML =
        `<div class="pago-monto"><small>Total a cubrir</small><strong>${usd(t.total)} / ${bs(t.totalBs)}</strong></div>` +
        `<div id="mxRestante" class="pago-monto pago-restante" data-estado="falta"><small></small><strong></strong></div>` +
        `<div id="mxLineas" class="mx-lineas"></div>` +
        `<button id="mxAgregar" class="btn btn-ghost" type="button"><i class="fas fa-plus"></i> Agregar otro pago</button>`;
    cont.replaceChildren(raiz);

    const lineaDe = (nodo) => {
        const fila = nodo.closest('.pago-linea');
        return fila ? state.pagosMixtos.find((x) => x.id === Number(fila.dataset.id)) : null;
    };

    raiz.addEventListener('input', (e) => {
        const campo = e.target.dataset.campo;
        const l = campo ? lineaDe(e.target) : null;
        if (!l) return;
        if (campo === 'referencia') {
            e.target.value = l.metodo === 'PM' ? soloDigitos(e.target.value) : e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        }
        const monedaAntes = monedaLinea(l);
        l[campo] = e.target.value;
        $('#pagoError').hidden = true;
        if (campo === 'metodo') { l.banco = ''; l.referencia = ''; l.obs = ''; }
        if (campo === 'metodo' || campo === 'otraMoneda') {
            if (monedaLinea(l) !== monedaAntes) l.monto = ''; // el monto ya no está en la misma moneda
            pintarLineasMixto();
        } else {
            actualizarMixto();
        }
    });

    raiz.addEventListener('click', (e) => {
        if (e.target.closest('#mxAgregar')) {
            if (state.pagosMixtos.length >= MIXTO_MAX) return;
            const l = nuevaLineaMixto('PM');
            state.pagosMixtos.push(l);
            pintarLineasMixto();
            $(`#mx-${l.id}-monto`)?.focus();
            return;
        }
        const l = lineaDe(e.target);
        if (!l) return;
        if (e.target.closest('[data-quitar]')) {
            state.pagosMixtos = state.pagosMixtos.filter((x) => x !== l);
            pintarLineasMixto();
        } else if (e.target.closest('[data-completar]')) {
            completarLineaMixto(l);
            pintarLineasMixto();
        }
    });

    pintarLineasMixto();
}

/** Valida el pago combinado. Devuelve { pago } o { error, campo }. */
function leerMixto(pago) {
    const L = state.pagosMixtos;
    if (L.length < 2) return { error: 'Agrega al menos dos pagos. Si es un solo método, elígelo directamente.' };
    const pagos = [];
    for (const [i, l] of L.entries()) {
        const id = (c) => `mx-${l.id}-${c}`;
        const n = i + 1;
        const p = { metodo: l.metodo, moneda: monedaLinea(l), monto: 0, banco: 'N/A', referencia: 'N/A', observaciones: l.obs.trim() };
        if (l.monto === '') return { error: `Pago ${n}: ingresa el monto.`, campo: id('monto') };
        const monto = Number(l.monto);
        if (!Number.isFinite(monto) || monto <= 0) return { error: `Pago ${n}: el monto no es válido.`, campo: id('monto') };
        p.monto = round2(monto);

        if (l.metodo === 'PM') {
            if (!l.banco) return { error: `Pago ${n}: selecciona el banco destino.`, campo: id('banco') };
            if (!l.referencia) return { error: `Pago ${n}: ingresa el número de referencia.`, campo: id('referencia') };
            if (!/^\d{4,12}$/.test(l.referencia)) return { error: `Pago ${n}: la referencia debe tener entre 4 y 12 dígitos.`, campo: id('referencia') };
            p.banco = l.banco;
            p.referencia = l.referencia;
        } else if (l.metodo === 'ZELLE' || l.metodo === 'BINANCE') {
            if (!l.referencia) {
                return { error: `Pago ${n}: ${l.metodo === 'ZELLE' ? 'ingresa el número de confirmación' : 'ingresa el ID de orden o referencia'}.`, campo: id('referencia') };
            }
            if (!/^[A-Z0-9]{4,30}$/.test(l.referencia)) return { error: `Pago ${n}: la referencia debe tener entre 4 y 30 letras o números.`, campo: id('referencia') };
            p.referencia = l.referencia;
        } else if (l.metodo === 'OTROS' && !p.observaciones) {
            return { error: `Pago ${n}: describe el método de pago en las observaciones.`, campo: id('obs') };
        }
        pagos.push(p);
    }

    if (L.some((l) => METODOS_USD.has(l.metodo))) {
        pago.aplicar_descuento = state.descuentoUsd;
        if (state.descuentoUsd) {
            if (!(state.tasaUsdt > 0)) return { error: 'Ingresa la tasa USDT o desactiva el descuento.', campo: 'tasaUsdt' };
            if (state.tasaUsdt > state.tasa * 2) return { error: 'La tasa USDT parece incorrecta (más del doble de la tasa BCV).', campo: 'tasaUsdt' };
            pago.tasa_usdt = state.tasaUsdt;
        }
    }

    const rest = restanteMixto();
    const tol = toleranciaMixto(L.length);
    const ultimo = `mx-${L[L.length - 1].id}-monto`;
    if (rest > tol) return { error: `Falta por cubrir ${usd(rest)} (${bs(round2(rest * state.tasa))}). Ajusta los montos.`, campo: ultimo };
    if (rest < -tol) return { error: `Los pagos superan el total por ${usd(-rest)}. Ajusta los montos.`, campo: ultimo };

    pago.pagos = pagos;
    return { pago };
}

//--- 4. ENVIAR LA FACTURA ---//
function mostrarEstado(estado, mensaje) {
    const d = $('#dlgEstado');
    d.querySelectorAll('[data-estado]').forEach((s) => { s.hidden = s.dataset.estado !== estado; });
    if (mensaje) $('#estadoMsg').textContent = mensaje;
    if (!d.open) d.showModal();
}

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
        state.factura = { id: payload.id_factura, telefono, pdf: res.pdf === true, whatsapp: res.whatsapp ?? null };
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
const AVISOS_WA = {
    enviado: ['ok', 'La nota de entrega se envió por WhatsApp al cliente.'],
    sin_whatsapp: ['warn', 'Este número no tiene WhatsApp. Imprime la nota de entrega en formato carta.'],
    no_disponible: ['warn', 'No se pudo enviar por WhatsApp en este momento.'],
    no_configurado: ['warn', 'El envío por WhatsApp no está configurado.'],
};
// Con estos estados reintentar no sirve de nada: el cliente no tiene WhatsApp o el bot no está configurado.
const SIN_REINTENTO = new Set(['enviado', 'sin_whatsapp', 'no_configurado']);

function pintarExito() {
    const f = state.factura;
    const [tipo, texto] = AVISOS_WA[f.whatsapp] ?? ['warn', 'Esta factura ya estaba registrada. Puedes imprimirla o enviarla por WhatsApp.'];
    const aviso = $('#exitoWa');
    aviso.dataset.tipo = tipo;
    aviso.textContent = f.pdf ? texto : `${texto} No se pudo guardar el PDF para imprimirlo.`;
    $('#btnImprimir').hidden = !f.pdf;
    $('#btnReenviarWa').hidden = !f.pdf || SIN_REINTENTO.has(f.whatsapp);
}

// Abre el PDF en una pestaña nueva; desde el visor se imprime (el PDF ya es tamaño carta).
function imprimirFactura() {
    if (state.factura?.pdf) window.open(urlPdfFactura(state.factura.id), '_blank', 'noopener');
}

async function reintentarWhatsapp() {
    const f = state.factura;
    const btn = $('#btnReenviarWa');
    btn.disabled = true;
    try {
        f.whatsapp = await reenviarWhatsapp(f.id, f.telefono);
    } catch (e) {
        console.error('Error al reenviar por WhatsApp:', e);
        f.whatsapp = 'no_disponible';
    } finally {
        btn.disabled = false;
    }
    pintarExito();
}

//--- INICIO ---//
async function init() {
    // auth-guard.js redirige a /login.html si no hay sesión
    if (window.Auth && !(await window.Auth.listo)) return;

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
