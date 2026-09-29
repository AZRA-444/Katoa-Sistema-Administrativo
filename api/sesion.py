"""GET /api/sesion

Comprueba la sesión a partir de las cookies HttpOnly. Si el access token venció
pero el refresh token sigue vigente, renueva la sesión de forma transparente.
Devuelve el usuario y su rol leído de la tabla `perfiles` (fuente de verdad).
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

MSG_NO_DISPONIBLE = "Servicio no disponible. Intenta de nuevo en un momento."


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not c.config_completa():
            return c.responder(self, 500, {"error": "Configuración del servidor incompleta."})

        cookies = c.leer_cookies(self)
        access = cookies.get(c.COOKIE_ACCESS)
        refresh = cookies.get(c.COOKIE_REFRESH)
        nuevas_cookies = []

        try:
            usuario = c.auth_usuario(access) if access else None

            if not usuario and refresh:
                renovada = c.auth_refresh(refresh)
                if renovada:
                    access = renovada["access_token"]
                    nuevas_cookies = c.cookies_sesion(renovada)
                    usuario = c.auth_usuario(access)

            if not usuario:
                return c.responder(
                    self, 401, {"autenticado": False},
                    cookies=c.cookies_borrar() if (access or refresh) else (),
                )

            perfil = c.obtener_perfil(usuario["id"])
        except (requests.RequestException, RuntimeError):
            return c.responder(self, 503, {"error": MSG_NO_DISPONIBLE})

        if perfil is None or not perfil.get("activo"):
            c.auth_logout(access)
            return c.responder(
                self, 403, {"autenticado": False, "error": "Cuenta sin acceso."},
                cookies=c.cookies_borrar(),
            )

        return c.responder(
            self,
            200,
            {
                "autenticado": True,
                "usuario": {
                    "id": usuario["id"],
                    "email": usuario.get("email"),
                    "nombre": perfil.get("nombre"),
                    "rol": perfil.get("rol"),
                },
                "debe_cambiar_clave": bool(perfil.get("debe_cambiar_clave")),
            },
            cookies=nuevas_cookies,
        )

    do_POST = do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido
