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
