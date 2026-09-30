"""/api/inventario

GET (cualquier sesión activa):
    ?q=texto | código de barras          -> búsqueda para facturación (sin costos)
GET (encargado, admin, sysadmin):
    ?modo=lista    [&seccion=&q=&alerta=bajo|alto|agotado]
    ?modo=kardex   [&variante=&tipo=&usuario=&seccion=&desde=&hasta=]
    ?modo=secciones | ?modo=proveedores
POST (solo admin y sysadmin), JSON {"accion": ...}:
    crear | llegada | salida | ajuste | proveedor
El stock solo cambia mediante funciones SQL (inv_mover): el kardex siempre queda registrado.
"""
import json
import math
import os
import re
import sys
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

MAX_BODY = 64 * 1024
LIMITE_LISTA = 200
LIMITE_KARDEX = 300
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
    if not math.isfinite(f) or f != int(f) or not (minimo <= f <= maximo):
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    return int(f)


def _numero(v, nombre, minimo=0.01, maximo=1_000_000):
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    try:
        f = float(v)
    except ValueError:
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.") from None
    if not math.isfinite(f) or not (minimo <= f <= maximo):
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    return float(Decimal(str(f)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))   # half-up, igual que el cliente


def _texto(v, nombre, maximo, obligatorio=True, minimo=1):
    s = (v or "").strip() if isinstance(v, str) or v is None else None
    if s is None:
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    if not s and not obligatorio:
        return None
    if len(s) < minimo or len(s) > maximo:
        raise c.ErrorPeticion(400, f"{nombre[0].upper() + nombre[1:]}: entre {minimo} y {maximo} caracteres.")
    return s


def _fecha(v, nombre="la fecha"):
    """AAAA-MM-DD real (rechaza 2026-02-30, que pasaba la expresión regular)."""
    if not isinstance(v, str) or not FECHA_RE.match(v):
        raise c.ErrorPeticion(400, f"Fecha inválida en {nombre}.")
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise c.ErrorPeticion(400, f"Fecha inválida en {nombre}.") from None


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
    # activo=true: igual que _buscar; antes se listaban variantes inactivas y luego fallaban al darles entrada
    params = [("select", cols), ("activo", "is.true"), ("order", "nombre.asc"), ("limit", str(LIMITE_LISTA + 1))]
    if qs.get("seccion") and qs["seccion"][0]:
        params.append(("seccion_id", f"eq.{_entero(qs['seccion'][0], 'la sección', 1, 32000)}"))
    alerta = qs.get("alerta", [""])[0]
    if alerta in ("bajo", "alto"):
        params.append(("alerta", f"eq.{alerta}"))
    elif alerta == "agotado":
        params.append(("cantidad", "lte.0"))
    if len(q) >= 2:
        if q.isdigit() and len(q) >= 6:
            params.append(("codigo_barras", f"eq.{q}"))
        else:
            params.append(("or", f"(nombre.ilike.*{q}*,marca.ilike.*{q}*,color.ilike.*{q}*,talla.ilike.*{q}*)"))
    return _leer("inv_catalogo", params)


def _kardex(qs, u):
    params = [("select", "*"), ("order", "creado_en.desc,id.desc"), ("limit", str(LIMITE_KARDEX + 1))]
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
    # Fechas en hora de Venezuela (UTC-4). «hasta» es inclusivo: se usa < día siguiente 00:00
    # (antes era <= 23:59:59 y se perdían los movimientos del último segundo).
    desde = _fecha(g("desde"), "«Desde»") if g("desde") else None
    hasta = _fecha(g("hasta"), "«Hasta»") if g("hasta") else None
    if desde and hasta and desde > hasta:
        raise c.ErrorPeticion(400, "La fecha «Desde» no puede ser posterior a «Hasta».")
    if desde:
        params.append(("creado_en", f"gte.{desde.isoformat()}T00:00:00-04:00"))
    if hasta:
        params.append(("creado_en", f"lt.{(hasta + timedelta(days=1)).isoformat()}T00:00:00-04:00"))
    filas = _leer("inv_kardex", params)
    if not c.es_admin(u):          # los costos solo los ve el administrador
        for f in filas:
            f["costo_unitario"] = None
    return filas


# ── Escrituras (solo admin) ─────────────────────────────────────────────────
def _hay(v):
    return v not in (None, "")


def _variante(v, n):
    """Valida y normaliza una variante. Solo pasan las claves conocidas y con valores ya redondeados
    (antes se validaba pero se enviaba el JSON crudo a la función SQL)."""
    if not isinstance(v, dict):
        raise c.ErrorPeticion(400, f"Variante {n}: datos inválidos.")
    try:
        out = {}
        for clave, nombre, maximo in (("color", "el color", 40), ("talla_presentacion", "la talla o presentación", 40),
                                      ("codigo_barras", "el código de barras", 32)):
            t = _texto(v.get(clave), nombre, maximo, obligatorio=False)
            if t:
                out[clave] = t
        out["precio_detal"] = _numero(v.get("precio_detal"), "el precio detal")
        if _hay(v.get("precio_costo")):
            out["precio_costo"] = _numero(v.get("precio_costo"), "el precio de costo", 0)
        for precio, cant, etq in (("precio_mayor", "cantidad_mayor", "mayor"),
                                  ("precio_gran_mayor", "cantidad_gran_mayor", "gran mayor")):
            if _hay(v.get(precio)) != _hay(v.get(cant)):
                raise c.ErrorPeticion(400, f"el precio {etq} y su cantidad mínima deben indicarse juntos.")
            if _hay(v.get(precio)):
                out[precio] = _numero(v.get(precio), f"el precio {etq}")
                out[cant] = _entero(v.get(cant), f"la cantidad {etq}", 1)
        if "cantidad_mayor" in out and "cantidad_gran_mayor" in out \
                and out["cantidad_gran_mayor"] <= out["cantidad_mayor"]:
            raise c.ErrorPeticion(400, "gran mayor debe empezar en una cantidad superior a la de mayor.")
        for clave, nombre in (("cantidad_inicial", "la cantidad inicial"), ("cantidad_minima", "el mínimo"),
                              ("cantidad_maxima", "el máximo")):
            if _hay(v.get(clave)):
                out[clave] = _entero(v.get(clave), nombre, 0, 1_000_000, False)
        if "cantidad_minima" in out and "cantidad_maxima" in out and out["cantidad_minima"] > out["cantidad_maxima"]:
            raise c.ErrorPeticion(400, "el mínimo no puede ser mayor que el máximo.")
        if v.get("maneja_lotes") is True:
            out["maneja_lotes"] = True
        lote = _texto(v.get("lote"), "el lote", 40, obligatorio=False)
        if lote:
            out["lote"] = lote
        if _hay(v.get("vencimiento")):
            out["vencimiento"] = _fecha(v.get("vencimiento"), "el vencimiento").isoformat()
        imgs = v.get("imagenes")
        if imgs is not None:
            if not isinstance(imgs, list) or len(imgs) > 4 or not all(isinstance(x, str) and len(x) <= 500 for x in imgs):
                raise c.ErrorPeticion(400, MENSAJES["maximo_imagenes"])
            out["imagenes"] = imgs
        return out
    except c.ErrorPeticion as e:
        raise c.ErrorPeticion(e.status, f"Variante {n}: {e.mensaje[0].lower() + e.mensaje[1:]}") from None


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
    limpias = [_variante(v, i) for i, v in enumerate(variantes, 1)]
    _rpc("inv_crear_producto", {"p_usuario": u["id"], "p_producto": limpio, "p_variantes": limpias})
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
            "vencimiento": _fecha(ln["vencimiento"], "el vencimiento").isoformat() if _hay(ln.get("vencimiento")) else None,
        })
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
    """Idempotente: si ya existe (sin distinguir mayúsculas) se devuelve en lugar de fallar con un error
    de duplicado que además se traducía como «código de barras repetido»."""
    nombre = _texto(d.get("nombre"), "el nombre", 120)
    for p in _leer("inv_proveedores", [("select", "id,nombre,activo"), ("limit", "1000")]):
        if str(p.get("nombre", "")).strip().lower() == nombre.lower():
            if p.get("activo") is False:
                raise c.ErrorPeticion(409, "Ese proveedor existe pero está desactivado.")
            return "Ese proveedor ya estaba registrado.", {"proveedor_id": p["id"]}
    filas = _leer("inv_proveedores", None, insertar={
        "nombre": nombre,
        "contacto": _texto(d.get("contacto"), "el contacto", 200, obligatorio=False),
    })
    return "Proveedor registrado.", {"proveedor_id": filas[0]["id"] if filas else None}


class handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _ok(self, **extra):
        c.responder(self, 200, {"status": "ok", **extra})

    def _recortado(self, filas, limite):
        """Se pide limite+1 filas: si sobra una, el cliente avisa de que hay más resultados."""
        return self._ok(data=filas[:limite], truncado=len(filas) > limite)

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
                return self._recortado(_lista(qs, u), LIMITE_LISTA)
            if modo == "kardex":
                return self._recortado(_kardex(qs, u), LIMITE_KARDEX)
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
        except Exception as e:  # noqa: BLE001 - nunca dejar escapar un 500 sin JSON
            print(f"[inventario] GET inesperado {type(e).__name__}: {e}", file=sys.stderr)
            c.responder(self, 500, {"status": "error", "message": "Error interno. Inténtalo de nuevo."})

    def do_POST(self):
        try:
            u = _entrada(self, "admin")
            d = c.leer_json(self, MAX_BODY)
            accion, extra = d.get("accion"), {}
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
                msg, extra = _proveedor(d, u)
            else:
                raise c.ErrorPeticion(400, "Acción no válida.")
            self._ok(message=msg, **extra)
        except c.ErrorPeticion as e:
            self._fallo(e)
        except (requests.RequestException, RuntimeError) as e:
            print(f"[inventario] POST {e}", file=sys.stderr)
            c.responder(self, 503, {"status": "error", "message": "Servicio no disponible. Inténtalo de nuevo."})
        except Exception as e:  # noqa: BLE001
            print(f"[inventario] POST inesperado {type(e).__name__}: {e}", file=sys.stderr)
            c.responder(self, 500, {"status": "error", "message": "Error interno. Inténtalo de nuevo."})
