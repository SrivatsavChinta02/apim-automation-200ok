const Onboard = {
  currentEnv: 'dev',
  selectedApi: null,
  selectedOps: [],

  async render(container) {
    this.currentEnv = 'dev';
    this.selectedApi = null;
    this.selectedOps = [];

    const wrap = document.createElement('div');
    wrap.className = 'p-2';

    // Page title
    const title = document.createElement('div');
    title.className = 'd-flex align-items-center mb-3';
    title.innerHTML = '<i class="bi bi-person-plus me-2 text-primary"></i><span class="fw-bold" style="font-size:.95rem">Manual Onboarding</span>';
    wrap.appendChild(title);

    // Form section
    this._formSection = document.createElement('div');
    wrap.appendChild(this._formSection);

    // Progress section (hidden initially)
    this._progressSection = document.createElement('div');
    this._progressSection.style.display = 'none';
    wrap.appendChild(this._progressSection);

    container.appendChild(wrap);
    this._buildForm();
    this._ensureModal();
  },

  _buildForm() {
    const f = this._formSection;
    f.innerHTML = '';
    this.selectedApi = null;
    this.selectedOps = [];

    // Card 1: Environment
    f.appendChild(this._buildEnvCard());
    // Card 2: API Selection
    f.appendChild(this._buildApiCard());
    // Card 3: Operations Selection (hidden until API selected)
    this._opsCard = this._buildOpsCard();
    this._opsCard.style.display = 'none';
    f.appendChild(this._opsCard);
    // Card 4: Consumer Details
    f.appendChild(this._buildConsumerCard());

    // Submit button
    const submitRow = document.createElement('div');
    submitRow.className = 'd-flex justify-content-end mt-3 mb-3';
    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn btn-sm btn-primary';
    submitBtn.innerHTML = '<i class="bi bi-send me-1"></i>Review & Onboard';
    submitBtn.addEventListener('click', () => this._onReview());
    submitRow.appendChild(submitBtn);
    f.appendChild(submitRow);
  },

  _card(icon, titleText) {
    const card = document.createElement('div');
    card.className = 'card mb-3';
    const header = document.createElement('div');
    header.className = 'card-gradient-header';
    header.innerHTML = `<i class="bi ${icon} me-1"></i>${titleText}`;
    const body = document.createElement('div');
    body.className = 'card-body';
    card.appendChild(header);
    card.appendChild(body);
    return { card, body };
  },

  _buildEnvCard() {
    const { card, body } = this._card('bi-cloud', 'Environment');
    EnvTabs.render(body, this.currentEnv, env => {
      this.currentEnv = env;
      // Reset API selection when env changes
      this.selectedApi = null;
      this._opsCard.style.display = 'none';
      if (this._apiSelectedCard) this._apiSelectedCard.style.display = 'none';
      // Reload dropdown for new environment
      if (this._apiDropBtn) {
        this._apiDropBtn.textContent = 'Select an API...';
        this._loadApis();
      }
    });
    return card;
  },

  _buildApiCard() {
    const { card, body } = this._card('bi-search', 'API Selection');

    // Version-aware dropdown (like diff.js)
    const dropWrapper = document.createElement('div');
    dropWrapper.className = 'position-relative mb-2';

    const dropBtn = document.createElement('button');
    dropBtn.type = 'button';
    dropBtn.className = 'form-select form-select-sm text-start';
    dropBtn.style.cssText = 'background:white;cursor:pointer;';
    dropBtn.textContent = 'Loading...';
    dropWrapper.appendChild(dropBtn);

    const dropList = document.createElement('div');
    dropList.style.cssText = 'display:none;position:absolute;top:100%;left:0;right:0;max-height:300px;overflow-y:auto;background:white;border:1px solid #ced4da;border-radius:4px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.15);';
    dropWrapper.appendChild(dropList);

    this._apiDropBtn = dropBtn;
    this._apiDropList = dropList;

    dropBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropList.style.display = dropList.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { dropList.style.display = 'none'; }, { capture: true });

    body.appendChild(dropWrapper);

    // Selected API display (hidden initially)
    this._apiSelectedCard = document.createElement('div');
    this._apiSelectedCard.style.display = 'none';
    this._apiSelectedCard.className = 'mt-2 p-2 border rounded';
    this._apiSelectedCard.style.background = '#f9fafb';
    body.appendChild(this._apiSelectedCard);

    // Load APIs for current environment
    this._loadApis();

    return card;
  },

  async _loadApis() {
    if (!this._apiDropBtn || !this._apiDropList) return;

    const dropBtn = this._apiDropBtn;
    const dropList = this._apiDropList;

    dropBtn.textContent = 'Loading...';
    dropBtn.disabled = true;

    try {
      const apis = await API.get('/api/apis', { env: this.currentEnv });

      if (!apis || apis.length === 0) {
        dropBtn.textContent = 'No APIs found';
        dropBtn.disabled = false;
        return;
      }

      // Populate dropdown with version support (like diff.js)
      dropList.innerHTML = '';
      dropBtn.textContent = 'Select an API...';
      dropBtn.disabled = false;

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
              // Call _onApiSelected with the specific version ID
              this._onApiSelected({ id: v.id, displayName: api.displayName, versionName: v.versionName });
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
            this._onApiSelected({ id: api.id, displayName: api.displayName });
          });
          dropList.appendChild(item);
        }
      });
    } catch (err) {
      dropBtn.textContent = 'Failed to load APIs';
      dropBtn.disabled = false;
      Toast.show('Failed to load APIs: ' + err.message, 'error');
    }
  },

  async _onApiSelected(item) {
    try {
      // Show operations card immediately with loading state
      this._opsCard.style.display = '';
      const opsBody = this._opsListContainer;
      opsBody.innerHTML = '<div class="text-center py-3"><div class="spinner-border spinner-border-sm me-2"></div><span class="text-muted">Loading operations...</span></div>';

      // Fetch API details with timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout - backend may be slow or unreachable')), 30000)
      );

      const api = await Promise.race([
        API.get(`/api/apis/${item.id}`, { env: this.currentEnv }),
        timeoutPromise
      ]);

      this.selectedApi = api;

      // Show selected API card
      this._apiSelectedCard.style.display = '';
      this._apiSelectedCard.innerHTML = `
        <div class="d-flex align-items-center justify-content-between">
          <div>
            <div class="fw-semibold" style="font-size:.85rem">${api.displayName}</div>
            <div class="text-muted" style="font-size:.75rem">
              <code>${api.path}</code> &middot; Rev ${api.revision} &middot; ${api.operations.length} operations
            </div>
          </div>
          <button class="btn btn-sm btn-outline-danger py-0" id="onboard-clear-api">
            <i class="bi bi-x"></i>
          </button>
        </div>`;

      this._apiSelectedCard.querySelector('#onboard-clear-api').addEventListener('click', () => {
        this.selectedApi = null;
        this._apiSelectedCard.style.display = 'none';
        this._opsCard.style.display = 'none';
        this._apiSelect.value = '';
      });

      // Populate operations
      this._populateOps(api.operations);
    } catch (e) {
      // Show error in operations card instead of hiding it
      const opsBody = this._opsListContainer;
      opsBody.innerHTML = `
        <div class="alert alert-danger mb-0" style="font-size:.85rem">
          <strong>Failed to load operations:</strong><br>
          ${e.message}<br><br>
          <small>Backend URL: ${API.baseUrl}<br>
          Check console (F12) for details</small>
        </div>`;
      Toast.show('Failed to load API details: ' + e.message, 'error');
      console.error('API load error:', e);
    }
  },

  _buildOpsCard() {
    const { card, body } = this._card('bi-list-check', 'Operations Selection');

    // Toggle row
    const toggleRow = document.createElement('div');
    toggleRow.className = 'd-flex gap-2 mb-2';
    const selectAllBtn = document.createElement('button');
    selectAllBtn.className = 'btn btn-sm btn-outline-primary py-0';
    selectAllBtn.style.fontSize = '.75rem';
    selectAllBtn.textContent = 'Select All';
    selectAllBtn.addEventListener('click', () => this._toggleAllOps(true));
    const deselectAllBtn = document.createElement('button');
    deselectAllBtn.className = 'btn btn-sm btn-outline-secondary py-0';
    deselectAllBtn.style.fontSize = '.75rem';
    deselectAllBtn.textContent = 'Deselect All';
    deselectAllBtn.addEventListener('click', () => this._toggleAllOps(false));
    toggleRow.appendChild(selectAllBtn);
    toggleRow.appendChild(deselectAllBtn);
    body.appendChild(toggleRow);

    this._opsListContainer = document.createElement('div');
    body.appendChild(this._opsListContainer);

    return card;
  },

  _verbBadgeClass(method) {
    const map = {
      GET: 'bg-success',
      POST: 'bg-primary',
      PUT: 'bg-warning text-dark',
      DELETE: 'bg-danger',
      PATCH: 'bg-purple',
    };
    return map[method.toUpperCase()] || 'bg-secondary';
  },

  _populateOps(operations) {
    const list = this._opsListContainer;
    list.innerHTML = '';
    this._opCheckboxes = [];

    if (!operations || !operations.length) {
      list.innerHTML = '<p class="text-muted mb-0" style="font-size:.8rem">No operations with policies found.</p>';
      return;
    }

    operations.forEach(op => {
      const row = document.createElement('div');
      row.className = 'form-check py-1 d-flex align-items-center gap-2';
      row.style.fontSize = '.82rem';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'form-check-input mt-0';
      cb.checked = true;
      cb.value = op.id;
      cb.id = `op-cb-${op.id}`;

      const label = document.createElement('label');
      label.className = 'form-check-label d-flex align-items-center gap-1 flex-grow-1';
      label.htmlFor = `op-cb-${op.id}`;

      // Purple badge needs custom style since Bootstrap 5 has no bg-purple
      const badgeCls = this._verbBadgeClass(op.method);
      const badgeStyle = op.method.toUpperCase() === 'PATCH' ? 'background:#6f42c1;color:white;' : '';

      label.innerHTML = `
        <span class="badge ${badgeCls}" style="font-size:.7rem;min-width:48px;${badgeStyle}">${op.method}</span>
        <code style="font-size:.75rem">${op.urlTemplate}</code>
        <span class="text-muted">&mdash; ${op.displayName}</span>`;

      row.appendChild(cb);
      row.appendChild(label);
      list.appendChild(row);
      this._opCheckboxes.push(cb);
    });
  },

  _toggleAllOps(checked) {
    if (!this._opCheckboxes) return;
    this._opCheckboxes.forEach(cb => { cb.checked = checked; });
  },

  _getSelectedOps() {
    if (!this._opCheckboxes) return [];
    return this._opCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
  },

  _buildConsumerCard() {
    const { card, body } = this._card('bi-person-badge', 'Consumer Details');

    const fields = [
      { label: 'Consumer App Name *', id: '_consumerAppName', placeholder: 'Enter app name' },
      { label: 'Consumer App ID *', id: '_consumerAppId', placeholder: 'Enter app ID' },
      { label: 'Consumer Name *', id: '_consumerName', placeholder: 'e.g. OCI, securitymgmt', validate: 'consumer_name',
        help: 'Sent by the caller in the consumer-name request header. Compared case-insensitively against the per-op allowlist.' },
    ];

    fields.forEach(f => {
      const group = document.createElement('div');
      group.className = 'mb-2';
      const label = document.createElement('label');
      label.className = 'form-label mb-1';
      label.style.fontSize = '.8rem';
      label.textContent = f.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'form-control form-control-sm';
      input.placeholder = f.placeholder;
      input.autocomplete = 'off';
      this[f.id] = input;
      group.appendChild(label);
      group.appendChild(input);

      if (f.help) {
        const helpDiv = document.createElement('div');
        helpDiv.className = 'form-text';
        helpDiv.style.fontSize = '.7rem';
        helpDiv.textContent = f.help;
        group.appendChild(helpDiv);
      }

      // Lightweight format check for consumer-name: short identifier, no spaces
      if (f.validate === 'consumer_name') {
        const validationMsg = document.createElement('div');
        validationMsg.className = 'invalid-feedback d-block';
        validationMsg.style.fontSize = '.75rem';
        validationMsg.style.display = 'none';
        group.appendChild(validationMsg);
        this._consumerNameValidation = validationMsg;

        input.addEventListener('input', () => {
          const value = input.value.trim();
          if (!value) {
            input.classList.remove('is-invalid', 'is-valid');
            validationMsg.style.display = 'none';
            return;
          }
          // Allow alphanumeric + hyphen + underscore, no spaces
          const ok = /^[A-Za-z0-9_-]{2,64}$/.test(value);
          if (ok) {
            input.classList.remove('is-invalid');
            input.classList.add('is-valid');
            validationMsg.style.display = 'none';
          } else {
            input.classList.remove('is-valid');
            input.classList.add('is-invalid');
            validationMsg.textContent = 'Consumer name: 2-64 chars, letters/digits/hyphens/underscores only (no spaces).';
            validationMsg.style.display = 'block';
          }
        });
      }

      body.appendChild(group);
    });

    return card;
  },

  _collectPayload() {
    return {
      env: this.currentEnv,
      api_id: this.selectedApi ? this.selectedApi.id : '',
      consumer_app_name: this._consumerAppName.value.trim(),
      consumer_app_id: this._consumerAppId.value.trim(),
      consumer_name: this._consumerName.value.trim(),
      selected_operations: this._getSelectedOps(),
    };
  },

  _validate(payload) {
    if (!payload.api_id) return 'Please select an API.';
    if (!payload.selected_operations.length) return 'Select at least one operation.';
    if (!payload.consumer_app_name) return 'Consumer App Name is required.';
    if (!payload.consumer_app_id) return 'Consumer App ID is required.';
    if (!payload.consumer_name) return 'Consumer Name is required.';

    if (!/^[A-Za-z0-9_-]{2,64}$/.test(payload.consumer_name)) {
      return 'Consumer Name must be 2-64 chars, letters/digits/hyphens/underscores only (no spaces).';
    }

    return null;
  },

  _ensureModal() {
    if (document.getElementById('onboard-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'onboard-modal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.innerHTML = `
      <div class="modal-dialog modal-lg">
        <div class="modal-content">
          <div class="modal-header py-2 px-3" style="background:var(--apim-gradient);color:white;">
            <h6 class="modal-title mb-0"><i class="bi bi-person-plus me-1"></i>Confirm Onboarding</h6>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body py-2 px-3" id="onboard-modal-body" style="font-size:.82rem"></div>
          <div class="modal-footer py-2 px-3">
            <button class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button class="btn btn-sm btn-primary" id="onboard-confirm-btn">
              <i class="bi bi-person-plus me-1"></i>Onboard
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  async _onReview() {
    const payload = this._collectPayload();
    const err = this._validate(payload);
    if (err) { Toast.show(err, 'error'); return; }

    const body = document.getElementById('onboard-modal-body');

    // Show loading state while checking for duplicates
    body.innerHTML = `
      <div class="text-center py-3">
        <div class="spinner-border spinner-border-sm text-primary me-2" role="status"></div>
        <span class="text-muted" style="font-size:.85rem">Checking for duplicates...</span>
      </div>`;

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('onboard-modal'));
    modal.show();

    // Check for duplicate consumer and existing consumer products
    let duplicateSection = '';
    let duplicateCheck = null;
    let allProducts = [];
    let hasApiAlready = false;

    try {
      // First check: products that already have this API
      duplicateCheck = await API.get('/api/onboard/check-duplicate', {
        env: payload.env,
        consumer_app_id: payload.consumer_app_id,
        consumer_app_name: payload.consumer_app_name,
        consumer_name: payload.consumer_name,
        api_id: payload.api_id
      });

      console.log('[Onboard] Duplicate check response:', duplicateCheck);

      if (duplicateCheck.exists) {
        hasApiAlready = true;
        allProducts = duplicateCheck.products || [{ id: duplicateCheck.product_id, name: duplicateCheck.product_name }];
      }

      // Second check: all products belonging to this consumer (may include products without this API)
      const consumerProducts = await API.get('/api/check-consumer-products', {
        env: payload.env,
        consumer_app_id: payload.consumer_app_id,
        consumer_app_name: payload.consumer_app_name,
        consumer_name: payload.consumer_name,
        api_id: payload.api_id
      });

      console.log('[Onboard] Consumer products response:', consumerProducts);

      if (consumerProducts.exists && consumerProducts.products) {
        // Merge products, avoiding duplicates
        const existingIds = new Set(allProducts.map(p => p.id));
        consumerProducts.products.forEach(product => {
          if (!existingIds.has(product.id)) {
            allProducts.push(product);
          }
        });
      }

      if (allProducts.length > 0) {
        const existingProducts = allProducts;

        // Build existing products list
        let productsListHtml = '';
        if (existingProducts.length > 0) {
          productsListHtml = `
            <div class="mt-2">
              <div class="fw-semibold mb-1" style="font-size:.75rem">Existing Products:</div>
              <ul class="mb-0" style="font-size:.75rem; padding-left: 1.2rem;">
                ${existingProducts.map(p => `<li><code>${p.name || p.id}</code></li>`).join('')}
              </ul>
            </div>`;
        }

        // Build product selector dropdown (if multiple products exist)
        let productSelectorHtml = '';
        if (existingProducts.length > 1) {
          productSelectorHtml = `
            <div class="mb-2 ms-4" id="onboard-existingProductSelector" style="display:none;">
              <label class="form-label mb-1" style="font-size:.75rem">Select Product:</label>
              <select class="form-select form-select-sm" id="onboard-existingProductDropdown">
                ${existingProducts.map(p => `<option value="${p.id}">${p.name || p.id}</option>`).join('')}
              </select>
            </div>`;
        }

        duplicateSection = `
          <div class="alert ${hasApiAlready ? 'alert-warning' : 'alert-info'} py-2 px-3 mb-3" style="font-size:.8rem">
            <i class="bi ${hasApiAlready ? 'bi-exclamation-triangle' : 'bi-info-circle'} me-1"></i>
            <strong>${hasApiAlready ? 'Duplicate Detected:' : 'Existing Products Found:'}</strong> ${hasApiAlready ? 'Consumer already has access to this API.' : 'Consumer has existing products.'}
            ${productsListHtml}
          </div>
          <div class="border rounded p-3 mb-3" style="background:#f8f9fa">
            <div class="fw-semibold mb-2" style="font-size:.85rem">
              <i class="bi bi-diagram-3 me-1 text-primary"></i>Choose Action
            </div>
            <div class="form-check mb-2">
              <input class="form-check-input" type="radio" name="onboardStrategy" id="onboard-addToExisting" value="addToExisting" checked>
              <label class="form-check-label" for="onboard-addToExisting" style="font-size:.85rem">
                <i class="bi bi-plus-circle text-success me-1"></i>
                <strong>Add to existing product</strong> <span class="badge bg-success" style="font-size:.65rem">Recommended</span>
                <br><small class="text-muted ms-3">Add selected operations to existing product</small>
              </label>
            </div>
            ${productSelectorHtml}
            <div class="form-check">
              <input class="form-check-input" type="radio" name="onboardStrategy" id="onboard-createNew" value="createNew">
              <label class="form-check-label" for="onboard-createNew" style="font-size:.85rem">
                <i class="bi bi-exclamation-triangle text-warning me-1"></i>
                <strong>Create new product</strong>
                <br><small class="text-muted ms-3">Create a separate product (may result in duplicate access)</small>
              </label>
            </div>
          </div>`;
      }
    } catch (e) {
      console.warn('Failed to check for duplicates:', e);
      // Continue even if duplicate check fails
    }

    // Build confirmation text based on whether duplicates exist
    let confirmationText = '';
    if (duplicateCheck && duplicateCheck.exists) {
      const existingProducts = duplicateCheck.products || [{ id: duplicateCheck.product_id, name: duplicateCheck.product_name }];
      const productName = existingProducts[0]?.name || existingProducts[0]?.id || 'existing product';

      confirmationText = `
        <p class="mb-2" id="confirmationText">
          Add consumer <strong>${payload.consumer_app_name}</strong> to existing product
          <strong id="selectedProductName">${productName}</strong> on
          <span class="badge bg-primary">${payload.env}</span>?
        </p>`;
    } else {
      confirmationText = `
        <p class="mb-2" id="confirmationText">
          Create new product for consumer <strong>${payload.consumer_app_name}</strong> and API
          <strong>${this.selectedApi.displayName}</strong> on
          <span class="badge bg-primary">${payload.env}</span>?
        </p>`;
    }

    // Show full modal content
    body.innerHTML = `
      ${duplicateSection}
      ${confirmationText}
      <table class="table table-sm mb-0 table-borderless">
        <tr><td class="text-muted fw-semibold" style="white-space:nowrap">Consumer App ID</td><td>${payload.consumer_app_id}</td></tr>
        <tr><td class="text-muted fw-semibold">Consumer Name</td><td><code style="font-size:.75rem">${payload.consumer_name}</code></td></tr>
        <tr><td class="text-muted fw-semibold">Operations</td><td>${payload.selected_operations.length} selected</td></tr>
      </table>`;

    const confirmBtn = document.getElementById('onboard-confirm-btn');
    confirmBtn.replaceWith(confirmBtn.cloneNode(true));

    // Set up radio button handlers to show/hide product selector and update confirmation text
    const addToExistingRadio = document.getElementById('onboard-addToExisting');
    const createNewRadio = document.getElementById('onboard-createNew');
    const productSelector = document.getElementById('onboard-existingProductSelector');
    const productDropdown = document.getElementById('onboard-existingProductDropdown');
    const confirmationTextElem = document.getElementById('confirmationText');
    const selectedProductNameElem = document.getElementById('selectedProductName');

    const updateConfirmationText = () => {
      if (!confirmationTextElem) return;

      if (addToExistingRadio && addToExistingRadio.checked) {
        // Adding to existing product
        let productName = '';
        if (productDropdown) {
          const selectedOption = productDropdown.options[productDropdown.selectedIndex];
          productName = selectedOption.textContent;
        } else if (duplicateCheck && duplicateCheck.exists) {
          const existingProducts = duplicateCheck.products || [{ id: duplicateCheck.product_id, name: duplicateCheck.product_name }];
          productName = existingProducts[0]?.name || existingProducts[0]?.id || 'existing product';
        }

        confirmationTextElem.innerHTML = `
          Add consumer <strong>${payload.consumer_app_name}</strong> to existing product
          <strong id="selectedProductName">${productName}</strong> on
          <span class="badge bg-primary">${payload.env}</span>?`;
      } else {
        // Creating new product
        confirmationTextElem.innerHTML = `
          Create new product for consumer <strong>${payload.consumer_app_name}</strong> and API
          <strong>${this.selectedApi.displayName}</strong> on
          <span class="badge bg-primary">${payload.env}</span>?`;
      }
    };

    if (addToExistingRadio && createNewRadio) {
      addToExistingRadio.addEventListener('change', () => {
        if (addToExistingRadio.checked) {
          if (productSelector) productSelector.style.display = 'block';
          updateConfirmationText();
        }
      });

      createNewRadio.addEventListener('change', () => {
        if (createNewRadio.checked) {
          if (productSelector) productSelector.style.display = 'none';
          updateConfirmationText();
        }
      });

      // Update text when product dropdown changes
      if (productDropdown) {
        productDropdown.addEventListener('change', updateConfirmationText);
      }

      // Show selector initially if "add to existing" is checked
      if (productSelector && addToExistingRadio.checked) {
        productSelector.style.display = 'block';
      }
    }

    document.getElementById('onboard-confirm-btn').addEventListener('click', () => {
      // Check if duplicate exists and get the selected strategy
      if (duplicateCheck && duplicateCheck.exists) {
        const addToExistingRadio = document.getElementById('onboard-addToExisting');
        if (addToExistingRadio && addToExistingRadio.checked) {
          payload.onboard_strategy = 'add_to_existing';

          // Get selected product ID from dropdown if it exists, otherwise use first product
          const productDropdown = document.getElementById('onboard-existingProductDropdown');
          if (productDropdown) {
            payload.existing_product_id = productDropdown.value;
          } else {
            const existingProducts = duplicateCheck.products || [{ id: duplicateCheck.product_id }];
            payload.existing_product_id = existingProducts[0].id;
          }
        } else {
          payload.onboard_strategy = 'create_new';
        }
      } else {
        payload.onboard_strategy = 'create_new';
      }

      modal.hide();
      this._submit(payload);
    }, { once: true });
  },

  _submit(payload) {
    this._formSection.style.display = 'none';
    const ps = this._progressSection;
    ps.style.display = '';
    ps.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'd-flex align-items-center mb-3';
    heading.innerHTML = '<i class="bi bi-gear-wide-connected me-2 text-primary"></i><span class="fw-bold" style="font-size:.9rem">Onboarding consumer...</span>';
    ps.appendChild(heading);

    const pbContainer = document.createElement('div');
    ps.appendChild(pbContainer);
    const totalSteps = 5;
    const pb = ProgressBar.create(pbContainer, totalSteps);

    API.postSSE('/api/onboard', payload, {
      onStep(event) {
        if (!event.message) return; // Skip metadata events
        pb.update(event.step, event.message, event.status || 'running');
      },
      onDone: (event) => {
        pb.complete('All steps completed');
        this._showSuccess(ps, payload, event);
      },
      onError: (msg) => {
        pb.error(msg || 'An error occurred.');
        Toast.show(msg || 'Onboarding failed', 'error');
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn btn-sm btn-outline-secondary mt-3';
        retryBtn.innerHTML = '<i class="bi bi-arrow-left me-1"></i>Back to Form';
        retryBtn.addEventListener('click', () => {
          ps.style.display = 'none';
          this._formSection.style.display = '';
        });
        ps.appendChild(retryBtn);
      },
      invalidate: [{ prefix: '/api/products', params: { env: payload.env } }],
    });
  },

  _showSuccess(ps, payload, event) {
    const successCard = document.createElement('div');
    successCard.className = 'card mt-3';

    const header = document.createElement('div');
    header.className = 'card-gradient-header';
    header.innerHTML = '<i class="bi bi-check-circle me-1"></i>Consumer Onboarded Successfully';
    successCard.appendChild(header);

    const body = document.createElement('div');
    body.className = 'card-body';

    const summaryTable = document.createElement('table');
    summaryTable.className = 'table table-sm table-borderless mb-0';
    summaryTable.innerHTML = `
      <tr><td class="text-muted" style="white-space:nowrap">Consumer</td><td class="fw-semibold">${payload.consumer_app_name}</td></tr>
      <tr><td class="text-muted">API</td><td>${this.selectedApi ? this.selectedApi.displayName : payload.api_id}</td></tr>
      <tr><td class="text-muted">Environment</td><td><span class="badge bg-primary">${payload.env}</span></td></tr>
      <tr><td class="text-muted">Operations</td><td>${payload.selected_operations.length}</td></tr>`;
    body.appendChild(summaryTable);

    // Subscription keys
    const summary = event.summary || event;
    const keys = summary.keys || {};
    if (keys.primaryKey || keys.secondaryKey) {
      const keySection = document.createElement('div');
      keySection.className = 'mt-2 p-2 border rounded';
      keySection.style.background = '#f9fafb';

      const productName = summary.product_name || payload.consumer_app_name;
      const subName = summary.subscription_name || 'Subscription';
      const keyTitle = document.createElement('div');
      keyTitle.className = 'fw-semibold mb-2';
      keyTitle.style.fontSize = '.8rem';
      keyTitle.innerHTML = `<i class="bi bi-key me-1 text-warning"></i>Subscription Keys: ${productName} / ${subName}`;
      keySection.appendChild(keyTitle);

      const keyEntries = [
        { label: 'Primary', value: keys.primaryKey || '' },
        { label: 'Secondary', value: keys.secondaryKey || '' },
      ].filter(k => k.value);

      keyEntries.forEach(k => {
        const keyRow = document.createElement('div');
        keyRow.className = 'd-flex align-items-center gap-1 mb-1';
        const lbl = document.createElement('span');
        lbl.className = 'text-muted';
        lbl.style.fontSize = '.75rem';
        lbl.style.minWidth = '60px';
        lbl.textContent = k.label;

        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.className = 'form-control form-control-sm flex-grow-1';
        keyInput.style.fontSize = '.75rem';
        keyInput.value = k.value;
        keyInput.readOnly = true;
        keyInput.autocomplete = 'off';

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'btn btn-sm btn-outline-secondary py-0';
        toggleBtn.style.fontSize = '.7rem';
        toggleBtn.innerHTML = '<i class="bi bi-eye"></i>';
        toggleBtn.addEventListener('click', () => {
          const showing = keyInput.type === 'text';
          keyInput.type = showing ? 'password' : 'text';
          toggleBtn.innerHTML = showing ? '<i class="bi bi-eye"></i>' : '<i class="bi bi-eye-slash"></i>';
        });

        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn-sm btn-outline-primary py-0';
        copyBtn.style.fontSize = '.7rem';
        copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(k.value).then(() => {
            copyBtn.innerHTML = '<i class="bi bi-clipboard-check text-success"></i>';
            setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1500);
          });
        });

        keyRow.appendChild(lbl);
        keyRow.appendChild(keyInput);
        keyRow.appendChild(toggleBtn);
        keyRow.appendChild(copyBtn);
        keySection.appendChild(keyRow);
      });

      body.appendChild(keySection);
    }

    successCard.appendChild(body);
    ps.appendChild(successCard);

    // "Onboard Another" button
    const anotherBtn = document.createElement('button');
    anotherBtn.className = 'btn btn-sm btn-outline-primary mt-3 w-100';
    anotherBtn.innerHTML = '<i class="bi bi-plus me-1"></i>Onboard Another';
    anotherBtn.addEventListener('click', () => {
      ps.style.display = 'none';
      this._buildForm();
      this._formSection.style.display = '';
    });
    ps.appendChild(anotherBtn);

    Toast.show(`Consumer "${payload.consumer_app_name}" onboarded successfully`, 'success');
  }
};

Router.register('onboard', Onboard);
