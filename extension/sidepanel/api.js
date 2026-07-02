const AZURE_ERRORS = {
  401: "Azure credentials invalid - check tenant/client/secret in Settings",
  403: "Service principal lacks access to this APIM instance",
  404: "APIM instance or resource not found",
  429: "Azure rate limit hit - please wait and retry",
};

function azureErrorMessage(status, serverMessage) {
  return AZURE_ERRORS[status] || serverMessage || `HTTP ${status}`;
}

const Events = {
  _listeners: {},
  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  },
  off(event, callback) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
  },
  emit(event, data) {
    if (!this._listeners[event]) return;
    this._listeners[event].forEach(cb => cb(data));
  }
};

const Cache = {
  _store: {},
  TTL: 30 * 60 * 1000,

  _key(path, params) {
    const sorted = Object.entries(params).sort(([a],[b]) => a.localeCompare(b));
    return path + '?' + sorted.map(([k,v]) => `${k}=${v}`).join('&');
  },

  get(path, params = {}) {
    const key = this._key(path, params);
    const entry = this._store[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > this.TTL) { delete this._store[key]; return null; }
    return entry.data;
  },

  set(path, params, data) {
    const key = this._key(path, params);
    this._store[key] = { data, ts: Date.now() };
  },

  // Invalidate every entry whose key starts with `pathPrefix`.
  // If `paramFilter` is supplied, only entries whose params include all
  // listed key=value pairs are removed. Both arguments optional:
  //   invalidate()                              // clear everything
  //   invalidate('/api/products')               // all envs
  //   invalidate('/api/products', { env: 'dev' }) // just dev
  // Assumes param values never contain a literal '&' — true for our keys
  // (env names, API IDs, slugs). Don't pass user-supplied display names here.
  invalidate(pathPrefix, paramFilter) {
    if (!pathPrefix) { this._store = {}; return; }
    const filterEntries = paramFilter ? Object.entries(paramFilter) : [];
    for (const key of Object.keys(this._store)) {
      if (!key.startsWith(pathPrefix)) continue;
      if (filterEntries.length === 0) { delete this._store[key]; continue; }
      const queryString = key.slice(key.indexOf('?') + 1);
      const matches = filterEntries.every(([k, v]) =>
        queryString.split('&').includes(`${k}=${v}`)
      );
      if (matches) delete this._store[key];
    }
  },

  clear() { this._store = {}; },
  get size() { return Object.keys(this._store).length; }
};

const CACHEABLE = ['/api/apis', '/api/products', '/api/diff'];
function isCacheable(path) {
  return CACHEABLE.some(p => path === p || path.startsWith(p + '/'));
}

const ALL_ENVS = ['dev', 'sandbox', 'prod', 'dr'];

const API = {
  baseUrl: localStorage.getItem('apim-backend-url') || 'http://localhost:5050',
  _prefetching: false,
  _prefetchDone: false,
  _uiReady: false,
  _connected: false,
  Events,

  setUiReady() { this._uiReady = true; },

  async get(path, params = {}, { skipCache = false, retries = 2 } = {}) {
    if (!skipCache && isCacheable(path)) {
      const cached = Cache.get(path, params);
      if (cached) return cached;
    }
    const url = new URL(this.baseUrl + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await fetch(url);
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          // Per-call console.warn here was too noisy: prefetch + retries
          // generate dozens of warnings per page load. The page that called
          // get() handles its own error rendering. The request_id is still
          // on the response header for anyone who needs it.
          throw new Error(azureErrorMessage(r.status, err.error || err.message));
        }
        const data = await r.json();
        if (isCacheable(path)) Cache.set(path, params, data);
        return data;
      } catch (e) {
        lastError = e;
        if (e instanceof TypeError && attempt < retries) {
          // Network error - retry after delay
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        if (attempt >= retries) break;
      }
    }

    if (lastError instanceof TypeError) {
      throw new Error("Backend not running - start with 'python app.py'");
    }
    throw lastError;
  },

  // `invalidate` is an array of { prefix, params? } objects.
  // Pass [] (empty array) to skip cache changes entirely.
  // Pass null/undefined to fall back to the legacy clear-everything behaviour
  //   (kept temporarily for callers we haven't migrated; will be removed once
  //   every caller passes an explicit array).
  async post(path, body, invalidate) {
    let r;
    try {
      r = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e instanceof TypeError) throw new Error("Backend not running - start with 'python app.py'");
      throw e;
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const rid = r.headers.get('X-Request-ID');
      if (rid) console.warn(`[APIM] POST ${path} failed (request_id=${rid})`);
      throw new Error(azureErrorMessage(r.status, err.error || err.message));
    }
    if (Array.isArray(invalidate)) {
      invalidate.forEach(rule => Cache.invalidate(rule.prefix, rule.params));
    } else {
      Cache.clear();
      this._prefetchDone = false;
    }
    return r.json();
  },

  async postSSE(path, body, { onStep, onDone, onError, onMissingResource, invalidate }) {
    const applyInvalidation = () => {
      if (Array.isArray(invalidate)) {
        invalidate.forEach(rule => Cache.invalidate(rule.prefix, rule.params));
      } else {
        Cache.clear();
        this._prefetchDone = false;
      }
    };

    try {
      const r = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // Check HTTP status before reading SSE stream
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const errorMessage = err.error === 'admin_password_invalid'
          ? 'Incorrect admin password'
          : azureErrorMessage(r.status, err.error || err.message);
        onError(errorMessage, err.error);
        return;
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastEvent = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));
          // Skip invalidation on error — by contract the server signals
          // 'error' before mutating state, so the cache is still accurate.
          if (event.status === 'error') { onError(event.message); return; }
          if (event.event === 'promote_session') {
            if (onMissingResource) onMissingResource({ _type: 'session', session_id: event.session_id });
            continue;
          }
          if (event.event === 'promote_resource_missing') {
            if (onMissingResource) await onMissingResource({ _type: 'missing', ...event });
            continue;
          }
          if (event.summary) {
            applyInvalidation();
            onStep(event); onDone(event); return;
          }
          onStep(event);
          lastEvent = event;
        }
      }
      if (lastEvent) {
        applyInvalidation();
        onDone(lastEvent);
      }
    } catch (e) {
      if (e instanceof TypeError) onError("Backend not running - start with 'python app.py'");
      else onError(e.message || 'Connection failed');
    }
  },

  // Health check — also kicks off prefetch directly so we avoid a second round trip
  async health() {
    try {
      const r = await fetch(this.baseUrl + '/api/health');
      if (!r.ok) return false;
      const data = await r.json();
      const ok = data.status === 'ok';
      if (ok && this._uiReady && !this._prefetchDone && !this._prefetching) {
        // Start prefetch immediately — don't wait for checkConnection to call it separately
        this.prefetchAll();
      }
      return ok;
    } catch { return false; }
  },

  async _fetchBulkDetails(env, apis) {
    if (!apis || !apis.length) return;
    try {
      const url = new URL(this.baseUrl + '/api/apis/bulk-detail');
      url.searchParams.set('env', env);
      url.searchParams.set('ids', apis.map(a => a.id).join(','));
      const r = await fetch(url);
      if (!r.ok) return;
      const results = await r.json();
      results.forEach(detail => {
        if (detail && detail.id && !detail.error) {
          Cache.set(`/api/apis/${detail.id}`, { env }, detail);
        }
      });
    } catch (e) {
      console.warn(`Bulk detail failed for ${env}:`, e.message);
    }
  },

  async prefetchAll() {
    if (!this._uiReady || this._prefetching || this._prefetchDone) return;
    this._prefetching = true;
    this.Events.emit('prefetch-started');

    try {
      // FIX: No health() call here — already called by checkConnection.
      // Fetch dev API list AND all other env lists simultaneously.
      // The moment dev list arrives → table renders. Others populate in background.
      this.Events.emit('prefetch-env-started', { env: 'dev' });

      // Fire ALL list fetches at once — dev + sandbox + prod + dr in parallel
      const listPromises = ALL_ENVS.map(env =>
        Promise.allSettled([
          this.get('/api/apis', { env }),
          this.get('/api/products', { env }),
        ])
      );

      // As soon as dev resolves, render the table — don't wait for other envs
      const devListsPromise = listPromises[0]; // dev is ALL_ENVS[0]
      const [devApisResult, devProductsResult] = await devListsPromise;

      const devApis = devApisResult.status === 'fulfilled' ? devApisResult.value : [];
      const devProducts = devProductsResult.status === 'fulfilled' ? devProductsResult.value : [];

      // Render dev table immediately
      this.Events.emit('env-data-loaded', { env: 'dev', type: 'APIs', data: devApis });
      this.Events.emit('env-data-loaded', { env: 'dev', type: 'Products', data: devProducts });

      // Start dev bulk detail fetch in background (ops for all dev APIs in one request)
      const devOpsPromise = this._fetchBulkDetails('dev', devApis).then(() => {
        const opsCount = devApis.reduce((t, a) => {
          const d = Cache.get(`/api/apis/${a.id}`, { env: 'dev' });
          return t + (d?.operations?.length || 0);
        }, 0);
        this.Events.emit('prefetch-ops-complete', { env: 'dev', count: opsCount });
      }).catch(() => {});

      // Process other envs as their list results arrive (already in-flight)
      const otherEnvsPromise = Promise.all(
        ALL_ENVS.slice(1).map(async (env, i) => {
          const [ar, pr] = await listPromises[i + 1];
          if (ar.status === 'fulfilled') {
            this.Events.emit('prefetch-env-started', { env });
            this.Events.emit('env-data-loaded', { env, type: 'APIs', data: ar.value });
            // Bulk details for other envs in background
            this._fetchBulkDetails(env, ar.value).catch(() => {});
          }
          if (pr.status === 'fulfilled') {
            this.Events.emit('env-data-loaded', { env, type: 'Products', data: pr.value });
          }
        })
      );

      await Promise.all([devOpsPromise, otherEnvsPromise]);

      this._prefetchDone = true;
      this.Events.emit('prefetch-complete');
    } catch (e) {
      console.error('Prefetch failed:', e);
      this.Events.emit('prefetch-error', { message: e.message });
    } finally {
      this._prefetching = false;
    }
  },

  async searchApis(env, query) {
    const q = (query || '').toLowerCase();
    if (q.length < 2) return [];
    const cached = Cache.get('/api/apis', { env });
    if (cached && Array.isArray(cached)) {
      const flat = [];
      for (const a of cached) {
        if (a.versions && a.versions.length > 0) {
          for (const v of a.versions) {
            if (a.displayName.toLowerCase().includes(q) ||
                v.path.toLowerCase().includes(q) ||
                (v.versionName || '').toLowerCase().includes(q)) {
              flat.push({ id: v.id, displayName: a.displayName, path: v.path,
                revision: v.revision, versionName: v.versionName, versions: [],
                label: v.versionName ? `${a.displayName} — ${v.versionName}` : a.displayName });
            }
          }
        } else {
          if (a.displayName.toLowerCase().includes(q) ||
              a.path.toLowerCase().includes(q) ||
              a.id.toLowerCase().includes(q)) {
            flat.push({ ...a, label: a.displayName });
          }
        }
        if (flat.length >= 20) break;
      }
      return flat;
    }
    const results = await this.get('/api/apis/search', { env, q });
    return results.map(r => ({ ...r, label: r.versionName ? `${r.displayName} — ${r.versionName}` : r.displayName }));
  },

  refreshCache() {
    Cache.clear();
    this._prefetchDone = false;
    this.prefetchAll();
  }
};
