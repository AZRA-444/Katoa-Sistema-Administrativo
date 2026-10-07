"""/api/reportes  (solo lectura)

GET ?tipo=...  (encargado, admin, sysadmin). Los costos del inventario solo los ve el administrador.
    cierre          [desde, hasta, vendedor]          cierre de caja: por método de pago, vendedor y conciliación
    facturas        [desde, hasta, q, vendedor, metodo]   listado para reimprimir (máx. 100)
    detalle         id=FAC-...                         una factura con sus productos y pagos
    ventas          [desde, hasta, vendedor]          ventas por día, hora y vendedor
    productos       [desde, hasta, orden=cantidad|monto]  productos más vendidos
    clientes        [desde, hasta]                     mejores clientes
    finanzas        [desde, hasta, agrupar=dia|semana|mes]  ingresos por período y método + comparación
    inventario      [seccion]                          existencias valoradas, reposición y sobrestock
    movimientos     [desde, hasta, seccion]            entradas y salidas del kardex por tipo
    sin_movimiento  [dias=7..365, seccion]             productos con stock y sin ventas en los últimos días
    vendedores                                         nombres para el filtro

Fechas AAAA-MM-DD en hora de Venezuela (UTC-4); «hasta» es inclusivo. Sin fechas: el día de hoy.
Los totales de dinero nunca son parciales: si el rango trae demasiados registros se pide acotarlo.
"""
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

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
    "ED": "Efectivo en dólares", "EBS": "Efectivo en bolívares", "PM": "Pago móvil",
    "PVD": "Punto de venta (débito)", "PVC": "Punto de venta (crédito)", "ZELLE": "Zelle",
    "BINANCE": "Binance (USDT)", "OTROS": "Otros", "MIXTO": "Pago combinado",
}
ORDEN_METODOS = list(ETIQUETAS)
METODOS_USD = {"ED", "ZELLE", "BINANCE"}    # se cobran en dólares; el resto en bolívares (OTROS trae su moneda)
CON_REFERENCIA = {"PM", "ZELLE", "BINANCE"}  # se concilian contra el banco / la billetera
ENTRADAS = {"REGISTRO", "LLEGADA", "AJUSTE_ENTRADA", "DEVOLUCION_CLIENTE"}
TIPOS_KARDEX = ENTRADAS | {"SALIDA_VENTA", "SALIDA_OTRO", "AJUSTE_SALIDA", "DEVOLUCION_PROVEEDOR"}

COLS_FACTURA = ("id_factura,vendedor,subtotal_usd,total_usd,total_bs,metodo_pago,referencia,banco,"
                "created_at,pagos_combinados,tasa_cambio")
COLS_CLIENTE = COLS_FACTURA + ",nombre,apellido,cedula,telefono"
COLS_LISTADO = ("id_factura,nombre,apellido,cedula,telefono,vendedor,subtotal_usd,total_usd,total_bs,"
                "metodo_pago,created_at")


# ── Números y fechas ────────────────────────────────────────────────────────
def _d(v):
    """Decimal seguro: None, vacío o basura cuentan como 0 (un dato raro no debe tumbar el reporte)."""
    if v is None or isinstance(v, bool):
        return Decimal(0)
    try:
        return Decimal(str(v))
    except InvalidOperation:
        return Decimal(0)


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


def facturas_rango(desde, hasta, columnas=COLS_FACTURA, vendedor=None, extra=()):
    params = [("select", columnas), ("order", "created_at.asc,id_factura.asc"), *filtro_fecha("created_at", desde, hasta), *extra]
    if vendedor:
        params.append(("vendedor", f"eq.{vendedor}"))
    return todo("facturas", params, MAX_FACTURAS, "facturas")


# ── Pagos ───────────────────────────────────────────────────────────────────
def pagos_de(f):
    """Cada factura -> lista de pagos [{metodo, moneda, monto, lista, banco, referencia}].

    monto = lo que realmente entró (en su moneda); lista = su equivalente en dólares a precio de lista.
    Pago combinado: sale de pagos_combinados. Pago único: el total en USD (métodos en dólares, Otros)
    o en Bs (el resto).
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
    metodos = _por_metodo(facturas)
    por_metodo = _ordenar_metodos([
        {"metodo": m, "etiqueta": ETIQUETAS[m], "moneda": mon, "facturas": len(a["ids"]), "monto": _f(a["monto"]), "lista_usd": _f(a["lista"])}
        for (m, mon), a in metodos.items()])
    cobrado = {"USD": Decimal(0), "BS": Decimal(0)}
    for (m, mon), a in metodos.items():
        cobrado[mon] += a["monto"]

    vend = defaultdict(lambda: {"facturas": 0, "lista": Decimal(0), "usd": Decimal(0), "bs": Decimal(0)})
    conciliacion = []
    for f in facturas:
        v = vend[(f.get("vendedor") or "").strip() or "Sin vendedor"]
        v["facturas"] += 1
        v["lista"] += _d(f.get("subtotal_usd"))
        for p in pagos_de(f):
            v["usd" if p["moneda"] == "USD" else "bs"] += p["monto"]
            if p["metodo"] in CON_REFERENCIA:
                conciliacion.append({"id_factura": f.get("id_factura"), "hora": f.get("created_at"), "metodo": p["metodo"],
                                     "etiqueta": ETIQUETAS[p["metodo"]], "moneda": p["moneda"], "monto": _f(p["monto"]),
                                     "banco": p["banco"] if p["banco"] not in (None, "N/A") else None,
                                     "referencia": p["referencia"] if p["referencia"] not in (None, "N/A") else None})
    por_vendedor = sorted(({"vendedor": k, "facturas": v["facturas"], "lista_usd": _f(v["lista"]), "cobrado_usd": _f(v["usd"]),
                            "cobrado_bs": _f(v["bs"])} for k, v in vend.items()), key=lambda x: -x["lista_usd"])
    tasas = [_d(f.get("tasa_cambio")) for f in facturas if _d(f.get("tasa_cambio")) > 0]
    efectivo = lambda m: _f(sum((a["monto"] for (mm, _), a in metodos.items() if mm == m), Decimal(0)))  # noqa: E731
    return {
        "resumen": {"facturas": n, "lista_usd": _f(lista), "ticket_promedio": _f(lista / n) if n else 0.0,
                    "cobrado_usd": _f(cobrado["USD"]), "cobrado_bs": _f(cobrado["BS"]),
                    "efectivo_usd": efectivo("ED"), "efectivo_bs": efectivo("EBS"),
                    "tasa_min": _f(min(tasas)) if tasas else None, "tasa_max": _f(max(tasas)) if tasas else None,
                    "primera": facturas[0].get("created_at") if facturas else None,
                    "ultima": facturas[-1].get("created_at") if facturas else None},
        "por_metodo": por_metodo, "por_vendedor": por_vendedor, "conciliacion": conciliacion[:500],
        "conciliacion_total": len(conciliacion),
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
        lista = _d(f.get("subtotal_usd"))
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
def calc_clientes(facturas):
    acum = {}
    for f in facturas:
        clave = (f.get("cedula") or "").strip() or (f.get("telefono") or "").strip() or "—"
        a = acum.setdefault(clave, {"cedula": (f.get("cedula") or "").strip(), "facturas": 0, "lista": Decimal(0), "ultima": ""})
        a["facturas"] += 1
        a["lista"] += _d(f.get("subtotal_usd"))
        a["nombre"] = " ".join(x for x in (f.get("nombre"), f.get("apellido")) if x).strip() or "Sin nombre"
        a["telefono"] = f.get("telefono")
        a["ultima"] = max(a["ultima"], f.get("created_at") or "")
    total = sum((a["lista"] for a in acum.values()), Decimal(0))
    filas = sorted(({"cliente": a["nombre"], "cedula": a["cedula"] or None, "telefono": a["telefono"], "facturas": a["facturas"],
                     "compras_usd": _f(a["lista"]), "ticket_promedio": _f(a["lista"] / a["facturas"]), "ultima": a["ultima"],
                     "participacion": _pct(a["lista"], total)} for a in acum.values()), key=lambda x: (-x["compras_usd"], -x["facturas"]))
    return {"resumen": {"clientes": len(filas), "facturas": len(facturas), "recurrentes": sum(1 for x in filas if x["facturas"] >= 2),
                        "compras_usd": _f(total), "mostrados": min(len(filas), TOP)},
            "filas": filas[:TOP]}


# ── Finanzas (ingresos) ─────────────────────────────────────────────────────
def _periodo(t, agrupar):
    d = t.date()
    if agrupar == "mes":
        return d.strftime("%Y-%m")
    if agrupar == "semana":
        return (d - timedelta(days=d.weekday())).isoformat()     # lunes de esa semana
    return d.isoformat()


def calc_finanzas(facturas, agrupar, previo):
    """previo = (nº de facturas, ventas a precio de lista) del período anterior de igual duración."""
    buckets = {}
    total, bs_total = Decimal(0), Decimal(0)
    for f in facturas:
        t = hora_ve(f.get("created_at"))
        if not t:
            continue
        b = buckets.setdefault(_periodo(t, agrupar), {"facturas": 0, "lista": Decimal(0), "bs": Decimal(0)})
        lista = _d(f.get("subtotal_usd"))
        b["facturas"] += 1
        b["lista"] += lista
        b["bs"] += _d(f.get("total_bs"))
        total += lista
        bs_total += _d(f.get("total_bs"))
    metodos = _por_metodo(facturas)
    cobrado = {"USD": Decimal(0), "BS": Decimal(0)}
    for (m, mon), a in metodos.items():
        cobrado[mon] += a["monto"]
    por_metodo = _ordenar_metodos([
        {"metodo": m, "etiqueta": ETIQUETAS[m], "moneda": mon, "facturas": len(a["ids"]), "monto": _f(a["monto"]),
         "lista_usd": _f(a["lista"]), "participacion": _pct(a["lista"], total)} for (m, mon), a in metodos.items()])
    n_prev, lista_prev = previo
    variacion = _f((total - lista_prev) * 100 / lista_prev) if lista_prev else None
    return {
        "resumen": {"facturas": len(facturas), "ventas_usd": _f(total), "ventas_bs": _f(bs_total),
                    "ticket_promedio": _f(total / len(facturas)) if facturas else 0.0,
                    "cobrado_usd": _f(cobrado["USD"]), "cobrado_bs": _f(cobrado["BS"]),
                    "previo_facturas": n_prev, "previo_ventas_usd": _f(lista_prev), "variacion_pct": variacion},
        "por_periodo": [{"periodo": k, "facturas": v["facturas"], "ventas_usd": _f(v["lista"]), "ventas_bs": _f(v["bs"])}
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
    return calc_cierre(facturas_rango(desde, hasta, vendedor=_vendedor(qs))), desde, hasta


def r_facturas(qs, u):
    desde, hasta = rango(qs)
    params = [("select", COLS_LISTADO), ("order", "created_at.desc,id_factura.desc"), ("limit", str(LIMITE_FACTURAS + 1)),
              *filtro_fecha("created_at", desde, hasta)]
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
                    "observaciones": f.get("observaciones"), "tiene_comprobante": bool(f.get("comprobante_path"))},
        "items": [{"producto": x.get("nombre_producto"), "cantidad": _f(x.get("cantidad")), "precio_unitario": _f(x.get("precio_unitario")),
                   "precio_total": _f(x.get("precio_total"))} for x in items],
        "pagos": [{"metodo": p["metodo"], "etiqueta": ETIQUETAS[p["metodo"]], "moneda": p["moneda"], "monto": _f(p["monto"]),
                   "banco": p["banco"] if p["banco"] not in (None, "N/A") else None,
                   "referencia": p["referencia"] if p["referencia"] not in (None, "N/A") else None} for p in pagos_de(f)],
    }, None, None


def r_ventas(qs, u):
    desde, hasta = rango(qs)
    return calc_ventas(facturas_rango(desde, hasta, vendedor=_vendedor(qs)), desde, hasta), desde, hasta


def r_productos(qs, u):
    desde, hasta = rango(qs)
    orden = "monto" if _g(qs, "orden") == "monto" else "cantidad"
    detalles = todo("factura_detalles", [("select", "id_factura,inventario_id,nombre_producto,cantidad,precio_total"), ("order", "id.asc"),
                                         *filtro_fecha("created_at", desde, hasta)], MAX_FILAS, "productos vendidos")
    return calc_productos(detalles, orden), desde, hasta


def r_clientes(qs, u):
    desde, hasta = rango(qs)
    return calc_clientes(facturas_rango(desde, hasta, COLS_CLIENTE)), desde, hasta


def r_finanzas(qs, u):
    desde, hasta = rango(qs)
    agrupar = _g(qs, "agrupar") if _g(qs, "agrupar") in ("dia", "semana", "mes") else "dia"
    dias = (hasta - desde).days + 1
    p_hasta = desde - timedelta(days=1)
    p_desde = p_hasta - timedelta(days=dias - 1)
    previas = facturas_rango(p_desde, p_hasta, "id_factura,subtotal_usd")
    previo = (len(previas), sum((_d(f.get("subtotal_usd")) for f in previas), Decimal(0)))
    datos = calc_finanzas(facturas_rango(desde, hasta), agrupar, previo)
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


def r_vendedores(qs, u):
    filas, _ = _get("perfiles", [("select", "nombre"), ("activo", "is.true"), ("order", "nombre.asc"), ("limit", "500")])
    return sorted({(p.get("nombre") or "").strip() for p in filas if (p.get("nombre") or "").strip()}), None, None


REPORTES = {
    "cierre": r_cierre, "facturas": r_facturas, "detalle": r_detalle, "ventas": r_ventas, "productos": r_productos,
    "clientes": r_clientes, "finanzas": r_finanzas, "inventario": r_inventario, "movimientos": r_movimientos,
    "sin_movimiento": r_sin_movimiento, "vendedores": r_vendedores,
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
