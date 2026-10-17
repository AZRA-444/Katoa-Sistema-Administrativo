"""Registro de usuarios. Módulo auxiliar (el prefijo «_» evita que Vercel lo cuente como función): lo sirve
/api/administrador, que ya exige admin o sysadmin en TODAS sus peticiones.

  GET  ?modo=usr_lista
        -> {"usuarios": [{id, nombre, email, rol, activo, debe_cambiar_clave}], "roles": ["personal", ...], "yo": "<id>"}
           `roles` son los que el usuario de la sesión puede asignar al registrar.
  POST {"accion": "usuario_crear", "nombre": "Ana Pérez", "email": "ana@correo.com", "rol": "personal"}
        -> {"usuario": {id, nombre, email, rol, clave_temporal}}
  POST {"accion": "usuario_estado", "id": "<uuid>", "activo": false}   desactivar / reactivar (cuando alguien se va)
  POST {"accion": "usuario_rol",    "id": "<uuid>", "rol": "encargado"}  cambiar el rol
  POST {"accion": "usuario_clave",  "id": "<uuid>"}                      resetear la clave: devuelve una temporal
        -> {"usuario": {id, nombre, ...}}  (usuario_clave añade clave_temporal, que se muestra UNA vez)

Quién puede asignar qué rol (nadie puede crear a alguien con más poder del que tiene):
    admin    -> personal, encargado
    sysadmin -> personal, encargado, admin, sysadmin
Cambia ROLES_ASIGNABLES si quieres otra regla (por ejemplo, que admin también pueda crear admins).

Gestionar a un usuario existente sigue la misma regla: solo se puede actuar sobre quien tiene hoy un rol que tú
podrías asignar (admin → personal y encargado; sysadmin → todos) y dejarlo en un rol que también podrías asignar.
Nadie puede desactivarse, cambiarse el rol ni resetearse la clave a sí mismo (para eso está «Cambiar contraseña»).
Desactivar: `perfiles.activo = false` (lo comprueba cada petición, ver c.usuario_sesion) y, además, se bloquea la
cuenta en Supabase Auth para que no pueda renovar la sesión ni iniciar una nueva. Resetear la clave marca
`debe_cambiar_clave`, así las sesiones abiertas quedan inutilizadas hasta que cambie la clave.

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
import re
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
    return {"usuarios": usuarios, "roles": roles_asignables(u), "yo": u["id"]}


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


# ── Gestión de usuarios existentes ──────────────────────────────────────────
UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
BLOQUEO_PERMANENTE = "876000h"     # ~100 años: Supabase no tiene «bloquear sin fin»


def _perfil_objetivo(d, u):
    """Perfil del usuario sobre el que se actúa, validando que quien actúa pueda gestionarlo."""
    uid = str(d.get("id") or "")
    if not UUID_RE.match(uid):
        raise c.ErrorPeticion(400, "Usuario inválido.")
    if uid == u["id"]:
        raise c.ErrorPeticion(403, "No puedes hacer esto con tu propia cuenta.")
    r = c._http.get(f"{c.SUPABASE_URL}/rest/v1/perfiles",
                    params={"select": "id,nombre,rol,activo,debe_cambiar_clave", "id": f"eq.{uid}", "limit": "1"},
                    headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    if r.status_code != 200:
        _fallo(r, "perfiles")
    if not r.json():
        raise c.ErrorPeticion(404, "El usuario no existe.")
    p = r.json()[0]
    if str(p.get("rol") or "").lower() not in roles_asignables(u):
        raise c.ErrorPeticion(403, "No tienes permiso para gestionar a un usuario con ese rol.")
    return p


def _patch_perfil(uid, cambios):
    r = c._http.patch(f"{c.SUPABASE_URL}/rest/v1/perfiles", params={"id": f"eq.{uid}"}, json=cambios,
                      headers=c._hdr_servicio({"Prefer": "return=minimal"}), timeout=c.TIMEOUT)
    if r.status_code not in (200, 204):
        _fallo(r, "perfiles (actualizar)")


def _auth_admin_put(uid, cuerpo):
    """PUT /auth/v1/admin/users/{id}. Devuelve True si Supabase Auth lo aceptó (no lanza por error de red)."""
    try:
        r = c._http.put(f"{c.SUPABASE_URL}/auth/v1/admin/users/{uid}", json=cuerpo,
                        headers=c._hdr_servicio(), timeout=c.TIMEOUT)
    except requests.RequestException as e:
        print(f"[usuarios] auth admin {uid}: {e!r}", file=sys.stderr)
        return False
    if r.status_code not in (200, 201):
        print(f"[usuarios] auth admin {uid} {r.status_code}: {r.text[:200]}", file=sys.stderr)
        return False
    return True


def _resumen(p, **extra):
    return {"id": p["id"], "nombre": p.get("nombre"), "rol": p.get("rol"), "activo": p.get("activo"), **extra}


def _estado(d, u, p):
    activo = d.get("activo")
    if not isinstance(activo, bool):
        raise c.ErrorPeticion(400, "Indica si el usuario queda activo o no.")
    if bool(p.get("activo")) == activo:
        raise c.ErrorPeticion(409, "El usuario ya estaba " + ("activo." if activo else "desactivado."))
    _patch_perfil(p["id"], {"activo": activo})       # fuente de verdad: cada petición comprueba `activo`
    c.invalidar_sesion(uid=p["id"])
    bloqueo = _auth_admin_put(p["id"], {"ban_duration": "none" if activo else BLOQUEO_PERMANENTE})
    print(f"[usuarios] {u['email']} ({u['rol']}) {'reactivó' if activo else 'desactivó'} a {p.get('nombre')} ({p['id']})",
          file=sys.stderr)
    if activo:
        msg = f"{p.get('nombre')} quedó activo de nuevo."
        if not bloqueo:
            msg += " Aviso: no se pudo quitar el bloqueo en Supabase Auth; si no puede entrar, quítalo desde el panel de Supabase."
    else:
        msg = f"{p.get('nombre')} quedó desactivado y ya no puede usar el sistema."
        if not bloqueo:
            msg += " Aviso: no se pudo bloquear la cuenta en Supabase Auth; igualmente el sistema ya le niega el acceso."
    return _resumen(p, activo=activo), msg


def _rol(d, u, p):
    rol = str(d.get("rol") or "").strip().lower()
    if rol not in c.NIVELES:
        raise c.ErrorPeticion(400, "Rol inválido.")
    if rol not in roles_asignables(u):
        raise c.ErrorPeticion(403, "No puedes asignar ese rol.")
    if rol == str(p.get("rol") or "").lower():
        raise c.ErrorPeticion(409, "El usuario ya tiene ese rol.")
    _patch_perfil(p["id"], {"rol": rol})
    c.invalidar_sesion(uid=p["id"])
    print(f"[usuarios] {u['email']} ({u['rol']}) cambió el rol de {p.get('nombre')} ({p['id']}): {p.get('rol')} → {rol}",
          file=sys.stderr)
    return _resumen(p, rol=rol), f"{p.get('nombre')} ahora es {rol}."


def _clave(d, u, p):
    clave = _clave_temporal()
    # Primero se exige el cambio (las sesiones abiertas quedan inutilizadas); después se cambia la clave.
    # Si falla lo segundo, solo queda un cambio de clave pendiente que el usuario resuelve con la clave que ya conoce.
    _patch_perfil(p["id"], {"debe_cambiar_clave": True})
    c.invalidar_sesion(uid=p["id"])
    if not _auth_admin_put(p["id"], {"password": clave}):
        raise c.ErrorPeticion(502, "No se pudo cambiar la clave en Supabase. Inténtalo de nuevo.")
    print(f"[usuarios] {u['email']} ({u['rol']}) reseteó la clave de {p.get('nombre')} ({p['id']})", file=sys.stderr)
    return (_resumen(p, clave_temporal=clave),
            f"Clave de {p.get('nombre')} restablecida. Entrégale la clave temporal: tendrá que cambiarla al entrar.")


def gestionar(d, u):
    """usuario_estado | usuario_rol | usuario_clave. Devuelve (usuario, mensaje)."""
    if not roles_asignables(u):    # defensa en profundidad: /api/administrador ya filtra por rol
        raise c.ErrorPeticion(403, "No tienes permiso para gestionar usuarios.")
    accion = d.get("accion")
    p = _perfil_objetivo(d, u)
    if accion == "usuario_estado":
        return _estado(d, u, p)
    if accion == "usuario_rol":
        return _rol(d, u, p)
    if accion == "usuario_clave":
        return _clave(d, u, p)
    raise c.ErrorPeticion(400, "Acción no válida.")
