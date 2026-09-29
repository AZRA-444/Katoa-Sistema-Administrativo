(() => {
    'use strict';

    const emailInput = document.getElementById('email-login');
    const passInput = document.getElementById('password');
    const boton = document.getElementById('loginButton');
    const textoBoton = boton.textContent;

    // Mensaje de error accesible (se crea si el HTML no lo trae)
    let errorEl = document.getElementById('loginError');
    if (!errorEl) {
        errorEl = document.createElement('p');
        errorEl.id = 'loginError';
        errorEl.className = 'form-error';
        const pie = document.querySelector('.footer-content');
        pie.parentNode.insertBefore(errorEl, pie);
    }
    errorEl.setAttribute('role', 'alert');
    errorEl.hidden = true;

    const mostrarError = (msg) => {
        errorEl.textContent = msg;
        errorEl.hidden = false;
    };
    const limpiarError = () => {
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
        emailInput.disabled = cargando;
        passInput.disabled = cargando;
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
                location.replace(destinoSeguro());
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

    boton.addEventListener('click', iniciarSesion);
    [emailInput, passInput].forEach((el) =>
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                iniciarSesion();
            }
        })
    );
    [emailInput, passInput].forEach((el) => el.addEventListener('input', limpiarError));

    // Si ya hay una sesión válida, no mostrar el login
    fetch('/api/sesion', { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => r.ok && location.replace(destinoSeguro()))
        .catch(() => {});
})();