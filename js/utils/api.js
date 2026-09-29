/* Llamadas al servidor. Usan la sesión (cookie HttpOnly) creada por /api/login. */

const ENDPOINTS = {
    inventario: '/api/inventario',
    clientes: '/api/clientes',
    factura: '/api/enviar-factura',
    sesion: '/api/sesion',
    tasa: 'https://open.er-api.com/v6/latest/USD',
};

const irALogin = () => location.replace('/login.html?next=' + encodeURIComponent(location.pathname));

// El access token dura ~1 h; /api/sesion lo renueva con el refresh token.
const renovarSesion = () =>
    fetch(ENDPOINTS.sesion, { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.ok).catch(() => false);

async function request(url, opciones = {}, reintentar = true) {
    const headers = { Accept: 'application/json', ...(opciones.body ? { 'Content-Type': 'application/json' } : {}) };
    const r = await fetch(url, { credentials: 'same-origin', ...opciones, headers });
    if (r.status === 401) {
        // Sesión vencida: se intenta renovar UNA vez antes de sacar al usuario (no perder la factura en curso).
        if (reintentar && (await renovarSesion())) return request(url, opciones, false);
        irALogin();
        throw new Error('Sesión expirada');
    }
    return r;
}

const leerJson = async (r) => ((r.headers.get('content-type') || '').includes('application/json') ? r.json() : null);

//--- TASA DEL DÍA ---//
export async function obtenerTasa() {
    try {
        const d = await (await fetch(ENDPOINTS.tasa)).json();
        return Number(d?.rates?.VES) || 0;
    } catch {
        return 0; // sin conexión: se mantiene la tasa guardada o la manual
    }
}

//--- INVENTARIO ---//
/** GET /api/inventario?q= → [{id,nombre,color,calibre,cantidad,precio_detal,precio_mayor,cantidad_mayor}] */
export async function buscarProductos(q, signal) {
    try {
        const r = await request(`${ENDPOINTS.inventario}?q=${encodeURIComponent(q)}`, { signal });
        const d = r.ok ? await leerJson(r) : null;
        return Array.isArray(d) ? d : d?.data ?? [];
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        return [];
    }
}

//--- CLIENTES ---//
/** GET /api/clientes?cedula= → {nombre,apellido,telefono} | 404 */
export async function buscarCliente(cedula) {
    try {
        const r = await request(`${ENDPOINTS.clientes}?cedula=${encodeURIComponent(cedula)}`);
        const d = r.ok ? await leerJson(r) : null;
        return d?.data ?? d;
    } catch {
        return null;
    }
}

export const guardarCliente = (c) =>
    request(ENDPOINTS.clientes, { method: 'POST', body: JSON.stringify(c), keepalive: true }).catch(() => { });

//--- FACTURA ---//
/** POST /api/enviar-factura. Lanza Error con el mensaje que se muestra al usuario. */
export async function enviarFactura(payload) {
    const r = await request(ENDPOINTS.factura, { method: 'POST', body: JSON.stringify(payload) });
    if (r.status === 404) throw new Error('El servicio de facturación no está disponible en el servidor.');
    const d = await leerJson(r);
    if (!d) throw new Error('El servidor no devolvió una respuesta válida.');
    // Reintento de una factura que ya se había guardado (misma id): se trata como éxito.
    if (d.status === 'duplicada') return d;
    if (!r.ok || d.status === 'error') throw new Error(d.message || d.error || 'Error desconocido del servidor.');
    return d;
}