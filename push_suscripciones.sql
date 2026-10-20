-- Suscripciones de notificaciones push (una fila por dispositivo/navegador).
-- Ejecutar una vez en el SQL Editor de Supabase. Solo accede el servidor con la clave de servicio:
-- RLS activado y SIN políticas = el navegador no puede leer ni escribir esta tabla.

create table if not exists public.push_suscripciones (
  id             bigint generated always as identity primary key,
  usuario_id     uuid        not null,
  endpoint       text        not null unique,
  p256dh         text        not null,
  auth           text        not null,
  user_agent     text,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index if not exists push_suscripciones_usuario_idx on public.push_suscripciones (usuario_id, actualizado_en desc);

alter table public.push_suscripciones enable row level security;
