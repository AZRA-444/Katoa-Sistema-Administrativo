"""Pruebas de api/_push.py: cifrado RFC 8291 (con su vector oficial), VAPID y validación de endpoints."""
import base64
import json
import os
import sys

os.environ.setdefault("VAPID_PRIVATE_KEY", "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")  # clave de prueba pública del RFC
os.environ.setdefault("VAPID_SUBJECT", "mailto:prueba@katoa.test")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "api"))

import pytest  # noqa: E402
from cryptography.hazmat.primitives import hashes  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402
from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: E402
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat  # noqa: E402

import _push as p  # noqa: E402

# Vector de prueba de RFC 8291, apéndice A
AS_PRIVADA = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
AS_PUBLICA = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
UA_PRIVADA = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"
UA_PUBLICA = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
AUTH = "BTBZMqHH6r4Tts7J_aSIgg"
SAL = "DGv6ra1nlYgDCS1FRnbzlw"
TEXTO = b"When I grow up, I want to be a watermelon"


def _priv(b64):
    return ec.derive_private_key(int.from_bytes(p.b64u_dec(b64), "big"), ec.SECP256R1())


def _descifrar_como_navegador(cuerpo, ua_priv, auth):
    """Lado receptor, escrito aparte siguiendo RFC 8291 §3.4 y RFC 8188."""
    sal, rs, idlen = cuerpo[:16], int.from_bytes(cuerpo[16:20], "big"), cuerpo[20]
    as_pub, cifrado = cuerpo[21:21 + idlen], cuerpo[21 + idlen:]
    assert rs == 4096
    ua_pub = ua_priv.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    secreto = ua_priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
    ikm = HKDF(hashes.SHA256(), 32, auth, b"WebPush: info\x00" + ua_pub + as_pub).derive(secreto)
    cek = HKDF(hashes.SHA256(), 16, sal, b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, sal, b"Content-Encoding: nonce\x00").derive(ikm)
    plano = AESGCM(cek).decrypt(nonce, cifrado, None)
    assert plano.endswith(b"\x02")          # delimitador del último registro
    return plano[:-1]


def test_vector_rfc8291_valores_intermedios():
    as_priv, ua_pub = _priv(AS_PRIVADA), p.b64u_dec(UA_PUBLICA)
    secreto = as_priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))
    assert p.b64u(secreto) == "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs"          # ecdh_secret del RFC
    key_info = b"WebPush: info\x00" + ua_pub + p.b64u_dec(AS_PUBLICA)
    ikm = HKDF(hashes.SHA256(), 32, p.b64u_dec(AUTH), key_info).derive(secreto)
    assert p.b64u(ikm) == "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg"             # IKM del RFC
    cek = HKDF(hashes.SHA256(), 16, p.b64u_dec(SAL), b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, p.b64u_dec(SAL), b"Content-Encoding: nonce\x00").derive(ikm)
    assert p.b64u(cek) == "oIhVW04MRdy2XN9CiKLxTg"                                  # CEK del RFC
    assert p.b64u(nonce) == "4h_95klXJ5E_qnoN"                                      # NONCE del RFC


def test_cifrar_reproduce_el_vector_y_se_descifra():
    cuerpo = p.cifrar(TEXTO, UA_PUBLICA, AUTH, _priv=_priv(AS_PRIVADA), _sal=p.b64u_dec(SAL))
    assert p.b64u(cuerpo[:16]) == SAL
    assert cuerpo[21:86] == p.b64u_dec(AS_PUBLICA)
    assert cuerpo.startswith(p.b64u_dec("DGv6ra1nlYgDCS1FRnbzlwAAEABB"))             # sal + rs=4096 + idlen=65 + 0x04
    assert _descifrar_como_navegador(cuerpo, _priv(UA_PRIVADA), p.b64u_dec(AUTH)) == TEXTO


def test_cifrar_con_claves_aleatorias_y_json_utf8():
    ua = ec.generate_private_key(ec.SECP256R1())
    ua_pub = p.b64u(ua.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))
    auth = os.urandom(16)
    msg = json.dumps({"titulo": "Ñandú — cierre", "cuerpo": "Acción lista ✓"}, ensure_ascii=False).encode()
    a, b = p.cifrar(msg, ua_pub, p.b64u(auth)), p.cifrar(msg, ua_pub, p.b64u(auth))
    assert a != b                                                                    # sal y clave efímera nuevas cada vez
    assert _descifrar_como_navegador(a, ua, auth) == msg


def test_cifrar_rechaza_claves_malas_y_mensaje_enorme():
    with pytest.raises(ValueError):
        p.cifrar(b"x", "AAAA", AUTH)
    with pytest.raises(ValueError):
        p.cifrar(b"x" * 4000, UA_PUBLICA, AUTH)


def test_vapid_jwt_firma_valida():
    assert p.configurado()
    assert p.clave_publica() == AS_PUBLICA                                           # derivada de la privada
    jwt = p._jwt_vapid("https://fcm.googleapis.com")
    cab, cuerpo, firma = jwt.split(".")
    reclamos = json.loads(p.b64u_dec(cuerpo))
    assert reclamos["aud"] == "https://fcm.googleapis.com" and reclamos["sub"] == "mailto:prueba@katoa.test"
    assert 0 < reclamos["exp"] - __import__("time").time() <= 24 * 3600
    raw = p.b64u_dec(firma)
    assert len(raw) == 64
    pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), p.b64u_dec(p.clave_publica()))
    pub.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
               f"{cab}.{cuerpo}".encode(), ec.ECDSA(hashes.SHA256()))               # lanza si no es válida


@pytest.mark.parametrize("url,esperado", [
    ("https://fcm.googleapis.com/fcm/send/abc123def456ghi789", True),
    ("https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk", True),
    ("https://wns2-par02p.notify.windows.com/w/?token=BQYAAAD", True),
    ("https://web.push.apple.com/QGxyz0123456789abcdef", True),
    ("http://fcm.googleapis.com/fcm/send/abc123def456ghi789", False),               # sin https
    ("https://169.254.169.254/latest/meta-data/iam/security-credentials/", False),  # SSRF a metadatos
    ("https://localhost/fcm/send/abc123def456ghi789", False),
    ("https://fcm.googleapis.com.evil.com/fcm/send/abc123def456", False),           # sufijo falso
    ("https://evilfcm.googleapis.com@evil.com/x/abc123def456ghi", False),
    ("https://user:pw@fcm.googleapis.com/fcm/send/abc123def456", False),
    ("https://fcm.googleapis.com:8443/fcm/send/abc123def456ghi", False),
    ("https://notpush.apple.com.evil.org/abc123def456ghi789", False),
    ("", False), (None, False), (123, False),
])
def test_endpoint_valido(url, esperado):
    assert p.endpoint_valido(url) is esperado


def test_recorte_y_notificar_sin_configurar_no_lanza(monkeypatch):
    assert p._recorte("  hola\n\n  mundo  ", 50) == "hola mundo"
    assert p._recorte("a" * 300, 160).endswith("…") and len(p._recorte("a" * 300, 160)) == 160
    monkeypatch.setattr(p, "configurado", lambda: False)
    assert p.notificar("t", "c") == 0
    monkeypatch.setattr(p, "configurado", lambda: True)
    monkeypatch.setattr(p.c, "config_completa", lambda: True)
    monkeypatch.setattr(p, "_destinos", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("base caída")))
    assert p.notificar("t", "c") == 0                                                # un fallo interno no se propaga
