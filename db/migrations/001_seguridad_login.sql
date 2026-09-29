-- 001_seguridad_login.sql
-- Tablas que usa la API de login. Es seguro ejecutarlo más de una vez y
-- también si `perfiles` ya existe (solo agrega lo que falte).
-- Solo la API (clave secret / service role) accede a estas tablas.

-- ── perfiles ────────────────────────────────────────────────────────────────
create table if not exists public.perfiles (
    id                 uuid primary key references auth.users (id) on delete cascade,
    nombre             text        not null,
    rol                text        not null default 'personal',
    activo             boolean     not null default true,
    debe_cambiar_clave boolean     not null default false,
    creado_en          timestamptz not null default now()
);

alter table public.perfiles add column if not exists nombre             text;
alter table public.perfiles add column if not exists rol                text        not null default 'personal';
alter table public.perfiles add column if not exists activo             boolean     not null default true;
alter table public.perfiles add column if not exists debe_cambiar_clave boolean     not null default false;
alter table public.perfiles add column if not exists creado_en          timestamptz not null default now();

-- Roles válidos: personal, encargado, admin, sysAdmin (sin distinguir mayúsculas)
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'perfiles_rol_valido') then
        alter table public.perfiles
            add constraint perfiles_rol_valido
            check (lower(rol) in ('personal', 'encargado', 'admin', 'sysadmin'));
    end if;
end $$;

-- RLS activado y SIN políticas: ningún usuario puede leer ni modificar perfiles
-- desde el navegador (así nadie puede cambiarse el rol a sí mismo).
alter table public.perfiles enable row level security;
revoke all on public.perfiles from anon, authenticated;

-- ── login_intentos ──────────────────────────────────────────────────────────
create table if not exists public.login_intentos (
    id        bigint generated always as identity primary key,
    email     text        not null,
    ip        text,
    exitoso   boolean     not null,
    motivo    text,
    creado_en timestamptz not null default now()
);

create index if not exists login_intentos_email_idx
    on public.login_intentos (email, creado_en desc) where not exitoso;
create index if not exists login_intentos_ip_idx
    on public.login_intentos (ip, creado_en desc) where not exitoso;

alter table public.login_intentos enable row level security;
revoke all on public.login_intentos from anon, authenticated;

-- Limpieza opcional (con pg_cron o a mano): conservar 30 días
-- delete from public.login_intentos where creado_en < now() - interval '30 days';

-- ── Primer usuario ──────────────────────────────────────────────────────────
-- 1) Crea el usuario en Authentication → Users.
-- 2) Cambia el correo y el nombre y ejecuta:
--
-- insert into public.perfiles (id, nombre, rol, activo)
-- select id, 'Tu nombre', 'sysAdmin', true
-- from auth.users
-- where email = 'tu-correo@dominio.com'
-- on conflict (id) do update
--     set nombre = excluded.nombre, rol = excluded.rol, activo = true;
