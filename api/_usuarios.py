"""Registro de usuarios. Módulo auxiliar (el prefijo «_» evita que Vercel lo cuente como función): lo sirve
/api/administrador, que ya exige admin o sysadmin en TODAS sus peticiones.

  GET  ?modo=usr_lista
        -> {"usuarios": [{id, nombre, email, rol, activo, debe_cambiar_clave}], "roles": ["personal", ...]}
           `roles` son los que el usuario de la sesión puede asignar al registrar.
  POST {"accion": "usuario_crear", "nombre": "Ana Pérez", "email": "ana@correo.com", "rol": "personal"}
        -> {"usuario": {id, nombre, email, rol, clave_temporal}}

Quién puede asignar qué rol (nadie puede crear a alguien con más poder del que tiene):
    admin    -> personal, encargado
    sysadmin -> personal, encargado, admin, sysadmin
Cambia ROLES_ASIGNABLES si quieres otra regla (por ejemplo, que admin también pueda crear admins).

Flujo de alta:
  1. Se crea la cuenta en Supabase Auth (API de administración, correo ya confirmado) con una clave
     temporal generada aquí con `secrets`.
  2. Se crea su fila en `perfiles` con debe_cambiar_clave = true: en su primer ingreso el sistema lo obliga
     a cambiarla (ver c.usuario_sesion y /api/cambiar-clave).
  3. Si el paso 2 falla, se borra la cuenta del paso 1 para no dejar usuarios huérfanos sin perfil.

La clave temporal se devuelve UNA sola vez (la respuesta va con Cache-Control: no-store) y nunca se guarda
ni se escribe en los logs.
"""
import os
import secrets
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
import _comun as c  # noqa: E402

ROLES_ASIGNABLES = {
    "admin": ("personal", "encargado"),
    "sysadmin": ("personal", "encargado", "admin", "sysadmin"),
}

_LETRAS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"  # sin l, I, o, O (se confunden al dictarla)
_NUMEROS = "23456789"                                          # sin 0, 1
LARGO_CLAVE = 12
LIMITE_LISTA = 500


def roles_asignables(u):
    """Roles que el usuario de la sesión puede asignar (vacío si no es admin ni sysadmin)."""
    return list(ROLES_ASIGNABLES.get(u.get("rol"), ()))


def _clave_temporal():
    """12 caracteres con letras y números (cumple la política de /api/cambiar-clave)."""
    while True:
        s = "".join(secrets.choice(_LETRAS + _NUMEROS) for _ in range(LARGO_CLAVE))
        if any(ch in _NUMEROS for ch in s) and any(ch in _LETRAS for ch in s):
            return s


def _fallo(r, que):
    print(f"[usuarios] {que} {r.status_code}: {r.text[:300]}", file=sys.stderr)
    raise c.ErrorPeticion(502, "No se pudo completar la operación con la base de datos. Inténtalo de nuevo.")


def _correos():
    """{id: correo} desde Supabase Auth. Mejor esfuerzo: si falla, la lista se muestra sin correos."""
    try:
        r = c._http.get(f"{c.SUPABASE_URL}/auth/v1/admin/users", params={"per_page": str(LIMITE_LISTA)},
                        headers=c._hdr_servicio(), timeout=c.TIMEOUT)
        if r.status_code != 200:
            return {}
        return {x["id"]: x.get("email") for x in r.json().get("users", [])}
    except (requests.RequestException, ValueError, KeyError, AttributeError):
        return {}


def leer(u):
    r = c._http.get(f"{c.SUPABASE_URL}/rest/v1/perfiles",
                    params={"select": "id,nombre,rol,activo,debe_cambiar_clave", "order": "nombre.asc",
                            "limit": str(LIMITE_LISTA)},
                    headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if r.status_code != 200:
        _fallo(r, "perfiles")
    correos = _correos()
    usuarios = [{**p, "email": correos.get(p["id"])} for p in r.json()]
    return {"usuarios": usuarios, "roles": roles_asignables(u)}


def _borrar_cuenta(uid):
    """Deshace el alta en Supabase Auth. Mejor esfuerzo: si también falla, queda registrado para revisarlo."""
    try:
        r = c._http.delete(f"{c.SUPABASE_URL}/auth/v1/admin/users/{uid}", headers=c._hdr_servicio(), timeout=c.TIMEOUT)
        if r.status_code not in (200, 204):
            print(f"[usuarios] AVISO: no se pudo revertir la cuenta {uid} ({r.status_code}); bórrala a mano en Supabase.",
                  file=sys.stderr)
    except requests.RequestException as e:
        print(f"[usuarios] AVISO: no se pudo revertir la cuenta {uid}: {e}; bórrala a mano en Supabase.", file=sys.stderr)


def crear(d, u):
    permitidos = roles_asignables(u)
    if not permitidos:  # defensa en profundidad: /api/administrador ya filtra por rol
        raise c.ErrorPeticion(403, "No tienes permiso para registrar usuarios.")

    email = str(d.get("email") or "").strip().lower()
    if len(email) > 254 or not c.EMAIL_RE.match(email):
        raise c.ErrorPeticion(400, "Escribe un correo válido.")
    nombre = " ".join(str(d.get("nombre") or "").split())
    if not 2 <= len(nombre) <= 80:
        raise c.ErrorPeticion(400, "El nombre debe tener entre 2 y 80 caracteres.")
    rol = str(d.get("rol") or "").strip().lower()
    if rol not in c.NIVELES:
        raise c.ErrorPeticion(400, "Rol inválido.")
    if rol not in permitidos:
        raise c.ErrorPeticion(403, "No puedes asignar ese rol.")

    clave = _clave_temporal()

    # 1) Cuenta en Supabase Auth
    r = c._http.post(f"{c.SUPABASE_URL}/auth/v1/admin/users",
                     json={"email": email, "password": clave, "email_confirm": True},
                     headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if r.status_code in (409, 422) and ("registered" in r.text or "exists" in r.text):
        raise c.ErrorPeticion(409, "Ya existe un usuario con ese correo.")
    if r.status_code not in (200, 201):
        _fallo(r, "auth/admin/users")
    uid = r.json().get("id")
    if not uid:
        _fallo(r, "auth/admin/users (sin id)")

    # 2) Perfil con cambio de clave obligatorio. Upsert por si un trigger de Supabase ya creó la fila.
    try:
        rp = c._http.post(f"{c.SUPABASE_URL}/rest/v1/perfiles", params={"on_conflict": "id"},
                          json={"id": uid, "nombre": nombre, "rol": rol, "activo": True, "debe_cambiar_clave": True},
                          headers=c._hdr_servicio({"Prefer": "resolution=merge-duplicates,return=minimal"}),
                          timeout=c.TIMEOUT)
    except requests.RequestException:
        _borrar_cuenta(uid)
        raise
    if rp.status_code not in (200, 201, 204):
        _borrar_cuenta(uid)
        _fallo(rp, "perfiles")

    print(f"[usuarios] {u['email']} ({u['rol']}) registró a {email} como {rol}", file=sys.stderr)
    return {"id": uid, "nombre": nombre, "email": email, "rol": rol, "clave_temporal": clave}
