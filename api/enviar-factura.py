"""POST /api/enviar-factura

Guarda una factura en Supabase (RPC `guardar_factura_completa`).

Seguridad:
  - Exige sesión activa (cookie HttpOnly creada por /api/login) y comprueba el origen.
  - Valida todos los campos y RECALCULA el total en el servidor;
    si no coinciden con lo que envió el navegador, rechaza la factura.
  - Contrasta con datos del servidor lo que el navegador NO debe decidir (verificar_servidor):
      · precios: los de lista del inventario según la cantidad (solo admin/sysadmin pueden cambiarlos);
      · tasas: BCV y USDT frente a la fuente de referencia (desvío máximo configurable);
      · vendedor: el usuario autenticado, no el texto que llega del navegador.
  - Sube el comprobante (JPEG) al bucket `comprobantes` DESPUÉS de guardar la factura y sin sobrescribir
    nunca uno existente (así un id reutilizado no puede pisar el comprobante original).

Después de guardar:
  - Genera el PDF (tamaño carta), lo archiva en el bucket `facturas` y lo envía por WhatsApp
    al cliente a través del bot (api/_whatsapp.py). Si algo de esto falla, la factura sigue
    guardada y la respuesta indica el estado (`pdf`, `whatsapp`) para que el navegador
    ofrezca imprimir o reintentar.
"""
import base64
import binascii
import os
import re
import sys
import time
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402
import _referencias as ref  # noqa: E402
import _whatsapp as wa  # noqa: E402
from _factura_pdf import generar_pdf  # noqa: E402

MAX_BODY = 2 * 1024 * 1024
MAX_COMPROBANTE = 1_500_000  # bytes, ya comprimido por el navegador
MAX_PRODUCTOS = 150
CENT = Decimal("0.01")
TOLERANCIA = Decimal("0.02")  # diferencia admitida por redondeo JS vs Python
BUCKET = "comprobantes"
PREFIJO_JPEG = "data:image/jpeg;base64,"

METODOS_MIXTO = {"PM", "PVD", "PVC", "ED", "ZELLE", "BINANCE", "EBS", "OTROS"}  # los que se pueden combinar
METODOS = METODOS_MIXTO | {"MIXTO"}  # MIXTO = pago combinado (varios métodos, repetibles)
MAX_PAGOS = 8  # máximo de pagos dentro de un pago combinado
METODOS_USD = {"ED", "ZELLE", "BINANCE"}  # se cobran en dólares con la tasa USDT
MAX_BRECHA_USDT = Decimal(2)  # tasa USDT > 2× BCV se considera un error de digitación

ID_RE = re.compile(r"^[A-Za-z0-9\-]{1,64}$")
CEDULA_RE = re.compile(r"^[\d.]+$")
TELEFONO_RE = re.compile(r"^\+?\d{10,15}$")
REFERENCIA_RE = re.compile(r"^\d{4,12}$")
REFERENCIA_DIGITAL_RE = re.compile(r"^[A-Z0-9]{4,30}$")  # Zelle / Binance

MSG_NO_DISPONIBLE = "Servicio no disponible. Intenta de nuevo en un momento."
MSG_COMPROBANTE = ("La factura se guardó, pero no se pudo subir el comprobante. "
                   "Pulsa «Finalizar» de nuevo para reintentar solo el comprobante.")

# Un 23505 (unique_violation) solo significa «factura duplicada» si el conflicto es sobre el id de la factura.
RE_DUPLICADO_FACTURA = re.compile(r"id_factura|facturas?_\w*(pkey|key)", re.IGNORECASE)


def _entero_env(nombre, defecto):
    try:
        return int(os.environ.get(nombre, ""))
    except ValueError:
        return defecto


# Tiempo total de la función. DEBE ser menor o igual que "maxDuration" de api/enviar-factura.py en vercel.json.
MAX_SEGUNDOS = _entero_env("FUNCION_MAX_SEGUNDOS", 30)
MARGEN_SEGUNDOS = 3  # reserva para responder antes de que Vercel corte la función


class _Presupuesto:
    """Tiempo que le queda a la petición. La factura ya está guardada cuando empieza el PDF y WhatsApp,
    así que esas etapas se acortan u omiten antes que dejar que Vercel mate la función."""

    def __init__(self, total=MAX_SEGUNDOS, margen=MARGEN_SEGUNDOS):
        self.fin = time.monotonic() + total - margen

    def restante(self):
        return self.fin - time.monotonic()

    def timeout(self, maximo, minimo=1.5):
        """Timeout para la próxima llamada externa, o None si ya no queda tiempo útil."""
        r = self.restante()
        return None if r < minimo else min(maximo, r)


# ── Validación ──────────────────────────────────────────────────────────────
def _err(mensaje, status=400):
    raise c.ErrorPeticion(status, mensaje)


def _r2(d):
    return d.quantize(CENT, rounding=ROUND_HALF_UP)


def _texto(valor, nombre, maximo, obligatorio=True):
    if valor is None:
        valor = ""
    if not isinstance(valor, str):
        _err(f"Valor inválido en {nombre}.")
    valor = valor.strip()
    if obligatorio and not valor:
        _err(f"Falta {nombre}.")
    if len(valor) > maximo:
        _err(f"{nombre[0].upper() + nombre[1:]} es demasiado largo.")
    if any(ch < " " and ch not in "\n\t" for ch in valor):
        _err(f"Caracteres no permitidos en {nombre}.")
    return valor


def _positivo(valor, nombre, maximo):
    """Número JSON > 0 y finito (rechaza bool, texto, NaN e Infinity)."""
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        _err(f"Valor inválido en {nombre}.")
    try:
        d = Decimal(str(valor))
    except InvalidOperation:
        _err(f"Valor inválido en {nombre}.")
    if not d.is_finite() or d <= 0 or d > maximo:
        _err(f"Valor fuera de rango en {nombre}.")
    return d


def _num(d):
    """Decimal → int si es entero (columnas int en la BD), si no float."""
    return int(d) if d == d.to_integral_value() else float(d)


def calcular_totales(lineas, tasa):
    total = sum((l["total"] for l in lineas), Decimal(0))
    return {"total": total, "total_bs": _r2(total * tasa)}


def monto_en_dolares(t, tasa_usdt):
    """Cobro en dólares: total en Bs (tasa BCV) ÷ tasa USDT. Ej.: 100$ × 857,89 ÷ 960 = 89,36$.
    Nunca supera el total. Debe coincidir con montoEnDolares en js/facturacion.js."""
    return min(t["total"], _r2(t["total_bs"] / tasa_usdt))


def _decodificar_comprobante(valor):
    if valor in (None, ""):
        return None
    if not isinstance(valor, str) or not valor.startswith(PREFIJO_JPEG):
        _err("El comprobante debe ser una imagen JPEG.")
    b64 = valor[len(PREFIJO_JPEG):]
    if len(b64) > MAX_COMPROBANTE * 4 // 3 + 8:
        _err("El comprobante es demasiado grande.")
    try:
        datos = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        _err("El comprobante no es una imagen válida.")
    if len(datos) > MAX_COMPROBANTE or not datos.startswith(b"\xff\xd8\xff"):
        _err("El comprobante no es una imagen válida.")
    return datos


def _validar_mixto(p, t, tasa):
    """Pago combinado: varios pagos (métodos repetibles) que juntos cubren el total.

    Cada pago se convierte a "dólares de lista" (los de la tasa BCV):
      · en Bs            → monto ÷ tasa BCV
      · en $ con descuento (ED, Zelle, Binance) → monto × max(1, tasa USDT ÷ tasa BCV)
      · en $ sin descuento / "Otros" en $       → monto
    La suma debe igualar el total de lista. Debe coincidir con abonoLinea en js/facturacion.js.
    Devuelve (pagos_limpios, total_cobrado_usd, nota).
    """
    crudos = p.get("pagos")
    if not isinstance(crudos, list) or not 2 <= len(crudos) <= MAX_PAGOS:
        _err(f"El pago combinado necesita entre 2 y {MAX_PAGOS} pagos.")

    usa_usd = any(isinstance(x, dict) and x.get("metodo") in METODOS_USD for x in crudos)
    factor, tasa_usdt, aplicar = Decimal(1), None, False
    if usa_usd:
        aplicar = p.get("aplicar_descuento")
        if not isinstance(aplicar, bool):
            _err("Falta indicar si se aplica el descuento. Recarga la página e inténtalo de nuevo.")
        if aplicar:
            tasa_usdt = _positivo(p.get("tasa_usdt"), "la tasa USDT", Decimal(1_000_000))
            if tasa_usdt > tasa * MAX_BRECHA_USDT:
                _err("La tasa USDT parece incorrecta. Revísala e inténtalo de nuevo.")
            factor = max(Decimal(1), tasa_usdt / tasa)

    limpios, abonado, ahorro = [], Decimal(0), Decimal(0)
    for i, x in enumerate(crudos, 1):
        if not isinstance(x, dict):
            _err(f"Pago {i} inválido.")
        metodo = x.get("metodo")
        if metodo not in METODOS_MIXTO:
            _err(f"Pago {i}: método inválido.")
        moneda = x.get("moneda")
        esperada = moneda if metodo == "OTROS" else ("USD" if metodo in METODOS_USD else "BS")
        if moneda not in ("USD", "BS") or moneda != esperada:
            _err(f"Pago {i}: moneda inválida.")
        monto = _positivo(x.get("monto"), f"el monto del pago {i}", Decimal(10) ** 12)
        observaciones = _texto(x.get("observaciones"), f"las observaciones del pago {i}", 500, obligatorio=False)
        banco = referencia = "N/A"

        if metodo == "PM":
            banco = _texto(x.get("banco"), f"el banco del pago {i}", 40)
            referencia = _texto(x.get("referencia"), f"la referencia del pago {i}", 12)
            if not REFERENCIA_RE.match(referencia):
                _err(f"Pago {i}: la referencia debe tener entre 4 y 12 dígitos.")
        elif metodo in ("ZELLE", "BINANCE"):
            referencia = _texto(x.get("referencia"), f"la referencia del pago {i}", 30).upper()
            if not REFERENCIA_DIGITAL_RE.match(referencia):
                _err(f"Pago {i}: la referencia debe tener entre 4 y 30 letras o números.")
        elif metodo == "OTROS" and not observaciones:
            _err(f"Pago {i}: describe el método de pago en las observaciones.")

        if moneda == "BS":
            abono = monto / tasa
        elif metodo in METODOS_USD:
            abono = monto * factor
            ahorro += monto * (factor - 1)
        else:
            abono = monto
        abonado += abono
        limpios.append({
            "metodo": metodo, "moneda": moneda, "monto": float(_r2(monto)), "abono_usd": float(_r2(abono)),
            "banco": banco, "referencia": referencia, "observaciones": observaciones,
        })

    tolerancia = TOLERANCIA + Decimal("0.01") * len(limpios)  # mismo criterio que toleranciaMixto en el JS
    diferencia = t["total"] - abonado
    if diferencia > tolerancia:
        _err("Los pagos no cubren el total de la factura.")
    if diferencia < -tolerancia:
        _err("Los pagos superan el total de la factura.")

    ahorro = _r2(ahorro)
    nota = f"Pago combinado ({len(limpios)} pagos)"
    if usa_usd:
        nota += f" · Descuento USDT aplicado · Tasa {tasa_usdt:.2f} · Ahorro ${ahorro:.2f}" if aplicar else " · Sin descuento USDT"
    return limpios, t["total"] - ahorro, nota


def validar(p):
    """Devuelve (p_factura, p_detalles, comprobante_bytes|None) o lanza ErrorPeticion(400)."""
    id_factura = _texto(p.get("id_factura"), "el id de factura", 64)
    if not ID_RE.match(id_factura):
        _err("Id de factura inválido.")

    nombre = _texto(p.get("nombre"), "el nombre", 60)
    apellido = _texto(p.get("apellido"), "el apellido", 60)
    cedula = _texto(p.get("cedula"), "la cédula", 15)
    if not CEDULA_RE.match(cedula) or not 6 <= len(re.sub(r"\D", "", cedula)) <= 8:
        _err("Cédula inválida.")
    telefono = _texto(p.get("telefono"), "el teléfono", 16)
    if not TELEFONO_RE.match(telefono):
        _err("Teléfono inválido.")
    vendedor = _texto(p.get("vendedor"), "el vendedor", 60)
    tasa = _positivo(p.get("tasa_cambio"), "la tasa de cambio", Decimal(1_000_000))

    # Productos
    crudos = p.get("productos")
    if not isinstance(crudos, list) or not 1 <= len(crudos) <= MAX_PRODUCTOS:
        _err(f"La factura debe tener entre 1 y {MAX_PRODUCTOS} productos.")
    lineas = []
    for i, it in enumerate(crudos, 1):
        if not isinstance(it, dict):
            _err(f"Producto {i} inválido.")
        cantidad = _positivo(it.get("cantidad"), f"la cantidad del producto {i}", Decimal(100_000))
        unitario = _positivo(it.get("precioUnitario"), f"el precio del producto {i}", Decimal(10_000_000))
        id_inv = it.get("idInventario")
        if id_inv is not None and (isinstance(id_inv, bool) or not isinstance(id_inv, int)):
            _err(f"Producto {i}: id de inventario inválido.")
        lineas.append({
            "nombre": _texto(it.get("nombre"), f"el nombre del producto {i}", 120),
            "cantidad": cantidad,
            "unitario": unitario,
            "total": _r2(cantidad * unitario),
            "id_inventario": id_inv,
        })

    # Totales: el servidor manda
    t = calcular_totales(lineas, tasa)
    for campo, esperado in (("total_usd", t["total"]), ("total_bs", t["total_bs"])):
        recibido = _positivo(p.get(campo), campo, Decimal(10) ** 12)
        if abs(recibido - esperado) > TOLERANCIA:
            _err("Los totales no coinciden con el cálculo del servidor. Recarga la página e inténtalo de nuevo.")

    # Pago
    metodo = _texto(p.get("metodo_pago"), "el método de pago", 10)
    if metodo not in METODOS:
        _err("Método de pago inválido.")
    banco = referencia = "N/A"
    observaciones = _texto(p.get("observaciones"), "las observaciones", 500, obligatorio=False)
    comprobante = None

    a_pagar = None  # cobro en dólares (solo métodos en USD)
    pagos_combinados = None
    if metodo == "MIXTO":
        pagos_combinados, a_pagar, nota = _validar_mixto(p, t, tasa)
        observaciones = f"{observaciones} | {nota}" if observaciones else nota
    if metodo in METODOS_USD:
        aplicar = p.get("aplicar_descuento")
        if not isinstance(aplicar, bool):
            _err("Falta indicar si se aplica el descuento. Recarga la página e inténtalo de nuevo.")
        if aplicar:
            tasa_usdt = _positivo(p.get("tasa_usdt"), "la tasa USDT", Decimal(1_000_000))
            if tasa_usdt > tasa * MAX_BRECHA_USDT:
                _err("La tasa USDT parece incorrecta. Revísala e inténtalo de nuevo.")
            a_pagar = monto_en_dolares(t, tasa_usdt)
            monto_usd = _positivo(p.get("monto_usd"), "el monto en dólares", Decimal(10) ** 12)
            if abs(monto_usd - a_pagar) > TOLERANCIA:
                _err("El monto en dólares no coincide con el cálculo del servidor. Recarga la página e inténtalo de nuevo.")
            nota = f"Descuento USDT aplicado · Tasa {tasa_usdt:.2f} · Cobro ${a_pagar:.2f} (ahorro ${t['total'] - a_pagar:.2f})"
        else:
            a_pagar = t["total"]  # precio de lista, sin conversión ni descuento
            nota = f"Sin descuento USDT · Cobro ${a_pagar:.2f} a precio de lista"
        observaciones = f"{observaciones} | {nota}" if observaciones else nota

    if metodo == "PM":
        banco = _texto(p.get("banco"), "el banco", 40)
        referencia = _texto(p.get("referencia"), "la referencia", 12)
        if not REFERENCIA_RE.match(referencia):
            _err("La referencia debe tener entre 4 y 12 dígitos.")
        # Pago móvil: no se sube comprobante (si llegara en la petición, se ignora).
    elif metodo in ("ZELLE", "BINANCE"):
        referencia = _texto(p.get("referencia"), "la referencia", 30).upper()
        if not REFERENCIA_DIGITAL_RE.match(referencia):
            _err("La referencia debe tener entre 4 y 30 letras o números.")
        comprobante = _decodificar_comprobante(p.get("comprobante"))
    elif metodo == "OTROS":
        if not observaciones:
            _err("Describe el método de pago en las observaciones.")
    elif metodo in ("ED", "EBS"):
        if p.get("monto_recibido") in (None, ""):
            _err("Ingresa el monto recibido.")
        recibido = _positivo(p.get("monto_recibido"), "el monto recibido", Decimal(10) ** 12)
        total_moneda = a_pagar if metodo == "ED" else t["total_bs"]
        if recibido + TOLERANCIA < total_moneda:
            _err("El monto recibido no cubre el total de la factura.")
        simbolo = "$" if metodo == "ED" else "Bs"
        nota = f"Recibido {simbolo}{recibido:.2f} · Vuelto {simbolo}{max(recibido - total_moneda, Decimal(0)):.2f}"
        observaciones = f"{observaciones} | {nota}" if observaciones else nota

    factura = {
        "id_factura": id_factura, "nombre": nombre, "apellido": apellido, "cedula": cedula,
        "telefono": telefono, "vendedor": vendedor,
        "subtotal_usd": float(t["total"]),  # precio de lista (tasa BCV)
        "total_usd": float(a_pagar if a_pagar is not None else t["total"]),  # lo realmente cobrado en USD
        "subtotal_bs": float(t["total_bs"]), "total_bs": float(t["total_bs"]),
        "tasa_cambio": float(tasa),
        "metodo_pago": metodo, "referencia": referencia, "banco": banco,
        "comprobante_path": None, "observaciones": observaciones, "pagos_combinados": pagos_combinados,
    }
    detalles = [
        {
            "nombre_producto": l["nombre"], "cantidad": _num(l["cantidad"]),
            "precio_unitario": float(l["unitario"]), "precio_total": float(l["total"]),
            "id_inventario": l["id_inventario"],
        }
        for l in lineas
    ]
    return factura, detalles, comprobante


# ── Verificación contra datos del servidor ──────────────────────────────────
def tasa_usdt_usada(p):
    """Tasa USDT que el pago aplica de verdad (None si no hay descuento en dólares).
    Se llama después de validar(): los tipos ya están comprobados."""
    if p.get("aplicar_descuento") is not True:
        return None
    metodo = p.get("metodo_pago")
    pagos = p.get("pagos") if isinstance(p.get("pagos"), list) else []
    en_dolares = metodo in METODOS_USD or (
        metodo == "MIXTO" and any(isinstance(x, dict) and x.get("metodo") in METODOS_USD for x in pagos)
    )
    if not en_dolares:
        return None
    try:
        return Decimal(str(p.get("tasa_usdt")))
    except InvalidOperation:
        return None


def _verificar_precios(detalles, usuario):
    """El vendedor no decide el precio: el de lista sale del inventario según la cantidad (escala detal /
    mayor / gran mayor). Solo admin y sysadmin pueden vender con precios distintos."""
    if c.es_admin(usuario):
        return
    descuento = ref.descuento_max_pct()
    solo_inventario = not ref.env_bool("PERMITIR_SIN_INVENTARIO", True)
    ids = []
    for i, d in enumerate(detalles, 1):
        idinv = d["id_inventario"]
        if idinv is None:
            if solo_inventario:
                _err(f"Producto {i}: solo se pueden facturar productos del inventario.")
            continue
        if not 0 < idinv <= 2_147_483_647:
            _err(f"Producto {i}: id de inventario inválido.")
        ids.append(idinv)
    fichas = ref.catalogo(ids)
    for i, d in enumerate(detalles, 1):
        if d["id_inventario"] is None:
            continue
        ficha = fichas.get(d["id_inventario"])
        if ficha is None:
            _err(f"Producto {i}: ya no existe o está inactivo en el inventario. Quítalo y vuelve a agregarlo.")
        cantidad = Decimal(str(d["cantidad"]))
        minimo = _r2(ref.precio_de_lista(ficha, cantidad) * (Decimal(100) - descuento) / 100)
        if Decimal(str(d["precio_unitario"])) < minimo:
            _err(f"Producto {i} ({d['nombre_producto'][:40]}): el precio ${d['precio_unitario']:.2f} está por debajo "
                 f"del precio de lista (${minimo:.2f}). Solo un administrador puede cambiar precios.")


def _verificar_tasas(p, factura):
    """Las tasas las escribe o corrige el vendedor: se comparan con la fuente de referencia.
    Si la fuente no responde se acepta la enviada (hay ventas que no pueden esperar), pero queda en el log."""
    tol = ref.tolerancia_pct()
    if tol <= 0:
        return
    tasa = Decimal(str(factura["tasa_cambio"]))
    r = ref.tasa_bcv()
    if r is None:
        print("[enviar-factura] sin tasa de referencia BCV: se acepta la enviada", file=sys.stderr)
    elif abs(tasa - r) * 100 / r > tol:
        _err(f"La tasa de cambio ({tasa:.2f}) se aleja demasiado de la tasa de referencia ({r:.2f}). "
             "Actualízala e inténtalo de nuevo.")
    usdt = tasa_usdt_usada(p)
    if usdt is None:
        return
    ru = ref.tasa_usdt()
    if ru is None:
        print("[enviar-factura] sin tasa USDT de referencia: se acepta la enviada", file=sys.stderr)
    elif usdt > ru * (1 + tol / 100):  # una tasa USDT alta = más descuento; una baja no perjudica a la tienda
        _err(f"La tasa USDT ({usdt:.2f}) es demasiado alta frente a la de referencia ({ru:.2f}). "
             "Revísala e inténtalo de nuevo.")


def verificar_servidor(p, factura, detalles, usuario):
    """Contrasta con datos propios del servidor lo que el navegador no debe decidir.
    Modifica `factura` (vendedor) y lanza ErrorPeticion si algo no cuadra."""
    if not ref.env_bool("VENDEDOR_LIBRE", False) and usuario.get("nombre"):
        factura["vendedor"] = str(usuario["nombre"]).strip()[:60] or factura["vendedor"]
    _verificar_precios(detalles, usuario)
    _verificar_tasas(p, factura)


# ── Supabase ────────────────────────────────────────────────────────────────
def _ruta_comprobante(id_factura):
    return f"{id_factura}.jpg"  # id_factura ya pasó ID_RE: solo letras, números y guiones


def _ya_existe(r):
    t = r.text.lower()
    return r.status_code == 409 or "duplicate" in t or "already exists" in t


def _subir_comprobante(id_factura, datos):
    """Sube el comprobante cuando la factura YA está guardada y sin sobrescribir (x-upsert=false).

    · Si el objeto ya existe es un reintento (o un id reutilizado): se conserva el original, nunca se pisa.
    · Si falla, se responde 502 con MSG_COMPROBANTE: al reintentar, la factura sale «duplicada» y solo se
      repite esta subida (el id de la factura se conserva en el navegador entre reintentos).
    """
    try:
        r = c._http.post(
            f"{c.SUPABASE_URL}/storage/v1/object/{BUCKET}/{_ruta_comprobante(id_factura)}",
            data=datos,
            headers=c._hdr_servicio({"Content-Type": "image/jpeg", "x-upsert": "false"}),
            timeout=c.TIMEOUT * 2,
        )
    except requests.RequestException as e:
        print(f"[enviar-factura] storage inalcanzable ({id_factura}): {e!r}", file=sys.stderr)
        _err(MSG_COMPROBANTE, 502)
    if r.status_code in (200, 201):
        return
    if _ya_existe(r):
        print(f"[enviar-factura] comprobante de {id_factura} ya existía: se conserva el original", file=sys.stderr)
        return
    print(f"[enviar-factura] storage {r.status_code} ({id_factura}): {r.text[:300]}", file=sys.stderr)
    _err(MSG_COMPROBANTE, 502)


def _cuerpo_error(r):
    try:
        d = r.json()
    except ValueError:
        return {}
    return d if isinstance(d, dict) else {}


def _guardar(factura, detalles, usuario_id):
    r = c._http.post(
        f"{c.SUPABASE_URL}/rest/v1/rpc/guardar_factura_con_stock",
        json={"p_factura": factura, "p_detalles": detalles, "p_usuario": usuario_id},
        headers=c._hdr_servicio(),
        timeout=c.TIMEOUT,
    )
    if r.status_code in (200, 204):
        return "ok"
    print(f"[enviar-factura] rpc {r.status_code}: {r.text[:500]}", file=sys.stderr)
    stock = re.search(r'stock_insuficiente:([^"\\]+)', r.text)
    if stock:
        _err(f"Stock insuficiente: {stock.group(1).strip()}. Ajusta la cantidad e inténtalo de nuevo.", 409)

    # PostgREST responde 409 tanto a un duplicado (23505) como a una clave foránea rota (23503):
    # solo el duplicado DEL ID DE FACTURA es un reintento ya guardado; lo demás es un error real.
    cuerpo = _cuerpo_error(r)
    codigo = str(cuerpo.get("code") or "")
    texto = " ".join(str(cuerpo.get(k) or "") for k in ("message", "details", "hint"))
    if codigo == "23505":
        if RE_DUPLICADO_FACTURA.search(texto):
            return "duplicada"  # misma id_factura: el envío anterior sí se guardó
        _err("Ya existe un registro con alguno de estos datos. Revisa la factura e inténtalo de nuevo.", 409)
    if codigo == "23503":
        _err("Un producto de la factura ya no existe en el inventario. "
             "Quítalo, vuelve a agregarlo e inténtalo de nuevo.", 409)
    if codigo in ("23502", "23514", "22003", "22P02"):
        _err("Algún dato de la factura no cumple las reglas del sistema. Revísalo e inténtalo de nuevo.", 400)
    _err("No se pudo guardar la factura. Intenta de nuevo o avisa al administrador.", 502)


def _pdf_y_whatsapp(factura, detalles, enviar, presupuesto):
    """Mejor esfuerzo: la factura ya está guardada, nada de esto debe hacerla fallar.
    Cada llamada externa se acota al tiempo que queda (presupuesto); si no queda, se omite y el navegador
    ofrece reintentar. Devuelve (pdf_guardado: bool, estado_whatsapp: str|None)."""
    id_factura = factura["id_factura"]
    try:
        if not enviar:  # reintento de una factura duplicada: solo asegurar que el PDF exista
            t = presupuesto.timeout(c.TIMEOUT * 2)
            if t is None:
                return False, None
            if wa.descargar_pdf(id_factura, timeout=t) is not None:
                return True, None
            t = presupuesto.timeout(c.TIMEOUT * 2)
            return (wa.subir_pdf(id_factura, generar_pdf(factura, detalles), timeout=t) if t else False), None
        pdf = generar_pdf(factura, detalles)
        t = presupuesto.timeout(c.TIMEOUT * 2)
        guardado = wa.subir_pdf(id_factura, pdf, timeout=t) if t else False
        t = presupuesto.timeout(wa.TIMEOUT_BOT[1], minimo=3)
        whatsapp = (wa.enviar_pdf(factura["telefono"], id_factura, pdf, factura["nombre"], timeout=t)
                    if t else wa.NO_DISPONIBLE)
        return guardado, whatsapp
    except Exception as e:  # noqa: BLE001
        print(f"[enviar-factura] pdf/whatsapp: {e!r}", file=sys.stderr)
        return False, wa.NO_DISPONIBLE if enviar else None


def _error(h, status, mensaje):
    c.responder(h, status, {"status": "error", "message": mensaje})


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        presupuesto = _Presupuesto()
        if not c.config_completa():
            return _error(self, 500, "Configuración del servidor incompleta.")
        if not c.origen_valido(self):
            return _error(self, 403, "Origen no permitido.")
        try:
            usuario = c.usuario_sesion(self)
            if not usuario:
                return _error(self, 401, "Sesión expirada. Inicia sesión de nuevo.")
            datos = c.leer_json(self, MAX_BODY)
            factura, detalles, comprobante = validar(datos)
            verificar_servidor(datos, factura, detalles, usuario)
            if comprobante:
                factura["comprobante_path"] = _ruta_comprobante(factura["id_factura"])
            estado = _guardar(factura, detalles, usuario["id"])
            if comprobante:  # después de guardar: un fallo aquí nunca deja un archivo huérfano
                _subir_comprobante(factura["id_factura"], comprobante)
        except c.ErrorPeticion as e:
            return _error(self, e.status, e.mensaje)
        except (requests.RequestException, RuntimeError):
            return _error(self, 503, MSG_NO_DISPONIBLE)

        if estado == "duplicada":
            pdf_ok, _ = _pdf_y_whatsapp(factura, detalles, False, presupuesto)  # no se reenvía por WhatsApp
            return c.responder(self, 409, {
                "status": "duplicada", "message": "Esta factura ya estaba registrada.", "pdf": pdf_ok,
            })
        pdf_ok, whatsapp = _pdf_y_whatsapp(factura, detalles, True, presupuesto)
        return c.responder(
            self, 200,
            {
                "status": "ok", "message": "Factura guardada.", "id_factura": factura["id_factura"],
                "pdf": pdf_ok, "whatsapp": whatsapp,
            },
        )

    do_GET = do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido

    def do_OPTIONS(self):
        # Sin CORS: el frontend y la API viven en el mismo origen.
        self.send_response(204)
        self.end_headers()
