(async () => {
    'use strict';

    // auth-guard.js ya verificó la sesión y quitó las tarjetas sin permiso
    const usuario = await Auth.listo;
    if (!usuario) return;

    const nombre = usuario.nombre || usuario.email || '';
    document.getElementById('usuarioNombre').textContent = nombre;
    document.getElementById('usuarioRol').textContent = usuario.rol || '';
    document.getElementById('saludo').textContent = usuario.nombre ? `Hola, ${usuario.nombre.split(' ')[0]}` : 'Hola';
    document.getElementById('btnSalir').addEventListener('click', () => Auth.cerrarSesion());

    // Oculta las secciones que quedaron sin tarjetas para el rol del usuario
    document.querySelectorAll('[data-seccion]').forEach((sec) => {
        if (!sec.querySelector('.card')) sec.remove();
    });
    document.querySelectorAll('.stagger').forEach((g) =>
        [...g.children].forEach((c, i) => c.style.setProperty('--i', i))
    );

    // Admin: avisa cuántas solicitudes de autorización esperan respuesta (si falla, simplemente no se muestra)
    if (Auth.tieneNivel('admin')) {
        fetch('/api/notificaciones?modo=contador', { credentials: 'same-origin', cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                const n = Number(d?.autorizaciones_pendientes) || 0, b = document.getElementById('autBadge');
                if (b && n > 0) { b.textContent = `${n} por atender`; b.hidden = false; b.style.cssText = 'font:600 .72rem Inter,system-ui,sans-serif;color:#fff;background:#A65A30;border-radius:999px;padding:2px 8px;margin-left:6px;vertical-align:middle;'; }
            })
            .catch(() => { });
    }

    document.body.classList.add('is-ready');
})();
