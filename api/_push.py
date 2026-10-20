"""Notificaciones push (Web Push) — módulo auxiliar: el prefijo «_» evita que Vercel lo cuente como función.

Lo expone /api/notificaciones (suscribir, quitar, probar, clave pública) y lo dispara cuando:
  · un admin publica una notificación            -> a todo el personal activo (menos al autor)
  · alguien solicita una autorización            -> a admin y sysadmin
  · un admin aprueba / rechaza una solicitud     -> a quien la pidió (sin el código: ese solo lo ve el admin)

Implementa RFC 8030 (Web Push), RFC 8291 (cifrado aes128gcm) y RFC 8292 (VAPID) solo con `cryptography` y `requests`.

Variables de entorno (genera las claves con `python scripts/generar_vapid.py`):
  VAPID_PRIVATE_KEY   clave privada P-256, 32 bytes en base64url. SECRETA: solo en el servidor.
  VAPID_SUBJECT       contacto del remitente: «mailto:correo@tudominio.com» (Apple rechaza valores sin mailto:/https:)

Seguridad:
  · El servidor hace POST a la URL (`endpoint`) que le da el navegador: se acepta SOLO si es de un servicio push
    conocido (Google, Mozilla, Microsoft, Apple), por https y sin redirecciones (evita SSRF).
  · `notificar()` NUNCA lanza: un fallo del push no debe estropear la operación principal (publicar, solicitar…).
  · Se envía solo a usuarios activos; las suscripciones caducadas (404/410) se borran solas.
"""
import base64
import json
import os
import re
import struct
import sys
import time
from concurrent.futures import ThreadPoolExecutor, wait
from urllib.parse import urlparse

import requests
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

TABLA = "push_suscripciones"
MAX_POR_USUARIO = 10          # dispositivos por usuario (los más antiguos se descartan)
MAX_USUARIOS_ENVIO = 200      # tope de destinatarios por envío
HILOS = 8
TIMEOUT_ENVIO = 5             # segundos por servicio push
PRESUPUESTO_SEG = 7           # tiempo total máximo que un envío puede retrasar la respuesta
TTL_SEG = 60 * 60 * 24        # si el dispositivo está apagado, el aviso espera hasta 24 h
MAX_CUERPO = 160
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

# Servicios push de los navegadores. Cualquier otro host se rechaza.
HOSTS_PUSH = {"fcm.googleapis.com"}
SUFIJOS_PUSH = (".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com")

# Solo para pruebas con un único usuario: el autor también recibe sus propios avisos
INCLUIR_AUTOR = os.environ.get("PUSH_INCLUIR_AUTOR", "").strip().lower() in ("1", "true", "si", "sí")

_SUJETO = os.environ.get("VAPID_SUBJECT", "").strip()
_PRIVADA_RAW = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
_clave_cache = {}


# ── Base64url ───────────────────────────────────────────────────────────────
def b64u(datos):
    return base64.urlsafe_b64encode(datos).rstrip(b"=").decode("ascii")


def b64u_dec(texto):
    if not isinstance(texto, str) or not texto or len(texto) > 4096:
        raise ValueError("base64url inválido")
    return base64.urlsafe_b64decode(texto + "=" * (-len(texto) % 4))


# ── VAPID ───────────────────────────────────────────────────────────────────
def _clave_privada():
    if "k" not in _clave_cache:
        try:
            raw = b64u_dec(_PRIVADA_RAW)
            if len(raw) != 32:
                raise ValueError("la clave privada debe medir 32 bytes")
            _clave_cache["k"] = ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())
        except ValueError as e:
            print(f"[push] VAPID_PRIVATE_KEY inválida: {e}", file=sys.stderr)
            _clave_cache["k"] = None
    return _clave_cache["k"]


def configurado():
    return bool(_clave_privada() and _SUJETO.startswith(("mailto:", "https://")))


def clave_publica():
    """Clave pública (65 bytes sin comprimir, base64url): es la que el navegador necesita para suscribirse."""
    k = _clave_privada()
    if not k:
        return None
    return b64u(k.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))


def _jwt_vapid(audiencia):
    cab = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    cuerpo = b64u(json.dumps({"aud": audiencia, "exp": int(time.time()) + 12 * 3600, "sub": _SUJETO},
                             separators=(",", ":")).encode())
    firma = _clave_privada().sign(f"{cab}.{cuerpo}".encode(), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(firma)
    return f"{cab}.{cuerpo}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


# ── Cifrado RFC 8291 (aes128gcm, un solo registro) ──────────────────────────
def cifrar(mensaje, ua_publica_b64, auth_b64, *, _priv=None, _sal=None):
    """Devuelve el cuerpo cifrado. `_priv` y `_sal` solo existen para reproducir el vector de prueba del RFC."""
    ua_pub = b64u_dec(ua_publica_b64)
    auth = b64u_dec(auth_b64)
    if len(ua_pub) != 65 or ua_pub[0] != 4 or len(auth) != 16:
        raise ValueError("claves de suscripción inválidas")
    if len(mensaje) > 3993:  # 4096 de registro − 16 (etiqueta GCM) − 1 (delimitador) − 86 (cabecera)
        raise ValueError("mensaje demasiado largo")

    mi_priv = _priv or ec.generate_private_key(ec.SECP256R1())
    mi_pub = mi_priv.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    secreto = mi_priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))

    ikm = HKDF(hashes.SHA256(), 32, auth, b"WebPush: info\x00" + ua_pub + mi_pub).derive(secreto)
    sal = _sal or os.urandom(16)
    cek = HKDF(hashes.SHA256(), 16, sal, b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, sal, b"Content-Encoding: nonce\x00").derive(ikm)
    cifrado = AESGCM(cek).encrypt(nonce, mensaje + b"\x02", None)
    return sal + struct.pack(">I", 4096) + bytes([len(mi_pub)]) + mi_pub + cifrado


# ── Validación de lo que manda el navegador ─────────────────────────────────
def endpoint_valido(url):
    if not isinstance(url, str) or not 20 <= len(url) <= 2048:
        return False
    try:
        p = urlparse(url)
        host = (p.hostname or "").lower()
        puerto = p.port
    except ValueError:
        return False
    if p.scheme != "https" or not host or p.username or p.password or puerto not in (None, 443):
        return False
    return host in HOSTS_PUSH or host.endswith(SUFIJOS_PUSH)


def _claves_validas(p256dh, auth):
    try:
        return len(b64u_dec(p256dh)) == 65 and b64u_dec(p256dh)[0] == 4 and len(b64u_dec(auth)) == 16
    except ValueError:
        return False


# ── Base de datos ───────────────────────────────────────────────────────────
def _rest(metodo, tabla=TABLA, extra=None, **kw):
    return c._http.request(metodo, f"{c.SUPABASE_URL}/rest/v1/{tabla}",
                           headers=c._hdr_servicio(extra), timeout=c.TIMEOUT, **kw)


def _fallo(r, donde):
    print(f"[push] {donde} {r.status_code}: {r.text[:300]}", file=sys.stderr)
    raise c.ErrorPeticion(502, "No se pudo guardar la suscripción. Inténtalo de nuevo.")


def guardar(u, d, user_agent=""):
    """Registra (o reasigna al usuario actual) el dispositivo. Idempotente por `endpoint`."""
    s = d.get("suscripcion")
    keys = s.get("keys") if isinstance(s, dict) else None
    if not isinstance(keys, dict):
        raise c.ErrorPeticion(400, "Suscripción inválida.")
    endpoint, p256dh, auth = s.get("endpoint"), keys.get("p256dh"), keys.get("auth")
    if not endpoint_valido(endpoint) or not _claves_validas(p256dh, auth):
        raise c.ErrorPeticion(400, "Suscripción inválida.")

    r = _rest("POST", extra={"Prefer": "resolution=merge-duplicates,return=minimal"},
              params={"on_conflict": "endpoint"},
              json={"usuario_id": u["id"], "endpoint": endpoint, "p256dh": p256dh, "auth": auth,
                    "user_agent": (user_agent or "")[:200],
                    "actualizado_en": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    if r.status_code not in (200, 201, 204):
        _fallo(r, "guardar")

    # Tope por usuario: se descartan los más antiguos
    r = _rest("GET", params={"select": "id", "usuario_id": f"eq.{u['id']}",
                             "order": "actualizado_en.desc", "offset": str(MAX_POR_USUARIO), "limit": "50"})
    if r.status_code == 200 and r.json():
        _borrar_ids([int(f["id"]) for f in r.json()])


def quitar(u, d):
    endpoint = d.get("endpoint")
    if not endpoint_valido(endpoint):
        raise c.ErrorPeticion(400, "Suscripción inválida.")
    r = _rest("DELETE", extra={"Prefer": "return=minimal"},
              params={"usuario_id": f"eq.{u['id']}", "endpoint": f"eq.{endpoint}"})
    if r.status_code not in (200, 204):
        _fallo(r, "quitar")


def _borrar_ids(ids):
    if ids:
        _rest("DELETE", extra={"Prefer": "return=minimal"}, params={"id": f"in.({','.join(map(str, ids))})"})


def _destinos(usuarios=None, roles=None, excluir=None):
    """-> (suscripciones a las que enviar, diagnóstico). Solo usuarios ACTIVOS, filtrados por ids y/o roles."""
    diag = {"en_base": 0, "activos": 0, "tras_excluir": 0}
    params = {"select": "id,usuario_id,endpoint,p256dh,auth", "limit": "1000"}
    if usuarios is not None:
        ids = [x for x in usuarios if isinstance(x, str) and UUID_RE.match(x)]
        if not ids:
            return [], diag
        params["usuario_id"] = f"in.({','.join(ids)})"
    r = _rest("GET", params=params)
    if r.status_code != 200:
        print(f"[push] destinos {r.status_code}: {r.text[:200]} (¿existe la tabla push_suscripciones? sql/push_suscripciones.sql)",
              file=sys.stderr)
        return [], diag
    subs = r.json()
    diag["en_base"] = len(subs)
    uids = sorted({s["usuario_id"] for s in subs if UUID_RE.match(str(s["usuario_id"]))})[:MAX_USUARIOS_ENVIO]
    if not uids:
        return [], diag
    # Los roles NO se filtran en SQL: en la base hay valores como «sysAdmin» y el filtro `in.` distingue mayúsculas.
    r = _rest("GET", "perfiles", params={"select": "id,rol", "id": f"in.({','.join(uids)})", "activo": "is.true"})
    if r.status_code != 200:
        print(f"[push] perfiles {r.status_code}: {r.text[:200]}", file=sys.stderr)
        return [], diag
    perfiles = r.json()
    if roles:
        validos = {str(x).lower() for x in roles}
        perfiles = [f for f in perfiles if str(f.get("rol") or "").lower() in validos]
    activos = {str(f["id"]) for f in perfiles}
    diag["activos"] = sum(1 for s in subs if str(s["usuario_id"]) in activos)
    if excluir and not INCLUIR_AUTOR:
        activos.discard(str(excluir))
    destinos = [s for s in subs if str(s["usuario_id"]) in activos]
    diag["tras_excluir"] = len(destinos)
    return destinos, diag


# ── Envío ───────────────────────────────────────────────────────────────────
def _enviar_uno(sub, cuerpo):
    """-> 'ok' | 'caducada' | 'error'"""
    try:
        p = urlparse(sub["endpoint"])
        if not endpoint_valido(sub["endpoint"]):
            return "caducada"   # dato viejo o manipulado: se descarta
        datos = cifrar(cuerpo, sub["p256dh"], sub["auth"])
        r = requests.post(sub["endpoint"], data=datos, timeout=TIMEOUT_ENVIO, allow_redirects=False, headers={
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": str(TTL_SEG),
            "Urgency": "high",
            "Authorization": f"vapid t={_jwt_vapid(f'{p.scheme}://{p.netloc}')}, k={clave_publica()}",
        })
    except (requests.RequestException, ValueError) as e:
        print(f"[push] envío falló: {type(e).__name__}", file=sys.stderr)
        return "error"
    if 200 <= r.status_code < 300:
        return "ok"
    if r.status_code in (404, 410):
        return "caducada"       # el usuario revocó el permiso o desinstaló la app
    print(f"[push] {p.hostname} respondió {r.status_code}: {r.text[:150]}", file=sys.stderr)
    return "error"              # 401/403 = VAPID rechazado (revisa VAPID_SUBJECT y la clave); 413/429/5xx = reintento futuro


def _recorte(texto, maximo):
    t = re.sub(r"\s+", " ", str(texto or "")).strip()
    return t if len(t) <= maximo else t[: maximo - 1].rstrip() + "…"


def notificar(titulo, cuerpo, url="/assets/pages/notificaciones.html", *, usuarios=None, roles=None, excluir=None, tag=None,
              urgente=False):
    """Envía el aviso y devuelve cuántos dispositivos lo recibieron. No lanza nunca.

    `urgente`: en PC el aviso no desaparece solo hasta que el usuario lo atienda (en celular lo decide el sistema)."""
    try:
        if not configurado() or not c.config_completa():
            print("[push] no se envía: faltan VAPID_PRIVATE_KEY / VAPID_SUBJECT o la configuración de Supabase", file=sys.stderr)
            return 0
        if not (isinstance(url, str) and url.startswith("/") and not url.startswith("//")):
            url = "/"
        destinos, diag = _destinos(usuarios, roles, excluir)
        if not destinos:
            print(f"[push] sin destinatarios · suscripciones en la base: {diag['en_base']} · de usuarios activos"
                  f"{' con el rol pedido' if roles else ''}: {diag['activos']} · tras excluir al autor: {diag['tras_excluir']}"
                  " (el autor no recibe su propio aviso; para probar con un solo usuario: PUSH_INCLUIR_AUTOR=true)",
                  file=sys.stderr)
            return 0
        mensaje = {"titulo": _recorte(titulo, 80) or "Katoa", "cuerpo": _recorte(cuerpo, MAX_CUERPO), "url": url}
        if tag:
            mensaje["tag"] = str(tag)[:64]
        if urgente:
            mensaje["urgente"] = True
        cuerpo_json = json.dumps(mensaje, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

        ex = ThreadPoolExecutor(max_workers=HILOS)
        futuros = {ex.submit(_enviar_uno, s, cuerpo_json): s for s in destinos}
        hechos, _ = wait(futuros, timeout=PRESUPUESTO_SEG)
        ex.shutdown(wait=False, cancel_futures=True)   # no esperar a los que se atrasen

        ok, caducadas = 0, []
        for f in hechos:
            estado = f.result()
            if estado == "ok":
                ok += 1
            elif estado == "caducada":
                caducadas.append(int(futuros[f]["id"]))
        _borrar_ids(caducadas)
        print(f"[push] «{mensaje['titulo']}»: {ok} enviados de {len(destinos)} dispositivos"
              f"{f', {len(caducadas)} caducados eliminados' if caducadas else ''}"
              f"{f', {len(destinos) - len(hechos)} sin respuesta a tiempo' if len(hechos) < len(destinos) else ''}", file=sys.stderr)
        return ok
    except Exception as e:  # noqa: BLE001 — a propósito: el push es accesorio y no debe romper la operación principal
        print(f"[push] notificar falló: {type(e).__name__}: {e}", file=sys.stderr)
        return 0
