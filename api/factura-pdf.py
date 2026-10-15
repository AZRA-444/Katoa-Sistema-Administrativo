"""/api/factura-pdf

GET  ?id=FAC-...                       → devuelve el PDF (tamaño carta) para verlo/imprimirlo.
POST {id_factura, telefono}            → reenvía ese PDF por WhatsApp (botón «Reintentar»).

Exige sesión activa (cookie HttpOnly). El PDF se genera al guardar la factura
(api/enviar-factura.py) y vive en el bucket privado `facturas` de Supabase Storage.

Permisos (antes cualquier usuario podía ver cualquier factura y enviarla a cualquier número):
  · «personal» solo puede ver/reenviar facturas que emitió él mismo.
  · El WhatsApp va al teléfono guardado en la factura. Enviarlo a OTRO número exige rol encargado o superior.
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


def _digitos(tel):
    """Últimos 10 dígitos: compara +58 412 1234567, 0412-1234567 y 4121234567 como el mismo número."""
    return re.sub(r"\D", "", tel or "")[-10:]


def _factura(id_factura):
    r = c._http.get(f"{c.SUPABASE_URL}/rest/v1/facturas",
                    params={"select": "id_factura,vendedor,telefono", "id_factura": f"eq.{id_factura}", "limit": "1"},
                    headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if r.status_code != 200:
        print(f"[factura-pdf] facturas {r.status_code}: {r.text[:200]}", file=sys.stderr)
        raise RuntimeError("consulta de factura fallida")
    filas = r.json()
    return filas[0] if filas else None


def _autorizar(u, id_factura):
    """Devuelve la fila de la factura si este usuario puede verla; si no, lanza ErrorPeticion."""
    f = _factura(id_factura)
    if not f:
        raise c.ErrorPeticion(404, "No se encontró la factura.")
    if c.NIVELES.get(u["rol"], 0) < c.NIVELES["encargado"] and (f.get("vendedor") or "") != (u.get("nombre") or ""):
        raise c.ErrorPeticion(403, "Solo puedes ver las facturas que emitiste tú.")
    return f


class handler(BaseHTTPRequestHandler):
    def log_message(self, *args):   # sin log por petición: la URL lleva cédulas y búsquedas de clientes
        pass

    def _validar(self):
        """Devuelve True si se puede continuar; si no, ya respondió el error."""
        if not c.config_completa():
            _error(self, 500, "Configuración del servidor incompleta.")
        elif not c.origen_valido(self):
            _error(self, 403, "Origen no permitido.")
        else:
            self.usuario = c.usuario_sesion(self)
            if not self.usuario:
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
            _autorizar(self.usuario, id_factura)
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
            f = _autorizar(self.usuario, id_factura)
            if _digitos(telefono) != _digitos(f.get("telefono")) and c.NIVELES.get(self.usuario["rol"], 0) < c.NIVELES["encargado"]:
                return _error(self, 403, "Solo un encargado puede enviar la factura a un número distinto al del cliente.")
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
