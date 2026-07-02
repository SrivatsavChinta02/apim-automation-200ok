const Toast = {
  show(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) { console.warn('Toast container not found'); return; }
    const colors = { success: 'bg-success', error: 'bg-danger', info: 'bg-primary', warning: 'bg-warning' };
    const icons = { success: 'bi-check-circle', error: 'bi-x-circle', info: 'bi-info-circle', warning: 'bi-exclamation-triangle' };
    const el = document.createElement('div');
    el.className = 'toast show align-items-center text-white border-0 ' + (colors[type] || colors.info);
    el.setAttribute('role', 'alert');
    el.innerHTML = `
      <div class="d-flex">
        <div class="toast-body"><i class="bi ${icons[type] || icons.info} me-1"></i>${message}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" onclick="this.closest('.toast').remove()"></button>
      </div>`;
    container.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 3000);
  }
};
