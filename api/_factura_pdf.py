"""Genera el PDF del documento (nota de entrega) en tamaño CARTA (8,5 × 11 pulgadas).

El prefijo "_" hace que Vercel NO lo exponga como endpoint.
El mismo PDF sirve para WhatsApp y para imprimir: el navegador lo abre y se manda a la impresora.
Recibe los diccionarios YA validados por api/enviar-factura.py (`factura` y `detalles`).
"""
import io
import os
from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

# ── Nombre del documento: se cambia SOLO AQUÍ y se refleja en el PDF, el nombre del archivo y el mensaje de WhatsApp ──
DOC_TITULO = "NOTA DE ENTREGA"        # encabezado grande del PDF
DOC_NOMBRE = "nota de entrega"        # en frases: "Adjuntamos tu nota de entrega..."
DOC_ARCHIVO = "Nota-de-entrega"       # prefijo del archivo: Nota-de-entrega-<id>.pdf

# Datos de la empresa (se pueden cambiar con variables de entorno en Vercel).
EMPRESA = os.environ.get("EMPRESA_NOMBRE", "Corporación Katoa Global")
EMPRESA_RIF = os.environ.get("EMPRESA_RIF", "")
EMPRESA_DIRECCION = os.environ.get("EMPRESA_DIRECCION", "")
EMPRESA_TELEFONO = os.environ.get("EMPRESA_TELEFONO", "")

VENEZUELA = timezone(timedelta(hours=-4))  # sin horario de verano

TERRACOTA = colors.HexColor("#A65A30")
CREMA = colors.HexColor("#F6EFE9")
LINEA = colors.HexColor("#E6DDD5")
TINTA = colors.HexColor("#1E293B")
GRIS = colors.HexColor("#5B6678")

METODOS = {
    "MIXTO": "Pago combinado",
    "PM": "Pago móvil",
    "PVD": "Punto de venta (débito)",
    "PVC": "Punto de venta (crédito)",
    "ED": "Efectivo en dólares",
    "EBS": "Efectivo en bolívares",
    "ZELLE": "Zelle",
    "BINANCE": "Binance",
    "OTROS": "Otro método",
}


def _m(n):
    """1234.5 → 1.234,50 (formato venezolano)."""
    return f"{float(n):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _cant(n):
    n = float(n)
    return str(int(n)) if n == int(n) else f"{n:g}".replace(".", ",")


def _cedula(digitos):
    d = "".join(ch for ch in str(digitos) if ch.isdigit())
    return f"{int(d):,}".replace(",", ".") if d else str(digitos)


def _e(texto):
    return escape(str(texto or ""))


def _estilos():
    base = ParagraphStyle("base", fontName="Helvetica", fontSize=9.5, leading=13, textColor=TINTA)
    return {
        "base": base,
        "peq": ParagraphStyle("peq", parent=base, fontSize=8, leading=11, textColor=GRIS),
        "der": ParagraphStyle("der", parent=base, alignment=TA_RIGHT),
        "etq": ParagraphStyle("etq", parent=base, fontName="Helvetica-Bold", fontSize=7.5, leading=10, textColor=GRIS),
        "empresa": ParagraphStyle("empresa", parent=base, fontName="Helvetica-Bold", fontSize=17, leading=20, textColor=TERRACOTA),
        "titulo": ParagraphStyle("titulo", parent=base, fontName="Helvetica-Bold", fontSize=15, leading=18, alignment=TA_RIGHT),
        "th": ParagraphStyle("th", parent=base, fontName="Helvetica-Bold", fontSize=8.5, textColor=colors.white),
        "thd": ParagraphStyle("thd", parent=base, fontName="Helvetica-Bold", fontSize=8.5, textColor=colors.white, alignment=TA_RIGHT),
        "total": ParagraphStyle("total", parent=base, fontName="Helvetica-Bold", fontSize=12, leading=15, alignment=TA_RIGHT),
        "totalq": ParagraphStyle("totalq", parent=base, fontName="Helvetica-Bold", fontSize=12, leading=15),
    }


def _fecha():
    return datetime.now(VENEZUELA).strftime("%d/%m/%Y  %I:%M %p")


def _pie(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINEA)
    canvas.line(doc.leftMargin, 0.75 * inch, letter[0] - doc.rightMargin, 0.75 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(GRIS)
    canvas.drawCentredString(letter[0] / 2, 0.55 * inch, f"¡Gracias por su compra!  ·  {EMPRESA}")
    canvas.drawRightString(letter[0] - doc.rightMargin, 0.55 * inch, f"Página {doc.page}")
    canvas.restoreState()


def generar_pdf(factura, detalles):
    """Devuelve los bytes del PDF (tamaño carta)."""
    s = _estilos()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        leftMargin=0.75 * inch, rightMargin=0.75 * inch, topMargin=0.7 * inch, bottomMargin=1.0 * inch,
        title=f"{DOC_TITULO.capitalize()} {factura['id_factura']}", author=EMPRESA,
    )
    ancho = letter[0] - doc.leftMargin - doc.rightMargin
    historia = []

    # ── Encabezado ──
    datos_empresa = [Paragraph(_e(EMPRESA), s["empresa"])]
    for linea in (f"RIF: {EMPRESA_RIF}" if EMPRESA_RIF else "", EMPRESA_DIRECCION, EMPRESA_TELEFONO):
        if linea:
            datos_empresa.append(Paragraph(_e(linea), s["peq"]))
    datos_factura = [
        Paragraph(DOC_TITULO, s["titulo"]),
        Paragraph(f"N.º {_e(factura['id_factura'])}", s["der"]),
        Paragraph(_fecha(), ParagraphStyle("f", parent=s["peq"], alignment=TA_RIGHT)),
    ]
    cab = Table([[datos_empresa, datos_factura]], colWidths=[ancho * 0.55, ancho * 0.45])
    cab.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, 0), 1.6, TERRACOTA),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 10),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    historia += [cab, Spacer(1, 14)]

    # ── Cliente ──
    nombre = f"{factura['nombre']} {factura['apellido']}".strip()
    cliente = Table(
        [[
            [Paragraph("CLIENTE", s["etq"]), Paragraph(_e(nombre), s["base"])],
            [Paragraph("CÉDULA / RIF", s["etq"]), Paragraph(_e(_cedula(factura["cedula"])), s["base"])],
            [Paragraph("TELÉFONO", s["etq"]), Paragraph(_e(factura["telefono"]), s["base"])],
            [Paragraph("VENDEDOR", s["etq"]), Paragraph(_e(factura["vendedor"]), s["base"])],
        ]],
        colWidths=[ancho * 0.34, ancho * 0.22, ancho * 0.22, ancho * 0.22],
    )
    cliente.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CREMA),
        ("BOX", (0, 0), (-1, -1), 0.6, LINEA),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
    ]))
    historia += [cliente, Spacer(1, 16)]

    # ── Productos ──
    filas = [[
        Paragraph("CANT.", s["th"]), Paragraph("DESCRIPCIÓN", s["th"]),
        Paragraph("P. UNIT. ($)", s["thd"]), Paragraph("TOTAL ($)", s["thd"]),
    ]]
    for d in detalles:
        filas.append([
            Paragraph(_cant(d["cantidad"]), s["base"]),
            Paragraph(_e(d["nombre_producto"]), s["base"]),
            Paragraph(_m(d["precio_unitario"]), s["der"]),
            Paragraph(_m(d["precio_total"]), s["der"]),
        ])
    tabla = Table(filas, colWidths=[ancho * 0.11, ancho * 0.5, ancho * 0.195, ancho * 0.195], repeatRows=1)
    tabla.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), TERRACOTA),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, LINEA),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FBF8F5")]),
    ]))
    historia += [tabla, Spacer(1, 12)]

    # ── Totales ──
    subtotal = float(factura["subtotal_usd"])
    cobrado = float(factura["total_usd"])
    mixto = factura["metodo_pago"] == "MIXTO"
    if mixto:
        cobrado = subtotal  # los abonos de la tabla suman el total de lista; el ahorro va en las observaciones
    # En el pago combinado el descuento aplica solo a una parte: va explicado en las observaciones
    con_descuento = not mixto and abs(subtotal - cobrado) > 0.004
    tasa = float(factura["tasa_cambio"])
    lineas = []
    if con_descuento:
        lineas.append(("Total a precio de lista", f"$ {_m(subtotal)}", "base"))
        lineas.append(("Descuento por pago en dólares", f"- $ {_m(subtotal - cobrado)}", "base"))
    lineas.append(("TOTAL A PAGAR ($)" if con_descuento else "TOTAL ($)", f"$ {_m(cobrado)}", "total"))
    lineas.append((f"Total Bs (tasa BCV {_m(tasa)})", f"Bs {_m(factura['total_bs'])}", "base"))
    filas_tot = []
    for etiqueta, valor, est in lineas:
        est_izq = s["totalq"] if est == "total" else s["base"]
        est_der = s["total"] if est == "total" else s["der"]
        filas_tot.append([Paragraph(etiqueta, est_izq), Paragraph(valor, est_der)])
    tot = Table(filas_tot, colWidths=[ancho * 0.30, ancho * 0.22], hAlign="RIGHT")
    tot.setStyle(TableStyle([
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LINEABOVE", (0, 2 if con_descuento else 0), (-1, 2 if con_descuento else 0), 0.8, TERRACOTA),
    ]))
    historia += [tot, Spacer(1, 18)]

    # ── Pago ──
    metodo = METODOS.get(factura["metodo_pago"], factura["metodo_pago"])
    pagos = factura.get("pagos_combinados") if mixto else None
    if pagos:
        historia += [Paragraph("FORMA DE PAGO · COMBINADO", s["etq"]), Spacer(1, 4)]
        filas_p = [[
            Paragraph("MÉTODO", s["th"]), Paragraph("DETALLE", s["th"]),
            Paragraph("MONTO", s["thd"]), Paragraph("ABONO ($)", s["thd"]),
        ]]
        for x in pagos:
            partes = []
            if x.get("banco") not in (None, "", "N/A"):
                partes.append(f"Banco: {x['banco']}")
            if x.get("referencia") not in (None, "", "N/A"):
                partes.append(f"Ref.: {x['referencia']}")
            if x.get("observaciones"):
                partes.append(x["observaciones"])
            simbolo = "$" if x.get("moneda") == "USD" else "Bs"
            filas_p.append([
                Paragraph(_e(METODOS.get(x["metodo"], x["metodo"])), s["base"]),
                Paragraph(_e(" · ".join(partes) or "—"), s["peq"]),
                Paragraph(f"{simbolo} {_m(x['monto'])}", s["der"]),
                Paragraph(_m(x["abono_usd"]), s["der"]),
            ])
        tabla_pagos = Table(filas_p, colWidths=[ancho * 0.27, ancho * 0.37, ancho * 0.19, ancho * 0.17], repeatRows=1)
        tabla_pagos.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), TERRACOTA),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LINEBELOW", (0, 1), (-1, -1), 0.4, LINEA),
        ]))
        historia += [tabla_pagos, Spacer(1, 10)]
        pago = []
    else:
        pago = [[Paragraph("MÉTODO DE PAGO", s["etq"]), Paragraph(_e(metodo), s["base"])]]
    if factura.get("banco") not in (None, "", "N/A"):
        pago.append([Paragraph("BANCO", s["etq"]), Paragraph(_e(factura["banco"]), s["base"])])
    if factura.get("referencia") not in (None, "", "N/A"):
        pago.append([Paragraph("REFERENCIA", s["etq"]), Paragraph(_e(factura["referencia"]), s["base"])])
    if factura.get("observaciones"):
        pago.append([Paragraph("OBSERVACIONES", s["etq"]), Paragraph(_e(factura["observaciones"]), s["base"])])
    if pago:
        bloque_pago = Table(pago, colWidths=[ancho * 0.22, ancho * 0.78])
        bloque_pago.setStyle(TableStyle([
            ("BOX", (0, 0), (-1, -1), 0.6, LINEA),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ]))
        historia.append(bloque_pago)

    doc.build(historia, onFirstPage=_pie, onLaterPages=_pie)
    return buf.getvalue()
