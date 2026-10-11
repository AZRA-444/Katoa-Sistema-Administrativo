/* ==========================================================================
 * Autorización con código de un solo uso — Katoa (cliente)
 *
 * Para operaciones que el rol del usuario no puede hacer (anular una factura, salida o ajuste de inventario):
 *   1) el usuario escribe el motivo y SOLICITA la autorización;
 *   2) espera a que un admin la apruebe (el admin ve la solicitud en Notificaciones → Autorizaciones);
 *   3) el admin le dice el código de 6 dígitos y el usuario lo escribe aquí; se ejecuta la operación.
 *
 * Uso:
 *   import { conAutorizacion } from './autorizacion.js';
 *   const hecho = await conAutorizacion({
 *       accion: 'anular_factura' | 'salida' | 'ajuste',
 *       objetivo: 'FAC-123' | idVariante,
 *       detalle: { cantidad, sentido },                 // solo inventario
 *       titulo: 'Anular factura',
 *       motivo: 'texto ya escrito por el usuario (opcional: se precarga en el paso 1)',
 *       resumen: 'qué se va a hacer (opcional)',
 *       ejecutar: (autorizacion) => api(API, { ..., autorizacion }),   // lanza Error si falla; devuelve el resultado
 *   });                                                 // null si el usuario cancela
 * Servidor: /api/notificaciones (solicitar, estado, cancelar) y el endpoint de la operación (valida el código).
 * ========================================================================== */
const API = '/api/notificaciones';
const SONDEO_MS = 4000;
const $ = (s) => document.querySelector(s);
let montado = false;

async function llamar(url, cuerpo, reintentar = true) {
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
            return llamar(url, cuerpo, false);
        location.replace('/login.html?next=' + encodeURIComponent(location.pathname));
        throw new Error('Sesión expirada');
    }
    const d = await r.json().catch(() => null);
    if (!r.ok || d?.status !== 'ok') throw new Error(d?.message || 'No se pudo completar la operación.');
    return d;
}

function montar() {
    if (montado) return;
    montado = true;
    for (const href of ['factura-modal.css', 'autorizacion.css']) {
        document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL(`../assets/css/${href}`, import.meta.url).href }));
    }
    document.body.insertAdjacentHTML('beforeend', `
<dialog class="fm-dlg fm-dlg-sm" id="auDlg" aria-labelledby="auTit">
  <div class="fm-det au-pasos">
    <h2 id="auTit">Solicitar autorización</h2>
    <p class="au-resumen" id="auInfo" hidden></p>

    <form id="auPaso1" class="au-pasos" novalidate>
      <p class="fm-muted">Tu rol no puede hacer esto por sí solo. Un administrador recibirá la solicitud y, si la aprueba, te dará un código de 6 dígitos de un solo uso.</p>
      <label class="fm-campo" for="auMotivo">Motivo de la solicitud
        <textarea id="auMotivo" rows="3" minlength="3" maxlength="300" required></textarea></label>
      <div class="fm-acts fm-fin">
        <button type="button" class="fm-btn" data-au-cerrar>Cancelar</button>
        <button type="submit" class="fm-btn au-primario" id="auEnviar">Solicitar autorización</button>
      </div>
    </form>

    <div id="auPaso2" class="au-pasos" hidden>
      <p class="au-espera" role="status"><i class="fas fa-hourglass-half"></i><span id="auEspera">Esperando que un administrador apruebe la solicitud…</span></p>
      <p class="fm-muted">Puedes dejar esta ventana abierta. En cuanto la aprueben, aquí aparecerá el campo para escribir el código.</p>
      <div class="fm-acts fm-fin"><button type="button" class="fm-btn" id="auCancelarSol">Cancelar solicitud</button></div>
    </div>

    <form id="auPaso3" class="au-pasos" novalidate hidden>
      <label class="fm-campo" for="auCodigo">Código que te dio el administrador
        <input id="auCodigo" class="au-codigo" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="••••••" required /></label>
      <p class="fm-muted" id="auVence"></p>
      <div class="fm-acts fm-fin">
        <button type="button" class="fm-btn" id="auCancelarCod">Cancelar</button>
        <button type="submit" class="fm-btn au-primario" id="auConfirmar">Confirmar</button>
      </div>
    </form>

    <p class="fm-form-error" id="auErr" role="alert" hidden></p>
  </div>
</dialog>`);
}

/** Muestra el paso 1, 2 o 3 y oculta los demás. */
const paso = (n) => { for (const i of [1, 2, 3]) $(`#auPaso${i}`).hidden = i !== n; };
const error = (msg) => { const e = $('#auErr'); e.textContent = msg || ''; e.hidden = !msg; };

export function conAutorizacion({ accion, objetivo, detalle = {}, titulo = 'Solicitar autorización', motivo: motivoInicial = '', resumen = '', ejecutar }) {
    montar();
    const dlg = $('#auDlg');
    // Si ya hay otro diálogo igual abierto (doble clic) no se abre un segundo flujo.
    if (dlg.open) return Promise.resolve(null);

    return new Promise((resolver) => {
        let idSol = null, timer = null, fin = false, enviando = false;
        const nuevos = [];
        const escuchar = (nodo, ev, fn) => { nodo.addEventListener(ev, fn); nuevos.push(() => nodo.removeEventListener(ev, fn)); };

        const terminar = (resultado) => {
            if (fin) return;
            fin = true;
            clearTimeout(timer);
            nuevos.forEach((q) => q());
            if (dlg.open) dlg.close();
            resolver(resultado);
        };
        const cancelarSolicitud = async () => {
            if (idSol) await llamar(API, { accion: 'autorizacion_cancelar', id: idSol }).catch(() => { /* ya estaba resuelta */ });
            terminar(null);
        };

        // Estado de la solicitud: decide qué paso se ve.
        const consultar = async () => {
            if (fin || !idSol) return;
            try {
                const { data } = await llamar(`${API}?modo=autorizacion&id=${idSol}`);
                if (fin) return;
                if (data.estado === 'aprobada') {
                    const hasta = new Date(data.expira_en).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Caracas' });
                    $('#auVence').textContent = `Autorizado por ${data.autorizado_por || 'un administrador'}. El código vale hasta las ${hasta} y se puede usar una sola vez.`;
                    if ($('#auPaso3').hidden) { paso(3); error(''); $('#auCodigo').focus(); }
                } else if (data.estado === 'pendiente') {
                    timer = setTimeout(consultar, SONDEO_MS);
                } else {
                    const textos = { rechazada: 'Un administrador rechazó la solicitud.', vencida: 'El código venció. Solicita una nueva autorización.',
                        usada: 'Esta autorización ya se usó.', cancelada: 'La solicitud fue cancelada.' };
                    idSol = null; paso(1); error(textos[data.estado] || 'La solicitud ya no está disponible.');
                }
            } catch (e) {
                if (!fin) { error(e.message); timer = setTimeout(consultar, SONDEO_MS * 2); }
            }
        };

        // Paso 1: pedir
        escuchar($('#auPaso1'), 'submit', async (e) => {
            e.preventDefault();
            const motivo = $('#auMotivo').value.replace(/\s+/g, ' ').trim();
            if (motivo.length < 3) { $('#auMotivo').setAttribute('aria-invalid', 'true'); error('Escribe el motivo (mínimo 3 caracteres).'); return $('#auMotivo').focus(); }
            if (enviando) return;
            enviando = true; $('#auEnviar').disabled = true; error('');
            try {
                const d = await llamar(API, { accion: 'autorizacion_solicitar', accion_autorizar: accion, objetivo: String(objetivo), detalle, motivo });
                idSol = d.id;
                paso(2);
                consultar();
            } catch (ex) { error(ex.message); } finally { enviando = false; $('#auEnviar').disabled = false; }
        });
        escuchar($('#auMotivo'), 'input', (e) => e.target.removeAttribute('aria-invalid'));

        // Paso 3: escribir el código y ejecutar la operación (si el código es incorrecto se queda aquí)
        escuchar($('#auCodigo'), 'input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); e.target.removeAttribute('aria-invalid'); });
        escuchar($('#auPaso3'), 'submit', async (e) => {
            e.preventDefault();
            const codigo = $('#auCodigo').value;
            if (!/^\d{6}$/.test(codigo)) { $('#auCodigo').setAttribute('aria-invalid', 'true'); error('El código son 6 dígitos.'); return $('#auCodigo').focus(); }
            if (enviando) return;
            enviando = true; $('#auConfirmar').disabled = true; error('');
            try {
                terminar(await ejecutar({ id: idSol, codigo }));
            } catch (ex) {
                error(ex.message);
                $('#auCodigo').setAttribute('aria-invalid', 'true');
                // Tras un fallo se vuelve a consultar: si el código se bloqueó o se usó, el paso cambia solo.
                if (/bloque|ya se us|venci|no corresponde/i.test(ex.message)) { idSol = null; paso(1); }
                else $('#auCodigo').select();
            } finally { enviando = false; $('#auConfirmar').disabled = false; }
        });

        escuchar($('#auDlg'), 'cancel', (e) => { e.preventDefault(); cancelarSolicitud(); });   // tecla Esc
        escuchar($('#auPaso1').querySelector('[data-au-cerrar]'), 'click', () => terminar(null));
        escuchar($('#auCancelarSol'), 'click', cancelarSolicitud);
        escuchar($('#auCancelarCod'), 'click', cancelarSolicitud);

        $('#auTit').textContent = titulo;
        $('#auPaso1').reset(); $('#auPaso3').reset();
        $('#auMotivo').value = motivoInicial;
        $('#auMotivo').removeAttribute('aria-invalid');
        $('#auInfo').textContent = resumen; $('#auInfo').hidden = !resumen;
        error(''); paso(1);
        dlg.showModal();
        $('#auMotivo').focus();
    });
}
