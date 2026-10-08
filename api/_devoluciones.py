"""Lógica de DEVOLUCIONES de productos (módulo auxiliar: el prefijo «_» evita que Vercel lo cuente como función).

La expone /api/administrador (que ya exige admin o sysadmin en TODAS sus peticiones):
  GET  ?modo=dev_lista   [&desde=AAAA-MM-DD&hasta=AAAA-MM-DD&q=texto]  -> devoluciones (por defecto, últimos 30 días)
  GET  ?modo=dev_buscar  &q=texto                                      -> facturas NO anuladas donde buscar qué devolver
  GET  ?modo=dev_factura &id=FAC-...                                   -> factura con sus productos y lo ya devuelto
  POST {"accion": "devolucion_registrar", "id_factura": "...", "motivo": "...",
        "lineas": [{"detalle_id": 12, "cantidad": 2, "reingresa": true}]}
        Crea la devolución y devuelve el stock por el kardex (SQL: registrar_devolucion), todo en una
        transacción. La factura NO cambia de estado (las anulaciones siguen su propia lógica).
"""
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

MAX_LINEAS = 150
LIMITE = 300
DIAS_POR_DEFECTO = 30
MAX_DIAS = 366
VENEZUELA = timezone(timedelta(hours=-4))  # sin horario de verano
ID_RE = re.compile(r"^[A-Za-z0-9\-]{1,64}$")
UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
FECHA_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

COLS_DEV = ("id,id_factura,usuario_id,motivo,total_lista_usd,total_reembolso_usd,total_reembolso_bs,created_at,"
            "facturas(nombre,apellido,cedula,vendedor),"
            "devolucion_detalles(id,nombre_producto,cantidad,precio_unitario,precio_total,reingresa_stock)")
COLS_FACTURA = ("id_factura,nombre,apellido,cedula,telefono,vendedor,subtotal_usd,total_usd,total_bs,tasa_cambio,"
                "metodo_pago,created_at,estado,"
                "factura_detalles(id,nombre_producto,cantidad,precio_unitario,precio_total,inventario_id)")

MENSAJES = {
    "factura_no_encontrada": (404, "La factura no existe."),
    "factura_anulada": (409, "Esta factura está anulada: no admite devoluciones."),
    "motivo_requerido": (400, "Escribe el motivo de la devolución (entre 3 y 300 caracteres)."),
    "lineas_requeridas": (400, "Elige al menos un producto a devolver."),
    "detalle_no_encontrado": (400, "Un producto no pertenece a esta factura. Recarga e inténtalo de nuevo."),
    "linea_duplicada": (400, "Un producto está repetido en la devolución."),
    "cantidad_invalida": (400, "Cantidad inválida. Los productos del inventario se devuelven en unidades enteras."),
    "variante_no_encontrada": (409, "Un producto de esta factura está inactivo: actívalo en Inventario y vuelve a intentarlo."),
    "lote_requerido": (409, "No se pudo reingresar un producto que maneja lotes. Revisa el inventario."),
}


def _get(ruta, params):
    r = c._http.get(f"{c.SUPABASE_URL}/rest/v1/{ruta}", params=params, headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if r.status_code != 200:
        print(f"[devoluciones] {ruta} {r.status_code}: {r.text[:400]}", file=sys.stderr)
        raise c.ErrorPeticion(502, "No se pudieron cargar los datos. Inténtalo de nuevo.")
    return r.json()


# ── Validación ──────────────────────────────────────────────────────────────
def _fecha(v, nombre):
    if not FECHA_RE.match(v or ""):
        raise c.ErrorPeticion(400, f"Fecha inválida en {nombre}.")
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise c.ErrorPeticion(400, f"Fecha inválida en {nombre}.") from None


def _texto_libre(v, maximo=60):
    return re.sub(r"[^\w\s.\-]", "", v or "")[:maximo].strip()


def _id_factura(v):
    v = str(v or "")
    if not ID_RE.match(v):
        raise c.ErrorPeticion(400, "Id de factura inválido.")
    return v


# ── Lecturas ────────────────────────────────────────────────────────────────
def _nombres(uids):
    ids = sorted({x for x in uids if x and UUID_RE.match(x)})
    if not ids:
        return {}
    return {p["id"]: p.get("nombre") for p in _get("perfiles", [("select", "id,nombre"), ("id", f"in.({','.join(ids)})")])}


def lista(qs):
    g = lambda k: (qs.get(k, [""])[0] or "").strip()  # noqa: E731
    hoy = datetime.now(VENEZUELA).date()
    hasta = _fecha(g("hasta"), "«Hasta»") if g("hasta") else hoy
    desde = _fecha(g("desde"), "«Desde»") if g("desde") else hasta - timedelta(days=DIAS_POR_DEFECTO - 1)
    if desde > hasta:
        raise c.ErrorPeticion(400, "La fecha «Desde» no puede ser posterior a «Hasta».")
    if (hasta - desde).days > MAX_DIAS:
        raise c.ErrorPeticion(400, "El rango no puede superar un año.")
    params = [("select", COLS_DEV), ("order", "created_at.desc,id.desc"), ("limit", str(LIMITE + 1)),
              ("created_at", f"gte.{desde.isoformat()}T00:00:00-04:00"),
              ("created_at", f"lt.{(hasta + timedelta(days=1)).isoformat()}T00:00:00-04:00")]
    q = _texto_libre(g("q"))
    if q:
        params.append(("id_factura", f"ilike.*{q}*"))
    filas = _get("devoluciones", params)
    truncado = len(filas) > LIMITE
    filas = filas[:LIMITE]
    nombres = _nombres(f.get("usuario_id") for f in filas)
    for f in filas:
        f["registrada_por"] = nombres.get(f.pop("usuario_id", None))
        f["factura"] = f.pop("facturas", None) or {}
        f["detalles"] = sorted(f.pop("devolucion_detalles", None) or [], key=lambda d: d["id"])
    return {"data": filas, "truncado": truncado, "limite": LIMITE, "desde": desde.isoformat(), "hasta": hasta.isoformat()}


def buscar(qs):
    q = _texto_libre((qs.get("q", [""])[0] or ""))
    if len(q) < 2:
        return []
    cols = "id_factura,nombre,apellido,cedula,vendedor,total_usd,created_at,estado"
    filtro = f"(id_factura.ilike.*{q}*,nombre.ilike.*{q}*,apellido.ilike.*{q}*,cedula.ilike.*{q}*,telefono.ilike.*{q}*)"
    filas = _get("facturas", [("select", cols), ("or", filtro), ("order", "created_at.desc"), ("limit", "30")])
    return [f for f in filas if f.get("estado") != "anulada"][:20]


def factura(id_factura):
    filas = _get("facturas", [("select", COLS_FACTURA), ("id_factura", f"eq.{_id_factura(id_factura)}"), ("limit", "1")])
    if not filas:
        raise c.ErrorPeticion(404, "La factura no existe.")
    f = filas[0]
    detalles = sorted(f.pop("factura_detalles", None) or [], key=lambda d: d["id"])
    devuelto = {}
    if detalles:
        ids = ",".join(str(d["id"]) for d in detalles)
        for x in _get("devolucion_detalles", [("select", "detalle_id,cantidad"), ("detalle_id", f"in.({ids})")]):
            devuelto[x["detalle_id"]] = devuelto.get(x["detalle_id"], Decimal(0)) + Decimal(str(x["cantidad"]))
    for d in detalles:
        ya = devuelto.get(d["id"], Decimal(0))
        disponible = max(Decimal(str(d["cantidad"])) - ya, Decimal(0))
        d["devuelto"] = float(ya)
        d["disponible"] = float(disponible)
        d["en_inventario"] = d.pop("inventario_id", None) is not None   # el id interno no sale al navegador
    f["detalles"] = detalles
    return f


# ── Escritura ───────────────────────────────────────────────────────────────
def registrar(d, u):
    id_factura = _id_factura(d.get("id_factura"))
    motivo = re.sub(r"\s+", " ", str(d.get("motivo") or "")).strip()
    if not 3 <= len(motivo) <= 300:
        raise c.ErrorPeticion(400, "Escribe el motivo de la devolución (entre 3 y 300 caracteres).")
    crudas = d.get("lineas")
    if not isinstance(crudas, list) or not 1 <= len(crudas) <= MAX_LINEAS:
        raise c.ErrorPeticion(400, "Elige al menos un producto a devolver.")
    lineas, vistos = [], set()
    for i, ln in enumerate(crudas, 1):
        if not isinstance(ln, dict):
            raise c.ErrorPeticion(400, f"Línea {i} inválida.")
        det, cant, reing = ln.get("detalle_id"), ln.get("cantidad"), ln.get("reingresa", True)
        if isinstance(det, bool) or not isinstance(det, int) or det <= 0 or det in vistos:
            raise c.ErrorPeticion(400, f"Línea {i}: producto inválido o repetido.")
        if isinstance(cant, bool) or not isinstance(cant, (int, float)):
            raise c.ErrorPeticion(400, f"Línea {i}: cantidad inválida.")
        try:
            cd = Decimal(str(cant))
        except InvalidOperation:
            raise c.ErrorPeticion(400, f"Línea {i}: cantidad inválida.") from None
        if not cd.is_finite() or cd <= 0 or cd > 100_000:
            raise c.ErrorPeticion(400, f"Línea {i}: cantidad fuera de rango.")
        if not isinstance(reing, bool):
            raise c.ErrorPeticion(400, f"Línea {i}: indica si el producto vuelve al inventario.")
        vistos.add(det)
        lineas.append({"detalle_id": det, "cantidad": int(cd) if cd == cd.to_integral_value() else float(cd), "reingresa": reing})

    r = c._http.post(f"{c.SUPABASE_URL}/rest/v1/rpc/registrar_devolucion",
                     json={"p_id_factura": id_factura, "p_motivo": motivo, "p_usuario": u["id"], "p_lineas": lineas},
                     headers=c._hdr_servicio(), timeout=c.TIMEOUT * 2)
    if r.status_code == 200:
        try:
            return r.json()
        except ValueError:
            return None
    print(f"[devoluciones] registrar {id_factura} {r.status_code}: {r.text[:400]}", file=sys.stderr)
    exceso = re.search(r"cantidad_excede:([^\"\\]+)", r.text)
    if exceso:
        raise c.ErrorPeticion(409, f"No puedes devolver más de lo vendido en «{exceso.group(1).strip()}» "
                                   "(descontando devoluciones anteriores). Recarga e inténtalo de nuevo.")
    for clave, (status, msg) in MENSAJES.items():
        if clave in r.text:
            raise c.ErrorPeticion(status, msg)
    raise c.ErrorPeticion(502, "No se pudo registrar la devolución. Inténtalo de nuevo.")


def leer(qs):
    """Despacha los modos GET de devoluciones. Devuelve el dict a mezclar en la respuesta."""
    modo = (qs.get("modo", [""])[0] or "")
    if modo == "dev_lista":
        return lista(qs)
    if modo == "dev_buscar":
        return {"data": buscar(qs)}
    if modo == "dev_factura":
        return {"data": factura((qs.get("id") or [""])[0])}
    raise c.ErrorPeticion(400, "Modo no válido.")
