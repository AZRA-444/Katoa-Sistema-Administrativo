"""/api/inventario

GET (cualquier sesión activa):
    ?q=texto | código de barras          -> búsqueda para facturación (sin costos)
GET (encargado, admin, sysadmin):
    ?modo=lista    [&seccion=&q=&alerta=bajo|alto]
    ?modo=kardex   [&variante=&tipo=&usuario=&seccion=&desde=&hasta=]
    ?modo=secciones | ?modo=proveedores
POST (solo admin y sysadmin), JSON {"accion": ...}:
    crear | llegada | salida | ajuste | proveedor
El stock solo cambia mediante funciones SQL (inv_mover): el kardex siempre queda registrado.
"""
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

MAX_BODY = 64 * 1024
TIPOS = {"REGISTRO", "LLEGADA", "SALIDA_VENTA", "SALIDA_OTRO", "AJUSTE_ENTRADA",
         "AJUSTE_SALIDA", "DEVOLUCION_CLIENTE", "DEVOLUCION_PROVEEDOR"}
UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
FECHA_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
COLS_BUSQUEDA = ("id,nombre,marca,color,talla,cantidad,precio_detal,precio_mayor,precio_gran_mayor,"
                 "cantidad_mayor,cantidad_gran_mayor,codigo_barras,imagen")
COLS_LISTA = COLS_BUSQUEDA + ",producto_id,seccion,seccion_id,cantidad_minima,cantidad_maxima,maneja_lotes,alerta"

MENSAJES = {
    "lote_requerido": "Este producto maneja lotes: indica el lote y la fecha de vencimiento.",
    "variante_no_encontrada": "La variante no existe o está inactiva.",
    "cantidad_invalida": "La cantidad debe ser un número entero mayor que cero.",
    "variantes_requeridas": "Agrega al menos una variante.",
    "lineas_requeridas": "Agrega al menos una línea.",
    "maximo_imagenes": "Cada variante admite hasta 4 imágenes.",
    "23505": "Ya existe un registro con ese código de barras o con esa combinación de color y talla.",
    "23514": "Algún valor no cumple las reglas (precios, cantidades o motivo).",
    "22P02": "Algún dato tiene un formato inválido.",
    "23503": "Una referencia (sección, proveedor o variante) no existe.",
}


def _traducir(texto):
    m = re.search(r'stock_insuficiente:([^"\\]+)', texto)
    if m:
        return f"Stock insuficiente: {m.group(1).strip()}."
    for clave, msg in MENSAJES.items():
        if clave in texto:
            return msg
    return None


def _rpc(nombre, params):
    r = c._http.post(f"{c.SUPABASE_URL}/rest/v1/rpc/{nombre}", json=params,
                     headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if r.status_code not in (200, 204):
        print(f"[inventario] rpc {nombre} {r.status_code}: {r.text[:400]}", file=sys.stderr)
        if r.status_code >= 500:
            raise c.ErrorPeticion(502, "No se pudo completar la operación. Inténtalo de nuevo.")
        raise c.ErrorPeticion(409 if "stock_insuficiente" in r.text else 400,
                              _traducir(r.text) or "No se pudo completar la operación.")
    return r


def _leer(tabla, params, insertar=None):
    if insertar is None:
        r = c._http.get(f"{c.SUPABASE_URL}/rest/v1/{tabla}", params=params,
                        headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    else:
        r = c._http.post(f"{c.SUPABASE_URL}/rest/v1/{tabla}", json=insertar,
                         headers={**c._hdr_servicio(), "Prefer": "return=representation"}, timeout=c.TIMEOUT)
    if r.status_code not in (200, 201):
        print(f"[inventario] {tabla} {r.status_code}: {r.text[:400]}", file=sys.stderr)
        raise c.ErrorPeticion(400 if r.status_code == 409 else 502,
                              _traducir(r.text) or "No se pudo completar la operación.")
    return r.json()


# ── Validación ──────────────────────────────────────────────────────────────
def _entero(v, nombre, minimo=1, maximo=1_000_000, obligatorio=True):
    if v in (None, ""):
        if obligatorio:
            raise c.ErrorPeticion(400, f"Indica {nombre}.")
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    try:
        f = float(v)
    except ValueError:
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.") from None
    if f != int(f) or not (minimo <= f <= maximo):
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    return int(f)


def _numero(v, nombre, minimo=0.01, maximo=1_000_000):
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    try:
        f = float(v)
    except ValueError:
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.") from None
    if not (minimo <= f <= maximo) or f != f:
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    return round(f, 2)


def _texto(v, nombre, maximo, obligatorio=True, minimo=1):
    s = (v or "").strip() if isinstance(v, str) or v is None else None
    if s is None:
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    if not s and not obligatorio:
        return None
    if len(s) < minimo or len(s) > maximo:
        raise c.ErrorPeticion(400, f"{nombre[0].upper() + nombre[1:]}: entre {minimo} y {maximo} caracteres.")
    return s


# ── Sesión y permisos ───────────────────────────────────────────────────────
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


# ── Lecturas ────────────────────────────────────────────────────────────────
def _buscar(qs, u):
    q = re.sub(r"[^\w\s.\-]", "", (qs.get("q", [""])[0] or ""))[:60].strip()
    if len(q) < 2:
        return []
    params = [("select", COLS_BUSQUEDA), ("activo", "is.true"), ("order", "nombre.asc"), ("limit", "15")]
    if q.isdigit() and len(q) >= 6:
        params.append(("codigo_barras", f"eq.{q}"))
    else:
        params.append(("or", f"(nombre.ilike.*{q}*,marca.ilike.*{q}*,color.ilike.*{q}*,talla.ilike.*{q}*)"))
    return _leer("inv_catalogo", params)


def _lista(qs, u):
    q = re.sub(r"[^\w\s.\-]", "", (qs.get("q", [""])[0] or ""))[:60].strip()
    cols = COLS_LISTA + (",precio_costo" if c.es_admin(u) else "")
    params = [("select", cols), ("order", "nombre.asc"), ("limit", "200")]
    if qs.get("seccion"):
        params.append(("seccion_id", f"eq.{_entero(qs['seccion'][0], 'la sección', 1, 32000)}"))
    if qs.get("alerta", [""])[0] in ("bajo", "alto"):
        params.append(("alerta", f"eq.{qs['alerta'][0]}"))
    if len(q) >= 2:
        if q.isdigit() and len(q) >= 6:
            params.append(("codigo_barras", f"eq.{q}"))
        else:
            params.append(("or", f"(nombre.ilike.*{q}*,marca.ilike.*{q}*,color.ilike.*{q}*,talla.ilike.*{q}*)"))
    return _leer("inv_catalogo", params)


def _kardex(qs, u):
    params = [("select", "*"), ("order", "creado_en.desc,id.desc"), ("limit", "300")]
    g = lambda k: (qs.get(k, [""])[0] or "").strip()  # noqa: E731
    if g("variante"):
        params.append(("variante_id", f"eq.{_entero(g('variante'), 'la variante')}"))
    if g("seccion"):
        params.append(("seccion_id", f"eq.{_entero(g('seccion'), 'la sección', 1, 32000)}"))
    if g("tipo"):
        if g("tipo") not in TIPOS:
            raise c.ErrorPeticion(400, "Tipo de movimiento inválido.")
        params.append(("tipo", f"eq.{g('tipo')}"))
    if g("usuario"):
        if not UUID_RE.match(g("usuario")):
            raise c.ErrorPeticion(400, "Usuario inválido.")
        params.append(("usuario_id", f"eq.{g('usuario')}"))
    for clave, op, hora in (("desde", "gte", "00:00:00"), ("hasta", "lte", "23:59:59")):
        if g(clave):
            if not FECHA_RE.match(g(clave)):
                raise c.ErrorPeticion(400, "Fecha inválida.")
            params.append(("creado_en", f"{op}.{g(clave)}T{hora}-04:00"))   # hora de Venezuela (UTC-4)
    return _leer("inv_kardex", params)


# ── Escrituras (solo admin) ─────────────────────────────────────────────────
def _crear(d, u):
    prod, variantes = d.get("producto"), d.get("variantes")
    if not isinstance(prod, dict) or not isinstance(variantes, list) or not 1 <= len(variantes) <= 50:
        raise c.ErrorPeticion(400, "Datos del producto incompletos.")
    limpio = {
        "nombre": _texto(prod.get("nombre"), "el nombre", 120),
        "seccion_id": _entero(prod.get("seccion_id"), "la sección", 1, 32000),
        "marca": _texto(prod.get("marca"), "la marca", 60, obligatorio=False),
        "descripcion": _texto(prod.get("descripcion"), "la descripción", 1000, obligatorio=False),
    }
    for v in variantes:
        if not isinstance(v, dict):
            raise c.ErrorPeticion(400, "Variante inválida.")
        _numero(v.get("precio_detal"), "el precio detal")
        _numero(v.get("precio_costo", 0), "el precio de costo", 0)
        _entero(v.get("cantidad_inicial", 0), "la cantidad inicial", 0, 1_000_000, False)
    _rpc("inv_crear_producto", {"p_usuario": u["id"], "p_producto": limpio, "p_variantes": variantes})
    return "Producto registrado."


def _llegada(d, u):
    lineas = d.get("lineas")
    if not isinstance(lineas, list) or not 1 <= len(lineas) <= 100:
        raise c.ErrorPeticion(400, "Agrega entre 1 y 100 líneas.")
    salida = []
    for ln in lineas:
        if not isinstance(ln, dict):
            raise c.ErrorPeticion(400, "Línea inválida.")
        salida.append({
            "variante_id": _entero(ln.get("variante_id"), "la variante"),
            "cantidad": _entero(ln.get("cantidad"), "la cantidad", 1, 100_000),
            "costo": _numero(ln.get("costo"), "el costo"),
            "lote": _texto(ln.get("lote"), "el lote", 40, obligatorio=False),
            "vencimiento": ln.get("vencimiento") or None,
        })
        if salida[-1]["vencimiento"] and not FECHA_RE.match(str(salida[-1]["vencimiento"])):
            raise c.ErrorPeticion(400, "Fecha de vencimiento inválida.")
    _rpc("inv_llegada", {
        "p_usuario": u["id"],
        "p_proveedor": _entero(d.get("proveedor_id"), "el proveedor", 1, 10**9, False),
        "p_factura": _texto(d.get("numero_factura"), "el número de factura", 40, obligatorio=False),
        "p_notas": _texto(d.get("notas"), "las notas", 300, obligatorio=False),
        "p_lineas": salida,
    })
    return "Llegada registrada."


def _mover(d, u, tipo):
    _rpc("inv_mover", {
        "p_variante": _entero(d.get("variante_id"), "la variante"),
        "p_tipo": tipo,
        "p_cantidad": _entero(d.get("cantidad"), "la cantidad", 1, 100_000),
        "p_usuario": u["id"],
        "p_motivo": _texto(d.get("motivo"), "el motivo", 300, minimo=3),
    })


def _proveedor(d, u):
    _leer("inv_proveedores", None, insertar={
        "nombre": _texto(d.get("nombre"), "el nombre", 120),
        "contacto": _texto(d.get("contacto"), "el contacto", 200, obligatorio=False),
    })
    return "Proveedor registrado."


class handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _ok(self, **extra):
        c.responder(self, 200, {"status": "ok", **extra})

    def _fallo(self, e):
        c.responder(self, e.status, {"status": "error", "message": e.mensaje})

    def do_GET(self):
        try:
            qs = parse_qs(urlparse(self.path).query)
            modo = (qs.get("modo", ["buscar"])[0] or "buscar")
            if modo == "buscar":
                return self._ok(data=_buscar(qs, _entrada(self, "personal")))
            u = _entrada(self, "encargado")
            if modo == "lista":
                return self._ok(data=_lista(qs, u))
            if modo == "kardex":
                return self._ok(data=_kardex(qs, u))
            if modo == "secciones":
                return self._ok(data=_leer("inv_secciones", [("select", "id,nombre"), ("activo", "is.true"), ("order", "id")]))
            if modo == "proveedores":
                return self._ok(data=_leer("inv_proveedores", [("select", "id,nombre,contacto"), ("activo", "is.true"), ("order", "nombre")]))
            raise c.ErrorPeticion(400, "Modo no válido.")
        except c.ErrorPeticion as e:
            self._fallo(e)
        except (requests.RequestException, RuntimeError) as e:
            print(f"[inventario] GET {e}", file=sys.stderr)
            c.responder(self, 503, {"status": "error", "message": "Servicio no disponible. Inténtalo de nuevo."})

    def do_POST(self):
        try:
            u = _entrada(self, "admin")
            d = c.leer_json(self, MAX_BODY)
            accion = d.get("accion")
            if accion == "crear":
                msg = _crear(d, u)
            elif accion == "llegada":
                msg = _llegada(d, u)
            elif accion == "salida":
                _mover(d, u, "SALIDA_OTRO")
                msg = "Salida registrada."
            elif accion == "ajuste":
                sentido = d.get("sentido")
                if sentido not in ("entrada", "salida"):
                    raise c.ErrorPeticion(400, "Indica si el ajuste es de entrada o de salida.")
                _mover(d, u, "AJUSTE_ENTRADA" if sentido == "entrada" else "AJUSTE_SALIDA")
                msg = "Ajuste registrado."
            elif accion == "proveedor":
                msg = _proveedor(d, u)
            else:
                raise c.ErrorPeticion(400, "Acción no válida.")
            self._ok(message=msg)
        except c.ErrorPeticion as e:
            self._fallo(e)
        except (requests.RequestException, RuntimeError) as e:
            print(f"[inventario] POST {e}", file=sys.stderr)
            c.responder(self, 503, {"status": "error", "message": "Servicio no disponible. Inténtalo de nuevo."})
