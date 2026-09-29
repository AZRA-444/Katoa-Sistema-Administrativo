/* ============================================================================
 * Facturación — Katoa
 * Flujo: 1) datos del cliente  2) tasa y productos  3) pago  4) enviar
 * Formateadores → utils/format.js · Llamadas al servidor → utils/api.js
 * ========================================================================== */
import { FORMATTERS, usd, bs, round2, soloDigitos, telefonoE164 } from './utils/format.js';
import { buscarProductos, buscarCliente, guardarCliente, obtenerTasa, enviarFactura } from './utils/api.js';

//--- CONSTANTES ---//
const STORAGE = { vendedor: 'vendedorActual', tasa: 'tasaFacturacion' };
const BANCOS = [
    ['Banesco', 'Banesco'],
    ['Venezuela', 'Banco de Venezuela'],
    ['Provincial', 'Provincial'],
    ['Banplus', 'Banplus'],
];

// [monto mínimo (exclusivo), % de descuento], de mayor a menor.
// Debe coincidir con DESCUENTOS en api/enviar-factura.py (el servidor recalcula y rechaza si no cuadra).
export const DESCUENTOS = [[100, 25], [50, 20], [20, 15]];

//--- ESTADO ---//
const state = {
    items: [],            // productos de la factura
    tasa: 0,              // Bs por $
    tasaManual: false,    // true si el vendedor la escribió a mano
    cliente: null,        // datos ya validados del cliente
    comprobante: null,    // foto del pago móvil (data URL JPEG comprimido)
    idFactura: null,      // se conserva entre reintentos para no duplicar la factura
    enviando: false,
};
let seq = 0;

const $ = (sel, raiz = document) => raiz.querySelector(sel);
function el(tag, props = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) (k in n ? (n[k] = v) : n.setAttribute(k, v));
    n.append(...hijos);
    return n;
}

//--- CÁLCULOS (funciones puras, sin DOM) ---//
export const totalLinea = (p) => round2(p.cantidad * p.precioUnitario);

/** Precio al mayor si la cantidad alcanza el umbral; si no, precio al detal. */
export function precioUnitario(cantidad, { precioDetal, precioMayor, cantidadMayor }) {
    return precioMayor > 0 && cantidadMayor > 0 && cantidad >= cantidadMayor ? precioMayor : precioDetal;
}

export const porcentajeDescuento = (base) => DESCUENTOS.find(([min]) => base > min)?.[1] ?? 0;

/** Solo se guarda USD; los Bs se derivan de la tasa vigente. Los excluidos no reciben descuento. */
export function calcularTotales(items, tasa) {
    const suma = (lista) => round2(lista.reduce((a, p) => a + totalLinea(p), 0));
    const subtotal = suma(items);
    const base = suma(items.filter((p) => !p.excluidoDescuento));
    const porcentaje = porcentajeDescuento(base);
    const descuento = round2((base * porcentaje) / 100);
    const total = round2(subtotal - descuento);
    const aBs = (n) => round2(n * tasa);
    return {
        subtotal, porcentaje, descuento, total,
        subtotalBs: aBs(subtotal), descuentoBs: aBs(descuento), totalBs: aBs(total),
    };
}

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

    async function autorrellenar(cedula) {
        const c = await buscarCliente(cedula);
        if (!c) return;
        // Solo completa campos vacíos: nunca pisa lo que el vendedor ya escribió.
        if (c.nombre && !f.nombre.value) f.nombre.value = FORMATTERS.text(c.nombre);
        if (c.apellido && !f.apellido.value) f.apellido.value = FORMATTERS.text(c.apellido);
        if (c.telefono && !f.telefono.value)
            f.telefono.value = FORMATTERS.phone(String(c.telefono).replace(/\D/g, '').replace(/^58/, '0'));
    }

    form.addEventListener('input', (e) => {
        err.hidden = true;
        const formatear = FORMATTERS[e.target.dataset.format];
        if (formatear) e.target.value = formatear(e.target.value);
        if (e.target === f.cedula) {
            clearTimeout(timer);
            const digitos = soloDigitos(f.cedula.value);
            if (digitos.length >= 6) timer = setTimeout(() => autorrellenar(digitos), 400);
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
            stock: sel ? sel.stock : null, excluidoDescuento: false,
        });
        renderFactura();
        form.reset(); sel = null; total.value = '—'; cerrar(); nombre.focus();
    });
}

//--- 2c. TABLA, DESCUENTOS Y TOTALES ---//
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
        } else if (b.dataset.act === 'toggle') {
            p.excluidoDescuento = !p.excluidoDescuento;
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
    tr.classList.toggle('excluida', p.excluidoDescuento);
    set('cant', p.cantidad); set('nombre', p.nombre); set('pu', usd(p.precioUnitario));
    set('total', usd(t)); set('totalBs', bs(round2(t * state.tasa)));
    tr.querySelector('[data-f=bDesc]').hidden = !p.excluidoDescuento;
    tr.querySelector('[data-f=bStock]').hidden = !(p.stock != null && p.cantidad > p.stock);
    const btn = tr.querySelector('[data-act=toggle]');
    const txt = p.excluidoDescuento ? 'Volver a incluir en el descuento' : 'Excluir del descuento';
    btn.title = txt; btn.setAttribute('aria-label', txt); btn.setAttribute('aria-pressed', p.excluidoDescuento);
    btn.firstElementChild.className = `fa-solid ${p.excluidoDescuento ? 'fa-rotate-left' : 'fa-tag'}`;
    return tr;
}

/** Repinta tabla y totales. Se llama tras cualquier cambio de productos o tasa. */
function renderFactura() {
    const t = calcularTotales(state.items, state.tasa);
    state.idFactura = null; // la factura cambió: el próximo envío usa un id nuevo
    $('#filas').replaceChildren(...state.items.map(filaProducto));
    $('#tablaWrap').hidden = !state.items.length;
    $('#vacio').hidden = !!state.items.length;
    $('#cuenta').textContent = state.items.length;
    $('#rSub').hidden = $('#rDesc').hidden = !t.porcentaje;
    $('#tSub').textContent = usd(t.subtotal);
    $('#tDescLabel').textContent = `Descuento (${t.porcentaje}%)`;
    $('#tDesc').textContent = '−' + usd(t.descuento);
    $('#tTotal').textContent = usd(t.total);
    $('#tTotalBs').textContent = bs(t.totalBs);
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
    $('#tasa').readOnly = true; // con la tasa fija, los montos del pago no cambian
    selectMetodoPago($('#metodoPago').value);
}

function ocultarSeccionPagos() {
    $('#seccionProducto').hidden = false;
    $('#seccionFactura').hidden = false;
    $('#seccionPago').hidden = true;
    $('#btnProcesar').hidden = false;
    $('#tasa').readOnly = false;
}

const mostrarPagoError = (msg, campoId) => {
    const err = $('#pagoError');
    err.textContent = msg; err.hidden = false;
    if (campoId) $(`#${campoId}`)?.focus();
};

function selectMetodoPago(valor) {
    const cont = $('#paymentDetails');
    const t = calcularTotales(state.items, state.tasa);
    state.comprobante = null;
    $('#pagoError').hidden = true;

    const monto = (titulo, texto) => `<div class="pago-monto"><small>${titulo}</small><strong>${texto}</strong></div>`;
    const campo = (id, etiqueta, control, clase = '') =>
        `<div class="field ${clase}"><label for="${id}">${etiqueta}</label>${control}</div>`;
    const observaciones = (id) =>
        campo(id, 'Observaciones', `<textarea id="${id}" rows="3" maxlength="500" placeholder="Detalla alguna novedad…"></textarea>`, 'span');
    const mixto = `${usd(t.total)} / ${bs(t.totalBs)}`;

    if (valor === 'PM') {
        cont.innerHTML =
            monto('Monto a transferir', mixto) +
            campo('bankSelect', 'Banco destino',
                `<select id="bankSelect"><option value="" disabled selected>Seleccione un banco</option>` +
                BANCOS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('') + `</select>`) +
            campo('pmRef', 'Número de referencia',
                `<input id="pmRef" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="Últimos 4 a 12 dígitos">`) +
            `<div class="field span"><span class="lbl">Comprobante de pago (opcional)</span>
         <input id="receiptCapture" type="file" accept="image/*" capture="environment" hidden>
         <button id="btnCapture" class="btn btn-ghost" type="button"><i class="fas fa-camera"></i> Adjuntar o tomar foto</button>
         <div id="receiptPreview" class="receipt-preview" hidden></div></div>`;
        activarComprobante();
    } else if (valor === 'PVD' || valor === 'PVC') {
        cont.innerHTML = monto('Monto a cobrar en el punto de venta', mixto);
    } else if (valor === 'ED') {
        cont.innerHTML =
            monto('Monto a pagar', usd(t.total)) +
            campo('EDMontoRecibido', 'Monto recibido ($)', `<input id="EDMontoRecibido" type="number" min="0" step="0.01" inputmode="decimal" placeholder="ej: 20">`) +
            campo('EDVueltoEntrega', 'Vuelto a entregar ($)', `<input id="EDVueltoEntrega" readonly placeholder="0,00">`) +
            observaciones('observacionesED');
        activarVuelto($('#EDMontoRecibido'), $('#EDVueltoEntrega'), t.total, usd);
    } else if (valor === 'EBS') {
        cont.innerHTML =
            monto('Monto a pagar', bs(t.totalBs)) +
            campo('EBSMontoRecibido', 'Monto recibido (Bs)', `<input id="EBSMontoRecibido" type="number" min="0" step="0.01" inputmode="decimal" placeholder="ej: 2500">`) +
            campo('EBSVueltoEntrega', 'Vuelto a entregar (Bs)', `<input id="EBSVueltoEntrega" readonly placeholder="0,00">`);
        activarVuelto($('#EBSMontoRecibido'), $('#EBSVueltoEntrega'), t.totalBs, bs);
    } else if (valor === 'OTROS') {
        cont.innerHTML = monto('Monto', mixto) + observaciones('observacionesOTROS');
    }

    $('#pmRef')?.addEventListener('input', (e) => { e.target.value = soloDigitos(e.target.value); });
}

function activarVuelto(entrada, salida, total, formato) {
    entrada.addEventListener('input', () => {
        salida.value = entrada.value === '' ? '' : formato(calcularVuelto(Number(entrada.value) || 0, total));
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

    if (metodo === 'PM') {
        pago.banco = val('bankSelect');
        pago.referencia = val('pmRef');
        if (!pago.banco) return { error: 'Selecciona el banco destino.', campo: 'bankSelect' };
        if (!/^\d{4,12}$/.test(pago.referencia)) return { error: 'La referencia debe tener entre 4 y 12 dígitos.', campo: 'pmRef' };
    } else if (metodo === 'ED' || metodo === 'EBS') {
        const id = metodo === 'ED' ? 'EDMontoRecibido' : 'EBSMontoRecibido';
        const total = metodo === 'ED' ? t.total : t.totalBs;
        if (val(id) !== '') {
            const recibido = Number(val(id));
            if (!(recibido >= total)) return { error: 'El monto recibido no cubre el total de la factura.', campo: id };
            pago.monto_recibido = recibido;
        }
        if (metodo === 'ED') pago.observaciones = val('observacionesED');
    } else if (metodo === 'OTROS') {
        pago.observaciones = val('observacionesOTROS');
        if (!pago.observaciones) return { error: 'Describe el método de pago en las observaciones.', campo: 'observacionesOTROS' };
    }
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
        nombre: c.nombre, apellido: c.apellido, cedula: c.cedula, telefono, vendedor: c.vendedor,
        tasa_cambio: state.tasa,
        subtotal_usd: t.subtotal, descuento_usd: t.descuento, total_usd: t.total,
        subtotal_bs: t.subtotalBs, descuento_bs: t.descuentoBs, total_bs: t.totalBs,
        ...lectura.pago,
        comprobante: lectura.pago.metodo_pago === 'PM' ? state.comprobante : null,
        productos: state.items.map((p) => ({
            nombre: p.nombre, cantidad: p.cantidad, precioUnitario: p.precioUnitario,
            precioTotal: totalLinea(p), excluidoDescuento: p.excluidoDescuento, idInventario: p.idInventario,
        })),
    };

    state.enviando = true;
    $('#btnFinalizar').disabled = true;
    $('#pagoError').hidden = true;
    mostrarEstado('cargando');
    try {
        await enviarFactura(payload);
        mostrarEstado('exito');
        guardarCliente({ cedula: soloDigitos(c.cedula), nombre: c.nombre, apellido: c.apellido, telefono });
        state.items = []; // sin productos, el aviso de salida ya no aplica
        setTimeout(() => location.reload(), 1800);
    } catch (e) {
        console.error('Error en finalizarCompra:', e);
        mostrarEstado('error', e.message);
        state.enviando = false;
        $('#btnFinalizar').disabled = false;
    }
}

//--- INICIO ---//
async function init() {
    // auth-guard.js redirige a /login.html si no hay sesión
    if (window.Auth && !(await window.Auth.listo)) return;

    initTasa();
    initCliente();
    initProducto();
    initFactura();
    renderFactura();

    $('#btnProcesar').addEventListener('click', mostrarSeccionPago);
    $('#btnVolver').addEventListener('click', ocultarSeccionPagos);
    $('#btnFinalizar').addEventListener('click', finalizarCompra);
    $('#metodoPago').addEventListener('change', (e) => selectMetodoPago(e.target.value));

    const dlgEstado = $('#dlgEstado');
    dlgEstado.addEventListener('cancel', (e) => { if (state.enviando) e.preventDefault(); });
    $('#btnEstadoCerrar').addEventListener('click', () => dlgEstado.close());

    document.addEventListener('click', (e) => { if (e.target.closest('[data-open-cliente]')) abrirCliente(); });
    window.addEventListener('beforeunload', (e) => {
        if (state.items.length) { e.preventDefault(); e.returnValue = ''; }
    });
}

// En el navegador arranca solo; en Node (tests) solo se importan las funciones puras.
if (typeof document !== 'undefined') init();