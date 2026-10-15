"""Comisiones de vendedores. Módulo auxiliar (el prefijo «_» evita que Vercel lo cuente como función): lo sirve
/api/administrador, que ya exige admin o sysadmin en TODAS sus peticiones. SQL: sql/comisiones.sql.

  GET  ?modo=com_resumen&mes=AAAA-MM   -> comisión de cada vendedor en el mes
  POST {"accion": "com_config", "vendedor": "Ana" | "*", "porcentaje": 5 | null}
        Fija el porcentaje de un vendedor (o el por defecto con "*"). porcentaje null = quita el propio
        (el vendedor vuelve a usar el por defecto).
  POST {"accion": "com_pagar", "mes": "AAAA-MM", "vendedor": "Ana", "monto_usd": 25.5}
        Registra el pago de una comisión y crea el egreso «Comisiones» correspondiente.

Regla (base de caja: la comisión se gana cuando el dinero entra, así un mes ya pagado no cambia después):
    base = ventas cobradas en el mes (facturas no anuladas y no a crédito, por lo realmente cobrado)
         − reembolsos de devoluciones del mes (de facturas que no son a crédito)
         + abonos de crédito recibidos en el mes (de cuentas no anuladas, a nombre del vendedor de la venta)
    comisión = base × porcentaje del vendedor (o el por defecto).
Las ventas a crédito aún sin cobrar no comisionan; se muestran aparte como «crédito pendiente».
"""
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

VENEZUELA = timezone(timedelta(hours=-4))
CENT = Decimal("0.01")
DEFECTO = "*"
SIN_VENDEDOR = "Sin vendedor"
MES_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
TOPE = 20_000


def _d(v):
    try:
        return Decimal(str(v)) if v is not None and not isinstance(v, bool) else Decimal(0)
    except InvalidOperation:
        return Decimal(0)


def _r2(d):
    return d.quantize(CENT, rounding=ROUND_HALF_UP)


def _f(d):
    return float(_r2(d))


def _get(tabla, params):
    r = c._http.get(f"{c.SUPABASE_URL}/rest/v1/{tabla}", params=params, headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if r.status_code != 200:
        print(f"[comisiones] {tabla} {r.status_code}: {r.text[:300]}", file=sys.stderr)
        raise c.ErrorPeticion(502, "No se pudieron consultar las comisiones. ¿Ejecutaste sql/comisiones.sql en Supabase?")
    return r.json()


def _nombre(v):
    return (v or "").strip() or SIN_VENDEDOR


def _pct(valor, nombre="El porcentaje"):
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        raise c.ErrorPeticion(400, f"{nombre} no es válido.")
    d = _d(valor)
    if not d.is_finite() or not 0 <= d <= 100:
        raise c.ErrorPeticion(400, f"{nombre} debe estar entre 0 y 100.")
    return _r2(d)


def resumen(mes, ini, fin, ventas):
    """Filas por vendedor. `ventas` = facturas del mes ya filtradas (sin anuladas) que entrega administrador._ventas."""
    if not MES_RE.match(mes or ""):
        raise c.ErrorPeticion(400, "Mes inválido.")
    desde, hasta = f"{ini}T00:00:00-04:00", f"{fin}T00:00:00-04:00"

    config = {f["vendedor"]: _d(f["porcentaje"]) for f in _get("comisiones_config", [("select", "vendedor,porcentaje")])}
    defecto = config.get(DEFECTO, Decimal(0))

    acum = {}

    def fila(v):
        return acum.setdefault(_nombre(v), {"ventas": Decimal(0), "devol": Decimal(0), "abonos": Decimal(0),
                                            "credito_pend": Decimal(0)})

    for f in ventas:
        if f.get("metodo_pago") == "CREDITO":
            continue          # el fiado comisiona al cobrarse (abonos); su saldo pendiente se calcula abajo
        fila(f.get("vendedor"))["ventas"] += _d(f.get("total_usd"))

    # Reembolsos de devoluciones hechas en el mes (las de facturas a crédito ya bajaron la deuda, no hubo cobro).
    devs = _get("devoluciones", [("select", "total_reembolso_usd,facturas(vendedor,metodo_pago)"),
                                 ("created_at", f"gte.{desde}"), ("created_at", f"lt.{hasta}"), ("limit", str(TOPE))])
    for x in devs:
        fa = x.get("facturas") or {}
        if fa.get("metodo_pago") != "CREDITO":
            fila(fa.get("vendedor"))["devol"] += _d(x.get("total_reembolso_usd"))

    # Abonos de crédito recibidos en el mes. Si la cuenta se anuló, ese dinero se devolvió: no comisiona.
    abonos = _get("cobros_abonos", [("select", "monto_usd,cuentas_por_cobrar(vendedor,estado)"),
                                    ("creado_en", f"gte.{desde}"), ("creado_en", f"lt.{hasta}"), ("limit", str(TOPE))])
    for x in abonos:
        cta = x.get("cuentas_por_cobrar") or {}
        if cta.get("estado") != "anulada":
            fila(cta.get("vendedor"))["abonos"] += _d(x.get("monto_usd"))

    # Informativo: crédito vendido en el mes que todavía no se cobró.
    pend = _get("cuentas_por_cobrar", [("select", "vendedor,total_usd,abonado_usd"), ("estado", "eq.pendiente"),
                                       ("fecha_venta", f"gte.{ini}"), ("fecha_venta", f"lt.{fin}"), ("limit", str(TOPE))])
    for x in pend:
        fila(x.get("vendedor"))["credito_pend"] += _d(x.get("total_usd")) - _d(x.get("abonado_usd"))

    pagos = {}
    for p in _get("comisiones_pagos", [("select", "vendedor,monto_usd"), ("mes", f"eq.{mes}"), ("limit", str(TOPE))]):
        pagos[p["vendedor"]] = pagos.get(p["vendedor"], Decimal(0)) + _d(p["monto_usd"])
    for v in list(config) + list(pagos):     # vendedores con % o pagos propios aparecen aunque no vendan
        if v != DEFECTO:
            fila(v)

    filas = []
    for v, a in acum.items():
        base = a["ventas"] - a["devol"] + a["abonos"]
        propio = v in config
        pct = config[v] if propio else defecto
        comision = _r2(max(base, Decimal(0)) * pct / 100)
        pagado = _r2(pagos.get(v, Decimal(0)))
        filas.append({
            "vendedor": v, "ventas_usd": _f(a["ventas"]), "devoluciones_usd": _f(a["devol"]), "abonos_usd": _f(a["abonos"]),
            "base_usd": _f(base), "porcentaje": float(pct), "porcentaje_propio": propio, "comision_usd": float(comision),
            "pagado_usd": float(pagado), "pendiente_usd": float(max(comision - pagado, Decimal(0))),
            "credito_pendiente_usd": _f(a["credito_pend"]),
        })
    filas.sort(key=lambda r: (-r["comision_usd"], r["vendedor"]))
    return {"mes": mes, "porcentaje_defecto": float(defecto), "vendedores": filas,
            "totales": {"comision_usd": _f(sum((_d(r["comision_usd"]) for r in filas), Decimal(0))),
                        "pagado_usd": _f(sum((_d(r["pagado_usd"]) for r in filas), Decimal(0))),
                        "pendiente_usd": _f(sum((_d(r["pendiente_usd"]) for r in filas), Decimal(0)))}}


def leer(qs, ini_fin, ventas):
    modo = (qs.get("modo", [""])[0] or "")
    if modo == "com_resumen":
        mes = (qs.get("mes", [""])[0] or "").strip()
        ini, fin = ini_fin(mes)
        return resumen(mes, ini, fin, ventas(ini, fin))
    raise c.ErrorPeticion(400, "Modo no válido.")


def configurar(d, u):
    vendedor = d.get("vendedor")
    if not isinstance(vendedor, str) or not 1 <= len(vendedor.strip()) <= 60:
        raise c.ErrorPeticion(400, "Vendedor inválido.")
    vendedor = vendedor.strip()
    if d.get("porcentaje") is None:
        if vendedor == DEFECTO:
            raise c.ErrorPeticion(400, "El porcentaje por defecto no se puede quitar: ponlo en 0 si no hay comisión.")
        r = c._http.delete(f"{c.SUPABASE_URL}/rest/v1/comisiones_config", params={"vendedor": f"eq.{vendedor}"},
                           headers=c._hdr_servicio({"Prefer": "return=minimal"}), timeout=c.TIMEOUT)
    else:
        r = c._http.post(f"{c.SUPABASE_URL}/rest/v1/comisiones_config", params={"on_conflict": "vendedor"},
                         json={"vendedor": vendedor, "porcentaje": float(_pct(d.get("porcentaje"))),
                               "actualizado_por": u["id"], "actualizado_en": datetime.now(timezone.utc).isoformat()},
                         headers=c._hdr_servicio({"Prefer": "resolution=merge-duplicates,return=minimal"}), timeout=c.TIMEOUT)
    if r.status_code not in (200, 201, 204):
        print(f"[comisiones] config {r.status_code}: {r.text[:300]}", file=sys.stderr)
        raise c.ErrorPeticion(502, "No se pudo guardar el porcentaje.")


def pagar(d, u, ini_fin, ventas):
    mes = str(d.get("mes") or "")
    vendedor = d.get("vendedor")
    if not MES_RE.match(mes):
        raise c.ErrorPeticion(400, "Mes inválido.")
    if not isinstance(vendedor, str) or not 1 <= len(vendedor.strip()) <= 60 or vendedor.strip() == DEFECTO:
        raise c.ErrorPeticion(400, "Vendedor inválido.")
    vendedor = vendedor.strip()
    m = d.get("monto_usd")
    if isinstance(m, bool) or not isinstance(m, (int, float)) or not 0 < m <= 10_000_000:
        raise c.ErrorPeticion(400, "Monto inválido.")
    monto = _r2(_d(m))
    if monto <= 0:
        raise c.ErrorPeticion(400, "Monto inválido.")

    ini, fin = ini_fin(mes)
    fila = next((r for r in resumen(mes, ini, fin, ventas(ini, fin))["vendedores"] if r["vendedor"] == vendedor), None)
    pendiente = _d(fila["pendiente_usd"]) if fila else Decimal(0)
    if monto > pendiente + Decimal("0.005"):
        raise c.ErrorPeticion(409, f"El monto supera la comisión pendiente de {vendedor} (${float(pendiente):.2f}).")

    # Camino normal: función SQL atómica (sql/comisiones_pago_atomico.sql) → bloquea, revalida y crea egreso + pago juntos.
    comision = _d(fila["comision_usd"]) if fila else Decimal(0)
    rpc = c._http.post(f"{c.SUPABASE_URL}/rest/v1/rpc/registrar_pago_comision",
                       json={"p_mes": mes, "p_vendedor": vendedor, "p_monto": float(monto),
                             "p_comision": float(comision), "p_usuario": u["id"]},
                       headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if rpc.status_code in (200, 204):
        return
    if rpc.status_code == 404 or "PGRST202" in rpc.text:
        # La función aún no existe (SQL sin ejecutar): se usa el camino anterior, que NO es atómico.
        print("[comisiones] ⚠ falta sql/comisiones_pago_atomico.sql: pago sin bloqueo transaccional", file=sys.stderr)
    else:
        exceso = re.search(r"comision_excede:([\d.]+)", rpc.text)
        if exceso:
            raise c.ErrorPeticion(409, f"El monto supera la comisión pendiente de {vendedor} (${float(exceso.group(1)):.2f}).")
        print(f"[comisiones] rpc pago {rpc.status_code}: {rpc.text[:300]}", file=sys.stderr)
        raise c.ErrorPeticion(502, "No se pudo registrar el pago de la comisión. Inténtalo de nuevo.")

    hoy = datetime.now(VENEZUELA).date().isoformat()
    r = c._http.post(f"{c.SUPABASE_URL}/rest/v1/egresos",
                     json={"fecha": hoy, "categoria": "Comisiones", "monto_usd": float(monto), "creado_por": u["id"],
                           "descripcion": f"Comisión {vendedor} · {mes}", "proveedor": vendedor},
                     headers=c._hdr_servicio({"Prefer": "return=representation"}), timeout=c.TIMEOUT)
    if r.status_code not in (200, 201):
        print(f"[comisiones] egreso {r.status_code}: {r.text[:300]}", file=sys.stderr)
        raise c.ErrorPeticion(502, "No se pudo registrar el egreso del pago.")
    try:
        egreso_id = r.json()[0]["id"]
    except (ValueError, KeyError, IndexError, TypeError):
        egreso_id = None
    p = c._http.post(f"{c.SUPABASE_URL}/rest/v1/comisiones_pagos",
                     json={"mes": mes, "vendedor": vendedor, "monto_usd": float(monto), "egreso_id": egreso_id,
                           "creado_por": u["id"]},
                     headers=c._hdr_servicio({"Prefer": "return=minimal"}), timeout=c.TIMEOUT)
    if p.status_code not in (200, 201, 204):
        print(f"[comisiones] pago {p.status_code}: {p.text[:300]}", file=sys.stderr)
        if egreso_id is not None:   # no dejar un egreso sin su pago: se deshace y se pide reintentar
            try:
                c._http.delete(f"{c.SUPABASE_URL}/rest/v1/egresos", params={"id": f"eq.{egreso_id}"},
                               headers=c._hdr_servicio({"Prefer": "return=minimal"}), timeout=c.TIMEOUT)
            except Exception as e:  # noqa: BLE001
                print(f"[comisiones] no se pudo deshacer el egreso {egreso_id}: {e!r}", file=sys.stderr)
        raise c.ErrorPeticion(502, "No se pudo registrar el pago de la comisión. Inténtalo de nuevo.")
