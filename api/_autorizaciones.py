"""Autorizaciones con código de un solo uso (módulo auxiliar: el prefijo «_» evita que Vercel lo cuente como función).

Lo exponen /api/notificaciones (solicitar, aprobar, rechazar, cancelar y consultar) y lo consumen
/api/historial (anular factura) e /api/inventario (salida y ajuste), que lo piden solo a quien no es admin.

Flujo:
  1. SOLICITAR  Un usuario que NO tiene el permiso pide autorizar UNA operación concreta, con un motivo.
  2. APROBAR    Un admin la aprueba: se genera un código de 6 dígitos que solo se le muestra a él, una vez.
  3. USAR       El solicitante envía {autorizacion: {id, codigo}} junto con la operación; `exigir()` lo valida
                y lo consume en la misma petición.

Seguridad:
  · El código vale solo para esa acción, ese objetivo (factura o producto), esos datos (cantidad, sentido)
    y ese solicitante. Se compara contra lo guardado en la solicitud, no contra lo que diga el navegador.
  · Un solo uso (actualización condicional `usada_en is null`), caduca a los 10 min y se bloquea a los 3 intentos.
  · En la base solo queda un HMAC-SHA256 del código (clave AUTORIZACION_SECRET); se compara con hmac.compare_digest.
  · Auditoría: quién pidió, quién autorizó y cuándo quedan en `autorizaciones`; además el aval se anota en el
    motivo de la anulación y del movimiento de inventario (kardex).
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

TABLA = "autorizaciones"
VIGENCIA_MIN = 10          # minutos que vale el código desde que se genera
SOLICITUD_HORAS = 24       # una solicitud sin atender deja de mostrarse pasado este plazo
MAX_ABIERTAS = 5           # solicitudes abiertas por usuario (evita llenar la bandeja del admin)
LIMITE_LISTA = 50

ACCIONES = {"anular_factura": "Anular factura", "salida": "Registrar salida", "ajuste": "Ajustar stock"}
ID_FACTURA_RE = re.compile(r"^[A-Za-z0-9\-]{1,64}$")
CODIGO_RE = re.compile(r"^\d{6}$")

# Clave del HMAC. Lo recomendable es una variable propia; si no existe se deriva de la clave de servicio
# (que ya es secreta y solo vive en el servidor), para no romper el despliegue.
_SECRETO = (os.environ.get("AUTORIZACION_SECRET") or c.SUPABASE_SECRET_KEY or "").encode("utf-8")

_MSG_USO = {
    "invalida": "Esta autorización no corresponde a esta operación. Solicita una nueva.",
    "usada": "Este código ya se usó. Solicita una nueva autorización.",
    "no_aprobada": "La solicitud todavía no ha sido aprobada por un administrador.",
    "vencida": "El código venció. Solicita una nueva autorización.",
    "bloqueada": "Código bloqueado por demasiados intentos. Solicita una nueva autorización.",
}


# ── Utilidades ──────────────────────────────────────────────────────────────
def _ahora():
    return datetime.now(timezone.utc)


def _rest(metodo, extra=None, **kw):
    return c._http.request(metodo, f"{c.SUPABASE_URL}/rest/v1/{kw.pop('ruta', TABLA)}",
                           headers=c._hdr_servicio(extra), timeout=c.TIMEOUT, **kw)


def _fallo(r, donde):
    print(f"[autorizaciones] {donde} {r.status_code}: {r.text[:300]}", file=sys.stderr)
    raise c.ErrorPeticion(502, "No se pudo procesar la autorización. Inténtalo de nuevo.")


def _hash(id_aut, codigo):
    return hmac.new(_SECRETO, f"{id_aut}:{codigo}".encode("utf-8"), hashlib.sha256).hexdigest()


def _id(v):
    if isinstance(v, bool) or not isinstance(v, int) or v < 1:
        raise c.ErrorPeticion(400, "Autorización inválida.")
    return v


def _nombre(u):
    return (u.get("nombre") or u.get("email") or "Usuario")[:80]


def _vigente(f):
    """Estado que ve el cliente: una aprobación vencida se muestra como «vencida» aunque siga «aprobada» en la base."""
    if f["estado"] == "aprobada" and f.get("expira_en") and datetime.fromisoformat(f["expira_en"]) <= _ahora():
        return "vencida"
    return f["estado"]


def _limite_solicitud():
    return (_ahora() - timedelta(hours=SOLICITUD_HORAS)).isoformat()


def con_aval(motivo, aprobador, maximo=300):
    """Anota «Autorizado por X» en el motivo sin pasarse del largo permitido (factura y kardex lo guardan)."""
    cola = f" · Autorizado por {(aprobador or 'administración')[:40]}"
    return motivo[: maximo - len(cola)].rstrip() + cola


# ── Descripción de la operación (la arma el SERVIDOR con datos de la base) ──
def _entero(v, nombre, minimo, maximo):
    if isinstance(v, bool) or not isinstance(v, (int, str)):
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    try:
        n = int(v)
    except ValueError:
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.") from None
    if not minimo <= n <= maximo:
        raise c.ErrorPeticion(400, f"Valor inválido en {nombre}.")
    return n


def _describir(accion, d):
    """Devuelve (objetivo, detalle, resumen). Rechaza lo que no existe para no abrir solicitudes inútiles."""
    if accion == "anular_factura":
        objetivo = str(d.get("objetivo") or "")
        if not ID_FACTURA_RE.match(objetivo):
            raise c.ErrorPeticion(400, "Id de factura inválido.")
        r = _rest("GET", ruta="facturas", params={
            "select": "id_factura,nombre,apellido,total_usd,estado", "id_factura": f"eq.{objetivo}", "limit": "1"})
        if r.status_code != 200:
            _fallo(r, "factura")
        if not r.json():
            raise c.ErrorPeticion(404, "La factura no existe.")
        f = r.json()[0]
        if f.get("estado") == "anulada":
            raise c.ErrorPeticion(409, "Esta factura ya estaba anulada.")
        cliente = " ".join(x for x in (f.get("nombre"), f.get("apellido")) if x) or "Sin nombre"
        return objetivo, {}, f"Anular la factura {objetivo} · {cliente} · ${float(f.get('total_usd') or 0):,.2f}"

    if accion in ("salida", "ajuste"):
        variante = _entero(d.get("objetivo"), "el producto", 1, 10**9)
        det = d.get("detalle") if isinstance(d.get("detalle"), dict) else {}
        cantidad = _entero(det.get("cantidad"), "la cantidad", 1, 100_000)
        sentido = "salida"
        if accion == "ajuste":
            sentido = det.get("sentido")
            if sentido not in ("entrada", "salida"):
                raise c.ErrorPeticion(400, "Indica si el ajuste es de entrada o de salida.")
        r = _rest("GET", ruta="inv_catalogo", params={
            "select": "id,nombre,color,talla,cantidad", "id": f"eq.{variante}", "activo": "is.true", "limit": "1"})
        if r.status_code != 200:
            _fallo(r, "producto")
        if not r.json():
            raise c.ErrorPeticion(404, "El producto no existe o está inactivo.")
        p = r.json()[0]
        nombre = " - ".join(x for x in (p.get("nombre"), p.get("color"), p.get("talla")) if x)
        verbo = "Salida" if accion == "salida" else f"Ajuste de {sentido}"
        return str(variante), {"cantidad": cantidad, "sentido": sentido}, \
            f"{verbo} de {cantidad} × {nombre} (stock actual: {p.get('cantidad')})"

    raise c.ErrorPeticion(400, "Acción no válida.")


# ── Acciones del solicitante ────────────────────────────────────────────────
def solicitar(u, d):
    """Abre (o reutiliza) una solicitud. Devuelve {id}. Los admin no la necesitan: ya tienen el permiso."""
    if c.es_admin(u):
        raise c.ErrorPeticion(403, "Tu rol ya puede hacer esta acción sin autorización.")
    accion = d.get("accion_autorizar")
    if accion not in ACCIONES:
        raise c.ErrorPeticion(400, "Acción no válida.")
    motivo = re.sub(r"\s+", " ", str(d.get("motivo") or "")).strip()
    if not 3 <= len(motivo) <= 300:
        raise c.ErrorPeticion(400, "Escribe el motivo (entre 3 y 300 caracteres).")
    objetivo, detalle, resumen = _describir(accion, d)

    r = _rest("GET", params={
        "select": "id,accion,objetivo,detalle,estado,expira_en,creada_en", "solicitante_id": f"eq.{u['id']}",
        "estado": "in.(pendiente,aprobada)", "creada_en": f"gte.{_limite_solicitud()}", "limit": "50"})
    if r.status_code != 200:
        _fallo(r, "abiertas")
    abiertas = [f for f in r.json() if _vigente(f) in ("pendiente", "aprobada")]
    for f in abiertas:
        if f["accion"] == accion and f["objetivo"] == objetivo and f["detalle"] == detalle:
            return {"id": f["id"], "reutilizada": True}   # doble clic o reintento: no se duplica
    if len(abiertas) >= MAX_ABIERTAS:
        raise c.ErrorPeticion(429, "Ya tienes varias solicitudes abiertas. Espera a que las atiendan o cancélalas.")

    r = _rest("POST", extra={"Prefer": "return=representation"}, json={
        "accion": accion, "objetivo": objetivo, "detalle": detalle, "resumen": resumen, "motivo": motivo,
        "solicitante_id": u["id"], "solicitante_nombre": _nombre(u)})
    if r.status_code not in (200, 201) or not r.json():
        _fallo(r, "crear")
    return {"id": r.json()[0]["id"], "reutilizada": False}


def cancelar(u, d):
    i = _id(d.get("id"))
    r = _rest("PATCH", extra={"Prefer": "return=representation"}, json={"estado": "cancelada"},
              params={"id": f"eq.{i}", "solicitante_id": f"eq.{u['id']}", "estado": "in.(pendiente,aprobada)"})
    if r.status_code != 200:
        _fallo(r, "cancelar")
    if not r.json():
        raise c.ErrorPeticion(409, "Esta solicitud ya no se puede cancelar.")


def estado(u, i):
    """Estado de UNA solicitud. El solicitante solo ve las suyas; el código nunca sale por aquí."""
    r = _rest("GET", params={
        "select": "id,accion,resumen,estado,expira_en,resuelta_por_nombre,solicitante_id,intentos",
        "id": f"eq.{_id(i)}", "limit": "1"})
    if r.status_code != 200:
        _fallo(r, "estado")
    if not r.json() or (r.json()[0]["solicitante_id"] != u["id"] and not c.es_admin(u)):
        raise c.ErrorPeticion(404, "La solicitud no existe.")
    f = r.json()[0]
    return {"id": f["id"], "estado": _vigente(f), "resumen": f["resumen"], "expira_en": f["expira_en"],
            "autorizado_por": f["resuelta_por_nombre"], "intentos_restantes": max(0, 3 - (f["intentos"] or 0))}


# ── Acciones del admin ──────────────────────────────────────────────────────
def _solo_admin(u):
    if not c.es_admin(u):
        raise c.ErrorPeticion(403, "Solo un administrador puede gestionar autorizaciones.")


def aprobar(u, d):
    """Genera el código (solo se devuelve aquí). Si el admin lo perdió, puede generar otro: el anterior deja de servir."""
    _solo_admin(u)
    i = _id(d.get("id"))
    codigo = f"{secrets.randbelow(10**6):06d}"
    ahora = _ahora()
    expira = ahora + timedelta(minutes=VIGENCIA_MIN)
    r = _rest("PATCH", extra={"Prefer": "return=representation"}, json={
        "estado": "aprobada", "codigo_hash": _hash(i, codigo), "intentos": 0,
        "resuelta_por": u["id"], "resuelta_por_nombre": _nombre(u), "resuelta_en": ahora.isoformat(),
        "expira_en": expira.isoformat()},
        params={"id": f"eq.{i}", "estado": "in.(pendiente,aprobada)", "usada_en": "is.null",
                "creada_en": f"gte.{_limite_solicitud()}"})
    if r.status_code != 200:
        _fallo(r, "aprobar")
    if not r.json():
        raise c.ErrorPeticion(409, "Esta solicitud ya fue atendida o venció.")
    f = r.json()[0]
    return {"codigo": codigo, "expira_en": f["expira_en"], "resumen": f["resumen"],
            "solicitante": f["solicitante_nombre"], "vigencia_min": VIGENCIA_MIN}


def rechazar(u, d):
    _solo_admin(u)
    i = _id(d.get("id"))
    r = _rest("PATCH", extra={"Prefer": "return=representation"}, json={
        "estado": "rechazada", "codigo_hash": None, "resuelta_por": u["id"],
        "resuelta_por_nombre": _nombre(u), "resuelta_en": _ahora().isoformat()},
        params={"id": f"eq.{i}", "estado": "in.(pendiente,aprobada)", "usada_en": "is.null"})
    if r.status_code != 200:
        _fallo(r, "rechazar")
    if not r.json():
        raise c.ErrorPeticion(409, "Esta solicitud ya fue atendida.")


def listar(u):
    """Para el admin: lo que espera respuesta (pendientes y aprobadas vigentes) y los últimos movimientos."""
    _solo_admin(u)
    cols = ("id,accion,resumen,motivo,solicitante_nombre,estado,creada_en,resuelta_por_nombre,resuelta_en,"
            "expira_en,usada_en")
    r = _rest("GET", params={"select": cols, "order": "creada_en.desc", "limit": str(LIMITE_LISTA),
                             "creada_en": f"gte.{(_ahora() - timedelta(days=30)).isoformat()}"})
    if r.status_code != 200:
        _fallo(r, "listar")
    pendientes, recientes = [], []
    limite = datetime.fromisoformat(_limite_solicitud())
    for f in r.json():
        f["estado"] = _vigente(f)
        f["accion_nombre"] = ACCIONES.get(f["accion"], f["accion"])
        if f["estado"] == "pendiente" and datetime.fromisoformat(f["creada_en"]) >= limite:
            pendientes.append(f)
        elif f["estado"] == "aprobada":
            pendientes.append(f)        # aprobada y vigente: el admin puede generar otro código si lo perdió
        else:
            recientes.append(f)
    pendientes.sort(key=lambda f: f["creada_en"])        # la más antigua primero
    return pendientes, recientes


def contar_pendientes():
    r = _rest("GET", extra={"Prefer": "count=exact"}, params={
        "select": "id", "estado": "eq.pendiente", "creada_en": f"gte.{_limite_solicitud()}", "limit": "1"})
    if r.status_code not in (200, 206):
        return 0
    total = r.headers.get("Content-Range", "*/0").split("/")[-1]
    return int(total) if total.isdigit() else 0


# ── Uso: lo llaman historial.py e inventario.py ─────────────────────────────
def exigir(u, aut, accion, objetivo, detalle):
    """Autoriza la operación. Devuelve None si el usuario es admin (no necesita nada) o el nombre de quien
    autorizó si trae un código válido; en cualquier otro caso lanza ErrorPeticion.

    Llamar DESPUÉS de validar los datos de la operación y ANTES de ejecutarla: el código se consume aquí,
    así que dos envíos simultáneos nunca pueden ejecutar la operación dos veces.
    """
    if c.es_admin(u):
        return None
    if not isinstance(aut, dict):
        raise c.ErrorPeticion(403, "No tienes permiso para esta acción. Solicita autorización a un administrador.")
    i = _id(aut.get("id"))
    codigo = str(aut.get("codigo") or "").strip()
    if not CODIGO_RE.match(codigo):
        raise c.ErrorPeticion(400, "El código son 6 dígitos.")

    # 1) Comprobar que la solicitud corresponde a ESTA operación y reservar un intento (atómico en SQL).
    r = c._http.post(f"{c.SUPABASE_URL}/rest/v1/rpc/autorizacion_intento", headers=c._hdr_servicio(),
                     timeout=c.TIMEOUT, data=json.dumps({
                         "p_id": i, "p_usuario": u["id"], "p_accion": accion,
                         "p_objetivo": str(objetivo), "p_detalle": detalle}))
    if r.status_code != 200:
        _fallo(r, "intento")
    res = r.json()
    if res.get("resultado") != "ok":
        raise c.ErrorPeticion(403, _MSG_USO.get(res.get("resultado"), _MSG_USO["invalida"]))

    # 2) Comparar en tiempo constante.
    if not hmac.compare_digest(str(res["hash"]), _hash(i, codigo)):
        quedan = max(0, 3 - int(res.get("intentos") or 3))
        raise c.ErrorPeticion(403, "Código incorrecto. " + (
            f"Te quedan {quedan} intento{'s' if quedan != 1 else ''}." if quedan else
            "Se bloqueó: solicita una nueva autorización."))

    # 3) Consumirlo: la actualización condicional solo la gana UNA petición.
    r = _rest("PATCH", extra={"Prefer": "return=representation"},
              json={"estado": "usada", "usada_en": _ahora().isoformat()},
              params={"id": f"eq.{i}", "estado": "eq.aprobada", "usada_en": "is.null",
                      "expira_en": f"gt.{_ahora().isoformat()}"})
    if r.status_code != 200:
        _fallo(r, "consumir")
    if not r.json():
        raise c.ErrorPeticion(403, _MSG_USO["usada"])
    return res.get("aprobador") or "administración"
