(async () => {
    'use strict';

    // auth-guard.js ya verificó la sesión y quitó las tarjetas sin permiso
    const usuario = await Auth.listo;
    if (!usuario) return;

    document.getElementById('usuarioNombre').textContent = usuario.nombre || usuario.email || '';
    document.getElementById('usuarioRol').textContent = usuario.rol || '';
    document.getElementById('btnSalir').addEventListener('click', () => Auth.cerrarSesion());
})();
