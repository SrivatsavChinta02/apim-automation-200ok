const Settings = {
  authenticated: false,
  sessionTimeout: null,

  async render(container) {
    container.innerHTML = `
      <div class="p-3">
        <div class="card-gradient-header rounded-top px-3 py-2 mb-3">
          <h6 class="mb-0 fw-semibold text-white">
            <i class="bi bi-gear me-2"></i>Settings
          </h6>
        </div>

        <!-- Card 1: Connection Settings -->
        <div class="card mb-3 shadow-sm">
          <div class="card-header fw-semibold small">
            <i class="bi bi-plug me-1"></i> Connection Settings
          </div>
          <div class="card-body">
            <div class="mb-3">
              <label class="form-label small fw-semibold">Backend URL</label>
              <div class="input-group input-group-sm">
                <input type="text" id="settings-backend-url" class="form-control form-control-sm"
                  placeholder="http://localhost:5050" autocomplete="off" />
                <button class="btn btn-sm btn-outline-secondary" id="settings-test-btn" type="button">
                  Test Connection
                </button>
              </div>
              <div id="settings-test-result" class="mt-2 small"></div>
            </div>
          </div>
        </div>

        <!-- Card 2: Azure Credentials (read-only, protected) -->
        <div class="card mb-3 shadow-sm">
          <div class="card-header fw-semibold small">
            <i class="bi bi-shield-lock me-1"></i> Azure Credentials
            <button id="settings-logout-btn" class="btn btn-sm btn-outline-danger float-end d-none" style="padding: 0.1rem 0.4rem; font-size: 0.75rem;">
              <i class="bi bi-box-arrow-right me-1"></i>Logout
            </button>
          </div>
          <div class="card-body">
            <!-- Authentication Required Message -->
            <div id="settings-auth-required" class="text-center py-4">
              <i class="bi bi-shield-lock text-muted" style="font-size: 2.5rem;"></i>
              <p class="text-muted small mt-2 mb-3">Authentication required to view credentials</p>
              <button class="btn btn-sm btn-primary" id="settings-auth-btn">
                <i class="bi bi-key me-1"></i>Authenticate
              </button>
            </div>

            <!-- Loading State -->
            <div id="settings-credentials-loading" class="text-muted small d-none">
              <span class="spinner-border spinner-border-sm me-1"></span> Loading...
            </div>

            <!-- Credentials Content (hidden until authenticated) -->
          <div id="settings-credentials-content" class="d-none">
  <div class="mb-2">
    <label class="form-label small fw-semibold mb-1">Tenant ID (shared)</label>
    <div id="settings-tenant-id" class="form-control form-control-sm bg-light text-muted font-monospace small" style="cursor:default;"></div>
  </div>
  <table class="table table-sm table-bordered small mb-2 mt-2">
    <thead class="table-light">
      <tr>
        <th>Environment</th>
        <th>Client ID</th>
        <th>Secret</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody id="settings-env-creds-tbody"></tbody>
  </table>
  <div class="alert alert-info py-1 px-2 small mb-0">
    <i class="bi bi-info-circle me-1"></i>
    Edit credentials in the backend <code>.env</code> file and restart the server.
  </div>
</div> 
            <div id="settings-credentials-error" class="d-none text-danger small">
              <i class="bi bi-exclamation-triangle me-1"></i>
              Could not load credentials from backend.
            </div>
          </div>
        </div>

        <!-- Card 3: Preferences -->
        <div class="card mb-3 shadow-sm">
          <div class="card-header fw-semibold small">
            <i class="bi bi-sliders me-1"></i> Preferences
          </div>
          <div class="card-body">
            <div class="mb-3">
              <label class="form-label small fw-semibold" for="settings-default-env">Default Environment</label>
              <select id="settings-default-env" class="form-select form-select-sm">
                <option value="dev">Dev</option>
                <option value="sandbox">Sandbox</option>
                <option value="prod">Prod</option>
                <option value="dr">DR</option>
              </select>
            </div>
            <button class="btn btn-sm btn-primary" id="settings-save-prefs-btn">
              <i class="bi bi-check-lg me-1"></i>Save Preferences
            </button>
          </div>
        </div>

        <!-- Card 4: About -->
        <div class="card mb-3 shadow-sm">
          <div class="card-header fw-semibold small">
            <i class="bi bi-info-circle me-1"></i> About
          </div>
          <div class="card-body small">
            <div class="d-flex justify-content-between mb-1">
              <span class="text-muted">Extension Version</span>
              <span class="fw-semibold">1.0.0</span>
            </div>
            <div class="d-flex justify-content-between mb-1">
              <span class="text-muted">Backend Status</span>
              <span id="settings-about-status">
                <span class="spinner-border spinner-border-sm"></span>
              </span>
            </div>
            <div class="d-flex justify-content-between">
              <span class="text-muted">Environments</span>
              <span id="settings-about-envs" class="text-muted">—</span>
            </div>
          </div>
        </div>
      </div>
    `;

    Settings._init(container);
  },

  _init(container) {
    // Restore saved backend URL
    const savedUrl = localStorage.getItem('apim-backend-url') || 'http://localhost:5050';
    const urlInput = container.querySelector('#settings-backend-url');
    urlInput.value = savedUrl;

    // Restore saved default env
    const savedEnv = localStorage.getItem('apim-default-env') || 'dev';
    const envSelect = container.querySelector('#settings-default-env');
    envSelect.value = savedEnv;

    // Wire up Test Connection button
    container.querySelector('#settings-test-btn').addEventListener('click', () => {
      Settings._testConnection(container);
    });

    // Wire up Save Preferences button
    container.querySelector('#settings-save-prefs-btn').addEventListener('click', () => {
      const url = urlInput.value.trim();
      const env = envSelect.value;
      if (url) {
        localStorage.setItem('apim-backend-url', url);
        if (typeof API !== 'undefined' && API.baseUrl !== undefined) {
          API.baseUrl = url;
        }
      }
      localStorage.setItem('apim-default-env', env);
      Toast.show('Preferences saved', 'success');
    });

    // Wire up Authenticate button
    container.querySelector('#settings-auth-btn').addEventListener('click', () => {
      Settings._showAuthModal(container);
    });

    // Wire up Logout button
    container.querySelector('#settings-logout-btn').addEventListener('click', () => {
      Settings._logout(container);
    });

    // Check if already authenticated (session active)
    if (Settings.authenticated) {
      Settings._showCredentials(container);
    }

    // Load About info (always visible)
    Settings._checkHealth(container);
  },

  async _testConnection(container) {
    const btn = container.querySelector('#settings-test-btn');
    const resultEl = container.querySelector('#settings-test-result');
    const urlInput = container.querySelector('#settings-backend-url');

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Testing...';
    resultEl.innerHTML = '';

    try {
      const baseUrl = urlInput.value.trim() || 'http://localhost:5050';
      const resp = await fetch(`${baseUrl}/api/health`);
      if (resp.ok) {
        const data = await resp.json();
        resultEl.innerHTML = `
          <span class="text-success">
            <i class="bi bi-check-circle-fill me-1"></i>
            Connected — environments: ${(data.environments || []).join(', ')}
          </span>`;
      } else {
        resultEl.innerHTML = `
          <span class="text-danger">
            <i class="bi bi-x-circle-fill me-1"></i>
            Backend returned ${resp.status}
          </span>`;
      }
    } catch (err) {
      resultEl.innerHTML = `
        <span class="text-danger">
          <i class="bi bi-x-circle-fill me-1"></i>
          ${err.message}
        </span>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'Test Connection';
    }
  },

  _showAuthModal(container) {
    // Create authentication modal
    const modalHtml = `
      <div class="modal fade" id="settings-auth-modal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered modal-sm">
          <div class="modal-content">
            <div class="modal-header py-2 px-3" style="background:#0d6efd;color:white;">
              <h6 class="modal-title mb-0"><i class="bi bi-shield-lock me-1"></i>Admin Authentication</h6>
            </div>
            <div class="modal-body py-3 px-3">
              <div class="mb-2">
                <label class="form-label small mb-1">Username</label>
                <input type="text" id="settings-auth-username" class="form-control form-control-sm" placeholder="Enter username" autocomplete="off" />
              </div>
              <div class="mb-3">
                <label class="form-label small mb-1">Password</label>
                <input type="password" id="settings-auth-password" class="form-control form-control-sm" placeholder="Enter password" autocomplete="off" />
              </div>
              <div id="settings-auth-error" class="alert alert-danger py-1 px-2 small d-none mb-0">
                <i class="bi bi-exclamation-triangle me-1"></i><span id="settings-auth-error-msg"></span>
              </div>
            </div>
            <div class="modal-footer py-2 px-3">
              <button class="btn btn-sm btn-secondary" data-bs-dismiss="modal">Cancel</button>
              <button class="btn btn-sm btn-primary" id="settings-auth-submit">
                <i class="bi bi-key me-1"></i>Login
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('settings-auth-modal');
    if (existingModal) existingModal.remove();

    // Add modal to document
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modalEl = document.getElementById('settings-auth-modal');
    const modal = new bootstrap.Modal(modalEl);

    // Wire up submit button
    const submitBtn = modalEl.querySelector('#settings-auth-submit');
    const usernameInput = modalEl.querySelector('#settings-auth-username');
    const passwordInput = modalEl.querySelector('#settings-auth-password');
    const errorDiv = modalEl.querySelector('#settings-auth-error');
    const errorMsg = modalEl.querySelector('#settings-auth-error-msg');

    const handleSubmit = async () => {
      const username = usernameInput.value.trim();
      const password = passwordInput.value;

      if (!username || !password) {
        errorMsg.textContent = 'Please enter both username and password';
        errorDiv.classList.remove('d-none');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Authenticating...';
      errorDiv.classList.add('d-none');

      try {
        const result = await Settings._authenticate(username, password);
        if (result.success) {
          Settings.authenticated = true;
          modal.hide();
          Settings._showCredentials(container);
          Settings._startSessionTimeout(container);
          Toast.show('Authentication successful', 'success');
        } else {
          errorMsg.textContent = result.message || 'Invalid credentials';
          errorDiv.classList.remove('d-none');
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="bi bi-key me-1"></i>Login';
        }
      } catch (err) {
        errorMsg.textContent = 'Authentication failed. Please try again.';
        errorDiv.classList.remove('d-none');
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="bi bi-key me-1"></i>Login';
      }
    };

    submitBtn.addEventListener('click', handleSubmit);

    // Submit on Enter key
    passwordInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSubmit();
    });

    // Focus username input when modal shown
    modalEl.addEventListener('shown.bs.modal', () => {
      usernameInput.focus();
    });

    // Clean up modal after hide
    modalEl.addEventListener('hidden.bs.modal', () => {
      modalEl.remove();
    });

    modal.show();
  },

  async _authenticate(username, password) {
    try {
      const response = await API.post('/api/auth/login', { username, password });
      return response;
    } catch (err) {
      return { success: false, message: err.message || 'Authentication failed' };
    }
  },

  _showCredentials(container) {
    // Hide auth required message
    const authRequired = container.querySelector('#settings-auth-required');
    authRequired.classList.add('d-none');

    // Show logout button
    const logoutBtn = container.querySelector('#settings-logout-btn');
    logoutBtn.classList.remove('d-none');

    // Load credentials
    Settings._loadCredentials(container);
  },

  _logout(container) {
    Settings.authenticated = false;

    // Clear session timeout
    if (Settings.sessionTimeout) {
      clearTimeout(Settings.sessionTimeout);
      Settings.sessionTimeout = null;
    }

    // Hide credentials and logout button
    const contentEl = container.querySelector('#settings-credentials-content');
    const loadingEl = container.querySelector('#settings-credentials-loading');
    const errorEl = container.querySelector('#settings-credentials-error');
    const logoutBtn = container.querySelector('#settings-logout-btn');
    const authRequired = container.querySelector('#settings-auth-required');

    contentEl.classList.add('d-none');
    loadingEl.classList.add('d-none');
    errorEl.classList.add('d-none');
    logoutBtn.classList.add('d-none');
    authRequired.classList.remove('d-none');

    Toast.show('Logged out', 'info');
  },

  _startSessionTimeout(container) {
    // Clear existing timeout
    if (Settings.sessionTimeout) {
      clearTimeout(Settings.sessionTimeout);
    }

    // Auto-logout after 15 minutes
    Settings.sessionTimeout = setTimeout(() => {
      Settings._logout(container);
      Toast.show('Session expired. Please login again.', 'warning');
    }, 15 * 60 * 1000); // 15 minutes
  },

  async _loadCredentials(container) {
    const loadingEl = container.querySelector('#settings-credentials-loading');
    const contentEl = container.querySelector('#settings-credentials-content');
    const errorEl = container.querySelector('#settings-credentials-error');

    loadingEl.classList.remove('d-none');

    try {
      const data = await API.get('/api/settings');
      container.querySelector('#settings-tenant-id').textContent = data.tenant_id || '(not set)';
const tbody = container.querySelector('#settings-env-creds-tbody');
const envOrder = ['dev', 'sandbox', 'prod', 'dr'];
const envLabels = { dev: 'Dev', sandbox: 'Sandbox', prod: 'Prod', dr: 'DR' };
envOrder.forEach(env => {
  const cred = (data.env_credentials || {})[env] || {};
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="fw-semibold">${envLabels[env]}</td>
    <td class="font-monospace text-muted" style="font-size:.75rem">${cred.client_id || '(not set)'}</td>
    <td class="font-monospace text-muted" style="font-size:.75rem">${cred.client_secret_hint || '****'}</td>
    <td>${cred.configured
      ? '<span class="badge bg-success">Configured</span>'
      : '<span class="badge bg-danger">Missing</span>'}</td>`;
  tbody.appendChild(tr);
});

      loadingEl.classList.add('d-none');
      contentEl.classList.remove('d-none');
    } catch (err) {
      loadingEl.classList.add('d-none');
      errorEl.classList.remove('d-none');
    }
  },

  async _checkHealth(container) {
    const statusEl = container.querySelector('#settings-about-status');
    const envsEl = container.querySelector('#settings-about-envs');

    try {
      const data = await API.get('/api/health');
      statusEl.innerHTML = '<span class="text-success"><i class="bi bi-circle-fill me-1"></i>Connected</span>';
      envsEl.textContent = (data.environments || []).join(', ');
    } catch (err) {
      statusEl.innerHTML = '<span class="text-danger"><i class="bi bi-circle-fill me-1"></i>Disconnected</span>';
      envsEl.textContent = '—';
    }
  },
};

Router.register('settings', Settings);
