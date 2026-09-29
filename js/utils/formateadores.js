const documentType = document.getElementById('documentType');
const documentNumber = document.getElementById('documentNumber');

// Reglas por tipo de documento (máximo de DÍGITOS puros)
const DOC_RULES = {
  V: { maxDigits: 8, placeholder: '12.345.678' },
  E: { maxDigits: 9, placeholder: '80.000.000' },
  J: { maxDigits: 9, placeholder: '123.456.78-9' },
  G: { maxDigits: 9, placeholder: '200.000.00-0' },
  P: { maxDigits: 9, placeholder: '123.456.789' },
  C: { maxDigits: 9, placeholder: '123.456.789' }
};

// 1. Formatear Cédula / RIF con puntos automáticamente
function formatDoc() {
  const selectedType = documentType.value;
  const config = DOC_RULES[selectedType] || DOC_RULES.V;

  // Extraer solo números y limitar la cantidad de dígitos según la regla
  let rawValue = documentNumber.value.replace(/\D/g, '').slice(0, config.maxDigits);

  if (!rawValue) {
    documentNumber.value = '';
    return;
  }

  // Formatear con puntos de miles (es-VE)
  documentNumber.value = new Intl.NumberFormat('es-VE').format(parseInt(rawValue, 10));
}

// 2. Actualizar placeholder y reformatear al cambiar de tipo (V, E, J, etc.)
function updateDocRules() {
  const selectedType = documentType.value;
  const config = DOC_RULES[selectedType] || DOC_RULES.V;

  // Permitir espacio suficiente en el HTML para los dígitos + los puntos
  documentNumber.maxLength = config.maxDigits + 3;
  documentNumber.placeholder = config.placeholder;

  // Re-aplicar el formato con el nuevo límite
  formatDoc();
}

// Escuchar eventos en el Documento
documentNumber.addEventListener('input', formatDoc);
documentType.addEventListener('change', updateDocRules);

// Configuración inicial
updateDocRules();

/**
 * Obtener el documento limpio para enviar al Backend
 * @returns {string} Ej: "V-12345678" (Sin puntos)
 */
function getFullDocument() {
  const prefix = documentType.value;
  const cleanNumber = documentNumber.value.replace(/\D/g, ''); // Remueve los puntos
  return cleanNumber ? `${prefix}-${cleanNumber}` : '';
}

// ----------------------------------------------------
// Funciones Utilitarias Adicionales
// ----------------------------------------------------

// Capitalizar Nombres/Apellidos (Ej: "juan perez" -> "Juan Perez")
function formatText(input) {
  let valor = input.value.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ ]/g, "");
  input.value = valor
    .toLowerCase()
    .replace(/(^\w{1})|(\s+\w{1})/g, letter => letter.toUpperCase());
}

// Formatear Teléfono Venezolano (Ej: "04121234567" -> "0412-123-4567")
function formatPhone(input) {
  let telefono = input.value.replace(/\D/g, "").slice(0, 11); // Máximo 11 dígitos
  
  if (telefono.length > 4 && telefono.length <= 7) {
    telefono = telefono.slice(0, 4) + "-" + telefono.slice(4);
  } else if (telefono.length > 7) {
    telefono = telefono.slice(0, 4) + "-" + telefono.slice(4, 7) + "-" + telefono.slice(7, 11);
  }
  
  input.value = telefono;
}