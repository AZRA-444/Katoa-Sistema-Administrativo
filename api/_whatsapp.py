"""Cliente del bot de WhatsApp (Baileys) y almacenamiento de los PDF de facturas.

El prefijo "_" hace que Vercel NO lo exponga como endpoint.

Variables de entorno (Vercel):
  WHATSAPP_BOT_URL  → URL pública (https) del bot, sin barra final. Ej.: https://bot.midominio.com
  WHATSAPP_BOT_KEY  → clave secreta compartida con el bot (la misma que API_KEY en el bot).
"""
import base64
import os
import sys

import requests

import _comun as c
from _factura_pdf import DOC_ARCHIVO, DOC_NOMBRE, generar_pdf

BOT_URL = os.environ.get("WHATSAPP_BOT_URL", "").rstrip("/")
BOT_KEY = os.environ.get("WHATSAPP_BOT_KEY", "")
BUCKET_FACTURAS = "facturas"  # bucket PRIVADO en Supabase Storage
TIMEOUT_BOT = (3.05, 8)  # (conexión, lectura). Debe caber en el límite de la función de Vercel.

# Estados que se devuelven al navegador
ENVIADO = "enviado"
SIN_WHATSAPP = "sin_whatsapp"
NO_DISPONIBLE = "no_disponible"
NO_CONFIGURADO = "no_configurado"


# ── Almacén de PDF (Supabase Storage) ───────────────────────────────────────
def subir_pdf(id_factura, pdf, timeout=None):
    """Guarda el PDF. Devuelve True/False (nunca lanza: la factura ya está guardada).
    `timeout` (s) permite ajustar la espera al tiempo que le queda a la función de Vercel."""
    try:
        r = c._http.post(
            f"{c.SUPABASE_URL}/storage/v1/object/{BUCKET_FACTURAS}/{id_factura}.pdf",
            data=pdf,
            headers=c._hdr_servicio({"Content-Type": "application/pdf", "x-upsert": "true"}),
            timeout=timeout or c.TIMEOUT * 2,
        )
        if r.status_code in (200, 201):
            return True
        print(f"[facturas] storage {r.status_code}: {r.text[:300]}", file=sys.stderr)
    except requests.RequestException as e:
        print(f"[facturas] storage error: {e}", file=sys.stderr)
    return False


def descargar_pdf(id_factura, timeout=None):
    """Devuelve los bytes del PDF o None si no existe."""
    r = c._http.get(
        f"{c.SUPABASE_URL}/storage/v1/object/{BUCKET_FACTURAS}/{id_factura}.pdf",
        headers=c._hdr_servicio(),
        timeout=timeout or c.TIMEOUT * 2,
    )
    if r.status_code == 200 and r.content.startswith(b"%PDF"):
        return r.content
    return None


COLS_FACTURA_PDF = ("id_factura,nombre,apellido,cedula,telefono,vendedor,subtotal_usd,total_usd,subtotal_bs,total_bs,"
                    "tasa_cambio,metodo_pago,referencia,banco,observaciones,pagos_combinados,created_at,"
                    "factura_detalles(id,nombre_producto,cantidad,precio_unitario,precio_total)")


def factura_desde_bd(id_factura, timeout=None):
    """(factura, detalles) tal como están GUARDADOS en la base de datos, o None si la factura no existe.
    Es la única fuente válida para regenerar un PDF: lo que llega en una petición repetida puede diferir de lo guardado."""
    r = c._http.get(
        f"{c.SUPABASE_URL}/rest/v1/facturas",
        params={"select": COLS_FACTURA_PDF, "id_factura": f"eq.{id_factura}", "limit": "1"},
        headers=c._hdr_servicio(), timeout=timeout or c.TIMEOUT,
    )
    if r.status_code != 200:
        print(f"[facturas] lectura para PDF {r.status_code}: {r.text[:200]}", file=sys.stderr)
        raise RuntimeError("consulta de factura fallida")
    filas = r.json()
    if not filas:
        return None
    factura = filas[0]
    detalles = sorted(factura.pop("factura_detalles", None) or [], key=lambda d: d["id"])
    return factura, detalles


def regenerar_pdf(id_factura, timeout=None):
    """Genera el PDF de una factura YA guardada a partir de la base de datos (con la fecha original) y lo archiva.
    Devuelve (bytes, guardado: bool), o None si la factura no existe. Mejor esfuerzo al archivar: nunca lanza por eso."""
    datos = factura_desde_bd(id_factura, timeout)
    if datos is None:
        return None
    pdf = generar_pdf(*datos)
    return pdf, subir_pdf(id_factura, pdf, timeout=timeout)


# ── Envío por WhatsApp ──────────────────────────────────────────────────────
def configurado():
    return bool(BOT_URL and BOT_KEY)


def leyenda(id_factura, nombre=None):
    saludo = f"Hola {nombre}, gracias" if nombre else "Gracias"
    return f"{saludo} por tu compra en Corporación Katoa Global. Adjuntamos tu {DOC_NOMBRE} N.º {id_factura}."


def enviar_pdf(telefono, id_factura, pdf, nombre=None, timeout=None):
    """Manda el PDF por WhatsApp. Devuelve ENVIADO | SIN_WHATSAPP | NO_DISPONIBLE | NO_CONFIGURADO.
    `timeout` (s) acota la lectura según el tiempo restante de la función; sin él se usa TIMEOUT_BOT.

    Usa requests.post directo (sin reintentos automáticos): reintentar un POST
    podría entregar la factura dos veces al cliente.
    """
    if not configurado():
        return NO_CONFIGURADO
    t_bot = TIMEOUT_BOT if timeout is None else (min(TIMEOUT_BOT[0], timeout), min(TIMEOUT_BOT[1], timeout))
    try:
        r = requests.post(
            f"{BOT_URL}/send-document",
            json={
                "to": telefono,
                "filename": f"{DOC_ARCHIVO}-{id_factura}.pdf",
                "pdf_base64": base64.b64encode(pdf).decode("ascii"),
                "caption": leyenda(id_factura, nombre),
            },
            headers={"x-api-key": BOT_KEY},
            timeout=t_bot,
        )
    except requests.RequestException as e:
        print(f"[whatsapp] bot inalcanzable: {e}", file=sys.stderr)
        return NO_DISPONIBLE
    if r.status_code == 200:
        return ENVIADO
    if r.status_code == 404:
        return SIN_WHATSAPP
    print(f"[whatsapp] bot respondió {r.status_code}: {r.text[:300]}", file=sys.stderr)
    return NO_DISPONIBLE
