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
from _factura_pdf import DOC_ARCHIVO, DOC_NOMBRE

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
def subir_pdf(id_factura, pdf):
    """Guarda el PDF. Devuelve True/False (nunca lanza: la factura ya está guardada)."""
    try:
        r = c._http.post(
            f"{c.SUPABASE_URL}/storage/v1/object/{BUCKET_FACTURAS}/{id_factura}.pdf",
            data=pdf,
            headers=c._hdr_servicio({"Content-Type": "application/pdf", "x-upsert": "true"}),
            timeout=c.TIMEOUT * 2,
        )
        if r.status_code in (200, 201):
            return True
        print(f"[facturas] storage {r.status_code}: {r.text[:300]}", file=sys.stderr)
    except requests.RequestException as e:
        print(f"[facturas] storage error: {e}", file=sys.stderr)
    return False


def descargar_pdf(id_factura):
    """Devuelve los bytes del PDF o None si no existe."""
    r = c._http.get(
        f"{c.SUPABASE_URL}/storage/v1/object/{BUCKET_FACTURAS}/{id_factura}.pdf",
        headers=c._hdr_servicio(),
        timeout=c.TIMEOUT * 2,
    )
    if r.status_code == 200 and r.content.startswith(b"%PDF"):
        return r.content
    return None


# ── Envío por WhatsApp ──────────────────────────────────────────────────────
def configurado():
    return bool(BOT_URL and BOT_KEY)


def leyenda(id_factura, nombre=None):
    saludo = f"Hola {nombre}, gracias" if nombre else "Gracias"
    return f"{saludo} por tu compra en Corporación Katoa Global. Adjuntamos tu {DOC_NOMBRE} N.º {id_factura}."


def enviar_pdf(telefono, id_factura, pdf, nombre=None):
    """Manda el PDF por WhatsApp. Devuelve ENVIADO | SIN_WHATSAPP | NO_DISPONIBLE | NO_CONFIGURADO.

    Usa requests.post directo (sin reintentos automáticos): reintentar un POST
    podría entregar la factura dos veces al cliente.
    """
    if not configurado():
        return NO_CONFIGURADO
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
            timeout=TIMEOUT_BOT,
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
