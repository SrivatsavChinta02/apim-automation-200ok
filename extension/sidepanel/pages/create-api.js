// @ts-nocheck
console.log('[CreateAPI] Loaded v1.0.1 - No default values');

const CreateAPI = {
  currentEnv: 'dev',
  urlRows: [],
  hasConsumer: false,

  // Form field references (initialized in _buildForm and related methods)
  _formSection: null,
  _progressSection: null,
  _policyCard: null,
  _consumerCard: null,

  // Mode selection
  _modeNewRadio: null,
  _modeAddRadio: null,

  // API identity fields
  _apiNameInput: null,
  _existingApiSection: null,
  _existingApiSelect: null,
  _newApiSection: null,
  _revisionInfo: null,

  // Backend configuration
  _backendConfigInfo: null,
  _backendChoiceContainer: null,
  _lastBackendCount: 0,
  _lastBackends: '',
  _enableLBCheckbox: null,
  _lbSection: null,
  _lbAlgorithmSection: null,
  _lbAlgorithmSelect: null,
  _lbBackendsSection: null,
  _lbBackendsContainer: null,
  _backendConfigs: null,

  // Circuit Breaker fields
  _enableCBCheckbox: null,
  _cbSettingsSection: null,
  _cbFailureCount: null,
  _cbIntervalSec: null,
  _cbTripDuration: null,

  // Policy fields
  _jwtInput: null,
  _rateLimitCalls: null,
  _quotaCalls: null,

  // Cert auth fields
  _certAuthToggle: null,
  _certAuthFields: null,
  _clientCertFile: null,
  _clientCertPassword: null,
  _caToggle: null,
  _caFields: null,
  _caCertFile: null,
  _caCertPassword: null,
  _caCertStore: null,

  // Consumer fields
  _consumerCheckbox: null,
  _consumerFields: null,
  _consumerAppName: null,
  _consumerAppId: null,
  _consumerClientId: null,
  _consumerStrategySection: null,
  _consumerCreateNewRadio: null,
  _consumerAddExistingRadio: null,
  _consumerProductSection: null,
  _consumerProductSelect: null,

  async render(container) {
    this.currentEnv = 'dev';
    this.urlRows = [];
    this.hasConsumer = false;

    // Main wrapper
    const wrap = document.createElement('div');
    wrap.className = 'p-2';

    // Page title
    const title = document.createElement('div');
    title.className = 'd-flex align-items-center mb-3';
    title.innerHTML = '<i class="bi bi-plus-circle me-2 text-primary"></i><span class="fw-bold" style="font-size:.95rem">Create API</span>';
    wrap.appendChild(title);

    // Build form section
    this._formSection = document.createElement('div');
    wrap.appendChild(this._formSection);

    // Progress section (hidden initially)
    this._progressSection = document.createElement('div');
    this._progressSection.style.display = 'none';
    wrap.appendChild(this._progressSection);

    container.appendChild(wrap);
    this._buildForm();
    this._ensureModal();
    this._ensureErrorModal();
  },

  _buildForm() {
    const f = this._formSection;
    f.innerHTML = '';

    // Card 1: API Identity
    f.appendChild(this._buildIdentityCard());
    // Card 2: Backend URLs
    f.appendChild(this._buildUrlsCard());
    // Card 2.5: Backend Configuration (Load Balancer)
    f.appendChild(this._buildBackendConfigCard());
    // Card 3: Operations Preview
    f.appendChild(this._buildOpsCard());
    // Card 4: Policy Configuration
    const policyCard = this._buildPolicyCard();
    this._policyCard = policyCard;
    f.appendChild(policyCard);
    // Card 4.5: Backend Cert Auth (mTLS)
    f.appendChild(this._buildCertAuthCard());
    // Card 5: Consumer
    const consumerCard = this._buildConsumerCard();
    this._consumerCard = consumerCard;
    f.appendChild(consumerCard);

    // Submit button
    const submitRow = document.createElement('div');
    submitRow.className = 'd-flex justify-content-end mt-3 mb-3';
    this._submitBtn = document.createElement('button');
    this._submitBtn.className = 'btn btn-sm btn-primary';
    this._submitBtn.innerHTML = '<i class="bi bi-send me-1"></i>Review & Create';
    this._submitBtn.addEventListener('click', () => {
      try {
        this._onReview();
      } catch (e) {
        console.error('Error in _onReview:', e);
      }
    });
    submitRow.appendChild(this._submitBtn);
    f.appendChild(submitRow);

    // No default URL row - user can add URLs as needed
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

  _buildIdentityCard() {
    const { card, body } = this._card('bi-tag', 'API Type');

    // API Mode Selection (New vs Add to Existing)
    const modeLabel = document.createElement('div');
    modeLabel.className = 'form-label mb-2 fw-semibold';
    modeLabel.style.fontSize = '.85rem';
    modeLabel.textContent = 'What would you like to do?';
    body.appendChild(modeLabel);

    // Radio buttons for mode selection
    const modeGroup = document.createElement('div');
    modeGroup.className = 'mb-3';

    const newApiRadio = document.createElement('div');
    newApiRadio.className = 'form-check mb-2';
    this._modeNewRadio = document.createElement('input');
    this._modeNewRadio.className = 'form-check-input';
    this._modeNewRadio.type = 'radio';
    this._modeNewRadio.name = 'apiMode';
    this._modeNewRadio.id = 'modeNew';
    this._modeNewRadio.value = 'new';
    this._modeNewRadio.checked = true;
    const newApiLabel = document.createElement('label');
    newApiLabel.className = 'form-check-label';
    newApiLabel.htmlFor = 'modeNew';
    newApiLabel.style.fontSize = '.85rem';
    newApiLabel.innerHTML = '<strong>Create New API</strong> <small class="text-muted">— Fresh API with new backends and policies</small>';
    newApiRadio.appendChild(this._modeNewRadio);
    newApiRadio.appendChild(newApiLabel);

    const addApiRadio = document.createElement('div');
    addApiRadio.className = 'form-check';
    this._modeAddRadio = document.createElement('input');
    this._modeAddRadio.className = 'form-check-input';
    this._modeAddRadio.type = 'radio';
    this._modeAddRadio.name = 'apiMode';
    this._modeAddRadio.id = 'modeAdd';
    this._modeAddRadio.value = 'add';
    const addApiLabel = document.createElement('label');
    addApiLabel.className = 'form-check-label';
    addApiLabel.htmlFor = 'modeAdd';
    addApiLabel.style.fontSize = '.85rem';
    addApiLabel.innerHTML = '<strong>Add to Existing API</strong> <small class="text-muted">— Add operations without changing backends/policies</small>';
    addApiRadio.appendChild(this._modeAddRadio);
    addApiRadio.appendChild(addApiLabel);

    modeGroup.appendChild(newApiRadio);
    modeGroup.appendChild(addApiRadio);
    body.appendChild(modeGroup);

    // Existing API dropdown (shown when "Add to Existing" is selected)
    this._existingApiSection = document.createElement('div');
    this._existingApiSection.className = 'mb-3 p-2 border rounded';
    this._existingApiSection.style.background = '#f0f4ff';
    this._existingApiSection.style.display = 'none';

    const existingLabel = document.createElement('label');
    existingLabel.className = 'form-label mb-1';
    existingLabel.style.fontSize = '.8rem';
    existingLabel.textContent = 'Select Existing API';
    this._existingApiSelect = document.createElement('select');
    this._existingApiSelect.className = 'form-select form-select-sm';

    // Add event listener to detect backend type when API is selected
    this._existingApiSelect.addEventListener('change', () => {
      this._onExistingApiSelected();
      // Check for duplicate operations when API changes
      this._checkOperationDuplicates();
    });

    this._existingApiSection.appendChild(existingLabel);
    this._existingApiSection.appendChild(this._existingApiSelect);

    // Revision info (shown after API is selected)
    this._revisionInfo = document.createElement('div');
    this._revisionInfo.className = 'alert alert-info py-2 px-3 mt-2 mb-0';
    this._revisionInfo.style.fontSize = '.75rem';
    this._revisionInfo.style.display = 'none';
    this._existingApiSection.appendChild(this._revisionInfo);

    body.appendChild(this._existingApiSection);

    // API Name input (shown when "Create New" is selected)
    this._newApiSection = document.createElement('div');
    this._newApiSection.className = 'mb-3';

    const nameLabel = document.createElement('label');
    nameLabel.className = 'form-label mb-1';
    nameLabel.style.fontSize = '.8rem';
    nameLabel.textContent = 'API Name *';
    this._apiNameInput = document.createElement('input');
    this._apiNameInput.type = 'text';
    this._apiNameInput.className = 'form-control form-control-sm';
    this._apiNameInput.placeholder = 'Enter API name';
    this._apiNameInput.autocomplete = 'off';
    this._newApiSection.appendChild(nameLabel);
    this._newApiSection.appendChild(this._apiNameInput);
    body.appendChild(this._newApiSection);

    // Environment
    const envLabel = document.createElement('label');
    envLabel.className = 'form-label mb-1';
    envLabel.style.fontSize = '.8rem';
    envLabel.textContent = 'Environment';
    body.appendChild(envLabel);
    const envContainer = document.createElement('div');
    body.appendChild(envContainer);
    EnvTabs.render(envContainer, this.currentEnv, env => {
      this.currentEnv = env;
      // Reload existing APIs if in "add" mode
      if (this._modeAddRadio.checked) {
        this._loadExistingApis();
      }
      // Check for duplicates when environment changes
      if (this._modeNewRadio && this._modeNewRadio.checked) {
        this._checkApiDuplicate();
      }
      // Check for duplicate operations in "add" mode
      if (this._modeAddRadio && this._modeAddRadio.checked) {
        this._checkOperationDuplicates();
      }
    });

    // Store references to cards for later show/hide
    this._modeNewRadio._updateFormVisibility = () => {
      this._newApiSection.style.display = 'block';
      this._existingApiSection.style.display = 'none';

      // Clear operation duplicate errors when switching to new mode
      const opError = this._existingApiSection?.querySelector('.operation-duplicate-warning');
      if (opError) opError.remove();

      // Reset button and check for API duplicates
      if (this._submitBtn) {
        this._submitBtn.disabled = false;
      }
      this._checkApiDuplicate();

      // Show policy and consumer cards in new mode
      if (this._policyCard) this._policyCard.style.display = 'block';
      if (this._consumerCard) this._consumerCard.style.display = 'block';

      // Update backend config card messaging for new mode
      if (this._backendConfigInfo) {
        this._backendConfigInfo.innerHTML = '<i class="bi bi-info-circle me-1"></i>All backends will be created as resources and referenced by ID in policies.';
        this._backendConfigInfo.className = 'alert alert-info py-2 px-3 mb-2';
      }

      // Hide backend choice container (pool detection) in new mode
      if (this._backendChoiceContainer) {
        this._backendChoiceContainer.style.display = 'none';
      }

      // Hide revision info in new mode
      if (this._revisionInfo) {
        this._revisionInfo.style.display = 'none';
      }
    };

    this._modeAddRadio._updateFormVisibility = () => {
      this._newApiSection.style.display = 'none';
      this._existingApiSection.style.display = 'block';

      // Clear API duplicate errors when switching to add mode
      const apiError = this._newApiSection?.querySelector('.api-duplicate-warning');
      if (apiError) apiError.remove();

      // Disable button until API selected and validated
      if (this._submitBtn) {
        this._submitBtn.disabled = true;
      }

      this._loadExistingApis();

      // Hide policy card in add mode (API-level config)
      if (this._policyCard) this._policyCard.style.display = 'none';
      // Show consumer card in add mode (can onboard to existing APIs)
      if (this._consumerCard) this._consumerCard.style.display = 'block';

      // Update backend config card messaging for add mode
      if (this._backendConfigInfo) {
        this._backendConfigInfo.innerHTML = '<i class="bi bi-info-circle me-1"></i>Select an existing API to see backend options.';
        this._backendConfigInfo.className = 'alert alert-info py-2 px-3 mb-2';
      }
    };

    // Event listeners for mode switching
    this._modeNewRadio.addEventListener('change', () => {
      if (this._modeNewRadio.checked) {
        this._modeNewRadio._updateFormVisibility();
      }
    });

    this._modeAddRadio.addEventListener('change', () => {
      if (this._modeAddRadio.checked) {
        this._modeAddRadio._updateFormVisibility();
      }
    });

    // Real-time duplicate check for Create New API
    if (this._apiNameInput) {
      this._apiNameInput.addEventListener('blur', () => this._checkApiDuplicate());
    }

    return card;
  },

  async _checkApiDuplicate() {
    // Only check in "Create New API" mode
    if (!this._modeNewRadio || !this._modeNewRadio.checked) {
      return;
    }

    const apiName = this._apiNameInput?.value?.trim();
    const env = this.currentEnv;

    // Only check if both fields are filled
    if (!apiName || !env) {
      // Clear any previous error
      const existingError = this._newApiSection?.querySelector('.api-duplicate-warning');
      if (existingError) existingError.remove();
      // Enable submit button when fields are empty
      if (this._submitBtn) {
        this._submitBtn.disabled = false;
      }
      return;
    }

    try {
      // Get all APIs and check by display name (fuzzy match)
      console.log('[CreateAPI] Fetching all APIs for duplicate check', { env, apiName });

      const allApis = await API.get('/api/apis', { env });

      if (!allApis || !Array.isArray(allApis)) {
        console.warn('[CreateAPI] Invalid response from /api/apis', { allApis });
        return;
      }

      console.log('[CreateAPI] APIs fetched', { count: allApis.length });

      // Case-insensitive exact display name match
      const apiNameLower = apiName.toLowerCase().trim();
      const duplicate = allApis.find(api => {
        const displayName = api.displayName || '';
        return displayName.toLowerCase().trim() === apiNameLower;
      });

      // Remove any existing warning first
      const existingError = this._newApiSection?.querySelector('.api-duplicate-warning');
      if (existingError) existingError.remove();

      if (duplicate) {
        console.log('[CreateAPI] Duplicate found', { duplicate });
        // Create warning element
        const warning = document.createElement('div');
        warning.className = 'api-duplicate-warning alert alert-danger py-2 px-2 mt-2 mb-0';
        warning.style.fontSize = '.75rem';
        warning.style.borderLeft = '3px solid #dc3545';
        warning.innerHTML = `<i class="bi bi-exclamation-triangle-fill me-1"></i>API with display name '<strong>${duplicate.displayName}</strong>' already exists (API ID: '<strong>${duplicate.id}</strong>'). Please choose a different API name.`;

        this._newApiSection?.appendChild(warning);

        // Disable submit button to block creation
        if (this._submitBtn) {
          this._submitBtn.disabled = true;
        }
      } else {
        console.log('[CreateAPI] No duplicate found');

        // Enable submit button when no duplicate
        if (this._submitBtn) {
          this._submitBtn.disabled = false;
        }
      }
    } catch (err) {
      // For errors, silently fail and allow submission
      console.error('[CreateAPI] Duplicate check failed', err);
      const existingError = this._newApiSection?.querySelector('.api-duplicate-warning');
      if (existingError) existingError.remove();
      // Enable submit button on error (don't block if check fails)
      if (this._submitBtn) {
        this._submitBtn.disabled = false;
      }
    }
  },

  async _checkOperationDuplicates() {
    // Only check in "Add to Existing API" mode
    if (!this._modeAddRadio || !this._modeAddRadio.checked) {
      return;
    }

    const apiId = this._existingApiSelect?.value?.trim();
    const env = this.currentEnv;

    // Clear any previous error
    const existingError = this._existingApiSection?.querySelector('.operation-duplicate-warning');
    if (existingError) existingError.remove();

    // Only check if API is selected
    if (!apiId || !env) {
      // Enable submit button when no API selected
      if (this._submitBtn) {
        this._submitBtn.disabled = false;
      }
      return;
    }

    // Get operations from URL rows
    const operations = [];
    for (const row of this.urlRows) {
      const url = row.urlInput?.value?.trim();
      const verb = row.verbSelect?.value?.trim();
      if (url && verb) {
        try {
          const parsed = new URL(url);
          const path = parsed.pathname || '/';
          operations.push({ verb: verb.toUpperCase(), path });
        } catch (e) {
          // Invalid URL, skip
        }
      }
    }

    // No operations to check
    if (operations.length === 0) {
      if (this._submitBtn) {
        this._submitBtn.disabled = false;
      }
      return;
    }

    try {
      console.log('[CreateAPI] Checking for duplicate operations', { apiId, env, operations });

      // Fetch existing operations from the API
      const existingOps = await API.get(`/api/apis/${apiId}/operations`, { env });

      if (!existingOps) {
        console.warn('[CreateAPI] Invalid response from operations API', { existingOps });
        if (this._submitBtn) {
          this._submitBtn.disabled = false;
        }
        return;
      }

      // Backend returns {value: [...], count: X} structure (Azure APIM format)
      const operationsList = existingOps.value || [];
      console.log('[CreateAPI] Existing operations fetched', { count: operationsList.length });

      // Build set of existing operation keys (METHOD:path)
      const existingOpKeys = new Set();
      for (const op of operationsList) {
        const opProps = op.properties || {};
        const method = opProps.method?.toUpperCase();
        const path = opProps.urlTemplate;
        if (method && path) {
          existingOpKeys.add(`${method}:${path}`);
        }
      }

      // Check for duplicates
      const duplicates = [];
      for (const op of operations) {
        const opKey = `${op.verb}:${op.path}`;
        if (existingOpKeys.has(opKey)) {
          duplicates.push(`${op.verb} ${op.path}`);
        }
      }

      if (duplicates.length > 0) {
        console.log('[CreateAPI] Duplicate operations found', { duplicates });

        // Get API display name
        const allApis = await API.get('/api/apis', { env });
        const selectedApi = allApis?.find(a => a.id === apiId);
        const apiDisplayName = selectedApi?.displayName || apiId;

        // Create warning element
        const warning = document.createElement('div');
        warning.className = 'operation-duplicate-warning alert alert-danger py-2 px-2 mt-2 mb-0';
        warning.style.fontSize = '.75rem';
        warning.style.borderLeft = '3px solid #dc3545';
        warning.innerHTML = `<i class="bi bi-exclamation-triangle-fill me-1"></i>The following operation(s) already exist in API '<strong>${apiDisplayName}</strong>':<br><strong>${duplicates.join(', ')}</strong><br>Please remove these duplicate operations.`;

        this._existingApiSection?.appendChild(warning);

        // Disable submit button to block creation
        if (this._submitBtn) {
          this._submitBtn.disabled = true;
        }
      } else {
        console.log('[CreateAPI] No duplicate operations found');

        // Enable submit button when no duplicates
        if (this._submitBtn) {
          this._submitBtn.disabled = false;
        }
      }
    } catch (err) {
      // For errors, silently fail and allow submission
      console.error('[CreateAPI] Operation duplicate check failed', err);
      if (this._submitBtn) {
        this._submitBtn.disabled = false;
      }
    }
  },

  _buildUrlsCard() {
    const { card, body } = this._card('bi-link-45deg', 'Backend URLs');

    // Backend type badge row
    const badgeRow = document.createElement('div');
    badgeRow.className = 'mb-2';
    this._backendBadge = document.createElement('span');
    this._backendBadge.className = 'badge bg-secondary';
    this._backendBadge.style.fontSize = '.75rem';
    this._backendBadge.textContent = 'No URLs yet';
    badgeRow.appendChild(this._backendBadge);
    body.appendChild(badgeRow);

    // Labels row
    const labelsRow = document.createElement('div');
    labelsRow.className = 'd-flex gap-1 mb-1';
    const urlLabel = document.createElement('label');
    urlLabel.textContent = 'URL';
    urlLabel.style.flex = '2';
    urlLabel.style.fontSize = '.8rem';
    urlLabel.className = 'form-label mb-0';
    const verbLabel = document.createElement('label');
    verbLabel.textContent = 'Verb';
    verbLabel.style.width = '80px';
    verbLabel.style.fontSize = '.8rem';
    verbLabel.className = 'form-label mb-0';
    const reqTypeLabel = document.createElement('label');
    reqTypeLabel.textContent = 'Request Type';
    reqTypeLabel.style.width = '90px';
    reqTypeLabel.style.fontSize = '.8rem';
    reqTypeLabel.className = 'form-label mb-0';
    labelsRow.appendChild(urlLabel);
    labelsRow.appendChild(verbLabel);
    labelsRow.appendChild(reqTypeLabel);
    // Add a dummy for the remove button
    const dummy = document.createElement('div');
    dummy.style.width = '32px';
    labelsRow.appendChild(dummy);
    body.appendChild(labelsRow);

    // URL rows container
    this._urlRowsContainer = document.createElement('div');
    this._urlRowsContainer.className = 'mb-2';
    body.appendChild(this._urlRowsContainer);

    // Add URL button
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm btn-outline-secondary w-100';
    addBtn.innerHTML = '<i class="bi bi-plus me-1"></i>Add URL';
    addBtn.addEventListener('click', () => {
      this._addUrlRow();
      this._refreshOpsPreview();
      // Update backend configs if using existing pool (for priority/weight configuration)
      const useExistingPoolRadio = document.getElementById('useExistingPool');
      if (useExistingPoolRadio && useExistingPoolRadio.checked && this._lbBackendsSection) {
        setTimeout(() => this._updateBackendConfigs(), 100); // Small delay to ensure URL is populated
      }
    });
    body.appendChild(addBtn);

    return card;
  },

  _buildBackendConfigCard() {
    const { card, body } = this._card('bi-gear', 'Backend Configuration');

    // Info message about single backend
    this._backendConfigInfo = document.createElement('div');
    this._backendConfigInfo.className = 'alert alert-info py-2 px-3 mb-2';
    this._backendConfigInfo.style.fontSize = '.8rem';
    this._backendConfigInfo.innerHTML = '<i class="bi bi-info-circle me-1"></i>All backends will be created as resources and referenced by ID in policies.';
    body.appendChild(this._backendConfigInfo);

    // Radio button choice container for backend strategy (shown for existing APIs)
    this._backendChoiceContainer = document.createElement('div');
    this._backendChoiceContainer.className = 'mb-3';
    this._backendChoiceContainer.style.display = 'none';
    body.appendChild(this._backendChoiceContainer);

    // Load Balancer section (only visible for multiple backends)
    this._lbSection = document.createElement('div');
    this._lbSection.style.display = 'none';

    const lbCheckRow = document.createElement('div');
    lbCheckRow.className = 'mb-2';

    this._enableLBCheckbox = document.createElement('input');
    this._enableLBCheckbox.type = 'checkbox';
    this._enableLBCheckbox.className = 'form-check-input me-2';
    this._enableLBCheckbox.id = 'enableLB';

    const lbLabel = document.createElement('label');
    lbLabel.className = 'form-check-label';
    lbLabel.htmlFor = 'enableLB';
    lbLabel.style.fontSize = '.85rem';
    lbLabel.textContent = 'Enable Load Balancer Pool';

    lbCheckRow.appendChild(this._enableLBCheckbox);
    lbCheckRow.appendChild(lbLabel);
    this._lbSection.appendChild(lbCheckRow);

    // LB Algorithm dropdown (only visible when LB enabled)
    this._lbAlgorithmSection = document.createElement('div');
    this._lbAlgorithmSection.className = 'mb-2 ms-4';
    this._lbAlgorithmSection.style.display = 'none';

    const algLabel = document.createElement('label');
    algLabel.className = 'form-label mb-1';
    algLabel.style.fontSize = '.8rem';
    algLabel.textContent = 'Load Balancing Algorithm';

    this._lbAlgorithmSelect = document.createElement('select');
    this._lbAlgorithmSelect.className = 'form-select form-select-sm';
    const algorithms = [
      { value: 'roundRobin', label: 'Round Robin (default)' },
      { value: 'weighted', label: 'Weighted' },
      { value: 'leastConnections', label: 'Least Connections' },
      { value: 'priority', label: 'Priority-based' }
    ];
    algorithms.forEach(alg => {
      const opt = document.createElement('option');
      opt.value = alg.value;
      opt.textContent = alg.label;
      this._lbAlgorithmSelect.appendChild(opt);
    });

    // Add event listener to show/hide backend configs based on algorithm
    this._lbAlgorithmSelect.addEventListener('change', () => {
      const algorithm = this._lbAlgorithmSelect.value;
      // Only show priority/weight for weighted and priority-based algorithms
      if (algorithm === 'weighted' || algorithm === 'priority') {
        this._lbBackendsSection.style.display = 'block';
        this._updateBackendConfigs();
      } else {
        this._lbBackendsSection.style.display = 'none';
      }
    });

    this._lbAlgorithmSection.appendChild(algLabel);
    this._lbAlgorithmSection.appendChild(this._lbAlgorithmSelect);
    this._lbSection.appendChild(this._lbAlgorithmSection);

    // Backend-specific priority and weight settings
    this._lbBackendsSection = document.createElement('div');
    this._lbBackendsSection.className = 'ms-4 mt-2';
    this._lbBackendsSection.style.display = 'none';

    const backendsLabel = document.createElement('div');
    backendsLabel.className = 'form-label mb-2 fw-semibold';
    backendsLabel.style.fontSize = '.8rem';
    backendsLabel.innerHTML = '<i class="bi bi-sliders me-1 text-primary"></i><strong>Configure Priority/Weight for NEW Backends</strong><br><small class="text-muted fw-normal">(Priority: lower = higher priority, Weight: distribution ratio)</small>';
    this._lbBackendsSection.appendChild(backendsLabel);

    // Container for backend rows (will be populated dynamically)
    this._lbBackendsContainer = document.createElement('div');
    this._lbBackendsContainer.className = 'border rounded p-2';
    this._lbBackendsContainer.style.background = '#f8f9fa';
    this._lbBackendsSection.appendChild(this._lbBackendsContainer);

    // DON'T append to _lbSection - keep it separate so it can be shown independently
    // this._lbSection.appendChild(this._lbBackendsSection);

    // Store backend configs
    this._backendConfigs = new Map(); // hostname -> {priority, weight}

    body.appendChild(this._lbSection);
    // Append backends section separately so it can be controlled independently
    body.appendChild(this._lbBackendsSection);

    // Circuit Breaker section
    const cbCheckRow = document.createElement('div');
    cbCheckRow.className = 'mb-3 mt-3 pt-3 border-top';

    this._enableCBCheckbox = document.createElement('input');
    this._enableCBCheckbox.type = 'checkbox';
    this._enableCBCheckbox.className = 'form-check-input me-2';
    this._enableCBCheckbox.id = 'enableCB';

    const cbLabel = document.createElement('label');
    cbLabel.className = 'form-check-label fw-semibold';
    cbLabel.htmlFor = 'enableCB';
    cbLabel.style.fontSize = '.85rem';
    cbLabel.textContent = 'Enable Circuit Breaker';

    cbCheckRow.appendChild(this._enableCBCheckbox);
    cbCheckRow.appendChild(cbLabel);
    body.appendChild(cbCheckRow);

    // Circuit Breaker settings (only visible when CB enabled)
    this._cbSettingsSection = document.createElement('div');
    this._cbSettingsSection.className = 'ms-4';
    this._cbSettingsSection.style.display = 'none';

    const cbRow = document.createElement('div');
    cbRow.className = 'row g-2';

    const cbFields = [
      { label: 'Failure Count', id: '_cbFailureCount', placeholder: '5', type: 'number', help: 'Number of failures before circuit opens' },
      { label: 'Monitor Window (sec)', id: '_cbIntervalSec', placeholder: '60', type: 'number', help: 'Time window to count failures' },
      { label: 'Trip Duration (sec)', id: '_cbTripDuration', placeholder: '30', type: 'number', help: 'How long circuit stays open' },
    ];

    cbFields.forEach(f => {
      const group = document.createElement('div');
      group.className = 'col-12 col-md-4';
      const label = document.createElement('label');
      label.className = 'form-label mb-1';
      label.style.fontSize = '.75rem';
      label.innerHTML = `${f.label} <small class="text-muted">${f.help}</small>`;
      const input = document.createElement('input');
      input.type = f.type;
      input.className = 'form-control form-control-sm';
      input.placeholder = f.placeholder;
      input.autocomplete = 'off';
      this[f.id] = input;
      group.appendChild(label);
      group.appendChild(input);
      cbRow.appendChild(group);
    });

    this._cbSettingsSection.appendChild(cbRow);
    body.appendChild(this._cbSettingsSection);

    // Event listeners for toggling visibility
    this._enableLBCheckbox.addEventListener('change', () => {
      const isChecked = this._enableLBCheckbox.checked;
      this._lbAlgorithmSection.style.display = isChecked ? 'block' : 'none';

      // Only show backends section for weighted/priority algorithms
      if (isChecked) {
        const algorithm = this._lbAlgorithmSelect.value;
        if (algorithm === 'weighted' || algorithm === 'priority') {
          this._lbBackendsSection.style.display = 'block';
          this._updateBackendConfigs();
        } else {
          this._lbBackendsSection.style.display = 'none';
        }
      } else {
        this._lbBackendsSection.style.display = 'none';
      }
    });

    this._enableCBCheckbox.addEventListener('change', () => {
      this._cbSettingsSection.style.display = this._enableCBCheckbox.checked ? 'block' : 'none';
    });

    return card;
  },

  _addUrlRow() {
    const idx = this.urlRows.length;
    const row = document.createElement('div');
    row.className = 'mb-2 p-2 border rounded';
    row.style.background = '#f9fafb';

    // URL input row
    const urlRow = document.createElement('div');
    urlRow.className = 'd-flex gap-1 mb-1';

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'form-control form-control-sm flex-grow-1';
    urlInput.placeholder = 'Enter URL';
    urlInput.autocomplete = 'off';

    const verbSelect = document.createElement('select');
    verbSelect.className = 'form-select form-select-sm';
    verbSelect.style.width = '80px';
    verbSelect.style.flexShrink = '0';
    ['GET','POST','PUT','DELETE','PATCH'].forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      verbSelect.appendChild(opt);
    });



    // Request type dropdown
    const bodyTypeInput = document.createElement('select');
    bodyTypeInput.className = 'form-select form-select-sm';
    bodyTypeInput.style.width = '90px';
    bodyTypeInput.style.flexShrink = '0';
    ['Json', 'Xml', 'Form', 'Text', 'None'].forEach(type => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type;
      bodyTypeInput.appendChild(opt);
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-sm btn-outline-danger';
    removeBtn.style.flexShrink = '0';
    removeBtn.innerHTML = '<i class="bi bi-trash"></i>';
    removeBtn.addEventListener('click', () => {
      const i = this.urlRows.indexOf(rowData);
      if (i !== -1) this.urlRows.splice(i, 1);
      row.remove();
      this._updateBackendBadge();
      this._refreshOpsPreview();
      this._validateAllUrls(); // Re-validate remaining URLs
      // Check for duplicate operations when operation is removed
      if (this._modeAddRadio && this._modeAddRadio.checked) {
        this._checkOperationDuplicates();
      }
    });

    urlRow.appendChild(urlInput);
    urlRow.appendChild(verbSelect);
    urlRow.appendChild(bodyTypeInput);
    urlRow.appendChild(removeBtn);
    row.appendChild(urlRow);

    // Validation message container
    const validationMsg = document.createElement('div');
    validationMsg.className = 'mt-1';
    validationMsg.style.fontSize = '.75rem';
    validationMsg.style.display = 'none';
    row.appendChild(validationMsg);

    this._urlRowsContainer.appendChild(row);

    const rowData = { urlInput, verbSelect, bodyTypeInput, row, clientPath: '', validationMsg, hasError: false };
    this.urlRows.push(rowData);

    urlInput.addEventListener('input', () => {
      this._validateUrl(rowData);
      this._updateBackendBadge();
      this._refreshOpsPreview();
      // Check for duplicate operations when URL changes
      if (this._modeAddRadio && this._modeAddRadio.checked) {
        this._checkOperationDuplicates();
      }
      // Update backend configs if using existing pool (for priority/weight configuration)
      const useExistingPoolRadio = document.getElementById('useExistingPool');
      if (useExistingPoolRadio && useExistingPoolRadio.checked && this._lbBackendsSection) {
        this._updateBackendConfigs();
      }
    });
    verbSelect.addEventListener('change', () => {
      this._refreshOpsPreview();
      // Check for duplicate operations when verb changes
      if (this._modeAddRadio && this._modeAddRadio.checked) {
        this._checkOperationDuplicates();
      }
    });
    bodyTypeInput.addEventListener('input', () => this._refreshOpsPreview());
  },

  _validateUrl(rowData) {
    const input = rowData.urlInput;
    const msg = rowData.validationMsg;
    const value = input.value.trim();

    // Empty is OK (not yet entered)
    if (!value) {
      msg.style.display = 'none';
      input.style.borderColor = '';
      rowData.hasError = false;
      return;
    }

    let url;
    try {
      url = new URL(value);
    } catch {
      this._showValidationError(input, msg, 'Invalid URL format');
      rowData.hasError = true;
      return;
    }

    // Check for localhost
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.local')) {
      this._showValidationError(input, msg, 'Localhost URLs not allowed in production');
      rowData.hasError = true;
      return;
    }

    // Check for non-standard ports
    const port = url.port;
    const isStandardPort = !port || port === '80' || port === '443' ||
                          (url.protocol === 'http:' && port === '80') ||
                          (url.protocol === 'https:' && port === '443');

    if (!isStandardPort) {
      this._showValidationWarning(input, msg, `Non-standard port detected (${port}) - verify this is intentional`);
      rowData.hasError = false; // Warning, not error
      // Don't return - check for mixed protocols too
    }

    // Check for mixed protocols across all URLs
    const mixedProtocolMsg = this._checkMixedProtocols();
    if (mixedProtocolMsg) {
      this._showValidationWarning(input, msg, mixedProtocolMsg);
      rowData.hasError = false; // Warning, not error
      return;
    }

    // Valid URL
    if (isStandardPort) {
      msg.style.display = 'none';
      input.style.borderColor = '#198754'; // Green
      rowData.hasError = false;
    }
  },

  _showValidationError(input, msg, text) {
    msg.textContent = '⛔ ' + text;
    msg.style.color = '#dc3545';
    msg.style.display = 'block';
    input.style.borderColor = '#dc3545';
  },

  _showValidationWarning(input, msg, text) {
    msg.textContent = '⚠️ ' + text;
    msg.style.color = '#fd7e14';
    msg.style.display = 'block';
    input.style.borderColor = '#fd7e14';
  },

  _checkMixedProtocols() {
    const protocols = new Set();
    this.urlRows.forEach(r => {
      const value = r.urlInput.value.trim();
      if (!value) return;
      try {
        const url = new URL(value);
        protocols.add(url.protocol);
      } catch {}
    });

    if (protocols.size > 1) {
      const protocolList = Array.from(protocols).join(', ');
      return `Mixed protocols detected (${protocolList}) - use HTTPS consistently`;
    }
    return null;
  },

  _validateAllUrls() {
    this.urlRows.forEach(rowData => this._validateUrl(rowData));
  },

  _getUrlEntries() {
    return this.urlRows
      .map((r, i) => {
        // Use the editable clientPath from the ops preview if set, else default to last segment of path
        let client_path = r.clientPath || '';
        if (!client_path) {
          try {
            const path = new URL(r.urlInput.value).pathname;
            // Use only the last segment, or fallback to the whole path if root
            const segments = path.split('/').filter(Boolean);
            client_path = segments.length ? '/' + segments[segments.length - 1] : path;
          } catch {
            client_path = '';
          }
        }
        return {
          url: r.urlInput.value.trim(),
          verb: r.verbSelect.value,
          client_path,
          body_type: r.bodyTypeInput.value.trim()
        };
      })
      .filter(r => r.url.length > 0);
  },

  _updateBackendBadge() {
    const entries = this._getUrlEntries();
    const isAddMode = this._modeAddRadio && this._modeAddRadio.checked;

    if (!entries.length) {
      this._backendBadge.className = 'badge bg-secondary';
      this._backendBadge.style.fontSize = '.75rem';
      this._backendBadge.textContent = 'No URLs yet';
      // Hide LB section when no URLs
      if (this._lbSection) this._lbSection.style.display = 'none';
      // In Add mode, update backend detection when URLs are cleared
      if (isAddMode && this._existingApiSelect && this._existingApiSelect.value) {
        this._onExistingApiSelected();
      }
      return;
    }
    const domains = new Set();
    entries.forEach(e => {
      try { domains.add(new URL(e.url).hostname); } catch {}
    });

    // In Add to Existing mode, check if backends changed (count OR names) and update detection
    if (isAddMode && this._existingApiSelect && this._existingApiSelect.value) {
      const currentBackends = Array.from(domains).sort().join(',');
      const lastBackends = this._lastBackends || '';

      if (lastBackends !== currentBackends) {
        this._lastBackends = currentBackends;
        this._lastBackendCount = domains.size;
        this._onExistingApiSelected(); // Refresh backend detection
        return; // _onExistingApiSelected will handle the rest
      }
    }

    if (domains.size === 0) {
      this._backendBadge.className = 'badge bg-secondary';
      this._backendBadge.textContent = 'Invalid URL(s)';
      if (this._lbSection) this._lbSection.style.display = 'none';
    } else if (domains.size === 1) {
      this._backendBadge.className = 'badge bg-info text-dark';
      this._backendBadge.textContent = 'Single Backend';
      // In "Add to Existing" mode, check radio button choice before showing LB section
      if (this._lbSection) {
        if (isAddMode) {
          const createNewRadio = document.getElementById('createNewPool');
          // Only show if "Create new pool" is selected
          this._lbSection.style.display = (createNewRadio && createNewRadio.checked) ? 'block' : 'none';
        } else {
          this._lbSection.style.display = 'none';
        }
      }
      // Hide priority/weight config for single backend in New API mode
      if (this._lbBackendsSection && !isAddMode) {
        this._lbBackendsSection.style.display = 'none';
      }
    } else {
      this._backendBadge.className = 'badge bg-warning text-dark';
      this._backendBadge.textContent = `Pool Backend (${domains.size} domains)`;
      // Show LB section for multiple backends, but respect radio button choice in Add mode
      if (this._lbSection) {
        // Check if we're in Add mode with "Use existing pool" selected
        const createNewRadio = document.getElementById('createNewPool');
        // In Add mode: hide LB section unless "Create new pool" is explicitly selected
        // In New mode: always show LB section
        if (isAddMode) {
          // Default to hidden in Add mode, only show if "Create new pool" is selected
          this._lbSection.style.display = (createNewRadio && createNewRadio.checked) ? 'block' : 'none';
        } else {
          // New API mode - always show
          this._lbSection.style.display = 'block';
        }
      }
      // Update backend configs if LB is enabled AND algorithm needs it
      if (this._enableLBCheckbox && this._enableLBCheckbox.checked) {
        const algorithm = this._lbAlgorithmSelect.value;
        if (algorithm === 'weighted' || algorithm === 'priority') {
          this._updateBackendConfigs();
        }
      }
    }
    this._backendBadge.style.fontSize = '.75rem';
  },

  _updateBackendConfigs() {
    if (!this._lbBackendsContainer) return;

    const entries = this._getUrlEntries();
    const domains = new Set();
    entries.forEach(e => {
      try { domains.add(new URL(e.url).hostname); } catch {}
    });

    // Clear existing UI
    this._lbBackendsContainer.innerHTML = '';

    if (domains.size === 0) {
      this._lbBackendsContainer.innerHTML = '<div class="text-muted small">Add URLs to configure backends</div>';
      return;
    }

    // Create input rows for each backend
    const sortedDomains = Array.from(domains).sort();
    sortedDomains.forEach((hostname) => {
      // Get existing config or use defaults
      const existing = this._backendConfigs.get(hostname) || { priority: 1, weight: 50 };

      const row = document.createElement('div');
      row.className = 'mb-2 p-2 border rounded';
      row.style.background = 'white';

      const hostnameLabel = document.createElement('div');
      hostnameLabel.className = 'fw-semibold mb-1';
      hostnameLabel.style.fontSize = '.8rem';
      hostnameLabel.innerHTML = `<i class="bi bi-hdd-network me-1 text-primary"></i>${hostname}`;
      row.appendChild(hostnameLabel);

      const inputRow = document.createElement('div');
      inputRow.className = 'd-flex gap-2';

      // Priority input
      const priorityGroup = document.createElement('div');
      priorityGroup.className = 'flex-fill';
      const priorityLabel = document.createElement('label');
      priorityLabel.className = 'form-label mb-1';
      priorityLabel.style.fontSize = '.7rem';
      priorityLabel.textContent = 'Priority';
      const priorityInput = document.createElement('input');
      priorityInput.type = 'number';
      priorityInput.className = 'form-control form-control-sm';
      priorityInput.placeholder = '1';
      priorityInput.value = existing.priority;
      priorityInput.min = '1';
      priorityInput.autocomplete = 'off';
      priorityInput.addEventListener('input', () => {
        this._backendConfigs.set(hostname, {
          priority: parseInt(priorityInput.value) || 1,
          weight: parseInt(weightInput.value) || 50
        });
      });
      priorityGroup.appendChild(priorityLabel);
      priorityGroup.appendChild(priorityInput);

      // Weight input
      const weightGroup = document.createElement('div');
      weightGroup.className = 'flex-fill';
      const weightLabel = document.createElement('label');
      weightLabel.className = 'form-label mb-1';
      weightLabel.style.fontSize = '.7rem';
      weightLabel.textContent = 'Weight';
      const weightInput = document.createElement('input');
      weightInput.type = 'number';
      weightInput.className = 'form-control form-control-sm';
      weightInput.placeholder = '50';
      weightInput.value = existing.weight;
      weightInput.min = '1';
      weightInput.autocomplete = 'off';
      weightInput.addEventListener('input', () => {
        this._backendConfigs.set(hostname, {
          priority: parseInt(priorityInput.value) || 1,
          weight: parseInt(weightInput.value) || 50
        });
      });
      weightGroup.appendChild(weightLabel);
      weightGroup.appendChild(weightInput);

      inputRow.appendChild(priorityGroup);
      inputRow.appendChild(weightGroup);
      row.appendChild(inputRow);

      this._lbBackendsContainer.appendChild(row);

      // Store initial values
      this._backendConfigs.set(hostname, existing);
    });
  },

  _buildOpsCard() {
    const { card, body } = this._card('bi-table', 'Operations Preview');
    this._opsBody = body;
    body.innerHTML = '<p class="text-muted mb-0" style="font-size:.8rem">Add URLs above to see operations.</p>';
    return card;
  },

  _slugify(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'op';
  },

  _stripCommonPrefix(paths) {
    if (!paths.length) return paths;
    const parts = paths.map(p => p.replace(/^\//, '').split('/'));
    const minLen = Math.min(...parts.map(p => p.length));
    let common = 0;
    for (let i = 0; i < minLen - 1; i++) {
      const seg = parts[0][i];
      if (seg.includes('{') || !parts.every(p => p[i] === seg)) break;
      common = i + 1;
    }
    return parts.map(p => '/' + p.slice(common).join('/'));
  },

  _refreshOpsPreview() {
    const entries = this._getUrlEntries();
    const body = this._opsBody;
    if (!entries.length) {
      body.innerHTML = '<p class="text-muted mb-0" style="font-size:.8rem">Add URLs above to see operations.</p>';
      return;
    }

    // Extract full paths and compute short client paths
    const fullPaths = entries.map(e => {
      try { return new URL(e.url).pathname; } catch { return e.url; }
    });
    const clientPaths = this._stripCommonPrefix(fullPaths);

    const table = document.createElement('table');
    table.className = 'table table-sm mb-0';
    table.innerHTML = `<thead><tr class="table-light">
      <th>Verb</th><th>Client Path</th><th>Rewrite URI</th><th>Operation ID</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    entries.forEach((e, i) => {
      const clientPath = e.client_path || clientPaths[i] || '/';
      const rewriteUri = fullPaths[i] || '/';
      const slug = this._slugify(clientPath.replace(/^\//, '').replace(/\//g, '-'));
      const opId = `${e.verb.toLowerCase()}-${slug}`;
      const tr = document.createElement('tr');
      // Editable client path cell
      const clientPathCell = document.createElement('td');
      clientPathCell.style.padding = '0.25rem';
      const clientPathInput = document.createElement('input');
      clientPathInput.type = 'text';
      clientPathInput.value = clientPath;
      clientPathInput.className = 'form-control form-control-sm';
      clientPathInput.autocomplete = 'off';
      clientPathInput.style.color = '#d6336c';
      clientPathInput.style.fontSize = '.75rem';
      clientPathInput.style.background = 'transparent';
      clientPathInput.style.border = '1px solid #eee';
      clientPathInput.style.padding = '0.1rem 0.25rem';
      clientPathInput.addEventListener('input', () => {
        this.urlRows[i].clientPath = clientPathInput.value;
      });
      clientPathCell.appendChild(clientPathInput);
      tr.innerHTML = `
        <td><span class="badge bg-primary">${e.verb}</span></td>
        <td></td>
        <td><code style="font-size:.75rem">${rewriteUri}</code></td>
        <td><code style="font-size:.75rem">${opId}</code></td>`;
      tr.replaceChild(clientPathCell, tr.children[1]);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.innerHTML = '';
    body.appendChild(table);
  },

  _buildPolicyCard() {
    const { card, body } = this._card('bi-shield-lock', 'Policy Configuration');

    const row = document.createElement('div');
    row.className = 'row';

    const fields = [
      { label: 'JWT Audience *', id: '_jwtInput', placeholder: 'Enter JWT audience', type: 'text', required: false, help: null },
      { label: 'Rate Limit Calls *', id: '_rateLimitCalls', placeholder: 'Enter limit', type: 'number', required: true, help: 'Per-minute window (60s, fixed)' },
      { label: 'Quota Calls (per day) *', id: '_quotaCalls', placeholder: 'Enter quota', type: 'number', required: true, help: 'Per-day window (86400s, fixed)' },
    ];

    fields.forEach(f => {
      const group = document.createElement('div');
      group.className = 'mb-2 col-6';
      const label = document.createElement('label');
      label.className = 'form-label mb-1';
      label.style.fontSize = '.8rem';
      label.textContent = f.label;
      const input = document.createElement('input');
      input.type = f.type;
      input.className = 'form-control form-control-sm';
      input.placeholder = f.placeholder;
      input.autocomplete = 'off';
      if (f.required) {
        input.required = true;
        input.min = '1';
      }
      this[f.id] = input;
      group.appendChild(label);
      group.appendChild(input);
      if (f.help) {
        const small = document.createElement('small');
        small.className = 'form-text text-muted';
        small.textContent = f.help;
        group.appendChild(small);
      }
      row.appendChild(group);
    });

    body.appendChild(row);
    return card;
  },

  _buildCertAuthCard() {
    const { card, body } = this._card('bi-shield-check', 'Backend Cert Auth (Optional)');

    // Toggle checkbox
    const toggleRow = document.createElement('div');
    toggleRow.className = 'form-check mb-2';
    this._certAuthToggle = document.createElement('input');
    this._certAuthToggle.type = 'checkbox';
    this._certAuthToggle.className = 'form-check-input';
    this._certAuthToggle.id = 'cert-auth-toggle';
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'form-check-label';
    toggleLabel.style.fontSize = '.85rem';
    toggleLabel.htmlFor = 'cert-auth-toggle';
    toggleLabel.textContent = 'Backend requires client cert (mTLS to backend)';
    toggleRow.appendChild(this._certAuthToggle);
    toggleRow.appendChild(toggleLabel);
    body.appendChild(toggleRow);

    // Collapsible cert fields
    this._certAuthFields = document.createElement('div');
    this._certAuthFields.style.display = 'none';
    this._certAuthFields.style.paddingLeft = '16px';
    this._certAuthFields.style.borderLeft = '2px solid #ddd';
    this._certAuthFields.style.margin = '8px 0';

    const certFileGroup = document.createElement('div');
    certFileGroup.className = 'mb-2';
    const certFileLabel = document.createElement('label');
    certFileLabel.className = 'form-label mb-1';
    certFileLabel.style.fontSize = '.8rem';
    certFileLabel.textContent = 'Client cert file (.pfx/.p12/.cer/.crt):';
    this._clientCertFile = document.createElement('input');
    this._clientCertFile.type = 'file';
    this._clientCertFile.className = 'form-control form-control-sm';
    this._clientCertFile.accept = '.pfx,.p12,.cer,.crt';
    certFileGroup.appendChild(certFileLabel);
    certFileGroup.appendChild(this._clientCertFile);
    this._certAuthFields.appendChild(certFileGroup);

    const certPwGroup = document.createElement('div');
    certPwGroup.className = 'mb-2';
    const certPwLabel = document.createElement('label');
    certPwLabel.className = 'form-label mb-1';
    certPwLabel.style.fontSize = '.8rem';
    certPwLabel.textContent = 'Cert password (leave blank for none):';
    this._clientCertPassword = document.createElement('input');
    this._clientCertPassword.type = 'password';
    this._clientCertPassword.className = 'form-control form-control-sm';
    this._clientCertPassword.autocomplete = 'off';
    certPwGroup.appendChild(certPwLabel);
    certPwGroup.appendChild(this._clientCertPassword);
    this._certAuthFields.appendChild(certPwGroup);

    // CA toggle
    const caToggleRow = document.createElement('div');
    caToggleRow.className = 'form-check mb-2';
    this._caToggle = document.createElement('input');
    this._caToggle.type = 'checkbox';
    this._caToggle.className = 'form-check-input';
    this._caToggle.id = 'ca-toggle';
    const caToggleLabel = document.createElement('label');
    caToggleLabel.className = 'form-check-label';
    caToggleLabel.style.fontSize = '.85rem';
    caToggleLabel.htmlFor = 'ca-toggle';
    caToggleLabel.textContent = 'Also upload CA certificate';
    caToggleRow.appendChild(this._caToggle);
    caToggleRow.appendChild(caToggleLabel);
    this._certAuthFields.appendChild(caToggleRow);

    // CA collapsible fields
    this._caFields = document.createElement('div');
    this._caFields.style.display = 'none';
    this._caFields.style.paddingLeft = '16px';
    this._caFields.style.borderLeft = '2px solid #ccc';
    this._caFields.style.margin = '8px 0';

    const caFileGroup = document.createElement('div');
    caFileGroup.className = 'mb-2';
    const caFileLabel = document.createElement('label');
    caFileLabel.className = 'form-label mb-1';
    caFileLabel.style.fontSize = '.8rem';
    caFileLabel.textContent = 'CA cert file:';
    this._caCertFile = document.createElement('input');
    this._caCertFile.type = 'file';
    this._caCertFile.className = 'form-control form-control-sm';
    this._caCertFile.accept = '.pfx,.p12,.cer,.crt';
    caFileGroup.appendChild(caFileLabel);
    caFileGroup.appendChild(this._caCertFile);
    this._caFields.appendChild(caFileGroup);

    const caPwGroup = document.createElement('div');
    caPwGroup.className = 'mb-2';
    const caPwLabel = document.createElement('label');
    caPwLabel.className = 'form-label mb-1';
    caPwLabel.style.fontSize = '.8rem';
    caPwLabel.textContent = 'CA cert password:';
    this._caCertPassword = document.createElement('input');
    this._caCertPassword.type = 'password';
    this._caCertPassword.className = 'form-control form-control-sm';
    this._caCertPassword.autocomplete = 'off';
    caPwGroup.appendChild(caPwLabel);
    caPwGroup.appendChild(this._caCertPassword);
    this._caFields.appendChild(caPwGroup);

    const caStoreGroup = document.createElement('div');
    caStoreGroup.className = 'mb-2';
    const caStoreLabel = document.createElement('label');
    caStoreLabel.className = 'form-label mb-1';
    caStoreLabel.style.fontSize = '.8rem';
    caStoreLabel.textContent = 'Store:';
    this._caCertStore = document.createElement('select');
    this._caCertStore.className = 'form-select form-select-sm';
    ['Root', 'CertificateAuthority'].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      this._caCertStore.appendChild(o);
    });
    caStoreGroup.appendChild(caStoreLabel);
    caStoreGroup.appendChild(this._caCertStore);
    this._caFields.appendChild(caStoreGroup);

    this._certAuthFields.appendChild(this._caFields);
    body.appendChild(this._certAuthFields);

    // Wire toggles
    this._certAuthToggle.addEventListener('change', () => {
      this._certAuthFields.style.display = this._certAuthToggle.checked ? 'block' : 'none';
    });
    this._caToggle.addEventListener('change', () => {
      this._caFields.style.display = this._caToggle.checked ? 'block' : 'none';
    });

    return card;
  },

  _buildConsumerCard() {
    const { card, body } = this._card('bi-person-check', 'Consumer Access (Optional)');

    const checkRow = document.createElement('div');
    checkRow.className = 'form-check mb-2';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'form-check-input';
    checkbox.id = 'consumer-check';
    const checkLabel = document.createElement('label');
    checkLabel.className = 'form-check-label';
    checkLabel.style.fontSize = '.85rem';
    checkLabel.htmlFor = 'consumer-check';
    checkLabel.textContent = 'Set up consumer access';
    checkRow.appendChild(checkbox);
    checkRow.appendChild(checkLabel);
    body.appendChild(checkRow);

    this._consumerFields = document.createElement('div');
    this._consumerFields.style.display = 'none';

    const appNameGroup = document.createElement('div');
    appNameGroup.className = 'mb-2';
    const appNameLabel = document.createElement('label');
    appNameLabel.className = 'form-label mb-1';
    appNameLabel.style.fontSize = '.8rem';
    appNameLabel.textContent = 'App Name';
    this._consumerAppName = document.createElement('input');
    this._consumerAppName.type = 'text';
    this._consumerAppName.className = 'form-control form-control-sm';
    this._consumerAppName.placeholder = 'Enter app name';
    this._consumerAppName.autocomplete = 'off';
    appNameGroup.appendChild(appNameLabel);
    appNameGroup.appendChild(this._consumerAppName);

    const appIdGroup = document.createElement('div');
    appIdGroup.className = 'mb-2';
    const appIdLabel = document.createElement('label');
    appIdLabel.className = 'form-label mb-1';
    appIdLabel.style.fontSize = '.8rem';
    appIdLabel.textContent = 'Consumer App ID';
    this._consumerAppId = document.createElement('input');
    this._consumerAppId.type = 'text';
    this._consumerAppId.className = 'form-control form-control-sm';
    this._consumerAppId.placeholder = 'Enter app ID';
    this._consumerAppId.autocomplete = 'off';
    appIdGroup.appendChild(appIdLabel);
    appIdGroup.appendChild(this._consumerAppId);

    const clientIdGroup = document.createElement('div');
    clientIdGroup.className = 'mb-2';
    const clientIdLabel = document.createElement('label');
    clientIdLabel.className = 'form-label mb-1';
    clientIdLabel.style.fontSize = '.8rem';
    clientIdLabel.textContent = 'Consumer Name';
    this._consumerClientId = document.createElement('input');
    this._consumerClientId.type = 'text';
    this._consumerClientId.className = 'form-control form-control-sm';
    this._consumerClientId.placeholder = 'Enter consumer name';
    this._consumerClientId.autocomplete = 'off';
    clientIdGroup.appendChild(clientIdLabel);
    clientIdGroup.appendChild(this._consumerClientId);

    this._consumerFields.appendChild(appNameGroup);
    this._consumerFields.appendChild(appIdGroup);
    this._consumerFields.appendChild(clientIdGroup);

    // Product/Subscription Strategy Section
    this._consumerStrategySection = document.createElement('div');
    this._consumerStrategySection.style.display = 'none';
    this._consumerStrategySection.className = 'mt-2';

    const strategyLabel = document.createElement('div');
    strategyLabel.className = 'form-label mb-1 fw-semibold';
    strategyLabel.style.fontSize = '.8rem';
    strategyLabel.textContent = 'Product/Subscription Strategy';
    this._consumerStrategySection.appendChild(strategyLabel);

    // Create New Product radio
    const createNewRow = document.createElement('div');
    createNewRow.className = 'form-check mb-1';
    const createNewRadio = document.createElement('input');
    createNewRadio.type = 'radio';
    createNewRadio.className = 'form-check-input';
    createNewRadio.name = 'consumer-strategy';
    createNewRadio.id = 'consumer-create-new';
    createNewRadio.value = 'create_new';
    createNewRadio.checked = true;
    const createNewLabel = document.createElement('label');
    createNewLabel.className = 'form-check-label';
    createNewLabel.style.fontSize = '.75rem';
    createNewLabel.htmlFor = 'consumer-create-new';
    createNewLabel.textContent = 'Create new product and subscription';
    createNewRow.appendChild(createNewRadio);
    createNewRow.appendChild(createNewLabel);
    this._consumerStrategySection.appendChild(createNewRow);

    // Add to Existing Product radio
    const addExistingRow = document.createElement('div');
    addExistingRow.className = 'form-check';
    const addExistingRadio = document.createElement('input');
    addExistingRadio.type = 'radio';
    addExistingRadio.className = 'form-check-input';
    addExistingRadio.name = 'consumer-strategy';
    addExistingRadio.id = 'consumer-add-existing';
    addExistingRadio.value = 'add_to_existing';
    const addExistingLabel = document.createElement('label');
    addExistingLabel.className = 'form-check-label';
    addExistingLabel.style.fontSize = '.75rem';
    addExistingLabel.htmlFor = 'consumer-add-existing';
    addExistingLabel.textContent = 'Add to existing product (use existing subscription)';
    addExistingRow.appendChild(addExistingRadio);
    addExistingRow.appendChild(addExistingLabel);
    this._consumerStrategySection.appendChild(addExistingRow);

    // Product selection dropdown
    this._consumerProductDropdown = document.createElement('div');
    this._consumerProductDropdown.className = 'mt-2';
    this._consumerProductDropdown.style.display = 'none';
    const productLabel = document.createElement('label');
    productLabel.className = 'form-label mb-1';
    productLabel.style.fontSize = '.75rem';
    productLabel.textContent = 'Select Product';
    this._consumerProductSelect = document.createElement('select');
    this._consumerProductSelect.className = 'form-select form-select-sm';
    this._consumerProductDropdown.appendChild(productLabel);
    this._consumerProductDropdown.appendChild(this._consumerProductSelect);
    this._consumerStrategySection.appendChild(this._consumerProductDropdown);

    this._consumerFields.appendChild(this._consumerStrategySection);

    // Store strategy radio buttons for easy access
    this._consumerCreateNewRadio = createNewRadio;
    this._consumerAddExistingRadio = addExistingRadio;

    // Event listeners for strategy radio buttons
    createNewRadio.addEventListener('change', () => {
      this._consumerProductDropdown.style.display = 'none';
    });

    addExistingRadio.addEventListener('change', () => {
      this._consumerProductDropdown.style.display = 'block';
    });

    // Duplicate detection now happens in _onReview when user clicks Review & Create button

    body.appendChild(this._consumerFields);

    checkbox.addEventListener('change', () => {
      this.hasConsumer = checkbox.checked;
      this._consumerFields.style.display = checkbox.checked ? '' : 'none';
      if (!checkbox.checked) {
        this._consumerStrategySection.style.display = 'none';
      }
    });

    return card;
  },

  _collectPayload() {
    const isNewMode = this._modeNewRadio.checked;

    const payload = {
      mode: isNewMode ? 'new' : 'add',
      env: this.currentEnv,
      urls: this._getUrlEntries(),
    };

    if (isNewMode) {
      // New API mode - include all configuration
      payload.name = this._apiNameInput.value.trim();

      // Collect backend configuration
      const backendConfig = {
        enable_lb: this._enableLBCheckbox.checked,
        enable_circuit_breaker: this._enableCBCheckbox.checked,
      };

      if (backendConfig.enable_lb) {
        backendConfig.lb_algorithm = this._lbAlgorithmSelect.value;
        // Convert Map to object for JSON serialization
        backendConfig.backend_configs = {};
        this._backendConfigs.forEach((config, hostname) => {
          backendConfig.backend_configs[hostname] = config;
        });
      }

      if (backendConfig.enable_circuit_breaker) {
        backendConfig.circuit_breaker = {
          failure_count: parseInt(this._cbFailureCount.value) || 5,
          interval_seconds: parseInt(this._cbIntervalSec.value) || 60,
          trip_duration_seconds: parseInt(this._cbTripDuration.value) || 30
        };
      }

      payload.backend_config = backendConfig;
      payload.jwt_audience = this._jwtInput.value.trim();
      payload.rate_limit_calls = this._rateLimitCalls.value.trim();
      payload.quota_calls = this._quotaCalls.value.trim();

      if (this.hasConsumer) {
        payload.consumer = {
          app_name: this._consumerAppName.value.trim(),
          app_id: this._consumerAppId.value.trim(),
          client_id: this._consumerClientId.value.trim(),
        };

        // Add onboarding strategy if consumer products exist
        if (this._consumerStrategySection.style.display !== 'none') {
          payload.consumer.onboard_strategy = this._consumerAddExistingRadio.checked ? 'add_to_existing' : 'create_new';
          if (payload.consumer.onboard_strategy === 'add_to_existing') {
            payload.consumer.existing_product_id = this._consumerProductSelect.value;
          }
        } else {
          // No existing products - default to create new
          payload.consumer.onboard_strategy = 'create_new';
        }
      }
    } else {
      // Add to existing API mode - include existing API ID and backend config
      payload.existing_api_id = this._existingApiSelect.value;
      const selectedOption = this._existingApiSelect.options[this._existingApiSelect.selectedIndex];
      if (selectedOption && selectedOption.dataset.apiData) {
        const apiData = JSON.parse(selectedOption.dataset.apiData);
        payload.name = apiData.displayName; // For display purposes
      }

      // Include backend configuration for new operations
      // Check if "Add to existing pool" is selected
      const addToExistingPoolRadio = document.getElementById('addToExistingPool');
      const isAddingToExistingPool = addToExistingPoolRadio && addToExistingPoolRadio.checked;
      const selectedPoolId = isAddingToExistingPool ? document.getElementById('apiPoolSelect')?.value : null;

      // Check if "Create new pool" is selected
      const createNewPoolRadio = document.getElementById('createNewPool');
      const isCreatingNewPool = createNewPoolRadio && createNewPoolRadio.checked;

      const backendConfig = {
        enable_lb: this._enableLBCheckbox.checked || isAddingToExistingPool || isCreatingNewPool,
        enable_circuit_breaker: this._enableCBCheckbox.checked,
      };

      // If adding to existing pool, pass the pool ID
      if (isAddingToExistingPool && selectedPoolId) {
        backendConfig.existing_pool_id = selectedPoolId;
      }

      // Send backend_configs if using existing pool OR creating new pool
      if (backendConfig.enable_lb) {
        // For existing pool, we may not have algorithm (pool already configured)
        if (this._lbAlgorithmSelect && this._lbAlgorithmSelect.value) {
          backendConfig.lb_algorithm = this._lbAlgorithmSelect.value;
        }

        // Send priority/weight configs for new backends
        backendConfig.backend_configs = {};
        if (this._backendConfigs && this._backendConfigs.size > 0) {
          this._backendConfigs.forEach((config, hostname) => {
            backendConfig.backend_configs[hostname] = config;
          });
        }
      }

      if (backendConfig.enable_circuit_breaker) {
        backendConfig.circuit_breaker = {
          failure_count: parseInt(this._cbFailureCount.value) || 5,
          interval_seconds: parseInt(this._cbIntervalSec.value) || 60,
          trip_duration_seconds: parseInt(this._cbTripDuration.value) || 30
        };
      }

      payload.backend_config = backendConfig;

      // Add consumer payload for Add to Existing API mode
      if (this.hasConsumer) {
        payload.consumer = {
          app_name: this._consumerAppName.value.trim(),
          app_id: this._consumerAppId.value.trim(),
          client_id: this._consumerClientId.value.trim(),
        };

        // Add onboarding strategy if consumer products exist
        if (this._consumerStrategySection.style.display !== 'none') {
          payload.consumer.onboard_strategy = this._consumerAddExistingRadio.checked ? 'add_to_existing' : 'create_new';
          if (payload.consumer.onboard_strategy === 'add_to_existing') {
            payload.consumer.existing_product_id = this._consumerProductSelect.value;
          }
        } else {
          // No existing products - default to create new
          payload.consumer.onboard_strategy = 'create_new';
        }
      }
    }

    return payload;
  },

  _validate(payload) {
    // Common validation for both modes
    if (!payload.urls.length) return 'At least one URL is required.';

    // Check for URL validation errors (not warnings)
    const urlErrors = this.urlRows.filter(r => r.hasError && r.urlInput.value.trim());
    if (urlErrors.length > 0) {
      return `Fix ${urlErrors.length} URL error${urlErrors.length > 1 ? 's' : ''} before submitting (localhost or invalid format).`;
    }

    if (payload.mode === 'new') {
      // New API mode validation
      if (!payload.name) return 'API Name is required.';
      if (!payload.jwt_audience) return 'JWT Audience is required.';

      // Rate limit and quota validation (only for new API mode)
      const rlc = Number(payload.rate_limit_calls);
      if (!payload.rate_limit_calls || isNaN(rlc) || rlc < 1) {
        return 'Rate limit and quota values are required (numeric, positive)';
      }
      const qc = Number(payload.quota_calls);
      if (!payload.quota_calls || isNaN(qc) || qc < 1) {
        return 'Rate limit and quota values are required (numeric, positive)';
      }

      if (payload.consumer) {
        if (!payload.consumer.app_name) return 'Consumer App Name is required.';
        if (!payload.consumer.app_id) return 'Consumer App ID is required.';
        if (!payload.consumer.client_id) return 'Consumer Name is required.';
      }
    } else {
      // Add to existing API mode validation
      if (!payload.existing_api_id) return 'Please select an existing API.';
      if (payload.consumer) {
        if (!payload.consumer.app_name) return 'Consumer App Name is required.';
        if (!payload.consumer.app_id) return 'Consumer App ID is required.';
        if (!payload.consumer.client_id) return 'Consumer Name is required.';
      }
    }

    return null;
  },

  _ensureModal() {
    if (document.getElementById('create-api-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'create-api-modal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.innerHTML = `
      <div class="modal-dialog modal-lg">
        <div class="modal-content">
          <div class="modal-header py-2 px-3" style="background:var(--apim-gradient);color:white;">
            <h6 class="modal-title mb-0"><i class="bi bi-check2-square me-1"></i>Confirm Create API</h6>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body py-2 px-3" id="create-api-modal-body" style="font-size:.82rem"></div>
          <div class="modal-footer py-2 px-3">
            <button class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button class="btn btn-sm btn-primary" id="create-api-confirm-btn">
              <i class="bi bi-send me-1"></i>Create API
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  _ensureErrorModal() {
    if (document.getElementById('create-api-error-modal')) return;
    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'create-api-error-modal';
    modalOverlay.className = 'assistant-modal-overlay';
    modalOverlay.style.display = 'none';
    modalOverlay.innerHTML = `
      <div class="assistant-modal-container">
        <div class="assistant-modal-content">
          <div class="assistant-modal-header">
            <i class="bi bi-exclamation-triangle-fill me-2" style="color:#dc3545"></i>
            <span>Unable to Process Request</span>
          </div>
          <div class="assistant-modal-body" id="create-api-error-modal-body"></div>
          <div class="assistant-modal-footer">
            <button class="assistant-modal-btn" id="create-api-error-modal-close">OK</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modalOverlay);

    // Add close handler
    const closeBtn = document.getElementById('create-api-error-modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modalOverlay.style.display = 'none';
      });
    }
  },

  _showErrorModal(message) {
    const modal = document.getElementById('create-api-error-modal');
    const body = document.getElementById('create-api-error-modal-body');
    if (modal && body) {
      body.textContent = message;
      modal.style.display = 'flex';
    }
  },

  _ensureBackendStrategyModal() {
    if (document.getElementById('backend-strategy-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'backend-strategy-modal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.dataset.bsBackdrop = 'static';
    modal.innerHTML = `
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header py-2 px-3" style="background:var(--apim-gradient);color:white;">
            <h6 class="modal-title mb-0"><i class="bi bi-hdd-network me-1"></i>New Backend Host Detected</h6>
          </div>
          <div class="modal-body py-3 px-3" id="backend-strategy-modal-body" style="font-size:.85rem"></div>
          <div class="modal-footer py-2 px-3">
            <button class="btn btn-sm btn-outline-secondary" id="backend-strategy-cancel">Cancel</button>
            <button class="btn btn-sm btn-outline-primary" id="backend-strategy-standalone">
              <i class="bi bi-hdd me-1"></i>Standalone
            </button>
            <button class="btn btn-sm btn-primary" id="backend-strategy-pool">
              <i class="bi bi-diagram-3 me-1"></i>Convert to Pool
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  /**
   * Rule 3: In add mode, if any new URL's host differs from the existing API's backend host
   * and Rule 1 found no matching backend, prompt the user with Standalone / Pool / Cancel.
   * Resolves with "standalone", "pool", or null (cancel).
   */
  async _promptBackendStrategy(newHost, existingHost, env) {
    this._ensureBackendStrategyModal();
    const modalEl = document.getElementById('backend-strategy-modal');
    const body = document.getElementById('backend-strategy-modal-body');

    body.innerHTML = `
      <p>The new URL has a different host than the existing API's backend:</p>
      <table class="table table-sm table-bordered" style="font-size:.82rem">
        <tr><td class="text-muted">Existing host</td><td><code>${existingHost || '(none)'}</code></td></tr>
        <tr><td class="text-muted">New host</td><td><code>${newHost}</code></td></tr>
      </table>
      <p class="mb-1">How should the new backend be handled?</p>
      <ul style="font-size:.82rem">
        <li><strong>Standalone</strong>: create a separate backend <code>b-&lt;api_id&gt;-2</code>; only the new operations will use it.</li>
        <li><strong>Convert to Pool</strong>: create <code>pool-&lt;api_id&gt;</code> with both backends; all operations switch to the pool.</li>
        <li><strong>Cancel</strong>: abort and go back to the form.</li>
      </ul>`;

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();

    return new Promise((resolve) => {
      const cancelBtn = document.getElementById('backend-strategy-cancel');
      const standaloneBtn = document.getElementById('backend-strategy-standalone');
      const poolBtn = document.getElementById('backend-strategy-pool');

      const cleanup = (result) => {
        modal.hide();
        // Remove old listeners by replacing buttons
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));
        standaloneBtn.replaceWith(standaloneBtn.cloneNode(true));
        poolBtn.replaceWith(poolBtn.cloneNode(true));
        resolve(result);
      };

      cancelBtn.addEventListener('click', () => cleanup(null), { once: true });
      standaloneBtn.addEventListener('click', () => cleanup('standalone'), { once: true });
      poolBtn.addEventListener('click', () => cleanup('pool'), { once: true });
    });
  },

  async _onReview() {
    // Block submission if duplicate errors are showing
    const apiDupError = this._newApiSection?.querySelector('.api-duplicate-warning');
    if (apiDupError) {
      Toast.show('Please resolve duplicate API error before proceeding', 'error');
      return;
    }
    const opDupError = this._existingApiSection?.querySelector('.operation-duplicate-warning');
    if (opDupError) {
      Toast.show('Please resolve duplicate operation error before proceeding', 'error');
      return;
    }

    const payload = this._collectPayload();

    const err = this._validate(payload);
    if (err) {
      Toast.show(err, 'error');
      return;
    }

    // Rule 3: In add mode, pre-flight check each new URL's host against existing backend
    if (payload.mode === 'add' && payload.existing_api_id) {
      try {
        // Fetch the existing API's backend host from its policy
        let existingBackendHost = null;
        try {
          const apiPolicyData = await API.get(
            `/api/apis/${payload.existing_api_id}/policies/policy`,
            { env: payload.env }
          );
          const apiPolicyXml = apiPolicyData?.raw || apiPolicyData?.properties?.value || '';
          const backendMatch = apiPolicyXml.match(/backend-id=["']([^"']+)["']/);
          if (backendMatch) {
            const backendId = backendMatch[1];
            const backendData = await API.get(`/api/backends/${backendId}`, { env: payload.env });
            const backendUrl = backendData?.properties?.url || '';
            try { existingBackendHost = new URL(backendUrl).hostname.toLowerCase(); } catch (_) {}
          }
        } catch (_) {}

        // Check each unique host in the new URLs
        const newHosts = new Set();
        (payload.urls || []).forEach(entry => {
          try { newHosts.add(new URL(entry.url).hostname.toLowerCase()); } catch (_) {}
        });

        for (const host of newHosts) {
          // Rule 1: check if an existing backend already matches this host
          const lookupResp = await API.get('/api/backends/lookup', { env: payload.env, host });
          if (lookupResp && lookupResp.match) {
            // Reuse — no strategy prompt needed
            continue;
          }

          // No match found — check if host differs from existing API backend
          if (existingBackendHost && host !== existingBackendHost) {
            // Rule 3: prompt the user
            const strategy = await this._promptBackendStrategy(host, existingBackendHost, payload.env);
            if (strategy === null) {
              // User cancelled
              return;
            }
            payload.backend_strategy = strategy;
            // Only prompt once (first differing host)
            break;
          }
        }
      } catch (e) {
        console.warn('Backend pre-flight check failed, proceeding without strategy prompt:', e);
      }
    }

    const body = document.getElementById('create-api-modal-body');

    // Show loading state if consumer is enabled (need to check for duplicates)
    if (payload.consumer) {
      body.innerHTML = `
        <div class="text-center py-3">
          <div class="spinner-border spinner-border-sm text-primary me-2" role="status"></div>
          <span class="text-muted" style="font-size:.85rem">Checking for duplicates...</span>
        </div>`;

      const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('create-api-modal'));
      modal.show();
    }

    // Check for duplicate consumer products if consumer is enabled
    let consumerDuplicateSection = '';
    if (payload.consumer) {
      const isAddMode = payload.mode === 'add';
      let allProducts = [];
      let hasApiAlready = false;

      try {
        if (isAddMode && payload.existing_api_id) {
          // Add to Existing API mode - check both endpoints
          try {
            const duplicateResp = await API.get('/api/onboard/check-duplicate', {
              env: payload.env,
              consumer_app_id: payload.consumer.app_id,
              consumer_app_name: payload.consumer.app_name,
              consumer_client_id: payload.consumer.client_id,
              api_id: payload.existing_api_id
            });
            if (duplicateResp.exists && duplicateResp.products) {
              hasApiAlready = true;
              allProducts = duplicateResp.products;
            }
          } catch (e) {
            console.warn('Error checking duplicate:', e);
          }

          // Check for all consumer products
          try {
            const consumerResp = await API.get('/api/check-consumer-products', {
              env: payload.env,
              consumer_app_id: payload.consumer.app_id,
              consumer_app_name: payload.consumer.app_name,
              consumer_client_id: payload.consumer.client_id,
              api_id: payload.existing_api_id
            });
            if (consumerResp.exists && consumerResp.products) {
              const existingIds = new Set(allProducts.map(p => p.id));
              consumerResp.products.forEach(product => {
                if (!existingIds.has(product.id)) {
                  allProducts.push(product);
                }
              });
            }
          } catch (e) {
            console.warn('Error checking consumer products:', e);
          }
        } else {
          // Create New API mode - only check consumer products
          try {
            const resp = await API.get('/api/check-consumer-products', {
              env: payload.env,
              consumer_app_id: payload.consumer.app_id,
              consumer_app_name: payload.consumer.app_name,
              consumer_client_id: payload.consumer.client_id
            });
            if (resp.exists && resp.products) {
              allProducts = resp.products;
            }
          } catch (e) {
            console.warn('Error checking consumer products:', e);
          }
        }

        if (allProducts.length > 0) {
          let productsListHtml = `
            <div class="mt-2">
              <div class="fw-semibold mb-1" style="font-size:.75rem">Existing Products:</div>
              <ul class="mb-0" style="font-size:.75rem; padding-left: 1.2rem;">
                ${allProducts.map(p => `<li><code>${p.name || p.id}</code></li>`).join('')}
              </ul>
            </div>`;

          let productSelectorHtml = `
            <div class="mb-2 ms-4" id="consumerProductSelector">
              <label class="form-label mb-1" style="font-size:.75rem">Select Product:</label>
              <select class="form-select form-select-sm" id="consumerProductDropdown">
                ${allProducts.map(p => `<option value="${p.id}">${p.name || p.id}</option>`).join('')}
              </select>
            </div>`;

          consumerDuplicateSection = `
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
                <input class="form-check-input" type="radio" name="consumerStrategy" id="consumerAddToExisting" value="add_to_existing" checked>
                <label class="form-check-label" for="consumerAddToExisting" style="font-size:.85rem">
                  <i class="bi bi-plus-circle text-success me-1"></i>
                  <strong>Add to existing product</strong> <span class="badge bg-success" style="font-size:.65rem">Recommended</span>
                  <br><small class="text-muted ms-3">Add API to existing product (use existing subscription)</small>
                </label>
              </div>
              ${productSelectorHtml}
              <div class="form-check">
                <input class="form-check-input" type="radio" name="consumerStrategy" id="consumerCreateNew" value="create_new">
                <label class="form-check-label" for="consumerCreateNew" style="font-size:.85rem">
                  <i class="bi bi-exclamation-triangle text-warning me-1"></i>
                  <strong>Create new product</strong>
                  <br><small class="text-muted ms-3">Create a separate product with new subscription</small>
                </label>
              </div>
            </div>`;

          // Update payload to reflect the default selection (Add to existing product)
          payload.consumer.onboard_strategy = 'add_to_existing';
          payload.consumer.existing_product_id = allProducts[0].id;
        }
      } catch (e) {
        console.error('Error checking consumer duplicates:', e);
      }
    }

    // Now populate modal summary

    // Count unique domains for backend type
    const domains = new Set();
    payload.urls.forEach(e => { try { domains.add(new URL(e.url).hostname); } catch {} });
    const backendType = domains.size <= 1 ? 'Single Backend' : `Pool Backend (${domains.size} domains)`;

    // Build backend config details
    let backendConfigRows = '';
    if (domains.size > 1 && payload.backend_config.enable_lb) {
      const backendConfigsObj = payload.backend_config.backend_configs || {};
      const backendsList = Object.entries(backendConfigsObj)
        .map(([host, cfg]) => `${host} (P:${cfg.priority}, W:${cfg.weight})`)
        .join(', ');
      backendConfigRows += `<tr><td class="text-muted fw-semibold">Load Balancer</td><td><span class="badge bg-success">${payload.backend_config.lb_algorithm}</span><br><small class="text-muted">${backendsList || 'Default configs'}</small></td></tr>`;
    }
    if (payload.backend_config.enable_circuit_breaker) {
      const cb = payload.backend_config.circuit_breaker;
      backendConfigRows += `<tr><td class="text-muted fw-semibold">Circuit Breaker</td><td><span class="badge bg-warning text-dark">Enabled</span><br><small class="text-muted">Failures: ${cb.failure_count}, Window: ${cb.interval_seconds}s, Trip: ${cb.trip_duration_seconds}s</small></td></tr>`;
    }

    body.innerHTML = `
      ${consumerDuplicateSection}
      <table class="table table-sm mb-0 table-borderless">
        <tr><td class="text-muted fw-semibold" style="white-space:nowrap">API Name</td><td class="fw-semibold">${payload.name}</td></tr>
        <tr><td class="text-muted fw-semibold">Environment</td><td><span class="badge bg-primary">${payload.env}</span></td></tr>
        <tr><td class="text-muted fw-semibold">Backend</td><td><span class="badge bg-info text-dark">${backendType}</span></td></tr>
        ${backendConfigRows}
        <tr><td class="text-muted fw-semibold">Operations</td><td>${payload.urls.length}</td></tr>
        <tr><td class="text-muted fw-semibold">JWT Audience</td><td><code style="font-size:.75rem">${payload.jwt_audience}</code></td></tr>
        <tr><td class="text-muted fw-semibold">Rate Limit</td><td>${payload.rate_limit_calls} / 60s</td></tr>
        <tr><td class="text-muted fw-semibold">Daily Quota</td><td>${payload.quota_calls} / 86400s</td></tr>
        ${payload.consumer ? `
          <tr><td class="text-muted fw-semibold">Consumer</td><td>${payload.consumer.app_name} (App ID: ${payload.consumer.app_id})</td></tr>
          <tr><td class="text-muted fw-semibold">Consumer Name</td><td><code style="font-size:.7rem">${payload.consumer.client_id}</code></td></tr>
          ${!consumerDuplicateSection ? `<tr><td class="text-muted fw-semibold">Product Strategy</td><td><span class="badge bg-success">Create New</span></td></tr>` : ''}
        ` : ''}
      </table>`;

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('create-api-modal'));
    if (!payload.consumer) {
      // Only show modal here if consumer is not enabled (otherwise already shown with loading state)
      modal.show();
    }

    // Add event listeners for consumer strategy radio buttons to toggle dropdown visibility
    if (consumerDuplicateSection) {
      const addToExistingRadio = document.getElementById('consumerAddToExisting');
      const createNewRadio = document.getElementById('consumerCreateNew');
      const productSelector = document.getElementById('consumerProductSelector');

      if (addToExistingRadio && createNewRadio && productSelector) {
        createNewRadio.addEventListener('change', () => {
          productSelector.style.display = 'none';
        });

        addToExistingRadio.addEventListener('change', () => {
          productSelector.style.display = 'block';
        });
      }
    }

    const confirmBtn = document.getElementById('create-api-confirm-btn');
    const handler = () => {
      // If consumer enabled and strategy options shown, read user's choice
      if (payload.consumer && consumerDuplicateSection) {
        const addToExistingRadio = document.getElementById('consumerAddToExisting');
        const createNewRadio = document.getElementById('consumerCreateNew');
        const productDropdown = document.getElementById('consumerProductDropdown');

        if (addToExistingRadio && addToExistingRadio.checked) {
          payload.consumer.onboard_strategy = 'add_to_existing';
          payload.consumer.existing_product_id = productDropdown ? productDropdown.value : null;
        } else if (createNewRadio && createNewRadio.checked) {
          payload.consumer.onboard_strategy = 'create_new';
          delete payload.consumer.existing_product_id;
        }
      }

      modal.hide();
      this._submit(payload);
    };
    confirmBtn.replaceWith(confirmBtn.cloneNode(true)); // remove old listener
    document.getElementById('create-api-confirm-btn').addEventListener('click', handler, { once: true });
  },

  async _submit(payload) {
    // Switch to progress view
    this._formSection.style.display = 'none';
    const ps = this._progressSection;
    ps.style.display = '';
    ps.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'd-flex align-items-center mb-3';
    heading.innerHTML = '<i class="bi bi-gear-wide-connected me-2 text-primary"></i><span class="fw-bold" style="font-size:.9rem">Creating API...</span>';
    ps.appendChild(heading);

    const pbContainer = document.createElement('div');
    ps.appendChild(pbContainer);
    const totalSteps = payload.consumer ? 6 : 5;
    const pb = ProgressBar.create(pbContainer, totalSteps);

    // If cert auth checkbox is on, upload cert(s) first and inject thumbprint into payload.
    if (this._certAuthToggle && this._certAuthToggle.checked) {
      const certFile = this._clientCertFile && this._clientCertFile.files[0];
      const certPw = (this._clientCertPassword && this._clientCertPassword.value) || '';
      if (!certFile) {
        ps.style.display = 'none';
        this._formSection.style.display = '';
        Toast.show('Please select a client cert file or uncheck cert auth.', 'error');
        return;
      }
      const apiName = payload.name || payload.existing_api_id || 'api';
      const env = payload.env;
      const fd = new FormData();
      fd.append('file', certFile);
      fd.append('password', certPw);
      fd.append('env', env);
      fd.append('suggested_id', `${apiName}-client-cert`);
      try {
        pb.update(0, 'Uploading client certificate...', 'running');
        const r = await fetch(`${API.baseUrl}/api/certificates/upload`, { method: 'POST', body: fd });
        const j = await r.json();
        if (!j.ok) {
          ps.style.display = 'none';
          this._formSection.style.display = '';
          Toast.show('Cert upload failed: ' + (j.error || 'unknown'), 'error');
          return;
        }
        payload.backend_cert_thumbprint = j.thumbprint;
        console.log('[CreateAPI] Cert uploaded:', j.cert_id, 'thumbprint:', j.thumbprint, 'reused:', j.reused);
      } catch (e) {
        ps.style.display = 'none';
        this._formSection.style.display = '';
        Toast.show('Cert upload error: ' + e.message, 'error');
        return;
      }

      // Optional CA cert upload
      if (this._caToggle && this._caToggle.checked) {
        const caFile = this._caCertFile && this._caCertFile.files[0];
        const caPw = (this._caCertPassword && this._caCertPassword.value) || '';
        const caStore = (this._caCertStore && this._caCertStore.value) || 'Root';
        if (caFile) {
          const fdca = new FormData();
          fdca.append('file', caFile);
          fdca.append('password', caPw);
          fdca.append('env', env);
          fdca.append('suggested_id', `${apiName}-ca-cert`);
          fdca.append('store_name', caStore);
          try {
            pb.update(0, 'Uploading CA certificate...', 'running');
            const rca = await fetch(`${API.baseUrl}/api/ca-certificates/upload`, { method: 'POST', body: fdca });
            const jca = await rca.json();
            if (!jca.ok) {
              ps.style.display = 'none';
              this._formSection.style.display = '';
              Toast.show('CA cert upload failed: ' + (jca.error || 'unknown'), 'error');
              return;
            }
            console.log('[CreateAPI] CA cert uploaded:', jca.cert_id, 'reused:', jca.reused);
          } catch (e) {
            ps.style.display = 'none';
            this._formSection.style.display = '';
            Toast.show('CA cert upload error: ' + e.message, 'error');
            return;
          }
        }
      }
    }

    API.postSSE('/api/apis/create', payload, {
      onStep(event) {
        console.log('SSE Event:', event);
        // Skip metadata events (like request_id) that don't have a message
        if (!event.message) return;
        pb.update(event.step, event.message, event.status || 'running');
      },
      onDone: (event) => {
        pb.complete('All steps completed');
        this._showSuccess(ps, payload, event);
      },
      onError: (msg) => {
        // Show duplicate errors in modal (like Smart Assistant)
        if (msg && (msg.includes('already exist') || msg.toLowerCase().includes('duplicate'))) {
          this._showErrorModal(msg);
          // Hide progress section and show form
          ps.style.display = 'none';
          this._formSection.style.display = '';
        } else {
          // Show other errors in progress bar + toast
          pb.error(msg || 'An error occurred.');
          Toast.show(msg || 'Creation failed', 'error');
          const retryBtn = document.createElement('button');
          retryBtn.className = 'btn btn-sm btn-outline-secondary mt-3';
          retryBtn.innerHTML = '<i class="bi bi-arrow-left me-1"></i>Back to Form';
          retryBtn.addEventListener('click', () => {
            ps.style.display = 'none';
            this._formSection.style.display = '';
          });
          ps.appendChild(retryBtn);
        }
      },
      invalidate: [{ prefix: '/api/apis', params: { env: payload.env } }],
    });
  },

  _showSuccess(ps, payload, event) {
    const successCard = document.createElement('div');
    successCard.className = 'card mt-3';

    const header = document.createElement('div');
    header.className = 'card-gradient-header';
    header.innerHTML = '<i class="bi bi-check-circle me-1"></i>API Created Successfully';
    successCard.appendChild(header);

    const body = document.createElement('div');
    body.className = 'card-body';

    const summaryTable = document.createElement('table');
    summaryTable.className = 'table table-sm table-borderless mb-0';
    summaryTable.innerHTML = `
      <tr><td class="text-muted" style="white-space:nowrap">API Name</td><td class="fw-semibold">${payload.name}</td></tr>
      <tr><td class="text-muted">Environment</td><td><span class="badge bg-primary">${payload.env}</span></td></tr>
      <tr><td class="text-muted">Operations</td><td>${payload.urls.length}</td></tr>`;
    body.appendChild(summaryTable);

    // Consumer keys if present
    if (payload.consumer && event.summary?.keys) {
      const keySection = document.createElement('div');
      keySection.className = 'mt-2 p-2 border rounded';
      keySection.style.background = '#f9fafb';

      const productName = event.summary.product_name || (payload.consumer ? payload.consumer.app_name : 'Product');
      const subName = event.summary.subscription_name || 'Subscription';
      const keyTitle = document.createElement('div');
      keyTitle.className = 'fw-semibold mb-2';
      keyTitle.style.fontSize = '.8rem';
      keyTitle.innerHTML = `<i class="bi bi-key me-1 text-warning"></i>Subscription Keys: ${productName} / ${subName}`;
      keySection.appendChild(keyTitle);

      const keyData = event.summary.keys;
      [
        { label: 'Primary', value: keyData.primaryKey },
        { label: 'Secondary', value: keyData.secondaryKey }
      ].forEach(k => {
        const keyRow = document.createElement('div');
        keyRow.className = 'd-flex align-items-center gap-1 mb-1';
        const lbl = document.createElement('span');
        lbl.className = 'text-muted';
        lbl.style.fontSize = '.75rem';
        lbl.style.minWidth = '50px';
        lbl.textContent = k.label || 'Key';

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

    // "Create Another" button
    const anotherBtn = document.createElement('button');
    anotherBtn.className = 'btn btn-sm btn-outline-primary mt-3 w-100';
    anotherBtn.innerHTML = '<i class="bi bi-plus me-1"></i>Create Another API';
    anotherBtn.addEventListener('click', () => {
      ps.style.display = 'none';
      this._buildForm();
      this._formSection.style.display = '';
    });
    ps.appendChild(anotherBtn);

    Toast.show(`API "${payload.name}" created successfully`, 'success');
  },

  async _loadExistingApis() {
    // Load existing APIs for the current environment
    this._existingApiSelect.innerHTML = '<option value="">Loading...</option>';
    this._existingApiSelect.disabled = true;

    try {
      const apis = await API.get('/api/apis', { env: this.currentEnv });

      if (!apis || apis.length === 0) {
        this._existingApiSelect.innerHTML = '<option value="">No APIs found in this environment</option>';
        return;
      }

      // Populate dropdown with existing APIs
      this._existingApiSelect.innerHTML = '<option value="">Select an API...</option>';
      apis.forEach(api => {
        if (api.versions && api.versions.length > 0) {
          // API has multiple versions - create optgroup
          const optgroup = document.createElement('optgroup');
          optgroup.label = api.displayName;

          api.versions.forEach(version => {
            const option = document.createElement('option');
            option.value = version.id;
            option.textContent = version.versionName || 'Original';
            option.dataset.apiData = JSON.stringify(version);
            optgroup.appendChild(option);
          });

          this._existingApiSelect.appendChild(optgroup);
        } else {
          // Single API, no versions
          const option = document.createElement('option');
          option.value = api.id;
          option.textContent = api.displayName;
          option.dataset.apiData = JSON.stringify(api);
          this._existingApiSelect.appendChild(option);
        }
      });
      this._existingApiSelect.disabled = false;

    } catch (err) {
      this._existingApiSelect.innerHTML = '<option value="">Failed to load APIs</option>';
      Toast.show(`Failed to load APIs: ${err.message}`, 'error');
    }
  },

  async _onExistingApiSelected() {
    const apiId = this._existingApiSelect.value;

    if (!apiId) {
      // No API selected, reset to default message
      if (this._backendConfigInfo) {
        this._backendConfigInfo.innerHTML = '<i class="bi bi-info-circle me-1"></i>Select an existing API to see backend options.';
        this._backendConfigInfo.className = 'alert alert-info py-2 px-3 mb-2';
      }
      // Hide radio choice container
      if (this._backendChoiceContainer) {
        this._backendChoiceContainer.style.display = 'none';
      }
      // Hide LB section
      if (this._lbSection) {
        this._lbSection.style.display = 'none';
      }
      // Hide revision info
      if (this._revisionInfo) {
        this._revisionInfo.style.display = 'none';
      }
      return;
    }

    // Get selected API data to show revision info
    const selectedOption = this._existingApiSelect.options[this._existingApiSelect.selectedIndex];
    if (selectedOption && selectedOption.dataset.apiData) {
      const apiData = JSON.parse(selectedOption.dataset.apiData);
      const currentRev = apiData.revision || '1';

      // Fetch all revisions to get the max revision number
      try {
        const revisionsData = await API.get(`/api/apis/${apiId}/revisions`, { env: this.currentEnv });
        const maxRev = revisionsData?.maxRevision || parseInt(currentRev);
        const nextRev = maxRev + 1;
        const totalRevisions = revisionsData?.revisions?.length || 1;

        this._revisionInfo.innerHTML = `
          <i class="bi bi-git me-1"></i>
          <strong>Current Revision:</strong> <code>Rev ${currentRev}</code>
          <span class="mx-2">|</span>
          <strong>Total Revisions:</strong> <code>${totalRevisions}</code>
          <span class="mx-2">→</span>
          <strong>New operations will be created in:</strong> <code>Rev ${nextRev}</code> (will be set as current)
        `;
        this._revisionInfo.style.display = 'block';
      } catch (error) {
        // Fallback to old logic if API call fails
        console.warn('Failed to fetch revisions, using fallback logic:', error);
        const nextRev = parseInt(currentRev) + 1;
        this._revisionInfo.innerHTML = `
          <i class="bi bi-git me-1"></i>
          <strong>Current Revision:</strong> <code>Rev ${currentRev}</code>
          <span class="mx-2">→</span>
          <strong>New operations will be created in:</strong> <code>Rev ${nextRev}</code> (will be set as current)
        `;
        this._revisionInfo.style.display = 'block';
      }
    }

    // Clear previous backend configuration UI
    if (this._backendChoiceContainer) {
      this._backendChoiceContainer.innerHTML = '';
      this._backendChoiceContainer.style.display = 'none';
    }
    if (this._lbSection) {
      this._lbSection.style.display = 'none';
    }

    // Show loading state
    if (this._backendConfigInfo) {
      this._backendConfigInfo.innerHTML = '<i class="bi bi-hourglass-split me-1"></i>Checking existing backend configuration for API: ' + apiId;
      this._backendConfigInfo.className = 'alert alert-secondary py-2 px-3 mb-2';
    }

    try {
      let apiMappedPools = [];

      // Detect pools mapped to this API by checking operation policies
      try {
        // Get all operations for this API
        const operations = await API.get(`/api/apis/${apiId}/operations`, { env: this.currentEnv });
        const ops = operations?.value || [];

        // Extract unique backend IDs from operation policies
        const poolBackendIds = new Set();

        for (const op of ops) {
          try {
            const opId = op.name;
            const policyData = await API.get(`/api/apis/${apiId}/operations/${opId}/policies/policy`, { env: this.currentEnv });
            const policyXml = policyData?.raw || policyData?.properties?.value || '';

            // Try multiple patterns to extract backend
            // Pattern 1: backend-id="xxx"
            let backendMatch = policyXml.match(/backend-id=["']([^"']+)["']/);

            // Pattern 2: <set-backend-service backend-id="xxx" />
            if (!backendMatch) {
              backendMatch = policyXml.match(/<set-backend-service[^>]*backend-id=["']([^"']+)["']/);
            }

            // Pattern 3: <set-backend-service id="xxx" />
            if (!backendMatch) {
              backendMatch = policyXml.match(/<set-backend-service[^>]*id=["']([^"']+)["']/);
            }

            if (backendMatch) {
              poolBackendIds.add(backendMatch[1]);
            }
          } catch (e) {
            continue;
          }
        }


        // If no backends found in operations, check API-level policy
        if (poolBackendIds.size === 0) {
          try {
            const apiPolicyData = await API.get(`/api/apis/${apiId}/policies/policy`, { env: this.currentEnv });
            const apiPolicyXml = apiPolicyData?.raw || apiPolicyData?.properties?.value || '';


            // Try same patterns on API-level policy
            let backendMatch = apiPolicyXml.match(/backend-id=["']([^"']+)["']/);
            if (!backendMatch) {
              backendMatch = apiPolicyXml.match(/<set-backend-service[^>]*backend-id=["']([^"']+)["']/);
            }
            if (!backendMatch) {
              backendMatch = apiPolicyXml.match(/<set-backend-service[^>]*id=["']([^"']+)["']/);
            }

            if (backendMatch) {
              poolBackendIds.add(backendMatch[1]);
            }
          } catch (e) {
            // Silently continue if API-level policy check fails
          }
        }

        // Fetch details for each backend to check if it's a pool
        const backendDetails = [];
        for (const backendId of poolBackendIds) {
          try {
            const details = await API.get(`/api/backends/${backendId}`, { env: this.currentEnv });
            const backendType = details?.properties?.type;
            const hasPoolProperty = details?.properties?.pool;

            backendDetails.push({
              id: backendId,
              type: backendType || 'Unknown',
              isPool: backendType === 'Pool' || !!hasPoolProperty
            });

            // A backend is considered a pool if:
            // 1. Type is explicitly "Pool", OR
            // 2. It has a "pool" property (load balancer with pool members)
            if (backendType === 'Pool' || hasPoolProperty) {
              const poolMembers = details?.properties?.pool?.services || [];
              const poolInfo = {
                id: backendId,
                name: details?.properties?.title || backendId,
                memberCount: poolMembers.length
              };
              apiMappedPools.push(poolInfo);
            }
          } catch (e) {
            backendDetails.push({
              id: backendId,
              type: 'Error',
              isPool: false,
              error: e.message
            });
          }
        }

        // ADDITIONAL CHECK: Find pools that contain the API's backends as members
        // This handles the case where the API uses a single backend that's part of a pool
        try {
          const allPools = await API.get('/api/backends/pools/list', { env: this.currentEnv });

          // Handle different response formats: {value: [...]}, {pools: [...]}, or direct array
          let pools = [];
          if (Array.isArray(allPools)) {
            pools = allPools;
          } else if (allPools?.value && Array.isArray(allPools.value)) {
            pools = allPools.value;
          } else if (allPools?.pools && Array.isArray(allPools.pools)) {
            pools = allPools.pools;
          }

          const matchedPools = [];
          for (const pool of pools) {
            const poolId = pool.name || pool.id?.split('/').pop();
            const poolMembers = pool.properties?.pool?.services || [];

            // Check if any of the API's backends are members of this pool
            const hasApiBackend = poolMembers.some(member => {
              const memberId = member.id?.split('/').pop();
              return poolBackendIds.has(memberId);
            });

            if (hasApiBackend) {
              // Avoid duplicates
              if (!apiMappedPools.find(p => p.id === poolId)) {
                const poolInfo = {
                  id: poolId,
                  name: pool.properties?.title || poolId,
                  memberCount: poolMembers.length
                };
                apiMappedPools.push(poolInfo);
              }
            }
          }
        } catch (e) {
          // Failed to check pool membership
        }
      } catch (e) {
        // Failed to detect API-mapped pools
      }

      // Count number of backends in NEW URLs
      const newUrlDomains = new Set();
      this._getUrlEntries().forEach(entry => {
        try {
          const url = new URL(entry.url);
          newUrlDomains.add(url.hostname);
        } catch (e) {
          // Invalid URL, skip
        }
      });
      const newBackendCount = newUrlDomains.size;

      // Store current backend count and names to detect changes later
      this._lastBackendCount = newBackendCount;
      this._lastBackends = Array.from(newUrlDomains).sort().join(',');

      // Update UI based on number of new backends and available pools
      const hasMultipleBackends = newBackendCount > 1;
      const hasApiPools = apiMappedPools.length > 0;

      // Build pool dropdown if API has pools
      let poolDropdownHtml = '';
      if (hasApiPools) {
        poolDropdownHtml = `
          <select class="form-select form-select-sm mt-2 ms-3" id="apiPoolSelect" style="font-size:.8rem">
            ${apiMappedPools.map(pool => `
              <option value="${pool.id}">${pool.name || pool.id} (${pool.memberCount} member${pool.memberCount !== 1 ? 's' : ''})</option>
            `).join('')}
          </select>
        `;
      }

      if (hasMultipleBackends) {
        // Scenario 1: Multiple backends in new URLs
        this._backendConfigInfo.innerHTML = `
          <i class="bi bi-hdd-network me-1 text-info"></i>
          <strong>Multiple Backends Detected:</strong> <span class="badge bg-info ms-1">${newBackendCount} backends</span>
        `;
        this._backendConfigInfo.className = 'alert alert-info py-2 px-3 mb-2';

        // Show radio button choices - Multiple backends scenario
        this._backendChoiceContainer.innerHTML = `
          <div class="border rounded p-3" style="background:#f8f9fa">
            <div class="fw-semibold mb-2" style="font-size:.85rem">
              <i class="bi bi-diagram-3 me-1 text-primary"></i>Backend Strategy
            </div>
            ${hasApiPools ? `
              <div class="form-check mb-2">
                <input class="form-check-input" type="radio" name="backendStrategy" id="addToExistingPool" value="addToExisting" checked>
                <label class="form-check-label" for="addToExistingPool" style="font-size:.85rem">
                  <i class="bi bi-plus-square text-success me-1"></i>
                  <strong>Add to existing pool</strong> <span class="badge bg-success" style="font-size:.65rem">${apiMappedPools.length} available</span>
                  <br><small class="text-muted ms-3">Add new backends to an existing pool for this API</small>
                  ${poolDropdownHtml}
                </label>
              </div>
            ` : ''}
            <div class="form-check mb-2">
              <input class="form-check-input" type="radio" name="backendStrategy" id="createNewPool" value="createNew" ${hasApiPools ? '' : 'checked'}>
              <label class="form-check-label" for="createNewPool" style="font-size:.85rem">
                <i class="bi bi-hdd-network text-primary me-1"></i>
                <strong>Create new LB pool</strong>
                <br><small class="text-muted ms-3">Create a new load balancer pool for these backends</small>
              </label>
            </div>
            <div class="form-check">
              <input class="form-check-input" type="radio" name="backendStrategy" id="keepIndividual" value="keepIndividual">
              <label class="form-check-label" for="keepIndividual" style="font-size:.85rem">
                <i class="bi bi-hdd me-1"></i>
                <strong>Keep as individual backends</strong>
                <br><small class="text-muted ms-3">Each operation references its own backend</small>
              </label>
            </div>
          </div>
        `;
        this._backendChoiceContainer.style.display = 'block';

        // Add event listeners to control LB section visibility
        const addToExistingPoolRadio = document.getElementById('addToExistingPool');
        const createNewPoolRadio = document.getElementById('createNewPool');
        const keepIndividualRadio = document.getElementById('keepIndividual');

        const updateLBSectionVisibility = () => {
          const checkboxContainer = this._enableLBCheckbox.closest('.form-check');

          if (createNewPoolRadio.checked) {
            // Creating new pool - show LB section
            this._lbSection.style.display = 'block';
            this._enableLBCheckbox.checked = true;
            this._enableLBCheckbox.disabled = true;
            if (checkboxContainer) checkboxContainer.style.display = 'none';
            this._lbAlgorithmSection.style.display = 'block';
            if (this._lbBackendsSection) this._lbBackendsSection.style.display = 'block';
          } else if (addToExistingPoolRadio && addToExistingPoolRadio.checked) {
            // Adding to existing pool - hide LB config (pool already configured)
            this._lbSection.style.display = 'none';
            if (checkboxContainer) checkboxContainer.style.display = 'block';
            // Show backend config for new backends priority/weight
            if (this._lbBackendsSection) {
              this._lbBackendsSection.style.display = 'block';
              const title = this._lbBackendsSection.querySelector('.fw-semibold');
              if (title) {
                title.innerHTML = '<i class="bi bi-plus-circle me-1 text-primary"></i>Configure Priority/Weight for NEW Backends';
              }
              this._updateBackendConfigs();
            }
          } else {
            // Keep individual - hide LB section
            this._lbSection.style.display = 'none';
            if (checkboxContainer) checkboxContainer.style.display = 'block';
            if (this._lbBackendsSection) this._lbBackendsSection.style.display = 'none';
          }
        };

        if (addToExistingPoolRadio) addToExistingPoolRadio.addEventListener('change', updateLBSectionVisibility);
        createNewPoolRadio.addEventListener('change', updateLBSectionVisibility);
        keepIndividualRadio.addEventListener('change', updateLBSectionVisibility);

        // Initialize visibility
        updateLBSectionVisibility();
      }
      else if (newBackendCount === 1) {
        // Scenario 2: Single backend in new URLs
        this._backendConfigInfo.innerHTML = `
          <i class="bi bi-hdd me-1 text-info"></i>
          <strong>Single Backend Detected:</strong> <span class="badge bg-info ms-1">1 backend</span>
        `;
        this._backendConfigInfo.className = 'alert alert-info py-2 px-3 mb-2';

        // Show radio button choices - Single backend scenario
        this._backendChoiceContainer.innerHTML = `
          <div class="border rounded p-3" style="background:#f8f9fa">
            <div class="fw-semibold mb-2" style="font-size:.85rem">
              <i class="bi bi-diagram-3 me-1 text-primary"></i>Backend Strategy
            </div>
            ${hasApiPools ? `
              <div class="form-check mb-2">
                <input class="form-check-input" type="radio" name="backendStrategy" id="addToExistingPool" value="addToExisting" checked>
                <label class="form-check-label" for="addToExistingPool" style="font-size:.85rem">
                  <i class="bi bi-plus-square text-success me-1"></i>
                  <strong>Add to existing pool</strong> <span class="badge bg-success" style="font-size:.65rem">${apiMappedPools.length} available</span>
                  <br><small class="text-muted ms-3">Add this backend to an existing pool for this API</small>
                  ${poolDropdownHtml}
                </label>
              </div>
            ` : ''}
            <div class="form-check">
              <input class="form-check-input" type="radio" name="backendStrategy" id="keepIndividual" value="keepIndividual" ${hasApiPools ? '' : 'checked'}>
              <label class="form-check-label" for="keepIndividual" style="font-size:.85rem">
                <i class="bi bi-hdd me-1"></i>
                <strong>Keep as individual backend</strong>
                <br><small class="text-muted ms-3">Reference backend by ID (no pool needed)</small>
              </label>
            </div>
          </div>
        `;
        this._backendChoiceContainer.style.display = 'block';

        // Add event listeners to control LB section visibility
        const addToExistingSingleRadio = document.getElementById('addToExistingPool');
        const keepIndividualSingleRadio = document.getElementById('keepIndividual');

        const updateLBSectionVisibilitySingle = () => {
          const checkboxContainer = this._enableLBCheckbox.closest('.form-check');

          if (addToExistingSingleRadio && addToExistingSingleRadio.checked) {
            // Adding to existing pool - hide LB config
            this._lbSection.style.display = 'none';
            if (checkboxContainer) checkboxContainer.style.display = 'block';
            // Show backend config for new backends
            if (this._lbBackendsSection) {
              this._lbBackendsSection.style.display = 'block';
              const title = this._lbBackendsSection.querySelector('.fw-semibold');
              if (title) {
                title.innerHTML = '<i class="bi bi-plus-circle me-1 text-primary"></i>Configure Priority/Weight for NEW Backends';
              }
              this._updateBackendConfigs();
            }
          } else {
            // Keep individual - hide LB section
            this._lbSection.style.display = 'none';
            if (checkboxContainer) checkboxContainer.style.display = 'block';
            if (this._lbBackendsSection) this._lbBackendsSection.style.display = 'none';
          }
        };

        if (addToExistingSingleRadio) addToExistingSingleRadio.addEventListener('change', updateLBSectionVisibilitySingle);
        keepIndividualSingleRadio.addEventListener('change', updateLBSectionVisibilitySingle);

        // Initialize visibility
        updateLBSectionVisibilitySingle();

      } else {
        // No backend detected
        this._backendConfigInfo.innerHTML = `
          <i class="bi bi-info-circle me-1"></i>
          No backend detected for this API. New backends will be created for new operations.
        `;
        this._backendConfigInfo.className = 'alert alert-info py-2 px-3 mb-2';

        // Hide radio choice container and show standard LB section
        this._backendChoiceContainer.style.display = 'none';
        // LB section visibility will be controlled by _updateBackendBadge as usual
      }
    } catch (err) {
      // Error fetching API details
      this._backendConfigInfo.innerHTML = `
        <i class="bi bi-exclamation-triangle me-1"></i>
        Could not detect backend configuration. New backends will be created.
      `;
      this._backendConfigInfo.className = 'alert alert-warning py-2 px-3 mb-2';
      this._backendChoiceContainer.style.display = 'none';
      console.error('Error checking backend:', err);
    }
  }
};

Router.register('create-api', CreateAPI);
