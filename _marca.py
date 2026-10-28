"""Datos generales de la empresa para TODOS los documentos PDF (nota de entrega y comprobante de egreso).

El prefijo "_" hace que Vercel NO lo exponga como endpoint. Se cambian con variables de entorno en Vercel:
  EMPRESA_NOMBRE, EMPRESA_RIF, EMPRESA_DIRECCION, EMPRESA_TELEFONO, EMPRESA_EMAIL
Lo que quede vacío simplemente no se imprime. El logo se cambia con scripts/generar_logo_pdf.py (api/_logo.py).
"""
import base64
import binascii
import io
import os

from _logo import LOGO_B64

EMPRESA = os.environ.get("EMPRESA_NOMBRE", "Corporación Katoa Global")
EMPRESA_RIF = os.environ.get("EMPRESA_RIF", "")
EMPRESA_DIRECCION = os.environ.get("EMPRESA_DIRECCION", "")
EMPRESA_TELEFONO = os.environ.get("EMPRESA_TELEFONO", "")
EMPRESA_EMAIL = os.environ.get("EMPRESA_EMAIL", "")


def lineas_empresa():
    """Las líneas de datos de la empresa que SÍ están configuradas, en orden de impresión."""
    return [x for x in (
        f"RIF: {EMPRESA_RIF}" if EMPRESA_RIF else "",
        EMPRESA_DIRECCION,
        " · ".join(p for p in (f"Tel.: {EMPRESA_TELEFONO}" if EMPRESA_TELEFONO else "", EMPRESA_EMAIL) if p),
    ) if x]


def logo_bytes():
    """Bytes del PNG del logo, o None si no se pudo leer (el PDF se genera igual, sin logo)."""
    try:
        return base64.b64decode(LOGO_B64)
    except (binascii.Error, ValueError):
        return None


def logo_flowable(alto_max, ancho_max=None):
    """Imagen de reportlab del logo o None. Conserva la proporción: cabe en `alto_max` × `ancho_max` puntos
    (por defecto el doble de ancho que de alto, para logos horizontales) sin deformarse."""
    datos = logo_bytes()
    if not datos:
        return None
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import Image
    try:
        w, h = ImageReader(io.BytesIO(datos)).getSize()
    except Exception:  # imagen dañada: el PDF se genera igual, sin logo
        return None
    ancho_max = ancho_max or alto_max * 2
    escala = min(alto_max / h, ancho_max / w)
    img = Image(io.BytesIO(datos), width=w * escala, height=h * escala)
    img.hAlign = "LEFT"
    return img
