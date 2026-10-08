"""/api/notificaciones

Notificaciones globales: las publica admin/sysadmin y las ven TODOS los usuarios activos.

GET                   -> bandeja del usuario (últimos 90 días) con `leida` por notificación
GET ?modo=contador    -> {no_leidas} (para la campana del inicio)
GET ?modo=publicadas  -> (admin y sysadmin) lo publicado, con cuántos usuarios lo han leído
POST {accion: "crear", categoria, titulo, mensaje}   (admin y sysadmin)
POST {accion: "leer", id}  ·  {accion: "leer_todas"}  (cualquier usuario)
POST {accion: "eliminar", id}                          (admin y sysadmin)

Categorías:
  empresa -> información de la empresa. La publica admin o sysadmin.
  sistema -> cambios en el sistema.     SOLO la publica sysadmin.

Tablas: `notificaciones` y `notificaciones_lecturas` (ver sql/notificaciones.sql).
"""
import os
import sys
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

MAX_BODY = 8 * 1024
DIAS_VISIBLES = 90          # la bandeja muestra lo publicado en este plazo
LIMITE = 100
ANTIDUPLICADO_SEG = 60      # misma publicación del mismo autor dentro de este plazo = doble clic / reintento
CATEGORIAS = ("empresa", "sistema")
SOLO_SYSADMIN = ("sistema",)
COLUMNAS = "id,categoria,titulo,mensaje,creado_por,creado_por_nombre,creado_en"


def _rest(metodo, tabla, extra=None, **kw):
    return c._http.request(metodo, f"{c.SUPABASE_URL}/rest/v1/{tabla}",
                           headers=c._hdr_servicio(extra), timeout=c.TIMEOUT, **kw)


def _fallo(r, tabla):
    print(f"[notificaciones] {tabla} {r.status_code}: {r.text[:300]}", file=sys.stderr)
    raise c.ErrorPeticion(502, "No se pudieron consultar las notificaciones. Inténtalo de nuevo.")


def _es_admin(u):
    return c.es_admin(u)


def _lista(solo_autor=None, dias=None):
    """Notificaciones activas, de la más nueva a la más antigua."""
    params = [("select", COLUMNAS), ("activa", "is.true"), ("order", "creado_en.desc,id.desc"), ("limit", str(LIMITE))]
    if dias:
        desde = (datetime.now(timezone.utc) - timedelta(days=dias)).isoformat()
        params.append(("creado_en", f"gte.{desde}"))
    if solo_autor:
        params.append(("creado_por", f"eq.{solo_autor}"))
    r = _rest("GET", "notificaciones", params=params)
    if r.status_code != 200:
        _fallo(r, "notificaciones")
    return r.json()


def _ids(filas):
    return [int(f["id"]) for f in filas]  # enteros de la base: seguros para armar in.(…)


def _leidas_por(uid, ids):
    if not ids:
        return set()
    r = _rest("GET", "notificaciones_lecturas", params={
        "select": "notificacion_id", "usuario_id": f"eq.{uid}",
        "notificacion_id": f"in.({','.join(map(str, ids))})", "limit": str(LIMITE)})
    if r.status_code != 200:
        _fallo(r, "notificaciones_lecturas")
    return {int(x["notificacion_id"]) for x in r.json()}


def _no_leidas(u):
    filas = _lista(dias=DIAS_VISIBLES)
    leidas = _leidas_por(u["id"], _ids(filas))
    return filas, leidas


def _marcar(uid, ids):
    """Marca como leídas. Idempotente: repetirlo no duplica ni falla (ignore-duplicates)."""
    if not ids:
        return
    r = _rest("POST", "notificaciones_lecturas",
              extra={"Prefer": "resolution=ignore-duplicates,return=minimal"},
              params={"on_conflict": "notificacion_id,usuario_id"},
              json=[{"notificacion_id": i, "usuario_id": uid} for i in ids])
    if r.status_code not in (200, 201, 204):
        _fallo(r, "notificaciones_lecturas")


def _una(i):
    r = _rest("GET", "notificaciones", params={"select": COLUMNAS, "id": f"eq.{i}", "activa": "is.true", "limit": "1"})
    if r.status_code != 200:
        _fallo(r, "notificaciones")
    filas = r.json()
    if not filas:
        raise c.ErrorPeticion(404, "La notificación ya no existe.")
    return filas[0]


def _id(d):
    i = d.get("id")
    if isinstance(i, bool) or not isinstance(i, int) or i < 1:
        raise c.ErrorPeticion(400, "Notificación inválida.")
    return i


def _texto(v, nombre, minimo, maximo):
    s = v.strip() if isinstance(v, str) else ""
    if not minimo <= len(s) <= maximo:
        raise c.ErrorPeticion(400, f"{nombre}: entre {minimo} y {maximo} caracteres.")
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in s):
        raise c.ErrorPeticion(400, f"{nombre}: contiene caracteres no permitidos.")
    return s


# ── Acciones ────────────────────────────────────────────────────────────────
def _crear(d, u):
    if not _es_admin(u):
        raise c.ErrorPeticion(403, "No tienes permiso para publicar notificaciones.")
    categoria = d.get("categoria")
    if categoria not in CATEGORIAS:
        raise c.ErrorPeticion(400, "Categoría inválida.")
    if categoria in SOLO_SYSADMIN and u["rol"] != "sysadmin":
        raise c.ErrorPeticion(403, "Los avisos de cambios del sistema solo los publica el sysadmin.")
    titulo = _texto(d.get("titulo"), "El título", 3, 80)
    mensaje = _texto(d.get("mensaje"), "El mensaje", 3, 1000)

    desde = (datetime.now(timezone.utc) - timedelta(seconds=ANTIDUPLICADO_SEG)).isoformat()
    r = _rest("GET", "notificaciones", params={
        "select": "id", "creado_por": f"eq.{u['id']}", "titulo": f"eq.{titulo}", "mensaje": f"eq.{mensaje}",
        "activa": "is.true", "creado_en": f"gte.{desde}", "limit": "1"})
    if r.status_code != 200:
        _fallo(r, "notificaciones")
    if r.json():
        raise c.ErrorPeticion(409, "Esa notificación ya se publicó hace un momento.")

    r = _rest("POST", "notificaciones", extra={"Prefer": "return=minimal"}, json={
        "categoria": categoria, "titulo": titulo, "mensaje": mensaje,
        "creado_por": u["id"], "creado_por_nombre": u.get("nombre") or u.get("email")})
    if r.status_code not in (200, 201, 204):
        _fallo(r, "notificaciones")


def _leer(d, u):
    i = _id(d)
    _una(i)
    _marcar(u["id"], [i])


def _leer_todas(u):
    filas, leidas = _no_leidas(u)
    _marcar(u["id"], [i for i in _ids(filas) if i not in leidas])


def _eliminar(d, u):
    if not _es_admin(u):
        raise c.ErrorPeticion(403, "No tienes permiso para eliminar notificaciones.")
    fila = _una(_id(d))
    if u["rol"] != "sysadmin" and (fila["creado_por"] != u["id"] or fila["categoria"] in SOLO_SYSADMIN):
        raise c.ErrorPeticion(403, "Solo puedes eliminar los avisos que tú publicaste.")
    r = _rest("PATCH", "notificaciones", extra={"Prefer": "return=minimal"},
              params={"id": f"eq.{fila['id']}"}, json={"activa": False})
    if r.status_code not in (200, 204):
        _fallo(r, "notificaciones")


# ── Lecturas (GET) ──────────────────────────────────────────────────────────
def _bandeja(u):
    filas, leidas = _no_leidas(u)
    return [{
        "id": f["id"], "categoria": f["categoria"], "titulo": f["titulo"], "mensaje": f["mensaje"],
        "autor": f.get("creado_por_nombre") or "Administración", "creado_en": f["creado_en"],
        "leida": int(f["id"]) in leidas,
    } for f in filas]


def _publicadas(u):
    # admin: solo lo suyo · sysadmin: todo
    filas = _lista(solo_autor=None if u["rol"] == "sysadmin" else u["id"])
    ids = _ids(filas)
    conteo = {}
    if ids:
        r = _rest("GET", "notificaciones_lecturas", params={
            "select": "notificacion_id", "notificacion_id": f"in.({','.join(map(str, ids))})", "limit": "20000"})
        if r.status_code != 200:
            _fallo(r, "notificaciones_lecturas")
        for x in r.json():
            conteo[int(x["notificacion_id"])] = conteo.get(int(x["notificacion_id"]), 0) + 1
    r = _rest("GET", "perfiles", extra={"Prefer": "count=exact"},
              params={"select": "id", "activo": "is.true", "limit": "1"})
    total = r.headers.get("Content-Range", "*/0").split("/")[-1] if r.status_code in (200, 206) else "0"
    return [{
        "id": f["id"], "categoria": f["categoria"], "titulo": f["titulo"], "mensaje": f["mensaje"],
        "autor": f.get("creado_por_nombre") or "Administración", "creado_en": f["creado_en"],
        "lecturas": conteo.get(int(f["id"]), 0),
    } for f in filas], int(total) if total.isdigit() else 0


def _entrada(h, escribe=False):
    if not c.config_completa():
        raise c.ErrorPeticion(500, "Configuración del servidor incompleta.")
    if escribe and not c.origen_valido(h):
        raise c.ErrorPeticion(403, "Origen no permitido.")
    u = c.usuario_sesion(h)
    if not u:
        raise c.ErrorPeticion(401, "Sesión expirada. Inicia sesión de nuevo.")
    return u


class handler(BaseHTTPRequestHandler):
    def _ok(self, **extra):
        c.responder(self, 200, {"status": "ok", **extra})

    def _error(self, e):
        c.responder(self, e.status, {"status": "error", "message": e.mensaje})

    def _caido(self, metodo, e):
        print(f"[notificaciones] {metodo} {e}", file=sys.stderr)
        c.responder(self, 503, {"status": "error", "message": "Servicio no disponible. Inténtalo de nuevo."})

    def do_GET(self):
        try:
            u = _entrada(self)
            modo = (parse_qs(urlparse(self.path).query).get("modo", [""])[0] or "").strip()
            if modo == "contador":
                filas, leidas = _no_leidas(u)
                return self._ok(no_leidas=sum(1 for i in _ids(filas) if i not in leidas))
            if modo == "publicadas":
                if not _es_admin(u):
                    raise c.ErrorPeticion(403, "No tienes permiso para esta sección.")
                filas, total = _publicadas(u)
                return self._ok(data=filas, total_usuarios=total)
            if modo:
                raise c.ErrorPeticion(400, "Modo no válido.")
            self._ok(data=_bandeja(u), puede_publicar=_es_admin(u), es_sysadmin=u["rol"] == "sysadmin")
        except c.ErrorPeticion as e:
            self._error(e)
        except (requests.RequestException, RuntimeError) as e:
            self._caido("GET", e)

    def do_POST(self):
        try:
            u = _entrada(self, escribe=True)
            d = c.leer_json(self, MAX_BODY)
            accion = d.get("accion")
            if accion == "crear":
                _crear(d, u)
                self._ok(message="Notificación publicada para todo el personal.")
            elif accion == "leer":
                _leer(d, u)
                self._ok()
            elif accion == "leer_todas":
                _leer_todas(u)
                self._ok()
            elif accion == "eliminar":
                _eliminar(d, u)
                self._ok(message="Notificación eliminada.")
            else:
                raise c.ErrorPeticion(400, "Acción no válida.")
        except c.ErrorPeticion as e:
            self._error(e)
        except (requests.RequestException, RuntimeError) as e:
            self._caido("POST", e)

    do_PUT = do_PATCH = do_DELETE = c.metodo_no_permitido
