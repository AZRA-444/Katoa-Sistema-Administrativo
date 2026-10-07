"""/api/historial — Facturas de hoy

GET (encargado, admin, sysadmin):
    (sin parámetros) | ?modo=hoy      -> facturas de HOY (hora de Venezuela) con sus productos
    ?modo=comprobante&id=FAC-...      -> imagen del comprobante de pago (bucket privado, se sirve por aquí)
POST (solo admin y sysadmin), JSON:
    {"accion": "anular", "id_factura": "...", "motivo": "..."}
        Marca la factura como anulada y devuelve el stock por el kardex (SQL: anular_factura), todo en una
        transacción. La factura NO se borra.

El PDF y el reenvío por WhatsApp ya existen en /api/factura-pdf.
"""
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

MAX_BODY = 4 * 1024
LIMITE = 300
BUCKET_COMPROBANTES = "comprobantes"
VENEZUELA = timezone(timedelta(hours=-4))  # sin horario de verano
ID_RE = re.compile(r"^[A-Za-z0-9\-]{1,64}$")
UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
COLS = ("id_factura,nombre,apellido,cedula,telefono,vendedor,subtotal_usd,total_usd,subtotal_bs,total_bs,"
        "metodo_pago,referencia,banco,created_at,comprobante_path,observaciones,tasa_cambio,pagos_combinados,"
        "estado,anulada_por,anulada_en,motivo_anulacion,"
        "factura_detalles(id,nombre_producto,cantidad,precio_unitario,precio_total)")

MENSAJES = {
    "factura_no_encontrada": (404, "La factura no existe."),
    "factura_ya_anulada": (409, "Esta factura ya estaba anulada."),
    "motivo_requerido": (400, "Escribe el motivo de la anulación (mínimo 3 caracteres)."),
    "variante_no_encontrada": (409, "Un producto de esta factura está inactivo: actívalo en Inventario y vuelve a intentarlo."),
    "lote_requerido": (409, "No se pudo devolver un producto con lote. Revisa el inventario."),
}


def _entrada(h, minimo):
    if not c.config_completa():
        raise c.ErrorPeticion(500, "Configuración del servidor incompleta.")
    if not c.origen_valido(h):
        raise c.ErrorPeticion(403, "Origen no permitido.")
    u = c.usuario_sesion(h)
    if not u:
        raise c.ErrorPeticion(401, "Sesión expirada. Inicia sesión de nuevo.")
    if c.NIVELES.get(u["rol"], 0) < c.NIVELES[minimo]:
        raise c.ErrorPeticion(403, "No tienes permiso para esta acción.")
    return u


def _get(ruta, params):
    r = c._http.get(f"{c.SUPABASE_URL}/rest/v1/{ruta}", params=params, headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if r.status_code != 200:
        print(f"[historial] {ruta} {r.status_code}: {r.text[:400]}", file=sys.stderr)
        raise c.ErrorPeticion(502, "No se pudieron cargar las facturas. Inténtalo de nuevo.")
    return r.json()


def _hoy():
    """Facturas desde las 00:00 de hoy (Venezuela) hasta las 00:00 de mañana."""
    inicio = datetime.now(VENEZUELA).replace(hour=0, minute=0, second=0, microsecond=0)
    params = [("select", COLS), ("order", "created_at.desc"), ("limit", str(LIMITE + 1)),
              ("created_at", f"gte.{inicio.isoformat()}"),
              ("created_at", f"lt.{(inicio + timedelta(days=1)).isoformat()}")]
    filas = _get("facturas", params)
    truncado = len(filas) > LIMITE
    filas = filas[:LIMITE]

    # Quién anuló (nombre del perfil), en una sola consulta
    ids = sorted({f["anulada_por"] for f in filas if f.get("anulada_por") and UUID_RE.match(f["anulada_por"])})
    nombres = {}
    if ids:
        for p in _get("perfiles", [("select", "id,nombre"), ("id", f"in.({','.join(ids)})")]):
            nombres[p["id"]] = p.get("nombre")
    for f in filas:
        f["anulada_por_nombre"] = nombres.get(f.get("anulada_por"))
        f["tiene_comprobante"] = bool(f.pop("comprobante_path", None))
        f.pop("anulada_por", None)
        f["factura_detalles"] = sorted(f.get("factura_detalles") or [], key=lambda d: d["id"])
    return filas, truncado


def _comprobante(id_factura):
    """Devuelve (bytes, content_type) del comprobante o lanza 404. La ruta sale de la BD, no del navegador."""
    if not ID_RE.match(id_factura):
        raise c.ErrorPeticion(400, "Id de factura inválido.")
    filas = _get("facturas", [("select", "comprobante_path"), ("id_factura", f"eq.{id_factura}"), ("limit", "1")])
    ruta = (filas[0].get("comprobante_path") if filas else None) or ""
    if not ruta or ".." in ruta or ruta.startswith("/"):
        raise c.ErrorPeticion(404, "Esta factura no tiene comprobante.")
    r = c._http.get(f"{c.SUPABASE_URL}/storage/v1/object/{BUCKET_COMPROBANTES}/{ruta}",
                    headers=c._hdr_servicio(), timeout=c.TIMEOUT * 2)
    if r.status_code != 200 or not r.content.startswith(b"\xff\xd8\xff"):
        raise c.ErrorPeticion(404, "No se encontró el comprobante.")
    return r.content


def _anular(d, u):
    id_factura = str(d.get("id_factura") or "")
    if not ID_RE.match(id_factura):
        raise c.ErrorPeticion(400, "Id de factura inválido.")
    motivo = re.sub(r"\s+", " ", str(d.get("motivo") or "")).strip()
    if not 3 <= len(motivo) <= 300:
        raise c.ErrorPeticion(400, "Escribe el motivo de la anulación (entre 3 y 300 caracteres).")
    r = c._http.post(f"{c.SUPABASE_URL}/rest/v1/rpc/anular_factura",
                     json={"p_id": id_factura, "p_motivo": motivo, "p_usuario": u["id"]},
                     headers=c._hdr_servicio(), timeout=c.TIMEOUT * 2)
    if r.status_code in (200, 204):
        return
    print(f"[historial] anular {id_factura} {r.status_code}: {r.text[:400]}", file=sys.stderr)
    for clave, (status, msg) in MENSAJES.items():
        if clave in r.text:
            raise c.ErrorPeticion(status, msg)
    if "stock_insuficiente" in r.text:
        raise c.ErrorPeticion(409, "No se pudo devolver el stock de un producto.")
    raise c.ErrorPeticion(502, "No se pudo anular la factura. Inténtalo de nuevo.")


class handler(BaseHTTPRequestHandler):
    def _fallo(self, e):
        c.responder(self, e.status, {"status": "error", "message": e.mensaje})

    def _error_interno(self, e, metodo):
        if isinstance(e, (requests.RequestException, RuntimeError)):
            print(f"[historial] {metodo} {e}", file=sys.stderr)
            return c.responder(self, 503, {"status": "error", "message": "Servicio no disponible. Inténtalo de nuevo."})
        print(f"[historial] {metodo} inesperado {type(e).__name__}: {e}", file=sys.stderr)
        c.responder(self, 500, {"status": "error", "message": "Error interno. Inténtalo de nuevo."})

    def do_GET(self):
        try:
            _entrada(self, "encargado")
            qs = parse_qs(urlparse(self.path).query)
            modo = (qs.get("modo", ["hoy"])[0] or "hoy")
            if modo == "hoy":
                filas, truncado = _hoy()
                return c.responder(self, 200, {"status": "ok", "data": filas, "truncado": truncado,
                                               "fecha": datetime.now(VENEZUELA).date().isoformat()})
            if modo == "comprobante":
                img = _comprobante((qs.get("id") or [""])[0])
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(img)))
                self.send_header("Cache-Control", "private, no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(img)
                return
            raise c.ErrorPeticion(400, "Modo no válido.")
        except c.ErrorPeticion as e:
            self._fallo(e)
        except Exception as e:  # noqa: BLE001 - nunca dejar escapar un 500 sin JSON
            self._error_interno(e, "GET")

    def do_POST(self):
        try:
            u = _entrada(self, "admin")
            d = c.leer_json(self, MAX_BODY)
            if d.get("accion") != "anular":
                raise c.ErrorPeticion(400, "Acción no válida.")
            _anular(d, u)
            c.responder(self, 200, {"status": "ok", "message": "Factura anulada y stock devuelto al inventario."})
        except c.ErrorPeticion as e:
            self._fallo(e)
        except Exception as e:  # noqa: BLE001
            self._error_interno(e, "POST")

    do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido
