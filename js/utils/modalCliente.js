function abrirModalCliente() {
  const modal = document.getElementById("modalDataCliente");
  if (modal && !modal.open) {
    modal.showModal();
  }
}