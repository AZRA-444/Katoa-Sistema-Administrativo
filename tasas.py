"""/api/tasas

GET ?tipo=bcv    -> tasa OFICIAL del BCV (Bs por USD)       · fuente: ve.dolarapi.com/v1/dolares/oficial
GET ?tipo=usdt   -> dólar paralelo / USDT (Bs por USDT)     · fuente: ve.dolarapi.com/v1/dolares/paralelo
     (sin «tipo» = usdt, como el antiguo /api/tasa-usdt)

Respuesta: {"status": "ok", "tasa": 123.45, "fuente": "oficial", "actualizado": "2026-10-14T..."}

El servidor consulta la fuente (con caché de unos minutos, ver api/_referencias.py): el navegador solo habla con
el mismo origen, así el CSP no necesita permitir ningún dominio de terceros. Reemplaza a /api/tasa-usdt; la tasa
«BCV» ya no sale de open.er-api.com (un agregador de mercado que no es la tasa oficial).
"""
import os
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402
import _referencias as ref  # noqa: E402

MSG_NO_DISPONIBLE = {
    "bcv": "No se pudo consultar la tasa oficial del BCV. Escríbela a mano.",
    "usdt": "No se pudo consultar la tasa USDT. Escríbela a mano.",
}


def _error(h, status, mensaje):
    c.responder(h, status, {"status": "error", "message": mensaje})


def consultar_tasa(tipo):
    """{tasa, fuente, actualizado} de la fuente. Lanza ErrorPeticion(502) si no hay dato."""
    info = ref.tasa_info(tipo)
    if info is None:
        raise c.ErrorPeticion(502, MSG_NO_DISPONIBLE[tipo])
    return {"tasa": round(float(info["tasa"]), 2), "fuente": info.get("fuente"), "actualizado": info.get("actualizado")}


class handler(BaseHTTPRequestHandler):
    def log_message(self, *args):   # sin log por petición
        pass

    def do_GET(self):
        if not c.config_completa():
            return _error(self, 500, "Configuración del servidor incompleta.")
        if not c.origen_valido(self):
            return _error(self, 403, "Origen no permitido.")
        tipo = (parse_qs(urlparse(self.path).query).get("tipo", ["usdt"])[0] or "usdt").lower()
        if tipo not in ref.URLS:
            return _error(self, 400, "Tipo de tasa no válido.")
        try:
            if not c.sesion_activa(self):
                return _error(self, 401, "Sesión expirada.")
            return c.responder(self, 200, {"status": "ok", **consultar_tasa(tipo)})
        except c.ErrorPeticion as e:
            return _error(self, e.status, e.mensaje)
        except (requests.RequestException, RuntimeError):
            return _error(self, 503, MSG_NO_DISPONIBLE[tipo])

    do_POST = do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()
