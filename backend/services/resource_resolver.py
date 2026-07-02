"""Per-env cache + smart id resolver for APIM resources.

Caches `apis/`, `products/`, `backends/` listings per env with a TTL.
Resolves user-typed queries to real APIM ids.

Usage:
    from services.resource_resolver import resolve_api_id, resolve_product_id, resolve_backend_id
    status, value = resolve_api_id("sandbox", "petstore", client)
    # status in {"ok", "ambiguous", "not_found"}

Match priority (4-tier):
    1. Exact id match
    2. Exact display-name match (case-insensitive)
    3. Substring contains (case-insensitive)
    4. difflib SequenceMatcher ratio >= 0.7

For api lookups, non-current revisions (entries with ;rev=N or
properties.isCurrent=False) are filtered out so the chooser doesn't
see 7 copies of the same logical API.
"""
import time
import threading
import difflib


class _ResourceCache:
    """Thread-safe in-memory cache: {env: (timestamp, [resource_dicts])}.

    `endpoint` is the APIM list path (e.g. "apis", "products", "backends").
    """

    def __init__(self, endpoint: str = "apis", ttl_seconds: int = 300):
        self._endpoint = endpoint
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._data: dict[str, tuple[float, list[dict]]] = {}

    def get(self, env: str, client) -> list[dict]:
        with self._lock:
            entry = self._data.get(env)
            if entry and (time.time() - entry[0]) < self._ttl:
                return entry[1]
        items = client.list_all(self._endpoint)
        with self._lock:
            self._data[env] = (time.time(), items)
        return items

    def invalidate(self, env: str) -> None:
        with self._lock:
            self._data.pop(env, None)


# Singletons
_api_cache = _ResourceCache("apis")
_product_cache = _ResourceCache("products")
_backend_cache = _ResourceCache("backends")
_subscription_cache = _ResourceCache("subscriptions")
_named_value_cache = _ResourceCache("namedValues")
_tag_cache = _ResourceCache("tags")
_certificate_cache = _ResourceCache("certificates")
_ca_certificate_cache = _ResourceCache("caCertificates")

# Back-compat aliases for existing imports/tests
_ApiCache = _ResourceCache
_cache = _api_cache


def invalidate_api_cache(env: str) -> None:
    _api_cache.invalidate(env)


def invalidate_product_cache(env: str) -> None:
    _product_cache.invalidate(env)


def invalidate_backend_cache(env: str) -> None:
    _backend_cache.invalidate(env)


def invalidate_subscription_cache(env: str) -> None:
    _subscription_cache.invalidate(env)


def invalidate_named_value_cache(env: str) -> None:
    _named_value_cache.invalidate(env)


def invalidate_tag_cache(env: str) -> None:
    _tag_cache.invalidate(env)


def invalidate_certificate_cache(env: str) -> None:
    _certificate_cache.invalidate(env)


def invalidate_ca_certificate_cache(env: str) -> None:
    _ca_certificate_cache.invalidate(env)


def _normalise(s: str) -> str:
    """Normalise a string for resolver matching: lowercase, collapse all
    whitespace + `_` + `-` into a single `-`. Preserves alphanumerics."""
    if not s:
        return ""
    import re as _re
    return _re.sub(r'[\s_-]+', '-', s.strip().lower())


def _strip_generic_suffixes(s: str) -> str:
    """Remove common generic suffixes that users add when referring to APIs.

    E.g., 'APIM Demo API' -> 'APIM Demo', 'orders endpoint' -> 'orders'
    This helps fuzzy matching when users say 'the X API' but the actual name is just 'X'.
    """
    if not s:
        return s
    import re as _re
    # Strip common API-related suffixes (case-insensitive)
    # Order matters: try longer patterns first
    patterns = [
        r'\s+api\s*$',       # " API", " api"
        r'\s+endpoint\s*$',  # " endpoint"
        r'\s+service\s*$',   # " service"
        r'\s+resource\s*$',  # " resource"
    ]
    result = s
    for pattern in patterns:
        result = _re.sub(pattern, '', result, flags=_re.IGNORECASE)
    return result


def _candidate(item: dict) -> dict:
    return {
        "id": item.get("name", ""),
        "display_name": item.get("properties", {}).get("displayName", ""),
    }


def _filter_apis(apis: list[dict]) -> list[dict]:
    """Drop non-current revisions and deduplicate version sets.

    For APIs in a version set, return only one representative (preferably
    the one without a version suffix or the first one alphabetically) so
    the API chooser doesn't show multiple versions as different APIs.
    The version checking logic (_check_api_versions) will handle showing
    all versions when needed.
    """
    # First, filter out non-current revisions
    current_apis = [
        a for a in apis
        if a.get("properties", {}).get("isCurrent", ";rev=" not in (a.get("name", "") or ""))
    ]

    # Group by apiVersionSetId
    version_sets = {}  # version_set_id -> list of APIs
    standalone_apis = []  # APIs not in any version set

    for api in current_apis:
        version_set_id = api.get("properties", {}).get("apiVersionSetId")
        if version_set_id:
            if version_set_id not in version_sets:
                version_sets[version_set_id] = []
            version_sets[version_set_id].append(api)
        else:
            standalone_apis.append(api)

    # For each version set, keep only one representative
    result = standalone_apis.copy()
    for version_set_id, apis_in_set in version_sets.items():
        if len(apis_in_set) == 1:
            result.append(apis_in_set[0])
        else:
            # Prefer the version without a suffix in display name, or the first alphabetically
            # This ensures we get a consistent "base" version that represents the whole set
            apis_in_set.sort(key=lambda a: (
                len(a.get("properties", {}).get("displayName", "")),  # Prefer shorter names
                a.get("properties", {}).get("displayName", "").lower()  # Then alphabetically
            ))
            result.append(apis_in_set[0])

    return result


def _resolve(items: list[dict], query: str) -> tuple[str, object]:
    if not query:
        return ("not_found", [])
    if not items:
        return ("not_found", [])

    q_lower = query.lower().strip()
    q_norm = _normalise(query)

    # Tier 1: Exact ID match (case-sensitive)
    # But also check for display name substring matches to avoid missing better options
    exact_id_match = None
    for it in items:
        if it.get("name", "") == query:
            exact_id_match = it
            break

    if exact_id_match:
        # Check if query is also a substring of other APIs' display names
        # This handles "mycontracts" matching both exact ID and "757-MyContracts" display name
        display_name_matches = []
        for it in items:
            display_name = (it.get("properties", {}).get("displayName") or "").lower()
            # Check if query appears in display name
            if q_lower in display_name or q_norm in _normalise(it.get("properties", {}).get("displayName") or ""):
                display_name_matches.append(it)

        # If we found other APIs via display name matching, show all candidates
        if len(display_name_matches) > 1:
            return ("ambiguous", [_candidate(it) for it in display_name_matches])
        elif len(display_name_matches) == 1 and display_name_matches[0] != exact_id_match:
            # Found exact ID match AND a different display name match - show both
            return ("ambiguous", [_candidate(exact_id_match), _candidate(display_name_matches[0])])
        else:
            # Only exact ID match, no other candidates
            return ("ok", exact_id_match["name"])

    # Tier 1.5: Normalized ID match (handles "APIM Demo" -> "apim-demo")
    # This catches space/dash/underscore variations in the ID itself
    for it in items:
        if _normalise(it.get("name", "")) == q_norm:
            return ("ok", it["name"])

    # Tier 2: Display name match (exact + normalized)
    display_matches = [
        it for it in items
        if (it.get("properties", {}).get("displayName") or "").lower() == q_lower
        or _normalise(it.get("properties", {}).get("displayName") or "") == q_norm
    ]
    if len(display_matches) == 1:
        return ("ok", display_matches[0]["name"])
    if len(display_matches) > 1:
        return ("ambiguous", [_candidate(it) for it in display_matches])

    # Tier 2.5: Strip generic suffixes and try again
    # Handles "APIM Demo API" -> "APIM Demo" when user adds "API" as a generic term
    q_stripped = _strip_generic_suffixes(query)
    if q_stripped != query:
        q_stripped_lower = q_stripped.lower().strip()
        q_stripped_norm = _normalise(q_stripped)

        # Try normalized ID match with stripped query
        for it in items:
            if _normalise(it.get("name", "")) == q_stripped_norm:
                return ("ok", it["name"])

        # Try display name match with stripped query
        stripped_matches = [
            it for it in items
            if (it.get("properties", {}).get("displayName") or "").lower() == q_stripped_lower
            or _normalise(it.get("properties", {}).get("displayName") or "") == q_stripped_norm
        ]
        if len(stripped_matches) == 1:
            return ("ok", stripped_matches[0]["name"])
        if len(stripped_matches) > 1:
            return ("ambiguous", [_candidate(it) for it in stripped_matches])

    # Tier 2.7: Progressive word removal - try removing words from the end one by one
    # Handles cases like "APIM Demo API v2" -> "APIM Demo API" -> "APIM Demo"
    import re as _re
    words = _re.split(r'\s+', query.strip())
    if len(words) > 1:
        for word_count in range(len(words) - 1, 0, -1):
            partial_query = ' '.join(words[:word_count])
            partial_norm = _normalise(partial_query)
            partial_lower = partial_query.lower()

            # Try normalized ID match
            for it in items:
                if _normalise(it.get("name", "")) == partial_norm:
                    return ("ok", it["name"])

            # Try display name match
            partial_matches = [
                it for it in items
                if (it.get("properties", {}).get("displayName") or "").lower() == partial_lower
                or _normalise(it.get("properties", {}).get("displayName") or "") == partial_norm
            ]
            if len(partial_matches) == 1:
                return ("ok", partial_matches[0]["name"])
            if len(partial_matches) > 1:
                return ("ambiguous", [_candidate(it) for it in partial_matches])

    # Tier 3: Substring match
    substring_matches = [
        it for it in items
        if q_lower in (it.get("name", "") or "").lower()
        or q_lower in (it.get("properties", {}).get("displayName") or "").lower()
        or q_norm in _normalise(it.get("name", "") or "")
        or q_norm in _normalise(it.get("properties", {}).get("displayName") or "")
    ]
    if len(substring_matches) == 1:
        return ("ok", substring_matches[0]["name"])
    if len(substring_matches) > 1:
        return ("ambiguous", [_candidate(it) for it in substring_matches])

    # Tier 3.5: Token-based matching (handles word order variations and partial matches)
    # E.g., "demo apim" matches "APIM Demo", "petstore api" matches "api-petstore"
    import re as _re
    query_tokens = set(_re.findall(r'\w+', q_lower))
    # Remove very common words that don't help matching
    common_words = {'the', 'a', 'an', 'api', 'endpoint', 'service', 'resource'}
    query_tokens = {t for t in query_tokens if len(t) > 1 and t not in common_words}

    if query_tokens:
        token_matches = []
        for it in items:
            # Extract tokens from both ID and display name
            item_name = it.get("name", "") or ""
            item_display = it.get("properties", {}).get("displayName", "") or ""
            item_tokens = set(_re.findall(r'\w+', (item_name + " " + item_display).lower()))

            # Calculate token overlap ratio
            if item_tokens:
                overlap = len(query_tokens & item_tokens)
                ratio = overlap / len(query_tokens)
                # If 80%+ of query tokens are in the item, it's a match
                if ratio >= 0.8:
                    token_matches.append((it, ratio))

        if token_matches:
            # Sort by ratio (best matches first)
            token_matches.sort(key=lambda x: x[1], reverse=True)
            # If top match is significantly better (100% vs less), return it
            if len(token_matches) == 1 or token_matches[0][1] == 1.0:
                return ("ok", token_matches[0][0]["name"])
            # Otherwise if multiple good matches, return ambiguous
            best_ratio = token_matches[0][1]
            close_matches = [it for it, r in token_matches if r >= best_ratio - 0.1]
            if len(close_matches) > 1:
                return ("ambiguous", [_candidate(it) for it in close_matches])

    # Build haystack of all searchable strings (ID + display name)
    haystack = []
    for it in items:
        haystack.append((it, it.get("name", "")))
        dn = it.get("properties", {}).get("displayName")
        if dn:
            haystack.append((it, dn))

    # Score against original query AND stripped/partial queries for better matching
    queries_to_try = [q_lower]

    # Add stripped query if different
    q_stripped_for_fuzzy = _strip_generic_suffixes(query).lower().strip()
    if q_stripped_for_fuzzy and q_stripped_for_fuzzy != q_lower:
        queries_to_try.append(q_stripped_for_fuzzy)

    # Add progressive partial queries (removing words from end)
    import re as _re
    words = _re.split(r'\s+', query.strip())
    if len(words) > 1:
        for word_count in range(len(words) - 1, 0, -1):
            partial = ' '.join(words[:word_count]).lower()
            if partial not in queries_to_try:
                queries_to_try.append(partial)

    # Score using all query variations
    best_scores = {}  # (item, name) -> best_score
    for query_variant in queries_to_try:
        for it, name in haystack:
            ratio = difflib.SequenceMatcher(None, query_variant, name.lower()).ratio()
            key = (id(it), name)
            if key not in best_scores or ratio > best_scores[key]:
                best_scores[key] = ratio

    # Build scored list with best scores
    scored = [(it, name, score) for (it, name), score in
              [((it, name), best_scores.get((id(it), name), 0))
               for it, name in haystack]]

    # Lower threshold from 0.7 to 0.6 for more lenient matching
    fuzzy_hits = [(it, score) for it, _, score in scored if score >= 0.6]
    if fuzzy_hits:
        best_by_id: dict[str, tuple[dict, float]] = {}
        for it, score in fuzzy_hits:
            iid = it.get("name", "")
            if iid and (iid not in best_by_id or score > best_by_id[iid][1]):
                best_by_id[iid] = (it, score)
        unique = list(best_by_id.values())
        if len(unique) == 1:
            return ("ok", unique[0][0]["name"])
        unique.sort(key=lambda t: t[1], reverse=True)
        return ("ambiguous", [_candidate(it) for it, _ in unique])

    scored.sort(key=lambda t: t[2], reverse=True)
    seen: set[str] = set()
    suggestions = []
    for it, _, _ in scored:
        iid = it.get("name", "")
        if iid and iid not in seen:
            suggestions.append(_candidate(it))
            seen.add(iid)
        if len(suggestions) >= 3:
            break
    return ("not_found", suggestions)


def resolve_api_id(env: str, query: str, client, filter_versions: bool = True) -> tuple[str, object]:
    """Resolve an API ID from a user query.

    Args:
        env: Environment name
        query: API ID or display name to search for
        client: APIM client
        filter_versions: If True, deduplicate version sets (for form-based flows).
                        If False, match against all versions (for Smart Assistant).

    For form-based flows (filter_versions=True):
        - Deduplicates version sets to avoid ambiguity
        - Version selection happens separately via _check_api_versions
        - User selects base API, then version dropdown appears

    For Smart Assistant (filter_versions=False):
        - Matches against all versions including "mycontracts-dev"
        - LLM explicitly references specific versions in tool calls
        - No separate version selection step
    """
    apis = _api_cache.get(env, client)
    if filter_versions:
        apis = _filter_apis(apis)
    return _resolve(apis, query)


def resolve_product_id(env: str, query: str, client) -> tuple[str, object]:
    products = _product_cache.get(env, client)
    return _resolve(products, query)


def resolve_backend_id(env: str, query: str, client) -> tuple[str, object]:
    backends = _backend_cache.get(env, client)
    return _resolve(backends, query)


def resolve_sub_id(env: str, query: str, client) -> tuple[str, object]:
    subs = _subscription_cache.get(env, client)
    return _resolve(subs, query)


def resolve_nv_id(env: str, query: str, client) -> tuple[str, object]:
    nvs = _named_value_cache.get(env, client)
    return _resolve(nvs, query)


def resolve_tag_id(env: str, query: str, client) -> tuple[str, object]:
    tags = _tag_cache.get(env, client)
    return _resolve(tags, query)


def resolve_cert_id(env: str, query: str, client) -> tuple[str, object]:
    items = _certificate_cache.get(env, client)
    return _resolve(items, query)


def resolve_ca_cert_id(env: str, query: str, client) -> tuple[str, object]:
    items = _ca_certificate_cache.get(env, client)
    return _resolve(items, query)


def get_display_name(env: str, kind: str, item_id: str, client=None) -> str:
    """Look up a resource's display name from the cache. Returns "" if not found.

    `kind` is one of: "api", "product", "backend", "subscription", "named_value", "tag".
    Caller may pass `client=None` to skip cache fetch (only checks already-loaded entries).
    """
    cache_map = {
        "api": _api_cache,
        "product": _product_cache,
        "backend": _backend_cache,
        "subscription": _subscription_cache,
        "named_value": _named_value_cache,
        "tag": _tag_cache,
    }
    cache = cache_map.get(kind)
    if not cache:
        return ""
    if client is not None:
        items = cache.get(env, client)
    else:
        # Read-only inspection of already-loaded data
        with cache._lock:
            entry = cache._data.get(env)
        items = entry[1] if entry else []
    for it in items:
        if it.get("name") == item_id:
            return it.get("properties", {}).get("displayName", "") or ""
    return ""


class _OpCache:
    """Thread-safe per-(env, api_id) cache for operations.

    Operations are scoped to a specific API, so the cache key is a tuple
    rather than just env. Same TTL semantics as _ResourceCache.
    """

    def __init__(self, ttl_seconds: int = 300):
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._data: dict[tuple[str, str], tuple[float, list[dict]]] = {}

    def get(self, env: str, api_id: str, client) -> list[dict]:
        key = (env, api_id)
        with self._lock:
            entry = self._data.get(key)
            if entry and (time.time() - entry[0]) < self._ttl:
                return entry[1]
        ops = client.list_all(f"apis/{api_id}/operations")
        with self._lock:
            self._data[key] = (time.time(), ops)
        return ops

    def invalidate(self, env: str, api_id: str | None = None) -> None:
        with self._lock:
            if api_id is None:
                # Drop all entries for this env
                self._data = {k: v for k, v in self._data.items() if k[0] != env}
            else:
                self._data.pop((env, api_id), None)


_op_cache = _OpCache()


def invalidate_operation_cache(env: str, api_id: str | None = None) -> None:
    _op_cache.invalidate(env, api_id)


def resolve_op_id(env: str, api_id: str, query: str, client) -> tuple[str, object]:
    """Resolve a user-typed op query against an API's operations.

    Same 4-tier match priority as resolve_api_id: exact id -> display name ->
    substring -> fuzzy. Returns (status, value) per the existing convention.
    """
    ops = _op_cache.get(env, api_id, client)
    return _resolve(ops, query)


def find_api_in_envs(query: str, env_clients: dict) -> list[dict]:
    """Probe each env for an api matching `query`. Returns list of envs where
    a match exists, sorted by match strength (exact > substring > fuzzy).

    `env_clients` is a {env_name: ApimClient} mapping (caller passes them in
    since this module has no Flask context).

    Returns: [{"env": "dev", "id": "my-petstore", "display_name": "...", "match": "exact|substring|fuzzy"}]
    """
    results = []
    for env_name, client in env_clients.items():
        try:
            status, value = resolve_api_id(env_name, query, client)
            if status == "ok":
                # Determine match strength by re-checking via _resolve manually
                apis = _filter_apis(_api_cache.get(env_name, client))
                q_lower = query.lower().strip()
                match_kind = "fuzzy"
                # Exact id?
                if any(a.get("name") == query for a in apis):
                    match_kind = "exact"
                else:
                    # Substring on id or display name?
                    for a in apis:
                        nm = (a.get("name") or "").lower()
                        dn = (a.get("properties", {}).get("displayName") or "").lower()
                        if q_lower in nm or q_lower in dn:
                            match_kind = "substring"
                            break
                # Display name lookup
                dn = ""
                for a in apis:
                    if a.get("name") == value:
                        dn = a.get("properties", {}).get("displayName", "") or ""
                        break
                results.append({
                    "env": env_name,
                    "id": value,
                    "display_name": dn,
                    "match": match_kind,
                })
        except Exception:
            # Network/auth fail for one env shouldn't block the rest
            continue
    # Sort: exact > substring > fuzzy, then alphabetical by env name
    order = {"exact": 0, "substring": 1, "fuzzy": 2}
    results.sort(key=lambda r: (order.get(r["match"], 9), r["env"]))
    return results
