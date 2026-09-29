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
  if (!state.compraExitosa) {
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

  // Inicializadores
  calcularPrecioTotal();
  inicializarTasa();
  configurarDelegacionEventos();
  inyectarEstilosAccionesProducto();

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

//--- ESTILOS MÍNIMOS PARA LOS BOTONES DE ACCIÓN DE CADA PRODUCTO ---//
function inyectarEstilosAccionesProducto() {
  if (document.getElementById("estilos-acciones-producto")) return;

  const style = document.createElement("style");
  style.id = "estilos-acciones-producto";
  style.textContent = `
    .acciones-producto {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .btn-toggle-desc {
      padding: 5px;
      border: 1px solid var(--accent, #666);
      background: transparent;
      color: var(--accent, #666);
      border-radius: 6px;
      width: 32px;
      height: 32px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .btn-toggle-desc:hover {
      background: var(--accent, #666);
      color: #fff;
    }
    .btn-toggle-desc.active {
      background: var(--accent, #666);
      color: #fff;
    }
  `;
  document.head.appendChild(style);
}

//--- FILTRADO Y FORMATEO DE DATOS ---//

function formatText(input) {
  let valor = input.value.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ ]/g, "");
  input.value = valor
    .split(" ")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

function formatDoc(input) {
  let valor = input.value.replace(/\D/g, "");
  if (!valor) {
    input.value = "";
    return;
  }
  input.value = new Intl.NumberFormat("es-VE").format(parseInt(valor, 10));
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

  // CORRECCIÓN: Limpiar puntos para validar numéricamente la cédula
  const cedulaLimpia = parseInt(documentID.replace(/\./g, ""), 10) || 0;

  if (!name || !secondName || !documentID || !numberPhone) {
    alert("Por favor, llena todos los datos del cliente correctamente.");
    return;
  }

  if (!nameVendedor) {
    alert("Por favor, llena el campo vendedor con tu nombre.");
    return;
  }

  if (cedulaLimpia < 100000) {
    alert("Número de cédula inválido.");
    return;
  }

  if (numberPhone.length < 13) {
    alert("Número telefónico incorrecto, ¡número(s) faltante!");
    return;
  }

  state.clienteCompleto = true;
  actualizarResumenCliente();

  const modal = document.getElementById("modalDataCliente");
  if (modal && modal.open) {
    modal.close();
  }
}

//--- OMITIR DATOS DEL CLIENTE (SE COMPLETAN MÁS TARDE) ---//
function omitirDatosCliente() {
  state.clienteCompleto = false;
  actualizarResumenCliente();

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
      <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
        <div>
          <p><strong>Cliente:</strong> ${escapeHtml(name)} ${escapeHtml(secondName)}</p>
          <p><strong>C.I. / RIF:</strong> ${escapeHtml(documentID)}</p>
          <p><strong>Teléfono:</strong> ${escapeHtml(numberPhone)}</p>
        </div>
        <button type="button" class="btn-secondary" onclick="abrirModalCliente()">
          <i class="fas fa-pen"></i> Editar cliente
        </button>
      </div>
    `;
  } else {
    data.innerHTML = `
      <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
        <p><i class="fas fa-triangle-exclamation"></i> Datos del cliente pendientes</p>
        <button type="button" class="btn-primary" onclick="abrirModalCliente()">
          <i class="fas fa-user-plus"></i> Completar datos del cliente
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

    if (data?.rates?.VES) {
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

    const textoActual = String(inputProduct.value || "").trim();

    if (!Array.isArray(resultados) || resultados.length === 0) {
      // Sin coincidencias: mostrar aviso + opción de agregar manualmente
      listaAutocomplete.innerHTML = `<li class="fac-autocomplete-empty"><i class="fas fa-box-open"></i> Sin coincidencias en el inventario</li>`;
      listaAutocomplete.appendChild(_crearItemManual(textoActual));
      listaAutocomplete.style.display = "block";
      ajustarPosicionLista();
      return;
    }

    resultados.forEach((prod) => {
      if (!prod || prod.id == null) return;

      const li = document.createElement("li");
      li.className = "fac-autocomplete-item";

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
    listaAutocomplete.style.display = "block";
    ajustarPosicionLista();
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
    requestAnimationFrame(() => {
      inputProduct.scrollIntoView({ block: "center", behavior: "smooth" });
    });
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
      alert("Por favor, ingresa una tasa de conversión válida.");
      return;
    }

    if (!nameProd) {
      alert("Por favor, ingresa el nombre del producto.");
      return;
    }

    if (!Number.isFinite(cantProd) || cantProd <= 0) {
      alert("La cantidad debe ser mayor que cero.");
      return;
    }

    if (!Number.isFinite(puProd) || puProd <= 0) {
      alert("El precio unitario debe ser mayor que cero.");
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

    limpiarFormulario();
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

  function ocultarLista() {
    listaAutocomplete.style.display = "none";
    listaAutocomplete.innerHTML = "";
  }

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

  state.listaProductos.forEach((producto, index) => {
    const fila = document.createElement("tr");
    const excluido = !!producto.excluidoDescuento;
    fila.innerHTML = `
      <td>${producto.cantidad}</td>
      <td>${escapeHtml(producto.nombre)}</td>
      <td>$${producto.precioUnitario.toFixed(2)}</td>
      <td>${producto.precioUnitarioBS.toFixed(2)}Bs</td>
      <td>$${producto.precioTotal.toFixed(2)}</td>
      <td>${producto.precioTotalBS.toFixed(2)}Bs</td>
      <td class="acciones-producto">
        <button
          class="btn-toggle-desc${excluido ? " active" : ""}"
          data-index="${index}"
          title="${excluido ? "Volver a incluir en el descuento" : "Sacar del descuento (se suma completo al total)"}"
        >
          <i class="fa-solid ${excluido ? "fa-rotate-left" : "fa-tag"}"></i>
        </button>
        <button class="btn-editar" data-index="${index}" title="Editar producto"><i class="fa-solid fa-pen"></i></button>
        <button class="btn-eliminar" data-index="${index}"> <i class="fa-solid fa-trash"></i> </button>
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

    totalFinal.innerHTML = `
        ${
          porcentajeDescuento > 0
            ? `
          <div>
              <h2>Sub-Total:</h2>
              <h2>$${subTotalUSD.toFixed(2)} / ${subTotalBS.toFixed(2)}Bs</h2>
          </div>
          <div>
              <h2>Descuento (-${porcentajeDescuento}%):</h2>
              <h2>-$${state.descUSD.toFixed(2)} / -${state.descBS.toFixed(2)}Bs</h2>
          </div>
        `
            : ""
        } 
        <div class="total-procesar">
          <div>
            <h1>Total: </h1>
            <h1>$${state.montoFinalUSD.toFixed(2)} / ${state.montoFinalBS.toFixed(2)}Bs</h1>
            <br>
            <button class="process" onclick="finalizarCompra()" id="procesarCompra">Procesar Compra <i class="fas fa-receipt"></i> </button>
          </div>
        </div>
    `;
  }
}

function configurarDelegacionEventos() {
  document.addEventListener("click", (e) => {
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
    modal.innerHTML = `
      <div class="modal-editar-inner">
        <h3><i class="fa-solid fa-pen"></i> Editar producto</h3>
        <div class="campo-editar">
          <label>Cantidad</label>
          <input type="number" id="editFacCant" min="1" step="1">
        </div>
        <div class="campo-editar">
          <label>Nombre</label>
          <input type="text" id="editFacNombre">
        </div>
        <div class="campo-editar">
          <label>Precio unitario (USD)</label>
          <input type="number" id="editFacPrecioUnd" min="0" step="0.01">
        </div>
        <div class="acciones-modal-editar">
          <button class="btn-secondary" onclick="cerrarModalEditarProductoFac()">Cancelar</button>
          <button class="btn-primary" onclick="guardarEdicionProductoFac()">Guardar</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  modal.dataset.index = index;
  document.getElementById("editFacCant").value = producto.cantidad;
  document.getElementById("editFacNombre").value = producto.nombre;
  document.getElementById("editFacPrecioUnd").value = producto.precioUnitario;
  modal.classList.remove("hidden");
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

  if (!nombre || cant <= 0 || precioUnd <= 0) {
    alert("Por favor, completa correctamente cantidad, nombre y precio unitario.");
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
    alert(
      "Debes completar los datos del cliente antes de finalizar la compra.",
    );
    abrirModalCliente();
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