# Correcciones de la auditoría

| # | Hallazgo | Qué se hizo | Dónde |
|---|---|---|---|
| 1 | Cifras distintas para el mismo mes | Una sola definición: **venta = `total_usd`** (cobrado, con descuento por divisas). Administrador, Reportes y Comisiones la importan; el precio de lista se muestra aparte y rotulado | `api/_ventas.py`, `administrador.py`, `reportes.py`, `_comisiones.py`, `js/administrador.js` |
| 2 | Tasa «BCV» de un agregador | Ahora es la tasa **oficial** (`ve.dolarapi.com/.../oficial`) servida por `/api/tasas`; el navegador ya no consulta terceros. Referencia vieja o caída ⇒ no se bloquea la venta. El PDF dice «tasa de cambio» (configurable) | `_referencias.py`, `tasas.py`, `js/utils/api.js`, `_factura_pdf.py` |
| 3 | Código de autorización quemado antes de la operación | El código se consume **dentro de la misma transacción SQL** que anula/mueve stock; si falla, se revierte y sigue vigente. Probado contra Postgres (éxito, fallo, reuso, carrera) | `sql/autorizaciones_atomico.sql`, `_autorizaciones.py`, `historial.py`, `inventario.py` |
| 4 | Duplicada con PDF distinto | El PDF faltante se regenera **desde la BD** con la fecha original (no con la petición ni la hora actual). `factura-pdf` también regenera si falta | `_whatsapp.py`, `_factura_pdf.py`, `enviar-factura.py`, `factura-pdf.py` |
| 5 | Usuarios incompletos | Desactivar/reactivar, cambiar rol y restablecer clave, con reglas de jerarquía y UI | `_usuarios.py`, `administrador.py`, `js/administrador.js` |
| 6 | 2 llamadas a Supabase por petición | Caché de sesión de 30 s por instancia (token con hash, tope de tamaño, nunca cachea cuentas inactivas ni con clave pendiente) | `_comun.py` |
| 7 | Login | Intento registrado **antes** de probar la clave (falla cerrado); límite por correo+IP para que no se pueda bloquear a un tercero; purga automática y SQL con índices/pg_cron | `_comun.py`, `login.py`, `cambiar-clave.py`, `sql/login_intentos.sql` |
| 8 | Egresos sin auditoría | Borrado lógico con quién, cuándo y motivo; el egreso de una comisión no se puede borrar; trigger contra `DELETE` físico | `administrador.py`, `sql/egresos_borrado_logico.sql` |
| 9 | Código duplicado en el frontend | `apiJson` único en `api.js` (5 copias eliminadas). `venta.js` con lo compartido entre Facturación y Pedidos (unas 450 líneas menos entre Facturación y Pedidos; `BANCOS` unificado) | `js/utils/api.js`, `js/utils/venta.js` |
| 10 | Autodetección de columna de fecha | Eliminada: siempre `created_at` (1 consulta en vez de varias que fallaban) | `administrador.py` |
| 11 | Despliegue | Versiones fijas, Python 3.12, `.gitignore`, `README.md`, `.env.example`, 112 tests de backend + 13 de frontend. Se corrigió `fromisoformat` (exigía 3.11+) con `parse_iso` | `requirements*.txt`, `.python-version`, `tests/` |
| 12 | Terceros | Font Awesome y fuentes alojados en `assets/vendor`; CSP sin dominios externos y con `object-src 'none'`; cabeceras de caché para estáticos | `vercel.json`, `assets/vendor/`, HTML |

## Antes de desplegar

1. Ejecuta en Supabase, en este orden: `sql/egresos_borrado_logico.sql` (**obligatorio**), `sql/autorizaciones_atomico.sql`,
   `sql/login_intentos.sql`; luego revisa `sql/verificar_produccion.sql` (bloques 9–11).
2. Revisa `.env.example` (opcionales nuevos: `SESION_CACHE_SEGUNDOS`, `TASA_REF_MAX_DIAS`, `PDF_ETIQUETA_TASA`).
3. `/api/tasa-usdt` desapareció (lo reemplaza `/api/tasas`); si algo externo lo llamaba, actualízalo.


# Ajustes de operación (formatos y roles)

| Cambio | Qué se hizo | Dónde |
|---|---|---|
| Tipografía de los números | Importes, KPI y stock pasan de Cormorant Garamond (cifras de estilo antiguo) a **Inter** con cifras alineadas (`--font-num`, clase `.num`) | `global.css`, `historial.css`, `cobros.css`, `administrador.css`, `inventario-ui.css`, `factura-modal.css` |
| Formatos con datos de la empresa | Todos los PDF (nota de entrega y comprobante de egreso) llevan **logo**, nombre, RIF, dirección, teléfono y correo, y la franja de marca. La vista previa de factura muestra logo y nombre | `api/_marca.py`, `api/_logo.py`, `api/_factura_pdf.py`, `api/_egreso_pdf.py`, `js/factura-modal.js` |
| Rol «personal» → «Vendedor» | Cambia el **nombre en pantalla**; la clave interna sigue siendo `personal` (base de datos y permisos no se tocan) | `js/auth-guard.js` (`Auth.etiquetaRol`), `js/index.js`, `js/administrador.js` |

**Datos de la empresa:** en Vercel define `EMPRESA_NOMBRE`, `EMPRESA_RIF`, `EMPRESA_DIRECCION`, `EMPRESA_TELEFONO` y `EMPRESA_EMAIL`; lo que quede vacío no se imprime.
**Logo propio:** `pip install pillow && python scripts/generar_logo_pdf.py ruta/a/tu-logo.png` (regenera `api/_logo.py`). Hoy usa la «K» de la app.
