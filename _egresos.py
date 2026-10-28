"""Egresos: categorías y métodos de pago PERSONALIZADOS, alta de egresos y comprobante (PDF + WhatsApp).

El prefijo "_" hace que Vercel NO lo exponga como endpoint (el límite de 12 funciones sigue igual): lo usa api/administrador.py.

· Categorías y métodos de fábrica: las listas de abajo. Los que crea el administrador viven en `egreso_opciones`
  (sql/egresos_categorias_metodos_comprobantes.sql). Quitar uno solo lo desactiva: los egresos viejos conservan su texto.
· Comprobante: se genera desde la base de datos cada vez (api/_egreso_pdf.py). Se envía por WhatsApp con el mismo bot de las
  notas de entrega; si el beneficiario no tiene WhatsApp o el bot no responde, el egreso YA está guardado y se imprime.
"""
import re
import sys
import unicodedata
from datetime import date, datetime, timezone

import requests

import _comun as c
import _whatsapp as wa
from _egreso_pdf import COMP_ARCHIVO, COMP_NOMBRE, generar_comprobante, numero
from _factura_pdf import EMPRESA

CATEGORIAS_BASE = ["Alquiler", "Servicios", "Nómina", "Comisiones", "Publicidad", "Transporte",
                   "Impuestos", "Mantenimiento", "Otros"]
METODOS_BASE = ["Efectivo $", "Efectivo Bs", "Pago móvil", "Transferencia", "Zelle", "Binance", "Punto de venta", "Otro"]
METODOS_CON_REFERENCIA = {"Pago móvil", "Transferencia", "Zelle", "Binance"}   # dejan rastro bancario: exigen referencia
TIPOS = {"categoria": ("categorías", CATEGORIAS_BASE), "metodo": ("métodos de pago", METODOS_BASE)}
MAX_PERSONALIZADAS = 40            # por tipo
FECHA_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NOMBRE_RE = re.compile(r"^[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ][0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ .,&/+()\-]{1,39}$")
TELEFONO_RE = re.compile(r"^\+?\d{10,15}$")
COLS_EGRESO = "id,fecha,categoria,descripcion,proveedor,monto_usd,metodo_pago,referencia,beneficiario_telefono,comprobante_whatsapp,comprobante_enviado_en"
TIMEOUT_WA = 12                     # s; cabe en maxDuration=30 de api/administrador.py (vercel.json)


def _fallo(r, tabla):
    print(f"[egresos] {tabla} {r.status_code}: {r.text[:300]}", file=sys.stderr)
    raise c.ErrorPeticion(502, "No se pudieron consultar los datos. Inténtalo de nuevo.")


def _clave(texto):
    """Para comparar nombres: sin acentos, sin mayúsculas y con los espacios normalizados."""
    s = unicodedata.normalize("NFD", " ".join(str(texto or "").split()))
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn").casefold()


def _texto(v, nombre, minimo, maximo):
    s = " ".join(v.split()) if isinstance(v, str) else ""
    if not minimo <= len(s) <= maximo:
        raise c.ErrorPeticion(400, f"{nombre}: entre {minimo} y {maximo} caracteres.")
    return s


def normalizar_telefono(v):
    """'0412-123 4567' → '04121234567'. Lanza 400 si no parece un teléfono."""
    t = re.sub(r"[\s\-().]", "", str(v or ""))
    if not TELEFONO_RE.match(t):
        raise c.ErrorPeticion(400, "Teléfono inválido: escribe solo números (10 a 15 dígitos, con o sin +).")
    return t


# ── Opciones personalizadas ─────────────────────────────────────────────────
def _personalizadas():
    r = c._http.get(f"{c.SUPABASE_URL}/rest/v1/egreso_opciones",
                    params={"select": "id,tipo,nombre", "activa": "eq.true", "order": "nombre.asc"},
                    headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if r.status_code != 200:
        _fallo(r, "egreso_opciones")
    return r.json()


def opciones():
    """{categorias: [..nombres], metodos: [..nombres], detalle: {categorias: [{nombre, id|None}], metodos: [...]}}.
    Primero las de fábrica (id None: no se pueden quitar) y luego las personalizadas."""
    filas = _personalizadas()
    detalle = {}
    for tipo, (_, base) in TIPOS.items():
        propias = [{"nombre": f["nombre"], "id": f["id"]} for f in filas if f["tipo"] == tipo]
        detalle[tipo + "s"] = [{"nombre": n, "id": None} for n in base] + propias
    return {"categorias": [o["nombre"] for o in detalle["categorias"]],
            "metodos": [o["nombre"] for o in detalle["metodos"]], "detalle": detalle}


def _valida(tipo, valor):
    """El nombre canónico de una categoría/método permitido (de fábrica o personalizado), o None. Solo consulta la
    base de datos si el valor no es de fábrica."""
    k = _clave(valor)
    for n in TIPOS[tipo][1]:
        if _clave(n) == k:
            return n
    for f in _personalizadas():
        if f["tipo"] == tipo and _clave(f["nombre"]) == k:
            return f["nombre"]
    return None


def crear_opcion(d, u):
    tipo = d.get("tipo")
    if tipo not in TIPOS:
        raise c.ErrorPeticion(400, "Tipo inválido.")
    plural = TIPOS[tipo][0]
    nombre = " ".join(str(d.get("nombre") or "").split())
    if not NOMBRE_RE.match(nombre):
        raise c.ErrorPeticion(400, "El nombre debe tener entre 2 y 40 caracteres: letras, números y . , & / + ( ) -")
    propias = [f for f in _personalizadas() if f["tipo"] == tipo]
    if any(_clave(n) == _clave(nombre) for n in [*TIPOS[tipo][1], *(f["nombre"] for f in propias)]):
        raise c.ErrorPeticion(409, "Ya existe una opción con ese nombre.")
    if len(propias) >= MAX_PERSONALIZADAS:
        raise c.ErrorPeticion(400, f"Llegaste al máximo de {MAX_PERSONALIZADAS} {plural} personalizados. Quita alguno que ya no uses.")
    r = c._http.post(f"{c.SUPABASE_URL}/rest/v1/egreso_opciones",
                     json={"tipo": tipo, "nombre": nombre, "creado_por": u["id"]},
                     headers=c._hdr_servicio({"Prefer": "return=representation"}), timeout=c.TIMEOUT)
    if r.status_code == 409:   # otra petición la creó a la vez (índice único)
        raise c.ErrorPeticion(409, "Ya existe una opción con ese nombre.")
    if r.status_code not in (200, 201):
        _fallo(r, "egreso_opciones")
    print(f"[egresos] {u['email']} creó {tipo} «{nombre}»", file=sys.stderr)
    return r.json()[0]["id"]


def quitar_opcion(d, u):
    """Desactiva una opción personalizada. Los egresos ya registrados con ella no cambian."""
    i = d.get("id")
    if isinstance(i, bool) or not isinstance(i, int) or i < 1:
        raise c.ErrorPeticion(400, "Opción inválida.")
    r = c._http.patch(f"{c.SUPABASE_URL}/rest/v1/egreso_opciones", params={"id": f"eq.{i}", "activa": "eq.true"},
                      json={"activa": False, "desactivada_por": u["id"], "desactivada_en": datetime.now(timezone.utc).isoformat()},
                      headers=c._hdr_servicio({"Prefer": "return=representation"}), timeout=c.TIMEOUT)
    if r.status_code != 200:
        _fallo(r, "egreso_opciones")
    if not r.json():
        raise c.ErrorPeticion(404, "La opción no existe o ya estaba quitada.")
    print(f"[egresos] {u['email']} quitó la opción {i}", file=sys.stderr)


# ── Alta de egresos ─────────────────────────────────────────────────────────
def crear(d, u):
    """Valida y guarda el egreso. Devuelve la fila guardada (con su id). Lanza ErrorPeticion si algo no cuadra."""
    fecha = d.get("fecha")
    try:
        if not (isinstance(fecha, str) and FECHA_RE.match(fecha)):
            raise ValueError
        date.fromisoformat(fecha)
    except ValueError:
        raise c.ErrorPeticion(400, "Fecha inválida.") from None
    categoria = _valida("categoria", d.get("categoria")) if isinstance(d.get("categoria"), str) else None
    if not categoria:
        raise c.ErrorPeticion(400, "Categoría inválida.")
    metodo = _valida("metodo", d.get("metodo_pago")) if isinstance(d.get("metodo_pago"), str) else None
    if not metodo:
        raise c.ErrorPeticion(400, "Elige un método de pago válido.")
    monto = d.get("monto_usd")
    if isinstance(monto, bool) or not isinstance(monto, (int, float)) or not 0.01 <= monto <= 10_000_000:
        raise c.ErrorPeticion(400, "Monto inválido.")
    ref = _texto(d.get("referencia"), "La referencia", 1, 40) if d.get("referencia") else None
    if metodo in METODOS_CON_REFERENCIA and not ref:
        raise c.ErrorPeticion(400, f"Con {metodo} la referencia es obligatoria.")
    fila = {"fecha": fecha, "categoria": categoria, "monto_usd": round(float(monto), 2), "creado_por": u["id"],
            "descripcion": _texto(d.get("descripcion"), "La descripción", 3, 150),
            "proveedor": (_texto(d.get("proveedor"), "El proveedor", 1, 80) if d.get("proveedor") else None),
            "metodo_pago": metodo, "referencia": ref,
            "beneficiario_telefono": normalizar_telefono(d["telefono"]) if d.get("telefono") else None}
    if d.get("enviar_whatsapp") and not fila["beneficiario_telefono"]:
        raise c.ErrorPeticion(400, "Para enviar el comprobante por WhatsApp escribe el teléfono del beneficiario.")
    r = c._http.post(f"{c.SUPABASE_URL}/rest/v1/egresos", json=fila,
                     headers=c._hdr_servicio({"Prefer": "return=representation"}), timeout=c.TIMEOUT)
    if r.status_code not in (200, 201):
        _fallo(r, "egresos")
    return r.json()[0]


# ── Comprobante ─────────────────────────────────────────────────────────────
def _egreso(id_egreso):
    if isinstance(id_egreso, bool) or not isinstance(id_egreso, int) or id_egreso < 1:
        raise c.ErrorPeticion(400, "Egreso inválido.")
    r = c._http.get(f"{c.SUPABASE_URL}/rest/v1/egresos",
                    params={"select": f"{COLS_EGRESO},creado_por", "id": f"eq.{id_egreso}", "eliminado_en": "is.null", "limit": "1"},
                    headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if r.status_code != 200:
        _fallo(r, "egresos")
    filas = r.json()
    if not filas:
        raise c.ErrorPeticion(404, "El egreso no existe o fue eliminado.")
    return filas[0]


def _quien(e):
    try:
        p = c.obtener_perfil(e["creado_por"]) if e.get("creado_por") else None
        return (p or {}).get("nombre")
    except requests.RequestException:
        return None


def pdf(id_egreso):
    """(bytes del PDF, N.º de comprobante) de un egreso vigente."""
    e = _egreso(id_egreso)
    return generar_comprobante(e, _quien(e)), numero(e["id"])


def enviar_comprobante(id_egreso, telefono=None):
    """Manda el comprobante por WhatsApp. Devuelve 'enviado' | 'sin_whatsapp' | 'no_disponible' | 'no_configurado'.
    Nunca lanza por fallos del envío (el egreso ya está guardado); sí si el egreso no existe o el teléfono es inválido.
    Con `telefono` envía a ese número y, si el egreso no tenía beneficiario, lo guarda para la próxima vez."""
    e = _egreso(id_egreso)
    tel = normalizar_telefono(telefono) if telefono else e.get("beneficiario_telefono")
    if not tel:
        raise c.ErrorPeticion(400, "Escribe el teléfono del beneficiario.")
    if not wa.configurado():
        estado = wa.NO_CONFIGURADO
    else:
        try:
            doc = generar_comprobante(e, _quien(e))
            num = numero(e["id"])
            saludo = f"Hola {e['proveedor']}, adjuntamos" if e.get("proveedor") else "Adjuntamos"
            estado = wa.enviar_documento(tel, f"{COMP_ARCHIVO}-{num}.pdf", doc,
                                         f"{saludo} tu {COMP_NOMBRE} N.º {num} de {EMPRESA}.", timeout=TIMEOUT_WA)
        except Exception as ex:   # noqa: BLE001 — el envío es accesorio: que no tumbe una respuesta ya guardada
            print(f"[egresos] comprobante {id_egreso}: {ex!r}", file=sys.stderr)
            estado = wa.NO_DISPONIBLE
    cambios = {"comprobante_whatsapp": estado}
    if estado == wa.ENVIADO:
        cambios["comprobante_enviado_en"] = datetime.now(timezone.utc).isoformat()
    if not e.get("beneficiario_telefono"):
        cambios["beneficiario_telefono"] = tel
    try:   # mejor esfuerzo: no es crítico para quien espera el resultado
        c._http.patch(f"{c.SUPABASE_URL}/rest/v1/egresos", params={"id": f"eq.{e['id']}"}, json=cambios,
                      headers=c._hdr_servicio({"Prefer": "return=minimal"}), timeout=c.TIMEOUT)
    except requests.RequestException as ex:
        print(f"[egresos] no se pudo anotar el envío del comprobante {id_egreso}: {ex!r}", file=sys.stderr)
    return estado
