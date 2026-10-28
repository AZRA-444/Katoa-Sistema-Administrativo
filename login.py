"""POST /api/login

Valida credenciales contra Supabase Auth y, si son correctas, entrega la sesión
en cookies HttpOnly (el JavaScript del navegador nunca ve los tokens).

Protecciones: límite de intentos por pareja correo+IP (y por IP, y un tope por correo que respeta las IP
conocidas), mensajes genéricos, verificación de cuenta activa y registro de cada intento ANTES de probar la
contraseña (si no se puede registrar, se rechaza: falla cerrado).
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

MSG_CREDENCIALES = "Correo o contraseña incorrectos."
MSG_BLOQUEO = "Demasiados intentos fallidos. Intenta de nuevo en unos minutos."
MSG_NO_DISPONIBLE = "Servicio no disponible. Intenta de nuevo en un momento."
MSG_CUENTA = "Tu cuenta está desactivada o sin acceso configurado. Contacta al administrador."


class handler(BaseHTTPRequestHandler):
    def log_message(self, *args):   # sin log por petición: la URL lleva cédulas y búsquedas de clientes
        pass

    def do_POST(self):
        if not c.config_completa():
            return c.responder(self, 500, {"error": "Configuración del servidor incompleta."})
        if not c.origen_valido(self):
            return c.responder(self, 403, {"error": "Origen no permitido."})

        try:
            datos = c.leer_json(self, 4096)
        except c.ErrorPeticion as e:
            return c.responder(self, e.status, {"error": e.mensaje})

        email = str(datos.get("email", "")).strip().lower()
        password = datos.get("password", "")
        if (
            len(email) > 254
            or not c.EMAIL_RE.match(email)
            or not isinstance(password, str)
            or not (1 <= len(password) <= 128)
        ):
            return c.responder(self, 400, {"error": "Ingresa un correo y una contraseña válidos."})

        ip = c.ip_cliente(self)

        # 1) Límite de intentos (si no se puede comprobar o registrar, se falla cerrado: nunca se prueba la clave)
        try:
            if c.login_bloqueado(email, ip):
                return c.responder(
                    self,
                    429,
                    {"error": MSG_BLOQUEO, "reintentar_en_segundos": c.VENTANA_MIN * 60},
                    extra={"Retry-After": str(c.VENTANA_MIN * 60)},
                )
            # El intento queda registrado ANTES de probar la contraseña (como fallo); si es correcta se marca éxito.
            intento = c.reservar_intento(email, ip)
        except requests.RequestException as e:
            print(f"[login] límite de intentos no disponible: {e}", file=sys.stderr)
            return c.responder(self, 503, {"error": MSG_NO_DISPONIBLE})

        # 2) Autenticación contra Supabase
        try:
            r = c.auth_password(email, password)
        except requests.RequestException:
            c.intento_liberar(intento)      # no fue culpa del usuario
            return c.responder(self, 503, {"error": MSG_NO_DISPONIBLE})

        if r.status_code in (400, 401, 422):
            return c.responder(self, 401, {"error": MSG_CREDENCIALES})    # el intento ya cuenta como fallo
        if r.status_code == 429:
            c.intento_liberar(intento)
            return c.responder(self, 429, {"error": MSG_BLOQUEO})
        if r.status_code != 200:
            print(f"[login] Supabase respondió {r.status_code}", file=sys.stderr)
            c.intento_liberar(intento)
            return c.responder(self, 503, {"error": MSG_NO_DISPONIBLE})

        sesion = r.json()

        # 3) La cuenta debe tener perfil y estar activa
        try:
            perfil = c.obtener_perfil(sesion["user"]["id"])
        except requests.RequestException:
            c.auth_logout(sesion["access_token"])
            c.intento_liberar(intento)
            return c.responder(self, 503, {"error": MSG_NO_DISPONIBLE})

        if perfil is None or not perfil.get("activo"):
            c.intento_motivo(intento, "cuenta_inactiva" if perfil else "sin_perfil")
            c.auth_logout(sesion["access_token"])
            return c.responder(self, 403, {"error": MSG_CUENTA})

        # 4) Éxito: el intento pasa a exitoso y la sesión va en cookies HttpOnly
        c.intento_exitoso(intento)
        c.purgar_intentos()                 # de vez en cuando: login_intentos no debe crecer sin límite
        return c.responder(
            self,
            200,
            {
                "ok": True,
                "usuario": {"nombre": perfil.get("nombre"), "rol": perfil.get("rol")},
                "debe_cambiar_clave": bool(perfil.get("debe_cambiar_clave")),
            },
            cookies=c.cookies_sesion(sesion),
        )

    do_GET = do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido

    def do_OPTIONS(self):
        # Sin CORS: el frontend y la API viven en el mismo origen.
        self.send_response(204)
        self.end_headers()
