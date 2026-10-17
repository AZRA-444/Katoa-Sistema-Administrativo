"""Utilidades compartidas por las funciones serverless de autenticación.

El prefijo "_" hace que Vercel NO exponga este archivo como endpoint.
"""
import base64
import hashlib
import json
import os
import random
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ── Configuración (variables de entorno en Vercel) ──────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
SUPABASE_SECRET_KEY = os.environ.get("SUPABASE_SECRET_KEY", "")
# Opcional: si no se define, se acepta el mismo host de la petición.
FRONTEND_DOMAIN = os.environ.get("FRONTEND_DOMAIN", "").rstrip("/")
# Poner COOKIE_SECURE=false SOLO en desarrollo local sin https.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "true").lower() != "false"

COOKIE_ACCESS = "kt_access"
COOKIE_REFRESH = "kt_refresh"
COOKIE_PATH = "/api"
REFRESH_MAX_AGE = 60 * 60 * 24 * 7  # 7 días

# Protección contra fuerza bruta (ver login_bloqueado). Los límites son por PAREJA correo+IP para que
# quien solo conoce un correo no pueda bloquear al dueño desde otra IP; el tope por correo (cualquier IP)
# frena los ataques distribuidos y exime a las IP desde las que ese correo ya entró con éxito.
VENTANA_MIN = 15
MAX_FALLOS_EMAIL_IP = 5
MAX_FALLOS_IP = 20
MAX_FALLOS_EMAIL_TOTAL = 30
DIAS_IP_CONOCIDA = 14
RETENCION_FALLOS_DIAS = 2     # los fallos solo importan dentro de VENTANA_MIN: se purgan pronto
RETENCION_EXITOS_DIAS = 30    # los éxitos alimentan «IP conocida» (DIAS_IP_CONOCIDA)
PROB_PURGA = 0.05             # probabilidad de purgar login_intentos en cada inicio de sesión correcto

TIMEOUT = 8


def _entero_env(nombre, defecto):
    try:
        return int(os.environ.get(nombre, ""))
    except ValueError:
        return defecto


# Segundos que se recuerda una sesión ya validada (evita 2 llamadas a Supabase por petición).
# 0 desactiva el caché. Desactivar una cuenta o cerrar sesión tarda como máximo esto en notarse
# en las instancias que ya tenían la sesión en memoria. Tope duro: 120 s.
SESION_CACHE_SEG = min(max(_entero_env("SESION_CACHE_SEGUNDOS", 30), 0), 120)
_CACHE_MAX = 512
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$")

# Reintentos SOLO para lecturas (GET/HEAD). Un POST que recibe 502/503/504 pudo haberse ejecutado ya en
# Supabase (el gateway falla después del commit): reintentarlo duplicaría movimientos de stock, llegadas
# o productos. Los errores de CONEXIÓN (la petición nunca salió) sí se reintentan con seguridad en
# cualquier método: urllib3 solo reintenta lecturas fallidas en métodos idempotentes.
_http = requests.Session()
_http.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(
            total=3,
            backoff_factor=0.4,
            status_forcelist=(502, 503, 504),
            allowed_methods=frozenset(["GET", "HEAD"]),
            raise_on_status=False,
        )
    ),
)


def config_completa():
    return all([SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SECRET_KEY])


# ── Errores de petición ─────────────────────────────────────────────────────
class ErrorPeticion(Exception):
    def __init__(self, status, mensaje):
        super().__init__(mensaje)
        self.status = status
        self.mensaje = mensaje


# ── Cabeceras hacia Supabase ────────────────────────────────────────────────
def _hdr_anon(token=None):
    h = {"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _hdr_servicio(extra=None):
    h = {"apikey": SUPABASE_SECRET_KEY, "Content-Type": "application/json"}
    # Las claves legacy (JWT) van también en Authorization; las nuevas sb_secret_ no.
    if SUPABASE_SECRET_KEY.startswith("eyJ"):
        h["Authorization"] = f"Bearer {SUPABASE_SECRET_KEY}"
    if extra:
        h.update(extra)
    return h


# ── Supabase Auth ───────────────────────────────────────────────────────────
def auth_password(email, password):
    return _http.post(
        f"{SUPABASE_URL}/auth/v1/token",
        params={"grant_type": "password"},
        json={"email": email, "password": password},
        headers=_hdr_anon(),
        timeout=TIMEOUT,
    )


def auth_refresh(refresh_token):
    r = _http.post(
        f"{SUPABASE_URL}/auth/v1/token",
        params={"grant_type": "refresh_token"},
        json={"refresh_token": refresh_token},
        headers=_hdr_anon(),
        timeout=TIMEOUT,
    )
    if r.status_code >= 500:
        raise RuntimeError("Supabase Auth no disponible")
    return r.json() if r.status_code == 200 else None


def auth_usuario(access_token):
    r = _http.get(
        f"{SUPABASE_URL}/auth/v1/user",
        headers=_hdr_anon(access_token),
        timeout=TIMEOUT,
    )
    if r.status_code >= 500:
        raise RuntimeError("Supabase Auth no disponible")
    return r.json() if r.status_code == 200 else None


def auth_logout(access_token, scope="local"):
    """Revoca la sesión ('local') o todas las demás ('others'). Mejor esfuerzo: nunca lanza excepción."""
    try:
        _http.post(
            f"{SUPABASE_URL}/auth/v1/logout",
            params={"scope": scope},
            headers=_hdr_anon(access_token),
            timeout=TIMEOUT,
        )
    except requests.RequestException:
        pass


def auth_cambiar_password(access_token, nueva):
    """Cambia la contraseña del usuario dueño del token (PUT /auth/v1/user)."""
    return _http.put(
        f"{SUPABASE_URL}/auth/v1/user",
        json={"password": nueva},
        headers=_hdr_anon(access_token),
        timeout=TIMEOUT,
    )


# ── Perfiles e intentos de login (service role) ─────────────────────────────
def obtener_perfil(uid):
    r = _http.get(
        f"{SUPABASE_URL}/rest/v1/perfiles",
        params={"id": f"eq.{uid}", "select": "nombre,rol,activo,debe_cambiar_clave"},
        headers=_hdr_servicio(),
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    filas = r.json()
    return filas[0] if filas else None


def marcar_clave_cambiada(uid):
    """Apaga perfiles.debe_cambiar_clave. Idempotente (por eso se puede repetir sin riesgo)."""
    r = _http.patch(
        f"{SUPABASE_URL}/rest/v1/perfiles",
        params={"id": f"eq.{uid}"},
        json={"debe_cambiar_clave": False},
        headers=_hdr_servicio({"Prefer": "return=minimal"}),
        timeout=TIMEOUT,
    )
    r.raise_for_status()


def parse_iso(valor):
    """datetime con zona desde un ISO de Supabase. Funciona en cualquier Python 3.9+: Postgres devuelve los
    microsegundos con largo variable y «Z» y `fromisoformat` solo los admite desde Python 3.11."""
    s = str(valor).strip().replace("Z", "+00:00")
    s = re.sub(r"\.(\d+)", lambda m: "." + (m.group(1) + "000000")[:6], s)
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ── Límite de intentos de login ─────────────────────────────────────────────
# Orden seguro: el intento se REGISTRA ANTES de comprobar la contraseña (como fallo). Si no se puede
# registrar, no se prueba la contraseña (falla cerrado): inducir errores en `login_intentos` ya no permite
# adivinar claves sin que cuente. Si la contraseña es correcta, el registro se marca como éxito.
def _desde(minutos=0, dias=0):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutos, days=dias)).isoformat()


def _contar_intentos(exitoso, desde, **filtros):
    """Cuenta filas de login_intentos (filtros por 'email' y/o 'ip'). Lanza RequestException si no se puede."""
    params = {"select": "id", "exitoso": "is.true" if exitoso else "is.false", "creado_en": f"gte.{desde}", "limit": "1"}
    params.update({k: f"eq.{v}" for k, v in filtros.items()})
    r = _http.get(f"{SUPABASE_URL}/rest/v1/login_intentos", params=params,
                  headers=_hdr_servicio({"Prefer": "count=exact"}), timeout=TIMEOUT)
    r.raise_for_status()
    total = r.headers.get("Content-Range", "*/0").split("/")[-1]
    return int(total) if total.isdigit() else 0


def login_bloqueado(email, ip):
    """True si este intento debe rechazarse sin probar la contraseña. Lanza RequestException si no puede
    comprobarse (el llamador responde 503: se falla cerrado)."""
    ventana = _desde(minutos=VENTANA_MIN)
    if _contar_intentos(False, ventana, ip=ip) >= MAX_FALLOS_IP:
        return True
    if _contar_intentos(False, ventana, email=email, ip=ip) >= MAX_FALLOS_EMAIL_IP:
        return True
    if _contar_intentos(False, ventana, email=email) >= MAX_FALLOS_EMAIL_TOTAL:
        # Ataque distribuido contra este correo: solo pasan las IP desde las que ya entró hace poco.
        return _contar_intentos(True, _desde(dias=DIAS_IP_CONOCIDA), email=email, ip=ip) == 0
    return False


def reservar_intento(email, ip, motivo="credenciales"):
    """Registra el intento como FALLIDO y devuelve su id. Lanza RequestException si no se pudo guardar."""
    r = _http.post(f"{SUPABASE_URL}/rest/v1/login_intentos",
                   json={"email": email, "ip": ip, "exitoso": False, "motivo": motivo},
                   headers=_hdr_servicio({"Prefer": "return=representation"}), timeout=TIMEOUT)
    r.raise_for_status()
    try:
        return r.json()[0]["id"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise requests.RequestException("login_intentos no devolvió el id del intento") from None


def _intento(metodo, id_intento, cuerpo=None):
    """Mejor esfuerzo sobre un intento ya registrado: nunca lanza (el resultado del login no depende de esto)."""
    if id_intento is None:
        return
    try:
        _http.request(metodo, f"{SUPABASE_URL}/rest/v1/login_intentos", params={"id": f"eq.{id_intento}"},
                      json=cuerpo, headers=_hdr_servicio({"Prefer": "return=minimal"}), timeout=TIMEOUT)
    except requests.RequestException as e:
        print(f"[auth] no se pudo actualizar el intento {id_intento}: {e}", file=sys.stderr)


def intento_exitoso(id_intento):
    _intento("PATCH", id_intento, {"exitoso": True, "motivo": None})


def intento_motivo(id_intento, motivo):
    _intento("PATCH", id_intento, {"motivo": motivo})


def intento_liberar(id_intento):
    """El fallo no fue culpa del usuario (Supabase caído, etc.): no debe contar contra él."""
    _intento("DELETE", id_intento)


def purgar_intentos(forzar=False):
    """Borra intentos viejos (la tabla crecería sin límite). Mejor esfuerzo y con poca frecuencia: ver también
    sql/login_intentos.sql, que lo programa en la base con pg_cron si está disponible."""
    if not forzar and random.random() >= PROB_PURGA:
        return
    for exitoso, dias in ((False, RETENCION_FALLOS_DIAS), (True, RETENCION_EXITOS_DIAS)):
        try:
            _http.delete(f"{SUPABASE_URL}/rest/v1/login_intentos",
                         params={"exitoso": "is.true" if exitoso else "is.false", "creado_en": f"lt.{_desde(dias=dias)}"},
                         headers=_hdr_servicio({"Prefer": "return=minimal"}), timeout=TIMEOUT)
        except requests.RequestException as e:
            print(f"[auth] no se pudo purgar login_intentos: {e}", file=sys.stderr)


# ── Utilidades HTTP ─────────────────────────────────────────────────────────
def ip_cliente(h):
    for nombre in ("x-vercel-forwarded-for", "x-forwarded-for", "x-real-ip"):
        valor = h.headers.get(nombre)
        if valor:
            return valor.split(",")[0].strip()[:64]
    return h.client_address[0]


def origen_valido(h):
    """Defensa CSRF adicional a SameSite=Strict."""
    origen = h.headers.get("Origin")
    if not origen:
        return True
    if FRONTEND_DOMAIN:
        return origen.rstrip("/") == FRONTEND_DOMAIN
    return urlparse(origen).netloc == (h.headers.get("Host") or "")


def leer_json(h, max_bytes):
    tipo = (h.headers.get("Content-Type") or "").lower()
    if "application/json" not in tipo:
        raise ErrorPeticion(415, "El contenido debe ser application/json.")
    try:
        largo = int(h.headers.get("Content-Length") or 0)
    except ValueError:
        raise ErrorPeticion(400, "Solicitud inválida.")
    if largo <= 0:
        raise ErrorPeticion(400, "Solicitud vacía.")
    if largo > max_bytes:
        raise ErrorPeticion(413, "Solicitud demasiado grande.")
    try:
        datos = json.loads(h.rfile.read(largo))
    except (ValueError, UnicodeDecodeError):
        raise ErrorPeticion(400, "JSON inválido.")
    if not isinstance(datos, dict):
        raise ErrorPeticion(400, "Formato inválido.")
    return datos


def responder(h, status, cuerpo, cookies=(), extra=None):
    payload = json.dumps(cuerpo, ensure_ascii=False).encode("utf-8")
    h.send_response(status)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Content-Length", str(len(payload)))
    h.send_header("Cache-Control", "no-store")
    h.send_header("X-Content-Type-Options", "nosniff")
    for ck in cookies:
        h.send_header("Set-Cookie", ck)
    for k, v in (extra or {}).items():
        h.send_header(k, v)
    h.end_headers()
    h.wfile.write(payload)


def metodo_no_permitido(h):
    responder(h, 405, {"error": "Método no permitido."})


# ── Cookies de sesión (HttpOnly) ────────────────────────────────────────────
def _cookie(nombre, valor, max_age):
    partes = [
        f"{nombre}={valor}",
        f"Max-Age={max_age}",
        f"Path={COOKIE_PATH}",
        "HttpOnly",
        "SameSite=Strict",
    ]
    if COOKIE_SECURE:
        partes.append("Secure")
    return "; ".join(partes)


def cookies_sesion(data):
    return [
        _cookie(COOKIE_ACCESS, data["access_token"], int(data.get("expires_in", 3600))),
        _cookie(COOKIE_REFRESH, data["refresh_token"], REFRESH_MAX_AGE),
    ]


def cookies_borrar():
    return [_cookie(COOKIE_ACCESS, "", 0), _cookie(COOKIE_REFRESH, "", 0)]


def leer_cookies(h):
    sc = SimpleCookie()
    try:
        sc.load(h.headers.get("Cookie") or "")
    except Exception:
        return {}
    return {k: v.value for k, v in sc.items()}

# ── Usuario de la sesión con su rol (inventario y trazabilidad del kardex) ──
NIVELES = {"personal": 1, "encargado": 2, "admin": 3, "sysadmin": 4}
MSG_CAMBIAR_CLAVE = "Debes cambiar tu contraseña antes de continuar."


# Caché en memoria de la instancia: sha256(access token) -> (vence, auth_user, perfil). Nunca se guarda el token.
# Solo entra una sesión VÁLIDA, con perfil ACTIVO y SIN cambio de clave pendiente: así una cuenta desactivada o
# con clave temporal siempre se consulta a Supabase y se bloquea al instante en esa instancia.
_sesiones = {}


def _clave_cache(access):
    return hashlib.sha256(access.encode("utf-8")).hexdigest()


def _segundos_de_vida(access):
    """Segundos hasta que vence el JWT (solo para ACORTAR el caché; no se verifica la firma: Supabase la verifica)."""
    try:
        carga = access.split(".")[1]
        exp = json.loads(base64.urlsafe_b64decode(carga + "=" * (-len(carga) % 4))).get("exp")
        return float(exp) - time.time() if isinstance(exp, (int, float)) else 0.0
    except (IndexError, ValueError, TypeError):
        return 0.0


def identidad(access):
    """(usuario_auth, perfil) del access token, con caché de SESION_CACHE_SEG segundos.
    (None, None) si el token no vale. Lanza RequestException/RuntimeError si Supabase no responde."""
    clave = _clave_cache(access)
    ahora = time.monotonic()
    hit = _sesiones.get(clave)
    if hit and hit[0] > ahora:
        return hit[1], hit[2]
    _sesiones.pop(clave, None)

    u = auth_usuario(access)
    if not u:
        return None, None
    perfil = obtener_perfil(u["id"])
    ttl = min(SESION_CACHE_SEG, _segundos_de_vida(access) - 5)
    if (ttl > 0 and perfil and perfil.get("activo") and not perfil.get("debe_cambiar_clave")):
        if len(_sesiones) >= _CACHE_MAX:   # sin crecer sin límite: primero lo vencido, si no, lo más viejo
            for k in [k for k, v in _sesiones.items() if v[0] <= ahora] or [min(_sesiones, key=lambda k: _sesiones[k][0])]:
                _sesiones.pop(k, None)
        _sesiones[clave] = (ahora + ttl, u, perfil)
    return u, perfil


def invalidar_sesion(access=None, uid=None):
    """Olvida una sesión (por token) o todas las de un usuario (por id) en ESTA instancia. Se usa al cerrar sesión,
    cambiar la clave, desactivar o cambiar el rol de una cuenta. Las otras instancias lo notan al vencer su caché."""
    if access:
        _sesiones.pop(_clave_cache(access), None)
    if uid:
        for k in [k for k, v in _sesiones.items() if v[1].get("id") == uid]:
            _sesiones.pop(k, None)


def usuario_sesion(h, permitir_cambio_pendiente=False):
    """{'id','email','nombre','rol'} del usuario con sesión válida y activo; None si no hay sesión.

    Si el perfil tiene `debe_cambiar_clave`, TODO endpoint protegido responde 403 (ErrorPeticion) hasta
    que cambie la contraseña: así la regla se cumple en el servidor y no depende de que el navegador
    redirija. Solo /api/cambiar-clave pasa permitir_cambio_pendiente=True.

    Usa `identidad` (caché corto): sin él cada petición costaba 2 llamadas a Supabase (auth + perfil).
    """
    access = leer_cookies(h).get(COOKIE_ACCESS)
    if not access:
        return None
    u, perfil = identidad(access)
    if not u:
        return None
    if not (perfil and perfil.get("activo")):
        return None
    if perfil.get("debe_cambiar_clave") and not permitir_cambio_pendiente:
        raise ErrorPeticion(403, MSG_CAMBIAR_CLAVE)
    return {
        "id": u["id"],
        "email": u.get("email"),
        "nombre": perfil.get("nombre"),
        "rol": str(perfil.get("rol") or "").lower(),
    }


def sesion_activa(h):
    """True si hay un usuario válido y activo (para endpoints que no necesitan su rol)."""
    return usuario_sesion(h) is not None


def es_admin(usuario):
    return NIVELES.get(usuario["rol"], 0) >= NIVELES["admin"]
