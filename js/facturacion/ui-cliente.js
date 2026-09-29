import { $ } from './dom.js';
import { FORMATTERS } from './format.js';
import { buscarCliente } from './api.js';
import { STORAGE } from './config.js';
import { getState, subscribe, update } from './store.js';

let dlg;
export const abrirCliente = () => dlg && !dlg.open && dlg.showModal();

export function initCliente() {
  dlg = $('#dlgCliente');
  const form = $('#formCliente');
  const err = $('#clienteError');
  const f = form.elements;
  let timer;
  f.vendedor.value = localStorage.getItem(STORAGE.vendedor) || '';

  async function autorrellenar(cedula) {
    const c = await buscarCliente(cedula);
    if (!c) return;
    // Solo completa campos vacíos: nunca pisa lo que el vendedor ya escribió.
    if (c.nombre && !f.nombre.value) f.nombre.value = FORMATTERS.text(c.nombre);
    if (c.apellido && !f.apellido.value) f.apellido.value = FORMATTERS.text(c.apellido);
    if (c.telefono && !f.telefono.value)
      f.telefono.value = FORMATTERS.phone(String(c.telefono).replace(/\D/g, '').replace(/^58/, '0'));
  }

  form.addEventListener('input', (e) => {
    err.hidden = true;
    const formatear = FORMATTERS[e.target.dataset.format];
    if (formatear) e.target.value = formatear(e.target.value);
    if (e.target === f.cedula) {
      clearTimeout(timer);
      const digitos = f.cedula.value.replace(/\D/g, '');
      if (digitos.length >= 6) timer = setTimeout(() => autorrellenar(digitos), 400);
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Object.fromEntries([...new FormData(form)].map(([k, x]) => [k, x.trim()]));
    const reglas = [
      ['nombre', !v.nombre, 'Escribe el nombre del cliente.'],
      ['apellido', !v.apellido, 'Escribe el apellido del cliente.'],
      ['cedula', v.cedula.replace(/\D/g, '').length < 6, 'Cédula inválida: debe tener entre 6 y 8 dígitos.'],
      ['telefono', v.telefono.length < 13, 'Teléfono incompleto. Ejemplo: 0412-345-6789.'],
      ['vendedor', !v.vendedor, 'Escribe el nombre del vendedor.'],
    ];
    const fallo = reglas.find((r) => r[1]);
    if (fallo) { err.textContent = fallo[2]; err.hidden = false; f[fallo[0]].focus(); return; }
    localStorage.setItem(STORAGE.vendedor, v.vendedor);
    update((s) => { s.cliente = v; });
    dlg.close();
  });

  $('#btnOmitir').addEventListener('click', () => dlg.close());
  subscribe(render);
  render(getState());
}

function render({ cliente: c }) {
  const chip = $('#chipCliente');
  chip.textContent = c ? 'Cliente listo' : 'Cliente pendiente';
  chip.dataset.ok = String(!!c);
  $('#clienteDatos').hidden = !c;
  $('#clienteVacio').hidden = !!c;
  $('#txtEditar').textContent = c ? 'Editar' : 'Completar';
  if (!c) return;
  $('#cNombre').textContent = `${c.nombre} ${c.apellido}`;
  $('#cCedula').textContent = c.cedula;
  $('#cTelefono').textContent = c.telefono;
  $('#cVendedor').textContent = c.vendedor;
}
