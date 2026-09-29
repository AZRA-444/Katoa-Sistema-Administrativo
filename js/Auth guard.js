/*
 * Cargar en el <head> de cada página protegida, SIN defer/async:
 *   <script src="/js/auth-guard.js"></script>
 *
 * Nota: esto controla la VISIBILIDAD en el navegador. La seguridad real la
 * aplican las funciones /api/* (leen la cookie HttpOnly y validan el rol).
 */
(() => {
    'use strict';

    // Oculta la página hasta confirmar la sesión
    document.documentElement.style.visibility = 'hidden';
    const mostrarPagina = () => (document.documentElement.style.visibility = '');

    const irALogin = () => {
        const next = location.pathname + location.search;
        location.replace('/login.html?next=' + encodeURIComponent(next));
    };

    const Auth = {
        usuario: null,

        tieneRol(...roles) {
            return !!this.usuario && roles.includes(this.usuario.rol);
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
            mostrarPagina();
            document.dispatchEvent(new CustomEvent('kt:sesion-lista', { detail: datos.usuario }));
            return Auth.usuario;
        } catch (e) {
            // Error de red o servidor: no se expulsa al usuario; las llamadas a la API
            // seguirán exigiendo sesión válida.
            console.error('No se pudo verificar la sesión:', e);
            mostrarPagina();
            return null;
        }
    })();

    window.Auth = Auth;
})();