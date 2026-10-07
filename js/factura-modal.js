/* ==========================================================================
 * Vista previa de factura (modal) — Katoa
 * Independiente de la página: crea su propio modal y sus estilos al usarse.
 *
 * Uso en cualquier página (Administrador, historial…):
 *   1) <script type="module" src="../../js/factura-modal.js"></script>
 *   2) un botón con el número de factura:   <button type="button" data-ver-factura="FAC-123">Vista previa</button>
 *      (también sirve desde JS:  import { abrirFactura } from './factura-modal.js';  abrirFactura('FAC-123');)
 *   3) opcional, para refrescar tu tabla cuando se anula una factura:
 *      document.addEventListener('factura:anulada', (e) => recargarTabla(e.detail.id));
 *
 * Acciones: ver e imprimir PDF, reenviar por WhatsApp, ver comprobante y anular (solo admin; devuelve el stock).
 * Servidor: /api/historial (factura, comprobante, anular) y /api/factura-pdf (PDF y WhatsApp).
 * ========================================================================== */
import { usd, bs } from './utils/format.js';
import { urlPdfFactura, reenviarWhatsapp } from './utils/api.js';

const API = '/api/historial';
const METODOS = {
    MIXTO: 'Pago combinado', PM: 'Pago móvil', PVD: 'Punto de venta (débito)', PVC: 'Punto de venta (crédito)',
    ED: 'Efectivo en dólares', EBS: 'Efectivo en bolívares', ZELLE: 'Zelle', BINANCE: 'Binance', OTROS: 'Otros',
};
const AVISOS_WA = {
    enviado: ['La factura se envió por WhatsApp al cliente.', false],
    sin_whatsapp: ['Este número no tiene WhatsApp. Imprime la factura en formato carta.', true],
    no_disponible: ['No se pudo enviar por WhatsApp en este momento. Inténtalo de nuevo.', true],
    no_configurado: ['El envío por WhatsApp no está configurado en el servidor.', true],
};

const $ = (sel) => document.querySelector(sel);
function el(tag, props = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) (k in n && k !== 'list' ? (n[k] = v) : n.setAttribute(k, v));
    n.append(...hijos);
    return n;
}
const metodo = (m) => METODOS[m] ?? m ?? '—';
const fechaHora = (iso) => new Date(iso).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Caracas' });
const nombreCliente = (f) => [f.nombre, f.apellido].filter(Boolean).join(' ');
const dato = (v) => (v && v !== 'N/A' ? v : null);
const soloDig = (s) => String(s ?? '').replace(/\D/g, '');

let factura = null, opciones = {}, avisoT, montado = false;

//--- Comunicación con el servidor ---//
export async function api(url, cuerpo, reintentar = true) {
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
    const d = await r.json().catch(() => null);
    if (!r.ok || d?.status !== 'ok') throw new Error(d?.message || d?.error || 'No se pudo completar la operación.');
    return d;
}

const ocultarAviso = () => {
    const n = $('#fmAviso');
    n.hidden = true;
    try { n.hidePopover(); } catch { /* ya estaba oculto */ }
};

/** Aviso temporal. Es un «popover» para que se vea POR ENCIMA de los modales abiertos. */
export function aviso(msg, error = false) {
    montar();
    const n = $('#fmAviso');
    n.textContent = msg; n.hidden = false;
    n.classList.toggle('fm-error', error);
    n.setAttribute('aria-live', error ? 'assertive' : 'polite');
    try { n.hidePopover(); n.showPopover(); } catch { /* navegador sin popover: se ve igual si no hay modal abierto */ }
    clearTimeout(avisoT); avisoT = setTimeout(ocultarAviso, error ? 7000 : 4500);
}

//--- Estructura (se crea una sola vez) ---//
function montar() {
    if (montado) return;
    montado = true;
    document.head.append(el('link', { rel: 'stylesheet', href: new URL('../assets/css/factura-modal.css', import.meta.url).href }));
    document.body.insertAdjacentHTML('beforeend', `
<dialog class="fm-dlg" id="fmFactura" aria-labelledby="fmTitulo">
  <div class="fm-det">
    <div class="fm-cab">
      <div><h2 id="fmTitulo">Factura</h2><p class="fm-muted" id="fmSub"></p></div>
      <button type="button" class="fm-btn" data-fm-cerrar aria-label="Cerrar"><i class="fas fa-xmark"></i><span class="fm-sr">Cerrar</span></button>
    </div>
    <p class="fm-banner" id="fmAnulada" hidden></p>
    <dl class="fm-datos" id="fmDatos"></dl>
    <div class="fm-scroll"><table class="fm-tabla">
      <caption class="fm-sr">Productos de la factura</caption>
      <thead><tr><th scope="col">Producto</th><th scope="col" class="fm-n">Cant.</th><th scope="col" class="fm-n">Precio</th><th scope="col" class="fm-n">Total</th></tr></thead>
      <tbody id="fmProductos"></tbody></table></div>
    <div class="fm-pagos" id="fmPagos"></div>
    <p class="fm-totales" id="fmTotales"></p>
    <p class="fm-muted" id="fmObs" hidden></p>
    <div class="fm-acts">
      <button type="button" class="fm-btn" id="fmPdf"><i class="fas fa-print"></i> Ver e imprimir PDF</button>
      <button type="button" class="fm-btn" id="fmWa"><i class="fab fa-whatsapp"></i> Reenviar por WhatsApp</button>
      <button type="button" class="fm-btn" id="fmComp"><i class="fas fa-receipt"></i> Ver comprobante</button>
      <button type="button" class="fm-btn fm-peligro" id="fmAnular"><i class="fas fa-ban"></i> Anular factura</button>
    </div>
  </div>
</dialog>
<dialog class="fm-dlg fm-dlg-comp" id="fmComprobante" aria-labelledby="fmCompTit">
  <div class="fm-det">
    <div class="fm-cab"><h2 id="fmCompTit">Comprobante de pago</h2>
      <button type="button" class="fm-btn" data-fm-cerrar aria-label="Cerrar"><i class="fas fa-xmark"></i><span class="fm-sr">Cerrar</span></button></div>
    <p class="fm-muted" id="fmCompEstado" role="status">Cargando comprobante…</p>
    <img id="fmCompImg" alt="Comprobante de pago de la factura" hidden />
  </div>
</dialog>
<dialog class="fm-dlg fm-dlg-sm" id="fmAnularDlg" aria-labelledby="fmAnularTit">
  <form class="fm-det" id="fmForm" novalidate>
    <h2 id="fmAnularTit">Anular factura</h2>
    <p class="fm-muted" id="fmAnularInfo"></p>
    <p class="fm-peligro-txt">La factura quedará anulada, dejará de sumar en los totales y los productos volverán al inventario (queda registrado en el kardex). Esto no se puede deshacer.</p>
    <label class="fm-campo" for="fmMotivo">Motivo de la anulación
      <textarea id="fmMotivo" rows="3" minlength="3" maxlength="300" required></textarea></label>
    <p class="fm-form-error" id="fmErr" role="alert" hidden></p>
    <div class="fm-acts fm-fin">
      <button type="button" class="fm-btn" data-fm-cerrar>Cancelar</button>
      <button type="submit" class="fm-btn fm-peligro" id="fmConfirmar">Anular factura</button>
    </div>
  </form>
</dialog>
<p id="fmAviso" class="fm-aviso" role="status" popover="manual" hidden></p>`);

    document.addEventListener('click', (e) => { if (e.target.closest('[data-fm-cerrar]')) e.target.closest('dialog').close(); });
    $('#fmAviso').addEventListener('click', ocultarAviso);
    $('#fmFactura').addEventListener('close', () => { factura = null; });
    $('#fmComprobante').addEventListener('close', () => { const i = $('#fmCompImg'); i.removeAttribute('src'); i.hidden = true; });
    $('#fmPdf').addEventListener('click', () => factura && window.open(urlPdfFactura(factura.id_factura), '_blank', 'noopener'));
    $('#fmWa').addEventListener('click', reenviar);
    $('#fmComp').addEventListener('click', verComprobante);
    $('#fmAnular').addEventListener('click', abrirAnular);
    $('#fmForm').addEventListener('submit', confirmarAnular);
    $('#fmMotivo').addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));
}

//--- Detalle ---//
function linea(rotulo, valor) {
    return valor ? el('div', {}, el('dt', { textContent: rotulo }), el('dd', { textContent: valor })) : null;
}

function pintar(f) {
    factura = f;
    const anulada = f.estado === 'anulada';
    $('#fmTitulo').textContent = `Factura ${f.id_factura}`;
    $('#fmSub').textContent = fechaHora(f.created_at);

    const banner = $('#fmAnulada');
    banner.hidden = !anulada;
    if (anulada) banner.textContent = `Anulada el ${fechaHora(f.anulada_en)}${f.anulada_por_nombre ? ` por ${f.anulada_por_nombre}` : ''}. Motivo: ${f.motivo_anulacion}`;

    $('#fmDatos').replaceChildren(...[
        linea('Cliente', nombreCliente(f)), linea('Cédula', dato(f.cedula)), linea('Teléfono', dato(f.telefono)),
        linea('Vendedor', f.vendedor), linea('Método de pago', metodo(f.metodo_pago)),
        f.metodo_pago !== 'MIXTO' ? linea('Banco', dato(f.banco)) : null,
        f.metodo_pago !== 'MIXTO' ? linea('Referencia', dato(f.referencia)) : null,
        linea('Tasa de cambio', f.tasa_cambio ? `Bs ${Number(f.tasa_cambio).toLocaleString('es-VE', { minimumFractionDigits: 2 })}` : null),
    ].filter(Boolean));

    $('#fmProductos').replaceChildren(...f.factura_detalles.map((d) => el('tr', {},
        el('td', { textContent: d.nombre_producto }),
        el('td', { className: 'fm-n', textContent: String(Number(d.cantidad)) }),
        el('td', { className: 'fm-n', textContent: usd(Number(d.precio_unitario)) }),
        el('td', { className: 'fm-n', textContent: usd(Number(d.precio_total)) }))));

    const pagos = $('#fmPagos');
    pagos.replaceChildren();
    if (f.metodo_pago === 'MIXTO') {
        pagos.append(el('h3', { textContent: 'Forma de pago · combinado' }));
        if (Array.isArray(f.pagos_combinados) && f.pagos_combinados.length) {
            for (const p of f.pagos_combinados) {
                const extra = [dato(p.banco) && `Banco: ${p.banco}`, dato(p.referencia) && `Ref.: ${p.referencia}`, dato(p.observaciones)].filter(Boolean).join(' · ');
                pagos.append(el('div', { className: 'fm-pago' },
                    el('span', { textContent: metodo(p.metodo) }),
                    el('strong', { textContent: `${p.moneda === 'USD' ? usd(Number(p.monto)) : bs(Number(p.monto))}  (abona ${usd(Number(p.abono_usd))})` }),
                    ...(extra ? [el('small', { textContent: extra })] : [])));
            }
        } else {
            pagos.append(el('p', { className: 'fm-muted', textContent: 'El desglose de este pago combinado no quedó guardado (factura registrada antes de la corrección). El PDF sí lo muestra.' }));
        }
    }

    $('#fmTotales').replaceChildren(
        el('span', { textContent: `Subtotal: ${usd(Number(f.subtotal_usd))}` }),
        el('strong', { textContent: `Total: ${usd(Number(f.total_usd))}` }),
        el('strong', { textContent: bs(Number(f.total_bs)) }));
    const obs = $('#fmObs');
    obs.hidden = !f.observaciones;
    obs.textContent = f.observaciones ? `Observaciones: ${f.observaciones}` : '';

    // Una factura anulada no se imprime ni se reenvía (el PDF no dice «anulada»).
    $('#fmPdf').hidden = anulada;
    $('#fmWa').hidden = anulada || !soloDig(f.telefono);
    $('#fmComp').hidden = !f.tiene_comprobante;
    $('#fmAnular').hidden = anulada || !window.Auth?.tieneNivel('admin');   // el servidor también lo exige
    if (!$('#fmFactura').open) $('#fmFactura').showModal();
}

/** Abre la vista previa. `arg` es el número de factura (se consulta al servidor) o el objeto ya cargado. */
export async function abrirFactura(arg, opts = {}) {
    montar();
    opciones = opts;
    try {
        pintar(typeof arg === 'string' ? (await api(`${API}?modo=factura&id=${encodeURIComponent(arg)}`)).data : arg);
    } catch (e) { aviso(e.message, true); }
}

async function reenviar() {
    const btn = $('#fmWa');
    if (!factura || btn.disabled) return;
    btn.disabled = true;
    try {
        const [msg, error] = AVISOS_WA[await reenviarWhatsapp(factura.id_factura, factura.telefono)] ?? AVISOS_WA.no_disponible;
        aviso(msg, error);
    } catch (e) { aviso(e.message, true); } finally { btn.disabled = false; }
}

function verComprobante() {
    if (!factura) return;
    const img = $('#fmCompImg'), estado = $('#fmCompEstado');
    img.hidden = true; img.removeAttribute('src');
    estado.hidden = false; estado.textContent = 'Cargando comprobante…';
    img.onload = () => { estado.hidden = true; img.hidden = false; };
    img.onerror = () => { estado.textContent = 'No se pudo cargar el comprobante.'; };
    img.src = `${API}?modo=comprobante&id=${encodeURIComponent(factura.id_factura)}`;
    $('#fmComprobante').showModal();
}

//--- Anular ---//
function abrirAnular() {
    if (!factura) return;
    $('#fmForm').reset();
    $('#fmErr').hidden = true;
    $('#fmMotivo').removeAttribute('aria-invalid');
    $('#fmAnularInfo').textContent = `${factura.id_factura} · ${nombreCliente(factura)} · ${usd(Number(factura.total_usd))}`;
    $('#fmAnularDlg').showModal();
    $('#fmMotivo').focus();
}

async function confirmarAnular(e) {
    e.preventDefault();
    const btn = $('#fmConfirmar'), err = $('#fmErr');
    const motivo = $('#fmMotivo').value.replace(/\s+/g, ' ').trim();
    if (motivo.length < 3) {
        $('#fmMotivo').setAttribute('aria-invalid', 'true');
        err.textContent = 'Escribe el motivo de la anulación (mínimo 3 caracteres).'; err.hidden = false;
        return $('#fmMotivo').focus();
    }
    if (!factura || btn.disabled) return;
    const id = factura.id_factura;
    btn.disabled = true; err.hidden = true;
    try {
        const d = await api(API, { accion: 'anular', id_factura: id, motivo });
        $('#fmAnularDlg').close();
        aviso(d.message);
        pintar((await api(`${API}?modo=factura&id=${encodeURIComponent(id)}`)).data);   // el modal queda mostrando «Anulada»
        document.dispatchEvent(new CustomEvent('factura:anulada', { detail: { id } }));
        opciones.onAnulada?.(id);
    } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
    } finally { btn.disabled = false; }
}

// Cualquier elemento con data-ver-factura="FAC-..." abre la vista previa (también en filas que se crean después).
document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ver-factura]');
    if (b && b.dataset.verFactura) { e.preventDefault(); abrirFactura(b.dataset.verFactura); }
});
