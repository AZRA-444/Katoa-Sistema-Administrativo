"""Utilidades compartidas por las funciones serverless de autenticación.

El prefijo "_" hace que Vercel NO exponga este archivo como endpoint.
"""
import json
import os
import re
import sys
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

# Protección contra fuerza bruta
VENTANA_MIN = 15
MAX_FALLOS_EMAIL = 5
MAX_FALLOS_IP = 20

TIMEOUT = 8
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$")

_http = requests.Session()
_http.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(
            total=3,
            backoff_factor=0.4,
            status_forcelist=(502, 503, 504),
            allowed_methods=frozenset(["GET", "POST"]),
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


def auth_logout(access_token):
    """Revoca la sesión actual. Mejor esfuerzo: nunca lanza excepción."""
    try:
        _http.post(
            f"{SUPABASE_URL}/auth/v1/logout",
            params={"scope": "local"},
            headers=_hdr_anon(access_token),
            timeout=TIMEOUT,
        )
    except requests.RequestException:
        pass


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


def contar_fallos(campo, valor):
    """Cuenta intentos fallidos recientes por 'email' o por 'ip'."""
    desde = (datetime.now(timezone.utc) - timedelta(minutes=VENTANA_MIN)).isoformat()
    r = _http.get(
        f"{SUPABASE_URL}/rest/v1/login_intentos",
        params={
            "select": "id",
            campo: f"eq.{valor}",
            "exitoso": "is.false",
            "creado_en": f"gte.{desde}",
            "limit": "1",
        },
        headers=_hdr_servicio({"Prefer": "count=exact"}),
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    total = r.headers.get("Content-Range", "*/0").split("/")[-1]
    return int(total) if total.isdigit() else 0


def registrar_intento(email, ip, exitoso, motivo=None):
    try:
        _http.post(
            f"{SUPABASE_URL}/rest/v1/login_intentos",
            json={"email": email, "ip": ip, "exitoso": exitoso, "motivo": motivo},
            headers=_hdr_servicio({"Prefer": "return=minimal"}),
            timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        print(f"[auth] no se pudo registrar el intento: {e}", file=sys.stderr)


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
