"""Datos de referencia que el SERVIDOR consulta por su cuenta, para no fiarse de lo que envía el navegador.

  · catalogo(ids)      → precios de lista del inventario (inv_catalogo) de las variantes activas.
  · precio_de_lista()  → mismas reglas de escala (detal / mayor / gran mayor) que js/facturacion.js.
  · tasa_bcv()         → tasa OFICIAL del BCV (ve.dolarapi.com/v1/dolares/oficial). Antes se usaba open.er-api.com,
                         que es un agregador de mercado y no la tasa oficial.
  · tasa_usdt()        → dólar paralelo (ve.dolarapi.com/v1/dolares/paralelo).
  · tasa_info(tipo)    → {tasa, fuente, actualizado} de cualquiera de las dos (lo sirve /api/tasas al navegador).

El prefijo "_" hace que Vercel NO lo exponga como endpoint.

Variables de entorno opcionales (Vercel):
  TASA_TOLERANCIA_PCT     Desvío máximo (%) permitido entre la tasa enviada y la de referencia. Def.: 10.
                          Con 0 se desactiva la comprobación.
  TASA_REF_MAX_DIAS       Antigüedad máxima (días) de la tasa de referencia para usarla al validar. Def.: 7.
                          Si la fuente lleva más tiempo sin actualizarse no se puede juzgar: se acepta la enviada.
  DESCUENTO_MAX_PCT       Descuento máximo (%) sobre el precio de lista que pueden dar "personal" y
                          "encargado". Def.: 0 (deben respetar la lista; solo admin/sysadmin cambian precios).
  PERMITIR_SIN_INVENTARIO Si es "false", "personal" y "encargado" solo pueden facturar productos del
                          inventario (las líneas escritas a mano se rechazan). Def.: true.
  VENDEDOR_LIBRE          Si es "true", se respeta el vendedor que escribe el navegador. Def.: false
                          (el vendedor es el nombre del usuario autenticado).
"""
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

import requests

import _comun as c

URL_TASA_BCV = "https://ve.dolarapi.com/v1/dolares/oficial"   # tasa oficial del BCV
URL_TASA_USDT = "https://ve.dolarapi.com/v1/dolares/paralelo"
TIMEOUT_REF = 3          # s: corto a propósito; la comprobación de tasas no debe frenar la venta
TTL_FRESCO = 300         # s: una respuesta se reutiliza 5 min en una instancia "caliente"
TTL_OBSOLETO = 3600      # s: si la fuente cae, se usa el último valor conocido hasta 1 h

_cache = {}


# ── Configuración por entorno ───────────────────────────────────────────────
def env_bool(nombre, defecto):
    v = os.environ.get(nombre)
    if v is None or not v.strip():
        return defecto
    return v.strip().lower() in ("1", "true", "yes", "si", "sí")


def env_decimal(nombre, defecto):
    try:
        return Decimal(os.environ.get(nombre, "").strip())
    except InvalidOperation:
        return Decimal(defecto)


def tolerancia_pct():
    """Desvío permitido en las tasas (%). <= 0 desactiva la comprobación."""
    return env_decimal("TASA_TOLERANCIA_PCT", 10)


def descuento_max_pct():
    return min(max(env_decimal("DESCUENTO_MAX_PCT", 0), Decimal(0)), Decimal(100))


# ── Precios del inventario ──────────────────────────────────────────────────
def _dec(v):
    try:
        return Decimal(str(v)) if v is not None else Decimal(0)
    except InvalidOperation:
        return Decimal(0)


def precio_de_lista(fila, cantidad):
    """Gran mayor si alcanza su umbral; si no, mayor si alcanza el suyo; si no, detal.
    Debe coincidir con precioUnitario() en js/facturacion.js y js/pedidos.js."""
    detal = _dec(fila.get("precio_detal"))
    mayor, c_mayor = _dec(fila.get("precio_mayor")), _dec(fila.get("cantidad_mayor"))
    gran, c_gran = _dec(fila.get("precio_gran_mayor")), _dec(fila.get("cantidad_gran_mayor"))
    if gran > 0 and c_gran > 0 and cantidad >= c_gran:
        return gran
    if mayor > 0 and c_mayor > 0 and cantidad >= c_mayor:
        return mayor
    return detal


def catalogo(ids):
    """{id: fila} de las variantes ACTIVAS pedidas. Los ids deben ser enteros (se validan antes)."""
    ids = sorted({int(i) for i in ids})
    if not ids:
        return {}
    r = c._http.get(
        f"{c.SUPABASE_URL}/rest/v1/inv_catalogo",
        params={
            "select": "id,precio_detal,precio_mayor,precio_gran_mayor,cantidad_mayor,cantidad_gran_mayor",
            "activo": "is.true",
            "id": f"in.({','.join(str(i) for i in ids)})",
            "limit": str(len(ids)),
        },
        headers=c._hdr_servicio(),
        timeout=c.TIMEOUT,
    )
    if r.status_code != 200:
        print(f"[referencias] inv_catalogo {r.status_code}: {r.text[:300]}", file=sys.stderr)
        raise c.ErrorPeticion(502, "No se pudieron verificar los precios. Inténtalo de nuevo.")
    return {int(f["id"]): f for f in r.json()}


# ── Tasas de referencia ─────────────────────────────────────────────────────
def _tasa_valida(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 < v < 1_000_000:
        return None
    return Decimal(str(v))


def _extraer(d):
    """{tasa, fuente, actualizado} de una respuesta de dolarapi (mismo formato para oficial y paralelo)."""
    if not isinstance(d, dict):
        return None
    tasa = _tasa_valida(d.get("promedio") or d.get("venta"))
    if tasa is None:
        return None
    return {"tasa": tasa, "fuente": d.get("fuente"), "actualizado": d.get("fechaActualizacion")}


def _consultar(clave, url):
    """Dato de referencia con caché. None si no se pudo obtener ni hay un valor reciente guardado."""
    ahora = time.monotonic()
    previo = _cache.get(clave)
    if previo and ahora - previo[0] < TTL_FRESCO:
        return previo[1]
    valor = None
    try:
        # requests.get directo: no se envían las cabeceras de Supabase a un tercero.
        r = requests.get(url, timeout=TIMEOUT_REF, headers={"Accept": "application/json"})
        if r.status_code == 200:
            valor = _extraer(r.json())
    except (requests.RequestException, ValueError) as e:
        print(f"[referencias] {clave} no disponible: {e!r}", file=sys.stderr)
    if valor is not None:
        _cache[clave] = (ahora, valor)
        return valor
    if previo and ahora - previo[0] < TTL_OBSOLETO:
        return previo[1]
    return None


URLS = {"bcv": URL_TASA_BCV, "usdt": URL_TASA_USDT}


def tasa_info(tipo):
    """{tasa: Decimal, fuente, actualizado} de 'bcv' o 'usdt'; None si no hay dato."""
    if tipo not in URLS:
        raise ValueError(tipo)
    return _consultar(tipo, URLS[tipo])


def _vigente(info, tipo):
    """La tasa de la referencia solo sirve para juzgar si no está vieja (feriados y fines de semana sí caben)."""
    if info is None:
        return None
    max_dias = int(env_decimal("TASA_REF_MAX_DIAS", 7))
    if max_dias > 0 and info.get("actualizado"):
        try:
            if datetime.now(timezone.utc) - c.parse_iso(info["actualizado"]) > timedelta(days=max_dias):
                print(f"[referencias] la tasa {tipo} de referencia tiene más de {max_dias} días: no se usa para validar",
                      file=sys.stderr)
                return None
        except ValueError:
            pass     # fecha ilegible: se confía en el valor
    return info["tasa"]


def tasa_bcv():
    """Tasa oficial del BCV como Decimal, o None si no hay dato o está vencido."""
    return _vigente(tasa_info("bcv"), "BCV")


def tasa_usdt():
    return _vigente(tasa_info("usdt"), "USDT")
