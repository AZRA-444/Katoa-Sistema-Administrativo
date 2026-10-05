"""
/api/tasa-usdt

GET: Devuelve la tasa USDT en bolívares (dólar paralelo) consultando ve.dolarapi.com desde el servidor.
     El navegador solo habla con el mismo origen, así no hay que ampliar el connect-src del CSP.
"""
import os
import sys
from http.server import BaseHTTPRequestHandler

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

FUENTE_URL = "https://ve.dolarapi.com/v1/dolares/paralelo"
MSG_NO_DISPONIBLE = "No se pudo consultar la tasa USDT. Escríbela a mano."


def _error(h, status, mensaje):
    c.responder(h, status, {"status": "error", "message": mensaje})


def consultar_tasa():
    """Consulta la fuente y devuelve {tasa, fuente, actualizado}. Lanza ErrorPeticion(502) si algo falla."""
    try:
        # requests.get directo (no c._http): no se deben enviar las cabeceras de Supabase a un tercero.
        r = requests.get(FUENTE_URL, timeout=c.TIMEOUT, headers={"Accept": "application/json"})
        datos = r.json() if r.status_code == 200 else None
    except (requests.RequestException, ValueError):
        datos = None
    if not isinstance(datos, dict):
        raise c.ErrorPeticion(502, MSG_NO_DISPONIBLE)

    tasa = datos.get("promedio") or datos.get("venta")
    if isinstance(tasa, bool) or not isinstance(tasa, (int, float)) or not 0 < tasa < 1_000_000:
        raise c.ErrorPeticion(502, MSG_NO_DISPONIBLE)
    return {
        "tasa": round(float(tasa), 2),
        "fuente": datos.get("fuente"),
        "actualizado": datos.get("fechaActualizacion"),
    }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not c.config_completa():
            return _error(self, 500, "Configuración del servidor incompleta.")
        if not c.origen_valido(self):
            return _error(self, 403, "Origen no permitido.")
        try:
            if not c.sesion_activa(self):
                return _error(self, 401, "Sesión expirada.")
            return c.responder(self, 200, {"status": "ok", **consultar_tasa()})
        except c.ErrorPeticion as e:
            return _error(self, e.status, e.mensaje)
        except (requests.RequestException, RuntimeError):
            return _error(self, 503, MSG_NO_DISPONIBLE)

    do_POST = do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()