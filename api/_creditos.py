"""Crédito (fiado): lo que comparten enviar-factura, historial (anular), devoluciones y cobros.

  · preparar()                   valida el plazo y el permiso al VENDER a crédito (antes de guardar la factura).
  · crear_cuenta()               registra la deuda en cuentas_por_cobrar (idempotente: un reintento no duplica).
  · anular_por_factura()         cierra la cuenta cuando se anula la factura.
  · ajustar_por_devolucion()     baja la deuda cuando se devuelven productos de una factura a crédito.

El prefijo "_" hace que Vercel NO lo exponga como endpoint. SQL: sql/cobros.sql.

Variables de entorno opcionales (Vercel):
  CREDITO_PLAZO_MAX_DIAS   Días máximos que se pueden dar para pagar. Def.: 90 (tope duro: 365).
  CREDITO_ROL_MINIMO       Rol mínimo que puede vender a crédito: personal | encargado | admin | sysadmin.
                           Def.: personal (cualquiera que pueda facturar).
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

METODO = "CREDITO"
VENEZUELA = timezone(timedelta(hours=-4))  # sin horario de verano
CENT = Decimal("0.01")
TOPE_PLAZO = 365
MSG_NO_REGISTRADA = ("La factura se guardó, pero no se pudo registrar la deuda en Cobros. "
                     "Pulsa «Finalizar» de nuevo para reintentar.")


def hoy():
    """Fecha de hoy en Venezuela (no la del servidor, que está en UTC)."""
    return datetime.now(VENEZUELA).date()


def _entero_env(nombre, defecto):
    try:
        return int(os.environ.get(nombre, "").strip())
    except ValueError:
        return defecto


def plazo_maximo():
    return min(max(_entero_env("CREDITO_PLAZO_MAX_DIAS", 90), 1), TOPE_PLAZO)


def rol_minimo():
    r = (os.environ.get("CREDITO_ROL_MINIMO") or "personal").strip().lower()
    return r if r in c.NIVELES else "personal"


def validar_plazo(valor):
    """Días para pagar: entero entre 1 y el máximo configurado (rechaza bool, texto y decimales)."""
    if isinstance(valor, bool) or not isinstance(valor, int):
        raise c.ErrorPeticion(400, "Indica los días que tiene el cliente para pagar.")
    maximo = plazo_maximo()
    if not 1 <= valor <= maximo:
        raise c.ErrorPeticion(400, f"El plazo del crédito debe estar entre 1 y {maximo} días.")
    return valor


def _r2(d):
    return d.quantize(CENT, rounding=ROUND_HALF_UP)


def preparar(p, factura, usuario):
    """Si la venta es a crédito: valida plazo y permiso, y anota el plazo en las observaciones de la factura.
    Devuelve los datos de la deuda ({plazo, vence, ...}) o None si la factura no es a crédito.
    Modifica factura['observaciones']. Lanza ErrorPeticion si algo no cuadra."""
    if factura.get("metodo_pago") != METODO:
        return None
    if c.NIVELES.get(usuario.get("rol"), 0) < c.NIVELES[rol_minimo()]:
        raise c.ErrorPeticion(403, "Tu rol no puede vender a crédito. Pídele a un encargado o administrador que lo registre.")
    plazo = validar_plazo(p.get("plazo_dias"))
    venta = hoy()
    vence = venta + timedelta(days=plazo)
    nota = f"Crédito a {plazo} día{'s' if plazo != 1 else ''} · Vence {vence:%d/%m/%Y}"
    obs = factura.get("observaciones") or ""
    factura["observaciones"] = f"{obs} | {nota}" if obs else nota
    return {
        "id_factura": factura["id_factura"],
        "cedula": factura["cedula"],
        "nombre_cliente": f"{factura['nombre']} {factura['apellido']}".strip(),
        "telefono": factura.get("telefono"),
        "vendedor": factura.get("vendedor"),
        "total_usd": float(_r2(Decimal(str(factura["subtotal_usd"])))),  # precio de lista: el crédito no lleva descuento
        "plazo_dias": plazo,
        "fecha_venta": venta.isoformat(),
        "fecha_vence": vence.isoformat(),
    }


def crear_cuenta(cuenta):
    """Inserta la cuenta por cobrar. Si ya existe (reintento de la misma factura) no hace nada.
    Lanza ErrorPeticion(502) si no se pudo registrar: la factura ya está guardada y el reintento es seguro."""
    try:
        r = c._http.post(
            f"{c.SUPABASE_URL}/rest/v1/cuentas_por_cobrar",
            params={"on_conflict": "id_factura"},
            json=cuenta,
            headers=c._hdr_servicio({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
            timeout=c.TIMEOUT,
        )
    except Exception as e:  # noqa: BLE001 - cualquier fallo de red: la factura ya está, se pide reintentar
        print(f"[creditos] crear_cuenta {cuenta.get('id_factura')} red: {e!r}", file=sys.stderr)
        raise c.ErrorPeticion(502, MSG_NO_REGISTRADA) from None
    if r.status_code in (200, 201, 204):
        return
    print(f"[creditos] crear_cuenta {cuenta.get('id_factura')} {r.status_code}: {r.text[:400]}", file=sys.stderr)
    raise c.ErrorPeticion(502, MSG_NO_REGISTRADA)


def _buscar_cuenta(id_factura):
    """(fila, ok): `ok` es False si la consulta falló (no se sabe si la factura tiene cuenta)."""
    try:
        r = c._http.get(
            f"{c.SUPABASE_URL}/rest/v1/cuentas_por_cobrar",
            params={"select": "id,estado,total_usd,abonado_usd", "id_factura": f"eq.{id_factura}", "limit": "1"},
            headers=c._hdr_servicio(), timeout=c.TIMEOUT,
        )
        if r.status_code != 200:
            print(f"[creditos] cuenta_de_factura {r.status_code}: {r.text[:200]}", file=sys.stderr)
            return None, False
        filas = r.json()
        return (filas[0] if filas else None), True
    except Exception as e:  # noqa: BLE001
        print(f"[creditos] cuenta_de_factura {e!r}", file=sys.stderr)
        return None, False


def cuenta_de_factura(id_factura):
    """Fila de cuentas_por_cobrar de una factura, o None. Si la tabla aún no existe (SQL sin ejecutar) o la
    consulta falla, devuelve None: el resto del sistema sigue funcionando para facturas que no son a crédito."""
    return _buscar_cuenta(id_factura)[0]


def ajustar_por_devolucion(id_factura, lineas):
    """Tras registrar una devolución: si la factura es a crédito, baja la deuda por el valor devuelto.
    `lineas` = [{detalle_id, cantidad}, ...] ya validadas. Devuelve:
      · None                       la factura no es a crédito (nada que ajustar);
      · {aplicada, total_usd, saldo_usd, reembolsar_usd}   la deuda se ajustó (resultado de la función SQL);
      · {"fallo": True}            hay que ajustar la deuda y NO se pudo: quien llama debe AVISAR al usuario
                                   (la devolución ya quedó registrada; la deuda se corrige a mano en Cobros)."""
    FALLO = {"fallo": True}
    cuenta, ok = _buscar_cuenta(id_factura)
    if not ok:
        return FALLO
    if not cuenta:
        return None
    try:
        ids = ",".join(str(int(x["detalle_id"])) for x in lineas)
        r = c._http.get(
            f"{c.SUPABASE_URL}/rest/v1/factura_detalles",
            params={"select": "id,precio_unitario", "id_factura": f"eq.{id_factura}", "id": f"in.({ids})"},
            headers=c._hdr_servicio(), timeout=c.TIMEOUT,
        )
        if r.status_code != 200:
            print(f"[creditos] ajustar devolución {id_factura} precios {r.status_code}: {r.text[:300]}", file=sys.stderr)
            return FALLO
        precios = {int(f["id"]): Decimal(str(f["precio_unitario"])) for f in r.json()}
        monto = _r2(sum((precios.get(int(x["detalle_id"]), Decimal(0)) * Decimal(str(x["cantidad"])) for x in lineas),
                        Decimal(0)))
        if not precios:
            return FALLO
        if monto <= 0:   # renglones de precio 0: no hay deuda que bajar
            return None
        r = c._http.post(
            f"{c.SUPABASE_URL}/rest/v1/rpc/ajustar_cuenta_devolucion",
            json={"p_id_factura": id_factura, "p_monto": float(monto)},
            headers=c._hdr_servicio(), timeout=c.TIMEOUT,
        )
        if r.status_code != 200:
            print(f"[creditos] ajustar devolución {id_factura} rpc {r.status_code}: {r.text[:300]}", file=sys.stderr)
            return FALLO
        d = r.json()
        return d if isinstance(d, dict) and d.get("aplicada") else FALLO
    except Exception as e:  # noqa: BLE001
        print(f"[creditos] ajustar devolución {id_factura} {e!r}", file=sys.stderr)
        return FALLO
