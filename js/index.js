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

    document.body.classList.add('is-ready');
})();
