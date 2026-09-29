import { $ } from './dom.js';
import { usd, bs, round2 } from './format.js';
import { calcularTotales, totalLinea } from './pricing.js';
import { getState, subscribe, update } from './store.js';

export function initFactura() {
  const tbody = $('#filas'), tpl = $('#tplFila');
  const dlg = $('#dlgEditar'), form = $('#formEditar'), err = $('#editarError');
  let editId = null;

  function fila(p, tasa) {
    const tr = tpl.content.firstElementChild.cloneNode(true);
    const t = totalLinea(p);
    const set = (k, v) => { tr.querySelector(`[data-f=${k}]`).textContent = v; };
    tr.dataset.id = p.id;
    tr.classList.toggle('excluida', p.excluidoDescuento);
    set('cant', p.cantidad); set('nombre', p.nombre); set('pu', usd(p.precioUnitario));
    set('total', usd(t)); set('totalBs', bs(round2(t * tasa)));
    tr.querySelector('[data-f=bDesc]').hidden = !p.excluidoDescuento;
    tr.querySelector('[data-f=bStock]').hidden = !(p.stock != null && p.cantidad > p.stock);
    const btn = tr.querySelector('[data-act=toggle]');
    const txt = p.excluidoDescuento ? 'Volver a incluir en el descuento' : 'Excluir del descuento';
    btn.title = txt; btn.setAttribute('aria-label', txt); btn.setAttribute('aria-pressed', p.excluidoDescuento);
    btn.firstElementChild.className = `fa-solid ${p.excluidoDescuento ? 'fa-rotate-left' : 'fa-tag'}`;
    return tr;
  }

  function render(s) {
    const t = calcularTotales(s.items, s.tasa);
    tbody.replaceChildren(...s.items.map((p) => fila(p, s.tasa)));
    $('#tablaWrap').hidden = !s.items.length;
    $('#vacio').hidden = !!s.items.length;
    $('#cuenta').textContent = s.items.length;
    $('#rSub').hidden = $('#rDesc').hidden = !t.porcentaje;
    $('#tSub').textContent = usd(t.subtotal);
    $('#tDescLabel').textContent = `Descuento (${t.porcentaje}%)`;
    $('#tDesc').textContent = '−' + usd(t.descuento);
    $('#tTotal').textContent = usd(t.total);
    $('#tTotalBs').textContent = bs(t.totalBs);
    $('#btnProcesar').disabled = !s.items.length;
  }

  tbody.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = Number(b.closest('tr').dataset.id);
    if (b.dataset.act === 'del') update((s) => { s.items = s.items.filter((p) => p.id !== id); });
    else if (b.dataset.act === 'toggle')
      update((s) => { const p = s.items.find((x) => x.id === id); p.excluidoDescuento = !p.excluidoDescuento; });
    else {
      const p = getState().items.find((x) => x.id === id);
      editId = id;
      form.elements.cant.value = p.cantidad;
      form.elements.nombre.value = p.nombre;
      form.elements.precio.value = p.precioUnitario;
      err.hidden = true;
      dlg.showModal();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const c = Number(form.elements.cant.value), pu = Number(form.elements.precio.value);
    const n = form.elements.nombre.value.trim();
    if (!n || !(c > 0) || !(pu > 0)) {
      err.textContent = 'Completa correctamente cantidad, nombre y precio unitario.'; err.hidden = false; return;
    }
    update((s) => Object.assign(s.items.find((x) => x.id === editId), { cantidad: c, nombre: n, precioUnitario: pu }));
    dlg.close();
  });
  $('#btnEditarCancelar').addEventListener('click', () => dlg.close());

  subscribe(render);
  render(getState());
}
