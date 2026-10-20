# Katoa — Sistema administrativo

Facturación, pedidos, inventario, cobros a crédito, devoluciones, reportes, comisiones y administración de usuarios.
Frontend estático (HTML + JS en módulos ES, sin build) y backend en funciones Python de Vercel sobre Supabase
(Postgres + Auth + Storage). El navegador **nunca** habla con Supabase: todo pasa por `/api/*`.

## Estructura

```
api/                 Funciones de Vercel (Python). Los archivos que empiezan por «_» son módulos auxiliares.
  _comun.py            sesión (con caché), cookies, límite de login, utilidades HTTP
  _ventas.py           DEFINICIÓN ÚNICA de «venta» (ver abajo)
  _autorizaciones.py   códigos de un solo uso; se consumen dentro de la transacción SQL de la operación
  _referencias.py      tasas de referencia: BCV oficial y USDT (ve.dolarapi.com)
  _factura_pdf.py, _whatsapp.py, _usuarios.py, _comisiones.py, _cobros.py, _creditos.py, _devoluciones.py
js/                  Módulos ES por página + js/utils/
  utils/api.js         ÚNICA capa de llamadas al servidor (apiJson, tasas, factura, reportes…)
  utils/venta.js       lógica compartida por Facturación y Pedidos
assets/              css, img y vendor/ (Font Awesome y fuentes alojados aquí: sin CDN de terceros)
sql/                 Migraciones y verificaciones (ver «Base de datos»)
tests/               pytest (backend), node --test (frontend) y SQL de prueba
```

### Límite de 12 funciones (plan Hobby de Vercel)

Cada `api/*.py` **sin** guion bajo inicial cuenta como una función. Hoy hay exactamente 12: `administrador`, `cambiar-clave`,
`enviar-factura`, `factura-pdf`, `guardar-cliente`, `historial`, `inventario`, `login`, `notificaciones`, `reportes`,
`sesion` y `tasas`. Para añadir lógica nueva, ponla en un módulo `_algo.py` y llámala desde un endpoint existente.

## Definición de «venta»

| Término | Campo | Significado |
|---|---|---|
| **Venta / Ingreso** | `facturas.total_usd` | Lo cobrado o por cobrar, **ya con el descuento por pago en divisas (USDT)** |
| Precio de lista | `facturas.subtotal_usd` | El mismo pedido sin descuento |
| Descuento | lista − venta | Lo que ahorró el cliente al pagar en divisas |

Una factura cuenta salvo que esté anulada. Administrador, Reportes y Comisiones usan `api/_ventas.py`, así el mismo mes da la
misma cifra en todas partes. El único reporte a precio de lista es «Productos» y así se rotula. Regla para pantallas nuevas:
si dice «ventas» o «ingresos», usa `venta_usd`; si muestra lista, rotúlalo.

## Tasas de cambio

* **BCV**: tasa **oficial** (`https://ve.dolarapi.com/v1/dolares/oficial`). Antes salía de `open.er-api.com`, un agregador de
  mercado. El navegador la pide a `/api/tasas?tipo=bcv`; ya no consulta terceros.
* **USDT**: dólar paralelo (`/api/tasas?tipo=usdt`).
* El servidor valida la tasa de cada factura contra la oficial (`TASA_TOLERANCIA_PCT`, 10 % por defecto). Si la referencia
  no responde o tiene más de `TASA_REF_MAX_DIAS` días, **no se bloquea** la venta: se acepta la tasa enviada.
* El PDF rotula la tasa como «tasa de cambio» (puede haberla ajustado el vendedor). Para «tasa BCV»: `PDF_ETIQUETA_TASA="tasa BCV"`.

## Base de datos (Supabase → SQL Editor)

Ejecuta **antes de desplegar** el código que las usa:

| Archivo | Para qué |
|---|---|
| `sql/comisiones_pago_atomico.sql` | pago de comisiones atómico (ya existente) |
| `sql/inventario_llegada_precios.sql` | `inv_llegada_con_precios`: registra la llegada y actualiza los precios de venta en una sola transacción (**ejecutar antes de desplegar** el cambio de llegada) |
| `sql/autorizaciones_atomico.sql` | consume el código de autorización **dentro de la misma transacción** que anula/mueve stock |
| `sql/egresos_borrado_logico.sql` | columnas `eliminado_en/por/motivo` y bloqueo del `DELETE` físico en `egresos` |
| `sql/login_intentos.sql` | índices y purga diaria (pg_cron si está disponible) de `login_intentos` |
| `sql/verificar_produccion.sql` | solo lectura: comprueba RLS, permisos, buckets y que lo anterior esté aplicado |

Las RPC `anular_factura` e `inv_mover` (y el resto del esquema) no están en este repositorio; las funciones nuevas las
**envuelven** sin reescribirlas. Si tus parámetros se llaman distinto, ajusta solo las dos líneas `execute format(...)` de
`autorizaciones_atomico.sql`. Sin esa migración el backend sigue funcionando con el comportamiento anterior y deja un aviso
en los logs. `egresos_borrado_logico.sql` **sí** es imprescindible antes del despliegue (la lectura de egresos filtra por
`eliminado_en`).

## Variables de entorno

Ver `.env.example`. Obligatorias: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEY`, `AUTORIZACION_SECRET`.

## Seguridad: decisiones que conviene conocer

* **Sesión**: cada petición valida el token con Supabase y lee el perfil; se recuerda `SESION_CACHE_SEGUNDOS` (30 s) por
  instancia. Consecuencia: desactivar a un usuario o cerrar su sesión puede tardar hasta ese tiempo en notarse en otras
  instancias. Nunca se cachea una cuenta inactiva ni con cambio de clave pendiente.
* **Login**: el intento se registra **antes** de probar la clave (si no se puede registrar, se rechaza). Límites: 5 fallos por
  correo+IP, 20 por IP, y un tope de 30 por correo desde cualquier IP que exime a las IP donde ese correo ya entró en los
  últimos 14 días. Así conocer un correo ya no basta para bloquear a su dueño.
* **Autorizaciones**: el código es de un solo uso, vence a los 10 min y se bloquea a los 3 intentos. Si la operación falla
  (stock, variante inactiva) se revierte todo y el código sigue vigente.
* **Usuarios**: desde Administrador → Usuarios se puede desactivar/reactivar, cambiar rol y restablecer clave. Nadie puede
  hacerlo sobre sí mismo ni sobre un rol que no podría asignar.
* **Egresos**: el borrado es lógico (quién, cuándo y motivo). Los egresos que son pago de una comisión no se pueden eliminar.
* **CSP**: `default-src 'self'`, sin dominios de terceros, `object-src 'none'`.

## Desarrollo y pruebas

Python **3.12** (`.python-version`). Dependencias fijadas en `requirements.txt`.

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest                 # backend: sesión/caché, login, autorizaciones, tasas, PDF, usuarios, ventas, egresos
npm test               # frontend: lógica compartida (js/utils/venta.js), sin dependencias
```

Prueba SQL de las autorizaciones atómicas (opcional, requiere un Postgres local): ver `tests/sql/`.

## Despliegue

1. Ejecuta las migraciones SQL pendientes (tabla de arriba).
2. Configura las variables de entorno en Vercel.
3. `vercel --prod` (o push a la rama conectada).
4. Pega `sql/verificar_produccion.sql` por bloques y revisa la columna «esperado».

## Caché de estáticos

`/assets/vendor/*` es inmutable (1 año; la ruta lleva la versión). JS y CSS no llevan huella en el nombre, por eso solo se
cachean 60 s con revalidación: un caché largo podría mezclar módulos de dos despliegues y romper los `import`. Si luego
añades huellas en los nombres, puedes alargarlo.

## PWA (instalable en celular y PC)

La app se puede instalar desde el navegador (requiere HTTPS; Vercel ya lo da, y `localhost` sirve para probar).

| Archivo | Para qué |
|---|---|
| `manifest.webmanifest` | Nombre, colores, íconos y accesos directos (Nueva venta, Pedidos, Inventario) |
| `sw.js` | Service worker: guarda solo estáticos; **`/api/*` y las páginas nunca se guardan** |
| `offline.html` | Pantalla que se muestra sin internet |
| `js/pwa.js` | Registra el SW, avisa de versiones nuevas y muestra la invitación a instalar (Android/PC y guía para iOS) |
| `assets/img/icons/` | Íconos 192/512 (`any` y `maskable`), `apple-touch-icon` 180 y favicons |

Al cambiar JS/CSS/íconos en un despliegue no hace falta nada: JS y CSS se piden primero a la red. Si cambias la lista
`PRECACHE` o quieres forzar la limpieza de cachés, sube `VERSION` en `sw.js`.

Cómo instalar: **Android/Chrome** → menú ⋮ → «Instalar aplicación». **iPhone/iPad (Safari)** → Compartir → «Añadir a pantalla de inicio».
**PC (Chrome/Edge)** → ícono de instalar en la barra de direcciones, o menú → «Guardar y compartir» → «Instalar página como aplicación».

## Notificaciones push

Llegan como notificaciones nativas (también con la app cerrada) a Android, PC e iPhone/iPad (iOS 16.4+, **solo con la app instalada** en la pantalla de inicio).

**Cuándo se envían:** al publicar una notificación (a todo el personal activo, menos al autor) · al solicitar una autorización (a admin y sysadmin) · al aprobar/rechazar una solicitud (al solicitante; **nunca** incluye el código).

**Puesta en marcha (una sola vez):**
1. `python scripts/generar_vapid.py` → copia `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` (`mailto:tu-correo@dominio.com`) a las variables de entorno de Vercel. La clave privada es secreta.
2. Ejecuta `sql/push_suscripciones.sql` en el SQL Editor de Supabase.
3. Despliega. Cada usuario activa los avisos en **Notificaciones → Avisos en este dispositivo** (o con la tarjeta que aparece en el inicio).

| Archivo | Para qué |
|---|---|
| `api/_push.py` | Cifrado Web Push (RFC 8291), firma VAPID (RFC 8292) y envío. Solo usa `cryptography` y `requests` |
| `api/notificaciones.py` | `GET ?modo=push_clave`, `POST push_suscribir / push_quitar / push_probar` y los disparadores |
| `sw.js` | Muestra el aviso y, al tocarlo, abre la app en la pantalla correcta |
| `js/push.js` | Pide permiso, suscribe el dispositivo y lo mantiene al día; da de baja el dispositivo al cerrar sesión |
| `tests/test_push.py` | Cifrado contra el vector oficial del RFC, firma VAPID y validación de endpoints |

Notas: el `endpoint` que manda el navegador solo se acepta si es de Google, Mozilla, Microsoft o Apple (evita SSRF) y las suscripciones
caducadas se borran solas. Si cambias `VAPID_PRIVATE_KEY`, los dispositivos se re-suscriben solos al abrir la app. El envío ocurre
antes de responder (Vercel congela la función al terminar), con un tope de 7 s.
