"""PDF del comprobante de egreso en tamaño CARTA. Sirve para imprimir y para enviar por WhatsApp.

El prefijo "_" hace que Vercel NO lo exponga como endpoint. Reutiliza el estilo de la nota de entrega
(api/_factura_pdf.py) para que los dos documentos de la empresa se vean iguales.
Recibe el egreso tal como está en la base de datos; nunca la hora actual: la fecha impresa es la del egreso.
"""
import io

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from _factura_pdf import (CREMA, EMPRESA, EMPRESA_DIRECCION, EMPRESA_RIF, EMPRESA_TELEFONO, GRIS, LINEA, TERRACOTA,
                          _e, _estilos, _m)

COMP_TITULO = "COMPROBANTE DE EGRESO"
COMP_NOMBRE = "comprobante de egreso"
COMP_ARCHIVO = "Comprobante-de-egreso"


def numero(id_egreso):
    """EGR-000123 (el id del egreso, con ceros a la izquierda)."""
    return f"EGR-{int(id_egreso):06d}"


def _fecha(iso):
    """'2026-10-21' → '21/10/2026'."""
    p = str(iso or "").split("-")
    return "/".join(reversed(p)) if len(p) == 3 else str(iso or "—")


def _pie(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINEA)
    canvas.line(doc.leftMargin, 0.75 * inch, letter[0] - doc.rightMargin, 0.75 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(GRIS)
    canvas.drawCentredString(letter[0] / 2, 0.55 * inch, f"{EMPRESA}  ·  Comprobante de egreso")
    canvas.restoreState()


def generar_comprobante(egreso, registrado_por=None):
    """Bytes del PDF. `egreso`: fila de la tabla `egresos`. `registrado_por`: nombre de quien lo registró (opcional)."""
    s = _estilos()
    num = numero(egreso["id"])
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        leftMargin=0.75 * inch, rightMargin=0.75 * inch, topMargin=0.7 * inch, bottomMargin=1.0 * inch,
        title=f"Comprobante de egreso {num}", author=EMPRESA,
    )
    ancho = letter[0] - doc.leftMargin - doc.rightMargin
    historia = []

    # ── Encabezado ──
    datos_empresa = [Paragraph(_e(EMPRESA), s["empresa"])]
    for linea in (f"RIF: {EMPRESA_RIF}" if EMPRESA_RIF else "", EMPRESA_DIRECCION, EMPRESA_TELEFONO):
        if linea:
            datos_empresa.append(Paragraph(_e(linea), s["peq"]))
    datos_doc = [
        Paragraph(COMP_TITULO, s["titulo"]),
        Paragraph(f"N.º {num}", s["der"]),
        Paragraph(_fecha(egreso.get("fecha")), ParagraphStyle("f", parent=s["peq"], alignment=TA_RIGHT)),
    ]
    cab = Table([[datos_empresa, datos_doc]], colWidths=[ancho * 0.50, ancho * 0.50])
    cab.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, 0), 1.6, TERRACOTA),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 10),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    historia += [cab, Spacer(1, 14)]

    # ── Beneficiario ──
    benef = egreso.get("proveedor") or "—"
    caja = Table([[
        [Paragraph("PAGADO A", s["etq"]), Paragraph(_e(benef), s["base"])],
        [Paragraph("CATEGORÍA", s["etq"]), Paragraph(_e(egreso.get("categoria")), s["base"])],
        [Paragraph("FECHA", s["etq"]), Paragraph(_fecha(egreso.get("fecha")), s["base"])],
    ]], colWidths=[ancho * 0.44, ancho * 0.30, ancho * 0.26])
    caja.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CREMA), ("BOX", (0, 0), (-1, -1), 0.6, LINEA),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8), ("LEFTPADDING", (0, 0), (-1, -1), 10),
    ]))
    historia += [caja, Spacer(1, 16)]

    # ── Detalle ──
    filas = [[Paragraph("CONCEPTO", s["etq"]), Paragraph(_e(egreso.get("descripcion")), s["base"])],
             [Paragraph("MÉTODO DE PAGO", s["etq"]), Paragraph(_e(egreso.get("metodo_pago") or "No especificado"), s["base"])]]
    if egreso.get("referencia"):
        filas.append([Paragraph("REFERENCIA", s["etq"]), Paragraph(_e(egreso["referencia"]), s["base"])])
    detalle = Table(filas, colWidths=[ancho * 0.24, ancho * 0.76])
    detalle.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, LINEA), ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINEA),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6), ("LEFTPADDING", (0, 0), (-1, -1), 10),
    ]))
    historia += [detalle, Spacer(1, 14)]

    # ── Monto ──
    monto = Table([[Paragraph("MONTO PAGADO ($)", s["totalq"]), Paragraph(f"$ {_m(egreso['monto_usd'])}", s["total"])]],
                  colWidths=[ancho * 0.30, ancho * 0.22], hAlign="RIGHT")
    monto.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, 0), 0.8, TERRACOTA),
                               ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
    historia += [monto, Spacer(1, 40)]

    # ── Firmas (para el comprobante impreso) ──
    def firma(t):
        return [Spacer(1, 26), Paragraph(t, ParagraphStyle("fi", parent=s["peq"], alignment=1))]
    firmas = Table([[firma("Entregado por" + (f": {_e(registrado_por)}" if registrado_por else "")), "",
                     firma("Recibido por (nombre, cédula y firma)")]],
                   colWidths=[ancho * 0.44, ancho * 0.12, ancho * 0.44])
    firmas.setStyle(TableStyle([("LINEABOVE", (0, 0), (0, 0), 0.6, GRIS), ("LINEABOVE", (2, 0), (2, 0), 0.6, GRIS),
                                ("TOPPADDING", (0, 0), (-1, -1), 0)]))
    historia.append(firmas)

    doc.build(historia, onFirstPage=_pie, onLaterPages=_pie)
    return buf.getvalue()
