"""
API Creator service — generator that yields progress events
as it creates an API in Azure APIM step by step.
"""

import json
import re
import time
from urllib.parse import urlparse
from config import BACKEND_API_VER, API_VER, AZURE_TENANT_ID
from utils.slugify import to_slug, to_base_path, to_operation_id
from policies.builder import PolicyBuilder
from app import add_default_groups_to_product
from utils.logger import get_logger

log = get_logger(__name__)


def _extract_domains(urls):
    """Group URLs by domain (hostname + port), returning {domain: [url_entries]}."""
    groups = {}
    for entry in urls:
        parsed = urlparse(entry["url"])
        # Group by hostname + port only (ignore scheme to avoid duplicates)
        # Prefer https for the backend URL
        hostname = parsed.hostname
        port = parsed.port

        # Build domain key for grouping (just hostname:port)
        domain_key = hostname
        if port and port not in (80, 443):
            domain_key += f":{port}"

        # Build actual backend URL (prefer https)
        backend_url = f"https://{hostname}"
        if port and port not in (80, 443):
            backend_url += f":{port}"

        # Group by domain key, but store the backend URL
        if domain_key not in groups:
            groups[domain_key] = {"backend_url": backend_url, "entries": []}
        groups[domain_key]["entries"].append(entry)

    # Return simplified structure: {backend_url: [entries]}
    return {data["backend_url"]: data["entries"] for data in groups.values()}


def _is_ok(status):
    return 200 <= status < 300


def _get_unique_backend_name(client, base_name):
    """
    Generate a unique backend name by checking if it exists and adding numeric suffixes.

    Args:
        client: APIM client
        base_name: Base name for the backend (e.g., "bknd-myapi")

    Returns:
        Unique backend name (e.g., "bknd-myapi" or "bknd-myapi-1" if exists)
    """
    # First try the base name
    status, data = client.get(f"backends/{base_name}", ver=BACKEND_API_VER)
    if status == 404:  # Backend doesn't exist, use base name
        return base_name

    # Backend exists, try with numeric suffixes starting at 2 (Rule 4)
    counter = 2
    while counter < 1000:  # Reasonable upper limit
        unique_name = f"{base_name}-{counter}"
        status, data = client.get(f"backends/{unique_name}", ver=BACKEND_API_VER)
        if status == 404:  # Found a unique name
            return unique_name
        counter += 1

    # Should never reach here, but fallback to random number
    import random
    return f"{base_name}-{random.randint(1000, 9999)}"


def _find_backend_by_host(client, url):
    """
    Find an existing backend whose URL host matches the given URL's host.

    Rule 1: Always reuse an existing backend if its URL host matches.
    Matching is host-only (scheme and path are ignored), so
    https://x.com/path1 and https://x.com/path2 share the same backend.

    Args:
        client: APIM client
        url: Backend URL to search for (e.g., "https://api.example.com/v1")

    Returns:
        (backend_name, backend_url) if found, (None, None) otherwise
    """
    target_host = (urlparse(url).hostname or "").lower()
    if not target_host:
        return None, None

    all_backends = client.list_all("backends", ver=BACKEND_API_VER)
    for backend in all_backends:
        backend_props = backend.get("properties", {})
        backend_url = backend_props.get("url", "")
        backend_type = backend_props.get("type", "")

        # Only match Single backends (not Pool backends)
        if backend_type == "Pool" or not backend_url:
            continue

        existing_host = (urlparse(backend_url).hostname or "").lower()
        if existing_host == target_host:
            return backend.get("name", ""), backend_url

    return None, None


def _next_member_name_for_api(client, api_id):
    """Return b-<api_id> if free, else b-<api_id>-2, -3, ... (Rule 4, collision-checked)."""
    base = f"b-{api_id}"
    s, _ = client.get(f"backends/{base}", ver=BACKEND_API_VER)
    if s == 404:
        return base
    counter = 2
    while counter < 1000:
        candidate = f"{base}-{counter}"
        s2, _ = client.get(f"backends/{candidate}", ver=BACKEND_API_VER)
        if s2 == 404:
            return candidate
        counter += 1
    import random
    return f"{base}-{random.randint(1000, 9999)}"


def _find_or_create_backend(client, url, base_name, circuit_breaker=None):
    """
    Find an existing backend whose host matches, or create a new one.
    Rule 1: Reuse any backend whose URL host matches the new URL's host.
    Rule 4: Naming scheme b-<api_id>, b-<api_id>-2, b-<api_id>-3, ...

    Args:
        client: APIM client
        url: Backend URL (e.g., "https://api.example.com")
        base_name: Base name for the backend if creating new (e.g., "b-myapi")
        circuit_breaker: Optional circuit breaker configuration dict

    Returns:
        (status, backend_id, error_data) tuple:
        - If existing backend found: (200, backend_id, None)
        - If new backend created: (status_from_put, backend_id, data_from_put)
    """
    # Rule 1: Try to find existing backend with same host
    existing_id, _ = _find_backend_by_host(client, url)
    if existing_id:
        return (200, existing_id, None)

    # No existing backend found - create new one with collision-safe name
    unique_name = _get_unique_backend_name(client, base_name)

    body = {
        "properties": {
            "url": url,
            "protocol": "http",
            "title": unique_name,
        }
    }

    # Add circuit breaker if provided
    if circuit_breaker:
        body["properties"]["circuitBreaker"] = circuit_breaker

    # Create backend
    status, data = client.put(f"backends/{unique_name}", body, ver=BACKEND_API_VER)
    return (status, unique_name, data)


def _get_unique_api_name(client, base_api_slug):
    """
    Generate a unique API ID by checking if it exists and adding numeric suffixes.

    Args:
        client: APIM client
        base_api_slug: Base API slug (e.g., "my-api")

    Returns:
        Unique API ID (e.g., "my-api" or "my-api-1" if exists)
    """
    # First try the base slug
    status, data = client.get(f"apis/{base_api_slug}", ver=API_VER)
    if status == 404:  # API doesn't exist, use base slug
        return base_api_slug

    # API exists, try with numeric suffixes
    counter = 1
    while counter < 1000:  # Reasonable upper limit
        unique_slug = f"{base_api_slug}-{counter}"
        status, data = client.get(f"apis/{unique_slug}", ver=API_VER)
        if status == 404:  # Found a unique name
            return unique_slug
        counter += 1

    # Should never reach here, but fallback to random number
    import random
    return f"{base_api_slug}-{random.randint(1000, 9999)}"


def _build_circuit_breaker(cb_config, backend_name):
    """
    Build circuit breaker configuration for Azure APIM backend.

    Args:
        cb_config: Dict with failure_count, interval_seconds, trip_duration_seconds
        backend_name: Unique name for this backend (e.g., "bknd-myapi" or "bknd-myapi-domain1")

    Returns:
        Dict with circuitBreaker configuration, or None if cb_config is empty
    """
    if not cb_config:
        return None

    failure_count = cb_config.get("failure_count", 5)
    interval_seconds = cb_config.get("interval_seconds", 60)
    trip_duration_seconds = cb_config.get("trip_duration_seconds", 30)

    # Convert seconds to ISO 8601 duration format (PT60S = 60 seconds)
    interval_iso = f"PT{interval_seconds}S"
    trip_duration_iso = f"PT{trip_duration_seconds}S"

    # Generate unique circuit breaker rule name based on backend name
    rule_name = f"cb-{backend_name}"

    return {
        "rules": [{
            "name": rule_name,
            "failureCondition": {
                "count": failure_count,
                "interval": interval_iso,
                "statusCodeRanges": [
                    {
                        "min": 429,
                        "max": 429
                    }
                ]
            },
            "tripDuration": trip_duration_iso
        }]
    }


def _apply_policy_with_retry(client, path, policy_body, max_retries=3, initial_delay=2, _label="policy"):
    """
    Apply a policy with retry logic to handle Azure APIM eventual consistency.

    Args:
        client: APIM client
        path: Policy endpoint path (e.g., "apis/{api_slug}/policies/policy")
        policy_body: Policy body dict
        max_retries: Maximum number of retry attempts (default 3)
        initial_delay: Initial delay in seconds (default 2)

    Returns:
        (status, data) tuple from the final attempt
    """
    for attempt in range(max_retries):
        status, data = client.put(path, policy_body, ver=API_VER)

        if _is_ok(status):
            log.info(
                "policy_apply_ok",
                extra={"label": _label, "path": path, "status": status, "attempt": attempt + 1},
            )
            return (status, data)

        # Check if error is due to backend not found (eventual consistency issue)
        # Convert entire error response to string and search for the pattern
        error_str = json.dumps(data).lower()
        is_not_found_error = 'could not be found' in error_str or 'not found' in error_str

        log.warning(
            "policy_apply_fail",
            extra={
                "label": _label, "path": path, "status": status,
                "attempt": attempt + 1, "max_attempts": max_retries,
                "error": str(data)[:400],
                "will_retry": bool(is_not_found_error and attempt < max_retries - 1),
            },
        )

        if is_not_found_error and attempt < max_retries - 1:
            # Retry with exponential backoff: 2s, 4s, 8s
            delay = initial_delay * (2 ** attempt)
            time.sleep(delay)
            # Continue to next attempt
        else:
            # Either not a "not found" error, or last attempt - return the error
            return (status, data)

    # Should not reach here, but return last result just in case
    return (status, data)


def _add_operations_to_existing_api(client, params):
    """
    Add new operations to an existing API, optionally adding backends to pool or enabling circuit breaker.

    Args:
        client: APIM client
        params: Dict with existing_api_id, urls (new operations), backend_config (optional), pool_member_config (optional)

    Yields:
        Progress events
    """
    api_slug = params["existing_api_id"]
    urls = params["urls"]
    backend_config = params.get("backend_config", {})
    pool_member_config = params.get("pool_member_config", {})  # {priority: int, weight: int}
    enable_lb = backend_config.get("enable_lb", False)
    enable_circuit_breaker = backend_config.get("enable_circuit_breaker", False)
    has_consumer = bool(params.get("consumer"))

    # Updated: 4 steps for API operations + 2 steps for consumer (if enabled)
    total = 6 if has_consumer else 4

    # Step 1: Get existing API to verify it exists and get current revision
    yield {"step": 1, "total": total, "status": "running",
           "message": f"Verifying API {api_slug}..."}

    status, api_data = client.get(f"apis/{api_slug}", ver=API_VER)
    if not _is_ok(status):
        yield {"step": 1, "total": total, "status": "error",
               "message": f"Failed to find API {api_slug}: {api_data}"}
        return

    # Check for duplicate operations before proceeding
    from urllib.parse import urlparse
    existing_operations = client.list_all(f"apis/{api_slug}/operations", ver=API_VER)
    existing_op_keys = set()
    for op in existing_operations:
        op_props = op.get("properties", {})
        method = op_props.get("method", "").upper()
        url_template = op_props.get("urlTemplate", "")
        existing_op_keys.add(f"{method}:{url_template}")

    duplicates = []
    for entry in urls:
        if not isinstance(entry, dict):
            continue
        parsed = urlparse(entry.get("url", ""))
        client_path = entry.get("client_path") or parsed.path
        verb = entry.get("verb", "").upper()
        if verb and client_path:
            op_key = f"{verb}:{client_path}"
            if op_key in existing_op_keys:
                duplicates.append(f"{verb} {client_path}")

    if duplicates:
        api_display = api_data.get("properties", {}).get("displayName", api_slug)
        dup_list = ", ".join(duplicates)
        error_msg = (
            f"Cannot add operations - the following operation(s) already exist in API '{api_display}':\n  {dup_list}\n\n"
            f"Please remove these duplicate operations and try again."
        )
        yield {"step": 1, "total": total, "status": "error", "message": error_msg}
        return

    # Get current revision number
    current_revision = api_data.get("properties", {}).get("apiRevision", "1")

    # Fetch ALL revisions to get the maximum revision number
    # Extract actual revision numbers to handle gaps (e.g., if Rev 3 was deleted)
    revisions = client.list_all(f"apis/{api_slug}/revisions", ver=API_VER)
    max_revision = 1
    if revisions:
        revision_numbers = []
        for rev in revisions:
            rev_num = None

            # Try 'name' field first (usually contains the revision number)
            name = rev.get('name', '')
            if name and name.isdigit():
                rev_num = int(name)

            # If not found, try extracting from 'id' field: /subscriptions/.../apis/{apiId};rev={revNum}
            if rev_num is None:
                rev_id = rev.get('id', '')
                if ';rev=' in rev_id:
                    try:
                        rev_num = int(rev_id.split(';rev=')[-1])
                    except (ValueError, IndexError):
                        pass

            # If still not found, try the last segment of id: .../revisions/{revNum}
            if rev_num is None and 'id' in rev:
                try:
                    id_parts = rev['id'].rstrip('/').split('/')
                    if len(id_parts) > 0 and id_parts[-1].isdigit():
                        rev_num = int(id_parts[-1])
                except (ValueError, IndexError):
                    pass

            if rev_num:
                revision_numbers.append(rev_num)

        # Find the maximum revision number (handles gaps from deleted revisions)
        max_revision = max(revision_numbers) if revision_numbers else len(revisions)

    next_revision = str(max_revision + 1)

    # Get existing API policy to find backend ID
    status, policy_data = client.get(f"apis/{api_slug}/policies/policy", ver=API_VER)
    existing_backend_id = None
    if _is_ok(status):
        # Extract backend ID from policy XML
        # Policy can be in 'raw' or 'properties.value' depending on endpoint
        policy_xml = policy_data.get("raw") or policy_data.get("properties", {}).get("value", "")

        # Debug: Log policy structure and content
        yield {"step": 1, "total": total, "status": "running",
               "message": f"DEBUG: Policy keys = {list(policy_data.keys())}, XML length = {len(policy_xml)}"}

        import re
        backend_match = re.search(r'backend-id="([^"]+)"', policy_xml)
        if backend_match:
            existing_backend_id = backend_match.group(1)
        else:
            yield {"step": 1, "total": total, "status": "running",
                   "message": f"DEBUG: No backend-id found in policy. First 200 chars: {policy_xml[:200]}"}

    total_revisions = len(revisions) if revisions else 1
    yield {"step": 1, "total": total, "status": "done",
           "message": f"API {api_slug} verified (current: Rev {current_revision}, total: {total_revisions} revisions, next: Rev {next_revision})"}

    # Check for duplicate operations BEFORE creating revision
    yield {"step": 1, "total": total, "status": "running",
           "message": "Checking for duplicate operations..."}

    existing_operations = client.list_all(f"apis/{api_slug}/operations", ver=API_VER)
    existing_op_keys = set()
    for op in existing_operations:
        op_props = op.get("properties", {})
        method = op_props.get("method", "").upper()
        url_template = op_props.get("urlTemplate", "")
        existing_op_keys.add(f"{method}:{url_template}")

    # Check if any new operations already exist
    duplicates = []
    for entry in urls:
        parsed = urlparse(entry["url"])
        client_path = entry.get("client_path") or parsed.path
        verb = entry["verb"].upper()
        op_key = f"{verb}:{client_path}"

        if op_key in existing_op_keys:
            duplicates.append(f"{verb} {client_path}")

    if duplicates:
        dup_list = "\n".join([f"  - {d}" for d in duplicates])
        yield {"step": 1, "total": total, "status": "error",
               "message": f"Cannot add operations - the following operations already exist in API '{api_slug}':\n{dup_list}\n\nPlease remove these duplicate operations and try again."}
        return

    # Step 2: Create new revision
    # Azure APIM automatically copies EVERYTHING from the current revision when creating a new one:
    # - All existing operations
    # - All operation-level policies
    # - API-level policy
    # - All API settings and configurations
    # This ensures existing operations remain unaffected and fully preserved.
    new_api_id = f"{api_slug};rev={next_revision}"
    yield {"step": 2, "total": total, "status": "running",
           "message": f"Creating revision {next_revision} (copying all existing operations + policies)..."}

    # Get the current API to copy its properties
    status, current_api = client.get(f"apis/{api_slug}", ver=API_VER)
    if not _is_ok(status):
        yield {"step": 2, "total": total, "status": "error",
               "message": f"Failed to get current API details: {current_api}"}
        return

    # Create new revision with copied properties
    # CRITICAL: sourceApiId tells Azure to COPY all operations from current revision
    # Include path explicitly, apiVersionSetId will be inherited for versioned APIs
    props = current_api.get("properties", {})
    revision_body = {
        "properties": {
            "sourceApiId": f"/apis/{api_slug}",
            "apiRevision": next_revision,
            "apiRevisionDescription": f"Added new operations via APIM Extension",
            "path": props.get("path", ""),  # Always include path explicitly
            "isCurrent": False
        }
    }

    # Remove None values
    revision_body["properties"] = {k: v for k, v in revision_body["properties"].items() if v is not None}

    status, rev_data = client.put(f"apis/{new_api_id}", revision_body, ver=API_VER)
    if not _is_ok(status):
        yield {"step": 2, "total": total, "status": "error",
               "message": f"Failed to create revision {next_revision}: {rev_data}"}
        return

    yield {"step": 2, "total": total, "status": "done",
           "message": f"Revision {next_revision} created with all existing operations + policies preserved"}

    # Keep base API slug for backend naming (without revision suffix)
    base_api_slug = api_slug
    # Update api_slug to point to the new revision for API operations
    api_slug = new_api_id

    # Step 3: Handle backend configuration
    # Rules 1, 2, 4, 7:
    # Rule 2: No auto-pool. Pool only created when backend_strategy="pool" (explicit user choice).
    # Rule 1: Reuse existing backend if host matches (host-only comparison).
    # Rule 4: Naming b-<api_id>, b-<api_id>-2, ...; pool-<api_id>.
    # Rule 7: Honour backend_strategy from payload ("standalone" or "pool").
    yield {"step": 3, "total": total, "status": "running",
           "message": "Configuring backends for new operations..."}

    domain_groups = _extract_domains(urls)
    backend_strategy = params.get("backend_strategy")  # "standalone" | "pool" | None

    # Check if user explicitly selected a pool (same as create tab)
    explicit_pool_id = backend_config.get("existing_pool_id")
    if explicit_pool_id and backend_strategy is None:
        backend_strategy = "pool"

    # Auto-detect: If API already has a pool backend and no explicit strategy given,
    # default to "pool" to maintain consistency (add new backends to existing pool)
    existing_is_pool_api = False
    if existing_backend_id:
        s, backend_data = client.get(f"backends/{existing_backend_id}", ver=BACKEND_API_VER)
        if _is_ok(s):
            existing_is_pool_api = (backend_data.get("properties", {}).get("type", "") == "Pool")

    # If API has pool and no explicit strategy given, default to pool
    if existing_is_pool_api and backend_strategy is None:
        backend_strategy = "pool"
        yield {"step": 3, "total": total, "status": "running",
               "message": "API has pool backend - new backends will be added to the pool"}

    # Track which backend ID to use for new operations' policies
    backend_id_for_new_ops = existing_backend_id  # Default: keep pointing to existing backend

    import re as _re

    # Collect all backend IDs (found or created) for all domains
    domain_to_backend = {}  # domain -> backend_id mapping

    for domain in domain_groups.keys():
        # Use same logic as create tab: find or create backend
        base_backend_name = _next_member_name_for_api(client, base_api_slug)

        # Build circuit breaker config if enabled
        circuit_breaker = None
        if enable_circuit_breaker:
            circuit_breaker = _build_circuit_breaker(
                backend_config.get("circuit_breaker", {}),
                base_backend_name
            )

        # Find or create backend (reuses existing if host matches)
        status, backend_id, data = _find_or_create_backend(client, domain, base_backend_name, circuit_breaker)
        if not _is_ok(status):
            yield {"step": 3, "total": total, "status": "error",
                   "message": f"Failed to create backend {backend_id}: {data}"}
            return

        domain_to_backend[domain] = backend_id
        yield {"step": 3, "total": total, "status": "running",
               "message": f"Backend {backend_id} ready for {domain}"}

    # Now handle pool strategy AFTER all backends are created/found
    if backend_strategy == "pool" and domain_to_backend:
        # Extract per-hostname configs from backend_config (same as create tab)
        backend_configs = backend_config.get("backend_configs", {})  # hostname -> {priority, weight}

        # Use explicit pool if user selected one, otherwise use auto-detected
        pool_backend_id = explicit_pool_id if explicit_pool_id else existing_backend_id

        # Check if we have a pool to add to
        if pool_backend_id:
            backend_id_for_new_ops = pool_backend_id

            # Get current pool members
            s, existing_backend_data = client.get(f"backends/{pool_backend_id}", ver=BACKEND_API_VER)
            if not _is_ok(s):
                yield {"step": 3, "total": total, "status": "error",
                       "message": f"Failed to fetch pool backend: {existing_backend_data}"}
                return

            pool_members = existing_backend_data.get("properties", {}).get("pool", {}).get("services", [])
            existing_member_ids = [m.get("id", "").split("/")[-1] for m in pool_members]

            # Add new backends that aren't already in the pool
            added_count = 0
            for domain, backend_id in domain_to_backend.items():
                if backend_id not in existing_member_ids:
                    # Get priority/weight from backend_configs for this hostname (matches create tab)
                    from urllib.parse import urlparse
                    hostname = urlparse(domain).hostname or domain
                    config = backend_configs.get(hostname, {})
                    priority = config.get("priority", 1)
                    weight = config.get("weight", 50)

                    pool_members.append({
                        "id": f"/backends/{backend_id}",
                        "priority": priority,
                        "weight": weight
                    })
                    added_count += 1

            lb_algorithm = backend_config.get("lb_algorithm") or existing_backend_data.get("properties", {}).get("loadBalancing", {}).get("type", "roundRobin")
            pool_body = {
                "properties": {
                    "type": "Pool",
                    "title": pool_backend_id,
                    "pool": {"services": pool_members}
                }
            }
            if lb_algorithm and lb_algorithm != "roundRobin":
                pool_body["properties"]["loadBalancing"] = {"type": lb_algorithm}

            status, data = client.put(f"backends/{pool_backend_id}", pool_body, ver=BACKEND_API_VER)
            if not _is_ok(status):
                yield {"step": 3, "total": total, "status": "error",
                       "message": f"Failed to update pool backend {pool_backend_id}: {data}"}
                return

            yield {"step": 3, "total": total, "status": "done",
                   "message": f"Added {added_count} backend(s) to pool '{pool_backend_id}' (now {len(pool_members)} total members)"}

        else:
            # Existing backend is single or doesn't exist - create new pool
            pool_backend_id = _get_unique_backend_name(client, f"pool-{base_api_slug}")
            backend_id_for_new_ops = pool_backend_id

            pool_members = []
            if existing_backend_id:
                pool_members.append({
                    "id": f"/backends/{existing_backend_id}",
                    "priority": 1,
                    "weight": 50
                })

            # Add all new backends
            for domain, backend_id in domain_to_backend.items():
                # Get priority/weight from backend_configs for this hostname (matches create tab)
                from urllib.parse import urlparse
                hostname = urlparse(domain).hostname or domain
                config = backend_configs.get(hostname, {})
                priority = config.get("priority", 1)
                weight = config.get("weight", 50)

                pool_members.append({
                    "id": f"/backends/{backend_id}",
                    "priority": priority,
                    "weight": weight
                })

            lb_algorithm = backend_config.get("lb_algorithm", "roundRobin")
            pool_body = {
                "properties": {
                    "type": "Pool",
                    "title": pool_backend_id,
                    "pool": {"services": pool_members}
                }
            }
            if lb_algorithm and lb_algorithm != "roundRobin":
                pool_body["properties"]["loadBalancing"] = {"type": lb_algorithm}

            status, data = client.put(f"backends/{pool_backend_id}", pool_body, ver=BACKEND_API_VER)
            if not _is_ok(status):
                yield {"step": 3, "total": total, "status": "error",
                       "message": f"Failed to create pool backend {pool_backend_id}: {data}"}
                return

            # Update existing operations to use the pool backend
            existing_ops = client.list_all(f"apis/{api_slug}/operations", ver=API_VER)
            updated_count = 0
            for op in existing_ops:
                op_id = op.get("name", "")
                if not op_id:
                    continue
                policy_path = f"apis/{api_slug}/operations/{op_id}/policies/policy"
                s, policy_data = client.get(policy_path, ver=API_VER)
                if _is_ok(s):
                    policy_xml = policy_data.get("raw") or policy_data.get("properties", {}).get("value", "")
                    if policy_xml and existing_backend_id and f'backend-id="{existing_backend_id}"' in policy_xml:
                        pattern = r'(backend-id=")' + _re.escape(existing_backend_id) + r'(")'
                        updated_policy = _re.sub(pattern, r'\1' + pool_backend_id + r'\2', policy_xml)
                        policy_body = {"properties": {"format": "rawxml", "value": updated_policy}}
                        s2, _ = client.put(policy_path, policy_body, ver=API_VER)
                        if _is_ok(s2):
                            updated_count += 1

            yield {"step": 3, "total": total, "status": "done",
                   "message": f"Pool '{pool_backend_id}' created with {len(pool_members)} members. Updated {updated_count} existing operations."}

    elif backend_strategy != "pool" and domain_to_backend:
        # Standalone strategy: operations will point to individual backends
        # Just use the first backend as default (per-op policies will override if needed)
        backend_id_for_new_ops = list(domain_to_backend.values())[0]
        yield {"step": 3, "total": total, "status": "done",
               "message": f"Backends ready. Operations will use individual backend references."}

    # Step 4: Add new operations to the API
    yield {"step": 4, "total": total, "status": "running",
           "message": f"Adding {len(urls)} new operations..."}

    # Build OpenAPI spec with only new operations
    openapi_spec = {
        "openapi": "3.0.1",
        "info": {"title": api_data.get("properties", {}).get("displayName", api_slug), "version": "1.0"},
        "paths": {}
    }

    for entry in urls:
        client_path = entry.get("client_path") or urlparse(entry["url"]).path
        verb = entry["verb"].lower()
        op_id = to_operation_id(verb, client_path)

        if client_path not in openapi_spec["paths"]:
            openapi_spec["paths"][client_path] = {}

        openapi_spec["paths"][client_path][verb] = {
            "operationId": op_id,
            "summary": client_path.replace("/", " ").strip() or op_id,
            "responses": {"200": {"description": "OK"}}
        }

    # Import new operations into the new revision
    # IMPORTANT: This MERGES with existing operations (already copied to this revision)
    # - Existing operations remain untouched with all their policies
    # - New operations are added alongside existing ones
    # - Result: Rev {next_revision} = all old operations + new operations
    import_body = {
        "properties": {
            "format": "openapi+json-link",
            "value": json.dumps(openapi_spec),
        }
    }

    # Use POST with import=true to add operations without overwriting existing ones
    status, data = client.post(
        f"apis/{api_slug}?import=true",
        import_body,
        ver=API_VER
    )

    if not _is_ok(status):
        # Try alternative: individually create each operation
        yield {"step": 4, "total": total, "status": "running",
               "message": f"Bulk import failed, adding operations individually..."}

        for entry in urls:
            parsed = urlparse(entry["url"])
            client_path = entry.get("client_path") or parsed.path
            verb = entry["verb"]
            op_id = to_operation_id(verb, client_path)

            # Create operation
            op_body = {
                "properties": {
                    "displayName": client_path.replace("/", " ").strip() or op_id,
                    "method": verb.upper(),
                    "urlTemplate": client_path,
                }
            }
            status, data = client.put(
                f"apis/{api_slug}/operations/{op_id}",
                op_body,
                ver=API_VER
            )
            if not _is_ok(status):
                yield {"step": 4, "total": total, "status": "error",
                       "message": f"Failed to create operation {op_id}: {data}"}
                return

            # Apply operation-level policy (rewrite-uri + backend reference)
            backend_path = parsed.path

            # Set backend explicitly if we have one (pool or individual backend)
            backend_section = f'<set-backend-service backend-id="{backend_id_for_new_ops}" />' if backend_id_for_new_ops else '<base />'

            op_policy_xml = f'''<policies>
  <inbound>
    <base />
    <rewrite-uri template="{backend_path}" copy-unmatched-params="false" />
    {backend_section}
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
  <on-error>
    <base />
  </on-error>
</policies>'''

            op_policy_body = {
                "properties": {
                    "format": "rawxml",
                    "value": op_policy_xml,
                }
            }
            status, data = client.put(
                f"apis/{api_slug}/operations/{op_id}/policies/policy",
                op_policy_body,
                ver=API_VER
            )
            if not _is_ok(status):
                yield {"step": 4, "total": total, "status": "error",
                       "message": f"Failed to apply policy for operation {op_id}: {data}"}
                return

    else:
        # Bulk import succeeded — apply per-op policies for new operations
        # For both standalone and pool strategies, we need to explicitly set the backend
        if backend_id_for_new_ops and backend_id_for_new_ops != existing_backend_id:
            strategy_label = "pool" if backend_strategy == "pool" else "standalone"

            yield {"step": 4, "total": total, "status": "running",
                   "message": f"Applying {strategy_label} backend policy for {len(urls)} imported operations..."}

            for entry in urls:
                parsed = urlparse(entry["url"])
                client_path = entry.get("client_path") or parsed.path
                verb = entry["verb"]
                op_id = to_operation_id(verb, client_path)
                backend_path = parsed.path

                backend_section = f'<set-backend-service backend-id="{backend_id_for_new_ops}" />'
                op_policy_xml = f'''<policies>
  <inbound>
    <base />
    <rewrite-uri template="{backend_path}" copy-unmatched-params="false" />
    {backend_section}
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
  <on-error>
    <base />
  </on-error>
</policies>'''
                op_policy_body = {
                    "properties": {
                        "format": "rawxml",
                        "value": op_policy_xml,
                    }
                }
                status, data = client.put(
                    f"apis/{api_slug}/operations/{op_id}/policies/policy",
                    op_policy_body,
                    ver=API_VER
                )
                if not _is_ok(status):
                    yield {"step": 4, "total": total, "status": "error",
                           "message": f"Failed to apply {strategy_label} policy for operation {op_id}: {data}"}
                    return

    yield {"step": 4, "total": total, "status": "running",
           "message": f"{len(urls)} operations added, releasing revision {next_revision}..."}

    # Release the new revision to make it current
    base_api_id = api_slug.split(";rev=")[0]  # Remove ;rev=X suffix
    revision_api_id = f"{base_api_id};rev={next_revision}"
    release_name = f"release-rev{next_revision}"

    release_body = {
        "properties": {
            "apiId": f"/apis/{revision_api_id}",
            "notes": f"Added {len(urls)} new operations via APIM Extension"
        }
    }

    # Use PUT (not POST) to create a release for the revision
    status, release_data = client.put(f"apis/{base_api_id}/releases/{release_name}", release_body, ver=API_VER)
    if not _is_ok(status):
        yield {"step": 4, "total": total, "status": "error",
               "message": f"Failed to release revision {next_revision}. Status: {status}. Error: {release_data}"}
        return

    # Explicitly set the revision as current using PATCH
    # This ensures the revision is made current reliably
    make_current_body = {
        "properties": {
            "isCurrent": True
        }
    }

    status_patch, patch_data = client.patch(f"apis/{revision_api_id}", make_current_body, ver=API_VER)
    if not _is_ok(status_patch):
        yield {"step": 4, "total": total, "status": "error",
               "message": f"Failed to set revision {next_revision} as current. Status: {status_patch}. Error: {patch_data}"}
        return

    # Verify the revision was actually set as current
    status_verify, api_verify = client.get(f"apis/{revision_api_id}", ver=API_VER)
    is_current = api_verify.get("properties", {}).get("isCurrent", False) if _is_ok(status_verify) else False

    if is_current:
        yield {"step": 4, "total": total, "status": "done",
               "message": f"✓ Revision {next_revision} successfully set as current"}
    else:
        yield {"step": 4, "total": total, "status": "error",
               "message": f"✗ Failed to set revision {next_revision} as current. Please check Azure portal."}

    # ── Consumer setup (if applicable) ────────────────────────────────────
    keys = None
    product_display_name = None
    sub_display_name = None
    if has_consumer:
        consumer = params["consumer"]
        onboard_strategy = consumer.get("onboard_strategy", "create_new")
        existing_product_id = consumer.get("existing_product_id")

        # Debug logging
        yield {"step": 5, "total": total, "status": "running",
               "message": f"DEBUG: strategy={onboard_strategy}, existing_product_id={existing_product_id}"}

        # Determine product ID based on strategy
        if onboard_strategy == "add_to_existing" and existing_product_id:
            # Reuse existing product
            product_id = existing_product_id

            # Step 5: Verify product exists and link API
            yield {"step": 5, "total": total, "status": "running",
                   "message": f"Linking API to existing product {product_id}..."}

            # Verify product exists
            status, existing_product = client.get(f"products/{product_id}", ver=API_VER)
            if status == 404:
                yield {"step": 5, "total": total, "status": "error",
                       "message": f"Product {product_id} not found"}
                return

            # Extract product display name
            product_display_name = existing_product.get("properties", {}).get("displayName", product_id)

            # Link API to existing product (use base_api_id without revision)
            status, data = client.put(f"products/{product_id}/apis/{base_api_id}", {}, ver=API_VER)
            if not _is_ok(status):
                yield {"step": 5, "total": total, "status": "error",
                       "message": f"Failed to link API to product: {data}"}
                return

            yield {"step": 5, "total": total, "status": "done",
                   "message": f"API linked to existing product {product_id}"}

        else:
            # Create new product and subscription
            consumer_name = consumer["app_name"]
            product_display_name = consumer_name

            # Find unique product ID
            base_product_id = to_slug(consumer_name)
            product_id = base_product_id
            counter = 1
            while True:
                status, _ = client.get(f"products/{product_id}", ver=API_VER)
                if status == 404:
                    break  # Product doesn't exist, we can use this ID
                counter += 1
                product_id = f"{base_product_id}-{counter}"

            product_display_name = consumer_name if counter == 1 else f"{consumer_name}-{counter}"

            # Find unique subscription ID
            base_sub_id = f"sub-{product_id}"
            sub_id = base_sub_id
            sub_counter = 1
            while True:
                status, _ = client.get(f"subscriptions/{sub_id}", ver=API_VER)
                if status == 404:
                    break  # Subscription doesn't exist, we can use this ID
                sub_counter += 1
                sub_id = f"{base_sub_id}-{sub_counter}"

            sub_display_name = f"Sub-{product_display_name}" if sub_counter == 1 else f"Sub-{product_display_name}-{sub_counter}"

            # Step 5: Create product, link API, create subscription
            yield {"step": 5, "total": total, "status": "running",
                   "message": f"Creating new product {product_id}..."}

            product_body = {
                "properties": {
                    "displayName": product_display_name,
                    "subscriptionRequired": True,
                    "state": "published",
                }
            }
            status, data = client.put(f"products/{product_id}", product_body, ver=API_VER)
            if not _is_ok(status):
                yield {"step": 5, "total": total, "status": "error",
                       "message": f"Failed to create product {product_id}: {data}"}
                return

            # Add default groups to product visibility
            add_default_groups_to_product(client, product_id)

            # Delete any auto-created subscriptions
            try:
                auto_subs = client.list_all(f"products/{product_id}/subscriptions")
                for s in auto_subs:
                    sid = s.get("name", "")
                    if sid:
                        client.delete(f"subscriptions/{sid}")
            except Exception:
                pass

            # Link API to product (use base_api_id without revision)
            status, data = client.put(f"products/{product_id}/apis/{base_api_id}", {}, ver=API_VER)
            if not _is_ok(status):
                yield {"step": 5, "total": total, "status": "error",
                       "message": f"Failed to link API to product: {data}"}
                return

            # Create subscription
            sub_body = {
                "properties": {
                    "scope": f"/products/{product_id}",
                    "displayName": sub_display_name,
                    "state": "active",
                }
            }
            status, data = client.put(f"subscriptions/{sub_id}", sub_body, ver=API_VER)
            if not _is_ok(status):
                yield {"step": 5, "total": total, "status": "error",
                       "message": f"Failed to create subscription: {data}"}
                return

            yield {"step": 5, "total": total, "status": "done",
                   "message": "New product and subscription created"}

        # Step 6: Get keys
        yield {"step": 6, "total": total, "status": "running",
               "message": "Retrieving subscription keys..."}

        # For existing products, get keys from existing subscription or create one if none exist
        # For new products, get keys from newly created subscription
        if onboard_strategy == "add_to_existing" and existing_product_id:
            # List existing subscriptions for the product
            existing_subs = client.list_all(f"products/{product_id}/subscriptions", ver=API_VER)

            if not existing_subs:
                # No subscriptions exist - create one
                sub_display_name = f"Sub-{existing_product.get('properties', {}).get('displayName', product_id)}"
                sub_id = f"sub-{product_id}"

                sub_body = {
                    "properties": {
                        "scope": f"/products/{product_id}",
                        "displayName": sub_display_name,
                        "state": "active",
                    }
                }
                status, data = client.put(f"subscriptions/{sub_id}", sub_body, ver=API_VER)
                if not _is_ok(status):
                    yield {"step": 6, "total": total, "status": "error",
                           "message": f"Failed to create subscription: {data}"}
                    return

                # Get keys for newly created subscription
                status, data = client.post(f"subscriptions/{sub_id}/listSecrets", ver=API_VER)
                if not _is_ok(status):
                    yield {"step": 6, "total": total, "status": "error",
                           "message": f"Failed to retrieve keys: {data}"}
                    return
                keys = data
            else:
                # Get keys for the first existing subscription
                first_sub_id = existing_subs[0].get("name", "")
                sub_display_name = existing_subs[0].get("properties", {}).get("displayName", first_sub_id)
                status, data = client.post(f"subscriptions/{first_sub_id}/listSecrets", ver=API_VER)
                if not _is_ok(status):
                    yield {"step": 6, "total": total, "status": "error",
                           "message": f"Failed to retrieve subscription keys: {data}"}
                    return

                keys = data
        else:
            # Get keys for newly created subscription
            status, data = client.post(f"subscriptions/{sub_id}/listSecrets", ver=API_VER)
            if not _is_ok(status):
                yield {"step": 6, "total": total, "status": "error",
                       "message": f"Failed to retrieve keys: {data}"}
                return

            keys = data

    # Final summary
    backends_info = ""
    if enable_lb:
        backends_info = " (backends added to pool)"
    elif enable_circuit_breaker:
        backends_info = " (circuit breaker configured)"

    summary = {
        "api_id": base_api_id,
        "revision": next_revision,
        "operations_added": len(urls),
        "backends_configured": enable_lb or enable_circuit_breaker,
    }

    if keys:
        summary["keys"] = keys
        if product_display_name:
            summary["product_name"] = product_display_name
        if sub_display_name:
            summary["subscription_name"] = sub_display_name

    yield {"step": total, "total": total, "status": "done",
           "message": f"Complete{backends_info} - Revision {next_revision} is live",
           "summary": summary}


def create_api_flow(client, params):
    """
    Generator that creates an API in APIM and yields progress event dicts.

           # Allow client_path override, else use parsed path
           client_path = entry.get("client_path", parsed.path)
           verb = entry["verb"]
           op_id = to_operation_id(verb, client_path)
           # Always use client_path with slashes replaced by spaces for displayName
           display_name = client_path.replace("/", " ").strip() or op_id
        dict with step, total, status, message (and summary on final)
    """
    mode = params.get("mode", "new")

    # If mode is "add", delegate to add-to-existing flow
    if mode == "add":
        yield from _add_operations_to_existing_api(client, params)
        return

    # Otherwise, continue with new API creation flow
    name = params["name"]
    base_api_slug = to_slug(name)

    # Check if API already exists (don't auto-generate unique names)
    status, existing_api = client.get(f"apis/{base_api_slug}", ver=API_VER)
    if status == 200:
        existing_name = existing_api.get("properties", {}).get("displayName", base_api_slug)
        yield {"step": 1, "total": total, "status": "error",
               "message": f"API '{base_api_slug}' already exists (Display Name: '{existing_name}'). Please choose a different API name or use 'Add to Existing API' to add operations to it."}
        return

    api_slug = base_api_slug
    base_path = to_base_path(name)

    urls = params["urls"]
    has_consumer = bool(params.get("consumer"))
    total = 7 if has_consumer else 5

    domain_groups = _extract_domains(urls)
    backend_config = params.get("backend_config", {})
    enable_lb = backend_config.get("enable_lb", False)
    enable_circuit_breaker = backend_config.get("enable_circuit_breaker", False)
    lb_algorithm = backend_config.get("lb_algorithm", "roundRobin")
    backend_configs = backend_config.get("backend_configs", {})  # hostname -> {priority, weight}
    backend_strategy = backend_config.get("backend_strategy")  # "standalone" | None
    backend_by_host = {}  # domain -> backend_id (populated in multi-no-LB branch)

    # ── Step 1: Create backend(s) ────────────────────────────────────────
    if len(domain_groups) == 1:
        # Single backend - create backend resource and reference by ID
        # Rule 4: naming scheme b-<api_id>
        base_backend_id = f"b-{api_slug}"
        domain = list(domain_groups.keys())[0]

        yield {"step": 1, "total": total, "status": "running",
               "message": f"Finding or creating backend..."}

        # Build circuit breaker config if enabled
        circuit_breaker = None
        if enable_circuit_breaker:
            circuit_breaker = _build_circuit_breaker(
                backend_config.get("circuit_breaker", {}),
                base_backend_id
            )

        # Find or create backend (deduplicates by URL)
        status, backend_id, data = _find_or_create_backend(client, domain, base_backend_id, circuit_breaker)
        if not _is_ok(status):
            yield {"step": 1, "total": total, "status": "error",
                   "message": f"Failed to create backend {backend_id}: {data}"}
            return

        log.info(
            "backend_resolved",
            extra={"backend_id": backend_id, "domain": domain, "base": base_backend_id, "status": status},
        )
        yield {"step": 1, "total": total, "status": "done",
               "message": f"Backend {backend_id} ready"}

    elif len(domain_groups) > 1 and enable_lb:
        # Multiple backends with Load Balancer - create pool backend
        # Rule 4: pool naming scheme pool-<api_id>
        base_backend_id = f"pool-{api_slug}"
        backend_id = _get_unique_backend_name(client, base_backend_id)

        yield {"step": 1, "total": total, "status": "running",
               "message": f"Creating pool backend {backend_id} ({len(domain_groups)} members)..."}

        # First, create individual backend members (Rule 4: b-<api_id>, b-<api_id>-2, ...)
        member_backends = []
        for domain in domain_groups.keys():
            # Collision-checked naming: probe b-<api_slug>, b-<api_slug>-2, ... until free
            base_member_name = _next_member_name_for_api(client, api_slug)

            # Build circuit breaker config if enabled
            circuit_breaker = None
            if enable_circuit_breaker:
                circuit_breaker = _build_circuit_breaker(
                    backend_config.get("circuit_breaker", {}),
                    base_member_name
                )

            # Find or create backend (deduplicates by URL)
            status, member_name, data = _find_or_create_backend(client, domain, base_member_name, circuit_breaker)
            if not _is_ok(status):
                yield {"step": 1, "total": total, "status": "error",
                       "message": f"Failed to create backend member {member_name}: {data}"}
                return

            # Get priority/weight for this backend (hostname), or use defaults
            hostname = urlparse(domain).hostname
            config = backend_configs.get(hostname, {"priority": 1, "weight": 50})

            # Build member reference for pool
            member_backends.append({
                "id": f"/backends/{member_name}",
                "priority": config.get("priority", 1),
                "weight": config.get("weight", 50)
            })

        # Now create the pool backend
        pool_body = {
            "properties": {
                "type": "Pool",
                "title": backend_id,
                "pool": {
                    "services": member_backends
                }
            }
        }
        status, data = client.put(f"backends/{backend_id}", pool_body, ver=BACKEND_API_VER)
        if not _is_ok(status):
            yield {"step": 1, "total": total, "status": "error",
                   "message": f"Failed to create pool backend {backend_id}: {data}"}
            return

        yield {"step": 1, "total": total, "status": "done",
               "message": f"Pool backend {backend_id} created with {len(member_backends)} members"}

    else:
        # Multiple backends without LB — create individual standalone backends.
        # API-level uses backend #0; per-op policies will override for ops
        # whose host differs (added in step 4 below).
        yield {"step": 1, "total": total, "status": "running",
               "message": f"Creating {len(domain_groups)} individual backends (standalone routing)..."}

        ordered_backend_ids = []  # preserve creation order for picking #0 as default
        for domain in domain_groups.keys():
            base_member_name = _next_member_name_for_api(client, api_slug)
            circuit_breaker = None
            if enable_circuit_breaker:
                circuit_breaker = _build_circuit_breaker(
                    backend_config.get("circuit_breaker", {}),
                    base_member_name
                )
            status, member_name, data = _find_or_create_backend(client, domain, base_member_name, circuit_breaker)
            if not _is_ok(status):
                yield {"step": 1, "total": total, "status": "error",
                       "message": f"Failed to create backend {member_name}: {data}"}
                return
            backend_by_host[domain] = member_name
            ordered_backend_ids.append(member_name)

        backend_id = ordered_backend_ids[0]  # API-level default
        yield {"step": 1, "total": total, "status": "done",
               "message": f"{len(ordered_backend_ids)} backends created, default '{backend_id}' (others wired via per-op set-backend-service)"}

    # Wait for Azure APIM to propagate the backend (eventual consistency)
    time.sleep(5)

    # ── Step 2: Create API via OpenAPI Import ───────────────────────────
    yield {"step": 2, "total": total, "status": "running",
           "message": f"Creating API {api_slug}..."}

    # Build the OpenAPI spec from the provided URLs
    openapi_spec = {
        "openapi": "3.0.1",
        "info": {"title": name, "version": "1.0"},
        "paths": {}
    }
    for entry in urls:
        client_path = entry.get("client_path") or urlparse(entry["url"]).path
        verb = entry["verb"].lower()
        op_id = to_operation_id(verb, client_path)

        if client_path not in openapi_spec["paths"]:
            openapi_spec["paths"][client_path] = {}

        # Declare any {param} tokens in the path so APIM accepts the spec.
        # OpenAPI requires every path parameter to be in the operation's
        # `parameters` collection with `in: path`, `required: true`.
        path_params = re.findall(r"\{([^}]+)\}", client_path)
        op_def = {
            "operationId": op_id,
            "summary": client_path.replace("/", " ").strip() or op_id,
            "responses": {"200": {"description": "OK"}}
        }
        if path_params:
            op_def["parameters"] = [
                {"name": p, "in": "path", "required": True, "schema": {"type": "string"}}
                for p in path_params
            ]
        openapi_spec["paths"][client_path][verb] = op_def

    api_body = {
        "properties": {
            "format": "openapi+json",
            "value": json.dumps(openapi_spec),
            "displayName": name,
            "path": base_path,
            "protocols": ["https"],
            "subscriptionRequired": True,
        }
    }
    status, data = client.put(f"apis/{api_slug}", api_body, ver=API_VER)
    if not _is_ok(status):
        yield {"step": 2, "total": total, "status": "error",
               "message": f"Failed to create API {api_slug}: {data}"}
        return

    # Poll until APIM has fully provisioned the API (eventual consistency).
    # Without this, the next step's policy PUT can hit "Entity not found"
    # because the API resource is registered but not yet queryable.
    for _ in range(15):
        gs, _gd = client.get(f"apis/{api_slug}", ver=API_VER)
        if gs == 200:
            break
        time.sleep(1)
    else:
        log.warning("api_propagation_timeout", extra={"api_id": api_slug})

    yield {"step": 2, "total": total, "status": "done",
           "message": f"API {api_slug} with {len(urls)} operations created"}

    # ── Step 3: Apply API-level policy ──────────────────────────────────
    yield {"step": 3, "total": total, "status": "running",
           "message": "Applying API-level policy..."}

    tenant_id = AZURE_TENANT_ID

    # Circuit breaker is not a policy XML element - it's configured at the backend resource level
    # (already applied to backends above if enabled)
    # Backend section just uses <base /> to inherit from parent
    backend_policy_xml = "<base />"

    # Optional: backend cert forwarding (X-ARR-ClientCert pattern). When
    # backend_cert_thumbprint is set, inject set-variable + set-header to
    # look up the cert from APIM cert store and forward it to the backend.
    client_cert_thumbprint = params.get("backend_cert_thumbprint")
    if client_cert_thumbprint:
        cert_block = (
            '<set-variable name="ClientCert" value=\'@{\n'
            f'        var certThumbprint = "{client_cert_thumbprint}";\n'
            '        X509Certificate2 cert1;\n'
            '        context.Deployment.Certificates.TryGetValue(certThumbprint, out cert1);\n'
            '        var certThumbprintBase64 = Convert.ToBase64String(cert1.RawData);\n'
            '        return certThumbprintBase64;\n'
            '    }\' />\n'
            '    <set-header name="X-ARR-ClientCert" exists-action="override">\n'
            '        <value>@{return (string)context.Variables["ClientCert"];}</value>\n'
            '    </set-header>'
        )
    else:
        cert_block = ""

    api_policy_xml = (
        PolicyBuilder.from_template("api_level")
        .set("TENANT_ID_PLACEHOLDER", tenant_id)
        .set("JWT_AUDIENCE_PLACEHOLDER", params["jwt_audience"])
        .set("BACKEND_ID_PLACEHOLDER", backend_id)
        .set("RATE_LIMIT_CALLS_PLACEHOLDER", params["rate_limit_calls"])
        .set("RATE_LIMIT_RENEWAL_PLACEHOLDER", "60")
        .set("QUOTA_CALLS_PLACEHOLDER", params.get("quota_calls", "2800"))
        .set("QUOTA_PERIOD_PLACEHOLDER", "86400")
        .set("BACKEND_POLICY_PLACEHOLDER", backend_policy_xml)
        .set("CLIENT_CERT_BLOCK_PLACEHOLDER", cert_block)
        .build()
    )

    policy_body = {
        "properties": {
            "format": "rawxml",
            "value": api_policy_xml,
        }
    }
    log.info(
        "api_policy_apply_start",
        extra={
            "api_id": api_slug, "backend_id": backend_id,
            "rate_calls": params.get("rate_limit_calls"),
            "quota_calls": params.get("quota_calls"),
            "xml_length": len(api_policy_xml),
        },
    )
    # Use retry logic to handle Azure APIM eventual consistency
    status, data = _apply_policy_with_retry(
        client, f"apis/{api_slug}/policies/policy", policy_body, _label="api_level"
    )
    if not _is_ok(status):
        # Dump full rendered XML to a debug file so we can replay/inspect it.
        import os as _os
        debug_dir = _os.path.join("logs", "policy-failures")
        _os.makedirs(debug_dir, exist_ok=True)
        debug_path = _os.path.join(debug_dir, f"{api_slug}-{int(time.time())}.xml")
        try:
            with open(debug_path, "w", encoding="utf-8") as fh:
                fh.write(api_policy_xml)
        except OSError:
            debug_path = None
        log.error(
            "api_policy_apply_failed",
            extra={
                "api_id": api_slug, "backend_id": backend_id, "status": status,
                "error": str(data)[:800],
                "debug_xml": debug_path,
            },
        )
        yield {"step": 3, "total": total, "status": "error",
               "message": f"Failed to apply API-level policy: {data}"}
        return

    yield {"step": 3, "total": total, "status": "done",
           "message": "API-level policy applied"}

    # ── Step 4: Apply operation-level policies ──────────────────────────
    yield {"step": 4, "total": total, "status": "running",
           "message": "Applying operation-level policies..."}

    consumer_name_value = (
        params["consumer"].get("consumer_name") or params["consumer"].get("client_id", "")
        if has_consumer else "*"
    )

    # Content-Type mapping
    CONTENT_TYPE_MAP = {
        "json": "application/json",
        "application/json": "application/json",
        "xml": "application/xml",
        "application/xml": "application/xml",
        "form": "application/x-www-form-urlencoded",
        "urlencoded": "application/x-www-form-urlencoded",
        "multipart": "multipart/form-data",
        "form-data": "multipart/form-data",
        "text": "text/plain",
        "plain": "text/plain",
        "octet": "application/octet-stream",
        "binary": "application/octet-stream"
    }

    for entry in urls:
        parsed = urlparse(entry["url"])
        client_path = entry.get("client_path") or parsed.path
        verb = entry["verb"]
        op_id = to_operation_id(verb, client_path)

        # Map user input to MIME type
        user_type = (entry.get("body_type") or "").strip().lower()
        mime_type = CONTENT_TYPE_MAP.get(user_type)
        if not mime_type and user_type:
            for k, v in CONTENT_TYPE_MAP.items():
                if k in user_type:
                    mime_type = v
                    break

        # Build content validation XML
        content_validation_xml = ""
        if mime_type and verb.upper() in ["POST", "PUT", "PATCH"]:
            content_validation_xml = f'''<validate-content unspecified-content-type-action="prevent" max-size="102400" size-exceeded-action="prevent">
            <content type="{mime_type}" validate-as="json" action="prevent" />
        </validate-content>'''

        # Build consumer-name allowlist check using choose block
        appid_check_xml = ""
        if consumer_name_value != "*":
            names = [n.strip().lower() for n in consumer_name_value.split(',') if n.strip()]
            if names:
                names_array = ', '.join([f'&quot;{n}&quot;' for n in names])
                appid_check_xml = f'''<choose>
            <when condition="@(new[] {{ {names_array} }}.Contains((string)context.Variables[&quot;consumer-name&quot;]))" />
            <otherwise>
                <return-response>
                    <set-status code="401" reason="Unauthorized" />
                    <set-header name="Content-Type" exists-action="override">
                        <value>application/json</value>
                    </set-header>
                    <set-body>{{"error":"This consumer doesn't have permission to execute the operation!"}}</set-body>
                </return-response>
            </otherwise>
        </choose>'''

        # Multi-backend standalone routing: if this op's host has its own
        # backend that differs from the API-level default, inject per-op
        # set-backend-service so the op routes correctly.
        # backend_by_host keys are full backend URLs: "https://<hostname>"
        backend_override_xml = ""
        try:
            op_backend_url = f"https://{parsed.hostname}" if parsed.hostname else ""
            op_backend_id = backend_by_host.get(op_backend_url)
            if op_backend_id and op_backend_id != backend_id:
                backend_override_xml = f'<set-backend-service backend-id="{op_backend_id}" />'
        except Exception:
            pass

        # Get the raw template string and perform replacements
        builder = (
            PolicyBuilder.from_template("operation_level")
            .set("REWRITE_URI_PLACEHOLDER", parsed.path)
            .set("CONTENT_VALIDATION_PLACEHOLDER", content_validation_xml)
            .set("APPID_CHECK_PLACEHOLDER", appid_check_xml)
            .set("BACKEND_OVERRIDE_PLACEHOLDER", backend_override_xml)
        )

        op_policy_xml_str = builder.build()
        op_policy_body = {
            "properties": {
                "format": "rawxml",
                "value": op_policy_xml_str,
            }
        }
        status, data = client.put(
            f"apis/{api_slug}/operations/{op_id}/policies/policy", op_policy_body, ver=API_VER
        )
        if not _is_ok(status):
            yield {"step": 4, "total": total, "status": "error",
                   "message": f"Failed to apply policy for operation {op_id}: {data}"}
            return

    yield {"step": 4, "total": total, "status": "done",
           "message": "Operation-level policies applied"}

    # ── Step 5, 6, 7: Consumer setup (if applicable) ────────────────────
    keys = None
    product_display_name = None
    sub_display_name = None
    if has_consumer:
        consumer = params["consumer"]
        consumer_name = consumer["app_name"]
        onboard_strategy = consumer.get("onboard_strategy", "create_new")
        existing_product_id = consumer.get("existing_product_id")

        # Debug logging
        yield {"step": 5, "total": total, "status": "running",
               "message": f"DEBUG: strategy={onboard_strategy}, existing_product_id={existing_product_id}"}

        # Determine product ID based on strategy
        if onboard_strategy == "add_to_existing" and existing_product_id:
            # Reuse existing product
            product_id = existing_product_id

            # Step 5: Verify product exists and link API
            yield {"step": 5, "total": total, "status": "running",
                   "message": f"Linking API to existing product {product_id}..."}

            # Verify product exists
            status, existing_product = client.get(f"products/{product_id}", ver=API_VER)
            if status == 404:
                yield {"step": 5, "total": total, "status": "error",
                       "message": f"Product {product_id} not found"}
                return

            # Extract product display name
            product_display_name = existing_product.get("properties", {}).get("displayName", product_id)

            # Link API to existing product
            status, data = client.put(f"products/{product_id}/apis/{api_slug}", {}, ver=API_VER)
            if not _is_ok(status):
                yield {"step": 5, "total": total, "status": "error",
                       "message": f"Failed to link API to product: {data}"}
                return

            yield {"step": 5, "total": total, "status": "done",
                   "message": f"API linked to existing product {product_id}"}

        else:
            # Create new product and subscription
            base_product_id = to_slug(consumer_name)
            product_id = base_product_id
            counter = 1
            while True:
                status, _ = client.get(f"products/{product_id}", ver=API_VER)
                if status == 404:
                    break
                counter += 1
                product_id = f"{base_product_id}-{counter}"

            product_display_name = consumer_name if counter == 1 else f"{consumer_name}-{counter}"

            base_sub_id = f"sub-{product_id}"
            sub_id = base_sub_id
            sub_counter = 1
            while True:
                status, _ = client.get(f"subscriptions/{sub_id}", ver=API_VER)
                if status == 404:
                    break
                sub_counter += 1
                sub_id = f"{base_sub_id}-{sub_counter}"

            sub_display_name = f"Sub-{product_display_name}" if sub_counter == 1 else f"Sub-{product_display_name}-{sub_counter}"

            # Step 5: Create product, link API, create subscription
            yield {"step": 5, "total": total, "status": "running",
                   "message": f"Creating new product {product_id}..."}

            product_body = {
                "properties": {
                    "displayName": product_display_name,
                    "subscriptionRequired": True,
                    "state": "published",
                }
            }
            status, data = client.put(f"products/{product_id}", product_body, ver=API_VER)
            if not _is_ok(status):
                yield {"step": 5, "total": total, "status": "error",
                       "message": f"Failed to create product {product_id}: {data}"}
                return

            # Add default groups to product visibility
            add_default_groups_to_product(client, product_id)

            # Delete any auto-created subscriptions
            try:
                auto_subs = client.list_all(f"products/{product_id}/subscriptions")
                for s in auto_subs:
                    sid = s.get("name", "")
                    if sid:
                        client.delete(f"subscriptions/{sid}")
            except Exception:
                pass

            # Link API to product
            status, data = client.put(f"products/{product_id}/apis/{api_slug}", {}, ver=API_VER)
            if not _is_ok(status):
                yield {"step": 5, "total": total, "status": "error",
                       "message": f"Failed to link API to product: {data}"}
                return

            # Create subscription
            sub_body = {
                "properties": {
                    "scope": f"/products/{product_id}",
                    "displayName": sub_display_name,
                    "state": "active",
                }
            }
            status, data = client.put(f"subscriptions/{sub_id}", sub_body, ver=API_VER)
            if not _is_ok(status):
                yield {"step": 5, "total": total, "status": "error",
                       "message": f"Failed to create subscription: {data}"}
                return

            yield {"step": 5, "total": total, "status": "done",
                   "message": "New product and subscription created"}

        # Step 6: Get keys
        yield {"step": 6, "total": total, "status": "running",
               "message": "Retrieving subscription keys..."}

        # For existing products, get keys from existing subscription or create one if none exist
        # For new products, get keys from newly created subscription
        if onboard_strategy == "add_to_existing" and existing_product_id:
            # List existing subscriptions for the product
            existing_subs = client.list_all(f"products/{product_id}/subscriptions", ver=API_VER)

            if not existing_subs:
                # No subscriptions exist - create one
                sub_display_name = f"Sub-{existing_product.get('properties', {}).get('displayName', product_id)}"
                sub_id = f"sub-{product_id}"

                sub_body = {
                    "properties": {
                        "scope": f"/products/{product_id}",
                        "displayName": sub_display_name,
                        "state": "active",
                    }
                }
                status, data = client.put(f"subscriptions/{sub_id}", sub_body, ver=API_VER)
                if not _is_ok(status):
                    yield {"step": 6, "total": total, "status": "error",
                           "message": f"Failed to create subscription: {data}"}
                    return

                # Get keys for newly created subscription
                status, data = client.post(f"subscriptions/{sub_id}/listSecrets", ver=API_VER)
                if not _is_ok(status):
                    yield {"step": 6, "total": total, "status": "error",
                           "message": f"Failed to retrieve keys: {data}"}
                    return
                keys = data
            else:
                # Get keys for the first existing subscription
                first_sub_id = existing_subs[0].get("name", "")
                sub_display_name = existing_subs[0].get("properties", {}).get("displayName", first_sub_id)
                status, data = client.post(f"subscriptions/{first_sub_id}/listSecrets", ver=API_VER)
                if not _is_ok(status):
                    yield {"step": 6, "total": total, "status": "error",
                           "message": f"Failed to retrieve subscription keys: {data}"}
                    return

                keys = data
        else:
            # Get keys for newly created subscription
            status, data = client.post(f"subscriptions/{sub_id}/listSecrets", ver=API_VER)
            if not _is_ok(status):
                yield {"step": 6, "total": total, "status": "error",
                       "message": f"Failed to retrieve keys: {data}"}
                return

            keys = data

        # Final summary
        summary_data = {
            "api_id": api_slug,
            "backend_id": backend_id,
            "operations": len(urls),
            "keys": keys,
        }
        if product_display_name:
            summary_data["product_name"] = product_display_name
        if sub_display_name:
            summary_data["subscription_name"] = sub_display_name

        yield {"step": total, "total": total, "status": "done",
               "message": "Complete",
               "summary": summary_data}
    else:
        # Final summary without consumer
        yield {"step": total, "total": total, "status": "done",
               "message": "Complete",
               "summary": {
                   "api_id": api_slug,
                   "backend_id": backend_id,
                   "operations": len(urls),
               }}
