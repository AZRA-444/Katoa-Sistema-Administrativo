(() => {
    'use strict';

    const form = document.getElementById('loginForm');
    const emailInput = document.getElementById('email-login');
    const passInput = document.getElementById('password');
    const boton = document.getElementById('loginButton');
    const errorEl = document.getElementById('loginError');
    const textoBoton = boton.textContent;

    const mostrarError = (msg) => {
        errorEl.textContent = msg;
        errorEl.hidden = false;
        [emailInput, passInput].forEach((el) => el.setAttribute('aria-invalid', 'true'));
    };
    const limpiarError = () => {
        [emailInput, passInput].forEach((el) => el.removeAttribute('aria-invalid'));
        errorEl.hidden = true;
        errorEl.textContent = '';
    };

    // Solo rutas internas: evita redirecciones abiertas (?next=https://sitio-malo)
    const destinoSeguro = () => {
        const next = new URLSearchParams(location.search).get('next');
        if (
            next &&
            next.startsWith('/') &&
            !next.startsWith('//') &&
            !next.startsWith('/\\') &&
            !next.startsWith('/login')
        ) {
            return next;
        }
        return '/index.html';
    };

    const setCargando = (cargando) => {
        boton.disabled = cargando;
        boton.setAttribute('aria-busy', cargando);
        emailInput.readOnly = cargando;
        passInput.readOnly = cargando;
        boton.textContent = cargando ? 'Verificando…' : textoBoton;
    };

    async function iniciarSesion() {
        limpiarError();

        const email = emailInput.value.trim();
        const password = passInput.value;

        if (!email || !password) {
            mostrarError('Ingresa tu correo y tu contraseña.');
            return;
        }
        if (!emailInput.checkValidity()) {
            mostrarError('Ingresa un correo electrónico válido.');
            return;
        }

        setCargando(true);
        try {
            const resp = await fetch('/api/login', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });
            const datos = await resp.json().catch(() => ({}));

            if (resp.ok && datos.ok) {
                // Clave temporal: primero se cambia (el servidor bloquea el resto hasta entonces).
                location.replace(datos.debe_cambiar_clave ? '/cambiar-clave.html' : destinoSeguro());
                return;
            }

            passInput.value = '';
            mostrarError(datos.error || 'No se pudo iniciar sesión. Intenta de nuevo.');
            passInput.focus();
        } catch (_) {
            mostrarError('Sin conexión con el servidor. Revisa tu internet e intenta de nuevo.');
        } finally {
            setCargando(false);
        }
    }

    // El envío del formulario cubre el botón y la tecla Enter
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        iniciarSesion();
    });
    [emailInput, passInput].forEach((el) => el.addEventListener('input', limpiarError));

    // Si ya hay una sesión válida, no mostrar el login
    fetch('/api/sesion', { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => r.ok && location.replace(destinoSeguro()))
        .catch(() => {});
})();
