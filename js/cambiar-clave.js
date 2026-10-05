(async () => {
    'use strict';

    // auth-guard.js verifica la sesión; si no hay, o no hay cambio pendiente, ya redirigió.
    const usuario = await window.Auth.listo;
    if (!usuario) return;

    const MIN = 10;
    const form = document.getElementById('claveForm');
    const actual = document.getElementById('claveActual');
    const nueva = document.getElementById('claveNueva');
    const repetida = document.getElementById('claveRepetida');
    const boton = document.getElementById('claveBoton');
    const errorEl = document.getElementById('claveError');
    const textoBoton = boton.textContent;

    const campos = [actual, nueva, repetida];
    const mostrarError = (msg, campo) => {
        errorEl.textContent = msg;
        errorEl.hidden = false;
        if (campo) { campo.setAttribute('aria-invalid', 'true'); campo.focus(); }
    };
    const limpiarError = () => {
        campos.forEach((el) => el.removeAttribute('aria-invalid'));
        errorEl.hidden = true;
        errorEl.textContent = '';
    };
    const setCargando = (cargando) => {
        boton.disabled = cargando;
        boton.setAttribute('aria-busy', cargando);
        boton.textContent = cargando ? 'Guardando…' : textoBoton;
    };

    // Mismas reglas que el servidor (api/cambiar-clave.py); el servidor es quien decide.
    const validar = () => {
        if (!actual.value) return ['Escribe tu contraseña actual.', actual];
        if (nueva.value.length < MIN) return [`La contraseña nueva debe tener al menos ${MIN} caracteres.`, nueva];
        if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(nueva.value) || !/\d/.test(nueva.value))
            return ['La contraseña nueva debe combinar letras y números.', nueva];
        if (nueva.value === actual.value) return ['La contraseña nueva debe ser distinta de la actual.', nueva];
        if (nueva.value !== repetida.value) return ['Las contraseñas nuevas no coinciden.', repetida];
        return null;
    };

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        limpiarError();
        const fallo = validar();
        if (fallo) return mostrarError(...fallo);

        setCargando(true);
        try {
            const r = await fetch('/api/cambiar-clave', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password_actual: actual.value, password_nueva: nueva.value }),
            });
            const d = await r.json().catch(() => ({}));
            if (r.ok && d.ok) {
                boton.textContent = 'Contraseña actualizada';
                location.replace('/index.html');
                return; // el botón queda bloqueado mientras se redirige
            }
            if (r.status === 401) { location.replace('/login.html'); return; }
            if (r.status === 403 && /actual/i.test(d.error || '')) actual.value = '';
            mostrarError(d.error || 'No se pudo cambiar la contraseña. Intenta de nuevo.', r.status === 403 ? actual : null);
        } catch (_) {
            mostrarError('Sin conexión con el servidor. Revisa tu internet e intenta de nuevo.');
        }
        setCargando(false);
    });

    campos.forEach((el) => el.addEventListener('input', limpiarError));
    document.getElementById('claveSalir').addEventListener('click', () => window.Auth.cerrarSesion());
})();
