"""/api/administrador  (solo admin y sysadmin)

GET  ?mes=AAAA-MM -> {ventas, egresos, costo_ventas, categorias}
POST {accion: "egreso_crear" | "egreso_eliminar", ...}

Ventas: tabla `facturas`. Costo de ventas: `inv_kardex` (SALIDA_VENTA - DEVOLUCION_CLIENTE).
Egresos: tabla `egresos` (ver sql/egresos.sql). Las fechas del mes se calculan en hora de Venezuela (UTC-4).
"""
import os
import re
import sys
from datetime import date
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

MAX_BODY = 16 * 1024
LIMITE = 5000
MES_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
FECHA_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CATEGORIAS = ["Alquiler", "Servicios", "Nómina", "Comisiones", "Publicidad", "Transporte",
              "Impuestos", "Mantenimiento", "Otros"]
FECHA_COLS = ("creado_en", "created_at", "fecha")  # columna de fecha de `facturas` (se detecta sola)
_fecha_col = None


def _get(tabla, params):
    return c._http.get(f"{c.SUPABASE_URL}/rest/v1/{tabla}", params=params, headers=c._hdr_servicio(), timeout=c.TIMEOUT)


def _fallo(r, tabla):
    print(f"[administrador] {tabla} {r.status_code}: {r.text[:300]}", file=sys.stderr)
    raise c.ErrorPeticion(502, "No se pudieron consultar los datos. Inténtalo de nuevo.")


def _rango(mes):
    y, m = int(mes[:4]), int(mes[5:])
    return date(y, m, 1), date(y + (m == 12), m % 12 + 1, 1)


def _ventas(ini, fin):
    global _fecha_col
    for col in ([_fecha_col] if _fecha_col else FECHA_COLS):
        r = _get("facturas", [("select", "*"), ("order", f"{col}.desc"), ("limit", str(LIMITE)),
                              (col, f"gte.{ini}T00:00:00-04:00"), (col, f"lt.{fin}T00:00:00-04:00")])
        if r.status_code == 200:
            _fecha_col = col
            break
        if r.status_code != 400:  # 400 = la columna no existe: se prueba la siguiente
            _fallo(r, "facturas")
    else:
        raise c.ErrorPeticion(500, "No se encontró la columna de fecha de las facturas.")
    salida = []
    for f in r.json():
        if f.get("anulada") is True or str(f.get("estado") or "").lower() in ("anulada", "cancelada"):
            continue
        salida.append({
            "id_factura": f.get("id_factura"), "nombre": f.get("nombre"), "apellido": f.get("apellido"),
            "cedula": f.get("cedula"), "vendedor": f.get("vendedor") or "Sin vendedor",
            "total_usd": float(f.get("total_usd") or 0), "metodo_pago": f.get("metodo_pago"),
            "pagos_combinados": f.get("pagos_combinados"), "fecha": f.get(_fecha_col),
        })
    return salida


def _costo_ventas(ini, fin):
    """Costo de la mercancía vendida según el kardex. None si no se puede calcular."""
    try:
        r = _get("inv_kardex", [("select", "tipo,cantidad,costo_unitario"), ("limit", "20000"),
                                ("tipo", "in.(SALIDA_VENTA,DEVOLUCION_CLIENTE)"),
                                ("creado_en", f"gte.{ini}T00:00:00-04:00"), ("creado_en", f"lt.{fin}T00:00:00-04:00")])
        if r.status_code != 200:
            return None
        total = 0.0
        for f in r.json():
            v = abs(float(f.get("cantidad") or 0)) * float(f.get("costo_unitario") or 0)
            total += v if f.get("tipo") == "SALIDA_VENTA" else -v
        return round(total, 2)
    except (requests.RequestException, ValueError):
        return None


def _egresos(ini, fin):
    r = _get("egresos", [("select", "id,fecha,categoria,descripcion,proveedor,monto_usd"),
                         ("order", "fecha.desc,id.desc"), ("limit", str(LIMITE)),
                         ("fecha", f"gte.{ini}"), ("fecha", f"lt.{fin}")])
    if r.status_code != 200:
        _fallo(r, "egresos")
    return r.json()


def _texto(v, nombre, minimo, maximo):
    s = v.strip() if isinstance(v, str) else ""
    if not minimo <= len(s) <= maximo:
        raise c.ErrorPeticion(400, f"{nombre}: entre {minimo} y {maximo} caracteres.")
    return s


def _crear(d, u):
    fecha = d.get("fecha")
    try:
        if not (isinstance(fecha, str) and FECHA_RE.match(fecha)):
            raise ValueError
        date.fromisoformat(fecha)
    except ValueError:
        raise c.ErrorPeticion(400, "Fecha inválida.") from None
    if d.get("categoria") not in CATEGORIAS:
        raise c.ErrorPeticion(400, "Categoría inválida.")
    monto = d.get("monto_usd")
    if isinstance(monto, bool) or not isinstance(monto, (int, float)) or not 0.01 <= monto <= 10_000_000:
        raise c.ErrorPeticion(400, "Monto inválido.")
    fila = {"fecha": fecha, "categoria": d["categoria"], "monto_usd": round(float(monto), 2), "creado_por": u["id"],
            "descripcion": _texto(d.get("descripcion"), "La descripción", 3, 150),
            "proveedor": (_texto(d.get("proveedor"), "El proveedor", 1, 80) if d.get("proveedor") else None)}
    r = c._http.post(f"{c.SUPABASE_URL}/rest/v1/egresos", json=fila,
                     headers=c._hdr_servicio({"Prefer": "return=minimal"}), timeout=c.TIMEOUT)
    if r.status_code not in (200, 201, 204):
        _fallo(r, "egresos")


def _eliminar(d):
    i = d.get("id")
    if isinstance(i, bool) or not isinstance(i, int) or i < 1:
        raise c.ErrorPeticion(400, "Egreso inválido.")
    r = c._http.delete(f"{c.SUPABASE_URL}/rest/v1/egresos", params={"id": f"eq.{i}"},
                       headers=c._hdr_servicio({"Prefer": "return=minimal"}), timeout=c.TIMEOUT)
    if r.status_code not in (200, 204):
        _fallo(r, "egresos")


def _entrada(h, escribe=False):
    if not c.config_completa():
        raise c.ErrorPeticion(500, "Configuración del servidor incompleta.")
    if escribe and not c.origen_valido(h):
        raise c.ErrorPeticion(403, "Origen no permitido.")
    u = c.usuario_sesion(h)
    if not u:
        raise c.ErrorPeticion(401, "Sesión expirada. Inicia sesión de nuevo.")
    if not c.es_admin(u):
        raise c.ErrorPeticion(403, "No tienes permiso para esta sección.")
    return u


class handler(BaseHTTPRequestHandler):
    def _ok(self, **extra):
        c.responder(self, 200, {"status": "ok", **extra})

    def _error(self, e):
        c.responder(self, e.status, {"status": "error", "message": e.mensaje})

    def do_GET(self):
        try:
            _entrada(self)
            mes = (parse_qs(urlparse(self.path).query).get("mes", [""])[0] or "").strip()
            if not MES_RE.match(mes):
                raise c.ErrorPeticion(400, "Mes inválido.")
            ini, fin = _rango(mes)
            self._ok(ventas=_ventas(ini, fin), egresos=_egresos(ini, fin),
                     costo_ventas=_costo_ventas(ini, fin), categorias=CATEGORIAS)
        except c.ErrorPeticion as e:
            self._error(e)
        except (requests.RequestException, RuntimeError) as e:
            print(f"[administrador] GET {e}", file=sys.stderr)
            c.responder(self, 503, {"status": "error", "message": "Servicio no disponible. Inténtalo de nuevo."})

    def do_POST(self):
        try:
            u = _entrada(self, escribe=True)
            d = c.leer_json(self, MAX_BODY)
            if d.get("accion") == "egreso_crear":
                _crear(d, u)
                self._ok(message="Egreso registrado.")
            elif d.get("accion") == "egreso_eliminar":
                _eliminar(d)
                self._ok(message="Egreso eliminado.")
            else:
                raise c.ErrorPeticion(400, "Acción no válida.")
        except c.ErrorPeticion as e:
            self._error(e)
        except (requests.RequestException, RuntimeError) as e:
            print(f"[administrador] POST {e}", file=sys.stderr)
            c.responder(self, 503, {"status": "error", "message": "Servicio no disponible. Inténtalo de nuevo."})

    do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido
