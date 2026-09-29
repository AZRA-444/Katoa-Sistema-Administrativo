import { $ } from './dom.js';
import { STORAGE } from './config.js';
import { obtenerTasa } from './api.js';
import { getState, update } from './store.js';

export function initTasa() {
  const input = $('#tasa');
  const fijar = (v, manual = false) =>
    update((s) => { s.tasa = v; s.tasaManual ||= manual; });
  const guardar = (v) => localStorage.setItem(STORAGE.tasa, v);

  const guardada = Number(localStorage.getItem(STORAGE.tasa)) || 0;
  if (guardada) { input.value = guardada.toFixed(2); fijar(guardada); }

  input.addEventListener('input', () => {
    const v = Number(input.value) || 0;
    fijar(v, true);
    guardar(v);
  });

  // La tasa en línea no pisa lo que el vendedor escribió a mano.
  obtenerTasa().then((v) => {
    if (v > 0 && !getState().tasaManual) { input.value = v.toFixed(2); fijar(v); guardar(v); }
  });
}
