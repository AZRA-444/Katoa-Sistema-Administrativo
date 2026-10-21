"""/api/administrador  (solo admin y sysadmin)

GET  ?mes=AAAA-MM -> {ventas, egresos, costo_ventas, categorias, metodos, opciones}
GET  ?modo=egr_pdf&id=N                          -> comprobante de egreso en PDF (ver api/_egresos.py)
GET  ?modo=dev_lista | dev_buscar | dev_factura  -> devoluciones de productos (ver api/_devoluciones.py)
GET  ?modo=com_resumen&mes=AAAA-MM               -> comisiones de vendedores (ver api/_comisiones.py)
GET  ?modo=usr_lista                             -> usuarios y roles que se pueden asignar (ver api/_usuarios.py)
POST {accion: "egreso_crear" | "egreso_eliminar" | "egreso_opcion_crear" | "egreso_opcion_quitar"
              | "egreso_comprobante_enviar" | "devolucion_registrar" | "com_config" | "com_pagar"
              | "usuario_crear" | "usuario_estado" | "usuario_rol" | "usuario_clave", ...}

Ventas: tabla `facturas` (columna de fecha `created_at`). «Venta» = total_usd, lo cobrado con el descuento por pago en
divisas: la definición vive en api/_ventas.py y es la misma de Reportes y Comisiones. Cada venta trae además `lista_usd`
(a precio de lista) para mostrar el descuento. Costo de ventas: `inv_kardex` (SALIDA_VENTA - DEVOLUCION_CLIENTE).
Egresos: tabla `egresos` (ver sql/egresos.sql). «Eliminar» es BORRADO LÓGICO (sql/egresos_borrado_logico.sql): la fila
queda con quién y cuándo la eliminó y deja de contarse. Las fechas del mes se calculan en hora de Venezuela (UTC-4).
"""
import os
import re
import sys
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comisiones as com  # noqa: E402
import _comun as c  # noqa: E402
import _devoluciones as dev  # noqa: E402
import _egresos as egr  # noqa: E402
import _usuarios as usr  # noqa: E402
import _ventas as ventas_def  # noqa: E402

MAX_BODY = 32 * 1024     # las devoluciones pueden traer hasta 150 líneas
PAGINA = 1000           # filas por consulta a Supabase
MAX_VENTAS = 20000      # tope de facturas por mes; más que eso falla en vez de dar totales parciales
MAX_FILAS = 20000
MES_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
FECHA_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CATEGORIAS = egr.CATEGORIAS_BASE   # de fábrica; las personalizadas salen de `egreso_opciones` (api/_egresos.py)
COL_FECHA = "created_at"   # columna de fecha de `facturas` (la misma que usan Historial y Reportes)
COLS_VENTA = ("id_factura,nombre,apellido,cedula,vendedor,subtotal_usd,total_usd,metodo_pago,pagos_combinados,"
              f"estado,{COL_FECHA}")


def _get(tabla, params):
    return c._http.get(f"{c.SUPABASE_URL}/rest/v1/{tabla}", params=params, headers=c._hdr_servicio(), timeout=c.TIMEOUT)


def _fallo(r, tabla):
    print(f"[administrador] {tabla} {r.status_code}: {r.text[:300]}", file=sys.stderr)
    raise c.ErrorPeticion(502, "No se pudieron consultar los datos. Inténtalo de nuevo.")


def _rango(mes):
    y, m = int(mes[:4]), int(mes[5:])
    return date(y, m, 1), date(y + (m == 12), m % 12 + 1, 1)


def _ini_fin(mes):
    if not MES_RE.match(mes or ""):
        raise c.ErrorPeticion(400, "Mes inválido.")
    return _rango(mes)


def _todas(tabla, params, tope, que):
    """Todas las filas, de 1000 en 1000. Si pasan de `tope` falla: un total parcial (ventas, costo, comisiones) engaña."""
    filas = []
    while True:
        r = _get(tabla, [*params, ("limit", str(PAGINA)), ("offset", str(len(filas)))])
        if r.status_code != 200:
            _fallo(r, tabla)
        lote = r.json()
        filas.extend(lote)
        if len(lote) < PAGINA:
            return filas
        if len(filas) >= tope:
            raise c.ErrorPeticion(400, f"Hay demasiados {que} en el mes (más de {tope:,}).".replace(",", "."))


def _ventas(ini, fin):
    """Facturas del mes que cuentan como venta (no anuladas), con la definición de api/_ventas.py."""
    filas = _todas("facturas", [("select", COLS_VENTA), ("order", f"{COL_FECHA}.desc,id_factura.desc"), ventas_def.FILTRO_VENTA,
                                (COL_FECHA, f"gte.{ini}T00:00:00-04:00"), (COL_FECHA, f"lt.{fin}T00:00:00-04:00")],
                   MAX_VENTAS, "facturas")
    salida = []
    for f in filas:
        if not ventas_def.es_venta(f):
            continue
        salida.append({
            "id_factura": f.get("id_factura"), "nombre": f.get("nombre"), "apellido": f.get("apellido"),
            "cedula": f.get("cedula"), "vendedor": f.get("vendedor") or "Sin vendedor",
            "total_usd": float(ventas_def.venta_usd(f)),        # VENTA: lo cobrado, con descuento por divisas
            "lista_usd": float(ventas_def.lista_usd(f)),        # el mismo pedido a precio de lista
            "metodo_pago": f.get("metodo_pago"), "pagos_combinados": f.get("pagos_combinados"), "fecha": f.get(COL_FECHA),
        })
    return salida


def _costo_ventas(ini, fin):
    """Costo de la mercancía vendida según el kardex. None si no se puede calcular (o si el mes no cabe completo)."""
    try:
        filas = _todas("inv_kardex", [("select", "tipo,cantidad,costo_unitario"), ("order", "id.asc"),
                                      ("tipo", "in.(SALIDA_VENTA,DEVOLUCION_CLIENTE)"),
                                      ("creado_en", f"gte.{ini}T00:00:00-04:00"), ("creado_en", f"lt.{fin}T00:00:00-04:00")],
                       MAX_FILAS, "movimientos")
        total = 0.0
        for f in filas:
            v = abs(float(f.get("cantidad") or 0)) * float(f.get("costo_unitario") or 0)
            total += v if f.get("tipo") == "SALIDA_VENTA" else -v
        return round(total, 2)
    except (c.ErrorPeticion, requests.RequestException, ValueError):
        return None


def _egresos(ini, fin):
    return _todas("egresos", [("select", egr.COLS_EGRESO), ("order", "fecha.desc,id.desc"),
                              ("eliminado_en", "is.null"), ("fecha", f"gte.{ini}"), ("fecha", f"lt.{fin}")], MAX_FILAS, "egresos")


def _texto(v, nombre, minimo, maximo):
    s = v.strip() if isinstance(v, str) else ""
    if not minimo <= len(s) <= maximo:
        raise c.ErrorPeticion(400, f"{nombre}: entre {minimo} y {maximo} caracteres.")
    return s


def _crear(d, u):
    """Valida y guarda el egreso (categoría y método pueden ser personalizados). Devuelve la fila guardada."""
    return egr.crear(d, u)


def _eliminar(d, u):
    """Borrado LÓGICO: marca el egreso con quién y cuándo lo eliminó (y el motivo, si lo hay). No se pierde la fila."""
    i = d.get("id")
    if isinstance(i, bool) or not isinstance(i, int) or i < 1:
        raise c.ErrorPeticion(400, "Egreso inválido.")
    motivo = " ".join(str(d.get("motivo") or "").split())[:200] or None
    # El egreso de una comisión pagada está enlazado a su pago: borrarlo dejaría el pago sin egreso.
    r = _get("comisiones_pagos", [("select", "id"), ("egreso_id", f"eq.{i}"), ("limit", "1")])
    if r.status_code != 200:
        _fallo(r, "comisiones_pagos")
    if r.json():
        raise c.ErrorPeticion(409, "Este egreso es el pago de una comisión y no se puede eliminar.")
    r = c._http.patch(f"{c.SUPABASE_URL}/rest/v1/egresos", params={"id": f"eq.{i}", "eliminado_en": "is.null"},
                      json={"eliminado_en": datetime.now(timezone.utc).isoformat(), "eliminado_por": u["id"],
                            "motivo_eliminacion": motivo},
                      headers=c._hdr_servicio({"Prefer": "return=representation"}), timeout=c.TIMEOUT)
    if r.status_code != 200:
        _fallo(r, "egresos")
    if not r.json():
        raise c.ErrorPeticion(404, "El egreso no existe o ya estaba eliminado.")
    print(f"[administrador] {u['email']} eliminó el egreso {i}", file=sys.stderr)


def _entrada(h, escribe=False):
    if not c.config_completa():
        raise c.ErrorPeticion(500, "Configuración del servidor incompleta.")
    if escribe and not c.origen_valido(h):
        raise c.ErrorPeticion(403, "Origen no permitido.")
    u = c.usuario_sesion(h)
    if not u:
        raise c.ErrorPeticion(401, "Sesión expirada. Inicia sesión de nuevo.")
    if not c.es_admin(u):
        raise c.ErrorPeticion(403, "No tienes permiso para esta sección.")
    return u


class handler(BaseHTTPRequestHandler):
    def log_message(self, *args):   # sin log por petición: la URL lleva cédulas y búsquedas de clientes
        pass

    def _ok(self, **extra):
        c.responder(self, 200, {"status": "ok", **extra})

    def _error(self, e):
        c.responder(self, e.status, {"status": "error", "message": e.mensaje})

    def _pdf_egreso(self, qs):
        """Comprobante de egreso: se abre en otra pestaña para verlo e imprimirlo (misma sesión por cookie)."""
        try:
            i = int((qs.get("id", [""])[0] or "").strip())
        except ValueError:
            raise c.ErrorPeticion(400, "Egreso inválido.") from None
        doc, num = egr.pdf(i)
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(doc)))
        self.send_header("Content-Disposition", f'inline; filename="Comprobante-de-egreso-{num}.pdf"')
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(doc)

    def do_GET(self):
        try:
            u = _entrada(self)
            qs = parse_qs(urlparse(self.path).query)
            if (qs.get("modo", [""])[0] or "") == "egr_pdf":
                return self._pdf_egreso(qs)
            if (qs.get("modo", [""])[0] or "").startswith("usr_"):
                return self._ok(**usr.leer(u))
            if (qs.get("modo", [""])[0] or "").startswith("com_"):
                return self._ok(**com.leer(qs, _ini_fin, _ventas))
            if qs.get("modo"):
                return self._ok(**dev.leer(qs))
            mes = (qs.get("mes", [""])[0] or "").strip()
            if not MES_RE.match(mes):
                raise c.ErrorPeticion(400, "Mes inválido.")
            ini, fin = _rango(mes)
            op = egr.opciones()
            self._ok(ventas=_ventas(ini, fin), egresos=_egresos(ini, fin), costo_ventas=_costo_ventas(ini, fin),
                     categorias=op["categorias"], metodos=op["metodos"], opciones=op["detalle"])
        except c.ErrorPeticion as e:
            self._error(e)
        except (requests.RequestException, RuntimeError) as e:
            print(f"[administrador] GET {e}", file=sys.stderr)
            c.responder(self, 503, {"status": "error", "message": "Servicio no disponible. Inténtalo de nuevo."})

    def do_POST(self):
        try:
            u = _entrada(self, escribe=True)
            d = c.leer_json(self, MAX_BODY)
            if d.get("accion") == "egreso_crear":
                fila = _crear(d, u)
                estado = None   # el egreso YA está guardado: un fallo del WhatsApp no lo deshace, solo se informa
                if d.get("enviar_whatsapp"):
                    estado = egr.enviar_comprobante(fila["id"], fila["beneficiario_telefono"])
                self._ok(id=fila["id"], whatsapp=estado, message="Egreso registrado.")
            elif d.get("accion") == "egreso_comprobante_enviar":
                self._ok(whatsapp=egr.enviar_comprobante(d.get("id"), d.get("telefono")))
            elif d.get("accion") == "egreso_opcion_crear":
                self._ok(id=egr.crear_opcion(d, u), message="Opción agregada.")
            elif d.get("accion") == "egreso_opcion_quitar":
                egr.quitar_opcion(d, u)
                self._ok(message="Opción quitada. Los egresos ya registrados no cambian.")
            elif d.get("accion") == "egreso_eliminar":
                _eliminar(d, u)
                self._ok(message="Egreso eliminado.")
            elif d.get("accion") == "com_config":
                com.configurar(d, u)
                self._ok(message="Porcentaje guardado.")
            elif d.get("accion") == "com_pagar":
                com.pagar(d, u, _ini_fin, _ventas)
                self._ok(message="Pago de comisión registrado y egreso creado.")
            elif d.get("accion") == "usuario_crear":
                self._ok(usuario=usr.crear(d, u), message="Usuario registrado.")
            elif d.get("accion") in ("usuario_estado", "usuario_rol", "usuario_clave"):
                resultado, msg = usr.gestionar(d, u)
                self._ok(usuario=resultado, message=msg)
            elif d.get("accion") == "devolucion_registrar":
                resultado, ajuste = dev.registrar(d, u)
                msg = "Devolución registrada."
                if ajuste and ajuste.get("fallo"):  # era a crédito y la deuda NO se pudo ajustar: que se sepa
                    msg += (" ⚠ La factura es a crédito y no se pudo bajar la deuda automáticamente: "
                            "revisa la cuenta en Cobros y ajústala antes de cobrar.")
                elif ajuste:  # la factura era a crédito: la deuda bajó en Cobros
                    msg += f" Factura a crédito: la deuda bajó y el saldo pendiente es ${float(ajuste.get('saldo_usd') or 0):.2f}."
                    if float(ajuste.get("reembolsar_usd") or 0) > 0:
                        msg += (f" El cliente ya había abonado de más: devuélvele ${float(ajuste['reembolsar_usd']):.2f} "
                                "(no se registra automáticamente).")
                self._ok(id=resultado, message=msg)
            else:
                raise c.ErrorPeticion(400, "Acción no válida.")
        except c.ErrorPeticion as e:
            self._error(e)
        except (requests.RequestException, RuntimeError) as e:
            print(f"[administrador] POST {e}", file=sys.stderr)
            c.responder(self, 503, {"status": "error", "message": "Servicio no disponible. Inténtalo de nuevo."})

    do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido
