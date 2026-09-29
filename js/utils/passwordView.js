(() => {
    'use strict';

    const password = document.getElementById('password');
    const boton = document.getElementById('viewPassword');
    const icono = document.getElementById('eyeIcon');
    if (!password || !boton || !icono) return;

    boton.addEventListener('click', (e) => {
        e.preventDefault();
        const oculta = password.type === 'password';
        password.type = oculta ? 'text' : 'password';
        icono.classList.toggle('fa-eye', !oculta);
        icono.classList.toggle('fa-eye-slash', oculta);
        boton.setAttribute('aria-label', oculta ? 'Ocultar contraseña' : 'Mostrar contraseña');
    });
})();
