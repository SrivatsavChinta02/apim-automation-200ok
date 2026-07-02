const Diff = {
  currentMode: 'instance',
  srcEnv: 'dev',
  destEnv: 'prod',
  selectedApi: null,
  _searchCtrl: null,

  async render(container) {
    this.currentMode = 'instance';
    this.srcEnv = 'dev';
    this.destEnv = 'prod';
    this.selectedApi = null;
    this._searchCtrl = null;

    const wrap = document.createElement('div');
    wrap.className = 'p-2';

    const title = document.createElement('div');
    title.className = 'd-flex align-items-center mb-2';
    title.innerHTML = '<i class="bi bi-arrow-left-right me-2 text-primary"></i><span class="fw-bold" style="font-size:.95rem">Diff &amp; Compare</span>';
    wrap.appendChild(title);

    const modeRow = document.createElement('div');
    modeRow.className = 'd-flex gap-1 mb-3';
    modeRow.innerHTML = `
      <button class="btn btn-sm btn-primary diff-mode-btn" data-mode="instance">
        <i class="bi bi-list-ul me-1"></i>Instance Diff
      </button>
      <button class="btn btn-sm btn-outline-secondary diff-mode-btn" data-mode="api">
        <i class="bi bi-file-earmark-code me-1"></i>Single API Diff
      </button>`;
    modeRow.querySelectorAll('.diff-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        modeRow.querySelectorAll('.diff-mode-btn').forEach(b => b.className = 'btn btn-sm btn-outline-secondary diff-mode-btn');
        btn.className = 'btn btn-sm btn-primary diff-mode-btn';
        this.currentMode = btn.dataset.mode;
        this._renderControls();
        resultsDiv.innerHTML = '';
      });
    });
    wrap.appendChild(modeRow);

    this._controlsDiv = document.createElement('div');
    wrap.appendChild(this._controlsDiv);

    const resultsDiv = document.createElement('div');
    this._resultsDiv = resultsDiv;
    wrap.appendChild(resultsDiv);

    container.appendChild(wrap);
    this._renderControls();

    const ctxApiId = sessionStorage.getItem('diff-api-id');
    const ctxApiName = sessionStorage.getItem('diff-api-name');
    const ctxSrcEnv = sessionStorage.getItem('diff-src-env');
    sessionStorage.removeItem('diff-api-id');
    sessionStorage.removeItem('diff-api-name');
    sessionStorage.removeItem('diff-src-env');
    if (ctxApiId && ctxSrcEnv) {
      this.currentMode = 'api';
      this.srcEnv = ctxSrcEnv;
      modeRow.querySelectorAll('.diff-mode-btn').forEach(b => b.className = 'btn btn-sm btn-outline-secondary diff-mode-btn');
      modeRow.querySelector('[data-mode="api"]').className = 'btn btn-sm btn-primary diff-mode-btn';
      this._renderControls();
      this.selectedApi = { id: ctxApiId, displayName: ctxApiName, path: '' };
      if (this._compareBtn) this._compareBtn.disabled = false;
      const sel = this._controlsDiv.querySelector('select');
      if (sel) sel.value = ctxApiId;
      this._runApiDiff();
    }
  },

  _renderControls() {
    const d = this._controlsDiv;
    d.innerHTML = '';
    this._resultsDiv.innerHTML = '';
    this.selectedApi = null;
    if (this.currentMode === 'instance') this._buildInstanceControls(d);
    else this._buildApiControls(d);
  },

  _buildInstanceControls(d) {
    const card = document.createElement('div');
    card.className = 'card mb-3';
    card.innerHTML = '<div class="card-gradient-header"><i class="bi bi-sliders me-1"></i>Compare Environments</div>';
    const body = document.createElement('div');
    body.className = 'card-body p-2';

    body.innerHTML += '<small class="text-muted fw-semibold">Source</small>';
    const srcTabsDiv = document.createElement('div');
    body.appendChild(srcTabsDiv);
    EnvTabs.render(srcTabsDiv, this.srcEnv, env => { this.srcEnv = env; });

    const destLbl = document.createElement('div');
    destLbl.className = 'mt-2';
    destLbl.innerHTML = '<small class="text-muted fw-semibold">Destination</small>';
    body.appendChild(destLbl);
    const destTabsDiv = document.createElement('div');
    body.appendChild(destTabsDiv);
    EnvTabs.render(destTabsDiv, this.destEnv, env => {
      if (env === this.srcEnv) { Toast.show('Source and destination must be different', 'warning'); return; }
      this.destEnv = env;
    });

    const btnRow = document.createElement('div');
    btnRow.className = 'd-flex justify-content-end mt-2';
    const cmpBtn = document.createElement('button');
    cmpBtn.className = 'btn btn-sm btn-primary';
    cmpBtn.innerHTML = '<i class="bi bi-arrow-left-right me-1"></i>Compare';
    cmpBtn.addEventListener('click', () => this._runInstanceDiff());
    btnRow.appendChild(cmpBtn);
    body.appendChild(btnRow);
    card.appendChild(body);
    d.appendChild(card);
  },

  _buildApiControls(d) {
    const card = document.createElement('div');
    card.className = 'card mb-3';
    card.innerHTML = '<div class="card-gradient-header"><i class="bi bi-sliders me-1"></i>Compare Single API</div>';
    const body = document.createElement('div');
    body.className = 'card-body p-2';

    body.innerHTML += '<small class="text-muted fw-semibold">Source</small>';
    const srcTabsDiv = document.createElement('div');
    body.appendChild(srcTabsDiv);
    EnvTabs.render(srcTabsDiv, this.srcEnv, env => {
      this.srcEnv = env;
      this.selectedApi = null;
      if (this._searchCtrl) this._searchCtrl.clear();
      this._updateCompareBtn();
      // Rebuild the entire API controls so dropdown reloads for new source env
      d.innerHTML = '';
      this._buildApiControls(d);
    });

    const destLbl = document.createElement('div');
    destLbl.className = 'mt-2';
    destLbl.innerHTML = '<small class="text-muted fw-semibold">Destination</small>';
    body.appendChild(destLbl);
    const destTabsDiv = document.createElement('div');
    body.appendChild(destTabsDiv);
    EnvTabs.render(destTabsDiv, this.destEnv, env => { this.destEnv = env; });

    const searchLbl = document.createElement('div');
    searchLbl.className = 'mt-2 mb-1';
    searchLbl.innerHTML = '<small class="text-muted fw-semibold">API (from source env)</small>';
    body.appendChild(searchLbl);

    const onApiSelect = (item) => {
      const api = item.api || item;
      body.querySelector('.version-picker')?.remove();
      body.querySelector('.selected-version-label')?.remove();
      if (api.versions && api.versions.length > 0) {
        const picker = document.createElement('div');
        picker.className = 'version-picker mt-2 p-2 border rounded';
        picker.style.background = '#f8fafc';
        const lbl = document.createElement('div');
        lbl.className = 'fw-semibold mb-1';
        lbl.style.fontSize = '.8rem';
        lbl.textContent = `Select version for "${api.displayName}":`;
        picker.appendChild(lbl);
        api.versions.forEach(v => {
          const btn = document.createElement('button');
          btn.className = 'btn btn-sm btn-outline-primary me-1 mb-1';
          btn.textContent = v.versionName || 'Original';
          btn.addEventListener('click', () => {
            const resolved = { ...api, id: v.id, path: v.path, revision: v.revision, versionName: v.versionName || 'Original', versions: [] };
            this.selectedApi = resolved;
            this._updateCompareBtn();
            picker.remove();
            const selLabel = document.createElement('div');
            selLabel.className = 'selected-version-label mt-1';
            selLabel.style.cssText = 'font-size:.78rem;color:#374151;';
            selLabel.innerHTML = `<i class="bi bi-check-circle text-success me-1"></i><strong>${api.displayName}</strong> — ${v.versionName || 'Original'}`;
            body.appendChild(selLabel);
          });
          picker.appendChild(btn);
        });
        body.appendChild(picker);
        this.selectedApi = null;
        this._updateCompareBtn();
      } else {
        this.selectedApi = api;
        this._updateCompareBtn();
      }
    };

    // Dropdown — version-aware
    const dropWrapper = document.createElement('div');
    dropWrapper.className = 'position-relative mb-2';
    const dropBtn = document.createElement('button');
    dropBtn.type = 'button';
    dropBtn.className = 'form-select form-select-sm text-start';
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
              const resolved = { ...api, id: v.id, path: v.path, revision: v.revision,
                versionName: v.versionName || 'Original', versions: [] };
              body.querySelector('.version-picker')?.remove();
              body.querySelector('.selected-version-label')?.remove();
              this.selectedApi = resolved;
              this._updateCompareBtn();
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
            body.querySelector('.version-picker')?.remove();
            body.querySelector('.selected-version-label')?.remove();
            onApiSelect(api);
            if (this._searchCtrl) this._searchCtrl.clear();
          });
          dropList.appendChild(item);
        }
      });
    };

    const cachedApis = Cache.get('/api/apis', { env: this.srcEnv });
    if (cachedApis && cachedApis.length) _fillDropdown(cachedApis);
    API.get('/api/apis', { env: this.srcEnv }).then(fresh => _fillDropdown(fresh)).catch(() => {
      if (!cachedApis || !cachedApis.length) dropBtn.textContent = 'Or select from list...';
    });

    dropBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropList.style.display = dropList.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { dropList.style.display = 'none'; }, { capture: true });
    body.appendChild(dropWrapper);

    const searchDiv = document.createElement('div');
    body.appendChild(searchDiv);
    this._searchCtrl = SearchInput.create(searchDiv, {
      placeholder: 'Search APIs...',
      onSearch: (q) => API.searchApis(this.srcEnv, q),
      onSelect: (item) => {
        onApiSelect(item);
        if (this._dropBtn) this._dropBtn.textContent = 'Or select from list...';
      }
    });

    const btnRow = document.createElement('div');
    btnRow.className = 'd-flex justify-content-end mt-2';
    this._compareBtn = document.createElement('button');
    this._compareBtn.className = 'btn btn-sm btn-primary';
    this._compareBtn.innerHTML = '<i class="bi bi-arrow-left-right me-1"></i>Compare';
    this._compareBtn.disabled = true;
    this._compareBtn.addEventListener('click', () => this._runApiDiff());
    btnRow.appendChild(this._compareBtn);
    body.appendChild(btnRow);
    card.appendChild(body);
    d.appendChild(card);
  },

  _updateCompareBtn() {
    if (this._compareBtn) this._compareBtn.disabled = !this.selectedApi;
  },

  // ── Instance Diff ─────────────────────────────────────────────────
  async _runInstanceDiff() {
    if (this.srcEnv === this.destEnv) { Toast.show('Source and destination environments must be different', 'warning'); return; }
    const r = this._resultsDiv;
    const cached = Cache.get('/api/diff/instance', { src: this.srcEnv, dest: this.destEnv });
    if (cached) { this._renderInstanceResults(r, cached); return; }
    r.innerHTML = this._skeletonHTML('Comparing instances...');
    try {
      const data = await API.get('/api/diff/instance', { src: this.srcEnv, dest: this.destEnv });
      r.innerHTML = '';
      this._renderInstanceResults(r, data);
    } catch (e) {
      r.innerHTML = `<div class="alert alert-danger mt-2">${e.message}</div>`;
    }
  },

  _renderInstanceResults(container, data) {
    const { only_in_src = [], only_in_dest = [], different = [], identical = [], summary = {} } = data;
    const total = only_in_src.length + only_in_dest.length + different.length + identical.length;

    const summaryCard = document.createElement('div');
    summaryCard.className = 'card mb-2';
    summaryCard.innerHTML = `
      <div class="card-gradient-header"><i class="bi bi-bar-chart-line me-1"></i>Summary</div>
      <div class="card-body p-2">
        <div class="d-flex flex-wrap gap-1" style="font-size:.8rem">
          <span class="badge bg-secondary">${total} total</span>
          <span class="badge bg-success">${only_in_src.length} only in source</span>
          <span class="badge bg-danger">${only_in_dest.length} only in dest</span>
          <span class="badge bg-warning text-dark">${different.length} different</span>
          <span class="badge bg-secondary">${identical.length} identical</span>
        </div>
      </div>`;
    container.appendChild(summaryCard);

    if (total === 0) { container.innerHTML += '<div class="alert alert-info mt-2">No APIs found.</div>'; return; }

    const tabsWrap = document.createElement('div');
    tabsWrap.innerHTML = `
      <ul class="nav nav-tabs nav-fill mb-2" style="font-size:.78rem">
        <li class="nav-item"><button class="nav-link active py-1" data-tab="src"><span class="badge bg-success me-1">${only_in_src.length}</span>Only Source</button></li>
        <li class="nav-item"><button class="nav-link py-1" data-tab="dest"><span class="badge bg-danger me-1">${only_in_dest.length}</span>Only Dest</button></li>
        <li class="nav-item"><button class="nav-link py-1" data-tab="diff"><span class="badge bg-warning text-dark me-1">${different.length}</span>Different</button></li>
        <li class="nav-item"><button class="nav-link py-1" data-tab="same"><span class="badge bg-secondary me-1">${identical.length}</span>Identical</button></li>
      </ul>`;
    container.appendChild(tabsWrap);

    const tabContent = document.createElement('div');
    container.appendChild(tabContent);

    const tabPanels = {
      src:  () => this._renderApiList(only_in_src, 'success', 'Only in Source', true),
      dest: () => this._renderApiList(only_in_dest, 'danger', 'Only in Dest', false),
      diff: () => this._renderApiListDiff(different),
      same: () => this._renderApiList(identical, 'secondary', 'Identical', false),
    };

    const showTab = (k) => { tabContent.innerHTML = ''; tabContent.appendChild(tabPanels[k]()); };
    tabsWrap.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        tabsWrap.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        showTab(btn.dataset.tab);
      });
    });
    showTab('src');
  },

  _renderApiList(apis, badgeClass, label, showPromote) {
    if (!apis.length) {
      const el = document.createElement('div');
      el.className = 'text-muted p-2';
      el.style.fontSize = '.83rem';
      el.textContent = `No APIs in "${label}"`;
      return el;
    }
    const table = document.createElement('table');
    table.className = 'table table-sm table-hover mb-0';
    table.innerHTML = `<thead><tr class="table-light" style="font-size:.78rem">
      <th>API Name</th><th>Path</th><th>Rev</th>${showPromote ? '<th></th>' : ''}
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    apis.forEach(api => {
      const tr = document.createElement('tr');
      tr.className = 'hover-lift';
      tr.innerHTML = `
        <td style="font-size:.8rem"><span class="fw-semibold">${api.displayName || api.id}</span></td>
        <td style="font-size:.78rem"><code>${api.path || '—'}</code></td>
        <td><span class="badge bg-${badgeClass}" style="font-size:.7rem">${api.revision || '—'}</span></td>
        ${showPromote ? '<td class="text-end"><button class="btn btn-outline-success btn-sm py-0 px-1" title="Promote" data-promote="1"><i class="bi bi-send"></i></button></td>' : ''}`;
      if (showPromote) tr.querySelector('[data-promote]').addEventListener('click', () => Router.navigate('promote'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  },

  _renderApiListDiff(apis) {
    if (!apis.length) {
      const el = document.createElement('div');
      el.className = 'text-muted p-2';
      el.style.fontSize = '.83rem';
      el.textContent = 'No differing APIs';
      return el;
    }
    const wrap = document.createElement('div');
    const table = document.createElement('table');
    table.className = 'table table-sm table-hover mb-0';
    table.innerHTML = `<thead><tr class="table-light" style="font-size:.78rem">
      <th>API Name</th><th>Src Rev</th><th>Dest Rev</th><th></th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    apis.forEach(api => {
      const tr = document.createElement('tr');
      tr.className = 'hover-lift';
      tr.style.cursor = 'pointer';
      tr.innerHTML = `
        <td style="font-size:.8rem"><span class="fw-semibold">${api.displayName || api.id}</span></td>
        <td><span class="badge bg-warning text-dark" style="font-size:.7rem">${api.src_revision || '—'}</span></td>
        <td><span class="badge bg-secondary" style="font-size:.7rem">${api.dest_revision || '—'}</span></td>
        <td class="text-end">
          <button class="btn btn-outline-primary btn-sm py-0 px-1 me-1" title="View diff" data-apidiff="1"><i class="bi bi-arrow-left-right"></i></button>
          <button class="btn btn-outline-success btn-sm py-0 px-1" title="Promote" data-promote="1"><i class="bi bi-send"></i></button>
        </td>`;
      tr.querySelector('[data-promote]').addEventListener('click', () => Router.navigate('promote'));
      tr.querySelector('[data-apidiff]').addEventListener('click', () => {
        this.currentMode = 'api';
        this.selectedApi = { id: api.id, displayName: api.displayName, path: api.src_path || '' };
        this._controlsDiv.querySelector('[data-mode="api"]') && null;
        this._resultsDiv.innerHTML = '';
        this._runApiDiff();
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  },

  // ── Single API Diff ───────────────────────────────────────────────
  async _runApiDiff() {
    if (!this.selectedApi) return;
    if (this.srcEnv === this.destEnv) { Toast.show('Source and destination must be different', 'warning'); return; }
    const r = this._resultsDiv;
    r.innerHTML = this._skeletonHTML('Comparing API...');
    try {
      const data = await API.get('/api/diff/api', { src: this.srcEnv, dest: this.destEnv, api_id: this.selectedApi.id || this.selectedApi });
      r.innerHTML = '';
      this._renderApiDiffResults(r, data);
    } catch (e) {
      r.innerHTML = '';
      const msg = e.message || 'Compare failed';
      if (msg.toLowerCase().includes('not found') || msg.includes('404')) this._renderApiNotFound(r);
      else r.innerHTML = `<div class="alert alert-danger mt-2">${msg}</div>`;
    }
  },

  _renderApiDiffResults(container, data) {
    const { src = {}, dest = {}, operations = {}, policy = {}, policy_diff = [], op_policy_diffs = {} } = data;

    // ── API info card
    const infoCard = document.createElement('div');
    infoCard.className = 'card mb-2';
    infoCard.innerHTML = `
      <div class="card-gradient-header"><i class="bi bi-info-circle me-1"></i>API Information</div>
      <div class="card-body p-2" style="font-size:.82rem">
        <div class="row g-1">
          <div class="col-6"><span class="text-muted">Name:</span> <span class="fw-semibold">${src.displayName || '—'}</span></div>
          <div class="col-6"><span class="text-muted">Path:</span> <code>${src.path || '—'}</code></div>
          <div class="col-6"><span class="text-muted">Source Rev:</span> <span class="badge bg-primary">${data.src_revision || src.revision || '—'}</span></div>
          <div class="col-6"><span class="text-muted">Dest Rev:</span> <span class="badge ${data.dest_revision === 'new' ? 'bg-danger' : src.revision !== (dest && dest.revision) ? 'bg-warning text-dark' : 'bg-secondary'}">${data.dest_revision === 'new' ? 'Not in destination' : (data.dest_revision || (dest && dest.revision) || 'Not in destination')}</span></div>
        </div>
      </div>`;
    container.appendChild(infoCard);

    // ── Operations card
    const ops = operations || {};
    const onlySrc = ops.only_in_src || [];
    const onlyDest = ops.only_in_dest || [];
    const common = ops.common || [];
    if (onlySrc.length || onlyDest.length || common.length) {
      const opsCard = document.createElement('div');
      opsCard.className = 'card mb-2';
      opsCard.innerHTML = `<div class="card-gradient-header"><i class="bi bi-list-columns me-1"></i>Operations
        ${onlySrc.length ? `<span class="badge bg-success ms-1">${onlySrc.length} new</span>` : ''}
        ${onlyDest.length ? `<span class="badge bg-danger ms-1">${onlyDest.length} removed</span>` : ''}
        ${common.length ? `<span class="badge bg-secondary ms-1">${common.length} common</span>` : ''}
      </div>`;
      const opsBody = document.createElement('div');
      opsBody.className = 'card-body p-0';
      const opsTable = document.createElement('table');
      opsTable.className = 'table table-sm mb-0';
      opsTable.innerHTML = `<thead><tr class="table-light" style="font-size:.75rem"><th>Method</th><th>Path</th><th>Status</th></tr></thead>`;
      const opsTbody = document.createElement('tbody');
      [
        ...onlySrc.map(o => ({ ...o, _s: 'new' })),
        ...onlyDest.map(o => ({ ...o, _s: 'removed' })),
        ...common.map(o => ({ ...o, _s: 'common' })),
      ].forEach(op => {
        const badgeClass = op._s === 'new' ? 'bg-success' : op._s === 'removed' ? 'bg-danger' : 'bg-secondary';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span class="badge bg-primary" style="font-size:.68rem">${op.method || '—'}</span></td>
          <td style="font-size:.78rem"><code>${op.urlTemplate || op.path || '—'}</code></td>
          <td><span class="badge ${badgeClass}" style="font-size:.68rem">${op._s}</span></td>`;
        opsTbody.appendChild(tr);
      });
      opsTable.appendChild(opsTbody);
      opsBody.appendChild(opsTable);
      opsCard.appendChild(opsBody);
      container.appendChild(opsCard);
    }

    // ── API-level policy diff card
    const apiPolCard = document.createElement('div');
    apiPolCard.className = 'card mb-2';
    const polChanged = policy_diff && policy_diff.some(l => l.type !== 'context');
    apiPolCard.innerHTML = `<div class="card-gradient-header">
      <i class="bi bi-shield-lock me-1"></i>API-level Policy
      ${polChanged ? '<span class="badge bg-warning text-dark ms-2">Changed</span>' : '<span class="badge bg-secondary ms-2">No changes</span>'}
    </div>`;
    const apiPolBody = document.createElement('div');
    apiPolBody.className = 'card-body p-2';
    if (polChanged) {
      apiPolBody.appendChild(this._renderDiffLines(policy_diff, data.aligned_policy_diff));
    } else if (!policy.src && !policy.dest) {
      apiPolBody.innerHTML = '<span class="text-muted" style="font-size:.8rem">No policy on either side.</span>';
    } else {
      apiPolBody.innerHTML = '<span class="text-muted" style="font-size:.8rem">Policy is identical in both environments.</span>';
    }
    apiPolCard.appendChild(apiPolBody);
    container.appendChild(apiPolCard);

    // ── Operation-level policy diffs card
    const opDiffKeys = Object.keys(op_policy_diffs || {});
    if (opDiffKeys.length) {
      const opPolCard = document.createElement('div');
      opPolCard.className = 'card mb-2';
      const changedOps = opDiffKeys.filter(k => op_policy_diffs[k].diff && op_policy_diffs[k].diff.some(l => l.type !== 'context'));
      opPolCard.innerHTML = `<div class="card-gradient-header">
        <i class="bi bi-shield me-1"></i>Operation Policies
        ${changedOps.length ? `<span class="badge bg-warning text-dark ms-2">${changedOps.length} changed</span>` : '<span class="badge bg-secondary ms-2">No changes</span>'}
      </div>`;
      const opPolBody = document.createElement('div');
      opPolBody.className = 'card-body p-2';

      opDiffKeys.forEach(opId => {
        const opDiff = op_policy_diffs[opId];
        const hasChanges = opDiff.diff && opDiff.diff.some(l => l.type !== 'context');
        const isNew = opDiff.src && !opDiff.dest;
        const isRemoved = !opDiff.src && opDiff.dest;

        const opRow = document.createElement('div');
        opRow.className = 'mb-2';

        const opHeader = document.createElement('div');
        opHeader.className = 'py-1 px-2 rounded d-flex align-items-center justify-content-between';
        opHeader.style.cssText = `background:${isNew ? '#d1fae5' : isRemoved ? '#fee2e2' : hasChanges ? '#fef3c7' : '#f3f4f6'};font-size:.78rem;${hasChanges || isNew || isRemoved ? 'cursor:pointer;' : ''}`;

        let opLabel = opId;
        let labelColor = '#374151';
        if (isNew) { opLabel = `+ ${opId} — policy added`; labelColor = '#166534'; }
        else if (isRemoved) { opLabel = `− ${opId} — policy removed`; labelColor = '#991b1b'; }
        else if (hasChanges) { opLabel = `~ ${opId} — policy changed`; labelColor = '#92400e'; }
        else { opLabel = `${opId} — no changes`; }

        opHeader.innerHTML = `
          <span style="color:${labelColor}">${opLabel}</span>
          ${(hasChanges || isNew || isRemoved) ? '<i class="bi bi-chevron-down"></i>' : ''}`;

        opRow.appendChild(opHeader);

        if (hasChanges || isNew || isRemoved) {
          const diffLines = isNew ? opDiff.diff || [] : isRemoved ? (opDiff.diff || []) : opDiff.diff;
          const diffEl = this._renderDiffLines(diffLines, opDiff.aligned_diff);
          diffEl.style.display = 'none';
          opRow.appendChild(diffEl);
          opHeader.addEventListener('click', () => {
            const icon = opHeader.querySelector('i.bi-chevron-down, i.bi-chevron-up');
            if (diffEl.style.display === 'none') {
              diffEl.style.display = '';
              if (icon) icon.className = 'bi bi-chevron-up';
            } else {
              diffEl.style.display = 'none';
              if (icon) icon.className = 'bi bi-chevron-down';
            }
          });
        }
        opPolBody.appendChild(opRow);
      });
      opPolCard.appendChild(opPolBody);
      container.appendChild(opPolCard);
    }

    // ── Promote button
    const promoteRow = document.createElement('div');
    promoteRow.className = 'd-flex justify-content-end mt-2 mb-2';
    const promoteBtn = document.createElement('button');
    promoteBtn.className = 'btn btn-sm btn-success';
    promoteBtn.innerHTML = '<i class="bi bi-send me-1"></i>Promote this API';
    promoteBtn.addEventListener('click', () => {
      if (this.selectedApi) {
        sessionStorage.setItem('promote-api-id', this.selectedApi.id || this.selectedApi);
        sessionStorage.setItem('promote-src-env', this.srcEnv);
        sessionStorage.setItem('promote-api-name', this.selectedApi.displayName || '');
      }
      Router.navigate('promote');
    });
    promoteRow.appendChild(promoteBtn);
    container.appendChild(promoteRow);
  },

  // ── Shared diff line renderer (same as promote.js) ─────────────────
  _renderDiffLines(diffLines, alignedLines) {
    const wrapper = document.createElement('div');
    if (alignedLines && alignedLines.length) {
      DiffViewer.renderAligned(wrapper, alignedLines,
        (this.srcEnv || 'Env1').toUpperCase(),
        (this.destEnv || 'Env2').toUpperCase());
    } else {
      DiffViewer.renderFromDiff(wrapper, diffLines,
        (this.srcEnv || 'Env1').toUpperCase(),
        (this.destEnv || 'Env2').toUpperCase());
    }
    return wrapper;
  },

  _renderApiNotFound(container) {
    const card = document.createElement('div');
    card.className = 'card mb-2 border-warning';
    card.innerHTML = `
      <div class="card-gradient-header"><i class="bi bi-exclamation-triangle me-1"></i>API Not Found in Destination</div>
      <div class="card-body p-2" style="font-size:.83rem">
        <p class="mb-2 text-muted">
          <strong>${this.selectedApi ? (this.selectedApi.displayName || this.selectedApi.id) : 'This API'}</strong>
          exists in <strong>${this.srcEnv}</strong> but was not found in <strong>${this.destEnv}</strong>.
        </p>
        <button class="btn btn-sm btn-success w-100"><i class="bi bi-send me-1"></i>Promote to Create in Destination</button>
      </div>`;
    card.querySelector('button').addEventListener('click', () => Router.navigate('promote'));
    container.appendChild(card);
  },

  _skeletonHTML(message) {
    return `
      <div class="card mb-2">
        <div class="card-body p-3 text-center text-muted" style="font-size:.83rem">
          <div class="spinner-border spinner-border-sm me-2" role="status"></div>${message}
        </div>
      </div>`;
  },
};

Router.register('diff', Diff);
