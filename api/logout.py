"""POST /api/logout

Revoca la sesión en Supabase y borra las cookies.
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not c.origen_valido(self):
            return c.responder(self, 403, {"error": "Origen no permitido."})
        try:
            c.leer_json(self, 64)
        except c.ErrorPeticion as e:
            return c.responder(self, e.status, {"error": e.mensaje})

        access = c.leer_cookies(self).get(c.COOKIE_ACCESS)
        if access and c.config_completa():
            c.auth_logout(access)

        return c.responder(self, 200, {"ok": True}, cookies=c.cookies_borrar())

    do_GET = do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido
