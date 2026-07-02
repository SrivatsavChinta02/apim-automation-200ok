/**
 * Spec Generator Page — Standalone, zero external dependencies
 */

const SpecGeneratorPage = (() => {
  console.log('[SpecGen] Loaded v1.0.3 - All values removed, generic placeholders only');

  let _endpoints = [];
  let _endpointCounter = 0;
  let _spec = null;     // serialized form (JSON or YAML string) shown in the UI
  let _specObj = null;  // the underlying object — sent as-is to APIM import

  const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
  const STATUS_CODES = {
    '200': 'OK', '201': 'Created', '204': 'No Content',
    '400': 'Bad Request', '401': 'Unauthorized', '403': 'Forbidden',
    '404': 'Not Found', '409': 'Conflict', '422': 'Unprocessable Entity',
    '500': 'Internal Server Error',
  };
  const CONTENT_TYPES = ['application/json', 'application/xml', 'multipart/form-data', 'application/x-www-form-urlencoded', 'text/plain'];
  const DATA_TYPES = ['string', 'integer', 'number', 'boolean', 'array', 'object'];
  const AUTH_SCHEMES = ['none', 'bearerAuth', 'apiKey', 'basicAuth', 'oauth2'];

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function slugify(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function camel(s) {
    return (s || '').replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase());
  }

  function _newEndpoint(overrides = {}) {
    return {
      id: ++_endpointCounter,
      method: 'GET',
      path: '',
      summary: '',
      description: '',
      tags: '',
      auth: 'none',
      pathParams: [],
      queryParams: [],
      requestBody: { enabled: false, contentType: 'application/json', schema: '' },
      responses: [{ statusCode: '200', description: '', contentType: 'application/json', schema: '' }],
      collapsed: false,
      ...overrides,
    };
  }

  async function render(container) {
    _endpoints = [];
    _spec = null;
    _specObj = null;
    container.innerHTML = _buildShell();
    _attachGlobalEvents();
    _renderEndpointList();
    _ensureErrorModal();
  }

  function unload() {}

  function _buildShell() {
    return `
<div class="sg2-root" id="sg2-root">

  <div class="sg2-left" id="sg2-left">

    <div class="sg2-card" id="sg2-info-card">
      <div class="sg2-card-header">
        <i class="bi bi-info-circle me-1"></i>API Info
      </div>
      <div class="sg2-card-body">
        <div class="sg2-row2">
          <div class="sg2-field">
            <label class="sg2-label">API Title <span class="sg2-req">*</span></label>
            <input id="sg2-title" class="sg2-input" placeholder="Enter API title" autocomplete="off" />
          </div>
          <div class="sg2-field">
            <label class="sg2-label">Version</label>
            <input id="sg2-version" class="sg2-input" placeholder="Enter version" autocomplete="off" />
          </div>
        </div>
        <div class="sg2-field mt-2">
          <label class="sg2-label">Description</label>
          <textarea id="sg2-desc" class="sg2-input" rows="2" placeholder="Enter description" autocomplete="off"></textarea>
        </div>
        <div class="sg2-row2 mt-2">
          <div class="sg2-field">
            <label class="sg2-label">Base URL <span class="sg2-req">*</span></label>
            <input id="sg2-baseurl" class="sg2-input" placeholder="Enter base URL" autocomplete="off" />
          </div>
          <div class="sg2-field">
            <label class="sg2-label">Default Auth</label>
            <select id="sg2-default-auth" class="sg2-select">
              ${AUTH_SCHEMES.map(a => `<option value="${a}">${a === 'none' ? 'None' : a}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
    </div>

    <div class="sg2-endpoints-header">
      <span class="sg2-section-title"><i class="bi bi-diagram-3 me-1"></i>Endpoints</span>
      <div class="sg2-endpoint-actions">
        <button class="sg2-btn-sm sg2-btn-secondary" id="sg2-add-endpoint">
          <i class="bi bi-plus me-1"></i>Add Endpoint
        </button>
        <button class="sg2-btn-sm sg2-btn-secondary" id="sg2-import-curl">
          <i class="bi bi-terminal me-1"></i>Import cURL
        </button>
      </div>
    </div>

    <div id="sg2-endpoint-list" style="max-height:600px;overflow-y:auto;padding-right:4px"></div>

    <div class="sg2-generate-bar">
      <div class="sg2-format-row">
        <label class="sg2-label me-2">Output Format:</label>
        <label class="sg2-radio-label"><input type="radio" name="sg2-fmt" value="yaml" checked> YAML</label>
        <label class="sg2-radio-label ms-2"><input type="radio" name="sg2-fmt" value="json"> JSON</label>
      </div>
      <button class="sg2-btn-generate" id="sg2-generate-btn">
        <i class="bi bi-file-earmark-code me-1"></i>Generate Spec
      </button>
      <button class="sg2-btn-sm sg2-btn-primary" id="sg2-create-in-apim">
        <i class="bi bi-cloud-upload me-1"></i>Create in APIM
      </button>
    </div>

  </div>

  <div class="sg2-right" id="sg2-right">
    <div class="sg2-output-header" id="sg2-output-header">
      <span class="sg2-section-title"><i class="bi bi-file-code me-1"></i>OpenAPI Spec</span>
      <div class="sg2-output-actions" id="sg2-output-actions" style="display:none">
        <button class="sg2-btn-sm sg2-btn-secondary" id="sg2-copy-btn">
          <i class="bi bi-clipboard me-1"></i>Copy
        </button>
        <button class="sg2-btn-sm sg2-btn-secondary" id="sg2-download-btn">
          <i class="bi bi-download me-1"></i>Download
        </button>
        <button class="sg2-btn-sm sg2-btn-secondary" id="sg2-validate-btn">
          <i class="bi bi-check-circle me-1"></i>Validate
        </button>
      </div>
    </div>
    <div class="sg2-output-placeholder" id="sg2-placeholder">
      <i class="bi bi-file-earmark-text sg2-ph-icon"></i>
      <div class="sg2-ph-text">Fill in your API details and click <strong>Generate Spec</strong></div>
      <div class="sg2-ph-sub">Your OpenAPI 3.0 spec will appear here</div>
    </div>
    <pre class="sg2-code-block" id="sg2-code-block" style="display:none"><code id="sg2-code"></code></pre>
    <div class="sg2-validation" id="sg2-validation" style="display:none"></div>
  </div>

  <div class="sg2-modal-overlay" id="sg2-curl-modal" style="display:none">
    <div class="sg2-modal">
      <div class="sg2-modal-header">
        <span><i class="bi bi-terminal me-1"></i>Import from cURL</span>
        <button class="sg2-modal-close" id="sg2-curl-close">&times;</button>
      </div>
      <div class="sg2-modal-body">
        <label class="sg2-label">Paste a cURL command:</label>
        <textarea id="sg2-curl-input" class="sg2-input mt-1" rows="5" autocomplete="off"
          placeholder="curl -X POST https://api.example.com/v1/users \
  -H 'Content-Type: application/json' \
  -d '{&quot;name&quot;: &quot;Alice&quot;}'"></textarea>
        <div id="sg2-curl-error" class="sg2-curl-error" style="display:none"></div>
      </div>
      <div class="sg2-modal-footer">
        <button class="sg2-btn-sm sg2-btn-secondary" id="sg2-curl-cancel">Cancel</button>
        <button class="sg2-btn-sm sg2-btn-primary" id="sg2-curl-import">Import</button>
      </div>
    </div>
  </div>

  <div class="sg2-modal-overlay" id="sg2-apim-modal" style="display:none">
    <div class="sg2-modal sg2-modal-wide">
      <div class="sg2-modal-header">
        <span><i class="bi bi-cloud-upload me-1"></i>Create API in APIM</span>
        <button class="sg2-modal-close" id="sg2-apim-close">&times;</button>
      </div>
      <div class="sg2-modal-body">
        <div class="sg2-field">
          <label class="sg2-label">Target Environment <span class="sg2-req">*</span></label>
          <select id="sg2-apim-env" class="sg2-select mt-1">
            <option value="">Select environment...</option>
            <option value="dev">Development (dev)</option>
            <option value="sandbox">Sandbox</option>
            <option value="prod">Production (prod)</option>
            <option value="dr">Disaster Recovery (dr)</option>
          </select>
        </div>
        <div class="sg2-field mt-2">
          <label class="sg2-label">API ID <span class="sg2-req">*</span></label>
          <input id="sg2-apim-id" class="sg2-input mt-1" placeholder="e.g., my-api (lowercase, hyphenated, max 80 chars)" autocomplete="off" />
          <span class="sg2-hint-inline">Lowercase, hyphenated, max 80 characters</span>
        </div>
        <div class="sg2-field mt-2">
          <label class="sg2-label">Base Path</label>
          <input id="sg2-apim-path" class="sg2-input mt-1" placeholder="e.g., v1/users (without leading slash)" autocomplete="off" />
          <span class="sg2-hint-inline">Optional - Path without leading slash</span>
        </div>
        <div id="sg2-apim-error" class="sg2-curl-error" style="display:none"></div>
      </div>
      <div class="sg2-modal-footer">
        <button class="sg2-btn-sm sg2-btn-secondary" id="sg2-apim-cancel">Cancel</button>
        <button class="sg2-btn-sm sg2-btn-primary" id="sg2-apim-submit">Create API</button>
      </div>
    </div>
  </div>

</div>
${_styles()}`;
  }

  function _renderEndpointList() {
    const list = document.getElementById('sg2-endpoint-list');
    if (!list) return;
    list.innerHTML = _endpoints.map(ep => _buildEndpointCard(ep)).join('');
    _attachEndpointEvents();
  }

  function _methodBadgeClass(m) {
    const map = {
      GET: 'sg2-badge-get', POST: 'sg2-badge-post', PUT: 'sg2-badge-put',
      PATCH: 'sg2-badge-patch', DELETE: 'sg2-badge-delete',
      OPTIONS: 'sg2-badge-opt', HEAD: 'sg2-badge-opt',
    };
    return map[m] || 'sg2-badge-get';
  }

  function _buildEndpointCard(ep) {
    return `
<div class="sg2-ep-card" data-id="${ep.id}" id="sg2-ep-${ep.id}">
  <div class="sg2-ep-header">
    <button class="sg2-ep-toggle" data-action="toggle" data-id="${ep.id}">
      <i class="bi bi-chevron-${ep.collapsed ? 'right' : 'down'} sg2-toggle-icon"></i>
    </button>
    <span class="sg2-badge ${_methodBadgeClass(ep.method)}">${ep.method}</span>
    <span class="sg2-ep-path">${esc(ep.path)}</span>
    <span class="sg2-ep-summary">${esc(ep.summary)}</span>
    <div class="ms-auto d-flex gap-1">
      <button class="sg2-ep-action" data-action="duplicate" data-id="${ep.id}" title="Duplicate">
        <i class="bi bi-copy"></i>
      </button>
      <button class="sg2-ep-action sg2-ep-delete" data-action="delete" data-id="${ep.id}" title="Delete">
        <i class="bi bi-trash"></i>
      </button>
    </div>
  </div>

  <div class="sg2-ep-body" id="sg2-ep-body-${ep.id}" style="${ep.collapsed ? 'display:none' : ''}">

    <div class="sg2-row3">
      <div class="sg2-field sg2-field-narrow">
        <label class="sg2-label">Method <span class="sg2-req">*</span></label>
        <select class="sg2-select sg2-ep-field" data-id="${ep.id}" data-field="method">
          ${HTTP_METHODS.map(m => `<option${m === ep.method ? ' selected' : ''}>${m}</option>`).join('')}
        </select>
      </div>
      <div class="sg2-field sg2-field-wide">
        <label class="sg2-label">Path <span class="sg2-req">*</span></label>
        <input class="sg2-input sg2-ep-field" data-id="${ep.id}" data-field="path"
          value="${esc(ep.path)}" placeholder="Enter path" autocomplete="off" />
      </div>
      <div class="sg2-field sg2-field-narrow">
        <label class="sg2-label">Auth Override</label>
        <select class="sg2-select sg2-ep-field" data-id="${ep.id}" data-field="auth">
          <option value="inherit"${ep.auth === 'inherit' ? ' selected' : ''}>Inherit</option>
          ${AUTH_SCHEMES.map(a => `<option value="${a}"${ep.auth === a ? ' selected' : ''}>${a === 'none' ? 'None' : a}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="sg2-row2 mt-2">
      <div class="sg2-field">
        <label class="sg2-label">Summary</label>
        <input class="sg2-input sg2-ep-field" data-id="${ep.id}" data-field="summary"
          value="${esc(ep.summary)}" placeholder="Enter summary" autocomplete="off" />
      </div>
      <div class="sg2-field">
        <label class="sg2-label">Tags <span class="sg2-hint">(comma-separated)</span></label>
        <input class="sg2-input sg2-ep-field" data-id="${ep.id}" data-field="tags"
          value="${esc(ep.tags)}" placeholder="Enter tags" autocomplete="off" />
      </div>
    </div>

    <div class="sg2-sub-section mt-2">
      <div class="sg2-sub-header">
        <span><i class="bi bi-braces me-1"></i>Path Parameters</span>
        <span class="sg2-hint">Auto-detected from {param} in path</span>
      </div>
      <div class="sg2-path-params" id="sg2-pp-${ep.id}">
        ${_buildPathParams(ep)}
      </div>
    </div>

    <div class="sg2-sub-section mt-2">
      <div class="sg2-sub-header">
        <span><i class="bi bi-question-circle me-1"></i>Query Parameters</span>
        <button class="sg2-btn-xs" data-action="add-query" data-id="${ep.id}">
          <i class="bi bi-plus"></i> Add
        </button>
      </div>
      <div id="sg2-qp-${ep.id}">
        ${_buildQueryParams(ep)}
      </div>
    </div>

    <div class="sg2-sub-section mt-2">
      <div class="sg2-sub-header">
        <span><i class="bi bi-body-text me-1"></i>Request Body</span>
        <label class="sg2-toggle-check">
          <input type="checkbox" class="sg2-ep-field" data-id="${ep.id}" data-field="requestBody.enabled"
            ${ep.requestBody.enabled ? 'checked' : ''} />
          Enable
        </label>
      </div>
      <div id="sg2-rb-${ep.id}" style="${ep.requestBody.enabled ? '' : 'display:none'}">
        ${_buildRequestBody(ep)}
      </div>
    </div>

    <div class="sg2-sub-section mt-2">
      <div class="sg2-sub-header">
        <span><i class="bi bi-arrow-return-left me-1"></i>Responses</span>
        <button class="sg2-btn-xs" data-action="add-response" data-id="${ep.id}">
          <i class="bi bi-plus"></i> Add
        </button>
      </div>
      <div id="sg2-resp-${ep.id}">
        ${_buildResponses(ep)}
      </div>
    </div>

  </div>
</div>`;
  }

  function _buildPathParams(ep) {
    const detected = (ep.path.match(/\{([^}]+)\}/g) || []).map(p => p.slice(1, -1));
    if (detected.length === 0) return `<span class="sg2-hint-inline">No path params detected</span>`;
    return detected.map(name => {
      const existing = ep.pathParams.find(p => p.name === name) || {};
      return `<div class="sg2-param-row sg2-path-param-row" data-name="${esc(name)}">
        <span class="sg2-param-name">{${esc(name)}}</span>
        <select class="sg2-select sg2-select-xs sg2-pp-type" data-id="${ep.id}" data-name="${esc(name)}">
          ${DATA_TYPES.slice(0, 4).map(t => `<option${(existing.type || 'string') === t ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <input class="sg2-input sg2-input-xs sg2-pp-desc" data-id="${ep.id}" data-name="${esc(name)}"
          placeholder="Enter description" value="${esc(existing.description || '')}" autocomplete="off" />
      </div>`;
    }).join('');
  }

  function _buildQueryParams(ep) {
    if (!ep.queryParams.length) return `<span class="sg2-hint-inline">No query params</span>`;
    return ep.queryParams.map((qp, i) => `
      <div class="sg2-param-row" data-qi="${i}">
        <input class="sg2-input sg2-input-xs" placeholder="Enter name"
          data-id="${ep.id}" data-qi="${i}" data-qfield="name" value="${esc(qp.name)}" autocomplete="off" />
        <select class="sg2-select sg2-select-xs" data-id="${ep.id}" data-qi="${i}" data-qfield="type">
          ${DATA_TYPES.slice(0, 5).map(t => `<option${qp.type === t ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
        <label class="sg2-check-label">
          <input type="checkbox" data-id="${ep.id}" data-qi="${i}" data-qfield="required"
            ${qp.required ? 'checked' : ''}> Req
        </label>
        <input class="sg2-input sg2-input-sm" placeholder="Enter description"
          data-id="${ep.id}" data-qi="${i}" data-qfield="description" value="${esc(qp.description || '')}" autocomplete="off" />
        <button class="sg2-btn-xs sg2-btn-danger" data-action="del-query" data-id="${ep.id}" data-qi="${i}">
          <i class="bi bi-x"></i>
        </button>
      </div>`).join('');
  }

  function _buildRequestBody(ep) {
    return `
    <div class="sg2-row2" style="padding:8px">
      <div class="sg2-field">
        <label class="sg2-label">Content-Type</label>
        <select class="sg2-select sg2-ep-field" data-id="${ep.id}" data-field="requestBody.contentType">
          ${CONTENT_TYPES.map(ct => `<option${ep.requestBody.contentType === ct ? ' selected' : ''}>${ct}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="sg2-field" style="padding:0 8px 8px">
      <label class="sg2-label">Schema (JSON)</label>
      <textarea class="sg2-input sg2-code-input sg2-ep-field" rows="3"
        data-id="${ep.id}" data-field="requestBody.schema"
        placeholder='{"type":"object","properties":{"name":{"type":"string"}}}'
        autocomplete="off">${esc(ep.requestBody.schema)}</textarea>
    </div>`;
  }

  function _buildResponses(ep) {
    if (!ep.responses.length) return '';
    return ep.responses.map((r, i) => `
      <div class="sg2-resp-row" data-ri="${i}">
        <select class="sg2-select sg2-select-xs" data-id="${ep.id}" data-ri="${i}" data-rfield="statusCode">
          ${Object.keys(STATUS_CODES).map(c => `<option${r.statusCode === c ? ' selected' : ''}>${c}</option>`).join('')}
        </select>
        <input class="sg2-input sg2-input-sm" placeholder="Enter description"
          data-id="${ep.id}" data-ri="${i}" data-rfield="description" value="${esc(r.description)}" autocomplete="off" />
        <select class="sg2-select sg2-select-sm" data-id="${ep.id}" data-ri="${i}" data-rfield="contentType">
          <option value="">no body</option>
          ${CONTENT_TYPES.map(ct => `<option${r.contentType === ct ? ' selected' : ''}>${ct}</option>`).join('')}
        </select>
        <textarea class="sg2-input sg2-code-input sg2-input-schema" rows="2"
          data-id="${ep.id}" data-ri="${i}" data-rfield="schema"
          placeholder='{"type":"array","items":{"$ref":"#/components/schemas/Item"}}'
          autocomplete="off">${esc(r.schema)}</textarea>
        <button class="sg2-btn-xs sg2-btn-danger" data-action="del-response" data-id="${ep.id}" data-ri="${i}">
          <i class="bi bi-x"></i>
        </button>
      </div>`).join('');
  }

  function _attachGlobalEvents() {
    document.getElementById('sg2-generate-btn')?.addEventListener('click', _generate);
    document.getElementById('sg2-copy-btn')?.addEventListener('click', _copy);
    document.getElementById('sg2-download-btn')?.addEventListener('click', _download);
    document.getElementById('sg2-validate-btn')?.addEventListener('click', _validate);
    document.getElementById('sg2-add-endpoint')?.addEventListener('click', () => {
      _endpoints.push(_newEndpoint());
      _renderEndpointList();
    });
    document.getElementById('sg2-import-curl')?.addEventListener('click', () => {
      document.getElementById('sg2-curl-modal').style.display = '';
    });
    document.getElementById('sg2-curl-close')?.addEventListener('click', _closeCurlModal);
    document.getElementById('sg2-curl-cancel')?.addEventListener('click', _closeCurlModal);
    document.getElementById('sg2-curl-import')?.addEventListener('click', _importCurl);

    document.getElementById('sg2-apim-close')?.addEventListener('click', _closeApimModal);
    document.getElementById('sg2-apim-cancel')?.addEventListener('click', _closeApimModal);
    document.getElementById('sg2-apim-submit')?.addEventListener('click', _submitApimImport);

    // Add real-time duplicate check for APIM modal
    document.getElementById('sg2-apim-id')?.addEventListener('blur', () => {
      _checkApimDuplicate();
      _checkOperationDuplicates();
    });
    document.getElementById('sg2-apim-env')?.addEventListener('change', () => {
      _checkApimDuplicate();
      _checkOperationDuplicates();
    });

    // Add validation for API Info fields
    document.getElementById('sg2-title')?.addEventListener('blur', _validateAPIInfo);
    document.getElementById('sg2-baseurl')?.addEventListener('blur', _validateAPIInfo);

    const createBtn = document.getElementById('sg2-create-in-apim');
    if (createBtn) createBtn.addEventListener('click', _onCreateInApim);
  }

  function _onCreateInApim() {
    if (!_specObj) {
      Toast.show('Generate the spec first', 'warning');
      return;
    }

    // Pre-populate the form with defaults
    const titleSlug = slugify(_specObj.info?.title || '');
    document.getElementById('sg2-apim-id').value = titleSlug || 'new-api';
    document.getElementById('sg2-apim-path').value = titleSlug || '';
    document.getElementById('sg2-apim-env').value = '';
    document.getElementById('sg2-apim-error').style.display = 'none';

    // Clear operation duplicate error when opening modal
    const existingOpError = document.querySelector('.sg2-operation-duplicate-error');
    if (existingOpError) existingOpError.remove();

    // Show the modal
    document.getElementById('sg2-apim-modal').style.display = '';

    // Check for duplicates after modal is shown
    setTimeout(() => {
      _checkApimDuplicate();
      _checkOperationDuplicates();
    }, 100);
  }

  function _closeApimModal() {
    document.getElementById('sg2-apim-modal').style.display = 'none';
    document.getElementById('sg2-apim-error').style.display = 'none';
  }

  async function _checkApimDuplicate() {
    const env = document.getElementById('sg2-apim-env').value.trim();
    const errEl = document.getElementById('sg2-apim-error');
    const submitBtn = document.getElementById('sg2-apim-submit');

    // Get the spec title (which will be the display name)
    const specTitle = _specObj?.info?.title?.trim();

    // Only check if both env and spec title are available
    if (!env || !specTitle) {
      errEl.style.display = 'none';
      // Enable submit button when fields are empty
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    try {
      // Get all APIs and check by display name (fuzzy match)
      console.log('[SpecGen] Fetching all APIs for duplicate check', { env, specTitle });

      const allApis = await API.get('/api/apis', { env });

      if (!allApis || !Array.isArray(allApis)) {
        console.warn('[SpecGen] Invalid response from /api/apis', { allApis });
        errEl.style.display = 'none';
        if (submitBtn) submitBtn.disabled = false;
        return;
      }

      console.log('[SpecGen] APIs fetched', { count: allApis.length });

      // Case-insensitive exact display name match
      const specTitleLower = specTitle.toLowerCase().trim();
      const duplicate = allApis.find(api => {
        const displayName = api.displayName || '';
        return displayName.toLowerCase().trim() === specTitleLower;
      });

      if (duplicate) {
        console.log('[SpecGen] Duplicate found', { duplicate });
        errEl.innerHTML = `<i class="bi bi-exclamation-triangle-fill me-1"></i>API with display name '<strong>${duplicate.displayName}</strong>' already exists (API ID: '<strong>${duplicate.id}</strong>'). Please choose a different API title in the spec.`;
        errEl.style.display = '';
        errEl.style.background = '#f8d7da';
        errEl.style.color = '#721c24';
        errEl.style.borderLeft = '3px solid #dc3545';
        // Disable submit button - visually and functionally
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.style.opacity = '0.5';
          submitBtn.style.cursor = 'not-allowed';
          submitBtn.style.pointerEvents = 'none';
        }
      } else {
        console.log('[SpecGen] No duplicate API found');
        errEl.style.display = 'none';
        // Only enable if NO operation duplicates either
        const opError = document.querySelector('.sg2-operation-duplicate-error');
        if (submitBtn && (!opError || opError.style.display === 'none')) {
          submitBtn.disabled = false;
          submitBtn.style.opacity = '';
          submitBtn.style.cursor = '';
          submitBtn.style.pointerEvents = '';
        }
      }
    } catch (err) {
      // For errors, hide error message but don't enable if other errors exist
      console.error('[SpecGen] Duplicate check failed', err);
      errEl.style.display = 'none';
      const opError = document.querySelector('.sg2-operation-duplicate-error');
      if (submitBtn && (!opError || opError.style.display === 'none')) {
        submitBtn.disabled = false;
        submitBtn.style.opacity = '';
        submitBtn.style.cursor = '';
        submitBtn.style.pointerEvents = '';
      }
    }
  }

  async function _checkOperationDuplicates() {
    const env = document.getElementById('sg2-apim-env')?.value?.trim();
    const apiId = document.getElementById('sg2-apim-id')?.value?.trim();
    const submitBtn = document.getElementById('sg2-apim-submit');

    // Clear any existing operation duplicate error
    const existingOpError = document.querySelector('.sg2-operation-duplicate-error');
    if (existingOpError) existingOpError.remove();

    // Only check if env and apiId are provided and we have endpoints
    if (!env || !apiId || !_endpoints || _endpoints.length === 0) {
      // No need to disable button here - let duplicate API check handle it
      return;
    }

    try {
      console.log('[SpecGen] Checking for duplicate operations', { env, apiId, endpointCount: _endpoints.length });

      // Check if the API exists
      const allApis = await API.get('/api/apis', { env });
      const existingApi = allApis?.find(a => a.id === apiId);

      // If API doesn't exist, no duplicates to check
      if (!existingApi) {
        console.log('[SpecGen] API does not exist, no operation duplicates to check');
        return;
      }

      // Fetch existing operations from the API
      const existingOps = await API.get(`/api/apis/${apiId}/operations`, { env });

      if (!existingOps) {
        console.warn('[SpecGen] Invalid response from operations API', { existingOps });
        return;
      }

      // Backend returns {value: [...], count: X} structure (Azure APIM format)
      const operationsList = existingOps.value || [];
      console.log('[SpecGen] Existing operations fetched', { count: operationsList.length });

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

      // Check for duplicates in spec endpoints
      const duplicates = [];
      for (const ep of _endpoints) {
        const method = ep.method?.toUpperCase();
        const path = ep.path;
        if (method && path) {
          const opKey = `${method}:${path}`;
          if (existingOpKeys.has(opKey)) {
            duplicates.push(`${method} ${path}`);
          }
        }
      }

      if (duplicates.length > 0) {
        console.log('[SpecGen] Duplicate operations found', { duplicates });

        const apiDisplayName = existingApi.displayName || apiId;

        // Create error element after the main error div
        const mainErrorDiv = document.getElementById('sg2-apim-error');
        const opError = document.createElement('div');
        opError.className = 'sg2-operation-duplicate-error sg2-curl-error';
        opError.style.display = '';
        opError.style.background = '#f8d7da';
        opError.style.color = '#721c24';
        opError.style.borderLeft = '3px solid #dc3545';
        opError.style.marginTop = '8px';
        opError.innerHTML = `<i class="bi bi-exclamation-triangle-fill me-1"></i>The following operation(s) already exist in API '<strong>${apiDisplayName}</strong>':<br><strong>${duplicates.join(', ')}</strong><br>Please remove these operations from the spec or choose a different API ID.`;

        if (mainErrorDiv && mainErrorDiv.parentElement) {
          mainErrorDiv.parentElement.insertBefore(opError, mainErrorDiv.nextSibling);
        }

        // Disable submit button - visually and functionally
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.style.opacity = '0.5';
          submitBtn.style.cursor = 'not-allowed';
          submitBtn.style.pointerEvents = 'none';
        }
      } else {
        console.log('[SpecGen] No duplicate operations found');
        // Only enable if NO API duplicates either
        const errEl = document.getElementById('sg2-apim-error');
        if (submitBtn && errEl && errEl.style.display === 'none') {
          submitBtn.disabled = false;
          submitBtn.style.opacity = '';
          submitBtn.style.cursor = '';
          submitBtn.style.pointerEvents = '';
        }
      }
    } catch (err) {
      // For errors, silently fail - don't change button state
      console.error('[SpecGen] Operation duplicate check failed', err);
    }
  }

  function _submitApimImport() {
    const env = document.getElementById('sg2-apim-env').value.trim();
    const apiId = document.getElementById('sg2-apim-id').value.trim();
    const path = document.getElementById('sg2-apim-path').value.trim();
    const errEl = document.getElementById('sg2-apim-error');

    // Block submission if duplicate errors are showing
    if (errEl && errEl.style.display !== 'none') {
      return;
    }
    const opError = document.querySelector('.sg2-operation-duplicate-error');
    if (opError && opError.style.display !== 'none') {
      return;
    }

    // Validate inputs
    if (!env) {
      errEl.textContent = 'Please select a target environment';
      errEl.style.display = '';
      return;
    }

    if (!apiId) {
      errEl.textContent = 'API ID is required';
      errEl.style.display = '';
      return;
    }

    if (apiId.length > 80) {
      errEl.textContent = 'API ID must be 80 characters or less';
      errEl.style.display = '';
      return;
    }

    if (!/^[a-z0-9-]+$/.test(apiId)) {
      errEl.textContent = 'API ID must be lowercase letters, numbers, and hyphens only';
      errEl.style.display = '';
      return;
    }

    // Close modal and start import
    _closeApimModal();

    const btn = document.getElementById('sg2-create-in-apim');
    const restoreBtn = ButtonLoader.start(btn, 'Importing...');
    const progressEl = _ensureImportProgressEl();

    API.postSSE('/api/spec/import',
      { env, api_id: apiId, path: path, spec: _specObj },
      {
        onStep: (event) => {
          if (event.message) progressEl.textContent = event.message;
        },
        onDone: (event) => {
          restoreBtn();
          if (event.summary) {
            Toast.show(`API '${event.summary.api_id}' ${event.summary.status} in ${env}`, 'success');
            progressEl.textContent = '';
          }
        },
        onError: (msg) => {
          restoreBtn();
          progressEl.textContent = '';
          // Show duplicate errors in modal (like Smart Assistant and Create tab)
          if (msg && (msg.includes('already exist') || msg.toLowerCase().includes('duplicate'))) {
            _showErrorModal(msg);
          } else {
            Toast.show(`Import failed: ${msg}`, 'danger');
          }
        },
        invalidate: [{ prefix: '/api/apis', params: { env } }],
      });
  }

  function _ensureImportProgressEl() {
    let el = document.getElementById('sg2-import-progress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sg2-import-progress';
      el.style.fontSize = '0.8rem';
      el.style.marginTop = '6px';
      el.style.color = '#666';
      document.querySelector('.sg2-generate-bar')?.appendChild(el);
    }
    return el;
  }

  let _processingAction = false;

  function _attachEndpointEvents() {
    const list = document.getElementById('sg2-endpoint-list');
    if (!list) return;

    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      // Prevent multiple rapid clicks
      if (_processingAction) return;

      const action = btn.dataset.action;
      const id = +btn.dataset.id;
      const ep = _endpoints.find(x => x.id === id);
      if (!ep) return;

      // Stop event propagation
      e.stopPropagation();

      if (action === 'toggle') {
        ep.collapsed = !ep.collapsed;
        _syncEpFromDom(ep);
        _renderEndpointList();
      } else if (action === 'delete') {
        _processingAction = true;
        _endpoints = _endpoints.filter(x => x.id !== id);
        _renderEndpointList();
        setTimeout(() => { _processingAction = false; }, 100);
      } else if (action === 'duplicate') {
        _processingAction = true;
        _syncEpFromDom(ep);
        const clone = JSON.parse(JSON.stringify(ep));
        clone.id = ++_endpointCounter;
        clone.collapsed = false;
        _endpoints.splice(_endpoints.indexOf(ep) + 1, 0, clone);
        _renderEndpointList();
        setTimeout(() => { _processingAction = false; }, 100);
      } else if (action === 'add-query') {
        _processingAction = true;
        _syncEpFromDom(ep);
        ep.queryParams.push({ name: '', type: 'string', required: false, description: '' });
        _renderEndpointList();
        setTimeout(() => { _processingAction = false; }, 100);
      } else if (action === 'del-query') {
        _processingAction = true;
        _syncEpFromDom(ep);
        ep.queryParams.splice(+btn.dataset.qi, 1);
        _renderEndpointList();
        setTimeout(() => { _processingAction = false; }, 100);
      } else if (action === 'add-response') {
        _processingAction = true;
        _syncEpFromDom(ep);
        ep.responses.push({ statusCode: '200', description: 'OK', contentType: 'application/json', schema: '' });
        _renderEndpointList();
        setTimeout(() => { _processingAction = false; }, 100);
      } else if (action === 'del-response') {
        _processingAction = true;
        _syncEpFromDom(ep);
        ep.responses.splice(+btn.dataset.ri, 1);
        _renderEndpointList();
        setTimeout(() => { _processingAction = false; }, 100);
      }
    });

    list.addEventListener('input', (e) => {
      const el = e.target;
      const id = +el.dataset.id;
      const ep = _endpoints.find(x => x.id === id);
      if (!ep) return;

      if (el.dataset.field === 'path') {
        ep.path = el.value;
        const ppEl = document.getElementById(`sg2-pp-${id}`);
        if (ppEl) ppEl.innerHTML = _buildPathParams(ep);
        _bindPathParamEvents(id);
        const pathDisplay = document.querySelector(`#sg2-ep-${id} .sg2-ep-path`);
        if (pathDisplay) pathDisplay.textContent = ep.path;

        // Real-time path validation
        _validatePath(el, ep.path);
        _checkDuplicates(id);
      }
      if (el.dataset.field === 'method') {
        const badge = document.querySelector(`#sg2-ep-${id} .sg2-badge`);
        if (badge) {
          badge.textContent = el.value;
          badge.className = `sg2-badge ${_methodBadgeClass(el.value)}`;
        }
        _checkDuplicates(id);
      }
      if (el.dataset.field === 'summary') {
        const sumEl = document.querySelector(`#sg2-ep-${id} .sg2-ep-summary`);
        if (sumEl) sumEl.textContent = el.value;
      }
      if (el.dataset.field === 'requestBody.enabled') {
        const rbEl = document.getElementById(`sg2-rb-${id}`);
        if (rbEl) rbEl.style.display = el.checked ? '' : 'none';
      }
      if (el.dataset.field === 'requestBody.schema') {
        _validateJSON(el, 'Request Body');
      }
    });

    _endpoints.forEach(ep => _bindPathParamEvents(ep.id));
  }

  function _bindPathParamEvents(epId) {
    const ppEl = document.getElementById(`sg2-pp-${epId}`);
    if (!ppEl) return;
    ppEl.addEventListener('input', (e) => {
      const el = e.target;
      const id = +el.dataset.id;
      const name = el.dataset.name;
      const ep = _endpoints.find(x => x.id === id);
      if (!ep || !name) return;
      let pp = ep.pathParams.find(p => p.name === name);
      if (!pp) { pp = { name, type: 'string', description: '' }; ep.pathParams.push(pp); }
      if (el.classList.contains('sg2-pp-type')) pp.type = el.value;
      if (el.classList.contains('sg2-pp-desc')) pp.description = el.value;
    });
  }

  function _syncEpFromDom(ep) {
    const fields = ['method', 'path', 'summary', 'tags', 'auth',
      'requestBody.enabled', 'requestBody.contentType', 'requestBody.schema'];
    fields.forEach(field => {
      const el = document.querySelector(`[data-id="${ep.id}"][data-field="${field}"]`);
      if (!el) return;
      const keys = field.split('.');
      if (keys.length === 1) {
        ep[field] = el.type === 'checkbox' ? el.checked : el.value;
      } else {
        ep[keys[0]][keys[1]] = el.type === 'checkbox' ? el.checked : el.value;
      }
    });

    ep.queryParams.forEach((qp, i) => {
      ['name', 'type', 'required', 'description'].forEach(f => {
        const el = document.querySelector(`[data-id="${ep.id}"][data-qi="${i}"][data-qfield="${f}"]`);
        if (!el) return;
        qp[f] = el.type === 'checkbox' ? el.checked : el.value;
      });
    });

    ep.responses.forEach((r, i) => {
      ['statusCode', 'description', 'contentType', 'schema'].forEach(f => {
        const el = document.querySelector(`[data-id="${ep.id}"][data-ri="${i}"][data-rfield="${f}"]`);
        if (el) {
          r[f] = el.value;
          // Validate response schema on sync
          if (f === 'schema' && el.value.trim()) {
            _validateJSON(el, `Response ${r.statusCode}`);
          }
        }
      });
    });

    const detected = (ep.path.match(/\{([^}]+)\}/g) || []).map(p => p.slice(1, -1));
    detected.forEach(name => {
      let pp = ep.pathParams.find(p => p.name === name);
      if (!pp) { pp = { name, type: 'string', description: '' }; ep.pathParams.push(pp); }
      const typeEl = document.querySelector(`.sg2-pp-type[data-id="${ep.id}"][data-name="${name}"]`);
      const descEl = document.querySelector(`.sg2-pp-desc[data-id="${ep.id}"][data-name="${name}"]`);
      if (typeEl) pp.type = typeEl.value;
      if (descEl) pp.description = descEl.value;
    });
    ep.pathParams = ep.pathParams.filter(pp => detected.includes(pp.name));
  }

  function _syncAllFromDom() {
    _endpoints.forEach(ep => _syncEpFromDom(ep));
  }

  function _closeCurlModal() {
    document.getElementById('sg2-curl-modal').style.display = 'none';
    document.getElementById('sg2-curl-error').style.display = 'none';
  }

  function _importCurl() {
    const raw = (document.getElementById('sg2-curl-input')?.value || '').trim();
    const errEl = document.getElementById('sg2-curl-error');
    try {
      const ep = _parseCurl(raw);
      _endpoints.push(ep);
      _closeCurlModal();
      _renderEndpointList();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = '';
    }
  }

  function _parseCurl(raw) {
    const cmd = raw.replace(/\\\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const methodMatch = cmd.match(/-X\s+([A-Z]+)/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';
    const urlMatch = cmd.match(/curl\s+(?:[^'"]\S+|'[^']+'|"[^"]+")/i);
    if (!urlMatch) throw new Error('Could not parse URL from cURL command');
    let rawUrl = urlMatch[0].replace(/^curl\s+/i, '').replace(/^['"]|['"]$/g, '');
    rawUrl = rawUrl.replace(/^-[a-zA-Z]+\s+/, '');
    let urlObj;
    try { urlObj = new URL(rawUrl); } catch { throw new Error('Invalid URL: ' + rawUrl); }
    const path = urlObj.pathname || '/';
    const queryParams = [];
    urlObj.searchParams.forEach((v, k) => {
      queryParams.push({ name: k, type: 'string', required: false, description: v });
    });
    const dataMatch = cmd.match(/(?:-d|--data(?:-raw)?)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/);
    let schema = '';
    let rbEnabled = false;
    let contentType = 'application/json';
    if (dataMatch) {
      const body = (dataMatch[1] || dataMatch[2] || dataMatch[3] || '').trim();
      rbEnabled = true;
      try {
        schema = JSON.stringify(_inferSchema(JSON.parse(body)), null, 2);
      } catch { schema = ''; }
    }
    const ctMatch = cmd.match(/-H\s+['"]?[Cc]ontent-[Tt]ype:\s*([^'"&\s]+)/);
    if (ctMatch) contentType = ctMatch[1];
    return _newEndpoint({
      method, path, summary: `${method} ${path}`, queryParams,
      requestBody: { enabled: rbEnabled, contentType, schema },
      responses: [{ statusCode: '200', description: 'OK', contentType: 'application/json', schema: '' }],
    });
  }

  function _inferSchema(obj) {
    if (Array.isArray(obj)) return { type: 'array', items: obj.length ? _inferSchema(obj[0]) : { type: 'object' } };
    if (obj !== null && typeof obj === 'object') {
      const props = {};
      Object.entries(obj).forEach(([k, v]) => { props[k] = _inferSchema(v); });
      return { type: 'object', properties: props };
    }
    if (typeof obj === 'number') return Number.isInteger(obj) ? { type: 'integer' } : { type: 'number' };
    if (typeof obj === 'boolean') return { type: 'boolean' };
    return { type: 'string' };
  }

  function _validatePath(el, path) {
    // Remove any existing error
    const existingError = el.parentElement.querySelector('.sg2-validation-error');
    if (existingError) existingError.remove();
    el.style.borderColor = '';

    // Validate path starts with /
    if (path && !path.startsWith('/')) {
      el.style.borderColor = '#dc3545';
      const errorMsg = document.createElement('div');
      errorMsg.className = 'sg2-validation-error';
      errorMsg.innerHTML = '<i class="bi bi-exclamation-circle me-1"></i>Path must start with /';
      el.parentElement.appendChild(errorMsg);
      return false;
    }

    // Validate path is not empty
    if (!path || path.trim() === '') {
      el.style.borderColor = '#dc3545';
      const errorMsg = document.createElement('div');
      errorMsg.className = 'sg2-validation-error';
      errorMsg.innerHTML = '<i class="bi bi-exclamation-circle me-1"></i>Path is required';
      el.parentElement.appendChild(errorMsg);
      return false;
    }

    return true;
  }

  function _validateJSON(el, fieldName) {
    // Remove any existing error
    const existingError = el.parentElement.querySelector('.sg2-validation-error');
    if (existingError) existingError.remove();
    el.style.borderColor = '';

    const value = el.value.trim();
    if (!value) return true; // Empty is okay

    try {
      JSON.parse(value);
      return true;
    } catch (e) {
      el.style.borderColor = '#dc3545';
      const errorMsg = document.createElement('div');
      errorMsg.className = 'sg2-validation-error';
      errorMsg.innerHTML = `<i class="bi bi-exclamation-circle me-1"></i>Invalid JSON in ${fieldName}: ${e.message}`;
      el.parentElement.appendChild(errorMsg);
      return false;
    }
  }

  function _checkDuplicates(currentId) {
    const current = _endpoints.find(ep => ep.id === currentId);
    if (!current) return;

    // Find duplicates
    const duplicates = _endpoints.filter(ep =>
      ep.id !== currentId &&
      ep.method === current.method &&
      ep.path === current.path
    );

    // Remove existing duplicate warnings
    document.querySelectorAll('.sg2-duplicate-warning').forEach(w => w.remove());

    // Show warning if duplicates exist
    if (duplicates.length > 0) {
      const headerEl = document.querySelector(`#sg2-ep-${currentId} .sg2-ep-header`);
      if (headerEl) {
        const warning = document.createElement('span');
        warning.className = 'sg2-duplicate-warning';
        warning.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>Duplicate';
        warning.title = `This ${current.method} ${current.path} endpoint is duplicated`;
        headerEl.appendChild(warning);
      }

      // Also mark the other duplicates
      duplicates.forEach(dup => {
        const dupHeaderEl = document.querySelector(`#sg2-ep-${dup.id} .sg2-ep-header`);
        if (dupHeaderEl && !dupHeaderEl.querySelector('.sg2-duplicate-warning')) {
          const warning = document.createElement('span');
          warning.className = 'sg2-duplicate-warning';
          warning.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>Duplicate';
          warning.title = `This ${dup.method} ${dup.path} endpoint is duplicated`;
          dupHeaderEl.appendChild(warning);
        }
      });
    }
  }

  function _validateAPIInfo() {
    const titleEl = document.getElementById('sg2-title');
    const baseUrlEl = document.getElementById('sg2-baseurl');
    let isValid = true;

    // Validate title
    const existingTitleError = titleEl.parentElement.querySelector('.sg2-validation-error');
    if (existingTitleError) existingTitleError.remove();
    titleEl.style.borderColor = '';

    if (!titleEl.value.trim()) {
      titleEl.style.borderColor = '#dc3545';
      const errorMsg = document.createElement('div');
      errorMsg.className = 'sg2-validation-error';
      errorMsg.innerHTML = '<i class="bi bi-exclamation-circle me-1"></i>API Title is required';
      titleEl.parentElement.appendChild(errorMsg);
      isValid = false;
    }

    // Validate base URL is required
    const existingUrlError = baseUrlEl.parentElement.querySelector('.sg2-validation-error');
    if (existingUrlError) existingUrlError.remove();
    baseUrlEl.style.borderColor = '';

    const urlValue = baseUrlEl.value.trim();
    if (!urlValue) {
      baseUrlEl.style.borderColor = '#dc3545';
      const errorMsg = document.createElement('div');
      errorMsg.className = 'sg2-validation-error';
      errorMsg.innerHTML = '<i class="bi bi-exclamation-circle me-1"></i>Base URL is required';
      baseUrlEl.parentElement.appendChild(errorMsg);
      isValid = false;
    } else if (!urlValue.match(/^https?:\/\/.+/)) {
      baseUrlEl.style.borderColor = '#ffc107';
      const errorMsg = document.createElement('div');
      errorMsg.className = 'sg2-validation-error sg2-validation-warning';
      errorMsg.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>Base URL should start with http:// or https://';
      baseUrlEl.parentElement.appendChild(errorMsg);
    }

    return isValid;
  }

  function _generate() {
    _syncAllFromDom();

    // Validate API info before generating
    if (!_validateAPIInfo()) {
      Toast.show('Please fix validation errors in API Info', 'error');
      return;
    }

    const title = (document.getElementById('sg2-title')?.value || 'My API').trim();
    const version = (document.getElementById('sg2-version')?.value || '1.0.0').trim();
    const desc = (document.getElementById('sg2-desc')?.value || '').trim();
    const baseUrl = (document.getElementById('sg2-baseurl')?.value || 'https://api.example.com/v1').trim();
    const defaultAuth = document.getElementById('sg2-default-auth')?.value || 'none';
    const fmt = document.querySelector('input[name="sg2-fmt"]:checked')?.value || 'yaml';
    const spec = _buildSpec({ title, version, desc, baseUrl, defaultAuth });
    _specObj = spec;
    _spec = fmt === 'json' ? JSON.stringify(spec, null, 2) : _toYaml(spec);
    document.getElementById('sg2-placeholder').style.display = 'none';
    document.getElementById('sg2-validation').style.display = 'none';
    const cb = document.getElementById('sg2-code-block');
    cb.style.display = '';
    document.getElementById('sg2-code').textContent = _spec;
    document.getElementById('sg2-output-actions').style.display = '';
  }

  function _buildSpec({ title, version, desc, baseUrl, defaultAuth }) {
    const spec = {
      openapi: '3.0.3',
      info: { title, version, ...(desc ? { description: desc } : {}) },
      servers: [{ url: baseUrl }],
      paths: {},
    };
    const schemes = _collectSecuritySchemes(defaultAuth);
    if (defaultAuth && defaultAuth !== 'none') spec.security = [{ [defaultAuth]: [] }];
    _endpoints.forEach(ep => {
      const path = ep.path.startsWith('/') ? ep.path : '/' + ep.path;
      if (!spec.paths[path]) spec.paths[path] = {};
      const op = {};
      if (ep.summary) op.summary = ep.summary;
      if (ep.tags) op.tags = ep.tags.split(',').map(t => t.trim()).filter(Boolean);
      const effectiveAuth = ep.auth === 'inherit' ? defaultAuth : ep.auth;
      if (effectiveAuth === 'none') op.security = [];
      else if (effectiveAuth && effectiveAuth !== 'none' && effectiveAuth !== defaultAuth) op.security = [{ [effectiveAuth]: [] }];
      const params = [];
      const detectedPP = (path.match(/\{([^}]+)\}/g) || []).map(p => p.slice(1, -1));
      detectedPP.forEach(name => {
        const pp = ep.pathParams.find(p => p.name === name) || {};
        params.push({ name, in: 'path', required: true, schema: { type: pp.type || 'string' }, ...(pp.description ? { description: pp.description } : {}) });
      });
      ep.queryParams.filter(qp => qp.name).forEach(qp => {
        params.push({ name: qp.name, in: 'query', ...(qp.required ? { required: true } : {}), schema: { type: qp.type || 'string' }, ...(qp.description ? { description: qp.description } : {}) });
      });
      if (params.length) op.parameters = params;
      if (ep.requestBody.enabled) {
        const ct = ep.requestBody.contentType || 'application/json';
        let schema = { type: 'object' };
        if (ep.requestBody.schema.trim()) try { schema = JSON.parse(ep.requestBody.schema); } catch { }
        op.requestBody = { required: true, content: { [ct]: { schema } } };
      }
      op.responses = {};
      (ep.responses.length ? ep.responses : [{ statusCode: '200', description: 'OK', contentType: '', schema: '' }]).forEach(r => {
        const respObj = { description: r.description || STATUS_CODES[r.statusCode] || 'Response' };
        if (r.contentType) {
          let schema = {};
          if (r.schema?.trim()) try { schema = JSON.parse(r.schema); } catch { schema = { type: 'object' }; }
          else schema = { type: 'object' };
          respObj.content = { [r.contentType]: { schema } };
        }
        op.responses[r.statusCode] = respObj;
      });

      // Generate a simple operationId: use summary if available, otherwise use last path segment
      let operationId;
      if (ep.summary && ep.summary.trim()) {
        operationId = camel(slugify(ep.summary));
      } else {
        // Extract last meaningful segment from path (e.g., /users/create -> create, /users/{id} -> users)
        const segments = path.split('/').filter(s => s && !s.startsWith('{'));
        operationId = segments.length > 0 ? camel(segments[segments.length - 1]) : camel(slugify(path));
      }
      op.operationId = operationId || 'operation';

      spec.paths[path][ep.method.toLowerCase()] = op;
    });
    if (Object.keys(schemes).length) spec.components = { securitySchemes: schemes };
    return spec;
  }

  function _collectSecuritySchemes(defaultAuth) {
    const schemes = {};
    const auths = new Set([defaultAuth]);
    _endpoints.forEach(ep => { if (ep.auth !== 'inherit') auths.add(ep.auth); });
    auths.forEach(auth => {
      if (auth === 'none' || !auth) return;
      if (auth === 'bearerAuth') schemes.bearerAuth = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' };
      else if (auth === 'apiKey') schemes.apiKey = { type: 'apiKey', in: 'header', name: 'X-API-Key' };
      else if (auth === 'basicAuth') schemes.basicAuth = { type: 'http', scheme: 'basic' };
      else if (auth === 'oauth2') schemes.oauth2 = { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: '/oauth/authorize', tokenUrl: '/oauth/token', scopes: {} } } };
    });
    return schemes;
  }

  function _toYaml(obj, indent = 0) {
    const pad = '  '.repeat(indent);
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj === 'boolean') return obj ? 'true' : 'false';
    if (typeof obj === 'number') return String(obj);
    if (typeof obj === 'string') return _yamlStr(obj, indent);
    if (Array.isArray(obj)) {
      if (!obj.length) return '[]';
      return obj.map(v => {
        const rendered = _toYaml(v, indent + 1);
        return `${pad}- ${rendered.trimStart()}`;
      }).join('\n');
    }
    if (typeof obj === 'object') {
      const keys = Object.keys(obj);
      if (!keys.length) return '{}';
      return keys.map(k => {
        const v = obj[k];
        const key = /[:\s#{}[\]|>&*!,'"%@`]/.test(k) ? `'${k}'` : k;
        if (v === null || v === undefined) return `${pad}${key}: null`;
        if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) return `${pad}${key}:\n${_toYaml(v, indent + 1)}`;
        if (Array.isArray(v) && v.length > 0) return `${pad}${key}:\n${_toYaml(v, indent + 1)}`;
        return `${pad}${key}: ${_toYaml(v, indent + 1).trimStart()}`;
      }).join('\n');
    }
    return String(obj);
  }

  function _yamlStr(s, indent) {
    if (!s.includes('\n') && !/[:\n#{}[\]|>&*!,'"%@`]/.test(s) && s.trim() === s && s.length < 120) return s;
    if (s.includes('\n')) {
      const pad = '  '.repeat(indent + 1);
      return '|\n' + s.split('\n').map(l => pad + l).join('\n');
    }
    return `'${s.replace(/'/g, "''")}'`;
  }

  function _copy() {
    if (!_spec) return;
    navigator.clipboard.writeText(_spec).then(() => {
      const btn = document.getElementById('sg2-copy-btn');
      if (!btn) return;
      btn.innerHTML = '<i class="bi bi-check2 me-1"></i>Copied!';
      setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard me-1"></i>Copy'; }, 1800);
    });
  }

  function _download() {
    if (!_spec) return;
    const fmt = document.querySelector('input[name="sg2-fmt"]:checked')?.value || 'yaml';
    const title = slugify(document.getElementById('sg2-title')?.value || 'openapi') || 'openapi';
    const blob = new Blob([_spec], { type: 'text/plain' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${title}.${fmt}` });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function _validate() {
    if (!_spec) return;
    const issues = [];
    _endpoints.forEach(ep => {
      if (!ep.path.startsWith('/')) issues.push(`Path "${ep.path}" should start with /`);
      if (!ep.responses.length) issues.push(`${ep.method} ${ep.path} has no responses`);
      ep.responses.forEach(r => {
        if (r.schema) try { JSON.parse(r.schema); } catch { issues.push(`Invalid JSON schema in ${r.statusCode} response of ${ep.method} ${ep.path}`); }
      });
      if (ep.requestBody.enabled && ep.requestBody.schema) {
        try { JSON.parse(ep.requestBody.schema); } catch { issues.push(`Invalid JSON schema in request body of ${ep.method} ${ep.path}`); }
      }
    });
    const valEl = document.getElementById('sg2-validation');
    valEl.style.display = '';
    if (issues.length === 0) {
      valEl.className = 'sg2-validation sg2-val-ok';
      valEl.innerHTML = '<i class="bi bi-check-circle me-1"></i>No issues found — spec looks valid.';
    } else {
      valEl.className = 'sg2-validation sg2-val-err';
      valEl.innerHTML = `<i class="bi bi-exclamation-triangle me-1"></i><strong>${issues.length} issue(s):</strong><ul class="mb-0 mt-1">${issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
    }
  }

  function _styles() {
  return `<style>
.sg2-root{display:flex;flex-direction:column;height:100%;font-size:.83rem;overflow-y:auto;padding:16px;gap:16px}
.sg2-left{width:100%;display:flex;flex-direction:column;gap:10px}
.sg2-right{width:100%;display:flex;flex-direction:column;border:1px solid var(--bs-border-color,#dee2e6);border-radius:8px;padding:12px;background:var(--bs-tertiary-bg,#f8f9fa);min-height:400px}

.sg2-card{border:1px solid var(--bs-border-color,#dee2e6);border-radius:6px;margin-bottom:10px;overflow:hidden}
.sg2-card-header{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--bs-secondary-color,#6c757d);background:var(--bs-tertiary-bg,#f8f9fa);padding:5px 10px;border-bottom:1px solid var(--bs-border-color,#dee2e6)}
.sg2-card-body{padding:8px}

.sg2-section-title{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--bs-secondary-color,#6c757d)}
.sg2-endpoints-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:4px}
.sg2-endpoint-actions{display:flex;gap:4px;flex-wrap:wrap}

/* Responsive form rows */
.sg2-row2{display:grid;grid-template-columns:1fr;gap:6px}
.sg2-row3{display:grid;grid-template-columns:1fr;gap:6px}
.sg2-field{display:flex;flex-direction:column;gap:2px}

.sg2-label{font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.03em;color:var(--bs-secondary-color,#6c757d)}
.sg2-req{color:#dc3545}
.sg2-hint{font-weight:400;text-transform:none}

.sg2-input,.sg2-select{padding:6px 8px;border:1px solid var(--bs-border-color,#dee2e6);border-radius:5px;font-size:.82rem;background:var(--bs-body-bg,#fff);color:var(--bs-body-color,#212529);width:100%;box-sizing:border-box;transition:border-color .15s,box-shadow .15s}
.sg2-input:focus,.sg2-select:focus{outline:none;border-color:#0d6efd;box-shadow:0 0 0 3px rgba(13,110,253,.12)}
.sg2-code-input{font-family:'Cascadia Code','Fira Code','Consolas',monospace;font-size:.74rem;resize:vertical}
.sg2-input-xs{width:80px;padding:4px 6px;font-size:.78rem}
.sg2-input-sm{flex:1;min-width:60px;padding:4px 6px;font-size:.78rem}
.sg2-input-schema{width:100%;margin-top:4px;box-sizing:border-box}
.sg2-select-xs{width:80px;padding:4px 5px;font-size:.78rem}
.sg2-select-sm{width:130px;padding:4px 5px;font-size:.78rem}

.sg2-btn-sm{padding:3px 8px;border-radius:5px;font-size:.76rem;cursor:pointer;border:1px solid;display:inline-flex;align-items:center;white-space:nowrap}
.sg2-btn-secondary{background:var(--bs-body-bg,#fff);border-color:var(--bs-border-color,#dee2e6);color:var(--bs-body-color,#212529)}
.sg2-btn-secondary:hover{background:var(--bs-tertiary-bg,#f8f9fa)}
.sg2-btn-primary{background:#0d6efd;border-color:#0d6efd;color:#fff}
.sg2-btn-primary:hover{background:#0b5ed7}
.sg2-btn-xs{padding:1px 6px;border-radius:4px;font-size:.72rem;cursor:pointer;border:1px solid var(--bs-border-color,#dee2e6);background:var(--bs-body-bg,#fff);color:var(--bs-body-color,#212529)}
.sg2-btn-xs:hover{background:var(--bs-tertiary-bg,#f8f9fa)}
.sg2-btn-danger{border-color:#f5c2c7;color:#842029}
.sg2-btn-danger:hover{background:#f8d7da}

.sg2-ep-card{border:1px solid var(--bs-border-color,#dee2e6);border-radius:8px;margin-bottom:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.05);transition:box-shadow .2s}
.sg2-ep-card:hover{box-shadow:0 2px 6px rgba(0,0,0,.1)}
.sg2-ep-header{display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--bs-tertiary-bg,#f8f9fa);border-bottom:1px solid var(--bs-border-color,#dee2e6);min-width:0;flex-wrap:wrap}
.sg2-ep-toggle{background:none;border:none;cursor:pointer;padding:2px 4px;color:var(--bs-secondary-color,#6c757d);font-size:.85rem;flex-shrink:0;transition:transform .2s}
.sg2-ep-toggle:hover{transform:scale(1.1)}
.sg2-ep-path{font-family:'Cascadia Code','Consolas',monospace;font-size:.78rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.sg2-ep-summary{font-size:.76rem;color:var(--bs-secondary-color,#6c757d);margin-left:4px;flex-shrink:0}
.sg2-ep-action{background:none;border:none;cursor:pointer;padding:3px 6px;border-radius:4px;font-size:.82rem;color:var(--bs-secondary-color,#6c757d);flex-shrink:0;transition:all .15s}
.sg2-ep-action:hover{background:var(--bs-border-color,#dee2e6);transform:scale(1.05)}
.sg2-ep-delete:hover{background:#f8d7da;color:#842029}
.sg2-ep-body{padding:10px}

.sg2-badge{font-size:.65rem;font-weight:700;padding:1px 5px;border-radius:4px;text-transform:uppercase;flex-shrink:0}
.sg2-badge-get{background:#cfe2ff;color:#0a3780}
.sg2-badge-post{background:#d1e7dd;color:#0a3622}
.sg2-badge-put{background:#fff3cd;color:#664d03}
.sg2-badge-patch{background:#f8d7da;color:#58151c}
.sg2-badge-delete{background:#f8d7da;color:#58151c}
.sg2-badge-opt{background:#e2e3e5;color:#41464b}

.sg2-sub-section{border:1px solid var(--bs-border-color,#dee2e6);border-radius:5px;overflow:hidden}
.sg2-sub-header{display:flex;align-items:center;justify-content:space-between;padding:3px 8px;background:var(--bs-tertiary-bg,#f8f9fa);border-bottom:1px solid var(--bs-border-color,#dee2e6);font-size:.68rem;font-weight:600;color:var(--bs-secondary-color,#6c757d);text-transform:uppercase;letter-spacing:.03em}
.sg2-hint-inline{font-size:.72rem;color:var(--bs-secondary-color,#6c757d);padding:4px 8px;display:block;font-weight:400;text-transform:none}

.sg2-param-row{display:flex;align-items:center;gap:4px;padding:4px 8px;border-bottom:1px solid var(--bs-border-color,#dee2e6);flex-wrap:wrap}
.sg2-param-row:last-child{border-bottom:none}
.sg2-param-name{font-family:monospace;font-size:.74rem;font-weight:600;color:#0a3780;min-width:50px}
.sg2-resp-row{display:flex;flex-wrap:wrap;align-items:flex-start;gap:4px;padding:5px 8px;border-bottom:1px solid var(--bs-border-color,#dee2e6)}
.sg2-resp-row:last-child{border-bottom:none}
.sg2-check-label{display:flex;align-items:center;gap:3px;font-size:.74rem;white-space:nowrap}
.sg2-toggle-check{display:flex;align-items:center;gap:4px;font-size:.74rem;cursor:pointer}

/* Generate bar - clean, not sticky */
.sg2-generate-bar{
  background:var(--bs-body-bg,#fff);
  border:1px solid var(--bs-border-color,#dee2e6);
  border-radius:6px;
  padding:12px 14px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  flex-wrap:wrap;
  box-shadow:0 2px 8px rgba(0,0,0,.06);
}
.sg2-format-row{display:flex;align-items:center;font-size:.76rem;gap:8px;flex-wrap:wrap}
.sg2-radio-label{cursor:pointer;font-size:.76rem;display:flex;align-items:center;gap:4px}
.sg2-btn-generate{padding:8px 16px;border:none;border-radius:6px;background:#0d6efd;color:#fff;font-weight:700;font-size:.82rem;cursor:pointer;display:flex;align-items:center;transition:all .2s;white-space:nowrap;box-shadow:0 2px 6px rgba(13,110,253,.3)}
.sg2-btn-generate:hover{background:#0b5ed7;transform:translateY(-1px);box-shadow:0 4px 10px rgba(13,110,253,.4)}

.sg2-output-header{display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;border-bottom:2px solid var(--bs-border-color,#dee2e6);margin-bottom:12px;flex-shrink:0;flex-wrap:wrap;gap:8px}
.sg2-output-actions{display:flex;gap:6px;flex-wrap:wrap}
.sg2-output-placeholder{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--bs-secondary-color,#6c757d);gap:10px;padding:40px 20px;min-height:300px}
.sg2-ph-icon{font-size:3rem;opacity:.3}
.sg2-ph-text{font-size:.88rem;font-weight:500}
.sg2-ph-sub{font-size:.78rem;opacity:.65}
.sg2-code-block{flex:1;overflow:auto;margin:0;padding:12px;border-radius:6px;background:#2d2d2d;color:#f8f8f2;border:1px solid var(--bs-border-color,#dee2e6);font-size:.74rem;line-height:1.6;font-family:'Cascadia Code','Fira Code','Consolas',monospace;min-height:300px;max-height:600px}
.sg2-validation{flex-shrink:0;margin-top:10px;padding:10px 14px;border-radius:6px;font-size:.8rem}
.sg2-val-ok{background:#d1e7dd;color:#0a3622;border:1px solid #a3cfbb}
.sg2-val-err{background:#f8d7da;color:#58151c;border:1px solid #f5c2c7}

.sg2-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9999;display:flex;align-items:center;justify-content:center}
.sg2-modal{background:var(--bs-body-bg,#fff);border-radius:8px;width:min(380px,90vw);box-shadow:0 8px 32px rgba(0,0,0,.18);overflow:hidden}
.sg2-modal-wide{width:min(480px,90vw)}
.sg2-modal-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bs-tertiary-bg,#f8f9fa);border-bottom:1px solid var(--bs-border-color,#dee2e6);font-weight:700;font-size:.82rem}
.sg2-modal-close{background:none;border:none;cursor:pointer;font-size:1.1rem;line-height:1;color:var(--bs-secondary-color,#6c757d)}
.sg2-modal-body{padding:12px}
.sg2-modal-footer{display:flex;justify-content:flex-end;gap:6px;padding:10px 14px;border-top:1px solid var(--bs-border-color,#dee2e6)}
.sg2-curl-error{margin-top:6px;padding:6px 10px;background:#f8d7da;color:#842029;border-radius:5px;font-size:.76rem}

.mt-1{margin-top:4px!important}.mt-2{margin-top:8px!important}.mt-3{margin-top:12px!important}
.ms-2{margin-left:8px!important}.me-1{margin-right:4px!important}.me-2{margin-right:8px!important}
.ms-auto{margin-left:auto!important}.d-flex{display:flex!important}.gap-1{gap:4px!important}
.mb-0{margin-bottom:0!important}

/* Validation error styles */
.sg2-validation-error{font-size:.72rem;color:#dc3545;margin-top:2px;display:flex;align-items:center;gap:2px}
.sg2-validation-warning{color:#ffc107!important}
.sg2-duplicate-warning{font-size:.65rem;color:#ffc107;margin-left:8px;padding:1px 6px;background:#fff3cd;border-radius:3px;display:inline-flex;align-items:center;gap:2px}

/* Scrollbar styling */
#sg2-endpoint-list::-webkit-scrollbar{width:6px}
#sg2-endpoint-list::-webkit-scrollbar-track{background:transparent;border-radius:3px}
#sg2-endpoint-list::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:3px}
#sg2-endpoint-list::-webkit-scrollbar-thumb:hover{background:#94a3b8}

/* Responsive improvements */
@media (min-width:768px){
  .sg2-row2{grid-template-columns:1fr 1fr}
  .sg2-row3{grid-template-columns:auto 1fr auto}
}
</style>`;
}

  function _ensureErrorModal() {
    if (document.getElementById('spec-gen-error-modal')) return;
    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'spec-gen-error-modal';
    modalOverlay.className = 'assistant-modal-overlay';
    modalOverlay.style.display = 'none';
    modalOverlay.innerHTML = `
      <div class="assistant-modal-container">
        <div class="assistant-modal-content">
          <div class="assistant-modal-header">
            <i class="bi bi-exclamation-triangle-fill me-2" style="color:#dc3545"></i>
            <span>Unable to Process Request</span>
          </div>
          <div class="assistant-modal-body" id="spec-gen-error-modal-body"></div>
          <div class="assistant-modal-footer">
            <button class="assistant-modal-btn" id="spec-gen-error-modal-close">OK</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modalOverlay);

    // Add close handler
    const closeBtn = document.getElementById('spec-gen-error-modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modalOverlay.style.display = 'none';
      });
    }
  }

  function _showErrorModal(message) {
    const modal = document.getElementById('spec-gen-error-modal');
    const body = document.getElementById('spec-gen-error-modal-body');
    if (modal && body) {
      body.textContent = message;
      modal.style.display = 'flex';
    }
  }

  return { render, unload };

})();

Router.register('spec-generator', SpecGeneratorPage);