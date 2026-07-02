const Explorer = {
  currentEnv: 'dev',
  apis: [],

  async render(container) {
    this.apis = [];

    // Pick up assistant prefill (cleared after one read)
    const _prefillRaw = sessionStorage.getItem('assistant-prefill');
    if (_prefillRaw) {
      sessionStorage.removeItem('assistant-prefill');
      try {
        const _prefill = JSON.parse(_prefillRaw);
        if (_prefill && _prefill.page === 'explorer' && _prefill.params) {
          if (_prefill.params.env) localStorage.setItem('apim-explorer-env', _prefill.params.env);
          if (_prefill.params.searchTerm) sessionStorage.setItem('apim-explorer-pending-search', _prefill.params.searchTerm);
        }
      } catch (e) { /* ignore malformed prefill */ }
    }

    // Check if there's a selected API from navigation (search or recent APIs)
    const selectedApiId = sessionStorage.getItem('explorer-select-api-id');
    const selectedEnv = sessionStorage.getItem('explorer-select-env');

    // Clear sessionStorage immediately to avoid re-triggering
    if (selectedApiId) {
      sessionStorage.removeItem('explorer-select-api-id');
      sessionStorage.removeItem('explorer-select-env');
      // Store in instance variable for later use
      this.pendingSelection = { apiId: selectedApiId, env: selectedEnv || 'dev' };
      // Set the current env to match the selected API
      if (selectedEnv) {
        this.currentEnv = selectedEnv;
      }
    }

    container.innerHTML = `
      <div class="d-flex align-items-center justify-content-between mb-2">
        <span class="fw-bold" style="font-size:.95rem">
          <i class="bi bi-list-ul me-1 text-primary"></i>API Explorer
        </span>
        <div class="d-flex gap-1">
          <button class="btn btn-sm btn-outline-secondary py-0 px-2" id="explorer-export-btn" title="Export to CSV">
            <i class="bi bi-download"></i>
          </button>
          <button class="btn btn-sm btn-outline-secondary py-0 px-2" id="explorer-refresh-btn" title="Refresh (clear cache)">
            <i class="bi bi-arrow-clockwise"></i>
          </button>
        </div>
      </div>
      <div id="explorer-tabs"></div>
      <div class="input-group input-group-sm mb-2 mt-2">
        <span class="input-group-text bg-white"><i class="bi bi-search text-muted"></i></span>
        <input type="text" class="form-control border-start-0" id="api-filter" placeholder="Filter APIs..." autocomplete="off">
      </div>
      <div id="api-table-area"></div>`;

    EnvTabs.render(document.getElementById('explorer-tabs'), this.currentEnv, env => {
      this.currentEnv = env;
      this.renderForEnv();
    });

    document.getElementById('api-filter').addEventListener('input', (e) => {
      this.filterTable(e.target.value);
    });

    // Apply pending search from assistant prefill
    const _pendingSearch = sessionStorage.getItem('apim-explorer-pending-search');
    if (_pendingSearch) {
      sessionStorage.removeItem('apim-explorer-pending-search');
      const _searchInput = document.getElementById('api-filter');
      if (_searchInput) {
        _searchInput.value = _pendingSearch;
        _searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    document.getElementById('explorer-export-btn').addEventListener('click', () => {
      this.exportToCSV();
    });

    document.getElementById('explorer-refresh-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const restoreBtn = ButtonLoader.start(btn, 'Refreshing...');

      try {
        API.refreshCache();
        Toast.show('Cache refreshed successfully', 'success');
        this.showLoading();

        // Wait for prefetch to complete
        await new Promise(resolve => {
          const handler = () => {
            API.Events.off('prefetch-complete', handler);
            resolve();
          };
          API.Events.on('prefetch-complete', handler);

          // Timeout after 30 seconds
          setTimeout(() => {
            API.Events.off('prefetch-complete', handler);
            resolve();
          }, 30000);
        });
      } finally {
        restoreBtn();
      }
    });

    this._onDataLoaded = this._onDataLoaded.bind(this);
    this._onPrefetchStarted = () => this.showLoading();
    this._onOpsComplete = this._onOpsComplete.bind(this);

    API.Events.on('env-data-loaded', this._onDataLoaded);
    API.Events.on('prefetch-started', this._onPrefetchStarted);
    API.Events.on('prefetch-ops-complete', this._onOpsComplete);

    this.renderForEnv();
  },

  unload() {
    API.Events.off('env-data-loaded', this._onDataLoaded);
    API.Events.off('prefetch-started', this._onPrefetchStarted);
    API.Events.off('prefetch-ops-complete', this._onOpsComplete);
  },

  _onDataLoaded({ env, type, data }) {
    if (env === this.currentEnv && type === 'APIs') {
      this.apis = data;
      this.renderTable(data);
      // If a search term was already typed (e.g. via assistant prefill applied
      // before APIs arrived), re-run the filter now that we have data.
      const _filterInput = document.getElementById('api-filter');
      if (_filterInput && _filterInput.value) {
        this.filterTable(_filterInput.value);
      }
      this._warmTopApis(data.slice(0, 10));
      this._handlePendingSelection();
    }
  },

  _handlePendingSelection() {
    // Handle pending API selection from navigation
    if (this.pendingSelection && this.pendingSelection.env === this.currentEnv) {
      const apiId = this.pendingSelection.apiId;
      this.pendingSelection = null; // Clear after use

      // Find and expand the selected API with retry logic
      const expandApi = (attempt = 0) => {
        const row = document.querySelector(`tr[data-api-id="${apiId}"]`);
        if (row) {
          // Find the API object
          const api = this.apis.find(a => a.id === apiId) ||
                      this.apis.flatMap(a => a.versions || []).find(v => v.id === apiId);
          if (api) {
            // Expand the detail view
            this.toggleDetail(api, row);
            // Scroll to the row after a brief delay to ensure expansion is rendered
            setTimeout(() => {
              row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 50);
          }
        } else if (attempt < 3) {
          // Retry up to 3 times if row not found yet
          setTimeout(() => expandApi(attempt + 1), 200);
        }
      };

      // Start trying to expand after DOM is ready
      setTimeout(() => expandApi(), 300);
    }
  },

  _onOpsComplete({ env }) {
    if (env !== this.currentEnv) return;
    document.querySelectorAll('.detail-row[data-api-id]').forEach(async row => {
      const apiId = row.dataset.apiId;
      const td = row.querySelector('td');
      if (!td || !td.querySelector('.skeleton')) return;
      const cached = Cache.get(`/api/apis/${apiId}`, { env: this.currentEnv });
      if (cached) this._renderDetailContent(td, cached);
    });
  },

  async _warmTopApis(apis) {
    for (const api of apis) {
      if (!Cache.get(`/api/apis/${api.id}`, { env: this.currentEnv })) {
        try { await API.get(`/api/apis/${api.id}`, { env: this.currentEnv }); }
        catch (e) { /* silent */ }
      }
    }
  },

  showLoading() {
    const area = document.getElementById('api-table-area');
    if (!area) return;
    area.innerHTML = `
      <div class="skeleton mb-2" style="height:36px;border-radius:6px"></div>
      <div class="skeleton mb-2" style="height:36px;border-radius:6px"></div>
      <div class="skeleton mb-2" style="height:36px;border-radius:6px"></div>
      <div class="skeleton mb-2" style="height:36px;border-radius:6px"></div>
      <div class="skeleton" style="height:36px;border-radius:6px"></div>`;
  },

  renderForEnv() {
    const area = document.getElementById('api-table-area');
    if (!area) return;

    // Show production warning banner for PROD/DR environments
    let content = '';
    if (this.currentEnv === 'prod' || this.currentEnv === 'dr') {
      content += `
        <div class="alert alert-warning py-2 px-3 mb-3 d-flex align-items-center" style="border-left:4px solid #d97706">
          <i class="bi bi-exclamation-triangle-fill me-2" style="font-size:1.1rem"></i>
          <div>
            <strong>Viewing ${this.currentEnv.toUpperCase()} Environment</strong> —
            Changes will affect live traffic!
          </div>
        </div>`;
    }

    const cachedApis = Cache.get('/api/apis', { env: this.currentEnv });
    if (cachedApis) {
      this.apis = cachedApis;
      if (!cachedApis.length) {
        area.innerHTML = content + `
          <div class="empty-state mt-4">
            <i class="bi bi-inbox"></i>
            <div class="fw-semibold mb-1">No APIs Found</div>
            <div style="font-size:.82rem">No APIs in this environment.</div>
          </div>`;
        return;
      }
      area.innerHTML = content + '<div id="api-table-container"></div>';
      this.renderTable(cachedApis);
      this._warmTopApis(cachedApis.slice(0, 10));
      this._handlePendingSelection();
    } else {
      area.innerHTML = content;
      this.showLoading();
    }
  },

  renderTable(apis) {
    // Check if table container exists, if not rebuild area structure
    let container = document.getElementById('api-table-container');
    if (!container) {
      const area = document.getElementById('api-table-area');
      // Clear skeleton and rebuild with warning banner (if PROD/DR) + container
      let content = '';
      if (this.currentEnv === 'prod' || this.currentEnv === 'dr') {
        content = `
          <div class="alert alert-warning py-2 px-3 mb-3 d-flex align-items-center" style="border-left:4px solid #d97706">
            <i class="bi bi-exclamation-triangle-fill me-2" style="font-size:1.1rem"></i>
            <div>
              <strong>Viewing ${this.currentEnv.toUpperCase()} Environment</strong> —
              Changes will affect live traffic!
            </div>
          </div>`;
      }
      area.innerHTML = content + '<div id="api-table-container"></div>';
      container = document.getElementById('api-table-container');
    }

    container.innerHTML = `
      <table class="table table-hover table-compact mb-0">
        <thead><tr class="table-light">
          <th>API Name</th><th>Base Path</th><th style="text-align:center">Rev</th><th></th>
        </tr></thead>
        <tbody id="api-tbody"></tbody>
      </table>`;
    const tbody = document.getElementById('api-tbody');
    const addApiRow = (api, isVersion = false, parentDisplayName = '') => {
      const row = document.createElement('tr');
      row.style.cursor = 'pointer';
      row.dataset.apiId = api.id;
      const pathDisplay = api.path ? `<code class="text-muted" style="font-size:.78rem">${api.path}</code>` : '<span class="text-muted">—</span>';
      const nameDisplay = isVersion
        ? `<span style="padding-left:1rem;font-size:.82rem">${api.versionName || api.path}</span>`
        : `<span class="fw-semibold">${api.displayName}</span>`;
      if (isVersion) row.style.background = '#f8fafc';
      const isBookmarked = Bookmarks.isBookmarked(api.id, this.currentEnv);
      row.innerHTML = `
        <td>${nameDisplay}</td>
        <td>${pathDisplay}</td>
        <td style="text-align:center"><span class="badge bg-secondary" style="font-size:.7rem">${api.revision}</span></td>
        <td class="text-end" style="white-space:nowrap">
          <button class="btn btn-outline-${isBookmarked ? 'warning' : 'secondary'} btn-sm py-0 px-1 me-1"
                  title="${isBookmarked ? 'Remove bookmark' : 'Bookmark this API'}"
                  data-action="bookmark">
            <i class="bi bi-star${isBookmarked ? '-fill' : ''}"></i>
          </button>
          <button class="btn btn-outline-success btn-sm py-0 px-1" title="Promote" data-action="promote">
            <i class="bi bi-send"></i>
          </button>
        </td>`;

      row.setAttribute('tabindex', '0');
      row.setAttribute('role', 'button');
      const handleRowActivate = (e) => {
        if (e.target.closest('button')) return;
        this.toggleDetail(api, row);
      };
      row.addEventListener('click', handleRowActivate);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleRowActivate(e); }
      });

      row.querySelector('[data-action="bookmark"]').addEventListener('click', (e) => {
        e.stopPropagation();
        const nowBookmarked = Bookmarks.toggle(api, this.currentEnv);
        const btn = e.currentTarget;
        const icon = btn.querySelector('i');
        if (nowBookmarked) {
          btn.classList.remove('btn-outline-secondary');
          btn.classList.add('btn-outline-warning');
          btn.title = 'Remove bookmark';
          icon.classList.remove('bi-star');
          icon.classList.add('bi-star-fill');
        } else {
          btn.classList.remove('btn-outline-warning');
          btn.classList.add('btn-outline-secondary');
          btn.title = 'Bookmark this API';
          icon.classList.remove('bi-star-fill');
          icon.classList.add('bi-star');
        }
        // Emit event to update home page if it's open
        API.Events.emit('bookmarks-changed');
      });

      row.querySelector('[data-action="promote"]').addEventListener('click', () => {
        sessionStorage.setItem('promote-api-id', api.id);
        sessionStorage.setItem('promote-src-env', this.currentEnv);
        sessionStorage.setItem('promote-api-name', api.versionName ? `${api.displayName || parentDisplayName} (${api.versionName})` : api.displayName);
        sessionStorage.setItem('promote-api-path', api.path);
        sessionStorage.setItem('promote-api-revision', api.revision);
        Router.navigate('promote');
      });

      tbody.appendChild(row);
    };

    apis.forEach(api => {
      if (api.versions && api.versions.length > 0) {
        // Group header row — not clickable for detail, just shows the API name
        const headerRow = document.createElement('tr');
        headerRow.style.background = '#f0f4ff';
        headerRow.innerHTML = `
          <td class="fw-semibold" colspan="2">${api.displayName}
            <span class="badge bg-primary ms-2" style="font-size:.68rem">${api.versions.length} versions</span>
          </td>
          <td></td><td></td>`;
        tbody.appendChild(headerRow);
        // One sub-row per version
        api.versions.forEach(v => {
          addApiRow({ ...v, displayName: api.displayName }, true, api.displayName);
        });
      } else {
        addApiRow(api);
      }
    });
  },

  async toggleDetail(api, row) {
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('detail-row')) {
      existing.remove();
      return;
    }

    const detailRow = document.createElement('tr');
    detailRow.className = 'detail-row';
    detailRow.dataset.apiId = api.id;
    const td = document.createElement('td');
    td.colSpan = 4;
    detailRow.appendChild(td);
    row.after(detailRow);

    // Cache-first — no skeleton flash if already cached
    const cached = Cache.get(`/api/apis/${api.id}`, { env: this.currentEnv });
    if (cached) { this._renderDetailContent(td, cached); return; }

    td.innerHTML = '<div class="p-2"><div class="skeleton" style="height:60px;border-radius:6px"></div></div>';
    try {
      const detail = await API.get(`/api/apis/${api.id}`, { env: this.currentEnv });
      this._renderDetailContent(td, detail);
    } catch (e) {
      td.innerHTML = `<div class="p-2 text-danger" style="font-size:.82rem"><i class="bi bi-exclamation-circle me-1"></i>${e.message}</div>`;
    }
  },

  _renderDetailContent(td, detail) {
    if (!detail.operations || !detail.operations.length) {
      td.innerHTML = '<div class="p-2 text-muted" style="font-size:.82rem"><i class="bi bi-info-circle me-1"></i>No operations with policies</div>';
      return;
    }
    let html = '<table class="table table-sm table-compact mb-0"><thead><tr class="table-light"><th>Verb</th><th>Client Path</th><th>Backend Path</th><th style="width:40px"></th></tr></thead><tbody>';
    detail.operations.forEach(op => {
      const badgeCls = { GET:'bg-success',POST:'bg-primary',PUT:'bg-warning text-dark',DELETE:'bg-danger',PATCH:'bg-purple' }[op.method] || 'bg-secondary';
      html += `<tr>
        <td><span class="badge ${badgeCls}" style="font-size:.7rem;min-width:44px">${op.method}</span></td>
        <td><code style="font-size:.75rem">${op.urlTemplate}</code></td>
        <td><code style="font-size:.75rem">${op.rewriteUri || '\u2014'}</code></td>
        <td class="text-center">
          <button class="btn btn-outline-secondary btn-sm py-0 px-1"
                  style="font-size:.7rem"
                  title="Copy client path"
                  data-copy-path="${op.urlTemplate}">
            <i class="bi bi-clipboard"></i>
          </button>
        </td>
      </tr>`;
    });
    html += '</tbody></table>';
    const container = document.createElement('div');
    container.className = 'p-2';
    container.style.background = '#f9fafb';
    container.style.borderRadius = '6px';
    container.innerHTML = html;

    // Add copy handlers
    container.querySelectorAll('[data-copy-path]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const path = btn.dataset.copyPath;
        Clipboard.copy(path, `Copied: ${path}`);
      });
    });

    td.innerHTML = '';
    td.appendChild(container);
  },

  filterTable(query) {
    if (!this.apis) return;
    const q = query.toLowerCase();
    const filtered = q ? this.apis.filter(a =>
      a.displayName.toLowerCase().includes(q) ||
      a.path.toLowerCase().includes(q) ||
      a.id.toLowerCase().includes(q)
    ) : this.apis;
    this.renderTable(filtered);
  },

  exportToCSV() {
    if (!this.apis || !this.apis.length) {
      Toast.show('No APIs to export', 'warning');
      return;
    }

    // Flatten versioned APIs for export
    const exportData = [];
    this.apis.forEach(api => {
      if (api.versions && api.versions.length > 0) {
        api.versions.forEach(v => {
          exportData.push({
            displayName: api.displayName,
            versionName: v.versionName || '',
            path: v.path,
            revision: v.revision,
            id: v.id
          });
        });
      } else {
        exportData.push({
          displayName: api.displayName,
          versionName: '',
          path: api.path,
          revision: api.revision,
          id: api.id
        });
      }
    });

    Exporter.toCSV(
      exportData,
      `apis-${this.currentEnv}`,
      ['displayName', 'versionName', 'path', 'revision', 'id']
    );
  }
};

Router.register('explorer', Explorer);
