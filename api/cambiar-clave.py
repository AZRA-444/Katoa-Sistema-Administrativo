"""POST /api/cambiar-clave   {"password_actual": "...", "password_nueva": "..."}

Cambia la contraseña del usuario con sesión y apaga `perfiles.debe_cambiar_clave`.

Mientras ese indicador esté activo, el resto de la API responde 403 (ver c.usuario_sesion): este es el
único endpoint protegido al que se puede llegar con una clave temporal.

Seguridad:
  - Pide la contraseña ACTUAL y la comprueba contra Supabase Auth (una sesión robada no basta).
  - Los intentos fallidos cuentan en el mismo límite que el login (por correo e IP).
  - Política de la nueva clave: 10 a 72 caracteres (72 bytes es el máximo de Supabase), con letras y
    números, distinta de la actual y sin contener la parte local del correo.
  - Al terminar revoca las DEMÁS sesiones del usuario (la actual sigue abierta).
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

MIN_CLAVE = 10
MAX_BYTES_CLAVE = 72  # límite de bcrypt/Supabase

MSG_NO_DISPONIBLE = "Servicio no disponible. Intenta de nuevo en un momento."
MSG_BLOQUEO = "Demasiados intentos fallidos. Intenta de nuevo en unos minutos."
MSG_ACTUAL = "La contraseña actual no es correcta."
MSG_PARCIAL = (
    "Tu contraseña se cambió, pero no pudimos terminar el proceso. "
    "Inténtalo de nuevo usando la contraseña nueva como «actual»."
)


def validar_nueva(nueva, actual, email):
    """Lanza ErrorPeticion(400) si la contraseña nueva no cumple la política."""
    if not isinstance(nueva, str) or not isinstance(actual, str):
        raise c.ErrorPeticion(400, "Solicitud inválida.")
    if not actual:
        raise c.ErrorPeticion(400, "Escribe tu contraseña actual.")
    if len(nueva) < MIN_CLAVE:
        raise c.ErrorPeticion(400, f"La contraseña nueva debe tener al menos {MIN_CLAVE} caracteres.")
    if len(nueva.encode("utf-8")) > MAX_BYTES_CLAVE:
        raise c.ErrorPeticion(400, f"La contraseña nueva es demasiado larga (máximo {MAX_BYTES_CLAVE} caracteres).")
    if not (any(ch.isalpha() for ch in nueva) and any(ch.isdigit() for ch in nueva)):
        raise c.ErrorPeticion(400, "La contraseña nueva debe combinar letras y números.")
    if nueva == actual:
        raise c.ErrorPeticion(400, "La contraseña nueva debe ser distinta de la actual.")
    local = str(email or "").split("@")[0].lower()
    if len(local) >= 4 and local in nueva.lower():
        raise c.ErrorPeticion(400, "La contraseña nueva no debe contener tu correo.")


def _error(h, status, mensaje):
    c.responder(h, status, {"error": mensaje})


def _verificar_actual(email, ip, actual):
    """Comprueba la contraseña actual con el mismo límite de intentos que el login."""
    if c.contar_fallos("email", email) >= c.MAX_FALLOS_EMAIL or c.contar_fallos("ip", ip) >= c.MAX_FALLOS_IP:
        raise c.ErrorPeticion(429, MSG_BLOQUEO)
    r = c.auth_password(email, actual)
    if r.status_code in (400, 401, 422):
        c.registrar_intento(email, ip, False, "cambio_clave")
        raise c.ErrorPeticion(403, MSG_ACTUAL)
    if r.status_code == 429:
        raise c.ErrorPeticion(429, MSG_BLOQUEO)
    if r.status_code != 200:
        print(f"[cambiar-clave] Supabase respondió {r.status_code} al verificar", file=sys.stderr)
        raise c.ErrorPeticion(503, MSG_NO_DISPONIBLE)
    # La comprobación abrió una sesión extra en Supabase: se revoca para no dejarla viva.
    try:
        c.auth_logout(r.json().get("access_token"))
    except ValueError:
        pass


def _aplicar_cambio(access, nueva):
    r = c.auth_cambiar_password(access, nueva)
    if r.status_code == 200:
        return
    if r.status_code in (401, 403):
        raise c.ErrorPeticion(401, "Sesión expirada. Inicia sesión de nuevo.")
    if r.status_code == 422:
        try:
            codigo = str(r.json().get("error_code") or r.json().get("code") or "")
        except ValueError:
            codigo = ""
        if "same_password" in codigo or "same_password" in r.text:
            raise c.ErrorPeticion(400, "La contraseña nueva debe ser distinta de la actual.")
        if "weak_password" in codigo or "weak_password" in r.text:
            raise c.ErrorPeticion(400, "La contraseña es demasiado fácil de adivinar. Elige otra más segura.")
        raise c.ErrorPeticion(400, "No se aceptó la contraseña nueva. Prueba con otra.")
    print(f"[cambiar-clave] Supabase respondió {r.status_code} al cambiar la clave", file=sys.stderr)
    raise c.ErrorPeticion(503, MSG_NO_DISPONIBLE)


class handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        if not c.config_completa():
            return _error(self, 500, "Configuración del servidor incompleta.")
        if not c.origen_valido(self):
            return _error(self, 403, "Origen no permitido.")
        try:
            usuario = c.usuario_sesion(self, permitir_cambio_pendiente=True)
            if not usuario or not usuario.get("email"):
                return _error(self, 401, "Sesión expirada. Inicia sesión de nuevo.")
            datos = c.leer_json(self, 4096)
            actual, nueva = datos.get("password_actual"), datos.get("password_nueva")
            validar_nueva(nueva, actual, usuario["email"])

            _verificar_actual(usuario["email"].strip().lower(), c.ip_cliente(self), actual)

            access = c.leer_cookies(self).get(c.COOKIE_ACCESS)
            _aplicar_cambio(access, nueva)

            # La clave ya cambió: apagar el indicador (idempotente, se intenta dos veces).
            apagado = False
            for _ in range(2):
                try:
                    c.marcar_clave_cambiada(usuario["id"])
                    apagado = True
                    break
                except requests.RequestException as e:
                    print(f"[cambiar-clave] no se pudo apagar debe_cambiar_clave: {e!r}", file=sys.stderr)
            if not apagado:
                return _error(self, 503, MSG_PARCIAL)

            c.auth_logout(access, scope="others")  # cierra las demás sesiones (mejor esfuerzo)
        except c.ErrorPeticion as e:
            return _error(self, e.status, e.mensaje)
        except (requests.RequestException, RuntimeError):
            return _error(self, 503, MSG_NO_DISPONIBLE)
        except Exception as e:  # noqa: BLE001 - nunca dejar escapar un 500 sin JSON
            print(f"[cambiar-clave] inesperado {type(e).__name__}: {e}", file=sys.stderr)
            return _error(self, 500, "Error interno. Inténtalo de nuevo.")
        return c.responder(self, 200, {"ok": True})

    do_GET = do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido

    def do_OPTIONS(self):
        # Sin CORS: el frontend y la API viven en el mismo origen.
        self.send_response(204)
        self.end_headers()
