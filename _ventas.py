"""Definición ÚNICA de «venta» para todo el sistema (módulo auxiliar: el prefijo «_» evita que Vercel lo cuente como función).

Antes el panel Administrador sumaba `total_usd` y otros reportes `subtotal_usd`, y el mismo mes mostraba cifras
distintas. Ahora todos usan estas funciones:

  VENTA  (venta_usd)   = `facturas.total_usd`    lo que se cobra o queda por cobrar, YA con el descuento por pago en
                                                 divisas (USDT). Es la cifra de «Ventas» e «Ingresos» en el Administrador,
                                                 en los Reportes y en las comisiones.
  LISTA  (lista_usd)   = `facturas.subtotal_usd` el mismo pedido a precio de lista (tasa BCV, sin descuento). Solo se
                                                 muestra como dato aparte («precio de lista») o para conciliar por método.
  DESCUENTO            = LISTA − VENTA           lo que se ahorró el cliente al pagar en divisas.

Una factura cuenta como venta salvo que esté ANULADA (`estado = 'anulada'`). Las devoluciones se restan aparte,
por la fecha en que se registraron.

Regla para pantallas nuevas: si muestra «ventas» o «ingresos», debe usar `venta_usd`; si muestra precios de lista,
debe rotularlo («a precio de lista»).
"""
from decimal import Decimal, InvalidOperation

# Filtro de PostgREST para traer solo facturas que cuentan como venta (el mismo en Administrador y Reportes).
FILTRO_VENTA = ("estado", "neq.anulada")
ESTADO_ANULADA = "anulada"

# Textos para que las pantallas rotulen igual la misma cifra.
ETIQUETA_VENTA = "Ventas (cobrado, con descuento por pago en divisas)"
ETIQUETA_LISTA = "A precio de lista (sin descuento)"


def dec(v):
    """Decimal seguro: None, vacío o basura cuentan como 0 (un dato raro no debe tumbar un reporte)."""
    if v is None or isinstance(v, bool):
        return Decimal(0)
    try:
        return Decimal(str(v))
    except InvalidOperation:
        return Decimal(0)


def venta_usd(f):
    """Venta de una factura: `total_usd` (si falta, `subtotal_usd`)."""
    v = f.get("total_usd")
    return dec(v) if v is not None else dec(f.get("subtotal_usd"))


def lista_usd(f):
    """La misma factura a precio de lista: `subtotal_usd` (si falta, `total_usd`)."""
    v = f.get("subtotal_usd")
    return dec(v) if v is not None else dec(f.get("total_usd"))


def descuento_usd(f):
    return max(lista_usd(f) - venta_usd(f), Decimal(0))


def es_venta(f):
    """False si la factura está anulada."""
    return str(f.get("estado") or "").strip().lower() != ESTADO_ANULADA
