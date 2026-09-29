/*
 * Cargar en el <head> de cada página protegida, SIN defer/async:
 *   <script src="/js/auth-guard.js"></script>
 *
 * - Oculta la página hasta verificar la sesión (si no hay, va a /login.html).
 * - Quita del DOM los elementos que el rol del usuario no puede usar:
 *       data-personal-access   personal, encargado, admin, sysAdmin
 *       data-encargado-access  encargado, admin, sysAdmin
 *       data-admin-only        admin, sysAdmin
 *       data-sysadmin-only     sysAdmin
 * - Expone window.Auth: usuario, listo, tieneRol(), tieneNivel(),
 *   aplicarPermisos(), cerrarSesion().
 *
 * Nota: esto controla lo que se VE. La seguridad real la aplican las
 * funciones /api/*, que leen la cookie HttpOnly y validan el rol.
 */
(() => {
    'use strict';

    document.documentElement.style.visibility = 'hidden';
    const mostrarPagina = () => (document.documentElement.style.visibility = '');

    const domListo = new Promise((res) =>
        document.readyState === 'loading'
            ? document.addEventListener('DOMContentLoaded', res, { once: true })
            : res()
    );

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

            await domListo;
            Auth.aplicarPermisos();
            mostrarPagina();
            document.dispatchEvent(new CustomEvent('kt:sesion-lista', { detail: Auth.usuario }));
            return Auth.usuario;
        } catch (e) {
            // Error de red o servidor: no se expulsa al usuario; las llamadas a la
            // API seguirán exigiendo sesión válida.
            console.error('No se pudo verificar la sesión:', e);
            mostrarPagina();
            return null;
        }
    })();

    window.Auth = Auth;
})();
