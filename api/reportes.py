"""/api/reportes  (solo lectura)

GET ?tipo=...  (encargado, admin, sysadmin). Los costos del inventario solo los ve el administrador.
    cierre          [desde, hasta, vendedor]          cierre de caja: por método de pago, vendedor, conciliación,
                                                      ventas a crédito y abonos cobrados en el período
    facturas        [desde, hasta, q, vendedor, metodo]   listado para reimprimir (máx. 100)
    detalle         id=FAC-...                         una factura con sus productos y pagos
    ventas          [desde, hasta, vendedor]          ventas por día, hora y vendedor
    productos       [desde, hasta, orden=cantidad|monto]  productos más vendidos
    clientes        [desde, hasta]                     mejores clientes
    finanzas        [desde, hasta, agrupar=dia|semana|mes]  ingresos por período y método + comparación
    inventario      [seccion]                          existencias valoradas, reposición y sobrestock
    movimientos     [desde, hasta, seccion]            entradas y salidas del kardex por tipo
    sin_movimiento  [dias=7..365, seccion]             productos con stock y sin ventas en los últimos días
    lista_precios   [seccion]                          lista de precios para el cliente: detal, mayor y gran mayor con su
                                                       cantidad mínima. NUNCA trae costos (ni para el administrador)
    vendedores                                         nombres para el filtro

Fechas AAAA-MM-DD en hora de Venezuela (UTC-4); «hasta» es inclusivo. Sin fechas: el día de hoy.
Los totales de dinero nunca son parciales: si el rango trae demasiados registros se pide acotarlo.
Las facturas ANULADAS no se cuentan en ningún reporte (cierre, ventas, productos, clientes, finanzas, listado).
«Ventas» = total_usd (lo cobrado, ya con el descuento por pago en divisas), igual que el panel Administrador:
la definición vive en api/_ventas.py. El único reporte a precio de lista es «productos» y así se rotula.
Las DEVOLUCIONES se restan por la fecha en que se registraron: cierre, ventas, clientes y finanzas traen lo devuelto y la venta
neta. Productos NO las descuenta (muestra lo vendido a precio de lista).
"""
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402
import _ventas as ventas_def  # noqa: E402

VE = timezone(timedelta(hours=-4))          # Venezuela no cambia de hora en el año
PAGINA = 1000
MAX_FACTURAS = 20_000
MAX_FILAS = 60_000                          # detalles, kardex y catálogo
MAX_DIAS = 366
LIMITE_FACTURAS = 100
TOP = 100
FECHA_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ID_RE = re.compile(r"^[A-Za-z0-9\-]{1,64}$")

ETIQUETAS = {
    "ED": "Efectivo en dólares", "EBS": "Efectivo en bolívares", "PM": "Pago móvil", "TB": "Transferencia bancaria",
    "PVD": "Punto de venta (débito)", "PVC": "Punto de venta (crédito)", "ZELLE": "Zelle",
    "BINANCE": "Binance (USDT)", "OTROS": "Otros", "MIXTO": "Pago combinado", "CREDITO": "Crédito (fiado)",
}
ORDEN_METODOS = list(ETIQUETAS)
METODOS_USD = {"ED", "ZELLE", "BINANCE"}    # se cobran en dólares; el resto en bolívares (OTROS trae su moneda)
CON_REFERENCIA = {"PM", "TB", "ZELLE", "BINANCE"}  # se concilian contra el banco / la billetera
ENTRADAS = {"REGISTRO", "LLEGADA", "AJUSTE_ENTRADA", "DEVOLUCION_CLIENTE"}
TIPOS_KARDEX = ENTRADAS | {"SALIDA_VENTA", "SALIDA_OTRO", "AJUSTE_SALIDA", "DEVOLUCION_PROVEEDOR"}

COLS_FACTURA = ("id_factura,vendedor,subtotal_usd,total_usd,total_bs,metodo_pago,referencia,banco,"
                "created_at,pagos_combinados,tasa_cambio")
COLS_CLIENTE = COLS_FACTURA + ",nombre,apellido,cedula,telefono"
COLS_LISTADO = ("id_factura,nombre,apellido,cedula,telefono,vendedor,subtotal_usd,total_usd,total_bs,"
                "metodo_pago,created_at")


# ── Números y fechas ────────────────────────────────────────────────────────
# La definición de «venta» vive en api/_ventas.py y es la misma del panel Administrador y las comisiones.
_venta = ventas_def.venta_usd
_d = ventas_def.dec


def _f(x):
    return float(_d(x).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _pct(parte, total):
    return _f(parte * 100 / total) if total else 0.0


def hoy():
    return datetime.now(VE).date()


def hora_ve(iso):
    """ISO de Supabase (microsegundos de longitud variable) -> datetime en hora de Venezuela."""
    s = str(iso).replace("Z", "+00:00")
    s = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], s)
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).astimezone(VE)


def _fecha(v, nombre):
    if not isinstance(v, str) or not FECHA_RE.match(v):
        raise c.ErrorPeticion(400, f"Fecha inválida en {nombre}.")
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise c.ErrorPeticion(400, f"Fecha inválida en {nombre}.") from None


def _g(qs, clave):
    return (qs.get(clave, [""])[0] or "").strip()


def rango(qs, max_dias=MAX_DIAS):
    """(desde, hasta) inclusivos. Falta una -> se completa con la otra o con hoy."""
    d, h = _g(qs, "desde"), _g(qs, "hasta")
    desde = _fecha(d, "«Desde»") if d else None
    hasta = _fecha(h, "«Hasta»") if h else None
    if not desde and not hasta:
        desde = hasta = hoy()
    elif not hasta:
        hasta = hoy()
    elif not desde:
        desde = hasta
    if desde > hasta:
        raise c.ErrorPeticion(400, "La fecha «Desde» no puede ser posterior a «Hasta».")
    if (hasta - desde).days + 1 > max_dias:
        raise c.ErrorPeticion(400, f"El rango máximo es de {max_dias} días.")
    return desde, hasta


def filtro_fecha(campo, desde, hasta):
    return [(campo, f"gte.{desde.isoformat()}T00:00:00-04:00"),
            (campo, f"lt.{(hasta + timedelta(days=1)).isoformat()}T00:00:00-04:00")]


def _texto_libre(v, maximo=60):
    return re.sub(r"[^\w\s.\-]", "", v or "")[:maximo].strip()


# ── Supabase ────────────────────────────────────────────────────────────────
def _get(tabla, params, contar=False):
    r = c._http.get(f"{c.SUPABASE_URL}/rest/v1/{tabla}", params=params,
                    headers=c._hdr_servicio({"Prefer": "count=exact"} if contar else None), timeout=c.TIMEOUT)
    if r.status_code not in (200, 206):
        print(f"[reportes] {tabla} {r.status_code}: {r.text[:300]}", file=sys.stderr)
        raise c.ErrorPeticion(502, "No se pudieron consultar los datos. Inténtalo de nuevo.")
    total = None
    cr = r.headers.get("Content-Range", "")
    if "/" in cr and cr.rsplit("/", 1)[1].isdigit():
        total = int(cr.rsplit("/", 1)[1])
    return r.json(), total


def todo(tabla, params, tope, que):
    """Todas las filas (pagina de 1000 en 1000). Si superan `tope` falla: un total parcial engaña."""
    filas, total = [], None
    while True:
        lote, t = _get(tabla, [*params, ("limit", str(PAGINA)), ("offset", str(len(filas)))], contar=total is None)
        if total is None:
            total = t
            if total is not None and total > tope:
                raise c.ErrorPeticion(400, f"Hay demasiados {que} en este rango (más de {tope:,}). Acorta las fechas.".replace(",", "."))
        filas.extend(lote)
        if len(filas) > tope:
            raise c.ErrorPeticion(400, f"Hay demasiados {que} en este rango (más de {tope:,}). Acorta las fechas.".replace(",", "."))
        if not lote or (total is not None and len(filas) >= total) or (total is None and len(lote) < PAGINA):
            return filas


def facturas_rango(desde, hasta, columnas=COLS_FACTURA, vendedor=None, extra=(), solo_anuladas=False):
    """Facturas del rango. Las ANULADAS quedan fuera (no son ventas): ni cierre, ni ventas, ni finanzas las cuentan.
    `solo_anuladas=True` devuelve únicamente esas (se usa para descontar sus renglones en el reporte de productos)."""
    estado = ("estado", f"eq.{ventas_def.ESTADO_ANULADA}") if solo_anuladas else ventas_def.FILTRO_VENTA
    params = [("select", columnas), ("order", "created_at.asc,id_factura.asc"), *filtro_fecha("created_at", desde, hasta), estado, *extra]
    if vendedor:
        params.append(("vendedor", f"eq.{vendedor}"))
    return todo("facturas", params, MAX_FACTURAS, "facturas")


# ── Devoluciones ────────────────────────────────────────────────────────────
COLS_DEVOLUCION = "id,id_factura,total_reembolso_usd,total_reembolso_bs,created_at,facturas(vendedor,cedula,metodo_pago)"


def devoluciones_rango(desde, hasta, vendedor=None):
    """Devoluciones HECHAS en el rango (por la fecha en que se registraron, no la de la venta), como las comisiones.
    Con `vendedor`: solo las de facturas de ese vendedor."""
    filas = todo("devoluciones", [("select", COLS_DEVOLUCION), ("order", "id.asc"), *filtro_fecha("created_at", desde, hasta)],
                 MAX_FILAS, "devoluciones")
    if vendedor:
        filas = [d for d in filas if (_fac_dev(d).get("vendedor") or "").strip() == vendedor]
    return filas


def _devoluciones_o_none(desde, hasta, vendedor=None):
    """None si no se pudieron consultar: el reporte de ventas sigue valiendo y se avisa del faltante."""
    try:
        return devoluciones_rango(desde, hasta, vendedor)
    except c.ErrorPeticion:
        return None


def _fac_dev(d):
    f = d.get("facturas")
    if isinstance(f, list):
        f = f[0] if f else {}
    return f if isinstance(f, dict) else {}


def _dev_usd(d):
    return _d(d.get("total_reembolso_usd"))


def calc_devoluciones(devs):
    """Las de facturas a crédito bajaron la deuda: no sacaron dinero de la caja (`credito_usd`)."""
    return {"cantidad": len(devs), "usd": _f(sum((_dev_usd(d) for d in devs), Decimal(0))),
            "bs": _f(sum((_d(d.get("total_reembolso_bs")) for d in devs), Decimal(0))),
            "credito_usd": _f(sum((_dev_usd(d) for d in devs if _fac_dev(d).get("metodo_pago") == "CREDITO"), Decimal(0)))}


# ── Pagos ───────────────────────────────────────────────────────────────────
def pagos_de(f):
    """Cada factura -> lista de pagos [{metodo, moneda, monto, lista, banco, referencia}].

    monto = lo que realmente entró (en su moneda); lista = su equivalente en dólares a precio de lista.
    Pago combinado: sale de pagos_combinados. Pago único: el total en USD (métodos en dólares, Otros)
    o en Bs (el resto). Crédito (fiado): monto 0 y lista = lo que quedó por cobrar.
    """
    pc = f.get("pagos_combinados")
    if f.get("metodo_pago") == "MIXTO" and isinstance(pc, list) and pc:
        salida = []
        for p in pc:
            if not isinstance(p, dict):
                continue
            metodo = p.get("metodo") if p.get("metodo") in ETIQUETAS else "OTROS"
            moneda = "BS" if p.get("moneda") == "BS" else "USD"
            salida.append({"metodo": metodo, "moneda": moneda, "monto": _d(p.get("monto")), "lista": _d(p.get("abono_usd")),
                           "banco": p.get("banco"), "referencia": p.get("referencia")})
        if salida:
            return salida
    metodo = f.get("metodo_pago") if f.get("metodo_pago") in ETIQUETAS else "OTROS"
    if metodo == "CREDITO":  # fiado: no entró dinero (monto 0); los abonos se cuentan aparte, cuando se cobran
        return [{"metodo": metodo, "moneda": "USD", "monto": Decimal(0),
                 "lista": _d(f.get("subtotal_usd")) or _d(f.get("total_usd")), "banco": None, "referencia": None}]
    if metodo in METODOS_USD or metodo in ("OTROS", "MIXTO"):
        moneda, monto = "USD", _d(f.get("total_usd"))
    else:
        moneda, monto = "BS", _d(f.get("total_bs"))
    return [{"metodo": metodo, "moneda": moneda, "monto": monto, "lista": _d(f.get("subtotal_usd")) or _d(f.get("total_usd")),
             "banco": f.get("banco"), "referencia": f.get("referencia")}]


def _ordenar_metodos(filas):
    return sorted(filas, key=lambda x: (ORDEN_METODOS.index(x["metodo"]) if x["metodo"] in ORDEN_METODOS else 99, x["moneda"]))


def _por_metodo(facturas):
    acum = {}
    for f in facturas:
        for p in pagos_de(f):
            a = acum.setdefault((p["metodo"], p["moneda"]), {"ids": set(), "monto": Decimal(0), "lista": Decimal(0)})
            a["ids"].add(f.get("id_factura"))
            a["monto"] += p["monto"]
            a["lista"] += p["lista"]
    return acum


# ── Cierre de caja ──────────────────────────────────────────────────────────
def calc_cierre(facturas):
    n = len(facturas)
    lista = sum((_d(f.get("subtotal_usd")) for f in facturas), Decimal(0))
    ventas = sum((_venta(f) for f in facturas), Decimal(0))
    metodos = _por_metodo(facturas)
    por_metodo = _ordenar_metodos([
        {"metodo": m, "etiqueta": ETIQUETAS[m], "moneda": mon, "facturas": len(a["ids"]), "monto": _f(a["monto"]), "lista_usd": _f(a["lista"])}
        for (m, mon), a in metodos.items()])
    cobrado = {"USD": Decimal(0), "BS": Decimal(0)}
    for (m, mon), a in metodos.items():
        cobrado[mon] += a["monto"]

    vend = defaultdict(lambda: {"facturas": 0, "lista": Decimal(0), "ventas": Decimal(0), "usd": Decimal(0), "bs": Decimal(0)})
    conciliacion = []
    for f in facturas:
        v = vend[(f.get("vendedor") or "").strip() or "Sin vendedor"]
        v["facturas"] += 1
        v["lista"] += _d(f.get("subtotal_usd"))
        v["ventas"] += _venta(f)
        for p in pagos_de(f):
            v["usd" if p["moneda"] == "USD" else "bs"] += p["monto"]
            if p["metodo"] in CON_REFERENCIA:
                conciliacion.append({"id_factura": f.get("id_factura"), "hora": f.get("created_at"), "metodo": p["metodo"],
                                     "etiqueta": ETIQUETAS[p["metodo"]], "moneda": p["moneda"], "monto": _f(p["monto"]),
                                     "banco": p["banco"] if p["banco"] not in (None, "N/A") else None,
                                     "referencia": p["referencia"] if p["referencia"] not in (None, "N/A") else None})
    por_vendedor = sorted(({"vendedor": k, "facturas": v["facturas"], "ventas_usd": _f(v["ventas"]),
                            "lista_usd": _f(v["lista"]), "cobrado_usd": _f(v["usd"]),
                            "cobrado_bs": _f(v["bs"])} for k, v in vend.items()), key=lambda x: -x["ventas_usd"])
    tasas = [_d(f.get("tasa_cambio")) for f in facturas if _d(f.get("tasa_cambio")) > 0]
    efectivo = lambda m: _f(sum((a["monto"] for (mm, _), a in metodos.items() if mm == m), Decimal(0)))  # noqa: E731
    credito = [f for f in facturas if f.get("metodo_pago") == "CREDITO"]
    return {
        "resumen": {"facturas": n, "ventas_usd": _f(ventas), "lista_usd": _f(lista), "descuento_usd": _f(lista - ventas),
                    "ticket_promedio": _f(ventas / n) if n else 0.0,
                    "cobrado_usd": _f(cobrado["USD"]), "cobrado_bs": _f(cobrado["BS"]),
                    "efectivo_usd": efectivo("ED"), "efectivo_bs": efectivo("EBS"),
                    "credito_facturas": len(credito),
                    "credito_usd": _f(sum((_venta(f) for f in credito), Decimal(0))),
                    "tasa_min": _f(min(tasas)) if tasas else None, "tasa_max": _f(max(tasas)) if tasas else None,
                    "primera": facturas[0].get("created_at") if facturas else None,
                    "ultima": facturas[-1].get("created_at") if facturas else None},
        "por_metodo": por_metodo, "por_vendedor": por_vendedor, "conciliacion": conciliacion[:500],
        "conciliacion_total": len(conciliacion),
    }


# ── Abonos de crédito (módulo Cobros) ───────────────────────────────────────
def abonos_rango(desde, hasta):
    """Abonos de cuentas a crédito cobrados en el rango (por la fecha en que se cobraron, no la de la venta)."""
    params = [("select", "monto_usd,metodo,moneda,monto_moneda,banco,referencia,creado_en,usuario_nombre,"
                         "cuentas_por_cobrar(id_factura,nombre_cliente)"),
              ("order", "creado_en.asc,id.asc"), *filtro_fecha("creado_en", desde, hasta)]
    return todo("cobros_abonos", params, MAX_FILAS, "abonos")


def calc_abonos(abonos):
    acum = {}
    conciliacion = []
    for a in abonos:
        metodo = a.get("metodo") if a.get("metodo") in ETIQUETAS else "OTROS"
        moneda = "BS" if a.get("moneda") == "BS" else "USD"
        k = acum.setdefault((metodo, moneda), {"n": 0, "monto": Decimal(0), "lista": Decimal(0)})
        k["n"] += 1
        k["monto"] += _d(a.get("monto_moneda"))
        k["lista"] += _d(a.get("monto_usd"))
        if metodo in CON_REFERENCIA:
            cta = a.get("cuentas_por_cobrar") or {}
            conciliacion.append({"id_factura": cta.get("id_factura"), "cliente": cta.get("nombre_cliente"),
                                 "hora": a.get("creado_en"), "metodo": metodo, "etiqueta": ETIQUETAS[metodo],
                                 "moneda": moneda, "monto": _f(a.get("monto_moneda")),
                                 "banco": a["banco"] if a.get("banco") not in (None, "N/A") else None,
                                 "referencia": a["referencia"] if a.get("referencia") not in (None, "N/A") else None})
    por_metodo = _ordenar_metodos([
        {"metodo": m, "etiqueta": ETIQUETAS[m], "moneda": mon, "abonos": v["n"], "monto": _f(v["monto"]), "lista_usd": _f(v["lista"])}
        for (m, mon), v in acum.items()])
    return {
        "cantidad": len(abonos),
        "lista_usd": _f(sum((_d(a.get("monto_usd")) for a in abonos), Decimal(0))),
        "cobrado_usd": _f(sum((v["monto"] for (m, mon), v in acum.items() if mon == "USD"), Decimal(0))),
        "cobrado_bs": _f(sum((v["monto"] for (m, mon), v in acum.items() if mon == "BS"), Decimal(0))),
        "por_metodo": por_metodo, "conciliacion": conciliacion[:500], "conciliacion_total": len(conciliacion),
    }


# ── Ventas ──────────────────────────────────────────────────────────────────
DIAS_SEMANA = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]


def calc_ventas(facturas, desde, hasta):
    dias = {}
    d = desde
    while d <= hasta:
        dias[d.isoformat()] = {"dia": d.isoformat(), "facturas": 0, "lista": Decimal(0), "bs": Decimal(0)}
        d += timedelta(days=1)
    horas = {h: {"hora": h, "facturas": 0, "lista": Decimal(0)} for h in range(24)}
    semana = {i: {"dia": DIAS_SEMANA[i], "facturas": 0, "lista": Decimal(0)} for i in range(7)}
    vend = defaultdict(lambda: {"facturas": 0, "lista": Decimal(0)})
    total = Decimal(0)
    for f in facturas:
        t = hora_ve(f.get("created_at"))
        lista = _venta(f)
        total += lista
        if t:
            for dest, clave in ((dias, t.date().isoformat()), (horas, t.hour), (semana, t.weekday())):
                if clave in dest:
                    dest[clave]["facturas"] += 1
                    dest[clave]["lista"] += lista
            if t.date().isoformat() in dias:
                dias[t.date().isoformat()]["bs"] += _d(f.get("total_bs"))
        v = vend[(f.get("vendedor") or "").strip() or "Sin vendedor"]
        v["facturas"] += 1
        v["lista"] += lista
    n = len(facturas)
    por_dia = [{"dia": x["dia"], "facturas": x["facturas"], "ventas_usd": _f(x["lista"]), "ventas_bs": _f(x["bs"]),
                "ticket_promedio": _f(x["lista"] / x["facturas"]) if x["facturas"] else 0.0} for x in dias.values()]
    con_ventas = [x for x in por_dia if x["facturas"]]
    return {
        "resumen": {"facturas": n, "ventas_usd": _f(total), "ticket_promedio": _f(total / n) if n else 0.0,
                    "dias_con_ventas": len(con_ventas), "dias": len(por_dia),
                    "promedio_diario": _f(total / len(con_ventas)) if con_ventas else 0.0,
                    "mejor_dia": max(con_ventas, key=lambda x: x["ventas_usd"]) if con_ventas else None},
        "por_dia": por_dia,
        "por_hora": [{"hora": x["hora"], "facturas": x["facturas"], "ventas_usd": _f(x["lista"])} for x in horas.values() if x["facturas"]],
        "por_dia_semana": [{"dia": x["dia"], "facturas": x["facturas"], "ventas_usd": _f(x["lista"])} for x in semana.values()],
        "por_vendedor": sorted(({"vendedor": k, "facturas": v["facturas"], "ventas_usd": _f(v["lista"]),
                                 "ticket_promedio": _f(v["lista"] / v["facturas"]), "participacion": _pct(v["lista"], total)}
                                for k, v in vend.items()), key=lambda x: -x["ventas_usd"]),
    }


# ── Productos ───────────────────────────────────────────────────────────────
def calc_productos(detalles, orden="cantidad"):
    acum = {}
    for x in detalles:
        clave = str(x.get("inventario_id") or x.get("nombre_producto") or "?")
        a = acum.setdefault(clave, {"producto": x.get("nombre_producto") or "Sin nombre", "cantidad": Decimal(0), "monto": Decimal(0), "ids": set()})
        a["cantidad"] += _d(x.get("cantidad"))
        a["monto"] += _d(x.get("precio_total"))
        a["ids"].add(x.get("id_factura"))
    filas = [{"producto": a["producto"], "cantidad": _f(a["cantidad"]), "monto_usd": _f(a["monto"]), "facturas": len(a["ids"]),
              "precio_promedio": _f(a["monto"] / a["cantidad"]) if a["cantidad"] else 0.0} for a in acum.values()]
    filas.sort(key=lambda x: (-x["monto_usd"], -x["cantidad"]) if orden == "monto" else (-x["cantidad"], -x["monto_usd"]))
    total_monto = sum((a["monto"] for a in acum.values()), Decimal(0))
    for x in filas:
        x["participacion"] = _pct(_d(x["monto_usd"]), total_monto)
    return {"resumen": {"productos": len(filas), "unidades": _f(sum((a["cantidad"] for a in acum.values()), Decimal(0))),
                        "monto_usd": _f(total_monto), "mostrados": min(len(filas), TOP)},
            "filas": filas[:TOP]}


# ── Clientes ────────────────────────────────────────────────────────────────
def calc_clientes(facturas, devs=()):
    acum = {}
    for f in facturas:
        clave = (f.get("cedula") or "").strip() or (f.get("telefono") or "").strip() or "—"
        a = acum.setdefault(clave, {"cedula": (f.get("cedula") or "").strip(), "facturas": 0, "lista": Decimal(0), "dev": Decimal(0), "ultima": ""})
        a["facturas"] += 1
        a["lista"] += _venta(f)
        a["nombre"] = " ".join(x for x in (f.get("nombre"), f.get("apellido")) if x).strip() or "Sin nombre"
        a["telefono"] = f.get("telefono")
        a["ultima"] = max(a["ultima"], f.get("created_at") or "")
    for d in devs:   # lo devuelto se descuenta al cliente (se une por cédula; sin cédula no se puede atribuir)
        ced = (_fac_dev(d).get("cedula") or "").strip()
        if ced in acum:
            acum[ced]["dev"] += _dev_usd(d)
    neto = lambda a: a["lista"] - a["dev"]  # noqa: E731
    total = sum((neto(a) for a in acum.values()), Decimal(0))
    filas = sorted(({"cliente": a["nombre"], "cedula": a["cedula"] or None, "telefono": a["telefono"], "facturas": a["facturas"],
                     "compras_usd": _f(a["lista"]), "devoluciones_usd": _f(a["dev"]), "neto_usd": _f(neto(a)),
                     "ticket_promedio": _f(a["lista"] / a["facturas"]), "ultima": a["ultima"],
                     "participacion": _pct(neto(a), total)} for a in acum.values()), key=lambda x: (-x["neto_usd"], -x["facturas"]))
    return {"resumen": {"clientes": len(filas), "facturas": len(facturas), "recurrentes": sum(1 for x in filas if x["facturas"] >= 2),
                        "compras_usd": _f(sum((a["lista"] for a in acum.values()), Decimal(0))),
                        "devoluciones_usd": _f(sum((a["dev"] for a in acum.values()), Decimal(0))), "neto_usd": _f(total),
                        "mostrados": min(len(filas), TOP)},
            "filas": filas[:TOP]}


# ── Finanzas (ingresos) ─────────────────────────────────────────────────────
def _periodo(t, agrupar):
    d = t.date()
    if agrupar == "mes":
        return d.strftime("%Y-%m")
    if agrupar == "semana":
        return (d - timedelta(days=d.weekday())).isoformat()     # lunes de esa semana
    return d.isoformat()


def calc_finanzas(facturas, agrupar, previo, devs=()):
    """previo = (nº de facturas, ventas) del período anterior de igual duración. `devs` = devoluciones del período."""
    buckets = {}
    total, bs_total = Decimal(0), Decimal(0)
    for f in facturas:
        t = hora_ve(f.get("created_at"))
        if not t:
            continue
        b = buckets.setdefault(_periodo(t, agrupar), {"facturas": 0, "lista": Decimal(0), "bs": Decimal(0), "dev": Decimal(0)})
        lista = _venta(f)
        b["facturas"] += 1
        b["lista"] += lista
        b["bs"] += _d(f.get("total_bs"))
        total += lista
        bs_total += _d(f.get("total_bs"))
    dev_total = Decimal(0)
    for d in devs:
        t = hora_ve(d.get("created_at"))
        if not t:
            continue
        b = buckets.setdefault(_periodo(t, agrupar), {"facturas": 0, "lista": Decimal(0), "bs": Decimal(0), "dev": Decimal(0)})
        b["dev"] += _dev_usd(d)
        dev_total += _dev_usd(d)
    metodos = _por_metodo(facturas)
    cobrado = {"USD": Decimal(0), "BS": Decimal(0)}
    for (m, mon), a in metodos.items():
        cobrado[mon] += a["monto"]
    base_metodos = sum((a["lista"] for a in metodos.values()), Decimal(0))   # los métodos se miden a precio de lista
    por_metodo = _ordenar_metodos([
        {"metodo": m, "etiqueta": ETIQUETAS[m], "moneda": mon, "facturas": len(a["ids"]), "monto": _f(a["monto"]),
         "lista_usd": _f(a["lista"]), "participacion": _pct(a["lista"], base_metodos)} for (m, mon), a in metodos.items()])
    n_prev, lista_prev = previo
    variacion = _f((total - lista_prev) * 100 / lista_prev) if lista_prev else None
    return {
        "resumen": {"facturas": len(facturas), "ventas_usd": _f(total), "ventas_bs": _f(bs_total),
                    "ticket_promedio": _f(total / len(facturas)) if facturas else 0.0,
                    "cobrado_usd": _f(cobrado["USD"]), "cobrado_bs": _f(cobrado["BS"]),
                    "devoluciones_usd": _f(dev_total), "devoluciones_cantidad": len(devs), "neto_usd": _f(total - dev_total),
                    "previo_facturas": n_prev, "previo_ventas_usd": _f(lista_prev), "variacion_pct": variacion},
        "por_periodo": [{"periodo": k, "facturas": v["facturas"], "ventas_usd": _f(v["lista"]), "ventas_bs": _f(v["bs"]),
                         "devoluciones_usd": _f(v["dev"]), "neto_usd": _f(v["lista"] - v["dev"])}
                        for k, v in sorted(buckets.items())],
        "por_metodo": por_metodo,
    }


# ── Inventario ──────────────────────────────────────────────────────────────
def _nombre_var(p):
    return " - ".join(x for x in (p.get("nombre"), p.get("color"), p.get("talla")) if x)


def _stock(p):
    return _d(p.get("cantidad"))


def calc_inventario(filas, admin):
    unidades = valor_detal = valor_costo = Decimal(0)
    agotados = bajos = altos = 0
    secciones = defaultdict(lambda: {"variantes": 0, "unidades": Decimal(0), "detal": Decimal(0), "costo": Decimal(0)})
    reposicion, sobrestock, valorados = [], [], []
    for p in filas:
        q = _stock(p)
        positivo = max(q, Decimal(0))
        detal = positivo * _d(p.get("precio_detal"))
        costo = positivo * _d(p.get("precio_costo")) if admin else Decimal(0)
        unidades += positivo
        valor_detal += detal
        valor_costo += costo
        s = secciones[p.get("seccion") or "Sin sección"]
        s["variantes"] += 1
        s["unidades"] += positivo
        s["detal"] += detal
        s["costo"] += costo
        base = {"producto": _nombre_var(p), "codigo": p.get("codigo_barras"), "seccion": p.get("seccion"), "cantidad": int(q) if q == q.to_integral() else _f(q),
                "minimo": p.get("cantidad_minima"), "maximo": p.get("cantidad_maxima")}
        if q <= 0:
            agotados += 1
        elif p.get("alerta") == "bajo":
            bajos += 1
        elif p.get("alerta") == "alto":
            altos += 1
            sobrestock.append({**base, "exceso": int(q - _d(p.get("cantidad_maxima"))) if _d(p.get("cantidad_maxima")) > 0 else None})
        if q <= 0 or p.get("alerta") == "bajo":
            maximo = _d(p.get("cantidad_maxima"))
            sugerido = int(max(maximo - q, Decimal(0))) if maximo > 0 else None
            reposicion.append({**base, "estado": "agotado" if q <= 0 else "bajo", "sugerido": sugerido,
                               "costo_reposicion": _f(sugerido * _d(p.get("precio_costo"))) if admin and sugerido else None})
        if positivo > 0:
            valorados.append({**base, "precio_detal": _f(p.get("precio_detal")), "valor_detal": _f(detal),
                              "valor_costo": _f(costo) if admin else None})
    reposicion.sort(key=lambda x: (x["estado"] != "agotado", x["cantidad"], x["producto"]))
    valorados.sort(key=lambda x: -x["valor_detal"])
    return {
        "resumen": {"variantes": len(filas), "unidades": _f(unidades), "valor_detal": _f(valor_detal),
                    "valor_costo": _f(valor_costo) if admin else None, "agotados": agotados, "bajos": bajos, "altos": altos},
        "por_seccion": sorted(({"seccion": k, "variantes": v["variantes"], "unidades": _f(v["unidades"]), "valor_detal": _f(v["detal"]),
                                "valor_costo": _f(v["costo"]) if admin else None} for k, v in secciones.items()), key=lambda x: -x["valor_detal"]),
        "reposicion": reposicion[:300], "reposicion_total": len(reposicion),
        "sobrestock": sobrestock[:100], "sobrestock_total": len(sobrestock),
        "top_valor": valorados[:20],
    }


def _escala(precio, desde):
    """Una escala de precio solo existe si trae precio Y cantidad «desde» (como en facturación)."""
    p, q = _d(precio), _d(desde)
    if p > 0 and q > 0:
        return {"precio": _f(p), "desde": int(q) if q == q.to_integral() else _f(q)}
    return None


def calc_lista_precios(filas):
    """Lista de precios para mostrar al cliente. Solo precios de venta: no recibe ni devuelve costos."""
    grupos = defaultdict(list)
    for p in filas:
        precio_detal = _d(p.get("precio_detal"))
        if precio_detal <= 0:
            continue
        grupos[p.get("seccion") or "Sin sección"].append({
            "producto": _nombre_var(p), "marca": p.get("marca"),
            "detal": {"precio": _f(precio_detal), "desde": 1},
            "mayor": _escala(p.get("precio_mayor"), p.get("cantidad_mayor")),
            "gran_mayor": _escala(p.get("precio_gran_mayor"), p.get("cantidad_gran_mayor")),
        })
    secciones = []
    for nombre in sorted(grupos, key=lambda x: (x == "Sin sección", x.lower())):
        items = sorted(grupos[nombre], key=lambda x: x["producto"].lower())
        secciones.append({"seccion": nombre, "filas": items})
    return {"resumen": {"productos": sum(len(g["filas"]) for g in secciones), "secciones": len(secciones)},
            "secciones": secciones}


def calc_movimientos(filas, admin):
    acum = defaultdict(lambda: {"movimientos": 0, "unidades": Decimal(0), "costo": Decimal(0)})
    for m in filas:
        a = acum[m.get("tipo")]
        a["movimientos"] += 1
        q = _d(m.get("cantidad"))
        a["unidades"] += q
        if admin and m.get("costo_unitario") is not None:
            a["costo"] += q * _d(m.get("costo_unitario"))
    por_tipo = [{"tipo": k, "signo": 1 if k in ENTRADAS else -1, "movimientos": v["movimientos"], "unidades": _f(v["unidades"]),
                 "costo_total": _f(v["costo"]) if admin else None} for k, v in acum.items()]
    por_tipo.sort(key=lambda x: (-x["signo"], -x["unidades"]))
    entradas = sum((_d(x["unidades"]) for x in por_tipo if x["signo"] > 0), Decimal(0))
    salidas = sum((_d(x["unidades"]) for x in por_tipo if x["signo"] < 0), Decimal(0))
    return {"resumen": {"movimientos": len(filas), "entradas": _f(entradas), "salidas": _f(salidas), "neto": _f(entradas - salidas)},
            "por_tipo": por_tipo}


def calc_sin_movimiento(catalogo, vendidos, admin):
    filas = []
    for p in catalogo:
        q = _stock(p)
        if q <= 0 or p.get("id") in vendidos:
            continue
        detal = q * _d(p.get("precio_detal"))
        costo = q * _d(p.get("precio_costo")) if admin else None
        filas.append({"producto": _nombre_var(p), "codigo": p.get("codigo_barras"), "seccion": p.get("seccion"), "cantidad": int(q) if q == q.to_integral() else _f(q),
                      "valor_detal": _f(detal), "valor_costo": _f(costo) if admin else None})
    filas.sort(key=lambda x: -(x["valor_costo"] if admin else x["valor_detal"]))
    return {"resumen": {"productos": len(filas), "unidades": _f(sum((_d(x["cantidad"]) for x in filas), Decimal(0))),
                        "valor_detal": _f(sum((_d(x["valor_detal"]) for x in filas), Decimal(0))),
                        "valor_costo": _f(sum((_d(x["valor_costo"]) for x in filas), Decimal(0))) if admin else None,
                        "mostrados": min(len(filas), 300)},
            "filas": filas[:300]}


# ── Consultas por tipo ──────────────────────────────────────────────────────
def _seccion(qs):
    s = _g(qs, "seccion")
    if not s:
        return None
    if not s.isdigit() or not 0 < int(s) < 32000:
        raise c.ErrorPeticion(400, "Sección inválida.")
    return s


def _vendedor(qs):
    """Nombre tal como está en facturas.vendedor (puede tener apóstrofes o tildes). Va en un filtro `eq.`,
    que PostgREST toma completo, así que solo se descartan los caracteres de control."""
    return re.sub(r"[\x00-\x1f\x7f]", "", _g(qs, "vendedor"))[:60].strip() or None


def r_cierre(qs, u):
    desde, hasta = rango(qs)
    cierre = calc_cierre(facturas_rango(desde, hasta, vendedor=_vendedor(qs)))
    # Los abonos de crédito se cobran por cobrador, no por vendedor: con filtro de vendedor no aplican.
    if _vendedor(qs):
        cierre["abonos"] = None
    else:
        try:
            cierre["abonos"] = calc_abonos(abonos_rango(desde, hasta))
        except c.ErrorPeticion:
            cierre["abonos"] = {"no_disponible": True}   # el cierre de ventas sigue valiendo; se avisa del faltante
    devs = _devoluciones_o_none(desde, hasta, _vendedor(qs))
    if devs is None:
        cierre["devoluciones"] = {"no_disponible": True}
    else:
        cierre["devoluciones"] = calc_devoluciones(devs)
        cierre["resumen"]["neto_usd"] = _f(_d(cierre["resumen"]["ventas_usd"]) - _d(cierre["devoluciones"]["usd"]))
    return cierre, desde, hasta


def r_facturas(qs, u):
    desde, hasta = rango(qs)
    params = [("select", COLS_LISTADO), ("order", "created_at.desc,id_factura.desc"), ("limit", str(LIMITE_FACTURAS + 1)),
              *filtro_fecha("created_at", desde, hasta), ("estado", "neq.anulada")]
    if _vendedor(qs):
        params.append(("vendedor", f"eq.{_vendedor(qs)}"))
    metodo = _g(qs, "metodo")
    if metodo:
        if metodo not in ETIQUETAS:
            raise c.ErrorPeticion(400, "Método de pago inválido.")
        params.append(("metodo_pago", f"eq.{metodo}"))
    q = _texto_libre(_g(qs, "q"))
    if len(q) >= 2:
        params.append(("or", f"(id_factura.ilike.*{q}*,nombre.ilike.*{q}*,apellido.ilike.*{q}*,cedula.ilike.*{q}*,telefono.ilike.*{q}*)"))
    filas, _ = _get("facturas", params)
    salida = [{"id_factura": f["id_factura"], "cliente": " ".join(x for x in (f.get("nombre"), f.get("apellido")) if x) or "—",
               "cedula": f.get("cedula"), "telefono": f.get("telefono"), "vendedor": f.get("vendedor"),
               "metodo": f.get("metodo_pago"), "etiqueta": ETIQUETAS.get(f.get("metodo_pago"), f.get("metodo_pago")),
               "total_usd": _f(f.get("total_usd")), "total_bs": _f(f.get("total_bs")), "creado": f.get("created_at")}
              for f in filas[:LIMITE_FACTURAS]]
    return {"filas": salida, "truncado": len(filas) > LIMITE_FACTURAS, "limite": LIMITE_FACTURAS}, desde, hasta


def r_detalle(qs, u):
    id_factura = _g(qs, "id")
    if not ID_RE.match(id_factura):
        raise c.ErrorPeticion(400, "Id de factura inválido.")
    filas, _ = _get("facturas", [("id_factura", f"eq.{id_factura}"), ("select", "*"), ("limit", "1")])
    if not filas:
        raise c.ErrorPeticion(404, "No se encontró la factura.")
    f = filas[0]
    items, _ = _get("factura_detalles", [("id_factura", f"eq.{id_factura}"), ("select", "nombre_producto,cantidad,precio_unitario,precio_total"),
                                         ("order", "id.asc")])
    return {
        "factura": {"id_factura": f["id_factura"], "cliente": " ".join(x for x in (f.get("nombre"), f.get("apellido")) if x) or "—",
                    "cedula": f.get("cedula"), "telefono": f.get("telefono"), "vendedor": f.get("vendedor"), "creado": f.get("created_at"),
                    "metodo": f.get("metodo_pago"), "etiqueta": ETIQUETAS.get(f.get("metodo_pago"), f.get("metodo_pago")),
                    "subtotal_usd": _f(f.get("subtotal_usd")), "total_usd": _f(f.get("total_usd")), "total_bs": _f(f.get("total_bs")),
                    "tasa_cambio": _f(f.get("tasa_cambio")) if f.get("tasa_cambio") is not None else None,
                    "observaciones": f.get("observaciones"), "tiene_comprobante": bool(f.get("comprobante_path")),
                    "estado": f.get("estado"), "anulada": f.get("estado") == "anulada"},
        "items": [{"producto": x.get("nombre_producto"), "cantidad": _f(x.get("cantidad")), "precio_unitario": _f(x.get("precio_unitario")),
                   "precio_total": _f(x.get("precio_total"))} for x in items],
        "pagos": [{"metodo": p["metodo"], "etiqueta": ETIQUETAS[p["metodo"]], "moneda": p["moneda"], "monto": _f(p["monto"]),
                   "banco": p["banco"] if p["banco"] not in (None, "N/A") else None,
                   "referencia": p["referencia"] if p["referencia"] not in (None, "N/A") else None} for p in pagos_de(f)],
    }, None, None


def aplicar_devoluciones_ventas(datos, devs):
    """Agrega al reporte de ventas lo devuelto en el período y la venta neta (resumen y por vendedor)."""
    dv = calc_devoluciones(devs)
    r = datos["resumen"]
    r.update({"devoluciones_usd": dv["usd"], "devoluciones_cantidad": dv["cantidad"], "devoluciones_credito_usd": dv["credito_usd"],
              "neto_usd": _f(_d(r["ventas_usd"]) - _d(dv["usd"]))})
    por_vend = defaultdict(lambda: Decimal(0))
    for d in devs:
        por_vend[(_fac_dev(d).get("vendedor") or "").strip() or "Sin vendedor"] += _dev_usd(d)
    filas = {x["vendedor"]: x for x in datos["por_vendedor"]}
    for nombre in por_vend:   # un vendedor puede tener devoluciones sin ventas en el rango
        filas.setdefault(nombre, {"vendedor": nombre, "facturas": 0, "ventas_usd": 0.0, "ticket_promedio": 0.0, "participacion": 0.0})
    for nombre, x in filas.items():
        x["devoluciones_usd"] = _f(por_vend.get(nombre, Decimal(0)))
        x["neto_usd"] = _f(_d(x["ventas_usd"]) - por_vend.get(nombre, Decimal(0)))
    datos["por_vendedor"] = sorted(filas.values(), key=lambda x: (-x["ventas_usd"], -x["devoluciones_usd"]))


def r_ventas(qs, u):
    desde, hasta = rango(qs)
    datos = calc_ventas(facturas_rango(desde, hasta, vendedor=_vendedor(qs)), desde, hasta)
    devs = _devoluciones_o_none(desde, hasta, _vendedor(qs))
    if devs is None:
        datos["resumen"]["devoluciones_no_disponible"] = True
    else:
        aplicar_devoluciones_ventas(datos, devs)
    return datos, desde, hasta


def r_productos(qs, u):
    desde, hasta = rango(qs)
    orden = "monto" if _g(qs, "orden") == "monto" else "cantidad"
    detalles = todo("factura_detalles", [("select", "id_factura,inventario_id,nombre_producto,cantidad,precio_total"), ("order", "id.asc"),
                                         *filtro_fecha("created_at", desde, hasta)], MAX_FILAS, "productos vendidos")
    # factura_detalles no trae el estado: se restan los renglones de las facturas anuladas del mismo rango
    anuladas = {f.get("id_factura") for f in facturas_rango(desde, hasta, "id_factura", solo_anuladas=True)}
    if anuladas:
        detalles = [d for d in detalles if d.get("id_factura") not in anuladas]
    return calc_productos(detalles, orden), desde, hasta


def r_clientes(qs, u):
    desde, hasta = rango(qs)
    return calc_clientes(facturas_rango(desde, hasta, COLS_CLIENTE), _devoluciones_o_none(desde, hasta) or ()), desde, hasta


def r_finanzas(qs, u):
    desde, hasta = rango(qs)
    agrupar = _g(qs, "agrupar") if _g(qs, "agrupar") in ("dia", "semana", "mes") else "dia"
    dias = (hasta - desde).days + 1
    p_hasta = desde - timedelta(days=1)
    p_desde = p_hasta - timedelta(days=dias - 1)
    previas = facturas_rango(p_desde, p_hasta, "id_factura,total_usd,subtotal_usd")
    previo = (len(previas), sum((_venta(f) for f in previas), Decimal(0)))
    devs = _devoluciones_o_none(desde, hasta)
    datos = calc_finanzas(facturas_rango(desde, hasta), agrupar, previo, devs or ())
    if devs is None:
        datos["resumen"]["devoluciones_no_disponible"] = True
    datos["agrupar"] = agrupar
    datos["periodo_previo"] = {"desde": p_desde.isoformat(), "hasta": p_hasta.isoformat()}
    return datos, desde, hasta


def _catalogo(qs, u):
    admin = c.es_admin(u)
    cols = "id,nombre,color,talla,cantidad,precio_detal,codigo_barras,seccion,seccion_id,cantidad_minima,cantidad_maxima,alerta" + (",precio_costo" if admin else "")
    params = [("select", cols), ("activo", "is.true"), ("order", "id.asc")]
    if _seccion(qs):
        params.append(("seccion_id", f"eq.{_seccion(qs)}"))
    return todo("inv_catalogo", params, MAX_FILAS, "productos"), admin


def r_inventario(qs, u):
    filas, admin = _catalogo(qs, u)
    return calc_inventario(filas, admin), None, None


def r_movimientos(qs, u):
    desde, hasta = rango(qs)
    params = [("select", "tipo,cantidad,costo_unitario"), ("order", "id.asc"), *filtro_fecha("creado_en", desde, hasta)]
    if _seccion(qs):
        params.append(("seccion_id", f"eq.{_seccion(qs)}"))
    return calc_movimientos(todo("inv_kardex", params, MAX_FILAS, "movimientos"), c.es_admin(u)), desde, hasta


def r_sin_movimiento(qs, u):
    dias = _g(qs, "dias") or "30"
    if not dias.isdigit() or not 7 <= int(dias) <= 365:
        raise c.ErrorPeticion(400, "Los días deben estar entre 7 y 365.")
    hasta = hoy()
    desde = hasta - timedelta(days=int(dias) - 1)
    catalogo, admin = _catalogo(qs, u)
    ventas = todo("inv_kardex", [("select", "variante_id"), ("tipo", "eq.SALIDA_VENTA"), ("order", "id.asc"),
                                 *filtro_fecha("creado_en", desde, hasta)], MAX_FILAS, "movimientos")
    return calc_sin_movimiento(catalogo, {m.get("variante_id") for m in ventas}, admin), desde, hasta


def r_lista_precios(qs, u):
    """Catálogo activo SOLO con columnas de precio de venta: precio_costo no se pide nunca, ni siquiera al administrador,
    porque esta lista se le enseña al cliente."""
    cols = ("id,nombre,marca,color,talla,seccion,seccion_id,precio_detal,precio_mayor,cantidad_mayor,"
            "precio_gran_mayor,cantidad_gran_mayor")
    params = [("select", cols), ("activo", "is.true"), ("order", "id.asc")]
    if _seccion(qs):
        params.append(("seccion_id", f"eq.{_seccion(qs)}"))
    return calc_lista_precios(todo("inv_catalogo", params, MAX_FILAS, "productos")), None, None


def r_vendedores(qs, u):
    filas, _ = _get("perfiles", [("select", "nombre"), ("activo", "is.true"), ("order", "nombre.asc"), ("limit", "500")])
    return sorted({(p.get("nombre") or "").strip() for p in filas if (p.get("nombre") or "").strip()}), None, None


REPORTES = {
    "cierre": r_cierre, "facturas": r_facturas, "detalle": r_detalle, "ventas": r_ventas, "productos": r_productos,
    "clientes": r_clientes, "finanzas": r_finanzas, "inventario": r_inventario, "movimientos": r_movimientos,
    "sin_movimiento": r_sin_movimiento, "lista_precios": r_lista_precios, "vendedores": r_vendedores,
}


def _entrada(h):
    if not c.config_completa():
        raise c.ErrorPeticion(500, "Configuración del servidor incompleta.")
    if not c.origen_valido(h):
        raise c.ErrorPeticion(403, "Origen no permitido.")
    u = c.usuario_sesion(h)
    if not u:
        raise c.ErrorPeticion(401, "Sesión expirada. Inicia sesión de nuevo.")
    if c.NIVELES.get(u["rol"], 0) < c.NIVELES["encargado"]:
        raise c.ErrorPeticion(403, "No tienes permiso para ver los reportes.")
    return u


class handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        try:
            u = _entrada(self)
            qs = parse_qs(urlparse(self.path).query)
            fn = REPORTES.get(_g(qs, "tipo"))
            if not fn:
                raise c.ErrorPeticion(400, "Reporte no válido.")
            data, desde, hasta = fn(qs, u)
            meta = {"tipo": _g(qs, "tipo"), "desde": desde.isoformat() if desde else None, "hasta": hasta.isoformat() if hasta else None,
                    "generado": datetime.now(VE).isoformat(timespec="seconds"), "usuario": u.get("nombre") or u.get("email"),
                    "admin": c.es_admin(u)}
            c.responder(self, 200, {"status": "ok", "meta": meta, "data": data})
        except c.ErrorPeticion as e:
            c.responder(self, e.status, {"status": "error", "message": e.mensaje})
        except (requests.RequestException, RuntimeError) as e:
            print(f"[reportes] {e}", file=sys.stderr)
            c.responder(self, 503, {"status": "error", "message": "Servicio no disponible. Inténtalo de nuevo."})
        except Exception as e:  # noqa: BLE001 - nunca dejar escapar un 500 sin JSON
            print(f"[reportes] inesperado {type(e).__name__}: {e}", file=sys.stderr)
            c.responder(self, 500, {"status": "error", "message": "Error interno. Inténtalo de nuevo."})

    def do_POST(self):
        c.metodo_no_permitido(self)
