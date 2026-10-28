/* ============================================================================
 * Venta — lógica COMPARTIDA por Facturación (facturacion.js) y Pedidos (pedidos.js)
 *
 * Antes estas constantes y funciones estaban copiadas en los dos módulos y empezaron a divergir (por ejemplo,
 * la lista de BANCOS). Aquí vive UNA sola copia:
 *   · constantes (métodos de pago, bancos, crédito, avisos de WhatsApp)
 *   · utilidades de DOM y de cálculo que no dependen del estado de ningún módulo
 *   · crearPagoMixto(state, obtenerItems): las funciones del pago combinado y del cobro en dólares, que leen
 *     el `state` de CADA módulo (tasa, tasaUsdt, descuentoUsd, pagosMixtos…). Cada módulo conserva su propio estado.
 *
 * Las reglas del pago combinado deben coincidir con _validar_mixto en api/enviar-factura.py.
 * ========================================================================== */
import { usd, bs, round2, soloDigitos, hoyISO, sumarDias, fechaISO } from './format.js';
import { urlPdfFactura, reenviarWhatsapp } from './api.js';

export const AVISOS_WA = {
    enviado: ['ok', 'La nota de entrega se envió por WhatsApp al cliente.'],
    sin_whatsapp: ['warn', 'Este número no tiene WhatsApp. Imprime la nota de entrega en formato carta.'],
    no_disponible: ['warn', 'No se pudo enviar por WhatsApp en este momento.'],
    no_configurado: ['warn', 'El envío por WhatsApp no está configurado.'],
};

// Crédito (fiado): el cliente se lleva la mercancía y paga después, dentro de un plazo en días. La deuda
// queda en el módulo Cobros. Reglas (plazo máximo, quién puede usarlo): las manda /api/sesion y las exige el servidor.
export const CREDITO = 'CREDITO';

export const METODOS_COMPROBANTE = new Set(['ZELLE', 'BINANCE']); // el pago móvil NO sube comprobante

export const METODOS_MIXTO = [
    ['PM', 'Pago móvil'], ['PVD', 'Punto de venta (débito)'], ['PVC', 'Punto de venta (crédito)'],
    ['ED', 'Efectivo en divisas ($)'], ['ZELLE', 'Zelle'], ['BINANCE', 'Binance (USDT)'],
    ['EBS', 'Efectivo en bolívares (Bs)'], ['OTROS', 'Otros'],
];

// Métodos que se cobran en dólares: el total se convierte con la tasa USDT (ver montoEnDolares).
export const METODOS_USD = new Set(['ED', 'ZELLE', 'BINANCE']);

// Cada pago se convierte a "dólares de lista" (tasa BCV) y la suma debe igualar el total.
// Debe coincidir con _validar_mixto en api/enviar-factura.py.
export const MIXTO_MAX = 8;

export const PLAZO_DEFECTO = 15;

// Con estos estados reintentar no sirve de nada: el cliente no tiene WhatsApp o el bot no está configurado.
export const SIN_REINTENTO = new Set(['enviado', 'sin_whatsapp', 'no_configurado']);

export const BANCOS = [
    ['Banesco', 'Banesco', '0134'],
    ['Venezuela', 'Banco de Venezuela', '0102'],
    ['Provincial', 'Provincial', '0108'],
    ['Banplus', 'Banplus', '0174'],
];

export const $ = (sel, raiz = document) => raiz.querySelector(sel);

/** Solo se guarda USD; los Bs se derivan de la tasa vigente. El servidor recalcula y rechaza si no cuadra. */
export function calcularTotales(items, tasa) {
    const total = round2(items.reduce((a, p) => a + totalLinea(p), 0));
    return { total, totalBs: round2(total * tasa) };
}

export const calcularVuelto = (recibido, total) => (recibido >= total ? round2(recibido - total) : 0);

/** Reduce la foto a JPEG de máx. 1280 px (~150 KB) antes de enviarla. */
export function comprimirImagen(archivo, maxLado = 1280, calidad = 0.72) {
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

export function el(tag, props = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) (k in n ? (n[k] = v) : n.setAttribute(k, v));
    n.append(...hijos);
    return n;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Fecha límite (DD/MM/AAAA, hora de Venezuela) para un plazo en días, o null si el plazo no es válido. */
export function fechaLimiteCredito(dias) {
    return Number.isInteger(dias) && dias >= 1 && dias <= plazoMax() ? fechaISO(sumarDias(hoyISO(), dias)) : null;
}

export const monedaLinea = (l) => (l.metodo === 'OTROS' ? l.otraMoneda : METODOS_USD.has(l.metodo) ? 'USD' : 'BS');

/**
 * Monto a cobrar cuando se paga en dólares (efectivo, Zelle, Binance):
 * total en Bs (tasa BCV) ÷ tasa USDT. Ej.: 100$ × 857,89 = 85.789 Bs ÷ 960 = 89,36$.
 * Nunca supera el total (si USDT < BCV no hay recargo). Con activo = false se cobra el total de lista, sin conversión.
 * Debe coincidir con monto_en_dolares en api/enviar-factura.py.
 */
export const montoEnDolares = (t, tasaUsdt, activo = true) =>
    activo && tasaUsdt > 0 ? Math.min(t.total, round2(t.totalBs / tasaUsdt)) : t.total;

export const plazoMax = () => Number(window.Auth?.credito?.plazo_max_dias) || 90;

/** Gran mayor si alcanza su umbral; si no, mayor si alcanza el suyo; si no, detal. */
export function precioUnitario(cantidad, { precioDetal, precioMayor, cantidadMayor, precioGranMayor = 0, cantidadGranMayor = 0 }) {
    if (precioGranMayor > 0 && cantidadGranMayor > 0 && cantidad >= cantidadGranMayor) return precioGranMayor;
    return precioMayor > 0 && cantidadMayor > 0 && cantidad >= cantidadMayor ? precioMayor : precioDetal;
}

/** Cambia el texto y, solo si cambió, reinicia el "latido" (clase .pulso). */
export function pulso(nodo, texto) {
    if (nodo.textContent === texto) return;
    nodo.textContent = texto;
    nodo.classList.remove('pulso');
    void nodo.offsetWidth; // reinicia la animación
    nodo.classList.add('pulso');
}

export const toleranciaMixto = (n) => 0.02 + 0.01 * n;

export const totalLinea = (p) => round2(p.cantidad * p.precioUnitario);

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

export function activarVuelto(entrada, salida, total, formato) {
    entrada.addEventListener('input', () => {
        const monto = typeof total === 'function' ? total() : total;
        salida.value = entrada.value === '' ? '' : formato(calcularVuelto(Number(entrada.value) || 0, monto));
    });
}

export function activarCredito() {
    const entrada = $('#creditoDias'), vence = $('#creditoVence');
    const pintar = () => { vence.textContent = fechaLimiteCredito(Number(entrada.value)) ?? '—'; };
    entrada.addEventListener('input', pintar);
    pintar();
}

export function mostrarEstado(estado, mensaje) {
    const d = $('#dlgEstado');
    d.querySelectorAll('[data-estado]').forEach((s) => { s.hidden = s.dataset.estado !== estado; });
    if (mensaje) $('#estadoMsg').textContent = mensaje;
    if (!d.open) d.showModal();
}

export const mostrarPagoError = (msg, campoId) => {
    const err = $('#pagoError');
    err.textContent = msg; err.hidden = false;
    if (campoId) $(`#${campoId}`)?.focus();
};

/**
 * Funciones del cobro (pago en dólares, pago combinado, pantalla de éxito) que leen el estado del módulo que las usa.
 *   state          { tasa, tasaUsdt, descuentoUsd, pagosMixtos, mixtoSeq, comprobante, factura, … } de ese módulo
 *   ganchos:
 *     obtenerItems  () => productos de la venta actual (en pedidos cambia con el pedido seleccionado)
 *     invalidarId   () => el cobro cambió: el próximo envío debe usar un id de factura nuevo
 *     renderResumen () => repinta el total del módulo (cada uno decide cuándo está «en pago»)
 *     deDocumento   'de la factura' | 'del pedido' (texto del aviso de abono)
 */
export function crearPagoMixto(state, { obtenerItems, invalidarId, renderResumen, deDocumento }) {
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
        round2(calcularTotales(obtenerItems(), state.tasa).total - state.pagosMixtos.reduce((a, l) => a + abonoLinea(l), 0));

    const nuevaLineaMixto = (metodo) => ({ id: ++state.mixtoSeq, metodo, otraMoneda: 'USD', monto: '', banco: '', referencia: '', obs: '' });

    /** Rellena el monto de un pago con lo que falta, en la moneda de ese pago. */
    function completarLineaMixto(l) {
        const faltante = restanteMixto() + abonoLinea(l);
        if (!(faltante > 0)) return;
        const nativo = monedaLinea(l) === 'BS' ? faltante * state.tasa : faltante / (METODOS_USD.has(l.metodo) ? factorUsd() : 1);
        l.monto = String(round2(nativo));
    }

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


    function selectMetodoPago(valor) {
        const cont = $('#paymentDetails');
        const t = calcularTotales(obtenerItems(), state.tasa);
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
            activarVuelto($('#EDMontoRecibido'), $('#EDVueltoEntrega'), () => aPagarUsd(calcularTotales(obtenerItems(), state.tasa)), usd);
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
        } else if (valor === CREDITO) {
            const max = plazoMax();
            cont.innerHTML =
                monto('Se carga a la cuenta del cliente', mixto) +
                campo('creditoDias', `Días para pagar (máx. ${max})`,
                    `<input id="creditoDias" type="number" min="1" max="${max}" step="1" inputmode="numeric" value="${Math.min(PLAZO_DEFECTO, max)}">`) +
                `<div class="pago-monto"><small>Fecha límite de pago</small><strong id="creditoVence">—</strong>` +
                `<span class="pago-ahorro">Queda por cobrar en el módulo Cobros. No entra a caja hoy.</span></div>` +
                observaciones('observacionesCRED');
            activarCredito();
        } else if (valor === 'MIXTO') {
            iniciarMixto(cont);
        }

        $('#pmRef')?.addEventListener('input', (e) => { e.target.value = soloDigitos(e.target.value); });
        $('#refDigital')?.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); });
    }

    /** Lee y valida el formulario de pago. Devuelve { pago } o { error, campo }. */
    function leerPago() {
        const metodo = $('#metodoPago').value;
        const t = calcularTotales(obtenerItems(), state.tasa);
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
        } else if (metodo === CREDITO) {
            const dias = Number(val('creditoDias'));
            if (!Number.isInteger(dias) || dias < 1) return { error: 'Indica cuántos días tiene el cliente para pagar.', campo: 'creditoDias' };
            if (dias > plazoMax()) return { error: `El plazo máximo del crédito es de ${plazoMax()} días.`, campo: 'creditoDias' };
            pago.plazo_dias = dias;
            pago.observaciones = val('observacionesCRED');
        } else if (metodo === 'MIXTO') {
            return leerMixto(pago);
        }
        return { pago };
    }

    function iniciarMixto(cont) {
        state.pagosMixtos = [nuevaLineaMixto('PM'), nuevaLineaMixto('ED')];
        const t = calcularTotales(obtenerItems(), state.tasa);
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

    /** Actualiza "falta por cubrir" y lo que abona cada pago, sin repintar los campos (no pierde el foco). */
    function actualizarMixto() {
        invalidarId();
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
                abono > 0 ? `Abona ${usd(round2(abono))} ${deDocumento}${conDescuento ? ' (con descuento)' : ''}` : '';
        }
    }

    /** Interruptor del descuento: actualiza el monto y el vuelto sin borrar lo que el vendedor ya escribió. */
    function alternarDescuento(activo) {
        state.descuentoUsd = activo;
        invalidarId();
        $('#pagoError').hidden = true;
        const caja = $('#pagoMontoUsd');
        if (caja) caja.outerHTML = htmlMontoDolares(calcularTotales(obtenerItems(), state.tasa));
        $('#EDMontoRecibido')?.dispatchEvent(new Event('input')); // recalcula el vuelto
        renderResumen(); // el aside refleja el descuento activado o desactivado
        if ($('#metodoPago').value === 'MIXTO') actualizarMixto(); // cambia lo que abona cada pago en dólares
    }

    function pintarLineasMixto() {
        const cont = $('#mxLineas');
        if (!cont) return;
        cont.innerHTML = state.pagosMixtos.map((l, i) => htmlLineaMixto(l, i + 1)).join('');
        $('#mxAgregar').disabled = state.pagosMixtos.length >= MIXTO_MAX;
        actualizarMixto();
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

    function pintarExito() {
        const f = state.factura;
        const [tipo, texto] = AVISOS_WA[f.whatsapp] ?? ['warn', 'Esta factura ya estaba registrada. Puedes imprimirla o enviarla por WhatsApp.'];
        const aviso = $('#exitoWa');
        aviso.dataset.tipo = tipo;
        aviso.textContent = f.pdf ? texto : `${texto} No se pudo guardar el PDF para imprimirlo.`;
        $('#btnImprimir').hidden = !f.pdf;
        $('#btnReenviarWa').hidden = !f.pdf || SIN_REINTENTO.has(f.whatsapp);
        const cred = $('#exitoCredito');
        cred.hidden = !f.credito;
        if (f.credito) cred.textContent = `Venta a crédito: el cliente tiene ${f.credito.dias} día${f.credito.dias === 1 ? '' : 's'} para pagar (hasta el ${f.credito.vence}). Se cobra en el módulo Cobros.`;
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

    // Abre el PDF en una pestaña nueva; desde el visor se imprime (el PDF ya es tamaño carta).
    function imprimirFactura() {
        if (state.factura?.pdf) window.open(urlPdfFactura(state.factura.id), '_blank', 'noopener');
    }

    return { factorUsd, abonoLinea, restanteMixto, nuevaLineaMixto, completarLineaMixto, aPagarUsd, htmlMontoDolares, htmlLineaMixto, leerMixto, activarComprobante, selectMetodoPago, leerPago, iniciarMixto, actualizarMixto, alternarDescuento, pintarLineasMixto, filaProducto, pintarExito, reintentarWhatsapp, imprimirFactura };
}
