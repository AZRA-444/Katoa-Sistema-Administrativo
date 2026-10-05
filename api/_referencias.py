"""Datos de referencia que el SERVIDOR consulta por su cuenta, para no fiarse de lo que envía el navegador.

  · catalogo(ids)      → precios de lista del inventario (inv_catalogo) de las variantes activas.
  · precio_de_lista()  → mismas reglas de escala (detal / mayor / gran mayor) que js/facturacion.js.
  · tasa_bcv()         → tasa de referencia (la misma fuente que usa el navegador: open.er-api.com).
  · tasa_usdt()        → dólar paralelo (la misma fuente que /api/tasa-usdt).

El prefijo "_" hace que Vercel NO lo exponga como endpoint.

Variables de entorno opcionales (Vercel):
  TASA_TOLERANCIA_PCT     Desvío máximo (%) permitido entre la tasa enviada y la de referencia. Def.: 10.
                          Con 0 se desactiva la comprobación (p. ej. si la fuente no refleja tu tasa oficial).
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
from decimal import Decimal, InvalidOperation

import requests

import _comun as c

URL_TASA_BCV = "https://open.er-api.com/v6/latest/USD"
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


def _extraer_bcv(d):
    return _tasa_valida((d.get("rates") or {}).get("VES")) if isinstance(d, dict) else None


def _extraer_usdt(d):
    return _tasa_valida(d.get("promedio") or d.get("venta")) if isinstance(d, dict) else None


def _consultar(clave, url, extraer):
    """Valor de referencia con caché. None si no se pudo obtener ni hay un valor reciente guardado."""
    ahora = time.monotonic()
    previo = _cache.get(clave)
    if previo and ahora - previo[0] < TTL_FRESCO:
        return previo[1]
    valor = None
    try:
        # requests.get directo: no se envían las cabeceras de Supabase a un tercero.
        r = requests.get(url, timeout=TIMEOUT_REF, headers={"Accept": "application/json"})
        if r.status_code == 200:
            valor = extraer(r.json())
    except (requests.RequestException, ValueError) as e:
        print(f"[referencias] {clave} no disponible: {e!r}", file=sys.stderr)
    if valor is not None:
        _cache[clave] = (ahora, valor)
        return valor
    if previo and ahora - previo[0] < TTL_OBSOLETO:
        return previo[1]
    return None


def tasa_bcv():
    return _consultar("bcv", URL_TASA_BCV, _extraer_bcv)


def tasa_usdt():
    return _consultar("usdt", URL_TASA_USDT, _extraer_usdt)
