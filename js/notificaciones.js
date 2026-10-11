const API = '/api/notificaciones';
const TZ = 'America/Caracas';
const CATS = {
    empresa: { nombre: 'Empresa', icono: 'fa-building' },
    sistema: { nombre: 'Sistema', icono: 'fa-gear' },
};
const TABS = ['Recibidas', 'Publicar', 'Publicadas', 'Autorizaciones'];
const ESTADOS_AUT = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', usada: 'Usada', vencida: 'Vencida', cancelada: 'Cancelada' };
const REFRESCO_AUT_MS = 15000;

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, ...hijos) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...hijos); return n; };
const fechaHora = (iso) => new Date(iso).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ });
const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

/** «hace 5 minutos», «ayer»… y la fecha completa pasados 7 días. */
function relativo(iso) {
    const seg = (new Date(iso) - Date.now()) / 1000, a = Math.abs(seg);
    if (a < 60) return 'justo ahora';
    if (a < 3600) return rtf.format(Math.round(seg / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(seg / 3600), 'hour');
    if (a < 7 * 86400) return rtf.format(Math.round(seg / 86400), 'day');
    return fechaHora(iso);
}

const S = { aut: { pendientes: [], recientes: [] }, recibidas: [], publicadas: [], totalUsuarios: 0, tab: 'Recibidas', esAdmin: false, esSysadmin: false };
let avisoT;

function aviso(msg, error = false) {
    const n = $('#aviso');
    n.textContent = msg; n.hidden = false; n.style.background = error ? 'var(--danger)' : '';
    clearTimeout(avisoT); avisoT = setTimeout(() => (n.hidden = true), 4500);
}

async function api(url, cuerpo, reintentar = true) {
    const r = await fetch(url, {
        credentials: 'same-origin', method: cuerpo ? 'POST' : 'GET',
        headers: { Accept: 'application/json', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    if (r.status === 401) {
        if (reintentar && (await fetch('/api/sesion', { credentials: 'same-origin', cache: 'no-store' }).then((x) => x.ok).catch(() => false)))
            return api(url, cuerpo, false);
        location.replace('/login.html?next=' + encodeURIComponent(location.pathname));
        throw new Error('Sesión expirada');
    }
    const d = await r.json().catch(() => null);
    if (!r.ok || d?.status !== 'ok') throw new Error(d?.message || 'No se pudo completar la operación.');
    return d;
}

//--- TARJETA ---//
/** Tarjeta de una notificación. El texto siempre entra como textContent (nunca HTML). */
function tarjeta(n, { vista = false } = {}) {
    const cat = CATS[n.categoria] || CATS.empresa;
    const nueva = !vista && n.leida === false;
    const pie = el('div', { className: 'notif-pie' }, el('small', { textContent: `Publicado por ${n.autor}` }));
    if (nueva) {
        const b = el('button', { type: 'button', className: 'btn btn-ghost' }, el('i', { className: 'fas fa-check' }), ' Marcar como leída');
        b.dataset.id = n.id;
        pie.append(b);
    }
    return el('article', { className: `notif cat-${n.categoria}${nueva ? ' no-leida' : ''}` },
        el('div', { className: 'notif-ico' }, el('i', { className: `fas ${cat.icono}` })),
        el('div', { className: 'notif-body' },
            el('div', { className: 'notif-cab' },
                el('span', { className: 'cat-badge', textContent: cat.nombre }),
                nueva ? el('span', { className: 'punto-nueva', textContent: 'Nueva' }) : '',
                el('time', { dateTime: n.creado_en, textContent: relativo(n.creado_en), title: fechaHora(n.creado_en) })),
            el('h3', { textContent: n.titulo }),
            el('p', { className: 'notif-msg', textContent: n.mensaje }),
            pie));
}

//--- RECIBIDAS ---//
function filtradas() {
    const cat = $('#fCategoria').value, soloNuevas = $('#fEstado').value === 'no-leidas';
    return S.recibidas.filter((n) => (!cat || n.categoria === cat) && (!soloNuevas || !n.leida));
}

function pintarRecibidas() {
    const lista = filtradas(), sinLeer = S.recibidas.filter((n) => !n.leida).length;
    $('#contR').textContent = lista.length;
    $('#nNoLeidas').textContent = sinLeer;
    $('#nNoLeidas').hidden = sinLeer === 0;
    $('#btnLeerTodas').hidden = sinLeer === 0;
    $('#listaR').replaceChildren(...lista.map((n) => tarjeta(n)));
    $('#vacioR').hidden = lista.length > 0;
    $('#vacioRTxt').textContent = S.recibidas.length
        ? 'No hay notificaciones con estos filtros.'
        : 'Todavía no hay notificaciones.';
}

async function cargarRecibidas() {
    try {
        const d = await api(API);
        S.recibidas = d.data;
        pintarRecibidas();
    } catch (e) { aviso(e.message, true); }
}

async function marcarLeida(id) {
    try {
        await api(API, { accion: 'leer', id });
        const n = S.recibidas.find((x) => x.id === id);
        if (n) n.leida = true;
        pintarRecibidas();
    } catch (e) {
        aviso(e.message, true);
        if (/ya no existe/i.test(e.message)) cargarRecibidas();
    }
}

async function marcarTodas() {
    try {
        await api(API, { accion: 'leer_todas' });
        S.recibidas.forEach((n) => (n.leida = true));
        pintarRecibidas();
    } catch (e) { aviso(e.message, true); }
}

//--- PUBLICADAS ---//
function filaPublicada(n) {
    const cat = CATS[n.categoria] || CATS.empresa;
    const b = el('button', { type: 'button', className: 'danger', title: 'Eliminar notificación', ariaLabel: 'Eliminar notificación' },
        el('i', { className: 'fas fa-trash' }), el('span', { className: 'lbl', textContent: 'Eliminar' }));
    b.dataset.id = n.id;
    return el('tr', {},
        el('td', { textContent: fechaHora(n.creado_en) }),
        el('td', {}, el('span', { className: `cat-badge cat-${n.categoria}`, textContent: cat.nombre })),
        el('td', { className: 'celda-titulo' }, el('div', { className: 'titulo-fila', textContent: n.titulo }), el('span', { className: 'sub', textContent: n.mensaje })),
        el('td', { textContent: n.autor }),
        el('td', { className: 'n leidas-n', textContent: `${n.lecturas} / ${S.totalUsuarios}` }),
        el('td', { className: 'c' }, el('div', { className: 'acts' }, b)));
}

function pintarPublicadas() {
    $('#contP').textContent = S.publicadas.length;
    $('#alcanceP').textContent = S.esSysadmin ? 'Todas las publicaciones' : 'Solo las que tú publicaste';
    $('#vacioP').hidden = S.publicadas.length > 0;
    $('#filasP').closest('.table-wrap').hidden = S.publicadas.length === 0;
    $('#filasP').replaceChildren(...S.publicadas.map(filaPublicada));
}

async function cargarPublicadas() {
    try {
        const d = await api(`${API}?modo=publicadas`);
        S.publicadas = d.data; S.totalUsuarios = d.total_usuarios;
        pintarPublicadas();
    } catch (e) { aviso(e.message, true); }
}

async function eliminar(id) {
    if (!confirm('¿Eliminar esta notificación? Dejará de aparecer en la bandeja de todos los usuarios.')) return;
    try {
        await api(API, { accion: 'eliminar', id });
        aviso('Notificación eliminada.');
        await Promise.all([cargarPublicadas(), cargarRecibidas()]);
    } catch (e) { aviso(e.message, true); }
}

//--- PUBLICAR ---//
function borrador() {
    return {
        categoria: $('#nCategoria').value, titulo: $('#nTitulo').value.trim(), mensaje: $('#nMensaje').value.trim(),
    };
}

function vistaPrevia() {
    const b = borrador();
    $('#nContador').textContent = `${$('#nMensaje').value.length} / 1000`;
    $('#vistaPrevia').replaceChildren(tarjeta({
        ...b, titulo: b.titulo || 'Título de la notificación', mensaje: b.mensaje || 'Aquí aparecerá el mensaje.',
        autor: Auth.usuario?.nombre || 'Tú', creado_en: new Date().toISOString(),
    }, { vista: true }));
}

function errorForm(msg) {
    const e = $('#errNotif');
    e.textContent = msg || ''; e.hidden = !msg;
}

function validar(b) {
    if (b.titulo.length < 3) return ['nTitulo', 'El título debe tener al menos 3 caracteres.'];
    if (b.mensaje.length < 3) return ['nMensaje', 'Escribe el mensaje que verán los usuarios.'];
    if (b.categoria === 'sistema' && !S.esSysadmin) return ['nCategoria', 'Los avisos del sistema solo los publica el sysadmin.'];
    return null;
}

function pedirConfirmacion(ev) {
    ev.preventDefault();
    const b = borrador(), fallo = validar(b);
    ['nTitulo', 'nMensaje', 'nCategoria'].forEach((id) => $('#' + id).removeAttribute('aria-invalid'));
    if (fallo) {
        $('#' + fallo[0]).setAttribute('aria-invalid', 'true'); $('#' + fallo[0]).focus();
        return errorForm(fallo[1]);
    }
    errorForm('');
    $('#resumenConf').replaceChildren(tarjeta({ ...b, autor: Auth.usuario?.nombre || 'Tú', creado_en: new Date().toISOString() }, { vista: true }));
    $('#dlgConfirmar').showModal();
}

async function publicar(ev) {
    ev.preventDefault();
    const btn = $('#btnConfirmar');
    btn.disabled = true;
    try {
        await api(API, { accion: 'crear', ...borrador() });
        $('#dlgConfirmar').close();
        $('#formNotif').reset();
        vistaPrevia();
        aviso('Notificación publicada para todo el personal.');
        cargarRecibidas();
        cambiarTab('Publicadas');
    } catch (e) {
        $('#dlgConfirmar').close();
        errorForm(e.message);
    } finally { btn.disabled = false; }
}

//--- AUTORIZACIONES ---//
function tarjetaAut(a) {
    const aprobada = a.estado === 'aprobada';
    const btn = (accion, texto, icono, clase) => {
        const b = el('button', { type: 'button', className: `btn ${clase}` }, el('i', { className: `fas ${icono}` }), ` ${texto}`);
        b.dataset.id = a.id; b.dataset.accion = accion;
        return b;
    };
    return el('article', { className: `notif cat-empresa${aprobada ? '' : ' no-leida'}` },
        el('div', { className: 'notif-ico' }, el('i', { className: 'fas fa-key' })),
        el('div', { className: 'notif-body' },
            el('div', { className: 'notif-cab' },
                el('span', { className: 'cat-badge', textContent: a.accion_nombre }),
                aprobada ? el('span', { className: 'punto-nueva', textContent: 'Aprobada · código sin usar' }) : '',
                el('time', { dateTime: a.creada_en, textContent: relativo(a.creada_en), title: fechaHora(a.creada_en) })),
            el('h3', { textContent: a.resumen }),
            el('p', { className: 'notif-msg', textContent: `Motivo: ${a.motivo}` }),
            el('div', { className: 'notif-pie' },
                el('small', { textContent: `Solicita: ${a.solicitante_nombre || '—'}` }),
                btn('rechazar', 'Rechazar', 'fa-xmark', 'btn-ghost'),
                btn('aprobar', aprobada ? 'Generar otro código' : 'Aprobar y generar código', 'fa-key', 'btn-primary'))));
}

function pintarAutorizaciones() {
    const { pendientes, recientes } = S.aut;
    const porAtender = pendientes.filter((a) => a.estado === 'pendiente').length;
    $('#nAutPend').textContent = porAtender; $('#nAutPend').hidden = porAtender === 0;
    $('#contAP').textContent = pendientes.length;
    $('#listaAP').replaceChildren(...pendientes.map(tarjetaAut));
    $('#vacioAP').hidden = pendientes.length > 0;
    $('#filasAR').closest('.table-wrap').hidden = recientes.length === 0;
    $('#vacioAR').hidden = recientes.length > 0;
    $('#filasAR').replaceChildren(...recientes.map((a) => el('tr', {},
        el('td', { textContent: fechaHora(a.creada_en) }),
        el('td', { className: 'celda-titulo' }, el('div', { className: 'titulo-fila', textContent: a.resumen }), el('span', { className: 'sub', textContent: a.motivo })),
        el('td', { textContent: a.solicitante_nombre || '—' }),
        el('td', { textContent: a.resuelta_por_nombre || '—' }),
        el('td', { textContent: ESTADOS_AUT[a.estado] || a.estado }))));
}

async function cargarAutorizaciones(silencioso = false) {
    try {
        const d = await api(`${API}?modo=autorizaciones`);
        S.aut = { pendientes: d.pendientes, recientes: d.recientes };
        pintarAutorizaciones();
    } catch (e) { if (!silencioso) aviso(e.message, true); }
}

async function resolverAutorizacion(id, accion) {
    try {
        if (accion === 'rechazar') {
            if (!confirm('¿Rechazar esta solicitud?')) return;
            await api(API, { accion: 'autorizacion_rechazar', id });
            aviso('Solicitud rechazada.');
        } else {
            const d = await api(API, { accion: 'autorizacion_aprobar', id });
            const hasta = new Date(d.expira_en).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
            $('#codigoInfo').textContent = `${d.resumen} — solicita ${d.solicitante || 'el usuario'}.`;
            $('#codigoValor').textContent = d.codigo;
            $('#codigoVence').textContent = `Vale ${d.vigencia_min} minutos (hasta las ${hasta}) y se puede usar una sola vez. No volverá a mostrarse; si lo pierdes, genera otro.`;
            $('#dlgCodigo').showModal();
            $('#dlgCodigo').addEventListener('close', () => { $('#codigoValor').textContent = ''; }, { once: true });
        }
        await cargarAutorizaciones();
    } catch (e) { aviso(e.message, true); cargarAutorizaciones(true); }
}

//--- PESTAÑAS ---//
function cambiarTab(id) {
    S.tab = id;
    for (const t of TABS) {
        const tab = $(`#tab${t}`), pan = $(`#pan${t}`);
        if (!tab || !pan) continue;
        tab.setAttribute('aria-selected', String(t === id));
        pan.hidden = t !== id;
    }
    if (id === 'Publicadas') cargarPublicadas();
    if (id === 'Recibidas') cargarRecibidas();
    if (id === 'Autorizaciones') cargarAutorizaciones();
}

//--- INICIO ---//
(async () => {
    const usuario = await Auth.listo;
    if (!usuario) return;
    S.esAdmin = Auth.tieneNivel('admin');
    S.esSysadmin = Auth.tieneNivel('sysadmin');

    for (const t of TABS) $(`#tab${t}`)?.addEventListener('click', () => cambiarTab(t));
    $('#fCategoria').addEventListener('change', pintarRecibidas);
    $('#fEstado').addEventListener('change', pintarRecibidas);
    $('#btnLeerTodas').addEventListener('click', marcarTodas);
    $('#listaR').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-id]');
        if (b) marcarLeida(Number(b.dataset.id));
    });

    if (S.esAdmin) {
        $('#formNotif').addEventListener('submit', pedirConfirmacion);
        $('#formNotif').addEventListener('input', () => { errorForm(''); vistaPrevia(); });
        $('#formConfirmar').addEventListener('submit', publicar);
        $('#dlgConfirmar [data-cerrar]').addEventListener('click', () => $('#dlgConfirmar').close());
        $('#filasP').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-id]');
            if (b) eliminar(Number(b.dataset.id));
        });
        if (!S.esSysadmin) $('#notaCategoria').textContent =
            'La recibirán todos los usuarios. Los avisos de cambios del sistema solo los publica el sysadmin.';
        vistaPrevia();
        $('#listaAP').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-accion]');
            if (b && !b.disabled) { b.disabled = true; resolverAutorizacion(Number(b.dataset.id), b.dataset.accion).finally(() => { b.disabled = false; }); }
        });
        cargarAutorizaciones(true);     // para el número de la pestaña
        setInterval(() => { if (!document.hidden) cargarAutorizaciones(true); }, REFRESCO_AUT_MS);
    }

    // Si se abre con #publicar (p. ej. desde el inicio) cae directo en la pestaña de publicación
    cambiarTab(!S.esAdmin ? 'Recibidas' : location.hash === '#publicar' ? 'Publicar' : location.hash === '#autorizaciones' ? 'Autorizaciones' : 'Recibidas');
    document.body.classList.add('is-ready');
})();
