/* Notificaciones push: activar/desactivar en este dispositivo y mantener la suscripción al día.
 * Script clásico sin HTML inline (CSP). Se carga solo en index.html y notificaciones.html.
 * Expone window.KatoaPush.desvincular(), que Auth.cerrarSesion() llama antes de cerrar la sesión. */
(() => {
    'use strict';

    const API = '/api/notificaciones';
    const CLAVE_OCULTO = 'katoa-push-oculto';
    const DIAS_OCULTO = 14;

    const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* modo privado */ } };
    const leer = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };

    const enModoApp = () =>
        window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: minimal-ui)').matches ||
        window.navigator.standalone === true;
    const esIOS = () =>
        /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const soportado = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

    async function api(metodo, cuerpo, query = '') {
        const r = await fetch(API + query, {
            method: metodo,
            credentials: 'same-origin',
            cache: 'no-store',
            headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined,
            body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.status === 'error') throw new Error(d.message || 'No se pudo completar la acción.');
        return d;
    }

    const aBytes = (b64u) => {
        const b64 = (b64u + '='.repeat((4 - (b64u.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
        return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    };
    const mismaClave = (buf, bytes) => {
        if (!buf) return false;
        const a = new Uint8Array(buf);
        return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
    };

    // `ready` no se resuelve nunca si el service worker no se registró: con tope de tiempo para no colgar la pantalla
    const registro = () => Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(
            () => rej(new Error('El service worker no está activo. Cierra la app por completo y vuelve a abrirla.')), 8000)),
    ]);
    const suscripcionActual = async () => (await registro()).pushManager.getSubscription();

    /** Crea (o reutiliza) la suscripción del navegador y la registra en el servidor. */
    async function suscribirYGuardar() {
        const { clave, disponible } = await api('GET', null, '?modo=push_clave');
        if (!disponible || !clave) throw new Error('Los avisos push aún no están configurados en el servidor.');
        const bytes = aBytes(clave);
        const reg = await registro();
        let sub = await reg.pushManager.getSubscription();
        const claveActual = sub && sub.options && sub.options.applicationServerKey;
        if (sub && claveActual && !mismaClave(claveActual, bytes)) {   // si Safari no expone la clave, no se re-suscribe
            await sub.unsubscribe();    // se cambió la clave VAPID: hay que suscribir de nuevo
            sub = null;
        }
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
        const d = await api('POST', { accion: 'push_suscribir', suscripcion: sub.toJSON() });
        return { sub, dispositivos: d.dispositivos };   // `dispositivos`: cuántos tiene registrados este usuario en el servidor
    }

    /** Pide permiso (debe llamarse desde un clic) y activa. */
    async function activar() {
        if (!soportado()) throw new Error('Este dispositivo no admite avisos push.');
        const permiso = await Notification.requestPermission();   // lo primero: iOS exige el gesto del usuario
        if (permiso !== 'granted') throw new Error('No diste permiso para mostrar avisos.');
        await suscribirYGuardar();
    }

    async function desactivar() {
        const sub = await suscripcionActual();
        if (!sub) return;
        await api('POST', { accion: 'push_quitar', endpoint: sub.endpoint }).catch(() => { });
        await sub.unsubscribe();
    }

    /** Antes de cerrar sesión: este dispositivo deja de recibir los avisos de ese usuario (equipos compartidos). */
    async function desvincular() {
        if (!soportado() || Notification.permission !== 'granted') return;
        try {
            const sub = await suscripcionActual();
            if (sub) await api('POST', { accion: 'push_quitar', endpoint: sub.endpoint });
        } catch (_) { /* cerrar sesión nunca debe fallar por esto */ }
    }
    window.KatoaPush = { activar, desactivar, desvincular };

    /** En cada apertura: si ya hay permiso, se re-registra el dispositivo (recupera suscripciones perdidas
     *  y lo asocia al usuario que inició sesión ahora). Sin permiso no hace nada ni pregunta. */
    function sincronizar() {
        if (soportado() && Notification.permission === 'granted') {
            suscribirYGuardar().catch((e) => console.warn('[push] no se pudo registrar este dispositivo:', e.message));
        }
    }

    // ---- Panel en Notificaciones ---------------------------------------------------------
    async function iniciarPanel(panel) {
        const estado = document.getElementById('pushEstado');
        const btn = document.getElementById('btnPush');
        const btnPrueba = document.getElementById('btnPushPrueba');
        panel.hidden = false;

        const pintar = async () => {
            btnPrueba.hidden = true;
            btn.hidden = false;
            btn.disabled = false;
            if (!soportado()) {
                btn.hidden = true;
                estado.textContent = esIOS() && !enModoApp()
                    ? 'En iPhone/iPad primero instala la app: toca Compartir y elige «Añadir a pantalla de inicio»; luego actívalos desde ahí.'
                    : 'Este navegador no admite avisos push.';
                return;
            }
            if (Notification.permission === 'denied') {
                btn.hidden = true;
                estado.textContent = 'Bloqueaste los avisos de este sitio. Para activarlos, permite las notificaciones en los ajustes del navegador o del sistema.';
                return;
            }
            const sub = Notification.permission === 'granted' ? await suscripcionActual().catch(() => null) : null;
            if (sub) {
                // El permiso del navegador NO basta: se confirma con el servidor que el dispositivo quedó registrado
                estado.textContent = 'Comprobando el registro en el servidor…';
                btn.disabled = true;
                try {
                    const { dispositivos } = await suscribirYGuardar();
                    estado.textContent = 'Activados: este dispositivo está registrado en el servidor' +
                        (dispositivos ? ` (${dispositivos} dispositivo${dispositivos === 1 ? '' : 's'} tuyo${dispositivos === 1 ? '' : 's'}).` : '.') +
                        ' Recibirás las notificaciones aunque la app esté cerrada.';
                    btn.textContent = 'Desactivar';
                    btn.classList.replace('btn-primary', 'btn-ghost');
                    btnPrueba.hidden = false;
                } catch (e) {
                    estado.textContent = 'El permiso está dado, pero el servidor no pudo registrar este dispositivo: ' + e.message;
                    btn.textContent = 'Reintentar';
                    btn.classList.replace('btn-ghost', 'btn-primary');
                }
                btn.disabled = false;
            } else {
                estado.textContent = 'Recibe las notificaciones y solicitudes de autorización en este dispositivo, aunque la app esté cerrada.';
                btn.textContent = 'Activar avisos';
                btn.classList.replace('btn-ghost', 'btn-primary');
            }
        };

        const avisar = (msg) => { estado.textContent = msg; };

        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const activo = btn.textContent === 'Desactivar';
                if (activo) await desactivar(); else await activar();
                await pintar();
            } catch (e) {
                await pintar();
                avisar(e.message);
            }
        });
        btnPrueba.addEventListener('click', async () => {
            btnPrueba.disabled = true;
            try { await api('POST', { accion: 'push_probar' }); avisar('Aviso de prueba enviado: debería llegar en unos segundos.'); }
            catch (e) { avisar(e.message); }
            finally { btnPrueba.disabled = false; }
        });
        pintar();
    }

    // ---- Invitación en el inicio ----------------------------------------------------------
    function invitar() {
        const t = Number(leer(CLAVE_OCULTO));
        if ((t ? (Date.now() - t) / 86400000 : Infinity) < DIAS_OCULTO) return;
        if (!soportado() || Notification.permission !== 'default') return;
        if (esIOS() && !enModoApp()) return;            // en iOS solo funciona con la app instalada
        if (document.querySelector('.pwa-card')) return; // no apilar sobre la tarjeta de instalar

        const caja = document.createElement('div');
        caja.className = 'pwa-card';
        caja.setAttribute('role', 'dialog');
        const t1 = document.createElement('strong'); t1.textContent = 'Activa los avisos';
        const p = document.createElement('p'); p.textContent = 'Recibe notificaciones y solicitudes de autorización en este dispositivo.';
        const fila = document.createElement('div'); fila.className = 'pwa-card-acciones';
        const no = document.createElement('button'); no.type = 'button'; no.className = 'pwa-btn'; no.textContent = 'Ahora no';
        const si = document.createElement('button'); si.type = 'button'; si.className = 'pwa-btn pwa-btn-primario'; si.textContent = 'Activar';
        no.addEventListener('click', () => { guardar(CLAVE_OCULTO, String(Date.now())); caja.remove(); });
        si.addEventListener('click', async () => {
            si.disabled = true;
            try { await activar(); caja.remove(); }
            catch (e) { p.textContent = e.message; si.disabled = false; }
        });
        fila.append(no, si);
        caja.append(t1, p, fila);
        document.body.appendChild(caja);
    }

    document.addEventListener('DOMContentLoaded', () => {
        const panel = document.getElementById('pushPanel');
        if (panel) {
            iniciarPanel(panel);   // el panel ya registra y comprueba el dispositivo por su cuenta
        } else {
            if (['/', '/index.html'].includes(location.pathname)) setTimeout(invitar, 2500);
            sincronizar();
        }
    });
})();
