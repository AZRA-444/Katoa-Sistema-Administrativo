"""/api/factura-pdf

GET  ?id=FAC-...                       → devuelve el PDF (tamaño carta) para verlo/imprimirlo.
POST {id_factura, telefono}            → reenvía ese PDF por WhatsApp (botón «Reintentar»).

Exige sesión activa (cookie HttpOnly). El PDF se genera al guardar la factura
(api/enviar-factura.py) y vive en el bucket privado `facturas` de Supabase Storage.
"""
import os
import re
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402
import _whatsapp as wa  # noqa: E402
from _factura_pdf import DOC_ARCHIVO  # noqa: E402

ID_RE = re.compile(r"^[A-Za-z0-9\-]{1,64}$")
TELEFONO_RE = re.compile(r"^\+?\d{10,15}$")
MSG_NO_DISPONIBLE = "Servicio no disponible. Intenta de nuevo en un momento."


def _error(h, status, mensaje):
    c.responder(h, status, {"status": "error", "message": mensaje})


class handler(BaseHTTPRequestHandler):
    def _validar(self):
        """Devuelve True si se puede continuar; si no, ya respondió el error."""
        if not c.config_completa():
            _error(self, 500, "Configuración del servidor incompleta.")
        elif not c.origen_valido(self):
            _error(self, 403, "Origen no permitido.")
        elif not c.sesion_activa(self):
            _error(self, 401, "Sesión expirada. Inicia sesión de nuevo.")
        else:
            return True
        return False

    def do_GET(self):
        try:
            if not self._validar():
                return
            id_factura = (parse_qs(urlparse(self.path).query).get("id") or [""])[0]
            if not ID_RE.match(id_factura):
                return _error(self, 400, "Id de factura inválido.")
            pdf = wa.descargar_pdf(id_factura)
        except c.ErrorPeticion as e:
            return _error(self, e.status, e.mensaje)
        except (requests.RequestException, RuntimeError):
            return _error(self, 503, MSG_NO_DISPONIBLE)
        if pdf is None:
            return _error(self, 404, "No se encontró el PDF de esta factura.")
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(pdf)))
        self.send_header("Content-Disposition", f'inline; filename="{DOC_ARCHIVO}-{id_factura}.pdf"')
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(pdf)

    def do_POST(self):
        try:
            if not self._validar():
                return
            datos = c.leer_json(self, 4096)
            id_factura = str(datos.get("id_factura") or "")
            telefono = str(datos.get("telefono") or "")
            if not ID_RE.match(id_factura):
                return _error(self, 400, "Id de factura inválido.")
            if not TELEFONO_RE.match(telefono):
                return _error(self, 400, "Teléfono inválido.")
            pdf = wa.descargar_pdf(id_factura)
            if pdf is None:
                return _error(self, 404, "No se encontró el PDF de esta factura.")
            estado = wa.enviar_pdf(telefono, id_factura, pdf)
        except c.ErrorPeticion as e:
            return _error(self, e.status, e.mensaje)
        except (requests.RequestException, RuntimeError):
            return _error(self, 503, MSG_NO_DISPONIBLE)
        c.responder(self, 200, {"status": "ok", "whatsapp": estado})

    do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()
