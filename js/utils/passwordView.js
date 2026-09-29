let password = document.getElementById('password');
let viewPassword = document.getElementById('viewPassword');
let eyeIcon = document.getElementById('eyeIcon');

viewPassword.addEventListener('click', (e) => {
    // Evita que el botón intente enviar datos o recargar la página (muy útil si luego usas una etiqueta <form>)
    e.preventDefault(); 

    // 1. Verificamos el estado actual
    const isPassword = password.type === 'password';
    
    // 2. Cambiamos el tipo de input
    password.type = isPassword ? 'text' : 'password';

    // 3. Reemplazamos las clases correctamente según el estado
    if (isPassword) {
        // Si era contraseña y la vamos a mostrar, cambiamos al ojo tachado
        eyeIcon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        // Si era texto y la vamos a ocultar, volvemos al ojo normal
        eyeIcon.classList.replace('fa-eye-slash', 'fa-eye');
    }
});