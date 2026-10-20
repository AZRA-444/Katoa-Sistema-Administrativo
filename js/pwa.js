/* PWA: registro del service worker, aviso de actualización y ayuda para instalar.
 * Script clásico y sin HTML inline (la CSP solo permite script-src 'self'). */
(() => {
    'use strict';

    const CLAVE_OCULTO = 'katoa-pwa-oculto';
    const DIAS_OCULTO = 14;

    const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* modo privado */ } };
    const leer = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };

    const enModoApp = () =>
        window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: minimal-ui)').matches ||
        window.navigator.standalone === true;

    const esIOS = () =>
        /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS

    // La invitación a instalar solo se muestra en la entrada (login / inicio)
    const ES_PAGINA_DE_ENTRADA = ['/', '/index.html', '/login.html'].includes(location.pathname);

    const ocultoHace = () => {
        const t = Number(leer(CLAVE_OCULTO));
        return t ? (Date.now() - t) / 86400000 : Infinity;
    };

    function crearTarjeta(titulo, texto, botones) {
        const caja = document.createElement('div');
        caja.className = 'pwa-card';
        caja.setAttribute('role', 'dialog');
        caja.setAttribute('aria-label', titulo);

        const t = document.createElement('strong');
        t.textContent = titulo;
        const p = document.createElement('p');
        p.textContent = texto;
        const acciones = document.createElement('div');
        acciones.className = 'pwa-card-acciones';

        for (const b of botones) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = b.primario ? 'pwa-btn pwa-btn-primario' : 'pwa-btn';
            btn.textContent = b.texto;
            btn.addEventListener('click', () => b.accion(caja));
            acciones.appendChild(btn);
        }
        caja.append(t, p, acciones);
        document.body.appendChild(caja);
        return caja;
    }

    const posponer = (caja) => {
        guardar(CLAVE_OCULTO, String(Date.now()));
        caja.remove();
    };

    // ---- Actualización de la app -------------------------------------------
    let actualizando = false;

    function avisarActualizacion(worker) {
        if (document.querySelector('.pwa-card[data-tipo="update"]')) return;
        const caja = crearTarjeta('Hay una versión nueva', 'Actualiza para usar las últimas mejoras.', [
            { texto: 'Después', accion: (c) => c.remove() },
            {
                texto: 'Actualizar',
                primario: true,
                accion: () => {
                    actualizando = true;
                    worker.postMessage({ type: 'SKIP_WAITING' });
                },
            },
        ]);
        caja.dataset.tipo = 'update';
    }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (actualizando) location.reload();
        });

        window.addEventListener('load', () => {
            navigator.serviceWorker
                .register('/sw.js', { scope: '/' })
                .then((reg) => {
                    if (reg.waiting && navigator.serviceWorker.controller) avisarActualizacion(reg.waiting);
                    reg.addEventListener('updatefound', () => {
                        const nuevo = reg.installing;
                        if (!nuevo) return;
                        nuevo.addEventListener('statechange', () => {
                            if (nuevo.state === 'installed' && navigator.serviceWorker.controller) {
                                avisarActualizacion(nuevo);
                            }
                        });
                    });
                    // Al volver a la app (típico en móvil) se busca una versión nueva
                    document.addEventListener('visibilitychange', () => {
                        if (!document.hidden) reg.update().catch(() => { });
                    });
                })
                .catch(() => { /* sin SW la app sigue funcionando como web normal */ });
        });
    }

    // ---- Instalar: Android / Chrome / Edge (PC) -----------------------------
    let eventoInstalar = null;

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        eventoInstalar = e;
        if (!ES_PAGINA_DE_ENTRADA || enModoApp() || ocultoHace() < DIAS_OCULTO) return;
        if (document.querySelector('.pwa-card[data-tipo="instalar"]')) return;

        const caja = crearTarjeta('Instala Katoa', 'Ábrela como una app, desde tu pantalla de inicio o escritorio.', [
            { texto: 'Ahora no', accion: posponer },
            {
                texto: 'Instalar',
                primario: true,
                accion: async (c) => {
                    c.remove();
                    if (!eventoInstalar) return;
                    eventoInstalar.prompt();
                    await eventoInstalar.userChoice.catch(() => { });
                    eventoInstalar = null;
                },
            },
        ]);
        caja.dataset.tipo = 'instalar';
    });

    window.addEventListener('appinstalled', () => {
        eventoInstalar = null;
        document.querySelectorAll('.pwa-card[data-tipo="instalar"]').forEach((c) => c.remove());
    });

    // ---- Instalar: iPhone / iPad (Safari no ofrece botón automático) --------
    window.addEventListener('load', () => {
        if (!ES_PAGINA_DE_ENTRADA || !esIOS() || enModoApp() || ocultoHace() < DIAS_OCULTO) return;
        const caja = crearTarjeta(
            'Instala Katoa en tu iPhone',
            'Toca el botón Compartir (cuadrado con una flecha hacia arriba) y elige «Añadir a pantalla de inicio».',
            [{ texto: 'Entendido', primario: true, accion: posponer }]
        );
        caja.dataset.tipo = 'instalar';
    });
})();
