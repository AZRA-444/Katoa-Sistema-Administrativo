//--- VARIABLES DE ESTADO ---//
const state = {
  listaProductos: [],
  tasaConver: 0,
  montoFinalUSD: 0,
  montoFinalBS: 0,
  descUSD: 0,
  descBS: 0,
  compraExitosa: false,
  clienteCompleto: false,
};

const fmtUSD = (n) => "$ " + Number(n).toFixed(2);
const fmtBs = (n) => "Bs " + Number(n).toFixed(2);

function mostrarError(id, mensaje, campo) {
  const el = document.getElementById(id);
  if (el) { el.textContent = mensaje; el.hidden = false; }
  if (campo) { campo.setAttribute("aria-invalid", "true"); campo.focus(); }
}

function ocultarError(id) {
  const el = document.getElementById(id);
  if (el) { el.hidden = true; el.textContent = ""; }
  document.querySelectorAll("[aria-invalid]").forEach((i) => i.removeAttribute("aria-invalid"));
}

// Los handlers inline (onclick/oninput) los bloquea el CSP (script-src 'self'):
// se enlazan aquí por JS.
function enlazarEventosEstaticos() {
  const formatos = { text: formatText, doc: formatDoc, phone: formatPhone };
  document.querySelectorAll("[data-format]").forEach((el) =>
    el.addEventListener("input", () => formatos[el.dataset.format](el)),
  );
  const on = (id, fn) => document.getElementById(id)?.addEventListener("click", fn);
  on("btnOmitirCliente", omitirDatosCliente);
  on("btnCerrarModal", dataClientSave);
  on("btnCerrarError", cerrarModalError);
  on("btnAgregarProducto", () => window.acceptProductData());

  document.getElementById("modalDataCliente")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); dataClientSave(); }
  });
  ["cantProduct", "prcUndProduct"].forEach((id) =>
    document.getElementById(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); window.acceptProductData(); }
    }),
  );
  ["cantProduct", "nameProduct", "prcUndProduct", "tasa-input"].forEach((id) =>
    document.getElementById(id)?.addEventListener("input", () => ocultarError("productoError")),
  );
  document.querySelectorAll("#modalDataCliente input").forEach((i) =>
    i.addEventListener("input", () => ocultarError("clienteError")),
  );
}

const inputVendedor = document.getElementById("nameVendedor");

if (inputVendedor) {
  inputVendedor.value = localStorage.getItem("vendedorActual") || "";

  inputVendedor.addEventListener("input", () => {
    localStorage.setItem("vendedorActual", inputVendedor.value.trim());
  });
}

const BACKEND_API_URL = "/api/precargar-factura";

//--- BLOQUEAR RECARGA ---//
window.addEventListener("beforeunload", (event) => {
  if (!state.compraExitosa && state.listaProductos.length > 0) {
    event.preventDefault();
    event.returnValue = "";
  }
});

//--- MANEJO DE MODAL DATA-CLIENT ---//
window.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("modalDataCliente");

  if (modal) {
    modal.showModal();

    modal.addEventListener("cancel", (event) => {
      event.preventDefault();
      omitirDatosCliente();
    });
  }

  actualizarResumenCliente();
  enlazarEventosEstaticos();

  // Inicializadores
  calcularPrecioTotal();
  inicializarTasa();
  configurarDelegacionEventos();

  // Autorrelleno de cliente: al escribir la cédula, si ya existe un
  // cliente registrado con esa cédula se completan nombre, apellido y
  // teléfono automáticamente (ver js/clientes.js).
  activarAutorrellenoCliente({
    inputCedula: document.getElementById("documentID"),
    campos: {
      nombre: document.getElementById("nameClient"),
      apellido: document.getElementById("secondNameClient"),
      telefono: document.getElementById("numberPhone"),
    },
  });
});

//--- FILTRADO Y FORMATEO DE DATOS ---//

function formatText(input) {
  let valor = input.value.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑüÜ ]/g, "");
  input.value = valor
    .split(" ")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

function formatDoc(input) {
  const digitos = input.value.replace(/\D/g, "").slice(0, 8);
  input.value = digitos.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function formatPhone(input) {
  let telefono = input.value.replace(/\D/g, "");
  if (telefono.length > 4 && telefono.length <= 7) {
    telefono = telefono.slice(0, 4) + "-" + telefono.slice(4);
  } else if (telefono.length > 7) {
    telefono =
      telefono.slice(0, 4) +
      "-" +
      telefono.slice(4, 7) +
      "-" +
      telefono.slice(7, 11);
  }
  input.value = telefono;
}

//--- GUARDAR DATA-CLIENT E IMPRIMIR EN FACTURA ---//
function dataClientSave() {
  const name = document.getElementById("nameClient").value.trim();
  const secondName = document.getElementById("secondNameClient").value.trim();
  const documentID = document.getElementById("documentID").value.trim();
  const numberPhone = document.getElementById("numberPhone").value.trim();
  const nameVendedor = document.getElementById("nameVendedor").value.trim();

  const cedulaDigitos = documentID.replace(/\D/g, "");
  const $ = (id) => document.getElementById(id);
  let error = null, campo = null;
  if (!name) { error = "Escribe el nombre del cliente."; campo = $("nameClient"); }
  else if (!secondName) { error = "Escribe el apellido del cliente."; campo = $("secondNameClient"); }
  else if (cedulaDigitos.length < 6) { error = "Cédula inválida: debe tener entre 6 y 8 dígitos."; campo = $("documentID"); }
  else if (numberPhone.length < 13) { error = "Teléfono incompleto. Ejemplo: 0412-345-6789."; campo = $("numberPhone"); }
  else if (!nameVendedor) { error = "Escribe el nombre del vendedor."; campo = $("nameVendedor"); }
  if (error) { mostrarError("clienteError", error, campo); return; }
  ocultarError("clienteError");

  state.clienteCompleto = true;
  actualizarResumenCliente();
  actualizarTabla();

  const modal = document.getElementById("modalDataCliente");
  if (modal && modal.open) {
    modal.close();
  }
}

//--- OMITIR DATOS DEL CLIENTE (SE COMPLETAN MÁS TARDE) ---//
function omitirDatosCliente() {
  state.clienteCompleto = false;
  ocultarError("clienteError");
  actualizarResumenCliente();
  actualizarTabla();

  const modal = document.getElementById("modalDataCliente");
  if (modal && modal.open) {
    modal.close();
  }
}

//--- ABRIR EL MODAL PARA COMPLETAR O EDITAR LOS DATOS DEL CLIENTE ---//
function abrirModalCliente() {
  const modal = document.getElementById("modalDataCliente");
  if (modal && !modal.open) {
    modal.showModal();
  }
}

//--- PINTAR EL RESUMEN DEL CLIENTE (COMPLETO O PENDIENTE) ---//
function actualizarResumenCliente() {
  const data = document.getElementById("data-client");
  if (!data) return;

  if (state.clienteCompleto) {
    const name = document.getElementById("nameClient").value.trim();
    const secondName = document.getElementById("secondNameClient").value.trim();
    const documentID = document.getElementById("documentID").value.trim();
    const numberPhone = document.getElementById("numberPhone").value.trim();

    data.innerHTML = `
      <div class="client-card">
        <div>
          <p><strong>Cliente:</strong> ${escapeHtml(name)} ${escapeHtml(secondName)}</p>
          <p><strong>C.I. / RIF:</strong> ${escapeHtml(documentID)}</p>
          <p><strong>Teléfono:</strong> ${escapeHtml(numberPhone)}</p>
        </div>
        <button type="button" class="btn-secondary" data-action="editar-cliente">
          <i class="fas fa-pen"></i> Editar cliente
        </button>
      </div>
    `;
  } else {
    data.innerHTML = `
      <div class="client-card client-pending">
        <p><i class="fas fa-triangle-exclamation"></i> Datos del cliente pendientes</p>
        <button type="button" class="btn-secondary" data-action="editar-cliente">
          <i class="fas fa-user-plus"></i> Completar datos
        </button>
      </div>
    `;
  }
}

//--- OBTENCION DE TASA ACTUALIZADA POR API ---//
async function obtenerTasaDolar(inputTasa) {
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await response.json();

    if (data?.rates?.VES && !state.tasaManual) {
      state.tasaConver = data.rates.VES;
      localStorage.setItem("tasaFacturacion", state.tasaConver);

      if (document.activeElement !== inputTasa) {
        inputTasa.value = state.tasaConver.toFixed(2);
      }

      if (state.listaProductos.length > 0) {
        recalcularPreciosPorNuevaTasa();
      }
    }
  } catch (error) {
    console.warn(
      "Fallo de conexión o API. Se mantendrá el valor manual o en caché.",
    );
  }
}

function inicializarTasa() {
  const inputTasa = document.getElementById("tasa-input");
  if (!inputTasa) return;

  const tasaGuardada = localStorage.getItem("tasaFacturacion");
  if (tasaGuardada) {
    state.tasaConver = Number(tasaGuardada);
    inputTasa.value = state.tasaConver.toFixed(2);
  }

  inputTasa.addEventListener("input", () => {
    state.tasaManual = true;
    state.tasaConver = Number(inputTasa.value) || 0;
    localStorage.setItem("tasaFacturacion", state.tasaConver);

    if (state.listaProductos.length > 0) {
      recalcularPreciosPorNuevaTasa();
    }
  });

  obtenerTasaDolar(inputTasa);
}

function recalcularPreciosPorNuevaTasa() {
  state.listaProductos.forEach((producto) => {
    producto.precioUnitarioBS = producto.precioUnitario * state.tasaConver;
    producto.precioTotalBS = producto.precioTotal * state.tasaConver;
  });
  actualizarTabla();
}

// ============================================================
// INCORPORACIÓN DE PRODUCTOS E INVENTARIO
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  // ------------------------------------------------------------
  // REFERENCIAS DOM
  // ------------------------------------------------------------
  const inputProduct = document.getElementById("nameProduct");
  const inputCant = document.getElementById("cantProduct");
  const inputPrcUnd = document.getElementById("prcUndProduct");
  const inputPrcTotal = document.getElementById("prcTotalProduct");
  const listaAutocomplete = document.getElementById("sugerencias-lista");

  if (!inputProduct || !inputCant || !inputPrcUnd || !inputPrcTotal || !listaAutocomplete) {
    console.error("Error: No se encontraron todos los elementos necesarios para el módulo de productos.");
    return;
  }

  // ------------------------------------------------------------
  // CONTROL DE BÚSQUEDA Y DEBOUNCE
  // ------------------------------------------------------------
  let timeoutId = null;
  let busquedaId = 0;
  let activo = -1;

  // ------------------------------------------------------------
  // 1. AUTOCOMPLETADO Y BÚSQUEDA
  // ------------------------------------------------------------
  inputProduct.addEventListener("input", (e) => {
    const texto = String(e.target.value || "").trim();

    limpiarDatasets();

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    busquedaId++;

    if (texto.length < 2) {
      ocultarLista();
      return;
    }

    const idBusquedaActual = busquedaId;

    timeoutId = setTimeout(async () => {
      try {
        // Garantiza encontrar el cliente de Supabase ya autenticado.
        // OJO: window.supabase es la LIBRERÍA del SDK (solo tiene
        // .createClient), no un cliente conectado; usarla aquí como
        // fallback era la causa de "db.from is not a function". El
        // cliente real lo crea auth-guard.js y lo expone en
        // window.__authClient.
        const clienteDb =
          window.__authClient || (typeof db !== "undefined" ? db : window.db);

        if (!clienteDb) {
          console.error("Error: el cliente de Supabase (__authClient) no está definido o cargado todavía.");
          return;
        }

        const resultados = await buscarProductosInventario(clienteDb, texto);

        if (idBusquedaActual !== busquedaId) return;

        const textoActual = String(inputProduct.value || "").trim();
        if (textoActual !== texto) return;

        mostrarSugerencia(resultados);
      } catch (error) {
        console.error("Error al buscar productos en el inventario:", error);
        if (idBusquedaActual === busquedaId) ocultarLista();
      } finally {
        if (idBusquedaActual === busquedaId) timeoutId = null;
      }
    }, 300);
  });

  // ------------------------------------------------------------
  // 2. MOSTRAR SUGERENCIAS
  // ------------------------------------------------------------
  function mostrarSugerencia(resultados) {
    listaAutocomplete.innerHTML = "";
    activo = -1;

    const textoActual = String(inputProduct.value || "").trim();

    if (!Array.isArray(resultados) || resultados.length === 0) {
      // Sin coincidencias: mostrar aviso + opción de agregar manualmente
      listaAutocomplete.innerHTML = `<li class="fac-autocomplete-empty" role="presentation"><i class="fas fa-box-open"></i> Sin coincidencias en el inventario</li>`;
      listaAutocomplete.appendChild(_crearItemManual(textoActual));
      abrirLista();
      return;
    }

    resultados.forEach((prod) => {
      if (!prod || prod.id == null) return;

      const li = document.createElement("li");
      li.className = "fac-autocomplete-item";
      li.setAttribute("role", "option");

      const nombre = String(prod.nombre ?? "").trim();
      const color = prod.color ? String(prod.color).trim() : "";
      const calibre = prod.calibre ? String(prod.calibre).trim() : "";
      const nombreCompleto = `${nombre}${color ? " - " + color : ""}${calibre ? " - " + calibre : ""}`.trim();

      if (!nombreCompleto) return;

      const stockSeguro = Number.isFinite(Number(prod.cantidad)) ? Number(prod.cantidad) : 0;
      const detalSeguro = Number.isFinite(Number(prod.precio_detal)) ? Number(prod.precio_detal) : 0;
      const mayorSeguro = Number.isFinite(Number(prod.precio_mayor)) ? Number(prod.precio_mayor) : 0;
      const umbralSeguro = Number.isFinite(Number(prod.cantidad_mayor)) && Number(prod.cantidad_mayor) > 0 ? Number(prod.cantidad_mayor) : 0;
      const tieneMayor   = mayorSeguro > 0 && umbralSeguro > 0;
      const sinStock = stockSeguro <= 0;

      if (sinStock) li.classList.add("sin-stock");

      const meta = [color, calibre].filter(Boolean).map(v => escapeHtml(v)).join(" · ");
      li.innerHTML = `
        <div class="fac-autocomplete-info">
          <span class="fac-autocomplete-nombre">${escapeHtml(nombre)}</span>
          ${meta ? `<span class="fac-autocomplete-meta">${meta}</span>` : ""}
        </div>
        <div class="fac-autocomplete-badges">
          <span class="fac-badge-precio" title="${tieneMayor ? 'Precio detal (menos de ' + umbralSeguro + ' und)' : 'Precio detal'}">D $${detalSeguro.toFixed(2)}</span>
          ${tieneMayor ? `<span class="fac-badge-precio mayor" title="Precio mayor (≥${umbralSeguro} und)">M $${mayorSeguro.toFixed(2)}</span>` : ""}
          <span class="fac-badge-stock${sinStock ? " sin-stock" : ""}">${sinStock ? "Sin stock" : "Stock: " + stockSeguro}</span>
        </div>
      `;

      li.addEventListener("click", () => {
        busquedaId++;

        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        inputProduct.value = nombreCompleto;

        inputProduct.dataset.id = String(prod.id);
        inputProduct.dataset.cantidad = String(stockSeguro);
        inputProduct.dataset.precioDetal = String(detalSeguro);
        inputProduct.dataset.precioMayor = String(mayorSeguro);
        inputProduct.dataset.cantidadMayor = String(umbralSeguro);

        const cantidadActual = Number(inputCant.value);
        if (!Number.isFinite(cantidadActual) || cantidadActual <= 0) {
          inputCant.value = "1";
        }

        recalcularPreciosFormulario();
        ocultarLista();
      });

      listaAutocomplete.appendChild(li);
    });

    if (!listaAutocomplete.children.length) {
      ocultarLista();
      return;
    }

    // Siempre ofrecer la opción manual al final, aunque haya resultados
    listaAutocomplete.appendChild(_crearItemManual(textoActual));
    abrirLista();
  }

  // ------------------------------------------------------------
  // 2.1 AJUSTE DE ALTURA/POSICIÓN EN MÓVIL (teclado virtual)
  // ------------------------------------------------------------
  // En móvil, el teclado virtual reduce el área realmente visible
  // de la pantalla. `max-height: 60vh` en el CSS se calcula sobre
  // el alto TOTAL del viewport, sin descontar el teclado, así que
  // la lista podía quedar renderizada por debajo de él (invisible
  // para el usuario aunque técnicamente estuviera en el DOM).
  // window.visualViewport sí refleja el alto realmente visible
  // (descontando el teclado) en navegadores modernos.
  function ajustarPosicionLista() {
    const vv = window.visualViewport;
    const alturaVisible = vv ? vv.height : window.innerHeight;

    const rectInput = inputProduct.getBoundingClientRect();
    // Espacio real disponible debajo del input hasta el borde
    // visible inferior (teclado incluido), con un margen de seguridad.
    const espacioDisponible = alturaVisible - rectInput.bottom - 16;

    // Nunca menos de ~140px (para que al menos se vea 1-2 opciones),
    // ni más que el límite razonable de 60vh en pantallas grandes.
    const maxAltura = Math.max(140, Math.min(espacioDisponible, window.innerHeight * 0.6));
    listaAutocomplete.style.maxHeight = `${maxAltura}px`;

    // Además, aseguramos que el propio input (y por tanto la lista,
    // que cuelga justo debajo) quede por encima del teclado. Se hace
    // en el siguiente frame para no pelear con el scroll nativo que
    // el navegador dispara al enfocar el input.
    // Solo en móvil (teclado virtual); en escritorio hacía saltar la página al teclear.
    if (window.matchMedia("(max-width: 600px)").matches) {
      requestAnimationFrame(() => {
        inputProduct.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
  }

  // Reajustar mientras el teclado termina de abrirse/cerrarse
  // (en iOS/Android esto dispara varios eventos de resize seguidos).
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      if (listaAutocomplete.style.display === "block") ajustarPosicionLista();
    });
  }

  // Crea el ítem "Agregar manualmente" que rellena solo el nombre
  // y deja el precio vacío para que el vendedor lo ingrese a mano.
  function _crearItemManual(texto) {
    const li = document.createElement("li");
    li.className = "fac-autocomplete-item fac-autocomplete-manual";
    li.setAttribute("role", "option");
    li.innerHTML = `
      <div class="fac-autocomplete-info">
        <span class="fac-autocomplete-nombre"><i class="fas fa-pencil"></i> Agregar "<strong>${escapeHtml(texto)}</strong>" manualmente</span>
        <span class="fac-autocomplete-meta">Sin vincular al inventario — ingresa el precio a mano</span>
      </div>
    `;
    li.addEventListener("click", () => {
      busquedaId++;
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }

      // Conservar el texto escrito, limpiar cualquier vínculo con inventario
      inputProduct.value = texto;
      limpiarDatasets();

      // Enfocar precio unitario para que el vendedor lo complete
      inputPrcUnd.value = "";
      inputPrcTotal.value = "";
      ocultarLista();
      inputPrcUnd.focus();
    });
    return li;
  }

  // ------------------------------------------------------------
  // 3. RECALCULAR PRECIOS
  // ------------------------------------------------------------
  function recalcularPreciosFormulario() {
    const cant = Number(inputCant.value);
    const idInventario = inputProduct.dataset.id;

    if (!Number.isFinite(cant) || cant <= 0) {
      inputPrcTotal.value = "0.00";
      if (idInventario) inputPrcUnd.value = "0.00";
      return;
    }

    if (idInventario) {
      const pu = obtenerPrecioUnitario(
        cant,
        inputProduct.dataset.precioDetal,
        inputProduct.dataset.precioMayor,
        inputProduct.dataset.cantidadMayor
      );
      inputPrcUnd.value = Number.isFinite(pu) && pu > 0 ? pu.toFixed(2) : "0.00";
    }

    const puActual = Number(inputPrcUnd.value);
    if (!Number.isFinite(puActual) || puActual <= 0) {
      inputPrcTotal.value = "0.00";
      return;
    }

    const total = cant * puActual;
    inputPrcTotal.value = Number.isFinite(total) && total > 0 ? total.toFixed(2) : "0.00";
  }

  inputCant.addEventListener("input", recalcularPreciosFormulario);

  inputPrcUnd.addEventListener("input", () => {
    const cant = Number(inputCant.value);
    const pu = Number(inputPrcUnd.value);

    if (!Number.isFinite(cant) || cant <= 0 || !Number.isFinite(pu) || pu <= 0) {
      inputPrcTotal.value = "0.00";
      return;
    }

    const total = cant * pu;
    inputPrcTotal.value = Number.isFinite(total) && total > 0 ? total.toFixed(2) : "0.00";
  });

  // ------------------------------------------------------------
  // 4. PROCESAR E INCORPORAR PRODUCTO (EXPUESTA A WINDOW)
  // ------------------------------------------------------------
  window.acceptProductData = function () {
    const cantProd = Number(inputCant.value);
    const nameProd = String(inputProduct.value || "").trim();
    const puProd = Number(inputPrcUnd.value);

    const idInventario = inputProduct.dataset.id || null;
    const stockDisponible = inputProduct.dataset.cantidad !== undefined 
      ? Number(inputProduct.dataset.cantidad) 
      : null;

    const tasa = Number(typeof state !== "undefined" ? state?.tasaConver : 0);

    if (!Number.isFinite(tasa) || tasa <= 0) {
      mostrarError("productoError", "Ingresa la tasa del día antes de agregar productos.", document.getElementById("tasa-input"));
      return;
    }

    if (!nameProd) {
      mostrarError("productoError", "Escribe el nombre del producto.", inputProduct);
      return;
    }

    if (!Number.isFinite(cantProd) || cantProd <= 0) {
      mostrarError("productoError", "La cantidad debe ser mayor que cero.", inputCant);
      return;
    }

    if (!Number.isFinite(puProd) || puProd <= 0) {
      mostrarError("productoError", "El precio unitario debe ser mayor que cero.", inputPrcUnd);
      return;
    }

    const precioTotal = cantProd * puProd;

    if (idInventario && stockDisponible !== null && Number.isFinite(stockDisponible) && cantProd > stockDisponible) {
      const continuar = confirm(
        `Atención: La cantidad ingresada (${cantProd}) supera el stock disponible (${stockDisponible}).\n\n¿Deseas agregarlo de todas formas?`
      );
      if (!continuar) return;
    }

    const producto = {
      idInventario: idInventario,
      cantidad: cantProd,
      nombre: nameProd,
      precioUnitario: puProd,
      precioUnitarioBS: tasa * puProd,
      precioTotal: precioTotal,
      precioTotalBS: tasa * precioTotal,
      excluidoDescuento: false
    };

    if (typeof state !== "undefined") {
      if (!Array.isArray(state.listaProductos)) state.listaProductos = [];
      state.listaProductos.push(producto);
    }

    if (typeof actualizarTabla === "function") {
      actualizarTabla();
    }

    ocultarError("productoError");
    limpiarFormulario();
    inputProduct.focus();
  };

  // ------------------------------------------------------------
  // 5. UTILIDADES Y Cierre
  // ------------------------------------------------------------
  function limpiarFormulario() {
    [inputCant, inputProduct, inputPrcUnd, inputPrcTotal].forEach((el) => {
      if (el) el.value = "";
    });
    limpiarDatasets();
    ocultarLista();

    busquedaId++;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  function limpiarDatasets() {
    delete inputProduct.dataset.id;
    delete inputProduct.dataset.cantidad;
    delete inputProduct.dataset.precioDetal;
    delete inputProduct.dataset.precioMayor;
    delete inputProduct.dataset.cantidadMayor;
  }

  function abrirLista() {
    listaAutocomplete.style.display = "block";
    inputProduct.setAttribute("aria-expanded", "true");
    ajustarPosicionLista();
  }

  function ocultarLista() {
    listaAutocomplete.style.display = "none";
    listaAutocomplete.innerHTML = "";
    inputProduct.setAttribute("aria-expanded", "false");
    activo = -1;
  }

  // Navegación con teclado: ↑ ↓ Enter Esc
  function marcarActivo(i) {
    const items = [...listaAutocomplete.querySelectorAll(".fac-autocomplete-item")];
    items.forEach((li, n) => {
      li.classList.toggle("active", n === i);
      li.setAttribute("aria-selected", n === i ? "true" : "false");
    });
    activo = i;
    items[i]?.scrollIntoView({ block: "nearest" });
  }

  inputProduct.addEventListener("keydown", (e) => {
    if (listaAutocomplete.style.display !== "block") return;
    const items = listaAutocomplete.querySelectorAll(".fac-autocomplete-item");
    if (e.key === "ArrowDown" && items.length) { e.preventDefault(); marcarActivo((activo + 1) % items.length); }
    else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); marcarActivo((activo - 1 + items.length) % items.length); }
    else if (e.key === "Enter") { e.preventDefault(); if (activo >= 0) items[activo].click(); }
    else if (e.key === "Escape") { ocultarLista(); }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".autocomplete-container")) {
      ocultarLista();
    }
  });
});

//--- ACTUALIZACION DE TABLA ---//
function actualizarTabla() {
  const tbody = document.getElementById("tablaProductos");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (state.listaProductos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="table-empty-state"><i class="fas fa-box-open"></i>Agrega productos para ver el detalle de la factura</div></td></tr>`;
  }

  state.listaProductos.forEach((producto, index) => {
    const fila = document.createElement("tr");
    const excluido = !!producto.excluidoDescuento;
    const tituloDesc = excluido ? "Volver a incluir en el descuento" : "Sacar del descuento (se suma completo al total)";
    fila.className = excluido ? "fila-excluida" : "";
    fila.innerHTML = `
      <td class="text-center">${producto.cantidad}</td>
      <td>${escapeHtml(producto.nombre)}${excluido ? ' <span class="badge-sin-desc">Sin descuento</span>' : ""}</td>
      <td class="num">${fmtUSD(producto.precioUnitario)}</td>
      <td class="num">${fmtBs(producto.precioUnitarioBS)}</td>
      <td class="num">${fmtUSD(producto.precioTotal)}</td>
      <td class="num">${fmtBs(producto.precioTotalBS)}</td>
      <td>
        <div class="acciones-producto">
          <button type="button" class="btn-toggle-desc${excluido ? " active" : ""}" data-index="${index}" title="${tituloDesc}" aria-label="${tituloDesc}" aria-pressed="${excluido}"><i class="fa-solid ${excluido ? "fa-rotate-left" : "fa-tag"}"></i></button>
          <button type="button" class="btn-editar" data-index="${index}" title="Editar producto" aria-label="Editar producto"><i class="fa-solid fa-pen"></i></button>
          <button type="button" class="btn-eliminar" data-index="${index}" title="Eliminar producto" aria-label="Eliminar producto"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    `;
    tbody.appendChild(fila);
  });

  const productosDescontables = state.listaProductos.filter(
    (p) => !p.excluidoDescuento,
  );
  const productosExcluidos = state.listaProductos.filter(
    (p) => p.excluidoDescuento,
  );

  const subTotalDescontableUSD = productosDescontables.reduce(
    (acc, p) => acc + p.precioTotal,
    0,
  );
  const subTotalDescontableBS = productosDescontables.reduce(
    (acc, p) => acc + p.precioTotalBS,
    0,
  );

  const subTotalExcluidoUSD = productosExcluidos.reduce(
    (acc, p) => acc + p.precioTotal,
    0,
  );
  const subTotalExcluidoBS = productosExcluidos.reduce(
    (acc, p) => acc + p.precioTotalBS,
    0,
  );

  const subTotalUSD = subTotalDescontableUSD + subTotalExcluidoUSD;
  const subTotalBS = subTotalDescontableBS + subTotalExcluidoBS;

  // El porcentaje de descuento se calcula solo sobre lo que sí aplica a descuento
  let porcentajeDescuento = 0;
  if (subTotalDescontableUSD > 500) porcentajeDescuento = 35;
  else if (subTotalDescontableUSD > 300) porcentajeDescuento = 30;
  else if (subTotalDescontableUSD > 200) porcentajeDescuento = 25;
  else if (subTotalDescontableUSD > 100) porcentajeDescuento = 20;
  else if (subTotalDescontableUSD > 50) porcentajeDescuento = 15;
  else if (subTotalDescontableUSD > 20) porcentajeDescuento = 10;
  else if (subTotalDescontableUSD > 10) porcentajeDescuento = 5;

  state.descUSD = subTotalDescontableUSD * (porcentajeDescuento / 100);
  state.descBS = subTotalDescontableBS * (porcentajeDescuento / 100);

  // Los productos excluidos se suman completos (sin descuento) al total final
  state.montoFinalUSD =
    subTotalDescontableUSD - state.descUSD + subTotalExcluidoUSD;
  state.montoFinalBS =
    subTotalDescontableBS - state.descBS + subTotalExcluidoBS;

  const totalFinal = document.getElementById("totalesTabla");
  if (totalFinal) {
    if (state.montoFinalUSD <= 0) {
      totalFinal.innerHTML = "";
      return;
    }

    const filasDescuento =
      porcentajeDescuento > 0
        ? `<div class="fila-total"><span>Sub-total</span><span>${fmtUSD(subTotalUSD)} / ${fmtBs(subTotalBS)}</span></div>
           <div class="fila-total descuento"><span>Descuento (-${porcentajeDescuento}%)</span><span>-${fmtUSD(state.descUSD)} / -${fmtBs(state.descBS)}</span></div>`
        : "";
    const aviso = state.clienteCompleto
      ? ""
      : `<p class="totales-aviso"><i class="fas fa-circle-info"></i> Falta completar los datos del cliente para procesar.</p>`;

    totalFinal.innerHTML = `
      ${filasDescuento}
      <div class="fila-total total-final"><span>Total</span><span>${fmtUSD(state.montoFinalUSD)} / ${fmtBs(state.montoFinalBS)}</span></div>
      ${aviso}
      <button type="button" class="btn-primary process" id="procesarCompra" data-action="procesar">Procesar compra <i class="fas fa-receipt"></i></button>
    `;
  }
}

function configurarDelegacionEventos() {
  document.addEventListener("click", (e) => {
    const accion = e.target.closest("[data-action]")?.dataset.action;
    if (accion === "editar-cliente") return abrirModalCliente();
    if (accion === "procesar") return finalizarCompra();
    if (accion === "cerrar-edicion") return cerrarModalEditarProductoFac();
    if (accion === "guardar-edicion") return guardarEdicionProductoFac();

    const botonEliminar = e.target.closest(".btn-eliminar");
    if (botonEliminar) {
      const index = parseInt(botonEliminar.getAttribute("data-index"), 10);
      state.listaProductos.splice(index, 1);
      actualizarTabla();
      return;
    }

    const botonEditar = e.target.closest(".btn-editar");
    if (botonEditar) {
      const index = parseInt(botonEditar.getAttribute("data-index"), 10);
      abrirModalEditarProducto(index);
      return;
    }

    const botonToggleDesc = e.target.closest(".btn-toggle-desc");
    if (botonToggleDesc) {
      const index = parseInt(botonToggleDesc.getAttribute("data-index"), 10);
      const producto = state.listaProductos[index];
      if (producto) {
        producto.excluidoDescuento = !producto.excluidoDescuento;
        actualizarTabla();
      }
    }
  });
}

//--- MODAL DE EDICIÓN DE PRODUCTO (FACTURACIÓN) ---//
function abrirModalEditarProducto(index) {
  const producto = state.listaProductos[index];
  if (!producto) return;

  // Crear modal si no existe
  let modal = document.getElementById("modalEditarProductoFac");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "modalEditarProductoFac";
    modal.className = "modal-editar-producto";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "tituloEditarProducto");
    modal.innerHTML = `
      <div class="modal-editar-inner">
        <h3 id="tituloEditarProducto"><i class="fa-solid fa-pen"></i> Editar producto</h3>
        <div class="campo-editar">
          <label for="editFacCant">Cantidad</label>
          <input type="number" id="editFacCant" min="1" step="1">
        </div>
        <div class="campo-editar">
          <label for="editFacNombre">Nombre</label>
          <input type="text" id="editFacNombre">
        </div>
        <div class="campo-editar">
          <label for="editFacPrecioUnd">Precio unitario (USD)</label>
          <input type="number" id="editFacPrecioUnd" min="0" step="0.01">
        </div>
        <p id="editFacError" class="form-error" role="alert" hidden></p>
        <div class="acciones-modal-editar">
          <button type="button" class="btn-secondary" data-action="cerrar-edicion">Cancelar</button>
          <button type="button" class="btn-primary" data-action="guardar-edicion">Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  modal.dataset.index = index;
  document.getElementById("editFacCant").value = producto.cantidad;
  document.getElementById("editFacNombre").value = producto.nombre;
  document.getElementById("editFacPrecioUnd").value = producto.precioUnitario;
  ocultarError("editFacError");
  modal.classList.remove("hidden");
  document.getElementById("editFacCant").focus();
}

function cerrarModalEditarProductoFac() {
  const modal = document.getElementById("modalEditarProductoFac");
  if (modal) modal.classList.add("hidden");
}

function guardarEdicionProductoFac() {
  const modal = document.getElementById("modalEditarProductoFac");
  if (!modal) return;
  const index = parseInt(modal.dataset.index, 10);
  const producto = state.listaProductos[index];
  if (!producto) return;

  const cant = Number(document.getElementById("editFacCant").value);
  const nombre = document.getElementById("editFacNombre").value.trim();
  const precioUnd = Number(document.getElementById("editFacPrecioUnd").value);

  if (!nombre || !Number.isFinite(cant) || cant <= 0 || !Number.isFinite(precioUnd) || precioUnd <= 0) {
    mostrarError("editFacError", "Completa correctamente cantidad, nombre y precio unitario.");
    return;
  }

  producto.cantidad = cant;
  producto.nombre = nombre;
  producto.precioUnitario = precioUnd;
  producto.precioUnitarioBS = precioUnd * state.tasaConver;
  producto.precioTotal = cant * precioUnd;
  producto.precioTotalBS = producto.precioTotal * state.tasaConver;

  cerrarModalEditarProductoFac();
  actualizarTabla();
}

// Esc cierra el modal de edición; Enter guarda
document.addEventListener("keydown", (e) => {
  const modal = document.getElementById("modalEditarProductoFac");
  if (!modal || modal.classList.contains("hidden")) return;
  if (e.key === "Escape") cerrarModalEditarProductoFac();
  if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); guardarEdicionProductoFac(); }
});

// Cerrar modal editar al hacer click fuera
document.addEventListener("click", (e) => {
  const modal = document.getElementById("modalEditarProductoFac");
  if (modal && !modal.classList.contains("hidden") && e.target === modal) {
    cerrarModalEditarProductoFac();
  }
});

function calcularPrecioTotal() {
  const cantidadInput = document.getElementById("cantProduct");
  const precioUndInput = document.getElementById("prcUndProduct");
  const precioTotalInput = document.getElementById("prcTotalProduct");

  if (!cantidadInput || !precioUndInput || !precioTotalInput) return;

  const calcular = () => {
    const cantidad = Number(cantidadInput.value) || 0;
    const precioUnitario = Number(precioUndInput.value) || 0;
    precioTotalInput.value = (cantidad * precioUnitario).toFixed(2);
  };

  cantidadInput.addEventListener("input", calcular);
  precioUndInput.addEventListener("input", calcular);
}

function mostrarModalCargando() {
  document.getElementById("statusModal").classList.remove("hidden");
  document.getElementById("modalLoading").classList.remove("hidden");
  document.getElementById("modalSuccess").classList.add("hidden");
  document.getElementById("modalError").classList.add("hidden");
}

function mostrarModalExito() {
  document.getElementById("modalLoading").classList.add("hidden");
  document.getElementById("modalSuccess").classList.remove("hidden");
}

function mostrarModalError(mensaje) {
  document.getElementById("modalLoading").classList.add("hidden");
  document.getElementById("modalErrorMessage").textContent = mensaje;
  document.getElementById("modalError").classList.remove("hidden");
}

function cerrarModalError() {
  document.getElementById("statusModal").classList.add("hidden");
}

function generarIdFactura() {
  const sufijoAleatorio =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 6)
      : Math.random().toString(36).slice(2, 8);

  return "FAC-" + Date.now().toString().slice(-8) + "-" + sufijoAleatorio;
}

async function finalizarCompra() {
  const boton = document.getElementById("procesarCompra");
  if (!boton) return;

  // Verificación de seguridad: no debería llegarse aquí sin datos del
  // cliente, pero se valida de nuevo por si el flujo cambia en el futuro.
  if (!state.clienteCompleto) {
    abrirModalCliente();
    mostrarError("clienteError", "Completa los datos del cliente para procesar la factura.");
    return;
  }

  const facturaData = {
    id_factura: generarIdFactura(),
    nombre:
      document.getElementById("nameClient")?.value.trim() || "Consumidor Final",
    apellido: document.getElementById("secondNameClient")?.value.trim() || "",
    cedula: document.getElementById("documentID")?.value.trim() || "V-00000000",
    telefono:
      document
        .getElementById("numberPhone")
        ?.value.trim()
        .replace(/\D/g, "")
        .replace(/^0/, "+58") || "N/A",
    vendedor: localStorage.getItem("vendedorActual") || "Cajero General",

    tasa_cambio: state.tasaConver, // <--- NUEVO CAMPO ENVIADO AL BACKEND

    subtotal_usd: state.montoFinalUSD + state.descUSD,
    descuento_usd: state.descUSD,
    total_usd: state.montoFinalUSD,

    subtotal_bs: state.montoFinalBS + state.descBS,
    descuento_bs: state.descBS,
    total_bs: state.montoFinalBS,

    productos: state.listaProductos.map((p) => ({
      nombre: p.nombre,
      cantidad: p.cantidad,
      precioUnitario: p.precioUnitario,
      precioTotal: p.precioTotal,
      excluidoDescuento: !!p.excluidoDescuento,
      // Liga el producto con inventario_bisuteria cuando vino del
      // autocompletado (null si se escribió el nombre a mano). Viaja
      // como "pendiente" y solo se usa para descontar stock cuando
      // el verificador aprueba la factura, no en este paso.
      idInventario: p.idInventario || null,
    })),
  };
  boton.disabled = true;
  mostrarModalCargando();

  try {
    const response = await fetch(BACKEND_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(facturaData),
    });

    // === CRÍTICO: Verificar si realmente es JSON ===
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const text = await response.text();
      console.error("Backend devolvió no-JSON:", text);
      throw new Error("El servidor no devolvió una respuesta JSON válida");
    }

    const resultado = await response.json();

    if (!response.ok || resultado.status === "error") {
      throw new Error(resultado.message || "Error desconocido del servidor");
    }

    mostrarModalExito();
    state.compraExitosa = true;
    state.listaProductos = [];
    actualizarTabla();

    // Actualiza el directorio de clientes en segundo plano (no bloquea
    // ni condiciona el éxito de la venta, que ya quedó guardada).
    guardarClienteSiNuevo({
      cedula: facturaData.cedula,
      nombre: facturaData.nombre,
      apellido: facturaData.apellido,
      telefono: facturaData.telefono,
    });

    setTimeout(() => {
      location.reload();
    }, 1800);
  } catch (error) {
    console.error("Error en finalizarCompra:", error);

    document.getElementById("statusModal").classList.remove("hidden");
    mostrarModalError(error.message);
  } finally {
    boton.disabled = false;
  }
}