"""Genera el par de claves VAPID para las notificaciones push.

    python scripts/generar_vapid.py

Copia VAPID_PRIVATE_KEY y VAPID_SUBJECT a las variables de entorno de Vercel (Settings → Environment Variables).
La clave privada es secreta: no la subas al repositorio. Si la cambias, todos los dispositivos deberán volver a
activar los avisos (el sistema los re-suscribe solo al abrir la app).
"""
import base64

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731

clave = ec.generate_private_key(ec.SECP256R1())
privada = b64u(clave.private_numbers().private_value.to_bytes(32, "big"))
publica = b64u(clave.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))

print("VAPID_PRIVATE_KEY=" + privada)
print("VAPID_SUBJECT=mailto:CAMBIA-ESTO@tudominio.com")
print()
print("(clave pública, solo informativa; el servidor la deriva sola) " + publica)
