const Router = {
  pages: {},
  currentSection: null,

  register(name, module) { this.pages[name] = module; },

  async navigate(section) {
    if (!this.pages[section]) return;
    if (this.currentSection === section) return;

    if (this.currentSection && this.pages[this.currentSection]?.unload) {
      this.pages[this.currentSection].unload();
    }

    this.currentSection = section;
    localStorage.setItem('apim-last-section', section);

    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.section === section);
    });

    const container = document.getElementById('page-content');
    container.innerHTML = '';

    // Only fade if render takes > 80ms — no flash on cached pages
    let faded = false;
    const fadeTimer = setTimeout(() => {
      faded = true;
      container.style.opacity = '0';
    }, 80);

    try {
      await this.pages[section].render(container);
    } catch (e) {
      container.innerHTML = `<div class="alert alert-danger m-2"><i class="bi bi-exclamation-triangle me-1"></i>${e.message}</div>`;
    }

    clearTimeout(fadeTimer);
    if (faded) {
      requestAnimationFrame(() => {
        container.style.transition = 'opacity 150ms ease';
        container.style.opacity = '1';
      });
    } else {
      container.style.opacity = '1';
      container.style.transition = '';
    }
  }
};

const ConnectionBanner = {
  _bannerId: 'backend-connection-banner',
  show() {
    const c = document.getElementById('page-content');
    if (!c || document.getElementById(this._bannerId)) return;
    const b = document.createElement('div');
    b.id = this._bannerId;
    b.className = 'alert alert-danger py-2 mb-2 mx-2 mt-2';
    b.style.fontSize = '.82rem';
    b.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i> Backend not running \u2014 start with <code>python app.py</code>';
    c.insertAdjacentElement('afterbegin', b);
  },
  remove() { document.getElementById(this._bannerId)?.remove(); }
};

async function checkConnection() {
  const dot = document.getElementById('connection-dot');
  if (!dot) return;
  // health() now internally calls prefetchAll() when connected — no duplicate call needed
  const ok = await API.health();
  dot.className = 'connection-dot ' + (ok ? 'ok' : 'error');
  dot.title = ok ? 'Backend connected' : 'Backend not reachable';
  ok ? ConnectionBanner.remove() : ConnectionBanner.show();
}

let _refreshTimer = null;
function startAutoRefresh() {
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(() => API.refreshCache(), 30 * 60 * 1000);
}

document.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => Router.navigate(el.dataset.section));
  });

  API.setUiReady();

  // Single call — health() checks connection AND fires prefetch in one round trip
  checkConnection();
  setInterval(checkConnection, 30000);
  startAutoRefresh();

  if (localStorage.getItem('apim-last-section') === 'home') localStorage.setItem('apim-last-section', 'assistant');
  await Router.navigate(localStorage.getItem('apim-last-section') || 'assistant');

  if (typeof BookmarksDropdown !== 'undefined') BookmarksDropdown.mount();

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      const sections = ['assistant', 'explorer', 'create-api', 'products', 'diff', 'promote', 'onboard', 'settings', 'spec-generator'];
      const idx = parseInt(e.key) - 1;
      if (idx < sections.length) Router.navigate(sections[idx]);
    }
    if (e.key === 'Escape') {
      const modal = document.querySelector('.modal.show');
      if (modal) bootstrap.Modal.getInstance(modal)?.hide();
    }
  });
});
