const Promote = {
  srcEnv: 'dev',
  destEnv: 'prod',
  selectedApi: null,
  _lastDiff: null,
  _promoteSessionId: null,

  async render(container) {
    this.srcEnv = 'dev';
    this.destEnv = 'prod';
    this.selectedApi = null;
    this._lastDiff = null;

    // Pick up assistant prefill (cleared after one read)
    // Translates assistant-prefill params into the promote-* sessionStorage keys
    // that _checkSessionStorage() already reads below.
    const _prefillRaw = sessionStorage.getItem('assistant-prefill');
    if (_prefillRaw) {
      sessionStorage.removeItem('assistant-prefill');
      try {
        const _prefill = JSON.parse(_prefillRaw);
        if (_prefill && _prefill.page === 'promote' && _prefill.params) {
          const p = _prefill.params;
          if (p.apiId) sessionStorage.setItem('promote-api-id', p.apiId);
          if (p.src) sessionStorage.setItem('promote-src-env', p.src);
          if (p.apiName) sessionStorage.setItem('promote-api-name', p.apiName);
          if (p.apiPath) sessionStorage.setItem('promote-api-path', p.apiPath);
          if (p.apiRevision) sessionStorage.setItem('promote-api-revision', p.apiRevision);
          // dest env is handled by _checkSessionStorage via destEnv assignment below if needed
          if (p.dest) { this.destEnv = p.dest; }
        }
      } catch (e) { /* ignore malformed prefill */ }
    }

    const wrap = document.createElement('div');
    wrap.className = 'p-2';

    const title = document.createElement('div');
    title.className = 'd-flex align-items-center mb-3';
    title.innerHTML = '<i class="bi bi-send me-2 text-primary"></i><span class="fw-bold" style="font-size:.95rem">Promote API</span>';
    wrap.appendChild(title);

    this._formSection = document.createElement('div');
    wrap.appendChild(this._formSection);

    this._progressSection = document.createElement('div');
    this._progressSection.style.display = 'none';
    wrap.appendChild(this._progressSection);

    container.appendChild(wrap);
    this._buildForm();
    this._ensureModal();
    this._checkSessionStorage();
  },

  _buildForm() {
    const f = this._formSection;
    f.innerHTML = '';
    f.appendChild(this._buildSourceCard());
    f.appendChild(this._buildDestCard());
    this._apiSelectionCard = this._buildApiSelectionCard();
    f.appendChild(this._apiSelectionCard);
    f.appendChild(this._buildPreviewCard());

    const btnRow = document.createElement('div');
    btnRow.className = 'd-flex justify-content-end mt-3 mb-3';
    const promoteBtn = document.createElement('button');
    promoteBtn.id = 'promote-submit-btn';
    promoteBtn.className = 'btn btn-sm btn-success';
    promoteBtn.innerHTML = '<i class="bi bi-send me-1"></i>Review & Promote';
    promoteBtn.addEventListener('click', () => this._onReview());
    btnRow.appendChild(promoteBtn);
    f.appendChild(btnRow);
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

  _buildSourceCard() {
    const { card, body } = this._card('bi-box-arrow-right', 'Source Environment');
    const label = document.createElement('div');
    label.className = 'text-muted mb-2';
    label.style.fontSize = '.8rem';
    label.textContent = 'Promote from:';
    body.appendChild(label);
    const tabContainer = document.createElement('div');
    body.appendChild(tabContainer);
    this._srcTabsNav = EnvTabs.render(tabContainer, this.srcEnv, env => {
      this.srcEnv = env;
      this._resetApiSelection();
      if (this.srcEnv === this.destEnv) {
        const envOrder = ['dev', 'sandbox', 'prod', 'dr'];
        const nextIdx = (envOrder.indexOf(this.srcEnv) + 1) % envOrder.length;
        this.destEnv = envOrder[nextIdx];
      }
      this._refreshDestTabs();
      // Rebuild dropdown so it loads APIs from the new source env
      if (this._apiSelectionCard) {
        const newCard = this._buildApiSelectionCard();
        this._apiSelectionCard.replaceWith(newCard);
        this._apiSelectionCard = newCard;
      }
    });
    return card;
  },

  _buildDestCard() {
    const { card, body } = this._card('bi-box-arrow-in-right', 'Destination Environment');
    const label = document.createElement('div');
    label.className = 'text-muted mb-2';
    label.style.fontSize = '.8rem';
    label.textContent = 'Promote to:';
    body.appendChild(label);
    this._destTabContainer = document.createElement('div');
    body.appendChild(this._destTabContainer);
    this._renderDestTabs();
    return card;
  },

  _renderDestTabs() {
    this._destTabContainer.innerHTML = '';
    this._destTabsNav = EnvTabs.render(this._destTabContainer, this.destEnv, env => {
      this.destEnv = env;
      if (this.srcEnv === this.destEnv) {
        Toast.show('Source and destination cannot be the same environment.', 'warning');
        this.destEnv = this.srcEnv === 'prod' ? 'dev' : 'prod';
        this._refreshDestTabs();
        return;
      }
      // Re-load preview if API already selected
      if (this.selectedApi) this._loadPreview();
    });
  },

  _refreshDestTabs() {
    this._renderDestTabs();
  },

  _buildApiSelectionCard() {
    const { card, body } = this._card('bi-search', 'Select API');
    const hint = document.createElement('div');
    hint.className = 'text-muted mb-2';
    hint.style.fontSize = '.8rem';
    hint.textContent = 'Search APIs from source environment:';
    body.appendChild(hint);

    const onApiSelect = (item) => {
      const api = item.api || item;
      if (api.versions && api.versions.length > 0) {
        this._showVersionPicker(api, (chosenVersion) => {
          const resolved = {
            ...api,
            id: chosenVersion.id,
            path: chosenVersion.path,
            revision: chosenVersion.revision,
            versionName: chosenVersion.versionName,
            versions: [],
          };
          this.selectedApi = resolved;
          this._showApiCard(resolved);
          this._loadPreview();
        });
      } else {
        this.selectedApi = api;
        this._showApiCard(api);
        this._loadPreview();
      }
    };

    // Custom scrollable dropdown — fetches fresh list for correct env
    const dropWrapper = document.createElement('div');
    dropWrapper.className = 'position-relative mb-2';
    const dropBtn = document.createElement('button');
    dropBtn.type = 'button';
    dropBtn.className = 'form-select form-select-sm text-start w-100';
    dropBtn.style.cssText = 'background:white;cursor:pointer;';
    dropBtn.textContent = 'Loading...';
    dropWrapper.appendChild(dropBtn);

    const dropList = document.createElement('div');
    dropList.style.cssText = 'display:none;position:absolute;top:100%;left:0;right:0;max-height:220px;overflow-y:auto;background:white;border:1px solid #ced4da;border-radius:4px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.15);';
    dropWrapper.appendChild(dropList);
    this._dropBtn = dropBtn;
    this._dropList = dropList;

    const _fillDropdown = (apiList) => {
      dropList.innerHTML = '';
      if (!apiList || !apiList.length) { dropBtn.textContent = 'No APIs found'; return; }
      dropBtn.textContent = 'Or select from list...';
      apiList.forEach(api => {
        if (api.versions && api.versions.length > 0) {
          // Group header
          const header = document.createElement('div');
          header.style.cssText = 'padding:4px 10px;font-size:.75rem;font-weight:600;background:#f0f4ff;color:#374151;border-bottom:1px solid #e5e7eb;';
          header.textContent = api.displayName;
          dropList.appendChild(header);
          // Version sub-entries
          api.versions.forEach(v => {
            const vitem = document.createElement('div');
            vitem.style.cssText = 'padding:5px 10px 5px 22px;cursor:pointer;font-size:.82rem;border-bottom:1px solid #f3f4f6;';
            vitem.textContent = v.versionName || 'Original';
            vitem.addEventListener('mouseenter', () => vitem.style.background = '#f0f9ff');
            vitem.addEventListener('mouseleave', () => vitem.style.background = '');
            vitem.addEventListener('click', () => {
              dropBtn.textContent = `${api.displayName} — ${v.versionName || 'Original'}`;
              dropList.style.display = 'none';
              const resolved = { ...api, id: v.id, path: v.path, revision: v.revision,
                versionName: v.versionName || 'Original', versions: [] };
              onApiSelect({ api: resolved });
              if (this._searchCtrl) this._searchCtrl.clear();
            });
            dropList.appendChild(vitem);
          });
        } else {
          const item = document.createElement('div');
          item.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:.82rem;border-bottom:1px solid #f3f4f6;';
          item.textContent = api.displayName;
          item.addEventListener('mouseenter', () => item.style.background = '#f0f9ff');
          item.addEventListener('mouseleave', () => item.style.background = '');
          item.addEventListener('click', () => {
            dropBtn.textContent = api.displayName;
            dropList.style.display = 'none';
            onApiSelect({ api });
            if (this._searchCtrl) this._searchCtrl.clear();
          });
          dropList.appendChild(item);
        }
      });
    };

    // Populate with cache first, then refresh
    const cached = Cache.get('/api/apis', { env: this.srcEnv });
    if (cached && cached.length) _fillDropdown(cached);
    API.get('/api/apis', { env: this.srcEnv }).then(fresh => _fillDropdown(fresh)).catch(() => {
      if (!cached || !cached.length) dropBtn.textContent = 'Or select from list...';
    });

    dropBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropList.style.display = dropList.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { dropList.style.display = 'none'; }, { capture: true });
    body.appendChild(dropWrapper);

    this._searchCtrl = SearchInput.create(body, {
      placeholder: 'Search by name or path...',
      onSearch: (q) => API.searchApis(this.srcEnv, q).then(res => res.map(r => ({ label: r.label, api: r }))),
      onSelect: (item) => {
        onApiSelect(item);
        if (this._dropBtn) this._dropBtn.textContent = 'Or select from list...';
      },
    });

    this._apiCard = document.createElement('div');
    body.appendChild(this._apiCard);
    return card;
  },

  _showApiCard(api) {
    this._apiCard.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'p-2 border rounded mt-2';
    card.style.background = '#f0fdf4';
    card.innerHTML = `
      <div class="d-flex align-items-start justify-content-between">
        <div>
          <div class="fw-semibold" style="font-size:.85rem">${api.displayName}</div>
          <div class="text-muted" style="font-size:.78rem"><code>${api.path}</code></div>
          <div class="mt-1">
            ${api.versionName ? `<span class="badge bg-info text-dark me-1" style="font-size:.7rem">${api.versionName}</span>` : ''}
            <span class="badge bg-secondary" style="font-size:.7rem">Rev ${api.revision}</span>
          </div>
        </div>
        <button class="btn btn-sm btn-outline-danger py-0 px-1" id="clear-api-btn" title="Clear selection">
          <i class="bi bi-x"></i>
        </button>
      </div>`;
    card.querySelector('#clear-api-btn').addEventListener('click', () => this._resetApiSelection());
    this._apiCard.appendChild(card);
  },

  _resetApiSelection() {
    this.selectedApi = null;
    this._lastDiff = null;
    if (this._apiCard) this._apiCard.innerHTML = '';
    if (this._searchCtrl) this._searchCtrl.clear();
    this._clearPreview();
  },

  _showVersionPicker(api, onPick) {
    this._apiCard.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'p-2 border rounded mt-2';
    card.style.background = '#f8fafc';
    const label = document.createElement('div');
    label.className = 'fw-semibold mb-2';
    label.style.fontSize = '.85rem';
    label.textContent = `Select version for "${api.displayName}":`;
    card.appendChild(label);
    api.versions.forEach(v => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-outline-primary me-2 mb-1';
      btn.textContent = v.versionName || 'Original';
      btn.addEventListener('click', () => onPick(v));
      card.appendChild(btn);
    });
    this._apiCard.appendChild(card);
  },

  _buildPreviewCard() {
    const { card, body } = this._card('bi-eye', 'Preview Changes');
    this._previewBody = body;
    this._previewContainer = document.createElement('div');
    body.appendChild(this._previewContainer);
    return card;
  },

  _clearPreview() {
    if (this._previewContainer) this._previewContainer.innerHTML = '';
  },

  async _loadPreview() {
    if (!this.selectedApi) return;

    this._previewContainer.innerHTML = `
      <div class="d-flex align-items-center gap-2 text-muted py-2" style="font-size:.82rem">
        <span class="spinner-border spinner-border-sm"></span> Loading diff...
      </div>`;

    try {
      const diff = await API.get('/api/diff/api', {
        src: this.srcEnv,
        dest: this.destEnv,
        api_id: this.selectedApi.id,
      });
      this._lastDiff = diff;
      this._renderPreview(diff);
    } catch (e) {
      this._previewContainer.innerHTML = `
        <div class="alert alert-danger py-2 px-3 mt-2" style="font-size:.82rem">
          <i class="bi bi-exclamation-circle me-1"></i>${e.message}
        </div>`;
    }
  },

  _renderPreview(diff) {
    const c = this._previewContainer;
    c.innerHTML = '';

    // ── Summary table ──────────────────────────────────────────────
    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'mb-3';
    summaryDiv.innerHTML = `
      <table class="table table-sm table-borderless mb-0" style="font-size:.8rem">
        <tr>
          <td class="text-muted fw-semibold" style="white-space:nowrap">Revisions</td>
          <td>
            <span class="badge bg-secondary me-1">${this.srcEnv}: ${diff.src_revision || '?'}</span>
            <span class="badge ${diff.dest_revision === 'new' ? 'bg-danger' : 'bg-primary'}">${this.destEnv}: ${diff.dest_revision === 'new' ? 'Not in destination' : diff.dest_revision}</span>
          </td>
        </tr>
        <tr>
          <td class="text-muted fw-semibold">Operations</td>
          <td>
            ${diff.ops_added ? `<span class="badge bg-success me-1">+${diff.ops_added} added</span>` : ''}
            ${diff.ops_changed ? `<span class="badge bg-warning text-dark me-1">${diff.ops_changed} removed in dest</span>` : ''}
            ${(!diff.ops_added && !diff.ops_changed) ? '<span class="text-muted">No changes</span>' : ''}
          </td>
        </tr>
        ${diff.backends_count !== undefined ? `<tr><td class="text-muted fw-semibold">Backends</td><td>${diff.backends_count}</td></tr>` : ''}
      </table>`;
    c.appendChild(summaryDiv);

    // ── Operations detail ──────────────────────────────────────────
    const ops = diff.operations || {};
    if ((ops.only_in_src && ops.only_in_src.length) || (ops.only_in_dest && ops.only_in_dest.length)) {
      const opsDiv = document.createElement('div');
      opsDiv.className = 'mb-3';
      const opsLabel = document.createElement('div');
      opsLabel.className = 'fw-semibold mb-1';
      opsLabel.style.fontSize = '.8rem';
      opsLabel.innerHTML = '<i class="bi bi-list-ul me-1 text-muted"></i>Operation Changes';
      opsDiv.appendChild(opsLabel);

      (ops.only_in_src || []).forEach(op => {
        const row = document.createElement('div');
        row.className = 'py-1 px-2 rounded mb-1';
        row.style.cssText = 'background:#d1fae5;font-size:.78rem;';
        row.innerHTML = `<span style="color:#166534">+ ${op.method} <code>${op.urlTemplate}</code> <span class="text-muted">(new)</span></span>`;
        opsDiv.appendChild(row);
      });
      (ops.only_in_dest || []).forEach(op => {
        const row = document.createElement('div');
        row.className = 'py-1 px-2 rounded mb-1';
        row.style.cssText = 'background:#fee2e2;font-size:.78rem;';
        row.innerHTML = `<span style="color:#991b1b">− ${op.method} <code>${op.urlTemplate}</code> <span class="text-muted">(only in dest)</span></span>`;
        opsDiv.appendChild(row);
      });
      c.appendChild(opsDiv);
    }

    // ── API-level policy diff ──────────────────────────────────────
    if (diff.policy_diff && diff.policy_diff.length) {
      const hasChanges = diff.policy_diff.some(l => l.type !== 'context');
      const polSection = document.createElement('div');
      polSection.className = 'mb-3';
      const polLabel = document.createElement('div');
      polLabel.className = 'fw-semibold mb-1 d-flex align-items-center justify-content-between';
      polLabel.style.fontSize = '.8rem';
      polLabel.innerHTML = `
        <span><i class="bi bi-shield-lock me-1 text-muted"></i>API-level Policy</span>
        ${hasChanges ? '<span class="badge bg-warning text-dark">Changed</span>' : '<span class="badge bg-secondary">No changes</span>'}`;
      polSection.appendChild(polLabel);
      if (hasChanges) {
        polSection.appendChild(this._renderDiffLines(diff.policy_diff));
      }
      c.appendChild(polSection);
    } else if (diff.src_policy || diff.dest_policy) {
      const polSection = document.createElement('div');
      polSection.className = 'mb-3';
      polSection.innerHTML = '<div class="fw-semibold mb-1" style="font-size:.8rem"><i class="bi bi-shield-lock me-1 text-muted"></i>API-level Policy <span class="badge bg-secondary">No changes</span></div>';
      c.appendChild(polSection);
    }

    // ── Operation-level policy diffs ───────────────────────────────
    const opDiffs = diff.op_policy_diffs || {};
    const opDiffKeys = Object.keys(opDiffs);
    if (opDiffKeys.length) {
      const opPolSection = document.createElement('div');
      opPolSection.className = 'mb-3';
      const opPolLabel = document.createElement('div');
      opPolLabel.className = 'fw-semibold mb-2';
      opPolLabel.style.fontSize = '.8rem';
      opPolLabel.innerHTML = '<i class="bi bi-shield me-1 text-muted"></i>Operation Policies';
      opPolSection.appendChild(opPolLabel);

      opDiffKeys.forEach(opId => {
        const opDiff = opDiffs[opId];
        const hasChanges = opDiff.diff && opDiff.diff.some(l => l.type !== 'context');
        const opRow = document.createElement('div');
        opRow.className = 'mb-2';
        const opHeader = document.createElement('div');
        opHeader.className = 'py-1 px-2 rounded d-flex align-items-center justify-content-between';
        opHeader.style.cssText = `background:${opDiff.src && !opDiff.dest ? '#d1fae5' : opDiff.dest && !opDiff.src ? '#fee2e2' : '#f3f4f6'};font-size:.78rem;cursor:pointer;`;

        let opLabel = opId;
        if (opDiff.src && !opDiff.dest) opLabel = `+ ${opId} (new policy)`;
        else if (!opDiff.src && opDiff.dest) opLabel = `− ${opId} (policy removed)`;
        else if (hasChanges) opLabel = `~ ${opId} (policy changed)`;
        else opLabel = `${opId} (no changes)`;

        opHeader.innerHTML = `
          <span style="color:${opDiff.src && !opDiff.dest ? '#166534' : !opDiff.src && opDiff.dest ? '#991b1b' : '#374151'}">${opLabel}</span>
          ${hasChanges ? '<i class="bi bi-chevron-down"></i>' : ''}`;

        opRow.appendChild(opHeader);

        if (hasChanges && opDiff.diff) {
          const diffEl = this._renderDiffLines(opDiff.diff);
          diffEl.style.display = 'none';
          opRow.appendChild(diffEl);
          opHeader.addEventListener('click', () => {
            const icon = opHeader.querySelector('i');
            if (diffEl.style.display === 'none') {
              diffEl.style.display = '';
              if (icon) { icon.className = 'bi bi-chevron-up'; }
            } else {
              diffEl.style.display = 'none';
              if (icon) { icon.className = 'bi bi-chevron-down'; }
            }
          });
        }
        opPolSection.appendChild(opRow);
      });
      c.appendChild(opPolSection);
    }

    // ── No changes at all ──────────────────────────────────────────
    const noDiff = !diff.ops_added && !diff.ops_changed &&
      !(diff.policy_diff && diff.policy_diff.some(l => l.type !== 'context')) &&
      !opDiffKeys.some(k => opDiffs[k].diff && opDiffs[k].diff.some(l => l.type !== 'context'));

    if (noDiff && diff.dest_revision !== 'new') {
      const noChange = document.createElement('div');
      noChange.className = 'alert alert-info py-2 px-3 mt-1';
      noChange.style.fontSize = '.82rem';
      noChange.innerHTML = '<i class="bi bi-check-circle me-1"></i>No differences found between source and destination.';
      c.appendChild(noChange);
    }
  },

  _renderDiffLines(diffLines) {
    const wrapper = document.createElement('div');
    DiffViewer.renderFromDiff(wrapper, diffLines,
      `${(this.srcEnv || 'Source').toUpperCase()} (promoting)`,
      `${(this.destEnv || 'Dest').toUpperCase()} (current)`);
    return wrapper;
  },

  _checkSessionStorage() {
    const apiId = sessionStorage.getItem('promote-api-id');
    const srcEnv = sessionStorage.getItem('promote-src-env');
    const apiName = sessionStorage.getItem('promote-api-name');
    const apiPath = sessionStorage.getItem('promote-api-path');
    const apiRev = sessionStorage.getItem('promote-api-revision');

    sessionStorage.removeItem('promote-api-id');
    sessionStorage.removeItem('promote-src-env');
    sessionStorage.removeItem('promote-api-name');
    sessionStorage.removeItem('promote-api-path');
    sessionStorage.removeItem('promote-api-revision');

    if (apiId && srcEnv) {
      this.srcEnv = srcEnv;
      if (this._srcTabsNav) {
        this._srcTabsNav.querySelectorAll('.nav-link').forEach(btn => {
          btn.classList.toggle('active', btn.textContent.toLowerCase() === srcEnv.toLowerCase());
        });
      }
      const syntheticApi = { id: apiId, displayName: apiName || apiId, path: apiPath || '/', revision: apiRev || '?' };
      this.selectedApi = syntheticApi;
      this._showApiCard(syntheticApi);
      this._loadPreview();
    }
  },

  _ensureModal() {
    if (document.getElementById('promote-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'promote-modal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.innerHTML = `
      <div class="modal-dialog modal-lg">
        <div class="modal-content">
          <div class="modal-header py-2 px-3" style="background:var(--apim-gradient);color:white;">
            <h6 class="modal-title mb-0"><i class="bi bi-send me-1"></i>Confirm Promote</h6>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body py-2 px-3" id="promote-modal-body" style="font-size:.82rem;max-height:60vh;overflow-y:auto"></div>
          <div class="modal-footer py-2 px-3">
            <button class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button class="btn btn-sm btn-success" id="promote-confirm-btn">
              <i class="bi bi-send me-1"></i>Promote
            </button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
  },

  _onReview() {
    if (!this.selectedApi) { Toast.show('Please select an API to promote.', 'warning'); return; }
    if (this.srcEnv === this.destEnv) { Toast.show('Source and destination environments cannot be the same.', 'error'); return; }

    const body = document.getElementById('promote-modal-body');
    body.innerHTML = '';

    // API summary
    const summary = document.createElement('div');
    summary.innerHTML = `
      <div class="mb-2 fw-semibold" style="font-size:.85rem">
        <i class="bi bi-arrow-right-circle me-1 text-success"></i>
        Promote <span class="text-primary">${this.selectedApi.displayName}</span>
      </div>
      <table class="table table-sm table-borderless mb-2">
        <tr><td class="text-muted fw-semibold" style="white-space:nowrap">From</td><td><span class="badge bg-secondary">${this.srcEnv}</span></td></tr>
        <tr><td class="text-muted fw-semibold">To</td><td><span class="badge bg-primary">${this.destEnv}</span></td></tr>
        <tr><td class="text-muted fw-semibold">API Path</td><td><code style="font-size:.75rem">${this.selectedApi.path}</code></td></tr>
      </table>
      <div class="alert alert-warning py-1 px-2 mb-2" style="font-size:.78rem">
        <i class="bi bi-exclamation-triangle me-1"></i>A new revision will be created in <strong>${this.destEnv}</strong> and set as current.
      </div>`;
    body.appendChild(summary);

    // Destructive-tier admin password prompt — required when dest != sandbox.
    // The /api/promote/api route enforces this server-side; we surface the
    // input here so the confirm modal collects it before submit.
    if (this.destEnv !== 'sandbox') {
      const pwSection = document.createElement('div');
      pwSection.innerHTML = `
        <div class="border-top pt-2 mt-2" style="font-size:.8rem">
          <div class="fw-semibold mb-1 text-danger">
            <i class="bi bi-shield-lock me-1"></i>Admin password required
          </div>
          <div class="text-muted mb-2" style="font-size:.75rem">
            Promotion to <strong>${this.destEnv}</strong> writes to a protected environment.
            Enter the admin password to continue.
          </div>
          <input type="password" id="promote-admin-password"
                 class="form-control form-control-sm"
                 placeholder="Admin password"
                 autocomplete="off" />
          <div id="promote-admin-password-err" class="text-danger mt-1" style="font-size:.7rem;display:none">
            <i class="bi bi-exclamation-circle me-1"></i>Password required
          </div>
        </div>`;
      body.appendChild(pwSection);
    }

    // Embed the diff in the modal if available
    if (this._lastDiff) {
      const diffSection = document.createElement('div');
      diffSection.innerHTML = '<div class="fw-semibold mb-2" style="font-size:.8rem;border-top:1px solid #e5e7eb;padding-top:8px;margin-top:4px">Changes to be promoted:</div>';
      body.appendChild(diffSection);
      const diffContainer = document.createElement('div');
      body.appendChild(diffContainer);
      // Re-render diff inline in modal
      const savedContainer = this._previewContainer;
      this._previewContainer = diffContainer;
      this._renderPreview(this._lastDiff);
      this._previewContainer = savedContainer;
    }

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('promote-modal'));
    modal.show();

    const oldBtn = document.getElementById('promote-confirm-btn');
    const newBtn = oldBtn.cloneNode(true);
    oldBtn.replaceWith(newBtn);
    newBtn.addEventListener('click', () => {
      // Prevent double submission - if button is already disabled, ignore
      if (newBtn.disabled) return;

      // For non-sandbox destinations, validate the admin password input
      // is non-empty before proceeding. Server-side will verify it.
      let adminPassword = null;
      if (this.destEnv !== 'sandbox') {
        const pwInput = document.getElementById('promote-admin-password');
        const pwErr = document.getElementById('promote-admin-password-err');
        adminPassword = (pwInput && pwInput.value || '').trim();
        if (!adminPassword) {
          if (pwErr) {
            pwErr.style.display = '';
            pwErr.innerHTML = '<i class="bi bi-exclamation-circle me-1"></i>Password required';
          }
          return;  // keep modal open, don't hide / don't submit
        }
        // Clear any previous error
        if (pwErr) pwErr.style.display = 'none';
      }
      // Don't hide modal yet - wait for successful request start
      this._submit(adminPassword, modal);
    });
  },

  _submit(adminPassword, modal) {
    const api = this.selectedApi;
    const src = this.srcEnv;
    const dest = this.destEnv;

    // Disable the promote button to prevent double submission
    const promoteBtn = document.getElementById('promote-confirm-btn');
    if (promoteBtn) {
      promoteBtn.disabled = true;
      promoteBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Validating...';
    }

    let requestStarted = false; // Track if we've received first event (successful auth)

    this._promoteSessionId = null;
    const reqBody = { src, dest, api_id: api.id };
    if (adminPassword) reqBody.admin_password = adminPassword;
    API.postSSE('/api/promote/api', reqBody, {
      onStep: (event) => {
        if (!requestStarted) {
          // First event received - auth was successful, hide modal and show progress
          requestStarted = true;
          modal.hide();
          this._formSection.style.display = 'none';
          const ps = this._progressSection;
          ps.style.display = '';
          ps.innerHTML = '';

          const heading = document.createElement('div');
          heading.className = 'd-flex align-items-center mb-3';
          heading.innerHTML = `<i class="bi bi-send me-2 text-primary"></i><span class="fw-bold" style="font-size:.9rem">Promoting "${api.displayName}"...</span>`;
          ps.appendChild(heading);

          const envRow = document.createElement('div');
          envRow.className = 'd-flex align-items-center gap-2 mb-3';
          envRow.innerHTML = `
            <span class="badge bg-secondary">${src}</span>
            <i class="bi bi-arrow-right text-muted"></i>
            <span class="badge bg-primary">${dest}</span>`;
          ps.appendChild(envRow);

          const pbContainer = document.createElement('div');
          ps.appendChild(pbContainer);
          this._currentProgressBar = ProgressBar.create(pbContainer, 8);
        }
        if (!event.message) return; // Skip metadata events
        if (this._currentProgressBar) {
          this._currentProgressBar.update(event.step, event.message, event.status || 'running');
        }
      },
      onDone: (event) => {
        if (this._currentProgressBar) {
          this._currentProgressBar.complete('Promotion complete');
        }
        this._showSuccess(this._progressSection, api, src, dest);
      },
      onError: (msg, errorCode) => {
        // Check if this is a password error
        if (errorCode === 'admin_password_invalid' || msg === 'Incorrect admin password') {
          // Show error in modal and keep it open
          const pwErr = document.getElementById('promote-admin-password-err');
          if (pwErr) {
            pwErr.style.display = '';
            pwErr.innerHTML = '<i class="bi bi-exclamation-circle me-1"></i>Incorrect admin password. Please try again.';
          }
          // Re-enable the button so user can try again
          if (promoteBtn) {
            promoteBtn.disabled = false;
            promoteBtn.innerHTML = '<i class="bi bi-send me-1"></i>Promote';
          }
          // Clear the password field
          const pwInput = document.getElementById('promote-admin-password');
          if (pwInput) {
            pwInput.value = '';
            pwInput.focus();
          }
          Toast.show('Incorrect admin password', 'error');
          return;
        }

        // For other errors, hide modal and show error in progress section
        if (!requestStarted) {
          modal.hide();
          this._formSection.style.display = 'none';
          const ps = this._progressSection;
          ps.style.display = '';
          ps.innerHTML = '';
        }

        const ps = this._progressSection;
        if (this._currentProgressBar) {
          this._currentProgressBar.error(msg || 'An error occurred during promotion.');
        } else {
          ps.innerHTML = `<div class="alert alert-danger">${msg || 'An error occurred during promotion.'}</div>`;
        }
        Toast.show(msg || 'Promotion failed', 'error');
        const backBtn = document.createElement('button');
        backBtn.className = 'btn btn-sm btn-outline-secondary mt-3';
        backBtn.innerHTML = '<i class="bi bi-arrow-left me-1"></i>Back to Form';
        backBtn.addEventListener('click', () => { ps.style.display = 'none'; this._formSection.style.display = ''; });
        ps.appendChild(backBtn);
      },
      onMissingResource: async (evt) => {
        if (evt._type === 'session') {
          this._promoteSessionId = evt.session_id;
          return;
        }
        // evt._type === 'missing' — show dialog, await user choice, POST resolution
        if (this._currentProgressBar) {
          this._currentProgressBar.update(evt.step, evt.message || 'Backend URL needs prod mapping', 'needs_input');
        }
        const resolution = await this._showMissingResourceDialog(evt);
        await fetch(API.baseUrl + '/api/promote/api/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: evt.session_id || this._promoteSessionId,
            resolution,
          }),
        });
      },
      invalidate: [
        { prefix: '/api/apis', params: { env: dest } },
        { prefix: '/api/diff', params: { src, dest } },
      ],
    });
  },

  _showMissingResourceDialog(evt) {
    return new Promise((resolve) => {
      // Remove any stale dialog
      const stale = document.getElementById('promote-missing-overlay');
      if (stale) stale.remove();

      const overlay = document.createElement('div');
      overlay.id = 'promote-missing-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;';

      const dialog = document.createElement('div');
      dialog.style.cssText = 'background:#fff;border-radius:8px;width:380px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,.25);overflow:hidden;';

      const header = document.createElement('div');
      header.className = 'card-gradient-header';
      header.style.padding = '10px 14px';
      header.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>Backend URL needs prod mapping';
      dialog.appendChild(header);

      const body = document.createElement('div');
      body.style.cssText = 'padding:14px;font-size:.82rem;';
      body.innerHTML = `
        <div class="mb-2 text-muted" style="font-size:.78rem">No automatic transformation rule applies to this hostname. AI Foundry endpoints typically require manual configuration.</div>
        <table class="table table-sm table-borderless mb-2" style="font-size:.78rem">
          <tr><td class="fw-semibold text-muted" style="white-space:nowrap">Backend ID</td><td><code>${evt.backend_id || '—'}</code></td></tr>
          <tr><td class="fw-semibold text-muted">Source URL</td><td><code style="word-break:break-all">${evt.src_url || '—'}</code></td></tr>
        </table>
        <label class="form-label mb-1" style="font-size:.78rem;font-weight:600">Production URL to use:</label>`;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'form-control form-control-sm mb-3';
      input.value = evt.suggestion || evt.src_url || '';
      body.appendChild(input);

      const btnRow = document.createElement('div');
      btnRow.className = 'd-flex gap-2 justify-content-end';

      const abortBtn = document.createElement('button');
      abortBtn.className = 'btn btn-sm btn-outline-danger';
      abortBtn.textContent = 'Abort promotion';
      abortBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'abort' }); });

      const skipBtn = document.createElement('button');
      skipBtn.className = 'btn btn-sm btn-outline-secondary';
      skipBtn.textContent = 'Skip this backend';
      skipBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'skip' }); });

      const useBtn = document.createElement('button');
      useBtn.className = 'btn btn-sm btn-success';
      useBtn.innerHTML = '<i class="bi bi-check me-1"></i>Use this URL';
      useBtn.addEventListener('click', () => { overlay.remove(); resolve({ action: 'use_url', url: input.value.trim() }); });

      btnRow.appendChild(abortBtn);
      btnRow.appendChild(skipBtn);
      btnRow.appendChild(useBtn);
      body.appendChild(btnRow);
      dialog.appendChild(body);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      // Focus the input for immediate editing
      setTimeout(() => input.focus(), 50);
    });
  },

  _showSuccess(ps, api, src, dest) {
    const successCard = document.createElement('div');
    successCard.className = 'card mt-3';
    const header = document.createElement('div');
    header.className = 'card-gradient-header';
    header.innerHTML = '<i class="bi bi-check-circle me-1"></i>Promotion Successful';
    successCard.appendChild(header);
    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = `
      <table class="table table-sm table-borderless mb-0">
        <tr><td class="text-muted fw-semibold" style="white-space:nowrap">API</td><td class="fw-semibold">${api.displayName}</td></tr>
        <tr><td class="text-muted fw-semibold">Path</td><td><code style="font-size:.75rem">${api.path}</code></td></tr>
        <tr><td class="text-muted fw-semibold">From</td><td><span class="badge bg-secondary">${src}</span></td></tr>
        <tr><td class="text-muted fw-semibold">To</td><td><span class="badge bg-primary">${dest}</span></td></tr>
      </table>`;
    successCard.appendChild(body);
    ps.appendChild(successCard);

    const anotherBtn = document.createElement('button');
    anotherBtn.className = 'btn btn-sm btn-outline-primary mt-3 w-100';
    anotherBtn.innerHTML = '<i class="bi bi-send me-1"></i>Promote Another API';
    anotherBtn.addEventListener('click', () => { ps.style.display = 'none'; this._buildForm(); this._formSection.style.display = ''; });
    ps.appendChild(anotherBtn);

    Toast.show(`"${api.displayName}" promoted to ${dest} successfully`, 'success');
  }
};

Router.register('promote', Promote);
