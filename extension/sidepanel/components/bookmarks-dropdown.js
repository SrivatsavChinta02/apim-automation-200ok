/**
 * BookmarksDropdown — a top-left header dropdown listing bookmarked APIs
 * with environment badges. Reuses Bookmarks from components/utils.js.
 *
 * Actual getAll() shape (flat): { id, displayName, path, revision, versionName, env, addedAt }
 * (NOT {api, env} — the Bookmarks.add() stores flat objects, not nested api objects.)
 */
const BookmarksDropdown = {
  _open: false,
  _mounted: false,

  mount() {
    if (this._mounted) return;
    const trigger = document.getElementById('bookmarks-trigger');
    const panel = document.getElementById('bookmarks-panel');
    if (!trigger || !panel) return;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggle();
    });

    document.addEventListener('click', (e) => {
      if (this._open && !panel.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) {
        this._close();
      }
    });

    this._mounted = true;
  },

  _toggle() { this._open ? this._close() : this._openPanel(); },

  _openPanel() {
    this._render();
    document.getElementById('bookmarks-panel').classList.add('open');
    this._open = true;
  },

  _close() {
    document.getElementById('bookmarks-panel').classList.remove('open');
    this._open = false;
  },

  _render() {
    const panel = document.getElementById('bookmarks-panel');
    if (typeof HTMLEscape === 'undefined' || typeof Bookmarks === 'undefined') {
      panel.innerHTML = '<div class="bookmarks-empty">Bookmarks unavailable.</div>';
      return;
    }
    const all = Bookmarks.getAll ? Bookmarks.getAll() : [];
    if (!all || all.length === 0) {
      panel.innerHTML = '<div class="bookmarks-empty">No bookmarks yet. Star an API in Explorer.</div>';
      return;
    }
    const validEnvs = new Set(['dev', 'sandbox', 'prod', 'dr']);
    // Flat shape: { id, displayName, path, revision, versionName, env, addedAt }
    panel.innerHTML = all.map(b => {
      const apiId = b.id || '';
      const name = b.displayName || b.id || '';
      const env = b.env || '';
      const envClass = validEnvs.has(env) ? `env-${env}` : 'env-unknown';
      const safeName = HTMLEscape.escape(name);
      return `
        <div class="bookmark-row" data-api-id="${HTMLEscape.escape(apiId)}" data-env="${HTMLEscape.escape(env)}">
          <span class="bookmark-name" title="${safeName}">${safeName}</span>
          <span class="env-badge ${envClass}">${HTMLEscape.escape(env)}</span>
          <button class="bookmark-remove" data-api-id="${HTMLEscape.escape(apiId)}" data-env="${HTMLEscape.escape(env)}" title="Remove bookmark">
            <i class="bi bi-x"></i>
          </button>
        </div>
      `;
    }).join('');

    panel.querySelectorAll('.bookmark-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.bookmark-remove')) return;
        const apiId = row.dataset.apiId;
        const env = row.dataset.env;
        if (env) localStorage.setItem('apim-explorer-env', env);
        if (apiId) localStorage.setItem('apim-explorer-focus-api', apiId);
        if (typeof Router !== 'undefined') Router.navigate('explorer');
        this._close();
      });
    });

    panel.querySelectorAll('.bookmark-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const apiId = btn.dataset.apiId;
        const env = btn.dataset.env;
        if (typeof Bookmarks !== 'undefined' && Bookmarks.remove) {
          Bookmarks.remove(apiId, env);
        }
        this._render();
      });
    });
  },
};
