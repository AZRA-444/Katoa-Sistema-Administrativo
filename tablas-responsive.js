/* Tablas responsive (≤ 720 px: cada fila pasa a ser una tarjeta).
 *
 * Copia el texto de cada <th> en el atributo data-label de las celdas de su columna, y marca la tabla con
 * .tabla-resp (los estilos están en assets/css/responsive.css). Así no hay que tocar cada módulo: sirve
 * para las filas que ya existen y para las que los scripts pintan después (MutationObserver).
 *
 * · Una celda que ya trae data-label no se toca (inventario.js y reportes.js lo definen a mano).
 * · Para excluir una tabla: <table data-no-resp>.
 */
(() => {
    'use strict';

    const limpio = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    function etiquetas(tabla) {
        const cab = tabla.tHead && tabla.tHead.rows[tabla.tHead.rows.length - 1];
        if (!cab) return null;
        const lista = [];
        for (const th of cab.cells) {
            const texto = limpio(th.dataset.label || th.textContent);
            for (let i = 0; i < (th.colSpan || 1); i++) lista.push(texto);
        }
        return lista;
    }

    function preparar(tabla) {
        if (tabla.hasAttribute('data-no-resp')) return;
        const lista = etiquetas(tabla);
        if (!lista) return;
        tabla.classList.add('tabla-resp');
        if (tabla.parentElement && tabla.parentElement.classList.contains('table-wrap')) {
            tabla.parentElement.classList.add('tabla-resp-wrap');
        }
        const grupos = [...tabla.tBodies];
        if (tabla.tFoot) grupos.push(tabla.tFoot);
        for (const g of grupos) {
            for (const tr of g.rows) {
                let col = 0;
                for (const td of tr.cells) {
                    if (td.colSpan > 1) { col += td.colSpan; continue; }   // «Cargando…», «Sin resultados»: sin etiqueta
                    if (!td.hasAttribute('data-label') && lista[col]) td.setAttribute('data-label', lista[col]);
                    col += 1;
                }
            }
        }
    }

    const pendientes = new Set();
    let programado = false;
    const procesar = () => {
        programado = false;
        for (const t of pendientes) preparar(t);
        pendientes.clear();
    };
    const encolar = (nodo) => {
        const el = nodo && nodo.nodeType === 1 ? nodo : nodo && nodo.parentElement;
        if (!el) return;
        const t = el.tagName === 'TABLE' ? el : el.closest('table');
        if (t) pendientes.add(t);
        else if (el.querySelectorAll) el.querySelectorAll('table').forEach((x) => pendientes.add(x));
        if (pendientes.size && !programado) { programado = true; requestAnimationFrame(procesar); }
    };

    const iniciar = () => {
        document.querySelectorAll('table').forEach((t) => pendientes.add(t));
        procesar();
        new MutationObserver((lote) => {
            for (const m of lote) {
                encolar(m.target);
                m.addedNodes.forEach(encolar);
            }
        }).observe(document.body, { childList: true, subtree: true });
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar, { once: true });
    else iniciar();
})();
