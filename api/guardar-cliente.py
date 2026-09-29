"""
/api/guardar-cliente

POST: Guarda o actualiza un cliente en Supabase.
GET:  Busca un cliente por cédula para autorrellenado (?cedula=12345678).
"""
import os
import re
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

MAX_BODY = 64 * 1024
CEDULA_RE = re.compile(r"^[\d.]+$")
TELEFONO_RE = re.compile(r"^\+?\d{10,15}$")

MSG_NO_DISPONIBLE = "Servicio no disponible. Intenta de nuevo en un momento."


def _err(mensaje, status=400):
    raise c.ErrorPeticion(status, mensaje)


def _texto(valor, nombre, maximo, obligatorio=True):
    if valor is None:
        valor = ""
    if not isinstance(valor, str):
        _err(f"Valor inválido en {nombre}.")
    valor = valor.strip()
    if obligatorio and not valor:
        _err(f"Falta {nombre}.")
    if len(valor) > maximo:
        _err(f"{nombre[0].upper() + nombre[1:]} es demasiado largo.")
    if any(ch < " " and ch not in "\n\t" for ch in valor):
        _err(f"Caracteres no permitidos en {nombre}.")
    return valor


def _sesion_activa(h):
    access = c.leer_cookies(h).get(c.COOKIE_ACCESS)
    if not access:
        return False
    usuario = c.auth_usuario(access)
    if not usuario:
        return False
    perfil = c.obtener_perfil(usuario["id"])
    return bool(perfil and perfil.get("activo"))


def _error(h, status, mensaje):
    c.responder(h, status, {"status": "error", "message": mensaje})


class handler(BaseHTTPRequestHandler):
    # ── GET: Consulta para Autorrellenado ───────────────────────────────────
    def do_GET(self):
        if not c.config_completa():
            return _error(self, 500, "Configuración del servidor incompleta.")
        if not c.origen_valido(self):
            return _error(self, 403, "Origen no permitido.")
        try:
            if not _sesion_activa(self):
                return _error(self, 401, "Sesión expirada.")

            # Extraer cédula de los parámetros (?cedula=12345678)
            parsed_url = urlparse(self.path)
            query_params = parse_qs(parsed_url.query)
            cedula_raw = query_params.get("cedula", [None])[0]

            cedula = _texto(cedula_raw, "la cédula", 15)
            if not CEDULA_RE.match(cedula) or not 6 <= len(re.sub(r"\D", "", cedula)) <= 8:
                _err("Cédula inválida.")

            # Consulta directa a Supabase por cédula
            url = f"{c.SUPABASE_URL}/rest/v1/clientes?cedula=eq.{cedula}&select=cedula,nombre,apellido,telefono"
            r = c._http.get(url, headers=c._hdr_servicio(), timeout=c.TIMEOUT)

            if r.status_code != 200:
                _err("Error al consultar el cliente.", 502)

            res = r.json()
            if not res:
                return c.responder(self, 404, {"status": "no_encontrado", "message": "Cliente no registrado."})

            cliente = res[0]
            return c.responder(
                self, 200,
                {"status": "ok", "cliente": cliente}
            )

        except c.ErrorPeticion as e:
            return _error(self, e.status, e.mensaje)
        except (requests.RequestException, RuntimeError):
            return _error(self, 503, MSG_NO_DISPONIBLE)

    # ── POST: Guardar o Actualizar Cliente ─────────────────────────────────
    def do_POST(self):
        if not c.config_completa():
            return _error(self, 500, "Configuración del servidor incompleta.")
        if not c.origen_valido(self):
            return _error(self, 403, "Origen no permitido.")
        try:
            if not _sesion_activa(self):
                return _error(self, 401, "Sesión expirada.")

            datos = c.leer_json(self, MAX_BODY)
            
            cedula = _texto(datos.get("cedula"), "la cédula", 15)
            if not CEDULA_RE.match(cedula) or not 6 <= len(re.sub(r"\D", "", cedula)) <= 8:
                _err("Cédula inválida.")

            nombre = _texto(datos.get("nombre"), "el nombre", 60)
            apellido = _texto(datos.get("apellido"), "el apellido", 60, obligatorio=False)
            telefono = _texto(datos.get("telefono"), "el teléfono", 16, obligatorio=False)
            if telefono and not TELEFONO_RE.match(telefono):
                _err("Teléfono inválido.")

            cliente = {
                "cedula": cedula,
                "nombre": nombre,
                "apellido": apellido,
                "telefono": telefono,
            }

            r = c._http.post(
                f"{c.SUPABASE_URL}/rest/v1/rpc/guardar_cliente",
                json={"p_cliente": cliente},
                headers=c._hdr_servicio(),
                timeout=c.TIMEOUT,
            )
            if r.status_code not in (200, 204):
                _err("No se pudo guardar el cliente.", 502)

            return c.responder(self, 200, {"status": "ok", "message": "Cliente guardado."})

        except c.ErrorPeticion as e:
            return _error(self, e.status, e.mensaje)
        except (requests.RequestException, RuntimeError):
            return _error(self, 503, MSG_NO_DISPONIBLE)

    do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()
