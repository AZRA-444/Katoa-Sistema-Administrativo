import { API } from './config.js';

async function request(url, opciones = {}) {
  const headers = { Accept: 'application/json', ...(opciones.body ? { 'Content-Type': 'application/json' } : {}) };
  const r = await fetch(url, { credentials: 'same-origin', headers, ...opciones });
  if (r.status === 401 || r.status === 403) {
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname));
    throw new Error('Sesión expirada');
  }
  return r;
}
const leerJson = async (r) => ((r.headers.get('content-type') || '').includes('application/json') ? r.json() : null);

/** GET /api/inventario?q= → [{id,nombre,color,calibre,cantidad,precio_detal,precio_mayor,cantidad_mayor}] */
export async function buscarProductos(q, signal) {
  try {
    const r = await request(`${API.inventario}?q=${encodeURIComponent(q)}`, { signal });
    const d = r.ok ? await leerJson(r) : null;
    return Array.isArray(d) ? d : d?.data ?? [];
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return [];
  }
}

/** GET /api/clientes?cedula= → {nombre,apellido,telefono} | 404 */
export async function buscarCliente(cedula) {
  try {
    const r = await request(`${API.clientes}?cedula=${encodeURIComponent(cedula)}`);
    const d = r.ok ? await leerJson(r) : null;
    return d?.data ?? d;
  } catch {
    return null;
  }
}

export const guardarCliente = (c) =>
  request(API.clientes, { method: 'POST', body: JSON.stringify(c), keepalive: true }).catch(() => {});

export async function obtenerTasa() {
  try {
    const d = await (await fetch(API.tasa)).json();
    return Number(d?.rates?.VES) || 0;
  } catch {
    return 0;
  }
}

/** POST /api/precargar-factura */
export async function enviarFactura(payload) {
  const r = await request(API.factura, { method: 'POST', body: JSON.stringify(payload) });
  if (r.status === 404) throw new Error('El servicio de facturación no está disponible en el servidor.');
  const d = await leerJson(r);
  if (!d) throw new Error('El servidor no devolvió una respuesta válida.');
  if (!r.ok || d.status === 'error') throw new Error(d.message || 'Error desconocido del servidor.');
  return d;
}
