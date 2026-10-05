(() => {
    'use strict';

    document.documentElement.style.visibility = 'hidden';
    const mostrarPagina = () => (document.documentElement.style.visibility = 'visible');

    const domListo = new Promise((res) =>
        document.readyState === 'loading'
            ? document.addEventListener('DOMContentLoaded', res, { once: true })
            : res()
    );


    // Mensaje a pantalla completa cuando la verificación falla (sin HTML inline)
    const mostrarErrorVerificacion = () => {
        domListo.then(() => {
            if (document.getElementById('kt-guard-error')) return;
            const caja = document.createElement('div');
            caja.id = 'kt-guard-error';
            caja.setAttribute('role', 'alert');
            Object.assign(caja.style, {
                position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: '14px',
                padding: '24px', textAlign: 'center', background: '#fff',
                color: '#111827', fontFamily: 'system-ui, sans-serif', zIndex: '2147483647',
                visibility: 'visible', // solo el mensaje se ve; la página sigue oculta
            });
            const t = document.createElement('p');
            t.textContent = 'No se pudo verificar tu sesión. Revisa tu conexión e intenta de nuevo.';
            const reintentar = document.createElement('button');
            reintentar.type = 'button';
            reintentar.textContent = 'Reintentar';
            reintentar.addEventListener('click', () => location.reload());
            const login = document.createElement('a');
            login.href = '/login.html';
            login.textContent = 'Ir a iniciar sesión';
            for (const el of [reintentar, login]) el.style.cssText = 'font:inherit;cursor:pointer;';
            caja.append(t, reintentar, login);
            document.body.appendChild(caja);
        });
    };

    // Si el navegador restaura la página desde caché (botón "atrás" tras salir),
    // se vuelve a verificar la sesión.
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) location.reload();
    });

    const irALogin = () => {
        const next = location.pathname + location.search;
        location.replace('/login.html?next=' + encodeURIComponent(next));
    };

    // Jerarquía de roles (se compara sin distinguir mayúsculas)
    const NIVELES = { personal: 1, encargado: 2, admin: 3, sysadmin: 4 };
    const nivelDe = (rol) => NIVELES[String(rol || '').toLowerCase()] || 0;

    const REGLAS = [
        ['[data-personal-access]', 'personal'],
        ['[data-encargado-access]', 'encargado'],
        ['[data-admin-only]', 'admin'],
        ['[data-sysadmin-only]', 'sysadmin'],
    ];

    const Auth = {
        usuario: null,
        debeCambiarClave: false,

        tieneRol(...roles) {
            if (!this.usuario) return false;
            const mio = String(this.usuario.rol).toLowerCase();
            return roles.some((r) => String(r).toLowerCase() === mio);
        },

        // true si el rol del usuario es igual o superior al indicado
        tieneNivel(minimo) {
            return !!this.usuario && nivelDe(this.usuario.rol) >= nivelDe(minimo);
        },

        // Elimina del DOM lo que el rol no puede ver (display:flex de las
        // tarjetas ignoraría el atributo hidden, por eso se quitan)
        aplicarPermisos(raiz = document) {
            for (const [selector, minimo] of REGLAS) {
                raiz.querySelectorAll(selector).forEach((el) => {
                    if (!this.tieneNivel(minimo)) el.remove();
                });
            }
        },

        async cerrarSesion() {
            try {
                await fetch('/api/logout', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                });
            } catch (_) {
                /* se redirige igualmente */
            }
            location.replace('/login.html');
        },
    };

    Auth.listo = (async () => {
        try {
            const r = await fetch('/api/sesion', { credentials: 'same-origin', cache: 'no-store' });
            if (r.status === 401 || r.status === 403) {
                irALogin();
                return null;
            }
            if (!r.ok) throw new Error('sesion ' + r.status);

            const datos = await r.json();
            Auth.usuario = datos.usuario;
            Auth.debeCambiarClave = !!datos.debe_cambiar_clave;

            // Clave temporal: solo se puede estar en la pantalla de cambio (el servidor también lo exige:
            // el resto de /api responde 403 hasta que la cambie).
            const enCambioClave = location.pathname.endsWith('/cambiar-clave.html');
            if (Auth.debeCambiarClave && !enCambioClave) {
                location.replace('/cambiar-clave.html');
                return null;
            }
            if (!Auth.debeCambiarClave && enCambioClave) {
                location.replace('/index.html');
                return null;
            }

            await domListo;
            Auth.aplicarPermisos();
            mostrarPagina();
            document.dispatchEvent(new CustomEvent('kt:sesion-lista', { detail: Auth.usuario }));
            return Auth.usuario;
        } catch (e) {
            // FALLA CERRADO: si no se puede verificar la sesión, la página NO se
            // muestra. Se ofrece reintentar o ir al login.
            console.error('No se pudo verificar la sesión:', e);
            mostrarErrorVerificacion();
            return null;
        }
    })();

    window.Auth = Auth;
})();
