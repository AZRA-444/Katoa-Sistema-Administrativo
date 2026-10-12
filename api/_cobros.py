"""Cobros: cuentas por cobrar de las ventas a crédito (fiado). Módulo auxiliar: el prefijo «_» evita que Vercel lo
cuente como función (el plan Hobby permite 12 y ya están ocupadas). Lo sirve /api/historial, que ya exige sesión,
origen válido y rol en cada petición:

  GET  ?modo=cobros_lista [&estado=pendientes|vencidas|pagadas|todas] [&q=texto]   (encargado+)
        -> cuentas (por defecto, las pendientes; las que vencen primero arriba) + resumen para las tarjetas
  GET  ?modo=cobros_cuenta&id=N                                                      (encargado+)
        -> una cuenta con todos sus abonos
  GET  ?modo=cobros_sin_cuenta                                                       (encargado+)
        -> facturas a crédito que quedaron SIN su deuda registrada (la venta se guardó pero falló el registro de
           la deuda y nadie reintentó); se regularizan con la acción cobro_regularizar
  POST {"accion": "cobro_abonar", "cuenta_id": 1, "monto_usd": 25.5, "metodo": "PM", "banco": "...",
        "referencia": "...", "observaciones": "...", "tasa_cambio": 480.12, "token": "..."}      (encargado+)
        Registra un cobro (parcial o total) en una transacción (SQL: registrar_abono). El monto va en dólares de
        lista, igual que la deuda; si se cobró en bolívares se guarda también el monto en Bs con la tasa usada.
        `token` evita registrar dos veces el mismo envío (doble clic, respuesta perdida).
  POST {"accion": "cobro_regularizar", "id_factura": "FAC-...", "plazo_dias": 30}                  (admin+)
        Crea la deuda de una factura a crédito que quedó sin registrar. El plazo cuenta desde la fecha de la venta.

SQL: sql/cobros.sql. Reglas del crédito (plazo máximo, quién puede vender a crédito): api/_creditos.py.
"""
import os
import re
import sys
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402
import _creditos as cred  # noqa: E402
import _referencias as ref  # noqa: E402

LIMITE = 500                 # filas de la lista
LIMITE_RESUMEN = 5000        # cuentas pendientes que entran en las tarjetas del resumen
CENT = Decimal("0.01")
POR_VENCER_DIAS = 3          # «vence pronto» = faltan 0 a 3 días

ID_RE = re.compile(r"^[A-Za-z0-9\-]{1,64}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9\-]{8,64}$")
REFERENCIA_RE = re.compile(r"^\d{4,12}$")
REFERENCIA_DIGITAL_RE = re.compile(r"^[A-Z0-9]{4,30}$")

METODOS_ABONO = {"PM", "PVD", "PVC", "ED", "ZELLE", "BINANCE", "EBS", "OTROS"}
METODOS_USD = {"ED", "ZELLE", "BINANCE"}   # el resto se cobra en bolívares (OTROS trae su moneda)

COLS = ("id,id_factura,cedula,nombre_cliente,telefono,vendedor,total_usd,abonado_usd,plazo_dias,"
        "fecha_venta,fecha_vence,estado,creada_en,pagada_en")
COLS_ABONO = "id,monto_usd,metodo,moneda,monto_moneda,tasa_cambio,banco,referencia,observaciones,usuario_nombre,creado_en"

MENSAJES = {
    "cuenta_no_encontrada": (404, "La cuenta no existe."),
    "cuenta_anulada": (409, "Esta cuenta está anulada: ya no se puede cobrar."),
    "cuenta_pagada": (409, "Esta cuenta ya está pagada por completo."),
}


# ── Utilidades ──────────────────────────────────────────────────────────────
def _get(ruta, params, contar=False):
    r = c._http.get(f"{c.SUPABASE_URL}/rest/v1/{ruta}", params=params, headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if r.status_code != 200:
        print(f"[cobros] {ruta} {r.status_code}: {r.text[:400]}", file=sys.stderr)
        raise c.ErrorPeticion(502, "No se pudieron cargar los cobros. Inténtalo de nuevo.")
    return r.json()


def _d(v):
    try:
        return Decimal(str(v)) if v is not None and not isinstance(v, bool) else Decimal(0)
    except InvalidOperation:
        return Decimal(0)


def _r2(d):
    return d.quantize(CENT, rounding=ROUND_HALF_UP)


def _f(d):
    return float(_r2(d))


def _texto(valor, nombre, maximo, obligatorio=True):
    if valor is None:
        valor = ""
    if not isinstance(valor, str):
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    valor = valor.strip()
    if obligatorio and not valor:
        raise c.ErrorPeticion(400, f"Falta {nombre}.")
    if len(valor) > maximo:
        raise c.ErrorPeticion(400, f"{nombre[0].upper() + nombre[1:]} es demasiado largo.")
    if any(ch < " " and ch not in "\n\t" for ch in valor):
        raise c.ErrorPeticion(400, f"Caracteres no permitidos en {nombre}.")
    return valor


def _positivo(valor, nombre, maximo):
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    try:
        d = Decimal(str(valor))
    except InvalidOperation:
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.") from None
    if not d.is_finite() or d <= 0 or d > maximo:
        raise c.ErrorPeticion(400, f"Valor fuera de rango en {nombre}.")
    return d


def _texto_libre(v, maximo=60):
    return re.sub(r"[^\w\s.\-]", "", v or "")[:maximo].strip()


def _fecha(iso):
    try:
        return date.fromisoformat(str(iso)[:10])
    except ValueError:
        return None


# ── Lectura ─────────────────────────────────────────────────────────────────
def _decorar(f, hoy):
    """Agrega lo que se calcula (no se guarda): saldo, días que faltan y si está vencida."""
    total, abonado = _d(f.get("total_usd")), _d(f.get("abonado_usd"))
    f["total_usd"], f["abonado_usd"] = _f(total), _f(abonado)
    f["saldo_usd"] = _f(total - abonado)
    pendiente = f.get("estado") == "pendiente"
    vence = _fecha(f.get("fecha_vence"))
    dias = (vence - hoy).days if (pendiente and vence) else None
    f["dias_restantes"] = dias                      # negativo = días de atraso
    f["vencida"] = bool(pendiente and dias is not None and dias < 0)
    f["por_vencer"] = bool(pendiente and dias is not None and 0 <= dias <= POR_VENCER_DIAS)
    return f


def _resumen(hoy):
    filas = _get("cuentas_por_cobrar", [("select", "total_usd,abonado_usd,fecha_vence"), ("estado", "eq.pendiente"),
                                         ("limit", str(LIMITE_RESUMEN + 1))])
    truncado = len(filas) > LIMITE_RESUMEN
    por_cobrar = vencido = Decimal(0)
    vencidas = por_vencer = 0
    for f in filas[:LIMITE_RESUMEN]:
        saldo = _d(f.get("total_usd")) - _d(f.get("abonado_usd"))
        por_cobrar += saldo
        vence = _fecha(f.get("fecha_vence"))
        if vence and vence < hoy:
            vencido += saldo
            vencidas += 1
        elif vence and (vence - hoy).days <= POR_VENCER_DIAS:
            por_vencer += 1
    inicio = f"{hoy.isoformat()}T00:00:00-04:00"
    fin = f"{(hoy + timedelta(days=1)).isoformat()}T00:00:00-04:00"
    abonos = _get("cobros_abonos", [("select", "monto_usd"), ("creado_en", f"gte.{inicio}"), ("creado_en", f"lt.{fin}"),
                                     ("limit", "5000")])
    return {
        "pendientes": min(len(filas), LIMITE_RESUMEN), "por_cobrar_usd": _f(por_cobrar),
        "vencidas": vencidas, "vencido_usd": _f(vencido), "por_vencer": por_vencer,
        "cobrado_hoy_usd": _f(sum((_d(a.get("monto_usd")) for a in abonos), Decimal(0))),
        "truncado": truncado,
    }


def lista(qs):
    hoy = cred.hoy()
    estado = (qs.get("estado", ["pendientes"])[0] or "pendientes")
    if estado not in ("pendientes", "vencidas", "pagadas", "todas"):
        raise c.ErrorPeticion(400, "Estado no válido.")
    params = [("select", COLS), ("limit", str(LIMITE + 1))]
    if estado in ("pendientes", "vencidas"):
        params += [("estado", "eq.pendiente"), ("order", "fecha_vence.asc,id.asc")]
        if estado == "vencidas":
            params.append(("fecha_vence", f"lt.{hoy.isoformat()}"))
    elif estado == "pagadas":
        params += [("estado", "eq.pagada"), ("order", "pagada_en.desc,id.desc")]
    else:
        params += [("estado", "neq.anulada"), ("order", "creada_en.desc,id.desc")]
    q = _texto_libre((qs.get("q", [""])[0] or ""))
    if len(q) >= 2:
        params.append(("or", f"(nombre_cliente.ilike.*{q}*,cedula.ilike.*{q}*,id_factura.ilike.*{q}*,telefono.ilike.*{q}*)"))
    filas = _get("cuentas_por_cobrar", params)
    truncado = len(filas) > LIMITE
    return {"data": [_decorar(f, hoy) for f in filas[:LIMITE]], "truncado": truncado, "limite": LIMITE,
            "resumen": _resumen(hoy), "hoy": hoy.isoformat()}


def cuenta(id_cuenta):
    try:
        n = int(id_cuenta)
    except (TypeError, ValueError):
        raise c.ErrorPeticion(400, "Id de cuenta inválido.") from None
    if not 0 < n <= 9_223_372_036_854_775_807:
        raise c.ErrorPeticion(400, "Id de cuenta inválido.")
    filas = _get("cuentas_por_cobrar", [("select", COLS), ("id", f"eq.{n}"), ("limit", "1")])
    if not filas:
        raise c.ErrorPeticion(404, "La cuenta no existe.")
    abonos = _get("cobros_abonos", [("select", COLS_ABONO), ("cuenta_id", f"eq.{n}"), ("order", "creado_en.asc,id.asc")])
    return {"data": _decorar(filas[0], cred.hoy()), "abonos": abonos}


def sin_cuenta():
    """Facturas a crédito vigentes que no tienen fila en cuentas_por_cobrar."""
    facturas = _get("facturas", [("select", "id_factura,nombre,apellido,cedula,subtotal_usd,created_at"),
                                 ("metodo_pago", "eq.CREDITO"), ("estado", "neq.anulada"),
                                 ("order", "created_at.desc"), ("limit", "1000")])
    if not facturas:
        return {"data": []}
    registradas = {f["id_factura"] for f in _get("cuentas_por_cobrar", [("select", "id_factura"), ("order", "id.desc"),
                                                                         ("limit", "5000")])}
    huerfanas = [{"id_factura": f["id_factura"], "cliente": " ".join(x for x in (f.get("nombre"), f.get("apellido")) if x),
                  "cedula": f.get("cedula"), "total_usd": _f(_d(f.get("subtotal_usd"))), "creada": f.get("created_at")}
                 for f in facturas if f["id_factura"] not in registradas]
    return {"data": huerfanas}


# ── Escritura ───────────────────────────────────────────────────────────────
def _verificar_tasa(tasa):
    """Mismo criterio que enviar-factura: la tasa que escribe el cajero no puede alejarse de la de referencia."""
    tol = ref.tolerancia_pct()
    if tol <= 0:
        return
    r = ref.tasa_bcv()
    if r is None:
        print("[cobros] sin tasa de referencia BCV: se acepta la enviada", file=sys.stderr)
    elif abs(tasa - r) * 100 / r > tol:
        raise c.ErrorPeticion(400, f"La tasa de cambio ({tasa:.2f}) se aleja demasiado de la tasa de referencia "
                                   f"({r:.2f}). Actualízala e inténtalo de nuevo.")


def abonar(d, u):
    cuenta_id = d.get("cuenta_id")
    if isinstance(cuenta_id, bool) or not isinstance(cuenta_id, int) or cuenta_id <= 0:
        raise c.ErrorPeticion(400, "Cuenta inválida.")
    monto = _r2(_positivo(d.get("monto_usd"), "el monto", Decimal(10) ** 9))
    if monto <= 0:
        raise c.ErrorPeticion(400, "El monto debe ser mayor que cero.")
    metodo = _texto(d.get("metodo"), "el método de pago", 10)
    if metodo not in METODOS_ABONO:
        raise c.ErrorPeticion(400, "Método de pago inválido.")

    moneda = d.get("moneda") if metodo == "OTROS" else ("USD" if metodo in METODOS_USD else "BS")
    if moneda not in ("USD", "BS"):
        raise c.ErrorPeticion(400, "Indica la moneda del pago.")
    observaciones = _texto(d.get("observaciones"), "las observaciones", 500, obligatorio=False)
    banco = referencia = "N/A"
    if metodo == "PM":
        banco = _texto(d.get("banco"), "el banco", 40)
        referencia = _texto(d.get("referencia"), "la referencia", 12)
        if not REFERENCIA_RE.match(referencia):
            raise c.ErrorPeticion(400, "La referencia debe tener entre 4 y 12 dígitos.")
    elif metodo in ("ZELLE", "BINANCE"):
        referencia = _texto(d.get("referencia"), "la referencia", 30).upper()
        if not REFERENCIA_DIGITAL_RE.match(referencia):
            raise c.ErrorPeticion(400, "La referencia debe tener entre 4 y 30 letras o números.")
    elif metodo == "OTROS" and not observaciones:
        raise c.ErrorPeticion(400, "Describe el método de pago en las observaciones.")

    tasa = None
    if moneda == "BS":
        tasa = _positivo(d.get("tasa_cambio"), "la tasa de cambio", Decimal(1_000_000))
        _verificar_tasa(tasa)
        monto_moneda = _r2(monto * tasa)
    else:
        monto_moneda = monto   # en dólares el abono entra a precio de lista (sin descuento por pago en divisas)

    token = d.get("token")
    if token is not None and (not isinstance(token, str) or not TOKEN_RE.match(token)):
        raise c.ErrorPeticion(400, "Solicitud inválida. Recarga la página e inténtalo de nuevo.")

    r = c._http.post(
        f"{c.SUPABASE_URL}/rest/v1/rpc/registrar_abono",
        json={"p_cuenta": cuenta_id, "p_monto": float(monto), "p_metodo": metodo, "p_moneda": moneda,
              "p_monto_moneda": float(monto_moneda), "p_tasa": float(tasa) if tasa is not None else None,
              "p_banco": banco, "p_referencia": referencia, "p_observaciones": observaciones or None,
              "p_usuario": u["id"], "p_usuario_nombre": u.get("nombre"), "p_token": token},
        headers=c._hdr_servicio(), timeout=c.TIMEOUT * 2)
    if r.status_code == 200:
        try:
            res = r.json()
        except ValueError:
            res = {}
        return res if isinstance(res, dict) else {}
    print(f"[cobros] abonar {cuenta_id} {r.status_code}: {r.text[:400]}", file=sys.stderr)
    exceso = re.search(r"monto_excede_saldo:([0-9.]+)", r.text)
    if exceso:
        raise c.ErrorPeticion(409, f"El monto supera el saldo pendiente (${float(exceso.group(1)):.2f}). "
                                   "Recarga la página: otra persona pudo haber cobrado.")
    for clave, (status, msg) in MENSAJES.items():
        if clave in r.text:
            raise c.ErrorPeticion(status, msg)
    raise c.ErrorPeticion(502, "No se pudo registrar el cobro. Inténtalo de nuevo.")


def regularizar(d):
    id_factura = str(d.get("id_factura") or "")
    if not ID_RE.match(id_factura):
        raise c.ErrorPeticion(400, "Id de factura inválido.")
    plazo = cred.validar_plazo(d.get("plazo_dias"))
    filas = _get("facturas", [("select", "id_factura,nombre,apellido,cedula,telefono,vendedor,subtotal_usd,metodo_pago,estado,created_at"),
                              ("id_factura", f"eq.{id_factura}"), ("limit", "1")])
    if not filas:
        raise c.ErrorPeticion(404, "La factura no existe.")
    f = filas[0]
    if f.get("metodo_pago") != cred.METODO:
        raise c.ErrorPeticion(409, "Esta factura no es a crédito.")
    if f.get("estado") == "anulada":
        raise c.ErrorPeticion(409, "Esta factura está anulada.")
    # created_at viene en UTC: la fecha de la venta es la de Venezuela.
    try:
        venta = datetime.fromisoformat(str(f["created_at"]).replace("Z", "+00:00")).astimezone(cred.VENEZUELA).date()
    except (ValueError, TypeError, KeyError):
        venta = _fecha(f.get("created_at")) or cred.hoy()
    cred.crear_cuenta({
        "id_factura": id_factura, "cedula": f["cedula"],
        "nombre_cliente": " ".join(x for x in (f.get("nombre"), f.get("apellido")) if x),
        "telefono": f.get("telefono"), "vendedor": f.get("vendedor"),
        "total_usd": _f(_d(f.get("subtotal_usd"))), "plazo_dias": plazo,
        "fecha_venta": venta.isoformat(), "fecha_vence": (venta + timedelta(days=plazo)).isoformat(),
    })


def exigir_nivel(u, minimo):
    if c.NIVELES.get(u["rol"], 0) < c.NIVELES[minimo]:
        raise c.ErrorPeticion(403, "No tienes permiso para esta acción.")


def post(d, u):
    """Ejecuta una acción POST de cobros (cobro_abonar | cobro_regularizar). Devuelve el JSON de respuesta."""
    accion = d.get("accion")
    if accion == "cobro_abonar":
        exigir_nivel(u, "encargado")
        res = abonar(d, u)
        saldo = float(res.get("saldo_usd") or 0)
        if res.get("duplicado"):
            msg = "Este cobro ya estaba registrado."
        elif res.get("estado") == "pagada":
            msg = "Cobro registrado. La cuenta quedó pagada por completo."
        else:
            msg = f"Cobro registrado. Saldo pendiente: ${saldo:.2f}."
        return {"status": "ok", "message": msg, "estado": res.get("estado"), "saldo_usd": saldo,
                "duplicado": bool(res.get("duplicado"))}
    if accion == "cobro_regularizar":
        if not c.es_admin(u):
            raise c.ErrorPeticion(403, "Solo un administrador puede regularizar una factura a crédito.")
        regularizar(d)
        return {"status": "ok", "message": "Deuda registrada en Cobros."}
    raise c.ErrorPeticion(400, "Acción no válida.")
