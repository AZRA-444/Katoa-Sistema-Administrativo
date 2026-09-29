import { initTasa } from './tasa.js';
import { initCliente, abrirCliente } from './ui-cliente.js';
import { initProducto } from './ui-producto.js';
import { initFactura } from './ui-factura.js';
import { initCheckout } from './checkout.js';
import { getState } from './store.js';

async function init() {
  // auth-guard.js redirige a /login.html si no hay sesión
  if (window.Auth && !(await window.Auth.listo)) return;

  initTasa();
  initCliente();
  initProducto();
  initFactura();
  initCheckout();

  document.addEventListener('click', (e) => { if (e.target.closest('[data-open-cliente]')) abrirCliente(); });
  addEventListener('beforeunload', (e) => {
    if (getState().items.length) { e.preventDefault(); e.returnValue = ''; }
  });
  abrirCliente();
}
init();
