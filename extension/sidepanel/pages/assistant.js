/**
 * Assistant Page — natural-language entry point for APIM automation.
 *
 * Flow:
 *   1. User types a query, presses Enter (or clicks Send).
 *   2. POST /api/assistant/parse with {query, history (last 6 = 3 pairs)}.
 *   3. Response is one of:
 *        ok           → render the plan; if gate_required, show Confirm/Cancel; else execute (navigate).
 *        needs_params → ask the user for the missing fields; do NOT increment strike counter.
 *        off_topic    → polite refusal; +1 strike.
 *        no_match     → "I don't know how to do that yet"; +1 strike.
 *        error        → backend or LLM failure; +1 strike.
 *   4. After 3 consecutive strikes, render the manual-action fallback grid.
 *   5. A successful parse OR a successful execute resets the counter to 0.
 *   6. The Reload button clears history + counter and re-renders the empty chat.
 */
const Assistant = {
  _history: [],          // [{role, content}, ...] — last 6 entries (3 user/assistant pairs)
  _strikeCount: 0,
  _maxStrikes: 3,
  _maxHistoryPairs: 3,
  _activePlanLabel: null, // user-facing label after status==='ok' until execute completes
  _collectingFor: null,   // user-facing label while in needs_params dialog
  // Decisions the user has already locked in (e.g. version-picked apiId, picked
  // op slugs). Sent with every parse so the backend can overlay them on top of
  // LLM extraction — prevents the LLM from "re-extracting" stale text from
  // history (e.g. version-set parent id) and overwriting the user's pick.
  _pinnedParams: {},
  _sessionId: null,
  _input: null,
  _sendBtn: null,

  _ensureSessionId() {
    if (!this._sessionId) {
      this._sessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return this._sessionId;
  },

  _clearAnalyzeSession() {
    if (!this._sessionId) return;
    const sid = this._sessionId;
    this._sessionId = null;
    // Best-effort fire-and-forget clear on the backend cache
    try {
      fetch(`${API.baseUrl}/api/assistant/session/${encodeURIComponent(sid)}/clear`, { method: 'POST' })
        .catch(() => {});
    } catch (e) { /* ignore */ }
  },

  render(container) {
    container.innerHTML = `
      <div id="assistant-root" class="assistant-root">
        <div class="assistant-header">
          <span class="assistant-title">
            <i class="bi bi-stars"></i>
            <span>Smart Assistant</span>
          </span>
          <button id="assistant-reload" class="assistant-reload" title="Reset chat">
            <i class="bi bi-arrow-clockwise"></i>
          </button>
        </div>
        <div id="assistant-context-badge" class="ctx-badge" hidden>
          <span class="ctx-badge-text">Building: <strong></strong></span>
          <button type="button" class="ctx-badge-cancel">cancel</button>
        </div>
        <div id="assistant-messages" class="assistant-messages">
          ${this._welcomeHTML()}
        </div>
        <form id="assistant-form" class="assistant-input-row">
          <input id="assistant-input" type="text" placeholder="Ask about APIs, products, or run an action…" autocomplete="off" />
          <button type="submit" class="assistant-send" title="Send">
            <i class="bi bi-send"></i>
          </button>
        </form>
      </div>

      <!-- Error Modal -->
      <div id="assistant-error-modal" class="assistant-modal-overlay" style="display:none">
        <div class="assistant-modal">
          <div class="assistant-modal-header">
            <i class="bi bi-exclamation-triangle-fill text-warning me-2"></i>
            <span>Unable to Process Request</span>
          </div>
          <div class="assistant-modal-body" id="assistant-error-modal-body"></div>
          <div class="assistant-modal-footer">
            <button class="assistant-modal-btn" id="assistant-error-modal-close">OK</button>
          </div>
        </div>
      </div>
    `;
    this._wire();
  },

  unload() {
    // history + strikeCount intentionally preserved across nav (cleared only on Reload)
  },

  _welcomeHTML() {
    return `
      <div class="welcome">
        <h2 class="welcome-title">What can I help you with?</h2>
        <p class="welcome-sub">Ask in plain English. I can route you to any APIM action with the right context already filled in.</p>
        <div class="suggestion-chips">
          <button class="chip" data-suggestion="list apis in prod">
            <i class="bi bi-list-ul"></i><span>list apis in prod</span>
          </button>
          <button class="chip" data-suggestion="create api Orders with path /orders">
            <i class="bi bi-plus-circle"></i><span>create api Orders</span>
          </button>
          <button class="chip" data-suggestion="promote orders to prod">
            <i class="bi bi-send"></i><span>promote orders to prod</span>
          </button>
          <button class="chip" data-suggestion="compare dev and prod">
            <i class="bi bi-arrow-left-right"></i><span>compare dev and prod</span>
          </button>
        </div>
      </div>
    `;
  },


  _wire() {
    const form = document.getElementById('assistant-form');
    const input = document.getElementById('assistant-input');
    const sendBtn = form ? form.querySelector('.assistant-send') : null;
    this._input = input;
    this._sendBtn = sendBtn;

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        input.value = '';
        this._handleQuery(q);
      });
    }

    const reloadBtn = document.getElementById('assistant-reload');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', () => this._reset());
    }

    // Badge cancel link — clears in-flight context the same way "/cancel" does
    const cancelLink = document.getElementById('assistant-context-badge')
      ?.querySelector('.ctx-badge-cancel');
    if (cancelLink) {
      cancelLink.addEventListener('click', () => this._clearContext('user'));
    }

    // Suggestion chips auto-submit on click (matches Claude.ai pattern).
    // Welcome HTML is re-rendered on reset, so we delegate from the parent.
    const messagesContainer = document.getElementById('assistant-messages');
    if (messagesContainer) {
      messagesContainer.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (chip && chip.dataset.suggestion) {
          this._handleQuery(chip.dataset.suggestion);
        }
      });
    }

    // Error modal close button
    const errorModalCloseBtn = document.getElementById('assistant-error-modal-close');
    if (errorModalCloseBtn) {
      errorModalCloseBtn.addEventListener('click', () => {
        const modal = document.getElementById('assistant-error-modal');
        if (modal) modal.style.display = 'none';
      });
    }

    // "/" focuses the input (when the input itself isn't already focused)
    document.addEventListener('keydown', (e) => {
      // Don't intercept '/' if user is typing in any input or textarea
      const isTyping = document.activeElement &&
                       (document.activeElement.tagName === 'INPUT' ||
                        document.activeElement.tagName === 'TEXTAREA' ||
                        document.activeElement.isContentEditable);

      if (e.key === '/' && !isTyping) {
        const root = document.getElementById('page-content');
        if (root && root.querySelector('.assistant-root')) {
          e.preventDefault();
          input.focus();
        }
      }
    });
  },

  _reset() {
    this._history = [];
    this._strikeCount = 0;
    this._activePlanLabel = null;
    this._collectingFor = null;
    this._pinnedParams = {};
    this._clearAnalyzeSession();
    this._hideContextBadge();
    this._setBusy(false);
    document.getElementById('assistant-messages').innerHTML = this._welcomeHTML();
  },

  _setBusy(busy) {
    if (this._input) this._input.disabled = !!busy;
    if (this._sendBtn) this._sendBtn.disabled = !!busy;
    // Visual cue beyond the disabled attribute
    document.getElementById('assistant-root')?.classList.toggle('busy', !!busy);
  },

  _showContextBadge(label) {
    const el = document.getElementById('assistant-context-badge');
    if (!el) return;
    const strong = el.querySelector('strong');
    if (strong) strong.textContent = label;
    el.hidden = false;
  },

  _hideContextBadge() {
    const el = document.getElementById('assistant-context-badge');
    if (el) el.hidden = true;
  },

  _showErrorModal(message) {
    const modal = document.getElementById('assistant-error-modal');
    const body = document.getElementById('assistant-error-modal-body');
    if (modal && body) {
      body.textContent = message;
      modal.style.display = 'flex';
    }
  },

  _clearContext(reason = 'cleared') {
    this._history = [];
    this._strikeCount = 0;
    this._activePlanLabel = null;
    this._collectingFor = null;
    this._pinnedParams = {};
    this._clearAnalyzeSession();
    this._hideContextBadge();
    // Remove (or rather: deactivate) any lingering plan card that hasn't been confirmed
    document.querySelectorAll('#assistant-messages .msg-assistant.plan').forEach(el => {
      // Don't show "Cancelled." message - just disable interactive elements
      // Completed operations should remain visible in history without misleading status
      el.classList.add('plan-cancelled');
      // Only disable gate / picker / action buttons — DO NOT disable the keys
      // card's Copy buttons or other utility buttons inside the SSE summary.
      el.querySelectorAll('.plan-actions button, .btn-confirm, .btn-cancel, .routing-btn, .nudge-btn, .gate-btn')
        .forEach(b => b.disabled = true);
    });
    // Optional: a small "Cleared. Ready for a new request." line
    if (reason === 'user') {
      this._appendAssistant('Cleared. Ready for a new request.', 'system-note');
    }
  },

  _labelForIntent(intent) {
    const set = new Set(intent || []);
    if (set.has('onboard')) return 'Onboard Consumer';
    if (set.has('promote') && set.has('bulk')) return 'Bulk Promote';
    if (set.has('promote')) return 'Promote API';
    if (set.has('create') && set.has('api') && set.has('with_lb')) return 'Create API with LB';
    if (set.has('create') && set.has('api')) return 'Create API';
    if (set.has('diff')) return 'Compare Envs';
    if (set.has('list')) return 'List';
    if (set.has('search')) return 'Search';
    return 'In progress';
  },

  _appendUser(text) {
    const list = document.getElementById('assistant-messages');
    const el = document.createElement('div');
    el.className = 'msg msg-user';
    el.textContent = text;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
  },

  _appendAssistant(html, kind = '') {
    const list = document.getElementById('assistant-messages');
    const el = document.createElement('div');
    el.className = `msg msg-assistant ${kind}`;
    el.innerHTML = html;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    return el;
  },

  _appendSpinner() {
    return this._appendAssistant('<span class="dot-typing"><i></i></span>', 'pending');
  },

  _escape(s) {
    return (typeof HTMLEscape !== 'undefined' && HTMLEscape.escape)
      ? HTMLEscape.escape(s)
      : String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  },

  _humanize(field) {
    const map = {
      displayName: 'API name',
      urls: 'a backend URL',
      verb: 'HTTP verb (GET / POST / PUT / DELETE)',
      jwtAudience: 'JWT audience',
      rateLimitCalls: 'rate limit (per minute)',
      quotaCalls: 'quota (per day)',
      apiId: 'API id',
      path: 'base path',
      env: 'environment (dev / sandbox / prod / dr)',
      src: 'source environment (dev / sandbox / prod / dr)',
      dest: 'destination environment (dev / sandbox / prod / dr)',
      consumerAppName: 'consumer app name',
      consumerAppId: 'consumer app id',
      clientId: 'Azure AD client id',
      productName: 'product name',
      searchTerm: 'search term',
      lbAlgorithm: 'load balancer algorithm (roundRobin / weighted / priority)',
      cbFailureCount: 'circuit breaker failure threshold',
      cbIntervalSeconds: 'circuit breaker window (seconds)',
      cbTripDuration: 'circuit breaker trip duration (seconds)',
      apiIds: 'list of API ids',
      existingApiId: 'API id (the one to add to)',
    };
    return map[field] || field;
  },

  _formatHave(params) {
    if (!params) return 'Got it.';
    const parts = [];
    if (params.displayName) parts.push(`Name: <strong>${this._escape(params.displayName)}</strong>`);
    if (params.urls && params.urls.length) {
      if (params.urls.length === 1) {
        const u = params.urls[0];
        parts.push(`URL: <code>${this._escape(u.url)}</code>${u.verb ? ' (' + this._escape(u.verb) + ')' : ''}`);
      } else {
        const lines = params.urls.map(u =>
          `<code>${this._escape(u.url)}</code>${u.verb ? ' (' + this._escape(u.verb) + ')' : ''}`
        ).join('<br>&nbsp;&nbsp;&nbsp;');
        parts.push(`URLs (${params.urls.length}):<br>&nbsp;&nbsp;&nbsp;${lines}`);
      }
    }
    if (params.lbAlgorithm) parts.push(`LB algorithm: <strong>${this._escape(params.lbAlgorithm)}</strong>`);
    if (params.cbFailureCount || params.cbIntervalSeconds || params.cbTripDuration) {
      const cb = `failures=${params.cbFailureCount || 5}, window=${params.cbIntervalSeconds || 60}s, trip=${params.cbTripDuration || 30}s`;
      parts.push(`Circuit breaker: <code>${this._escape(cb)}</code>`);
    }
    // Show friendly API name if we have version metadata or display name in params
    if (params.apiId) {
      let apiDisplay = params.apiId;
      if (this._selectedVersionMetadata && this._selectedVersionMetadata.apiId === params.apiId) {
        apiDisplay = `${this._selectedVersionMetadata.displayName} (${this._selectedVersionMetadata.versionName})`;
      } else if (params._apiDisplayName) {
        apiDisplay = params._apiVersionName ? `${params._apiDisplayName} (${params._apiVersionName})` : params._apiDisplayName;
      }
      parts.push(`API: <code>${this._escape(apiDisplay)}</code>`);
    }
    if (params.existingApiId) {
      let apiDisplay = params.existingApiId;
      if (this._selectedVersionMetadata && this._selectedVersionMetadata.apiId === params.existingApiId) {
        apiDisplay = `${this._selectedVersionMetadata.displayName} (${this._selectedVersionMetadata.versionName})`;
      } else if (params._existingApiDisplayName) {
        apiDisplay = params._existingApiVersionName ? `${params._existingApiDisplayName} (${params._existingApiVersionName})` : params._existingApiDisplayName;
      }
      parts.push(`Add to API: <code>${this._escape(apiDisplay)}</code>`);
    }
    if (params.consumerAppName) parts.push(`Consumer: <strong>${this._escape(params.consumerAppName)}</strong>`);
    if (params.consumerAppId) parts.push(`App id: <code>${this._escape(String(params.consumerAppId))}</code>`);
    if (params.clientId) parts.push(`Client id: <code>${this._escape(params.clientId)}</code>`);
    if (params.productName) parts.push(`Product: <strong>${this._escape(params.productName)}</strong>`);
    if (params.src) parts.push(`Src: <strong>${this._escape(params.src)}</strong>`);
    if (params.dest) parts.push(`Dest: <strong>${this._escape(params.dest)}</strong>`);
    if (params.selectedOperations && Array.isArray(params.selectedOperations) && params.selectedOperations.length) {
      const isAll = params.selectedOperations.length === 1 && params.selectedOperations[0] === '__ALL__';
      parts.push(isAll ? `Operations: <em>all</em>` : `Operations: ${params.selectedOperations.length} selected`);
    }
    if (params.jwtAudience) parts.push(`JWT aud: <code>${this._escape(params.jwtAudience)}</code>`);
    if (params.rateLimitCalls) parts.push(`Rate: ${this._escape(String(params.rateLimitCalls))}/min`);
    if (params.quotaCalls) parts.push(`Quota: ${this._escape(String(params.quotaCalls))}/day`);
    if (params.env) parts.push(`Env: <strong>${this._escape(params.env)}</strong>`);
    if (params.apiIds && Array.isArray(params.apiIds) && params.apiIds.length) {
      const list = params.apiIds.map(id => `<code>${this._escape(id)}</code>`).join(', ');
      parts.push(`APIs (${params.apiIds.length}): ${list}`);
    }
    if (parts.length === 0) return 'Got it.';
    return 'Got it. <br>• ' + parts.join('<br>• ');
  },

  async _handleQuery(query) {
    // Store the current query for version pickers to use
    this._currentQuery = query;
    // Client-side cancel/clear shortcut — short-circuits the LLM call entirely.
    const trimmed = (query || '').trim().toLowerCase();
    const CANCEL_WORDS = new Set([
      'cancel', 'nevermind', 'never mind', 'start over', 'startover',
      'forget that', 'forget it', 'restart', 'reset', 'clear', 'abort',
    ]);
    if (CANCEL_WORDS.has(trimmed)) {
      this._appendUser(query);
      this._clearContext('user');
      return;
    }

    this._appendUser(query);
    const spinner = this._appendSpinner();
    this._setBusy(true);

    try {
      const data = await API.post('/api/assistant/parse', {
        query,
        history: this._history,
        pinned_params: this._pinnedParams,
        session_id: this._ensureSessionId(),
      }, []);  // [] = no cache invalidation

      spinner.remove();

      if (data.status === 'analyze') {
        // Switch to the agentic tool-use loop on /api/assistant/analyze
        this._strikeCount = 0;
        await this._executeAnalyze(query);
        return;
      }

      if (data.status === 'ok') {
        this._strikeCount = 0;
        // Best-effort name resolution: if the plan's payload has api_id but
        // it doesn't exist in the cached env list, try to fuzzy-resolve. On a
        // unique match, swap in the real apiId. Otherwise leave as-is — the
        // backend will surface a clearer error.
        try { this._resolveApiIdInPlan(data.plan); } catch (e) { /* ignore */ }
        // Collection (if any) is done — switch from "Collecting" to "Building"
        this._collectingFor = null;
        this._activePlanLabel = data.plan?.name || 'In progress';
        this._showContextBadge('Building: ' + this._activePlanLabel);
        this._renderPlan(data.plan);
        this._pushHistory({ role: 'user', content: query });
        this._pushHistory({ role: 'assistant', content: data.plan.summary });
        return;
      }

      if (data.status === 'needs_params') {
        // Store version metadata if auto-selection happened
        if (data.hints && data.hints.auto_selected_version) {
          const autoSel = data.hints.auto_selected_version;
          this._selectedVersionMetadata = {
            apiId: autoSel.concreteId,
            displayName: autoSel.displayName,
            versionName: autoSel.versionName
          };
        }

        const have = this._formatHave(data.params);
        const need = (data.missing || []).map(m => `<strong>${this._escape(this._humanize(m))}</strong>`).join(', ');
        this._appendAssistant(`${have}<br><br>Still need: ${need}.<br><br>Reply with the missing pieces.`, 'follow-up');
        this._pushHistory({ role: 'user', content: query });
        this._pushHistory({ role: 'assistant', content: `Need: ${(data.missing || []).join(', ')}` });
        // Show in-flight badge so the user sees what they're collecting fields for
        const label = this._labelForIntent(data.intent);
        this._collectingFor = label;
        this._showContextBadge('Collecting: ' + label);
        if (Array.isArray(data.missing) && data.missing.includes('backendStrategy')) {
          this._renderBackendStrategyChooser(query, data);
        }
        if (Array.isArray(data.missing) && data.missing.includes('productStrategy')) {
          this._renderProductStrategyChooser(query, data);
        }
        if (Array.isArray(data.missing) && (data.missing.includes('apiId') || data.missing.includes('existingApiId'))) {
          const slot = data.missing.includes('existingApiId') ? 'existingApiId' : 'apiId';
          // Check if this is version selection (multiple versions of same API)
          if (data.hints && Array.isArray(data.hints.api_versions) && data.hints.api_versions.length > 1) {
            this._renderVersionChooserForDiff(query, data, slot);
          } else {
            this._renderApiIdChooser(query, data, slot);
          }
        }
        if (Array.isArray(data.missing) && data.missing.includes('backendCertThumbprint')) {
          this._renderCertUploadCard(query, data);
        }
        if (Array.isArray(data.missing) &&
            (data.missing.includes('env') || data.missing.includes('src')) &&
            data.hints && Array.isArray(data.hints.env_candidates) && data.hints.env_candidates.length > 0) {
          const slot = data.missing.includes('src') ? 'src' : 'env';
          this._renderEnvCandidatesChooser(query, data, slot);
        }
        if (Array.isArray(data.missing) &&
            data.missing.includes('selectedOperations') &&
            data.params && data.params.apiId &&
            data.params.env &&
            !data.missing.includes('env')) {
          // Show operations picker directly
          // Version selection should happen BEFORE this via backend's MissingParams(["apiId"])
          // NOT via an inline picker that uses potentially stale cache data
          this._renderOperationsPicker(
            data.params.apiId,
            data.params.env,
            data.params.consumerAppName,
          );
        }
        return;
      }

      if (data.status === 'needs_version_selection') {
        // API has multiple versions - user must select one before proceeding
        const apiDisplayName = data.api_display_name || data.params?.[data.api_param_name] || 'API';
        this._appendAssistant(
          `The API <strong>${this._escape(apiDisplayName)}</strong> has multiple versions. Please select the version you want to work with.`,
          'follow-up'
        );
        this._pushHistory({ role: 'user', content: query });
        this._pushHistory({ role: 'assistant', content: `Select version for ${apiDisplayName}` });
        const label = this._labelForIntent(data.intent);
        this._collectingFor = label;
        this._showContextBadge('Collecting: ' + label);
        // Render version selector
        this._renderVersionSelector(query, data);
        return;
      }

      if (data.status === 'invalid_params') {
        const bad = (data.invalid || []).map(m => `<strong>${this._escape(this._humanize(m))}</strong>`).join(', ');
        this._appendAssistant(`I couldn't accept ${bad}. Please double-check the value and try again.`, 'error');
        // Counter does NOT increment for invalid_params (user's input issue, not bot issue)
        this._pushHistory({ role: 'user', content: query });
        this._pushHistory({ role: 'assistant', content: `Invalid: ${(data.invalid || []).join(', ')}` });
        return;
      }

      if (data.status === 'off_topic') {
        this._appendAssistant(
          "I'm scoped to Azure APIM admin tasks. Try asking about APIs, products, subscriptions, or environment promotions.",
          'off-topic'
        );
        this._registerStrike();
        return;
      }

      if (data.status === 'no_match') {
        this._appendAssistant(
          "I understood your intent but don't have an automation for that yet. Try a different phrasing or use the manual pages.",
          'no-match'
        );
        this._registerStrike();
        return;
      }

      if (data.status === 'error') {
        this._showErrorModal(data.message || 'An unexpected error occurred. Please try again.');
        this._registerStrike();
        return;
      }

      // Anything else unexpected
      this._showErrorModal('An unexpected error occurred. Please try again.');
      this._registerStrike();

    } catch (e) {
      spinner.remove();
      this._appendAssistant('I encountered an issue processing your request. Please try again.', 'error');
      this._registerStrike();
    } finally {
      this._setBusy(false);
    }
  },

  _registerStrike() {
    this._strikeCount += 1;
    if (this._strikeCount >= this._maxStrikes) {
      this._appendAssistant(
        "I'm having trouble understanding your requests. Please try rephrasing or use the navigation menu to find what you need.",
        'system-note'
      );
      // Reset strike count after showing the message
      this._strikeCount = 0;
    }
  },

  _pushHistory(entry) {
    this._history.push(entry);
    const cap = this._maxHistoryPairs * 2;
    if (this._history.length > cap) {
      this._history = this._history.slice(-cap);
    }
  },

  _renderPlan(plan) {
    const list = (plan.steps || []).map(s => {
      const noteHtml = s.note
        ? `<div class="step-note" style="font-size:.75rem;color:#666;margin-top:2px;">${this._escape(s.note)}</div>`
        : '';
      return `<li><span class="step-label">${this._escape(s.label)}</span>${noteHtml}</li>`;
    }).join('');
    const summaryHtml =
      `<div class="plan-summary"><strong>${this._escape(plan.summary)}</strong></div>` +
      `<ol class="plan-steps">${list}</ol>`;

    if (!plan.gate_required) {
      const wrapper = this._appendAssistant(summaryHtml + '<div class="plan-status">Running…</div>', 'plan');
      this._executePlan(plan, wrapper.querySelector('.plan-status'));
      return;
    }

    const ambiguity = this._detectApiVersionAmbiguity(plan);
    const pickerHtml = ambiguity ? this._buildVersionPickerHtml(ambiguity) : '';

    // Destructive-tier check: promote with dest != sandbox needs admin password.
    // The /api/promote/api route enforces this server-side; we surface the
    // input here so the chat gate collects it before submit.
    const step0 = plan.steps && plan.steps[0];
    const stepPayload = (step0 && step0.payload) || {};
    const isPromoteToNonSandbox =
      step0 && (step0.action === 'POST_promote' || step0.action === 'POST_bulk_promote') &&
      stepPayload.dest && stepPayload.dest !== 'sandbox';
    const passwordHtml = isPromoteToNonSandbox ? `
      <div class="plan-password-prompt" style="margin-top:8px;padding:8px;border:1px solid #f3a;border-radius:4px;background:#fff5f7">
        <div style="font-weight:600;color:#a00;margin-bottom:4px;font-size:.78rem">
          🔒 Admin password required
        </div>
        <div style="font-size:.72rem;color:#666;margin-bottom:6px">
          Promotion to <strong>${this._escape(stepPayload.dest)}</strong> writes to a protected environment.
        </div>
        <input type="password" class="plan-admin-password"
               style="width:100%;padding:4px 6px;font-size:.78rem;border:1px solid #ccc;border-radius:3px"
               placeholder="Admin password" autocomplete="off" />
        <div class="plan-password-err" style="display:none;color:#a00;font-size:.7rem;margin-top:3px">
          Password required
        </div>
      </div>` : '';

    const wrapper = this._appendAssistant(`
      ${summaryHtml}
      ${pickerHtml}
      ${passwordHtml}
      <div class="plan-actions">
        <button class="btn-confirm">Confirm</button>
        <button class="btn-cancel">Cancel</button>
      </div>
    `, 'plan');

    const confirmBtn = wrapper.querySelector('.btn-confirm');

    if (ambiguity) {
      confirmBtn.disabled = true;
      confirmBtn.classList.add('disabled');
      this._wireVersionChips(wrapper, plan, confirmBtn);
    }

    confirmBtn.addEventListener('click', () => {
      if (confirmBtn.disabled) return;

      // Collect admin password if this is a promote-to-non-sandbox.
      if (isPromoteToNonSandbox) {
        const pwInput = wrapper.querySelector('.plan-admin-password');
        const pwErr = wrapper.querySelector('.plan-password-err');
        const pw = (pwInput && pwInput.value || '').trim();
        if (!pw) {
          if (pwErr) {
            pwErr.style.display = '';
            pwErr.textContent = 'Password required';
          }
          return;  // keep gate open
        }
        // Clear any previous error
        if (pwErr) pwErr.style.display = 'none';
        // Inject into step payload(s) so executor includes it in the POST body.
        (plan.steps || []).forEach(s => { if (s.payload) s.payload.admin_password = pw; });
      }

      // Disable the confirm button to prevent double submission
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Validating...';

      // Don't remove plan actions yet - wait for successful request start
      this._executePlan(plan, null, wrapper, isPromoteToNonSandbox);
    });

    wrapper.querySelector('.btn-cancel').addEventListener('click', () => {
      wrapper.querySelector('.plan-actions').remove();
      const cancelled = document.createElement('div');
      cancelled.className = 'plan-status';
      cancelled.textContent = 'Cancelled.';
      wrapper.appendChild(cancelled);
      // Plan-card cancel also clears in-flight context so the badge disappears
      this._activePlanLabel = null;
      this._collectingFor = null;
      this._hideContextBadge();
    });
  },

  _detectApiVersionAmbiguity(plan) {
    const step = plan?.steps?.[0];
    const rawId = step?.payload?.api_id || step?.payload?.apiId;
    const env = step?.payload?.env || step?.payload?.dest || step?.payload?.src || 'dev';
    return this._detectApiVersionAmbiguityForId(rawId, env);
  },

  _detectApiVersionAmbiguityForId(rawId, env) {
    if (!rawId || !env) return null;
    const cached = (typeof Cache !== 'undefined') ? Cache.get('/api/apis', { env }) : null;
    if (!cached || !Array.isArray(cached)) return null;
    const lower = String(rawId).toLowerCase();
    const matches = cached.filter(api => {
      const name = (api.displayName || api.name || '').toLowerCase();
      const id = (api.id || api.name || '').toLowerCase();
      return name.includes(lower) || name === lower || id === lower;
    });
    if (matches.length !== 1) return null;
    const api = matches[0];
    // version-set parents have multiple versions[] entries; concrete versions have 0 or 1
    const versions = Array.isArray(api.versions) ? api.versions : [];
    if (versions.length < 2) return null;
    return {
      rawId,
      displayName: api.displayName || api.id,
      versions,
    };
  },

  _buildVersionPickerHtml(ambiguity) {
    const chips = ambiguity.versions.map(v => {
      const id = v.id;
      const verName = v.versionName || 'Original';
      return `<button class="plan-version-chip" type="button" data-api-id="${this._escape(id)}" data-version-name="${this._escape(verName)}">${this._escape(verName)}</button>`;
    }).join('');
    return `
      <div class="plan-version-picker">
        <div class="plan-version-prompt">⚠ <strong>${this._escape(ambiguity.displayName)}</strong> has ${ambiguity.versions.length} versions. Pick one:</div>
        <div class="plan-version-chips">${chips}</div>
      </div>
    `;
  },

  _wireVersionChips(wrapper, plan, confirmBtn) {
    const chips = wrapper.querySelectorAll('.plan-version-chip');
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        chips.forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        const newApiId = chip.dataset.apiId;
        const verName = chip.dataset.versionName;

        // Detect which field to update based on what exists in the payload
        const payload = (plan.steps && plan.steps[0] && plan.steps[0].payload) || {};
        let payloadField = 'api_id';
        let pinnedField = 'apiId';

        if ('existing_api_id' in payload || 'existingApiId' in payload) {
          payloadField = 'existing_api_id';
          pinnedField = 'existingApiId';
        }

        // Pin the picked apiId for any subsequent parse calls within this
        // in-flight plan (e.g. follow-up questions that re-parse).
        // Also set resolution flags to prevent backend from re-processing the API ID
        const resolvedFlagName = pinnedField === 'existingApiId' ? '_existingApiIdResolved' : '_apiIdResolved';
        const versionCheckedFlagName = '_versionChecked';
        this._pinnedParams = {
          ...this._pinnedParams,
          [pinnedField]: newApiId,
          _versionPicked: true,
          [resolvedFlagName]: true,
          [versionCheckedFlagName]: true
        };
        if (plan.steps && plan.steps[0] && plan.steps[0].payload) {
          plan.steps[0].payload[payloadField] = newApiId;
        }
        if (plan.summary && verName) {
          const summaryEl = wrapper.querySelector('.plan-summary strong');
          if (summaryEl && !summaryEl.textContent.includes(`[${verName}]`)) {
            summaryEl.textContent = summaryEl.textContent + ` [${verName}]`;
            plan.summary = summaryEl.textContent;
          }
        }
        confirmBtn.disabled = false;
        confirmBtn.classList.remove('disabled');
      });
    });
  },

  _executePlan(plan, statusEl, planWrapper, requiresPassword) {
    const step = (plan.steps || [])[0];
    if (!step) {
      if (statusEl) statusEl.textContent = 'Plan has no steps.';
      else if (planWrapper) {
        const status = document.createElement('div');
        status.className = 'plan-status';
        status.textContent = 'Plan has no steps.';
        planWrapper.appendChild(status);
      }
      return;
    }

    if (step.action === 'ADD_operations') {
      return this._executeAddOps(plan, step, statusEl);
    }
    if (step.action.startsWith('POST_')) {
      if (step.sync === true) {
        return this._executeSync(plan, step, statusEl);
      }
      if (step.bulk === true) {
        return this._executeBulkPost(plan, step, statusEl);
      }
      return this._executePost(plan, step, statusEl, planWrapper, requiresPassword);
    }
    if (step.action.startsWith('READ_')) {
      return this._executeRead(plan, step, statusEl);
    }
    if (step.action.startsWith('NAVIGATE_')) {
      const page = step.action.slice('NAVIGATE_'.length).replace(/_/g, '-');
      sessionStorage.setItem('assistant-prefill', JSON.stringify({ page, params: step.params || {}, ts: Date.now() }));
      Router.navigate(page);
      if (statusEl) statusEl.textContent = `Opened ${plan.name}.`;
      else if (planWrapper) {
        const status = document.createElement('div');
        status.className = 'plan-status';
        status.textContent = `Opened ${plan.name}.`;
        planWrapper.appendChild(status);
      }
      return;
    }
    const errorMsg = `Action ${step.action} not yet implemented.`;
    if (statusEl) statusEl.textContent = errorMsg;
    else if (planWrapper) {
      const status = document.createElement('div');
      status.className = 'plan-status';
      status.textContent = errorMsg;
      planWrapper.appendChild(status);
    }
  },

  _executeSync(plan, step, statusEl) {
    if (statusEl) statusEl.textContent = 'Running…';
    API.post(step.endpoint, step.payload, [{ prefix: '/api/products', params: { env: step.payload.env } }])
      .then(resp => {
        if (statusEl) statusEl.textContent = '';
        const wrapper = statusEl ? statusEl.parentElement : null;
        const summary = document.createElement('div');
        summary.className = 'sse-summary';
        summary.innerHTML = `<strong>Done — ${this._escape(step.payload.consumer_app_name || plan.name)}.</strong>`;
        if (wrapper) wrapper.appendChild(summary);
        // Reveal-keys button (D.6) — keys may be nested under .keys (onboard pattern) or flat
        const respKeys = (resp && resp.keys) || resp || {};
        if (respKeys.primaryKey || respKeys.secondaryKey) {
          this._appendRevealKeys(wrapper || summary, respKeys.primaryKey, respKeys.secondaryKey);
        }
        this._clearContext();
      })
      .catch(() => {
        if (statusEl) statusEl.textContent = '';
        const wrapper = statusEl ? statusEl.parentElement : null;
        const errLine = document.createElement('div');
        errLine.className = 'sse-line error';
        errLine.innerHTML = `<span class="sse-mark">✗</span> <span class="sse-text">Operation failed</span>`;
        if (wrapper) wrapper.appendChild(errLine);
      });
  },

  _executeRead(plan, step, statusEl) {
    if (statusEl) statusEl.textContent = 'Loading…';
    const action = step.action;
    let fetchPromise;
    if (action === 'READ_diff') {
      fetchPromise = API.get(step.endpoint, step.params);
    } else {
      fetchPromise = API.get(step.endpoint, step.params);
    }
    fetchPromise
      .then(data => {
        if (statusEl) statusEl.remove();
        if (action === 'READ_diff') {
          this._renderDiff(data);
        } else if (action === 'READ_list_apis' || action === 'READ_search_apis') {
          this._renderApiList(data);
        } else if (action === 'READ_list_products') {
          this._renderProductList(data);
        }
        this._clearContext();
      })
      .catch(e => {
        // Show user-friendly error message, preserving specific environment info from backend
        let userMsg = 'Unable to complete request';
        const errMsg = e.message || '';
        if (errMsg.includes('404') || errMsg.includes('not found') || errMsg.includes('ResourceNotFound')) {
          // If backend provides specific environment info, use it; otherwise fallback to generic
          if (errMsg.includes('(source)') || errMsg.includes('(dest)') || errMsg.match(/not found in \w+ /)) {
            userMsg = errMsg; // Use the specific backend error message
          } else {
            userMsg = 'API not found in this environment';
          }
        } else if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Unauthorized')) {
          userMsg = 'Access denied';
        } else if (errMsg.includes('timeout') || errMsg.includes('ETIMEDOUT')) {
          userMsg = 'Request timed out';
        }
        if (statusEl) statusEl.textContent = userMsg;
      });
  },

  _renderDiff(data) {
    // Detect if this is a single API diff (has operations field) or instance diff
    if (data.operations) {
      return this._renderSingleApiDiff(data);
    }

    // Instance diff (comparing all APIs between environments)
    const counts = {
      only_in_src: (data.only_in_src || []).length,
      only_in_dest: (data.only_in_dest || []).length,
      different: (data.different || []).length,
      identical: (data.identical || []).length,
      renamed: (data.renamed || []).length,
    };
    let html = `<div class="diff-summary">`;
    html += `<div class="diff-counts">`;
    html += `<span class="diff-badge only-src">${counts.only_in_src} only in src</span>`;
    html += `<span class="diff-badge only-dest">${counts.only_in_dest} only in dest</span>`;
    html += `<span class="diff-badge different">${counts.different} different</span>`;
    html += `<span class="diff-badge renamed">${counts.renamed} renamed</span>`;
    html += `<span class="diff-badge identical">${counts.identical} identical</span>`;
    html += `</div>`;

    const esc = (v) => this._escape(String(v == null ? '' : v));
    const formatPlain = (i) => {
      const dn = esc(i.displayName || i.id || '');
      const pieces = [`<strong>${dn}</strong>`];
      if (i.path) pieces.push(`<code>${esc(i.path)}</code>`);
      if (i.revision) pieces.push(`rev ${esc(i.revision)}`);
      if (i.id && i.id !== i.displayName) pieces.push(`<small>${esc(i.id)}</small>`);
      return pieces.join(' · ');
    };
    const formatDifferent = (i) => {
      const dn = esc(i.displayName || i.id || '');
      const srcBits = [`<code>${esc(i.src_path || '')}</code>`, `rev ${esc(i.src_revision || '1')}`].join(' ');
      const destBits = [`<code>${esc(i.dest_path || '')}</code>`, `rev ${esc(i.dest_revision || '1')}`].join(' ');
      return `<strong>${dn}</strong><div class="diff-detail">src: ${srcBits} → dest: ${destBits}</div>`;
    };
    const formatRenamed = (i) => {
      const dn = esc(i.displayName || '');
      const detail = `src: <code>${esc(i.src_id)}</code> · <code>${esc(i.src_path || '')}</code> → dest: <code>${esc(i.dest_id)}</code> · <code>${esc(i.dest_path || '')}</code>`;
      return `<strong>${dn}</strong><div class="diff-detail">${detail}</div>`;
    };

    const renderSection = (label, items, formatter) => {
      if (!items || items.length === 0) return '';
      const MAX = 5;
      const visible = items.slice(0, MAX);
      const more = items.length - MAX;
      let s = `<div class="diff-section"><strong>${this._escape(label)}</strong><ul>`;
      visible.forEach(i => { s += `<li>${formatter(i)}</li>`; });
      if (more > 0) s += `<li class="diff-more">+${more} more…</li>`;
      s += `</ul></div>`;
      return s;
    };

    if (counts.different > 0) html += renderSection('Different', data.different, formatDifferent);
    if (counts.renamed > 0) html += renderSection('Renamed (same name, different id)', data.renamed, formatRenamed);
    if (counts.only_in_src > 0) html += renderSection('Only in source', data.only_in_src, formatPlain);
    if (counts.only_in_dest > 0) html += renderSection('Only in dest', data.only_in_dest, formatPlain);
    html += `</div>`;
    this._appendAssistant(html, 'read-result');
  },

  _renderSingleApiDiff(data) {
    // Single API diff - render operations, policy diffs, etc.
    const esc = (v) => this._escape(String(v == null ? '' : v));
    const ops = data.operations || {};
    const onlyInSrc = ops.only_in_src || [];
    const onlyInDest = ops.only_in_dest || [];
    const common = ops.common || [];

    let html = `<div class="diff-summary single-api">`;

    // API info with revision badges (matching Diff tab style)
    if (data.src || data.dest) {
      const srcRev = data.src_revision || '1';
      const destRev = data.dest_revision || '1';
      const revChanged = srcRev !== destRev;
      html += `<div class="diff-api-info" style="margin-bottom: 12px; padding: 8px; background: #f9fafb; border-radius: 4px;">`;
      html += `<div style="margin-bottom: 4px;"><strong>API:</strong> ${esc((data.src || data.dest).displayName || data.api_id)}</div>`;
      html += `<div style="display: flex; gap: 16px; font-size: 0.85rem;">`;
      html += `<div><span style="color: #6b7280;">Source Rev:</span> <span class="diff-badge" style="background: #3b82f6; color: white; padding: 2px 8px; border-radius: 3px; font-size: 0.75rem;">${esc(srcRev)}</span></div>`;
      html += `<div><span style="color: #6b7280;">Dest Rev:</span> <span class="diff-badge" style="background: ${revChanged ? '#f59e0b' : '#6b7280'}; color: white; padding: 2px 8px; border-radius: 3px; font-size: 0.75rem;">${esc(destRev)}</span></div>`;
      html += `</div></div>`;
    }

    // Operation counts
    const changedOps = common.filter(op => op.changed).length;
    html += `<div class="diff-counts">`;
    html += `<span class="diff-badge only-src">${onlyInSrc.length} ops only in src</span>`;
    html += `<span class="diff-badge only-dest">${onlyInDest.length} ops only in dest</span>`;
    html += `<span class="diff-badge different">${changedOps} ops changed</span>`;
    html += `<span class="diff-badge identical">${common.length - changedOps} ops unchanged</span>`;
    html += `</div>`;

    // Operations only in source
    if (onlyInSrc.length > 0) {
      html += `<div class="diff-section"><strong>Operations only in source</strong><ul>`;
      onlyInSrc.slice(0, 5).forEach(op => {
        html += `<li><code>${esc(op.method || '')} ${esc(op.urlTemplate || '')}</code></li>`;
      });
      if (onlyInSrc.length > 5) html += `<li class="diff-more">+${onlyInSrc.length - 5} more…</li>`;
      html += `</ul></div>`;
    }

    // Operations only in dest
    if (onlyInDest.length > 0) {
      html += `<div class="diff-section"><strong>Operations only in dest</strong><ul>`;
      onlyInDest.slice(0, 5).forEach(op => {
        html += `<li><code>${esc(op.method || '')} ${esc(op.urlTemplate || '')}</code></li>`;
      });
      if (onlyInDest.length > 5) html += `<li class="diff-more">+${onlyInDest.length - 5} more…</li>`;
      html += `</ul></div>`;
    }

    // Changed operations
    const changedList = common.filter(op => op.changed);
    if (changedList.length > 0) {
      html += `<div class="diff-section"><strong>Operations with policy changes</strong><ul>`;
      changedList.slice(0, 5).forEach(op => {
        html += `<li><code>${esc(op.method || '')} ${esc(op.urlTemplate || '')}</code> - policy differs</li>`;
      });
      if (changedList.length > 5) html += `<li class="diff-more">+${changedList.length - 5} more…</li>`;
      html += `</ul></div>`;
    }

    // API-level policy diff (FIX: properly render diff objects)
    if (data.policy_diff && data.policy_diff.length > 0) {
      const hasChanges = data.policy_diff.some(d => d.type !== 'context');
      if (hasChanges) {
        html += `<div class="diff-section"><strong>API-level policy changes</strong>`;
        html += `<div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px; padding: 8px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 0.75rem;">`;
        const displayLines = data.policy_diff.slice(0, 50);
        displayLines.forEach(diffObj => {
          const lineText = esc(diffObj.line || '');
          const lineType = diffObj.type || 'context';
          let lineColor = '#374151';
          let bgColor = 'transparent';
          let prefix = ' ';
          if (lineType === 'add') {
            lineColor = '#166534';
            bgColor = '#dcfce7';
            prefix = '+';
          } else if (lineType === 'remove') {
            lineColor = '#991b1b';
            bgColor = '#fee2e2';
            prefix = '-';
          }
          html += `<div style="color: ${lineColor}; background: ${bgColor}; padding: 1px 4px;"><span style="display: inline-block; width: 12px;">${prefix}</span>${lineText}</div>`;
        });
        if (data.policy_diff.length > 50) {
          html += `<div style="color: #6b7280; padding: 4px; text-align: center;">+${data.policy_diff.length - 50} more lines…</div>`;
        }
        html += `</div></div>`;
      }
    }

    html += `</div>`;
    this._appendAssistant(html, 'read-result');
  },

  _renderApiList(data) {
    const apis = Array.isArray(data) ? data : (data.apis || data.value || []);
    if (apis.length === 0) {
      this._appendAssistant('<em>No APIs found.</em>', 'read-result');
      return;
    }
    const MAX = 20;
    let html = '<div class="api-list">';
    apis.slice(0, MAX).forEach(api => {
      const name = this._escape(api.displayName || api.name || api.id || '—');
      const path = this._escape(api.path || api.serviceUrl || '');
      const rev = api.apiRevision ? `<span class="rev-badge">rev ${this._escape(String(api.apiRevision))}</span>` : '';
      const env = api.env ? `<span class="env-tag">${this._escape(api.env)}</span>` : '';
      html += `<div class="api-card"><div class="api-card-name">${name}${rev}${env}</div>`;
      if (path) html += `<div class="api-card-path">${path}</div>`;
      html += `</div>`;
    });
    if (apis.length > MAX) html += `<div class="api-more">+${apis.length - MAX} more</div>`;
    html += '</div>';
    this._appendAssistant(html, 'read-result');
  },

  _renderProductList(data) {
    const products = Array.isArray(data) ? data : (data.products || data.value || []);
    if (products.length === 0) {
      this._appendAssistant('<em>No products found.</em>', 'read-result');
      return;
    }
    const MAX = 20;
    let html = '<div class="api-list">';
    products.slice(0, MAX).forEach(p => {
      const name = this._escape(p.displayName || p.name || p.id || '—');
      const state = p.state ? `<span class="env-tag">${this._escape(p.state)}</span>` : '';
      html += `<div class="api-card"><div class="api-card-name">${name}${state}</div></div>`;
    });
    if (products.length > MAX) html += `<div class="api-more">+${products.length - MAX} more</div>`;
    html += '</div>';
    this._appendAssistant(html, 'read-result');
  },

  _renderInlineVersionPicker(ambiguity, env, consumerName, apiParamName = 'apiId') {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant ops-picker version-picker-inline';

    const chips = ambiguity.versions.map(v => {
      const id = v.id;
      const verName = v.versionName || 'Original';
      return `<button type="button" class="plan-version-chip" data-api-id="${this._escape(id)}" data-version-name="${this._escape(verName)}">${this._escape(verName)}</button>`;
    }).join('');

    const consumerLabel = this._escape(consumerName || 'the consumer');
    wrapper.innerHTML = `
      <div class="ops-picker-header">⚠ <strong>${this._escape(ambiguity.displayName)}</strong> has ${ambiguity.versions.length} versions in <strong>${this._escape(env)}</strong>. Pick which version <strong>${consumerLabel}</strong> should access:</div>
      <div class="plan-version-chips">${chips}</div>
    `;

    const list = document.getElementById('assistant-messages');
    if (list) {
      list.appendChild(wrapper);
      list.scrollTop = list.scrollHeight;
    }

    wrapper.querySelectorAll('.plan-version-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const concreteId = chip.dataset.apiId;
        wrapper.querySelectorAll('.plan-version-chip').forEach(c => {
          c.disabled = true;
          if (c === chip) c.classList.add('selected');
        });
        // Pin the picked apiId so the next parse doesn't re-extract the
        // version-set parent id from history and re-trigger this picker.
        // Also set resolution flags to prevent backend from re-processing the API ID
        const resolvedFlagName = apiParamName === 'existingApiId' ? '_existingApiIdResolved' : '_apiIdResolved';
        const versionCheckedFlagName = '_versionChecked';
        this._pinnedParams = {
          ...this._pinnedParams,
          [apiParamName]: concreteId,
          _versionPicked: true,
          [resolvedFlagName]: true,
          [versionCheckedFlagName]: true
        };
        // Re-run the original query with the pinned version
        this._handleQuery(this._currentQuery);
      });
    });
  },

  async _renderOperationsPicker(apiId, env, consumerName) {
    let ops;
    try {
      const resp = await API.get(`/api/apis/${encodeURIComponent(apiId)}/operations`, { env });
      ops = (resp && resp.value) || [];
    } catch (e) {
      // Backend unreachable / 404 — silently bail; user can still type the list.
      return;
    }

    if (!ops.length) return;

    const list = document.getElementById('assistant-messages');
    if (!list) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant ops-picker';
    const consumerLabel = consumerName ? this._escape(consumerName) : 'the consumer';

    // Use friendly display name if we have version metadata, otherwise use API ID
    let apiLabel = this._escape(apiId);
    if (this._selectedVersionMetadata && this._selectedVersionMetadata.apiId === apiId) {
      const dispName = this._selectedVersionMetadata.displayName;
      const verName = this._selectedVersionMetadata.versionName;
      apiLabel = this._escape(`${dispName} (${verName})`);
    }

    const rows = ops.map((op, i) => {
      const props = op.properties || {};
      const method = (props.method || '').toUpperCase();
      const urlTemplate = props.urlTemplate || '';
      const display = props.displayName || op.name || '';
      const id = op.name || `${method.toLowerCase()}-${i}`;
      const label = `${method} ${urlTemplate}`;
      return `<label class="op-row"><input type="checkbox" data-op-label="${this._escape(label)}" data-op-id="${this._escape(id)}"> <code>${this._escape(method)}</code> <span class="op-path">${this._escape(urlTemplate)}</span> <small class="op-name">${this._escape(display)}</small></label>`;
    }).join('');

    wrapper.innerHTML = `
      <div class="ops-picker-header">Pick which operations <strong>${consumerLabel}</strong> can access on <strong>${apiLabel}</strong>:</div>
      <div class="ops-picker-toolbar">
        <button type="button" class="ops-link" data-action="all">Select all</button>
        <span class="ops-sep">·</span>
        <button type="button" class="ops-link" data-action="clear">Clear</button>
      </div>
      <div class="ops-picker-list">${rows}</div>
      <div class="ops-picker-footer">
        <button type="button" class="ops-apply" disabled>Apply selection</button>
      </div>
    `;
    list.appendChild(wrapper);
    list.scrollTop = list.scrollHeight;

    const checkboxes = wrapper.querySelectorAll('input[type=checkbox]');
    const applyBtn = wrapper.querySelector('.ops-apply');
    let allClicked = false;

    const updateApply = () => {
      const anyChecked = Array.from(checkboxes).some(cb => cb.checked);
      applyBtn.disabled = !anyChecked;
    };

    checkboxes.forEach(cb => cb.addEventListener('change', () => { allClicked = false; updateApply(); }));

    wrapper.querySelector('[data-action="all"]').addEventListener('click', () => {
      checkboxes.forEach(cb => { cb.checked = true; });
      allClicked = true;
      updateApply();
    });
    wrapper.querySelector('[data-action="clear"]').addEventListener('click', () => {
      checkboxes.forEach(cb => { cb.checked = false; });
      allClicked = false;
      updateApply();
    });

    applyBtn.addEventListener('click', () => {
      let synthetic;
      if (allClicked) {
        synthetic = 'all operations';
      } else {
        const opIds = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.dataset.opId);
        synthetic = `operations: ${opIds.join(', ')}`;
      }
      // Pin the picked op slugs so the LLM doesn't re-extract or alter them on
      // the next round (free-form queries can otherwise emit labels not slugs).
      this._pinnedParams = {
        ...this._pinnedParams,
        selectedOperations: allClicked
          ? ['__ALL__']
          : Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.dataset.opId),
      };
      // Lock the picker so it stays as a visual record after submit.
      checkboxes.forEach(cb => { cb.disabled = true; });
      const toolbar = wrapper.querySelector('.ops-picker-toolbar');
      if (toolbar) toolbar.remove();
      applyBtn.outerHTML = '<span class="ops-submitted">Submitted ✓</span>';
      this._handleQuery(synthetic);
    });
  },

  _appendCreateApiNudge(apiName, env) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant nudge-bubble';
    wrapper.innerHTML = `
      <div>API <strong>${this._escape(apiName)}</strong> created in <strong>${this._escape(env)}</strong>. Want to onboard a consumer to it?</div>
      <div class="nudge-actions">
        <button type="button" class="nudge-btn nudge-yes">Onboard now</button>
        <button type="button" class="nudge-btn nudge-no">Skip</button>
      </div>
    `;
    document.getElementById('assistant-messages').appendChild(wrapper);
    wrapper.querySelector('.nudge-yes').addEventListener('click', () => {
      wrapper.querySelectorAll('button').forEach(b => b.disabled = true);
      wrapper.querySelector('.nudge-yes').textContent = 'Onboarding…';
      // Synthetic message — feeds through normal parse so the LLM picks up apiId/env
      this._handleQuery(`Onboard a consumer to ${apiName} in ${env}`);
    });
    wrapper.querySelector('.nudge-no').addEventListener('click', () => {
      wrapper.querySelectorAll('button').forEach(b => b.disabled = true);
      wrapper.querySelector('.nudge-no').textContent = 'Skipped';
    });
  },

  _appendRevealKeys(container, primaryKey, secondaryKey) {
    // Render keys IMMEDIATELY — no toggle button to break, no hidden state.
    // Each key has its own per-key Copy button + a global Copy-as-JSON.
    const escape = (s) => String(s || '').replace(/[&<>"']/g,
      c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

    const card = document.createElement('div');
    card.className = 'keys-card';
    card.style.cssText = 'border:1px solid #d1d5db;border-radius:4px;padding:10px;margin-top:8px;background:#fafafa';
    const btnStyle = 'background:#2563eb;color:#fff;border:none;border-radius:4px;font-size:.72rem;padding:4px 10px;cursor:pointer;font-weight:500';
    card.innerHTML = `
      <div style="font-weight:600;font-size:.8rem;margin-bottom:8px;color:#a16207">
        🔑 Subscription Keys (copy now — page refresh won't show them again)
      </div>
      <div style="margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
          <strong style="font-size:.78rem;min-width:70px;color:#111">Primary</strong>
          <button class="keys-copy-pri" type="button" style="${btnStyle}">Copy</button>
        </div>
        <code style="display:block;word-break:break-all;background:#f3f4f6;padding:4px 6px;border-radius:3px;font-size:.72rem;color:#111">${escape(primaryKey)}</code>
      </div>
      <div style="margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
          <strong style="font-size:.78rem;min-width:70px;color:#111">Secondary</strong>
          <button class="keys-copy-sec" type="button" style="${btnStyle}">Copy</button>
        </div>
        <code style="display:block;word-break:break-all;background:#f3f4f6;padding:4px 6px;border-radius:3px;font-size:.72rem;color:#111">${escape(secondaryKey)}</code>
      </div>
      <button class="keys-copy-json" type="button" style="${btnStyle}">Copy both as JSON</button>`;

    const flash = (b, ok = true) => {
      const orig = b.textContent;
      b.textContent = ok ? 'Copied!' : 'Failed';
      b.style.background = ok ? '#16a34a' : '#dc2626';
      setTimeout(() => { b.textContent = orig; b.style.background = '#2563eb'; }, 1500);
    };
    // Robust copy: try modern API first, fall back to execCommand-via-textarea.
    // The fallback works in extension contexts where Clipboard API is blocked.
    const copyTo = (b, value) => {
      const fallback = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = value;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          flash(b, ok);
        } catch (e) {
          console.error('clipboard fallback failed', e);
          flash(b, false);
        }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(() => flash(b, true)).catch((err) => {
          console.warn('navigator.clipboard failed, using fallback:', err);
          fallback();
        });
      } else {
        fallback();
      }
    };

    card.querySelector('.keys-copy-pri').addEventListener('click', (e) => { e.preventDefault(); copyTo(e.currentTarget, primaryKey); });
    card.querySelector('.keys-copy-sec').addEventListener('click', (e) => { e.preventDefault(); copyTo(e.currentTarget, secondaryKey); });
    card.querySelector('.keys-copy-json').addEventListener('click', (e) => {
      e.preventDefault();
      copyTo(e.currentTarget, JSON.stringify({ primaryKey, secondaryKey }, null, 2));
    });

    container.appendChild(card);
  },

  // Walk the plan's first step and if the payload has a non-matching api_id,
  // try to fuzzy-resolve against the cached env list. On unique match, swap
  // in the real id. Multi-match and zero-match fall through to backend.
  _resolveApiIdInPlan(plan) {
    const step = (plan && plan.steps && plan.steps[0]) || null;
    if (!step) return;
    const payload = step.payload || {};
    const params = step.params || {};
    const rawId = payload.api_id || params.apiId;
    if (!rawId) return;
    const env = payload.env || payload.src || params.env || params.src || 'dev';
    const r = this._resolveApiId(rawId, env);
    if (r.status === 'resolved' && r.apiId !== rawId) {
      if (payload.api_id) payload.api_id = r.apiId;
      if (params.apiId) params.apiId = r.apiId;
      // Reflect in summary so user sees the resolved id before Confirm.
      if (plan.summary && rawId) {
        plan.summary = plan.summary.replace(rawId, r.apiId);
      }
    }
  },

  _resolveApiId(rawId, envHint) {
    const env = envHint || 'dev';
    const cached = (typeof Cache !== 'undefined') ? Cache.get('/api/apis', { env }) : null;
    if (!cached || !Array.isArray(cached)) return { status: 'unknown', rawId };
    const lower = (rawId || '').toLowerCase();
    const matches = cached.filter(api => {
      const name = (api.displayName || api.name || '').toLowerCase();
      const id = (api.id || api.name || '').toLowerCase();
      const path = (api.path || '').toLowerCase();
      return name.includes(lower) || name === lower || id === lower || path.includes(lower) || id.includes(lower);
    });
    if (matches.length === 1) return { status: 'resolved', apiId: matches[0].id || matches[0].name, api: matches[0] };
    if (matches.length > 1) return { status: 'multi', matches };
    return { status: 'none', rawId };
  },

  _appendSseLine(progressEl, message, isError) {
    const line = document.createElement('div');
    line.className = isError ? 'sse-line error' : 'sse-line';
    line.innerHTML = `<span class="sse-mark">${isError ? '✗' : '●'}</span> <span class="sse-text">${this._escape(message)}</span>`;
    progressEl.appendChild(line);
    return line;
  },

  _markPreviousLinesDone(progressEl) {
    const lines = progressEl.querySelectorAll('.sse-line');
    for (let i = 0; i < lines.length - 1; i++) {
      const mark = lines[i].querySelector('.sse-mark');
      if (mark && mark.textContent === '●' && !lines[i].classList.contains('error')) {
        mark.textContent = '✓';
        lines[i].classList.add('done');
      }
    }
  },

  _renderBulkBlocks(container, apiIds) {
    const blocks = {};
    apiIds.forEach(apiId => {
      const det = document.createElement('details');
      det.className = 'bulk-api';
      det.open = true;
      const sum = document.createElement('summary');
      sum.textContent = apiId;
      det.appendChild(sum);
      const prog = document.createElement('div');
      prog.className = 'sse-progress sse-bulk-api-progress';
      prog.dataset.api = apiId;
      det.appendChild(prog);
      container.appendChild(det);
      blocks[apiId] = { details: det, progress: prog, seen: new Set(), failed: false, finalized: false };
    });
    return blocks;
  },

  _executeBulkPost(plan, step, statusEl) {
    const wrapper = statusEl ? statusEl.parentElement : null;
    const container = document.createElement('div');
    container.className = 'sse-bulk';
    const apiIds = (step.payload && step.payload.api_ids) || [];
    const total = apiIds.length;

    const overallStatus = document.createElement('div');
    overallStatus.className = 'sse-bulk-overall';
    overallStatus.textContent = `Starting ${total} APIs…`;
    container.appendChild(overallStatus);

    const blocks = this._renderBulkBlocks(container, apiIds);

    if (wrapper) wrapper.appendChild(container);
    if (statusEl) statusEl.textContent = '';

    const finalizeBlock = (apiId, succeeded) => {
      const b = blocks[apiId];
      if (!b || b.finalized) return;
      this._markPreviousLinesDone(b.progress);
      const lastLine = b.progress.querySelector('.sse-line:last-of-type');
      if (lastLine && !lastLine.classList.contains('error')) {
        const mark = lastLine.querySelector('.sse-mark');
        if (mark && mark.textContent === '●') { mark.textContent = '✓'; lastLine.classList.add('done'); }
      }
      const summary = document.createElement('div');
      summary.className = 'sse-summary';
      summary.textContent = succeeded ? '✓ Done' : '✗ Failed';
      b.progress.appendChild(summary);
      if (succeeded) b.details.open = false;
      b.finalized = true;
    };

    let lastApiId = null;
    let processed = 0;

    API.postSSE(step.endpoint, step.payload, {
      onStep: (event) => {
        const apiId = event.api;
        if (!apiId) return;
        const b = blocks[apiId];
        if (!b) return;
        lastApiId = apiId;

        if (event.status === 'api_starting') return;

        if (event.status === 'api_done' || event.status === 'api_failed') {
          finalizeBlock(apiId, !b.failed);
          processed += 1;
          overallStatus.textContent = `Processed ${processed} of ${total}…`;
          return;
        }

        if (event.status === 'step_error') {
          b.failed = true;
          if (event.message) this._appendSseLine(b.progress, event.message, true);
          return;
        }

        if (!event.message) return;
        if (b.seen.has(event.message)) return;
        b.seen.add(event.message);

        this._appendSseLine(b.progress, event.message, false);
        this._markPreviousLinesDone(b.progress);
      },
      onDone: (_event) => {
        Object.keys(blocks).forEach(id => {
          const b = blocks[id];
          if (!b.finalized) finalizeBlock(id, !b.failed);
        });
        const succeeded = Object.values(blocks).filter(b => !b.failed).length;
        const failed = total - succeeded;
        overallStatus.innerHTML = failed === 0
          ? `<strong>Done — all ${this._escape(String(total))} APIs promoted.</strong>`
          : `<strong>Done — ${this._escape(String(succeeded))} succeeded, ${this._escape(String(failed))} failed.</strong>`;
        this._clearContext();
      },
      onError: (msg) => {
        // Show duplicate API/operation errors in a modal
        if (msg && (msg.includes('already exist') || msg.includes('duplicate'))) {
          this._showErrorModal(msg);
          // Clear the container since we're showing modal
          if (container) container.remove();
          if (statusEl) statusEl.textContent = '';
        } else {
          const b = lastApiId ? blocks[lastApiId] : null;
          if (b) {
            b.failed = true;
            this._appendSseLine(b.progress, msg, true);
          } else {
            this._appendSseLine(container, msg, true);
          }
        }
      },
      invalidate: [
        { prefix: '/api/apis', params: { env: (step.payload && step.payload.dest) || 'prod' } },
        { prefix: '/api/apis', params: { env: (step.payload && step.payload.src) || 'dev' } },
      ],
    });
  },

  async _executeAddOps(plan, step, statusEl) {
    const wrapper = statusEl ? statusEl.parentElement : null;
    const progressList = document.createElement('div');
    progressList.className = 'sse-progress';
    if (wrapper) wrapper.appendChild(progressList);
    if (statusEl) statusEl.textContent = '';

    const initLine = (msg) => {
      const line = document.createElement('div');
      line.className = 'sse-line';
      line.innerHTML = `<span class="sse-mark">●</span> <span class="sse-text">${this._escape(msg)}</span>`;
      progressList.appendChild(line);
      return line;
    };
    const markLineDone = (line, ok = true) => {
      const mark = line.querySelector('.sse-mark');
      if (mark) mark.textContent = ok ? '✓' : '✗';
      line.classList.add(ok ? 'done' : 'error');
    };

    const inspectLine = initLine('Inspecting existing API…');
    let inspection;
    try {
      inspection = await API.post(step.endpoint_inspect, step.payload, []);
    } catch (e) {
      markLineDone(inspectLine, false);
      initLine(`Inspection failed: ${e.message || e}`);
      return;
    }
    markLineDone(inspectLine, true);

    // Surface what we learned
    const apiInfo = inspection.api || {};
    const summaryLine = initLine(
      apiInfo.backend_kind === 'pool'
        ? `${apiInfo.displayName || apiInfo.id} has a pool backend (${(apiInfo.current_pool_members || []).length} members).`
        : apiInfo.backend_kind === 'single'
          ? `${apiInfo.displayName || apiInfo.id} has a single backend (${apiInfo.current_backend_id || 'unknown'}).`
          : `${apiInfo.displayName || apiInfo.id} has no api-level backend yet.`
    );
    markLineDone(summaryLine, true);

    // Collect routing decisions for hosts that need them
    const hostGroups = inspection.host_groups || {};
    const decisionsNeeded = Object.entries(hostGroups).filter(([_, g]) => g.needs_decision);
    const userRequestedCb = !!step.payload.user_requested_cb;  // Only ask for CB if user mentioned it

    const routingChoices = {};   // host -> {strategy: 'pool'|'standalone'|'individual'|'add_to_existing_pool', lb_algorithm?, enable_cb?, cb_*?, existing_pool_id?, pool_priority?, pool_weight?}
    for (const [host, group] of decisionsNeeded) {
      const choice = await this._askRoutingDecision(host, group, apiInfo, step.payload.env, userRequestedCb);
      if (!choice) {
        initLine('Cancelled.');
        return;
      }
      routingChoices[host] = choice;
    }

    // Build the execute payload — for MVP we collapse to one global backend_strategy.
    // WHY: api_creator._add_operations_to_existing_api only supports a single
    // global strategy, not per-host. If any host chose pool, all new hosts use
    // pool; otherwise standalone/individual is applied across the board.
    const choices = Object.values(routingChoices);
    const anyPool = choices.some(c => c.strategy === 'pool');
    const anyAddToExisting = choices.some(c => c.strategy === 'add_to_existing_pool');
    const executePayload = { ...step.payload };

    if (anyAddToExisting) {
      // Add to existing pool strategy - matches create tab behavior EXACTLY
      // DO NOT set backend_strategy here - the backend detects existing_pool_id and adds to that pool
      const firstAddToExisting = choices.find(c => c.strategy === 'add_to_existing_pool');

      executePayload.backend_config = executePayload.backend_config || {};
      executePayload.backend_config.enable_lb = true;

      // CRITICAL: Pass the existing pool ID to the backend so it knows which pool to add to
      if (firstAddToExisting.existing_pool_id) {
        executePayload.backend_config.existing_pool_id = firstAddToExisting.existing_pool_id;
      }

      // Include lb_algorithm if available (optional for existing pools - already configured)
      if (firstAddToExisting.lb_algorithm) {
        executePayload.backend_config.lb_algorithm = firstAddToExisting.lb_algorithm;
      }

      // Include circuit breaker config if enabled
      if (firstAddToExisting.enable_cb) {
        executePayload.backend_config.enable_circuit_breaker = true;
        if (firstAddToExisting.cb_config) {
          executePayload.backend_config.circuit_breaker = firstAddToExisting.cb_config;
        }
      }

      // Include pool member priority/weight for each host
      // Create backend_configs object with per-hostname configuration
      executePayload.backend_config.backend_configs = {};
      Object.entries(routingChoices).forEach(([host, choice]) => {
        if (choice.strategy === 'add_to_existing_pool') {
          executePayload.backend_config.backend_configs[host] = {};
          if (choice.pool_priority !== undefined) {
            executePayload.backend_config.backend_configs[host].priority = choice.pool_priority;
          }
          if (choice.pool_weight !== undefined) {
            executePayload.backend_config.backend_configs[host].weight = choice.pool_weight;
          }
        }
      });
    } else if (anyPool) {
      // Create new pool strategy
      executePayload.backend_strategy = "pool";

      const firstPool = choices.find(c => c.strategy === 'pool');

      executePayload.backend_config = {
        enable_lb: true,
        lb_algorithm: firstPool.lb_algorithm || 'roundRobin',
        enable_circuit_breaker: !!firstPool.enable_cb,
      };

      if (firstPool.enable_cb) {
        // Use user-provided CB config if available, otherwise fall back to defaults
        executePayload.backend_config.circuit_breaker = firstPool.cb_config || {
          failure_count: 5,
          interval_seconds: 60,
          trip_duration_seconds: 30,
        };
      }

      // Include pool member priority/weight for each host using backend_configs
      if (firstPool.pool_priority !== undefined || firstPool.pool_weight !== undefined) {
        executePayload.backend_config.backend_configs = {};

        // Add config for each host in the routing choices
        Object.entries(routingChoices).forEach(([host, choice]) => {
          if (choice.strategy === 'pool') {
            executePayload.backend_config.backend_configs[host] = {};
            if (choice.pool_priority !== undefined) {
              executePayload.backend_config.backend_configs[host].priority = choice.pool_priority;
            }
            if (choice.pool_weight !== undefined) {
              executePayload.backend_config.backend_configs[host].weight = choice.pool_weight;
            }
          }
        });
      }
    } else if (choices.length > 0) {
      // Individual backends or standalone strategy
      executePayload.backend_strategy = 'standalone';
    }

    initLine('Applying changes…');

    // Stream the actual execute via SSE — inline the rendering instead of
    // calling _executePost (different progress block layout).
    API.postSSE(step.endpoint_execute, executePayload, {
      onStep: (event) => {
        if (!event.message) return;
        initLine(event.message);
        // Mark previous active lines done as new ones arrive
        const lines = progressList.querySelectorAll('.sse-line');
        for (let i = 0; i < lines.length - 1; i++) {
          const m = lines[i].querySelector('.sse-mark');
          if (m && m.textContent === '●') {
            m.textContent = '✓';
            lines[i].classList.add('done');
          }
        }
      },
      onDone: (event) => {
        progressList.querySelectorAll('.sse-line').forEach(l => {
          const m = l.querySelector('.sse-mark');
          if (m && m.textContent === '●') { m.textContent = '✓'; l.classList.add('done'); }
        });
        const summary = document.createElement('div');
        summary.className = 'sse-summary';
        summary.innerHTML = `<strong>Done — added ${step.payload.urls.length} op(s) to ${this._escape(step.payload.existing_api_id)}.</strong>`;
        progressList.appendChild(summary);
        this._clearContext();
      },
      onError: (msg) => {
        // Show duplicate operation errors in a modal like duplicate API errors
        if (msg && (msg.includes('already exist') || msg.includes('duplicate'))) {
          this._showErrorModal(msg);
          // Clear the progress list since we're showing modal
          if (progressList) progressList.remove();
          if (statusEl) statusEl.textContent = '';
        } else {
          const line = initLine(`Error: ${msg}`);
          markLineDone(line, false);
        }
      },
      invalidate: [{ prefix: '/api/apis', params: { env: step.payload?.env || 'dev' } }],
    });
  },

  _renderBackendStrategyChooser(originalQuery, parseData) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant routing-picker';

    wrapper.innerHTML = `
      <div class="routing-picker-title"><strong>Choose backend routing strategy</strong></div>
      <div class="routing-picker-desc" style="font-size:.8rem;color:#555;margin-bottom:8px">
        Your request spans multiple hostnames. Pick how operations should be routed:
      </div>
      <div class="routing-actions">
        <button type="button" class="routing-btn pool-btn" data-strategy="pool">
          Pool (LB)
        </button>
        <button type="button" class="routing-btn standalone-btn" data-strategy="standalone">
          Per-op (Standalone)
        </button>
      </div>
      <div class="routing-picker-hints" style="font-size:.75rem;color:#777;margin-top:8px">
        <div><strong>Pool (LB):</strong> All ops route through a single load-balanced pool. Good when backends are interchangeable replicas.</div>
        <div style="margin-top:4px"><strong>Per-op (Standalone):</strong> Each operation routes to its own backend. Good when each backend serves a distinct purpose (e.g. one OpenAI host, one internal service).</div>
      </div>
    `;

    const list = document.getElementById('assistant-messages');
    if (list) {
      list.appendChild(wrapper);
      list.scrollTop = list.scrollHeight;
    }

    wrapper.querySelectorAll('.routing-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const strategy = btn.dataset.strategy;
        // Lock the card so it stays as a visual record.
        wrapper.querySelectorAll('.routing-btn').forEach(b => { b.disabled = true; });
        btn.classList.add('selected');
        // Pin the chosen strategy and repost the original query so the parser
        // can proceed with all previously-collected params intact.
        this._pinnedParams = { ...this._pinnedParams, backendStrategy: strategy };
        this._handleQuery(originalQuery);
      });
    });
  },

  _renderProductStrategyChooser(originalQuery, data) {
    const collision = (data.hints && data.hints.product_collision) || {};
    const duplicate = (data.hints && data.hints.consumer_duplicate) || {};
    const existingId = this._escape(collision.existing_id || '(unknown)');
    const existingName = this._escape(collision.existing_name || existingId);

    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant routing-picker';

    // Check if this is a consumer duplicate (already has access to API)
    if (duplicate.products && duplicate.products.length > 0) {
      const apiId = this._escape(duplicate.api_id || 'this API');
      const productsListHtml = duplicate.products.map(p =>
        `<li style="font-size:.75rem"><code>${this._escape(p.id)}</code> — ${this._escape(p.name)}</li>`
      ).join('');

      // Build product selector dropdown (if multiple products exist) - SAME AS PRODUCTS TAB
      let productSelectorHtml = '';
      if (duplicate.products.length > 1) {
        productSelectorHtml = `
          <div style="margin:8px 0;padding:8px;background:#fff;border:1px solid #dee2e6;border-radius:4px" id="assistantProductSelector">
            <label style="font-size:.75rem;font-weight:600;margin-bottom:4px;display:block">Select Product:</label>
            <select class="form-select form-select-sm" id="assistantProductDropdown" style="font-size:.8rem">
              ${duplicate.products.map(p => `<option value="${this._escape(p.id)}">${this._escape(p.name || p.id)}</option>`).join('')}
            </select>
          </div>`;
      }

      wrapper.innerHTML = `
        <div class="routing-picker-title" style="color:#dc3545"><strong>⚠️ Duplicate Detected</strong></div>
        <div class="routing-picker-desc" style="font-size:.8rem;color:#555;margin-bottom:8px">
          Consumer already has access through the following products:
          <ul style="margin:6px 0 0 20px;padding:0">${productsListHtml}</ul>
        </div>
        ${productSelectorHtml}
        <div class="routing-actions">
          <button type="button" class="routing-btn" data-strategy="use_existing" style="background:#28a745;color:white">
            ✓ Add to existing product <span style="font-size:.7rem;opacity:.8">(Recommended)</span>
          </button>
          <button type="button" class="routing-btn" data-strategy="new_with_suffix" style="background:#ffc107">
            Create new product
          </button>
        </div>
        <div class="routing-picker-hints" style="font-size:.75rem;color:#777;margin-top:8px">
          <div><strong>Add to existing:</strong> Add this API to the existing product. Subscription keys are reused.</div>
          <div style="margin-top:4px"><strong>Create new:</strong> Create a separate product with new subscription keys.</div>
        </div>
      `;
    } else {
      // Product collision (product name exists)
      wrapper.innerHTML = `
        <div class="routing-picker-title"><strong>Product <code>${existingId}</code> already exists</strong></div>
        <div class="routing-picker-desc" style="font-size:.8rem;color:#555;margin-bottom:8px">
          A product named <strong>${existingName}</strong> already exists in this environment. How should we proceed?
        </div>
        <div class="routing-actions">
          <button type="button" class="routing-btn" data-strategy="use_existing">
            Use existing <code>${existingId}</code>
          </button>
          <button type="button" class="routing-btn" data-strategy="new_with_suffix">
            Create new <code>${existingId}-2</code>
          </button>
        </div>
        <div class="routing-picker-hints" style="font-size:.75rem;color:#777;margin-top:8px">
          <div><strong>Use existing:</strong> Link this API to the existing product. Subscription keys are reused.</div>
          <div style="margin-top:4px"><strong>Create new:</strong> Create a fresh product with a numbered suffix. Generates a new subscription.</div>
        </div>
      `;
    }

    const list = document.getElementById('assistant-messages');
    if (list) {
      list.appendChild(wrapper);
      list.scrollTop = list.scrollHeight;
    }

    wrapper.querySelectorAll('.routing-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const strategy = btn.dataset.strategy;
        wrapper.querySelectorAll('.routing-btn').forEach(b => { b.disabled = true; });
        btn.classList.add('selected');

        // If duplicate with products and user chose "use_existing", get selected product from dropdown
        if (duplicate.products && duplicate.products.length > 0 && strategy === 'use_existing') {
          const dropdown = document.getElementById('assistantProductDropdown');
          const selectedProductId = dropdown ? dropdown.value : duplicate.products[0].id;
          this._pinnedParams = { ...this._pinnedParams, productStrategy: strategy, existingProductId: selectedProductId };
        } else {
          this._pinnedParams = { ...this._pinnedParams, productStrategy: strategy };
        }

        this._handleQuery(originalQuery);
      });
    });
  },

  _renderVersionChooserForDiff(originalQuery, data, slot = 'apiId') {
    const versions = (data.hints && data.hints.api_versions) || [];
    const displayName = this._escape((data.hints && data.hints.api_display_name) || 'API');

    // DEBUG: Removed - Issue identified and fixed

    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant version-picker';

    const chips = versions.map(v => {
      const id = v.id;
      const verName = v.versionName || 'Original';
      return `<button type="button" class="plan-version-chip" data-api-id="${this._escape(id)}" data-version-name="${this._escape(verName)}">${this._escape(verName)}</button>`;
    }).join('');

    wrapper.innerHTML = `
      <div class="routing-picker-title">⚠️ <strong>${displayName}</strong> has ${versions.length} versions</div>
      <div class="routing-picker-desc" style="font-size:.8rem;color:#555;margin-bottom:8px">
        Pick which version:
      </div>
      <div class="plan-version-chips">${chips}</div>
    `;

    const list = document.getElementById('assistant-messages');
    if (list) {
      list.appendChild(wrapper);
      list.scrollTop = list.scrollHeight;
    }

    wrapper.querySelectorAll('.plan-version-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const concreteId = chip.dataset.apiId;
        const verName = chip.dataset.versionName;
        wrapper.querySelectorAll('.plan-version-chip').forEach(c => {
          c.disabled = true;
          if (c === chip) c.classList.add('selected');
        });
        // Pin the selected API ID and mark that version was explicitly picked
        // Also set resolution flags to prevent backend from re-processing the API ID
        // Store display metadata for showing friendly names in UI
        const resolvedFlagName = slot === 'existingApiId' ? '_existingApiIdResolved' : '_apiIdResolved';
        const versionCheckedFlagName = '_versionChecked';
        this._pinnedParams = {
          ...this._pinnedParams,
          [slot]: concreteId,
          _versionPicked: true,
          [resolvedFlagName]: true,
          [versionCheckedFlagName]: true,
          _apiDisplayName: displayName,
          _apiVersionName: verName
        };

        // Store display metadata for friendly UI labels
        this._selectedVersionMetadata = {
          apiId: concreteId,
          displayName: displayName,
          versionName: verName
        };

        // DEBUG: Removed - Issue identified and fixed

        this._handleQuery(originalQuery);
      });
    });
  },

  _renderVersionSelector(originalQuery, data) {
    const versions = data.versions || [];
    const displayName = this._escape(data.api_display_name || 'API');
    const apiParamName = data.api_param_name || 'apiId';

    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant version-picker';

    const chips = versions.map(v => {
      const id = v.id;
      const verName = v.versionName || 'Original';
      return `<button type="button" class="plan-version-chip" data-api-id="${this._escape(id)}" data-version-name="${this._escape(verName)}">${this._escape(verName)}</button>`;
    }).join('');

    wrapper.innerHTML = `
      <div class="routing-picker-title">⚠️ <strong>${displayName}</strong> has ${versions.length} versions</div>
      <div class="routing-picker-desc" style="font-size:.8rem;color:#555;margin-bottom:8px">
        Pick which version:
      </div>
      <div class="plan-version-chips">${chips}</div>
    `;

    const list = document.getElementById('assistant-messages');
    if (list) {
      list.appendChild(wrapper);
      list.scrollTop = list.scrollHeight;
    }

    wrapper.querySelectorAll('.plan-version-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const concreteId = chip.dataset.apiId;
        const verName = chip.dataset.versionName;
        wrapper.querySelectorAll('.plan-version-chip').forEach(c => {
          c.disabled = true;
          if (c === chip) c.classList.add('selected');
        });
        // Pin the selected API ID and mark that version was selected
        const versionFlag = `_versionSelected_${apiParamName}`;
        this._pinnedParams = {
          ...this._pinnedParams,
          [apiParamName]: concreteId,
          [versionFlag]: true
        };
        this._handleQuery(originalQuery);
      });
    });
  },

  _renderEnvCandidatesChooser(originalQuery, data, slot = 'env') {
    const candidates = (data.hints && data.hints.env_candidates) || [];
    const query = this._escape((data.hints && data.hints.env_query) || '');

    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant routing-picker';

    const buttonsHTML = candidates.map(c => {
      const env = this._escape(c.env);
      const id = this._escape(c.id);
      const dn = this._escape(c.display_name || '');
      const tag = this._escape(c.match);
      return `<button type="button" class="routing-btn" data-env="${env}">
        <strong>${env}</strong> — <code>${id}</code>${dn ? ` (${dn})` : ''} <span style="color:#888;font-size:.7rem">[${tag}]</span>
      </button>`;
    }).join('');

    wrapper.innerHTML = `
      <div class="routing-picker-title"><strong>Found <code>${query}</code> in ${candidates.length} env(s)</strong></div>
      <div class="routing-picker-desc" style="font-size:.8rem;color:#555;margin-bottom:8px">Pick which environment:</div>
      <div class="routing-actions" style="display:flex;flex-direction:column;gap:4px">${buttonsHTML}</div>
    `;

    const list = document.getElementById('assistant-messages');
    if (list) {
      list.appendChild(wrapper);
      list.scrollTop = list.scrollHeight;
    }

    wrapper.querySelectorAll('.routing-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const env = btn.dataset.env;
        wrapper.querySelectorAll('.routing-btn').forEach(b => { b.disabled = true; });
        btn.classList.add('selected');
        this._pinnedParams = { ...this._pinnedParams, [slot]: env };
        this._handleQuery(originalQuery);
      });
    });
  },

  _renderApiIdChooser(originalQuery, data, slot = 'apiId') {
    const candidates = (data.hints && data.hints[slot + '_candidates']) || [];
    const query = this._escape((data.hints && data.hints[slot + '_query']) || '');
    const notFound = !!(data.hints && data.hints[slot + '_not_found']);

    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant routing-picker';

    const titleHTML = notFound
      ? `<strong>API <code>${query}</code> not found in this environment</strong>`
      : `<strong>Multiple APIs match <code>${query}</code></strong>`;
    const descHTML = notFound
      ? (candidates.length
          ? 'Did you mean one of these?'
          : 'No close matches. Try typing the API id or display name.')
      : 'Pick which one you meant:';

    const buttonsHTML = candidates.map(c => {
      const id = this._escape(c.id);
      const dn = this._escape(c.display_name || c.id);
      return `<button type="button" class="routing-btn" data-api-id="${id}">
        <code>${id}</code>${c.display_name ? ` — ${dn}` : ''}
      </button>`;
    }).join('');

    wrapper.innerHTML = `
      <div class="routing-picker-title">${titleHTML}</div>
      <div class="routing-picker-desc" style="font-size:.8rem;color:#555;margin-bottom:8px">${descHTML}</div>
      <div class="routing-actions" style="display:flex;flex-direction:column;gap:4px">${buttonsHTML}</div>
    `;

    const list = document.getElementById('assistant-messages');
    if (list) {
      list.appendChild(wrapper);
      list.scrollTop = list.scrollHeight;
    }

    wrapper.querySelectorAll('.routing-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const apiId = btn.dataset.apiId;
        wrapper.querySelectorAll('.routing-btn').forEach(b => { b.disabled = true; });
        btn.classList.add('selected');
        this._pinnedParams = {
          ...this._pinnedParams,
          [slot]: apiId,
          [`_${slot}Resolved`]: true,
        };
        this._handleQuery(originalQuery);
      });
    });
  },

  _renderCertUploadCard(originalQuery, data) {
    const env = this._escape((data.hints && data.hints.cert_upload_target_env) || 'sandbox');
    const suggestedId = this._escape((data.hints && data.hints.cert_upload_suggested_id) || 'uploaded-client-cert');

    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant routing-picker';
    wrapper.innerHTML = `
      <div class="routing-picker-title"><strong>Upload client certificate for backend mTLS</strong></div>
      <div class="routing-picker-desc" style="font-size:.8rem;color:#555;margin-bottom:8px">
        Cert will be uploaded to <code>${env}</code> as <code>${suggestedId}</code> (or reused if a cert with the same thumbprint already exists).
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:.8rem">
        <label>Client cert file (.pfx/.cer):
          <input type="file" class="cert-file-input" accept=".pfx,.p12,.cer,.crt" style="display:block;margin-top:4px" />
        </label>
        <label>Cert password (leave blank if none):
          <input type="password" class="cert-pw-input" autocomplete="off" style="display:block;width:100%;margin-top:4px;padding:4px" />
        </label>
        <label>
          <input type="checkbox" class="ca-toggle" /> Also upload CA certificate
        </label>
        <div class="ca-fields" style="display:none;padding-left:16px;border-left:2px solid #ddd;margin-left:4px">
          <label>CA cert file:
            <input type="file" class="ca-file-input" accept=".pfx,.p12,.cer,.crt" style="display:block;margin-top:4px" />
          </label>
          <label>CA cert password:
            <input type="password" class="ca-pw-input" autocomplete="off" style="display:block;width:100%;margin-top:4px;padding:4px" />
          </label>
          <label>Store:
            <select class="ca-store-input" style="display:block;margin-top:4px;padding:4px">
              <option value="Root">Root</option>
              <option value="CertificateAuthority">CertificateAuthority</option>
            </select>
          </label>
        </div>
        <div class="cert-error" style="color:#c00;font-size:.75rem;display:none"></div>
        <button type="button" class="upload-cert-btn routing-btn" style="margin-top:6px">Upload and continue</button>
      </div>
    `;

    const list = document.getElementById('assistant-messages');
    if (list) {
      list.appendChild(wrapper);
      list.scrollTop = list.scrollHeight;
    }

    const caToggle = wrapper.querySelector('.ca-toggle');
    const caFields = wrapper.querySelector('.ca-fields');
    caToggle.addEventListener('change', () => {
      caFields.style.display = caToggle.checked ? 'block' : 'none';
    });

    const errorEl = wrapper.querySelector('.cert-error');
    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    };
    const clearError = () => { errorEl.style.display = 'none'; };

    const baseUrl = (typeof API !== 'undefined' && API.baseUrl) ? API.baseUrl : 'http://localhost:5050';

    const btn = wrapper.querySelector('.upload-cert-btn');
    btn.addEventListener('click', async () => {
      clearError();
      const certFile = wrapper.querySelector('.cert-file-input').files[0];
      const certPw = wrapper.querySelector('.cert-pw-input').value;
      if (!certFile) {
        showError('Please choose a client cert file.');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Uploading...';
      try {
        const fd = new FormData();
        fd.append('file', certFile);
        fd.append('password', certPw);
        fd.append('env', env);
        fd.append('suggested_id', suggestedId);
        const r = await fetch(baseUrl + '/api/certificates/upload', { method: 'POST', body: fd });
        const j = await r.json();
        if (!j.ok) {
          showError('Upload failed: ' + (j.error || ('HTTP ' + r.status)));
          btn.disabled = false;
          btn.textContent = 'Upload and continue';
          return;
        }
        const thumbprint = j.thumbprint;

        // Optional CA upload
        if (caToggle.checked) {
          const caFile = wrapper.querySelector('.ca-file-input').files[0];
          if (caFile) {
            const fdca = new FormData();
            fdca.append('file', caFile);
            fdca.append('password', wrapper.querySelector('.ca-pw-input').value);
            fdca.append('env', env);
            fdca.append('suggested_id', suggestedId.replace('-client-cert', '-ca-cert'));
            fdca.append('store_name', wrapper.querySelector('.ca-store-input').value);
            const rca = await fetch(baseUrl + '/api/ca-certificates/upload', { method: 'POST', body: fdca });
            const jca = await rca.json();
            if (!jca.ok) {
              showError('CA upload failed: ' + (jca.error || ('HTTP ' + rca.status)) + ' — proceeding without CA.');
              // fall through; client cert is still uploaded
            }
          }
        }

        // Pin and re-submit
        wrapper.querySelectorAll('input, button, select').forEach(el => { el.disabled = true; });
        btn.textContent = '✓ Uploaded — continuing';
        wrapper.classList.add('plan-cancelled');
        this._pinnedParams = {
          ...this._pinnedParams,
          backendCertThumbprint: thumbprint,
          backendCertAuth: true,
        };
        this._handleQuery(originalQuery);
      } catch (e) {
        showError('Upload error: ' + (e.message || e));
        btn.disabled = false;
        btn.textContent = 'Upload and continue';
      }
    });
  },

  async _fetchExistingBackendPools(apiId, env) {
    // Fetches existing backend pools mapped to this API
    // Returns array of {id, name, memberCount} objects
    const apiMappedPools = [];

    try {
      // Extract unique backend IDs from both API-level and operation-level policies
      const poolBackendIds = new Set();

      // Check API-level policy first (most common location for pools)
      try {
        const apiPolicyData = await API.get(`/api/apis/${apiId}/policies/policy`, { env });
        const apiPolicyXml = apiPolicyData?.raw || apiPolicyData?.properties?.value || '';

        let backendMatch = apiPolicyXml.match(/backend-id=["']([^"']+)["']/);
        if (!backendMatch) {
          backendMatch = apiPolicyXml.match(/<set-backend-service[^>]*backend-id=["']([^"']+)["']/);
        }
        if (backendMatch) {
          poolBackendIds.add(backendMatch[1]);
        }
      } catch (e) {
        // API-level policy may not exist
      }

      // Also check operation-level policies
      const operations = await API.get(`/api/apis/${apiId}/operations`, { env });
      const ops = operations?.value || [];

      for (const op of ops) {
        try {
          const opId = op.name;
          const policyData = await API.get(`/api/apis/${apiId}/operations/${opId}/policies/policy`, { env });
          const policyXml = policyData?.raw || policyData?.properties?.value || '';

          // Try multiple patterns to extract backend
          let backendMatch = policyXml.match(/backend-id=["']([^"']+)["']/);
          if (!backendMatch) {
            backendMatch = policyXml.match(/<set-backend-service[^>]*backend-id=["']([^"']+)["']/);
          }
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
          const apiPolicyData = await API.get(`/api/apis/${apiId}/policies/policy`, { env });
          const apiPolicyXml = apiPolicyData?.raw || apiPolicyData?.properties?.value || '';

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
          // Silently continue
        }
      }

      // Fetch details for each backend to check if it's a pool
      for (const backendId of poolBackendIds) {
        try {
          const details = await API.get(`/api/backends/${backendId}`, { env });
          const backendType = details?.properties?.type;
          const hasPoolProperty = details?.properties?.pool;

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
          continue;
        }
      }

      // ADDITIONAL CHECK: Find pools that contain the API's backends as members
      try {
        const allPools = await API.get('/api/backends/pools/list', { env });

        let pools = [];
        if (Array.isArray(allPools)) {
          pools = allPools;
        } else if (allPools?.value && Array.isArray(allPools.value)) {
          pools = allPools.value;
        } else if (allPools?.pools && Array.isArray(allPools.pools)) {
          pools = allPools.pools;
        }

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

    return apiMappedPools;
  },

  async _askRoutingDecision(host, group, apiInfo, env, userRequestedCb = false) {
    return new Promise(async (resolve) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'msg msg-assistant routing-picker';
      const opCount = (group.urls || []).length;
      const inEnvNote = group.classification === 'in_env'
        ? `<div class="routing-note">Backend <code>${this._escape(group.existing_backend_id || '')}</code> already exists in this env for this host — we'll reuse it.</div>`
        : '';

      // Fetch existing backend pools for this API
      const existingPools = await this._fetchExistingBackendPools(apiInfo.id, env);
      const hasExistingPools = existingPools.length > 0;

      // Build pool dropdown HTML if pools exist
      let poolDropdownHtml = '';
      if (hasExistingPools) {
        poolDropdownHtml = `
          <select class="form-select form-select-sm mt-2" id="existingPoolSelect" style="font-size:.85rem;max-width:300px">
            ${existingPools.map(pool => `
              <option value="${this._escape(pool.id)}">${this._escape(pool.name || pool.id)} (${pool.memberCount} member${pool.memberCount !== 1 ? 's' : ''})</option>
            `).join('')}
          </select>
        `;
      }

      // Build radio button UI matching create tab style
      wrapper.innerHTML = `
        <div class="mb-3">
          <strong>${this._escape(host)}</strong> doesn't match this API's current backend
          (${opCount} new op${opCount === 1 ? '' : 's'} affected). How should I route these?
        </div>
        ${inEnvNote}

        <div class="border rounded p-3 mb-3" style="background:#f8f9fa">
          <div class="fw-semibold mb-3" style="font-size:.85rem">
            <i class="bi bi-diagram-3 me-1 text-primary"></i>Backend Strategy
          </div>

          ${hasExistingPools ? `
            <div class="form-check mb-3">
              <input class="form-check-input" type="radio" name="backendStrategy" id="addToExistingPool" value="addToExisting" checked>
              <label class="form-check-label" for="addToExistingPool" style="font-size:.85rem">
                <i class="bi bi-plus-square text-success me-1"></i>
                <strong>Add to existing pool</strong>
                <span class="badge bg-success" style="font-size:.65rem">${existingPools.length} available</span>
                <br><small class="text-muted ms-3">Add this host to an existing pool for this API</small>
                ${poolDropdownHtml}
              </label>
            </div>
          ` : ''}

          <div class="form-check mb-3">
            <input class="form-check-input" type="radio" name="backendStrategy" id="createNewPool" value="createNew" ${hasExistingPools ? '' : 'checked'}>
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

        <div class="d-flex gap-2">
          <button type="button" class="btn btn-primary btn-sm apply-btn">
            <i class="bi bi-check-circle me-1"></i>Apply
          </button>
          <button type="button" class="btn btn-secondary btn-sm cancel-btn">Cancel</button>
        </div>
      `;
      document.getElementById('assistant-messages').appendChild(wrapper);

      const finalize = () => {
        wrapper.querySelectorAll('button, input').forEach(el => el.disabled = true);
        const selectedRadio = wrapper.querySelector('input[name="backendStrategy"]:checked');
        if (selectedRadio) {
          selectedRadio.parentElement.style.backgroundColor = '#e7f3ff';
        }
      };

      // Cancel button handler
      wrapper.querySelector('.cancel-btn').addEventListener('click', () => {
        finalize();
        resolve(null);
      });

      // Apply button handler - reads selected radio and processes accordingly
      wrapper.querySelector('.apply-btn').addEventListener('click', async () => {
        const selectedRadio = wrapper.querySelector('input[name="backendStrategy"]:checked');
        if (!selectedRadio) {
          resolve(null);
          return;
        }

        const selectedValue = selectedRadio.value;
        finalize();

        // Handle based on selected strategy
        if (selectedValue === 'addToExisting') {
          // Add to existing pool
          const selectedPoolId = document.getElementById('existingPoolSelect')?.value;
          if (!selectedPoolId) {
            resolve(null);
            return;
          }

          // Ask for priority and weight for the new pool member
          const priority = await this._askNumberInput(
            'Priority?',
            { min: 1, max: 10, defaultValue: 1, allowSkip: true }
          );
          if (priority === null) { resolve(null); return; }

          const weight = await this._askNumberInput(
            'Weight?',
            { min: 1, max: 100, defaultValue: 50, allowSkip: true }
          );
          if (weight === null) { resolve(null); return; }

          resolve({
            strategy: 'add_to_existing_pool',
            existing_pool_id: selectedPoolId,
            pool_priority: priority,
            pool_weight: weight,
          });

        } else if (selectedValue === 'createNew') {
          // Create new pool
          // Follow-up: ask for algorithm, then CB (only if user requested), then priority + weight
          const algo = await this._askPickOne(
            'LB algorithm?',
            [{ id: 'roundRobin', label: 'Round robin' }, { id: 'weighted', label: 'Weighted' }, { id: 'priority', label: 'Priority' }],
          );
          if (!algo) { resolve(null); return; }

          // Only ask for circuit breaker if user explicitly requested it in their query
          let cb = 'no';
          let cbConfig = null;
          if (userRequestedCb) {
            cb = await this._askPickOne(
              'Circuit breaker?',
              [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }],
            );
            if (!cb) { resolve(null); return; }

            // If user wants CB, ask for specific values BEFORE applying
            if (cb === 'yes') {
              const failureCount = await this._askNumberInput(
                'Failure count?',
                { min: 1, max: 20, defaultValue: 5, allowSkip: true }
              );
              if (failureCount === null) { resolve(null); return; }

              const intervalSeconds = await this._askNumberInput(
                'Interval (seconds)?',
                { min: 10, max: 300, defaultValue: 60, allowSkip: true }
              );
              if (intervalSeconds === null) { resolve(null); return; }

              const tripDuration = await this._askNumberInput(
                'Trip duration (seconds)?',
                { min: 10, max: 300, defaultValue: 30, allowSkip: true }
              );
              if (tripDuration === null) { resolve(null); return; }

              cbConfig = {
                failure_count: failureCount,
                interval_seconds: intervalSeconds,
                trip_duration_seconds: tripDuration
              };
            }
          }

          // Ask for priority and weight for the new pool member
          const priority = await this._askNumberInput(
            'Priority?',
            { min: 1, max: 10, defaultValue: 1, allowSkip: true }
          );
          if (priority === null) { resolve(null); return; }

          const weight = await this._askNumberInput(
            'Weight?',
            { min: 1, max: 100, defaultValue: 50, allowSkip: true }
          );
          if (weight === null) { resolve(null); return; }

          resolve({
            strategy: 'pool',
            lb_algorithm: algo,
            enable_cb: cb === 'yes',
            cb_config: cbConfig,
            pool_priority: priority,
            pool_weight: weight,
          });

        } else if (selectedValue === 'keepIndividual') {
          // Keep as individual backends
          resolve({ strategy: 'individual' });

        } else {
          resolve(null);
        }
      });
    });
  },

  _askPickOne(promptText, options) {
    return new Promise((resolve) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'msg msg-assistant routing-picker';
      const buttons = options.map(o => `<button type="button" class="routing-btn" data-id="${this._escape(o.id)}">${this._escape(o.label)}</button>`).join('');
      wrapper.innerHTML = `
        <div>${this._escape(promptText)}</div>
        <div class="routing-actions">${buttons}<button type="button" class="routing-btn cancel-btn">Cancel</button></div>
      `;
      document.getElementById('assistant-messages').appendChild(wrapper);
      wrapper.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          wrapper.querySelectorAll('button').forEach(b => { b.disabled = true; });
          btn.classList.add('selected');
          if (btn.classList.contains('cancel-btn')) {
            resolve(null);
          } else {
            resolve(btn.dataset.id);
          }
        });
      });
    });
  },

  _askNumberInput(promptText, opts = {}) {
    return new Promise((resolve) => {
      const { min = 1, max = 100, defaultValue = 1, allowSkip = true } = opts;
      const wrapper = document.createElement('div');
      wrapper.className = 'msg msg-assistant routing-picker';
      const skipBtn = allowSkip ? '<button type="button" class="routing-btn skip-btn">Use default</button>' : '';
      wrapper.innerHTML = `
        <div style="margin-bottom:8px">${this._escape(promptText)}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <input type="number" class="number-input" min="${min}" max="${max}" value="${defaultValue}"
                 style="padding:6px;border:1px solid #ccc;border-radius:4px;width:100px;font-size:.9rem" />
          <button type="button" class="routing-btn ok-btn">OK</button>
          ${skipBtn}
          <button type="button" class="routing-btn cancel-btn">Cancel</button>
        </div>
      `;
      document.getElementById('assistant-messages').appendChild(wrapper);

      const input = wrapper.querySelector('.number-input');
      const okBtn = wrapper.querySelector('.ok-btn');
      const skipBtn_el = wrapper.querySelector('.skip-btn');
      const cancelBtn = wrapper.querySelector('.cancel-btn');

      const finalize = (value) => {
        wrapper.querySelectorAll('button').forEach(b => { b.disabled = true; });
        input.disabled = true;
        if (value !== null) {
          okBtn.classList.add('selected');
        }
        resolve(value);
      };

      okBtn.addEventListener('click', () => {
        const val = parseInt(input.value, 10);
        if (isNaN(val) || val < min || val > max) {
          input.style.borderColor = 'red';
          return;
        }
        finalize(val);
      });

      if (skipBtn_el) {
        skipBtn_el.addEventListener('click', () => {
          finalize(defaultValue);
        });
      }

      cancelBtn.addEventListener('click', () => {
        finalize(null);
      });

      // Allow Enter key to submit
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          okBtn.click();
        }
      });
    });
  },

  async _executeAnalyze(query) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg msg-assistant analyze-bubble';
    const toolsEl = document.createElement('div');
    toolsEl.className = 'analyze-tools';
    const finalEl = document.createElement('div');
    finalEl.className = 'analyze-final';
    wrapper.appendChild(toolsEl);
    wrapper.appendChild(finalEl);
    const list = document.getElementById('assistant-messages');
    list.appendChild(wrapper);
    list.scrollTop = list.scrollHeight;

    const url = `${API.baseUrl}/api/assistant/analyze`;
    let finalText = '';
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          history: this._history,
          session_id: this._ensureSessionId(),
        }),
      });
      if (!resp.ok) {
        finalEl.textContent = `Error: HTTP ${resp.status}`;
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          if (!block.startsWith('data:')) continue;
          try {
            const event = JSON.parse(block.slice(5).trim());
            const out = this._handleAnalyzeEvent(event, toolsEl, finalEl);
            if (out && out.finalText) finalText = out.finalText;
            list.scrollTop = list.scrollHeight;
          } catch (e) { /* ignore malformed event */ }
        }
      }
    } catch (e) {
      finalEl.textContent = `Error: ${e.message || 'Connection failed'}`;
      return;
    }
    // Add to history so follow-up questions have context
    this._pushHistory({ role: 'user', content: query });
    if (finalText) this._pushHistory({ role: 'assistant', content: finalText.slice(0, 4000) });
  },

  _handleAnalyzeEvent(event, toolsEl, finalEl) {
    const e = event.event;
    const d = event.data || {};
    if (e === 'started') {
      // Single rolling status line; gets rewritten in place per tool event.
      toolsEl.innerHTML = `<div class="analyze-status pending"><span class="analyze-tool-spinner">●</span> <span class="analyze-status-text">Thinking…</span></div>`;
      return null;
    }
    if (e === 'tool_call_start') {
      const txt = toolsEl.querySelector('.analyze-status-text');
      if (txt) txt.textContent = `Processing…`;
      return null;
    }
    if (e === 'tool_call_done') {
      // Keep showing "Processing..." - don't update with tool details
      return null;
    }
    if (e === 'final_answer') {
      // Drop the rolling status; show only the answer.
      toolsEl.innerHTML = '';
      finalEl.innerHTML = this._renderMarkdown(d.text || '');
      return { finalText: d.text || '' };
    }
    if (e === 'tool_confirmation_required') {
      // Pause status while gate is up.
      const txt = toolsEl.querySelector('.analyze-status-text');
      if (txt) txt.textContent = 'Waiting for your confirmation…';
      this._renderConfirmationGate(d, toolsEl);
      return null;
    }
    if (e === 'version_selection_required') {
      // Pause status while version selection is pending.
      const txt = toolsEl.querySelector('.analyze-status-text');
      if (txt) txt.textContent = 'Select a version…';
      this._renderVersionSelectionGate(d, toolsEl);
      return null;
    }
    if (e === 'error') {
      toolsEl.innerHTML = `<div class="analyze-status error">Error: ${this._escape(d.message || 'unknown')}</div>`;
      return null;
    }
    return null;
  },

  _renderConfirmationGate(batch, parentEl) {
    const wrapper = document.createElement('div');
    wrapper.className = 'analyze-gate';
    const requiresPassword = !!batch.requires_password;

    const toolList = (batch.tools || []).map(t => {
      const flags = [];
      if (t.requires_password) flags.push('<span class="gate-flag destructive">DESTRUCTIVE</span>');
      else if (t.mutates) flags.push('<span class="gate-flag mutates">MUTATES</span>');
      return `<div class="gate-tool">
        <code>${this._escape(t.name)}</code> ${flags.join('')}
        <div class="gate-preview">${this._escape(t.preview || '')}</div>
      </div>`;
    }).join('');

    const passwordRow = requiresPassword
      ? `<div class="gate-password-row">
           <label>Admin password:</label>
           <input type="password" class="gate-password" autocomplete="off" />
         </div>`
      : '';

    const headerText = requiresPassword
      ? '⚠ DESTRUCTIVE — admin password required:'
      : 'The assistant wants to make changes:';

    wrapper.innerHTML = `
      <div class="gate-header">${this._escape(headerText)}</div>
      <div class="gate-tools">${toolList}</div>
      ${passwordRow}
      <div class="gate-actions">
        <button type="button" class="gate-btn gate-confirm">${requiresPassword ? 'Confirm with password' : 'Confirm all'}</button>
        <button type="button" class="gate-btn gate-cancel">Cancel</button>
      </div>
      <div class="gate-status"></div>
    `;
    parentEl.appendChild(wrapper);

    const finalize = (decision) => {
      const password = requiresPassword
        ? (wrapper.querySelector('.gate-password')?.value || '')
        : null;
      if (decision === 'confirm' && requiresPassword && !password) {
        wrapper.querySelector('.gate-status').textContent = 'Password required.';
        return;
      }
      wrapper.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
      wrapper.classList.add('resolved-' + decision);
      wrapper.querySelector('.gate-status').textContent = decision === 'confirm' ? 'Submitted, executing…' : 'Cancelled.';

      fetch(`${API.baseUrl}/api/assistant/analyze/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this._sessionId,
          batch_id: batch.batch_id,
          decision,
          password,
        }),
      }).catch(() => { /* worker will time out on its own */ });
    };

    wrapper.querySelector('.gate-confirm').addEventListener('click', () => finalize('confirm'));
    wrapper.querySelector('.gate-cancel').addEventListener('click', () => finalize('cancel'));
  },

  _renderVersionSelectionGate(selectionData, parentEl) {
    const wrapper = document.createElement('div');
    wrapper.className = 'analyze-gate version-selector';

    const versions = selectionData.versions || [];
    const versionChips = versions.map(v => {
      const isCurrent = v.isCurrent ? '<span class="version-current-badge">current</span>' : '';
      return `<button type="button" class="version-chip" data-version-id="${this._escape(v.id)}">
        <span class="version-name">${this._escape(v.versionName || 'Original')}</span>
        ${isCurrent}
        <span class="version-rev">Rev ${this._escape(v.revision || '1')}</span>
      </button>`;
    }).join('');

    wrapper.innerHTML = `
      <div class="gate-header">Select version for "${this._escape(selectionData.api_display_name)}":</div>
      <div class="version-chips">${versionChips}</div>
      <div class="gate-status"></div>
    `;
    parentEl.appendChild(wrapper);

    const finalize = (versionId) => {
      wrapper.querySelectorAll('button').forEach(el => { el.disabled = true; });
      wrapper.classList.add('resolved-selected');
      wrapper.querySelector('.gate-status').textContent = 'Version selected, continuing…';

      fetch(`${API.baseUrl}/api/assistant/analyze/select-version`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this._sessionId,
          selection_id: selectionData.selection_id,
          version_id: versionId,
        }),
      }).catch(() => { /* worker will time out on its own */ });
    };

    wrapper.querySelectorAll('.version-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const versionId = btn.getAttribute('data-version-id');
        finalize(versionId);
      });
    });
  },

  _fmtArgs(args) {
    if (!args || typeof args !== 'object') return '';
    return Object.entries(args).map(([k, v]) => {
      const val = typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
      return `${k}=${val}`;
    }).join(', ');
  },

  _renderMarkdown(text) {
    // HTML-escape first, THEN apply markdown formatting — defense in depth.
    let html = this._escape(text);
    // Code blocks ```...```
    html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
    // Inline code `...`
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    // Bold **...**
    html = html.replace(/\*\*([^\*\n]+)\*\*/g, '<strong>$1</strong>');
    // Italic *...* (but not inside ** which is already replaced)
    html = html.replace(/(^|[^\*])\*([^\*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    // Tables: lines starting with |
    html = html.replace(/((?:^\|.*\|\s*\n?)+)/gm, (block) => {
      const rows = block.trim().split('\n').filter(r => r.trim().startsWith('|'));
      if (rows.length < 2) return block;
      const isSep = (r) => /^\|[\s\-:|]+\|\s*$/.test(r.trim());
      const parseRow = (r) => {
        const t = r.trim();
        const inner = t.startsWith('|') ? t.slice(1) : t;
        const trimmed = inner.endsWith('|') ? inner.slice(0, -1) : inner;
        return trimmed.split('|').map(c => c.trim());
      };
      const header = parseRow(rows[0]);
      const dataRows = rows.slice(isSep(rows[1]) ? 2 : 1).map(parseRow);
      let table = '<table class="analyze-table"><thead><tr>';
      header.forEach(h => table += `<th>${h}</th>`);
      table += '</tr></thead><tbody>';
      dataRows.forEach(r => {
        table += '<tr>';
        r.forEach(c => table += `<td>${c}</td>`);
        table += '</tr>';
      });
      table += '</tbody></table>';
      return table;
    });
    // Lists
    html = html.replace(/((?:^[\-\*] .*\n?)+)/gm, (block) => {
      const items = block.trim().split('\n').filter(l => /^[\-\*] /.test(l)).map(l => `<li>${l.replace(/^[\-\*] /, '')}</li>`).join('');
      return `<ul>${items}</ul>`;
    });
    // Paragraphs (split on blank lines, wrap raw text in <p>)
    html = html.split(/\n{2,}/).map(p => {
      const t = p.trim();
      if (!t) return '';
      if (t.startsWith('<')) return t;
      return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    }).join('');
    return html;
  },

  _executePost(plan, step, statusEl, planWrapper, requiresPassword) {
    let requestStarted = false;
    let wrapper = statusEl ? statusEl.parentElement : null;
    let progressList = null;
    const seen = new Set();

    API.postSSE(step.endpoint, step.payload, {
      onStep: (event) => {
        if (!requestStarted) {
          // First event received - auth was successful
          requestStarted = true;

          // Remove plan actions and show progress
          if (planWrapper) {
            const planActions = planWrapper.querySelector('.plan-actions');
            if (planActions) planActions.remove();
            const status = document.createElement('div');
            status.className = 'plan-status';
            status.textContent = 'Running…';
            planWrapper.appendChild(status);
            statusEl = status;
            wrapper = planWrapper;
          }

          // Create progress list
          progressList = document.createElement('div');
          progressList.className = 'sse-progress';
          if (wrapper) wrapper.appendChild(progressList);
          if (statusEl) statusEl.textContent = '';
        }

        if (event.message && !seen.has(event.message)) {
          seen.add(event.message);
          this._appendSseLine(progressList, event.message, false);
        }
        this._markPreviousLinesDone(progressList);
      },
      onDone: (event) => {
        const lines = progressList.querySelectorAll('.sse-line');
        lines.forEach(l => {
          l.querySelector('.sse-mark').textContent = '✓';
          l.classList.add('done');
        });
        const summary = document.createElement('div');
        summary.className = 'sse-summary';
        const s = event.summary || {};
        const tplId = plan?.template_id || '';

        // Promotion-specific success message
        if (tplId === 'promote_api' && s.api_id) {
          const apiName = s.api_name || s.api_id;
          const apiPath = s.api_path ? ` <code>${this._escape(s.api_path)}</code>` : '';
          summary.innerHTML = `<strong>✓ Promoted ${this._escape(apiName)}</strong>${apiPath}<br>` +
                              `<small>${this._escape(s.src)} → ${this._escape(s.dest)} (revision ${this._escape(s.revision || '1')})</small>`;
        } else {
          // Generic success message for other operations
          const apiId = s.api_id || step.payload?.name || 'API';
          summary.innerHTML = `<strong>Done — ${this._escape(apiId)} in ${this._escape(step.payload?.env || 'dev')}.</strong>`;
        }

        progressList.appendChild(summary);
        // Subscription keys live nested under summary.keys (per onboard_service);
        // also accept the flat shape for backwards compat with other endpoints.
        const k = s.keys || s;
        if (k.primaryKey || k.secondaryKey) {
          this._appendRevealKeys(progressList, k.primaryKey, k.secondaryKey);
        }
        // After create_api/create_api_with_lb only — nudge to onboard a consumer
        const isCreate = tplId === 'create_api' || tplId === 'create_api_with_lb';
        if (isCreate) {
          const apiName = step.payload?.name || s.api_id || '';
          const env = step.payload?.env || 'dev';
          this._appendCreateApiNudge(apiName, env);
        }
        this._clearContext();
      },
      onError: (msg, errorCode) => {
        // Check if this is a password error and we haven't started yet
        if ((errorCode === 'admin_password_invalid' || msg === 'Incorrect admin password') && !requestStarted && planWrapper && requiresPassword) {
          // Show error in the plan card and keep gate open
          const pwErr = planWrapper.querySelector('.plan-password-err');
          if (pwErr) {
            pwErr.style.display = '';
            pwErr.textContent = 'Incorrect admin password. Please try again.';
          }
          // Re-enable the confirm button
          const confirmBtn = planWrapper.querySelector('.btn-confirm');
          if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm';
          }
          // Clear the password field and focus it
          const pwInput = planWrapper.querySelector('.plan-admin-password');
          if (pwInput) {
            pwInput.value = '';
            pwInput.focus();
          }
          Toast.show('Incorrect admin password', 'error');
          return;
        }

        // For other errors or if request already started, show in progress list
        if (!requestStarted && planWrapper) {
          // Remove plan actions and show error
          const planActions = planWrapper.querySelector('.plan-actions');
          if (planActions) planActions.remove();
          const status = document.createElement('div');
          status.className = 'plan-status';
          planWrapper.appendChild(status);
          statusEl = status;
          wrapper = planWrapper;
          progressList = document.createElement('div');
          progressList.className = 'sse-progress';
          wrapper.appendChild(progressList);
          statusEl.textContent = '';
        }

        // Show duplicate API/operation errors in a modal like in parse phase
        if (msg && (msg.includes('already exist') || msg.includes('duplicate'))) {
          this._showErrorModal(msg);
          // Clear the progress list since we're showing modal
          if (progressList) progressList.remove();
          if (statusEl) statusEl.textContent = '';
        } else {
          if (progressList) {
            this._appendSseLine(progressList, msg, true);
          }
        }
      },
      onMissingResource: async (evt) => {
        // Handle missing backend URL mapping (occurs during promotion)
        if (evt._type === 'session') {
          // Just store the session ID, don't show anything yet
          return;
        }
        // Show error - Smart Assistant doesn't support interactive resource mapping
        const errorMsg = 'Backend URL mapping required. Please use the Promote tab for this promotion.';
        this._appendSseLine(progressList, errorMsg, true);
        this._appendAssistant('This promotion requires manual backend URL mapping. Please use the Promote tab which provides an interactive dialog for mapping URLs.', 'system-note');
      },
      invalidate: [{ prefix: '/api/apis', params: { env: step.payload?.env || 'dev' } }],
    });
  },
};

Router.register('assistant', Assistant);
