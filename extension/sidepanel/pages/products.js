const Products = {
  currentEnv: 'dev',
  products: [],
  _selectedApiId: null,
  _selectedApiName: null,

  async render(container) {
    this.currentEnv = 'dev';
    this.products = [];
    this._selectedApiId = null;
    this._selectedApiName = null;

    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'p-2';

    // --- Page title row ---
    const titleRow = document.createElement('div');
    titleRow.className = 'd-flex align-items-center justify-content-between mb-2';
    titleRow.innerHTML = `
      <span class="fw-bold" style="font-size:.95rem">
        <i class="bi bi-box me-1 text-primary"></i>Products &amp; Subscriptions
      </span>
      <div class="d-flex gap-1">
        <button class="btn btn-sm btn-outline-secondary py-0 px-2" id="products-refresh-btn" title="Refresh" style="font-size:.78rem">
          <i class="bi bi-arrow-clockwise"></i>
        </button>
        <button class="btn btn-sm btn-primary py-0 px-2" id="products-new-product-btn" style="font-size:.78rem">
          <i class="bi bi-plus me-1"></i>Product
        </button>
        <button class="btn btn-sm btn-outline-primary py-0 px-2" id="products-new-sub-btn" style="font-size:.78rem">
          <i class="bi bi-plus me-1"></i>Subscription
        </button>
      </div>`;
    wrap.appendChild(titleRow);

    // --- EnvTabs ---
    const tabContainer = document.createElement('div');
    wrap.appendChild(tabContainer);
    EnvTabs.render(tabContainer, this.currentEnv, env => {
      this.currentEnv = env;
      this._loadProducts();
    });

    // --- Table area ---
    this._tableArea = document.createElement('div');
    wrap.appendChild(this._tableArea);

    container.appendChild(wrap);

    // Wire buttons
    document.getElementById('products-refresh-btn').addEventListener('click', () => {
      Cache.invalidate('/api/products');
      Toast.show('Cache cleared, refreshing...', 'info');
      this._loadProducts();
    });
    document.getElementById('products-new-product-btn').addEventListener('click', () => this._showCreateProductModal());
    document.getElementById('products-new-sub-btn').addEventListener('click', () => this._showCreateSubModal());

    // Ensure modals exist
    this._ensureKeysModal();
    this._ensureCreateProductModal();
    this._ensureCreateSubModal();
    this._ensureConfirmModal();

    this._loadProducts();
  },

  // ─────────────────────────────────────────────
  // Data loading
  // ─────────────────────────────────────────────

  async _loadProducts() {
    const area = this._tableArea;

    // FIX: render from cache instantly (no skeleton flash) then silently refresh if stale
    const cached = Cache.get('/api/products', { env: this.currentEnv });
    if (cached) {
      this.products = cached;
      if (!cached.length) {
        area.innerHTML = `<div class="card hover-lift"><div class="card-gradient-header"><i class="bi bi-inbox me-1"></i>No Products</div><div class="card-body text-muted" style="font-size:.85rem">No products found in this environment.</div></div>`;
      } else {
        this._renderTable(cached);
      }
    } else {
      area.innerHTML = Array(4).fill('<div class="skeleton mb-2" style="height:36px"></div>').join('');
    }

    try {
      const products = await API.get('/api/products', { env: this.currentEnv });
      this.products = products;
      if (!products.length) {
        area.innerHTML = `<div class="card hover-lift"><div class="card-gradient-header"><i class="bi bi-inbox me-1"></i>No Products</div><div class="card-body text-muted" style="font-size:.85rem">No products found in this environment.</div></div>`;
        return;
      }
      // Only re-render if data changed
      if (JSON.stringify(products) !== JSON.stringify(cached)) {
        this._renderTable(products);
      }
    } catch (e) {
      if (!cached) area.innerHTML = `<div class="alert alert-danger py-2" style="font-size:.82rem">${e.message}</div>`;
    }
  },

  _renderTable(products) {
    const area = this._tableArea;
    const table = document.createElement('table');
    table.className = 'table table-hover mb-0';
    table.innerHTML = `
      <thead>
        <tr class="table-light">
          <th style="font-size:.8rem">Name</th>
          <th style="font-size:.8rem">Display Name</th>          
          <th style="font-size:.8rem">State</th>
        </tr>
      </thead>`;
    const tbody = document.createElement('tbody');
    tbody.id = 'products-tbody';

    products.forEach(p => {
      const row = document.createElement('tr');
      row.style.cursor = 'pointer';
      row.className = 'hover-lift';
      const stateBadge = p.state === 'published'
        ? '<span class="badge" style="background:#d1fae5;color:#065f46;font-size:.72rem">published</span>'
        : '<span class="badge bg-secondary" style="font-size:.72rem">not published</span>';
      row.innerHTML = `
        <td class="fw-semibold" style="font-size:.82rem">${p.id}</td>
        <td style="font-size:.82rem">${p.displayName}</td>
        <td>${stateBadge}</td>`;

      row.addEventListener('click', () => this._toggleExpand(p, row, tbody));
      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    area.innerHTML = '';
    area.appendChild(table);
  },

  async _toggleExpand(product, row, tbody) {
    // If already expanded, collapse
    const existing = row.nextElementSibling;
    if (existing && existing.dataset.expandFor === product.id) {
      existing.remove();
      return;
    }
    // Remove any other open expand rows
    tbody.querySelectorAll('tr[data-expand-for]').forEach(r => r.remove());

    const expandRow = document.createElement('tr');
    expandRow.dataset.expandFor = product.id;
    const td = document.createElement('td');
    td.colSpan = 3;
    td.innerHTML = '<div class="p-2"><div class="skeleton" style="height:70px"></div></div>';
    expandRow.appendChild(td);
    row.after(expandRow);

    try {
      const detail = await API.get(`/api/products/${product.id}`, { env: this.currentEnv });
      td.innerHTML = '';
      td.appendChild(this._buildExpandContent(detail));
    } catch (e) {
      td.innerHTML = `<div class="p-2 text-danger" style="font-size:.82rem">${e.message}</div>`;
    }
  },

  _buildExpandContent(detail) {
    const wrap = document.createElement('div');
    wrap.className = 'p-2';
    wrap.style.background = '#f9fafb';

    // Subscriptions sub-table
    const subTitle = document.createElement('div');
    subTitle.className = 'fw-semibold mb-1';
    subTitle.style.fontSize = '.8rem';
    subTitle.innerHTML = '<i class="bi bi-key me-1 text-warning"></i>Subscriptions';
    wrap.appendChild(subTitle);

    if (!detail.subscriptions || !detail.subscriptions.length) {
      const noSubs = document.createElement('p');
      noSubs.className = 'text-muted mb-2';
      noSubs.style.fontSize = '.8rem';
      noSubs.textContent = 'No subscriptions.';
      wrap.appendChild(noSubs);
    } else {
      const subTable = document.createElement('table');
      subTable.className = 'table table-sm mb-2';
      subTable.innerHTML = `
        <thead><tr class="table-light">
          <th style="font-size:.75rem">Display Name</th>
          <th style="font-size:.75rem">State</th>
          <th style="font-size:.75rem">Created</th>
          <th></th>
        </tr></thead>`;
      const stbody = document.createElement('tbody');
      detail.subscriptions.forEach(sub => {
        const tr = document.createElement('tr');
        const stateClass = sub.state === 'active' ? 'bg-success' : 'bg-secondary';
        const created = sub.createdDate ? sub.createdDate.slice(0, 10) : '—';
        tr.innerHTML = `
          <td style="font-size:.78rem">${sub.displayName}</td>
          <td><span class="badge ${stateClass}" style="font-size:.7rem">${sub.state}</span></td>
          <td style="font-size:.78rem">${created}</td>
          <td></td>`;
        const keysBtn = document.createElement('button');
        keysBtn.className = 'btn btn-sm btn-outline-secondary py-0 px-1';
        keysBtn.style.fontSize = '.72rem';
        keysBtn.innerHTML = '<i class="bi bi-key me-1"></i>View Keys';
        keysBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._showKeysModal(sub.id, sub.displayName);
        });
        tr.querySelector('td:last-child').appendChild(keysBtn);
        stbody.appendChild(tr);
      });
      subTable.appendChild(stbody);
      wrap.appendChild(subTable);
    }

    // Linked APIs
    if (detail.apis && detail.apis.length) {
      const apiTitle = document.createElement('div');
      apiTitle.className = 'fw-semibold mb-1';
      apiTitle.style.fontSize = '.8rem';
      apiTitle.innerHTML = '<i class="bi bi-link-45deg me-1 text-primary"></i>Linked APIs';
      wrap.appendChild(apiTitle);
      const apiList = document.createElement('ul');
      apiList.className = 'list-unstyled mb-0';
      detail.apis.forEach(api => {
        const li = document.createElement('li');
        li.style.fontSize = '.78rem';
        li.innerHTML = `<i class="bi bi-chevron-right text-muted me-1"></i>${api.displayName} <code style="font-size:.72rem">(${api.id})</code>`;
        apiList.appendChild(li);
      });
      wrap.appendChild(apiList);
    }

    return wrap;
  },

  // ─────────────────────────────────────────────
  // View Keys Modal
  // ─────────────────────────────────────────────

  _ensureKeysModal() {
    if (document.getElementById('products-keys-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'products-keys-modal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.innerHTML = `
      <div class="modal-dialog modal-sm">
        <div class="modal-content">
          <div class="modal-header py-2 px-3" style="background:var(--apim-gradient);color:white;">
            <h6 class="modal-title mb-0"><i class="bi bi-key me-1"></i>Subscription Keys</h6>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body py-3 px-3" id="products-keys-body">
            <div class="skeleton mb-2" style="height:32px"></div>
            <div class="skeleton" style="height:32px"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  async _showKeysModal(subId, subName) {
    const body = document.getElementById('products-keys-body');
    body.innerHTML = `
      <div class="skeleton mb-2" style="height:32px"></div>
      <div class="skeleton" style="height:32px"></div>`;

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('products-keys-modal'));
    document.querySelector('#products-keys-modal .modal-title').innerHTML =
      `<i class="bi bi-key me-1"></i>${subName}`;
    modal.show();

    try {
      const keys = await API.get(`/api/subscriptions/${subId}/keys`, { env: this.currentEnv });
      body.innerHTML = '';
      const keyDefs = [
        { label: 'Primary Key', value: keys.primaryKey },
        { label: 'Secondary Key', value: keys.secondaryKey },
      ];
      keyDefs.forEach(k => {
        const row = this._buildKeyRow(k.label, k.value);
        body.appendChild(row);
      });
    } catch (e) {
      body.innerHTML = `<div class="alert alert-danger py-2" style="font-size:.82rem">${e.message}</div>`;
    }
  },

  _buildKeyRow(label, value) {
    const wrap = document.createElement('div');
    wrap.className = 'mb-3';

    const lbl = document.createElement('div');
    lbl.className = 'fw-semibold mb-1';
    lbl.style.fontSize = '.78rem';
    lbl.textContent = label;
    wrap.appendChild(lbl);

    const row = document.createElement('div');
    row.className = 'd-flex gap-1';

    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.className = 'form-control form-control-sm flex-grow-1';
    keyInput.style.fontSize = '.75rem';
    keyInput.value = value || '';
    keyInput.readOnly = true;
    keyInput.autocomplete = 'off';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-sm btn-outline-secondary py-0';
    toggleBtn.innerHTML = '<i class="bi bi-eye"></i>';
    toggleBtn.addEventListener('click', () => {
      const showing = keyInput.type === 'text';
      keyInput.type = showing ? 'password' : 'text';
      toggleBtn.innerHTML = showing ? '<i class="bi bi-eye"></i>' : '<i class="bi bi-eye-slash"></i>';
    });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-sm btn-outline-primary py-0';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(value || '').then(() => {
        copyBtn.innerHTML = '<i class="bi bi-clipboard-check text-success"></i>';
        setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1500);
      });
    });

    row.appendChild(keyInput);
    row.appendChild(toggleBtn);
    row.appendChild(copyBtn);
    wrap.appendChild(row);
    return wrap;
  },

  // ─────────────────────────────────────────────
  // Confirmation Modal (for warnings)
  // ─────────────────────────────────────────────

  _ensureConfirmModal() {
    if (document.getElementById('products-confirm-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'products-confirm-modal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.innerHTML = `
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header py-2 px-3" style="background:#f59e0b;color:white;">
            <h6 class="modal-title mb-0"><i class="bi bi-exclamation-triangle me-1"></i>Warning</h6>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body py-3 px-3" id="products-confirm-body" style="font-size:.85rem"></div>
          <div class="modal-footer py-2 px-3">
            <button class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal" id="products-confirm-cancel">Cancel</button>
            <button class="btn btn-sm btn-warning" id="products-confirm-ok">
              <i class="bi bi-check-circle me-1"></i>Proceed Anyway
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  _showConfirm(message) {
    return new Promise((resolve) => {
      const body = document.getElementById('products-confirm-body');
      body.innerHTML = message.replace(/\n/g, '<br>');

      const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('products-confirm-modal'));

      const okBtn = document.getElementById('products-confirm-ok');
      const cancelBtn = document.getElementById('products-confirm-cancel');

      // Remove old listeners
      const newOkBtn = okBtn.cloneNode(true);
      const newCancelBtn = cancelBtn.cloneNode(true);
      okBtn.replaceWith(newOkBtn);
      cancelBtn.replaceWith(newCancelBtn);

      // Add new listeners
      newOkBtn.addEventListener('click', () => {
        modal.hide();
        resolve(true);
      });

      newCancelBtn.addEventListener('click', () => {
        modal.hide();
        resolve(false);
      });

      // Handle backdrop click or ESC key
      document.getElementById('products-confirm-modal').addEventListener('hidden.bs.modal', () => {
        resolve(false);
      }, { once: true });

      modal.show();
    });
  },

  _showProductSelectionDialog(consumerName, products, hasApiAlready) {
    return new Promise((resolve) => {
      const body = document.getElementById('products-confirm-body');

      // Build products list
      const productsListHtml = products.map(p => `<li><code>${p.name || p.id}</code></li>`).join('');

      const message = `
        <div class="alert alert-warning py-2 px-3 mb-3" style="font-size:.8rem">
          <i class="bi bi-exclamation-triangle me-1"></i>
          <strong>Duplicate Products Found:</strong> The following products already exist for this consumer.
          <div class="mt-2">
            <div class="fw-semibold mb-1" style="font-size:.75rem">Existing Products:</div>
            <ul class="mb-0" style="font-size:.75rem; padding-left: 1.2rem;">
              ${productsListHtml}
            </ul>
          </div>
        </div>
        <div class="alert alert-info py-2 px-3 mb-0" style="font-size:.8rem">
          <i class="bi bi-info-circle me-1"></i>
          Creating a new product may result in duplicate subscriptions. Do you want to continue?
        </div>
      `;

      body.innerHTML = message;

      const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('products-confirm-modal'));

      const okBtn = document.getElementById('products-confirm-ok');
      const cancelBtn = document.getElementById('products-confirm-cancel');

      // Remove old listeners
      const newOkBtn = okBtn.cloneNode(true);
      const newCancelBtn = cancelBtn.cloneNode(true);
      okBtn.replaceWith(newOkBtn);
      cancelBtn.replaceWith(newCancelBtn);

      // Change OK button text
      newOkBtn.textContent = 'Create New Anyway';

      // Add new listeners
      newOkBtn.addEventListener('click', () => {
        // User chose to create new product anyway
        modal.hide();
        resolve(false); // Return false to continue with create
      });

      newCancelBtn.addEventListener('click', () => {
        modal.hide();
        resolve(null); // Return null to cancel
      });

      // Handle backdrop click or ESC key
      document.getElementById('products-confirm-modal').addEventListener('hidden.bs.modal', () => {
        resolve(null);
      }, { once: true });

      modal.show();
    });
  },

  // ─────────────────────────────────────────────
  // Create Product Modal
  // ─────────────────────────────────────────────

  _ensureCreateProductModal() {
    if (document.getElementById('products-create-product-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'products-create-product-modal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.innerHTML = `
      <div class="modal-dialog modal-sm">
        <div class="modal-content">
          <div class="modal-header py-2 px-3" style="background:var(--apim-gradient);color:white;">
            <h6 class="modal-title mb-0"><i class="bi bi-plus-circle me-1"></i>New Product</h6>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body py-3 px-3" id="products-create-product-body"></div>
          <div class="modal-footer py-2 px-3">
            <button class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button class="btn btn-sm btn-primary" id="products-create-product-submit">
              <i class="bi bi-send me-1"></i>Create
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  _showCreateProductModal() {
    // Reset selected API
    this._selectedApiId = null;
    this._selectedApiName = null;

    const body = document.getElementById('products-create-product-body');
    body.innerHTML = '';

    // Consumer App Name
    const nameGroup = this._formGroup('Consumer App Name *');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-control form-control-sm';
    nameInput.placeholder = 'Enter name';
    nameInput.autocomplete = 'off';
    nameGroup.appendChild(nameInput);
    body.appendChild(nameGroup);

    // Consumer App ID
    const idGroup = this._formGroup('Consumer App ID *');
    const idInput = document.createElement('input');
    idInput.type = 'text';
    idInput.className = 'form-control form-control-sm';
    idInput.placeholder = 'Enter ID';
    idInput.autocomplete = 'off';
    idGroup.appendChild(idInput);
    body.appendChild(idGroup);

    // Consumer Name
    const clientIdGroup = this._formGroup('Consumer Name *');
    const clientIdInput = document.createElement('input');
    clientIdInput.type = 'text';
    clientIdInput.className = 'form-control form-control-sm';
    clientIdInput.placeholder = 'Enter consumer name';
    clientIdInput.autocomplete = 'off';
    clientIdGroup.appendChild(clientIdInput);
    body.appendChild(clientIdGroup);

    // API search
    const apiGroup = this._formGroup('API');
    const searchContainer = document.createElement('div');
    const selectedApiDisplay = document.createElement('div');
    selectedApiDisplay.className = 'mt-1';
    selectedApiDisplay.style.fontSize = '.78rem';
    selectedApiDisplay.id = 'products-selected-api-display';

    const onApiSelect = (item) => {
      this._selectedApiId = item.id;
      this._selectedApiName = item.displayName;
      selectedApiDisplay.innerHTML = `<span class="badge bg-info text-dark">${item.displayName}</span>`;
    };

    const searchInput = SearchInput.create(searchContainer, {
      placeholder: 'Search API...',
      onSearch: async (q) => {
        return await API.searchApis(this.currentEnv, q);
      },
      onSelect: (item) => {
        onApiSelect(item);
        // Reset dropdown if user searched
        const select = apiGroup.querySelector('select');
        if (select) select.value = '';
      }
    });

    // --- API Dropdown (version-aware like diff.js) ---
    const dropWrapper = document.createElement('div');
    dropWrapper.className = 'position-relative mb-2';

    const dropBtn = document.createElement('button');
    dropBtn.type = 'button';
    dropBtn.className = 'form-select form-select-sm text-start';
    dropBtn.style.cssText = 'background:white;cursor:pointer;';
    dropBtn.textContent = 'Loading...';
    dropWrapper.appendChild(dropBtn);

    const dropList = document.createElement('div');
    dropList.style.cssText = 'display:none;position:fixed;max-height:250px;overflow-y:auto;background:white;border:1px solid #ced4da;border-radius:4px;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,.15);';
    dropWrapper.appendChild(dropList);

    const fillDropdown = (apis) => {
      dropList.innerHTML = '';
      if (!apis || !apis.length) {
        dropBtn.textContent = 'No APIs found';
        return;
      }

      dropBtn.textContent = 'Or select from list...';

      apis.forEach(api => {
        if (api.versions && api.versions.length > 0) {
          // API with multiple versions - create header + nested items
          const header = document.createElement('div');
          header.style.cssText = 'padding:4px 10px;font-size:.75rem;font-weight:600;background:#f0f4ff;color:#374151;border-bottom:1px solid #e5e7eb;';
          header.textContent = api.displayName;
          dropList.appendChild(header);

          api.versions.forEach(v => {
            const vitem = document.createElement('div');
            vitem.style.cssText = 'padding:5px 10px 5px 22px;cursor:pointer;font-size:.82rem;border-bottom:1px solid #f3f4f6;';
            vitem.textContent = v.versionName || 'Original';
            vitem.addEventListener('mouseenter', () => vitem.style.background = '#f0f9ff');
            vitem.addEventListener('mouseleave', () => vitem.style.background = '');
            vitem.addEventListener('click', () => {
              dropBtn.textContent = `${api.displayName} — ${v.versionName || 'Original'}`;
              dropList.style.display = 'none';
              onApiSelect({ id: v.id, displayName: api.displayName, versionName: v.versionName });
              searchInput.clear();
            });
            dropList.appendChild(vitem);
          });
        } else {
          // Simple API without versions
          const item = document.createElement('div');
          item.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:.82rem;border-bottom:1px solid #f3f4f6;';
          item.textContent = api.displayName;
          item.addEventListener('mouseenter', () => item.style.background = '#f0f9ff');
          item.addEventListener('mouseleave', () => item.style.background = '');
          item.addEventListener('click', () => {
            dropBtn.textContent = api.displayName;
            dropList.style.display = 'none';
            onApiSelect({ id: api.id, displayName: api.displayName });
            searchInput.clear();
          });
          dropList.appendChild(item);
        }
      });
    };

    dropBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dropList.style.display === 'none') {
        const rect = dropBtn.getBoundingClientRect();
        dropList.style.top = `${rect.bottom}px`;
        dropList.style.left = `${rect.left}px`;
        dropList.style.width = `${rect.width}px`;
        dropList.style.display = 'block';
      } else {
        dropList.style.display = 'none';
      }
    });
    document.addEventListener('click', () => { dropList.style.display = 'none'; }, { capture: true });

    // Load from cache and fetch fresh data
    const cachedApis = Cache.get('/api/apis', { env: this.currentEnv });
    if (cachedApis && cachedApis.length) fillDropdown(cachedApis);
    API.get('/api/apis', { env: this.currentEnv }).then(fresh => fillDropdown(fresh)).catch(() => {
      if (!cachedApis || !cachedApis.length) dropBtn.textContent = 'Or select from list...';
    });

    apiGroup.appendChild(dropWrapper);

    apiGroup.appendChild(searchContainer);
    apiGroup.appendChild(selectedApiDisplay);
    body.appendChild(apiGroup);

    
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('products-create-product-modal'));
    modal.show();

    // Wire submit
    const submitBtn = document.getElementById('products-create-product-submit');
    const newSubmit = submitBtn.cloneNode(true);
    submitBtn.replaceWith(newSubmit);
    newSubmit.addEventListener('click', async () => {
      const appName = nameInput.value.trim();
      const appId = idInput.value.trim();
      const clientId = clientIdInput.value.trim();
      if (!appName) { Toast.show('Consumer App Name is required', 'error'); return; }
      if (!appId) { Toast.show('Consumer App ID is required', 'error'); return; }
      if (!clientId) { Toast.show('Consumer Name is required', 'error'); return; }
      if (!this._selectedApiId) { Toast.show('Please select an API', 'error'); return; }

      newSubmit.disabled = true;
      newSubmit.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Checking...';

      try {
        // Check 1: Products that already have this API (true duplicates)
        const duplicateCheck = await API.get('/api/onboard/check-duplicate', {
          env: this.currentEnv,
          consumer_app_id: appId,
          consumer_app_name: appName,
          consumer_client_id: clientId,
          api_id: this._selectedApiId
        });

        // Check 2: All products belonging to this consumer
        const consumerProductsCheck = await API.get('/api/check-consumer-products', {
          env: this.currentEnv,
          consumer_app_id: appId,
          consumer_app_name: appName,
          consumer_client_id: clientId,
          api_id: this._selectedApiId
        });

        // Merge all products: products with API + products without API
        let allProducts = [];
        let hasApiAlready = false;

        if (duplicateCheck && duplicateCheck.exists && duplicateCheck.products) {
          allProducts = [...duplicateCheck.products];
          hasApiAlready = true;
        }

        if (consumerProductsCheck && consumerProductsCheck.exists && consumerProductsCheck.products) {
          const existingIds = new Set(allProducts.map(p => p.id));
          consumerProductsCheck.products.forEach(product => {
            if (!existingIds.has(product.id)) {
              allProducts.push(product);
            }
          });
        }

        // If products exist, show warning dialog
        if (allProducts.length > 0) {
          const continueCreate = await this._showProductSelectionDialog(
            appName,
            allProducts,
            hasApiAlready
          );

          if (continueCreate === null) {
            // User cancelled
            newSubmit.innerHTML = '<i class="bi bi-send me-1"></i>Create';
            newSubmit.disabled = false;
            return;
          }
          // User chose to create new anyway (continueCreate === false), continue below
        }

        newSubmit.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Creating...';

        const result = await API.post('/api/products/create', {
          env: this.currentEnv,
          consumer_app_id: appId,
          consumer_app_name: appName,
          consumer_name: clientId,
          api_id: this._selectedApiId,
        }, [{ prefix: '/api/products', params: { env: this.currentEnv } }]);

        newSubmit.innerHTML = '<i class="bi bi-send me-1"></i>Create';
        newSubmit.disabled = false;

        Toast.show('Product created successfully', 'success');
        modal.hide();
        this._loadProducts();

        // Show keys with product name
        if (result.primaryKey || result.secondaryKey) {
          const productName = result.product_id || `${appId}-${appName}`;
          this._showInlineKeys(`New Product Keys: ${productName}`, result.primaryKey, result.secondaryKey);
        }
      } catch (e) {
        newSubmit.innerHTML = '<i class="bi bi-send me-1"></i>Create';
        newSubmit.disabled = false;
        Toast.show(e.message || 'Create failed', 'error');
      }
    });
  },

  _showInlineKeys(title, primaryKey, secondaryKey) {
    // Re-use keys modal with static content
    const body = document.getElementById('products-keys-body');
    body.innerHTML = '';
    document.querySelector('#products-keys-modal .modal-title').innerHTML =
      `<i class="bi bi-key me-1"></i>${title}`;
    if (primaryKey) body.appendChild(this._buildKeyRow('Primary Key', primaryKey));
    if (secondaryKey) body.appendChild(this._buildKeyRow('Secondary Key', secondaryKey));
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('products-keys-modal'));
    modal.show();
  },

  // ─────────────────────────────────────────────
  // Create Subscription Modal
  // ─────────────────────────────────────────────

  _ensureCreateSubModal() {
    if (document.getElementById('products-create-sub-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'products-create-sub-modal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.innerHTML = `
      <div class="modal-dialog modal-sm">
        <div class="modal-content">
          <div class="modal-header py-2 px-3" style="background:var(--apim-gradient);color:white;">
            <h6 class="modal-title mb-0"><i class="bi bi-plus-circle me-1"></i>New Subscription</h6>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body py-3 px-3" id="products-create-sub-body"></div>
          <div class="modal-footer py-2 px-3">
            <button class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button class="btn btn-sm btn-primary" id="products-create-sub-submit">
              <i class="bi bi-send me-1"></i>Create
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  async _showCreateSubModal() {
    // Reload products to ensure fresh data with subscriptions
    await this._loadProducts();

    const body = document.getElementById('products-create-sub-body');
    body.innerHTML = '';

    // Product dropdown
    const productGroup = this._formGroup('Product *');
    const productSelect = document.createElement('select');
    productSelect.className = 'form-select form-select-sm';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '— select product —';
    productSelect.appendChild(defaultOpt);
    this.products.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.displayName;
      productSelect.appendChild(opt);
    });
    productGroup.appendChild(productSelect);
    body.appendChild(productGroup);

    // Display Name
    const nameGroup = this._formGroup('Display Name *');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-control form-control-sm';
    nameInput.placeholder = 'Enter subscription name';
    nameInput.autocomplete = 'off';
    nameGroup.appendChild(nameInput);
    body.appendChild(nameGroup);

    // API ID (optional)
    const apiIdGroup = this._formGroup('API ID (optional)');
    const apiIdInput = document.createElement('input');
    apiIdInput.type = 'text';
    apiIdInput.className = 'form-control form-control-sm';
    apiIdInput.placeholder = 'Leave blank for all APIs';
    apiIdInput.autocomplete = 'off';
    apiIdGroup.appendChild(apiIdInput);
    body.appendChild(apiIdGroup);

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('products-create-sub-modal'));
    modal.show();

    // Wire submit
    const submitBtn = document.getElementById('products-create-sub-submit');
    const newSubmit = submitBtn.cloneNode(true);
    submitBtn.replaceWith(newSubmit);
    newSubmit.addEventListener('click', async () => {
      const productId = productSelect.value;
      const displayName = nameInput.value.trim();
      const apiId = apiIdInput.value.trim();

      if (!productId) { Toast.show('Please select a product', 'error'); return; }
      if (!displayName) { Toast.show('Display Name is required', 'error'); return; }

      newSubmit.disabled = true;
      newSubmit.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Checking...';

      try {
        // Check if selected product already has subscriptions (just like products check)
        const duplicateCheck = await API.get('/api/subscriptions/check-duplicate', {
          env: this.currentEnv,
          product_id: productId
        });

        if (duplicateCheck && duplicateCheck.exists === true && duplicateCheck.subscriptions && duplicateCheck.subscriptions.length > 0) {
          const subsList = duplicateCheck.subscriptions.map(s => s.displayName).join(', ');
          const product = this.products.find(p => p.id === productId);
          const productDisplayName = product ? product.displayName : productId;

          const message =
            `<div class="mb-2"><strong>Product "${productDisplayName}"</strong> already has <strong>${duplicateCheck.subscriptions.length} subscription(s)</strong> mapped to it.</div>` +
            `<div class="mb-2">Existing subscriptions:</div>` +
            `<div class="alert alert-warning mb-2 py-2" style="font-size:.8rem"><strong>${subsList}</strong></div>` +
            `<div>Do you want to create another subscription?</div>`;

          const confirmCreate = await this._showConfirm(message);
          if (!confirmCreate) {
            newSubmit.innerHTML = '<i class="bi bi-send me-1"></i>Create';
            newSubmit.disabled = false;
            return;
          }
        }
      } catch (e) {
        console.error('Error checking subscription duplicates:', e);
        // Continue with creation even if check fails
      }

      newSubmit.disabled = true;
      newSubmit.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Creating...';

      try {
        const payload = { env: this.currentEnv, product_id: productId, display_name: displayName };
        if (apiId) payload.api_id = apiId;

        const result = await API.post('/api/subscriptions/create', payload,
          [{ prefix: '/api/products/' + productId, params: { env: this.currentEnv } }]
        );

        newSubmit.innerHTML = '<i class="bi bi-send me-1"></i>Create';
        newSubmit.disabled = false;

        Toast.show('Subscription created successfully', 'success');
        modal.hide();
        this._loadProducts();

        if (result.primaryKey || result.secondaryKey) {
          const subName = result.display_name || displayName;
          this._showInlineKeys(`New Subscription Keys: ${subName}`, result.primaryKey, result.secondaryKey);
        }
      } catch (e) {
        newSubmit.innerHTML = '<i class="bi bi-send me-1"></i>Create';
        newSubmit.disabled = false;
        Toast.show(e.message || 'Create failed', 'error');
      }
    });
  },

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  unload() { /* cleanup handled by render() recreating DOM */ },

  _formGroup(labelText) {
    const group = document.createElement('div');
    group.className = 'mb-2';
    const label = document.createElement('label');
    label.className = 'form-label mb-1';
    label.style.fontSize = '.8rem';
    label.textContent = labelText;
    group.appendChild(label);
    return group;
  },
};

Router.register('products', Products);
