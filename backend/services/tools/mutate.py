"""Mutating (POST/PUT) tools. ALL are gated by the confirmation chip.

The handler ONLY runs after the user clicks Confirm in the chat. The handler
does the actual APIM mutation and returns a result dict. On success, it
invalidates relevant cache entries so subsequent read tools see fresh data.
"""
from flask import current_app
from utils.logger import get_logger
from . import register, Tool
from . import cache as tool_cache

log = get_logger(__name__)


def _client(env):
    return current_app.get_client(env)


def _ok(status):
    return 200 <= status < 300


def _invalidate_after_mutation(session_id, env, tool_keys_to_invalidate):
    """After a successful mutation, drop cached read-tool results that overlap."""
    if not session_id:
        return
    for key in tool_keys_to_invalidate:
        tool_cache.invalidate_tool_for_env(session_id, key, env)


def _apply_as_new_revision(client, base_api_id, mutation_fn, description):
    """Clone the current revision -> run mutation_fn against the NEW rev -> release it.

    Used by mutating tools when the user opts in to "save as a new revision"
    (preserves rollback / audit trail). Mirrors the api_creator + onboard
    revision-clone pattern.

    mutation_fn(new_rev_id) -> (status, data) tuple. Performs the actual PUT/PATCH
    against the new revision's URL.

    Returns either {"ok": True, "new_revision": N, "release_name": ...} or
    {"error": "..."}.
    """
    from config import API_VER

    # 1. Find next revision number (APIM returns the rev under `apiRevision`)
    revisions = client.list_all(f"apis/{base_api_id}/revisions", ver=API_VER)
    rev_nums = []
    for rev in revisions:
        rev_str = str(rev.get("apiRevision") or "")
        if rev_str.isdigit():
            rev_nums.append(int(rev_str))
    next_rev = (max(rev_nums) if rev_nums else 1) + 1
    new_rev_id = f"{base_api_id};rev={next_rev}"

    # 2. Get current API props
    status_cur, current_api = client.get(f"apis/{base_api_id}", ver=API_VER)
    if not _ok(status_cur):
        return {"error": f"Failed to fetch current API props: {current_api}"}
    props = current_api.get("properties", {}) or {}

    # 3. Clone current rev with sourceApiId (CRITICAL — copies operations + policies forward)
    revision_body = {
        "properties": {
            "sourceApiId": f"/apis/{base_api_id}",
            "apiRevision": next_rev,
            "apiRevisionDescription": description,
            "displayName": props.get("displayName", ""),
            "path": props.get("path", ""),
            "protocols": props.get("protocols", ["https"]),
            "serviceUrl": props.get("serviceUrl"),
            "isCurrent": False,
        }
    }
    revision_body["properties"] = {k: v for k, v in revision_body["properties"].items() if v is not None}
    status_rev, rev_data = client.put(f"apis/{new_rev_id}", revision_body, ver=API_VER)
    if not _ok(status_rev):
        return {"error": f"Failed to create revision {next_rev}: {rev_data}"}

    # 4. Run the actual mutation against the new revision's URL
    mut_status, mut_data = mutation_fn(new_rev_id)
    if not _ok(mut_status):
        return {"error": f"Mutation on rev {next_rev} failed (status {mut_status}): {mut_data}"}

    # 5. Release the new revision as current
    release_name = f"release-rev{next_rev}"
    release_body = {
        "properties": {
            "apiId": f"/apis/{new_rev_id}",
            "notes": description,
        }
    }
    rel_status, rel_data = client.put(f"apis/{base_api_id}/releases/{release_name}", release_body, ver=API_VER)
    if not _ok(rel_status):
        return {"error": f"Created rev {next_rev} but release failed: {rel_data}"}

    return {"ok": True, "new_revision": next_rev, "release_name": release_name}


# 1. update_operation_policy
def _update_operation_policy(env, api_id, op_id, new_xml, as_new_revision=False, _session_id=None):
    client = _client(env)
    body = {"properties": {"format": "rawxml", "value": new_xml}}

    if as_new_revision:
        def _patch_on_new_rev(new_rev_id):
            return client.put(f"apis/{new_rev_id}/operations/{op_id}/policies/policy", body)
        result = _apply_as_new_revision(client, api_id, _patch_on_new_rev,
                                         f"Update op {op_id} policy")
        if "error" in result:
            return result
        _invalidate_after_mutation(_session_id, env, ["get_operation_policy", "search_in_policy", "list_revisions"])
        from services.resource_resolver import invalidate_operation_cache
        invalidate_operation_cache(env, api_id)
        return {"ok": True, "api_id": api_id, "op_id": op_id, "applied_to": "new_revision",
                "new_revision": result["new_revision"]}

    status, data = client.put(f"apis/{api_id}/operations/{op_id}/policies/policy", body)
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["get_operation_policy", "search_in_policy"])
    from services.resource_resolver import invalidate_operation_cache
    invalidate_operation_cache(env, api_id)
    return {"ok": True, "api_id": api_id, "op_id": op_id, "applied_to": "current_revision_in_place"}


register(Tool(
    name="update_operation_policy",
    description="Replace the inbound/backend/outbound/on-error policy XML for one operation. Full XML is REPLACED (not merged). ALWAYS ask the user 'in place or as a new revision?' before calling. Pass as_new_revision=true to clone current rev, patch, and release (rollback-friendly). Pass false to modify current rev in place.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
            "op_id": {"type": "string"},
            "new_xml": {"type": "string", "description": "Complete <policies>...</policies> XML to PUT"},
            "as_new_revision": {
                "type": "boolean",
                "default": False,
                "description": "If true, clone current rev -> patch -> release as new current. If false, modify current rev in place. ASK user which they prefer; do not default."
            },
        },
        "required": ["env", "api_id", "op_id", "new_xml"],
    },
    handler=_update_operation_policy,
    mutates=True,
    cacheable=False,
))


# 2. update_api_policy
def _update_api_policy(env, api_id, new_xml, as_new_revision=False, _session_id=None):
    client = _client(env)
    body = {"properties": {"format": "rawxml", "value": new_xml}}

    if as_new_revision:
        def _patch_on_new_rev(new_rev_id):
            return client.put(f"apis/{new_rev_id}/policies/policy", body)
        result = _apply_as_new_revision(client, api_id, _patch_on_new_rev,
                                         "Update API-level policy")
        if "error" in result:
            return result
        _invalidate_after_mutation(_session_id, env, ["get_api_policy", "search_in_policy", "list_revisions"])
        from services.resource_resolver import invalidate_api_cache
        invalidate_api_cache(env)
        return {"ok": True, "api_id": api_id, "applied_to": "new_revision",
                "new_revision": result["new_revision"]}

    status, data = client.put(f"apis/{api_id}/policies/policy", body)
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["get_api_policy", "search_in_policy"])
    from services.resource_resolver import invalidate_api_cache
    invalidate_api_cache(env)
    return {"ok": True, "api_id": api_id, "applied_to": "current_revision_in_place"}


register(Tool(
    name="update_api_policy",
    description="Replace the API-level policy XML. Affects ALL operations under this API. ALWAYS ask the user 'in place or as a new revision?' before calling. Pass as_new_revision=true to clone current rev, patch, and release (rollback-friendly). Pass false to modify current rev in place.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
            "new_xml": {"type": "string"},
            "as_new_revision": {
                "type": "boolean",
                "default": False,
                "description": "If true, clone current rev -> patch -> release as new current. If false, modify current rev in place. ASK user which they prefer; do not default."
            },
        },
        "required": ["env", "api_id", "new_xml"],
    },
    handler=_update_api_policy,
    mutates=True,
    cacheable=False,
))


# 3. update_named_value
def _update_named_value(env, nv_id, value, secret=False, _session_id=None):
    client = _client(env)
    body = {"properties": {"displayName": nv_id, "value": value, "secret": bool(secret)}}
    status, data = client.put(f"namedValues/{nv_id}", body)
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_named_values", "get_named_value"])
    from services.resource_resolver import invalidate_named_value_cache
    invalidate_named_value_cache(env)
    return {"ok": True, "nv_id": nv_id, "status": status}


register(Tool(
    name="update_named_value",
    description="Update or create a named value (key/value pair used in policies via {{name}} substitution). If secret=true, value is masked in policy XML viewers.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "nv_id": {"type": "string"},
            "value": {"type": "string"},
            "secret": {"type": "boolean", "default": False},
        },
        "required": ["env", "nv_id", "value"],
    },
    handler=_update_named_value,
    mutates=True,
    cacheable=False,
))


# 4. create_named_value (PUT is upsert in APIM, so we reuse the same handler)
register(Tool(
    name="create_named_value",
    description="Create a new named value. Same semantics as update_named_value (PUT is upsert).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "nv_id": {"type": "string"},
            "value": {"type": "string"},
            "secret": {"type": "boolean", "default": False},
        },
        "required": ["env", "nv_id", "value"],
    },
    handler=_update_named_value,
    mutates=True,
    cacheable=False,
))


# 5. update_subscription_state
def _update_subscription_state(env, sub_id, state, _session_id=None):
    if state not in ("active", "suspended", "cancelled"):
        return {"error": f"invalid state {state!r}; must be active|suspended|cancelled"}
    client = _client(env)
    # APIM uses PATCH for subscription state change
    body = {"properties": {"state": state}}
    status, data = client.patch(f"subscriptions/{sub_id}", body)
    if not _ok(status):
        return {"error": f"PATCH failed (status {status}): {data}"}
    from services.resource_resolver import invalidate_subscription_cache
    invalidate_subscription_cache(env)
    return {"ok": True, "sub_id": sub_id, "state": state}


register(Tool(
    name="update_subscription_state",
    description="Change a subscription's state. Valid: active | suspended | cancelled.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "sub_id": {"type": "string"},
            "state": {"type": "string", "enum": ["active", "suspended", "cancelled"]},
        },
        "required": ["env", "sub_id", "state"],
    },
    handler=_update_subscription_state,
    mutates=True,
    cacheable=False,
))


# 6. regenerate_subscription_keys
def _regenerate_subscription_keys(env, sub_id, which="primary", _session_id=None):
    client = _client(env)
    if which not in ("primary", "secondary", "both"):
        return {"error": f"invalid which={which!r}; must be primary|secondary|both"}
    results = {}
    if which in ("primary", "both"):
        s, _ = client.post(f"subscriptions/{sub_id}/regeneratePrimaryKey")
        results["primary_status"] = s
    if which in ("secondary", "both"):
        s, _ = client.post(f"subscriptions/{sub_id}/regenerateSecondaryKey")
        results["secondary_status"] = s
    # Fetch the new keys
    status, keys = client.post(f"subscriptions/{sub_id}/listSecrets")
    if not _ok(status):
        return {"error": f"could not fetch new keys (status {status})"}
    from services.resource_resolver import invalidate_subscription_cache
    invalidate_subscription_cache(env)
    return {
        "ok": True,
        "sub_id": sub_id,
        "primaryKey": keys.get("primaryKey", ""),
        "secondaryKey": keys.get("secondaryKey", ""),
        "rotated": which,
    }


register(Tool(
    name="regenerate_subscription_keys",
    description="Regenerate primary, secondary, or both keys for a subscription. Returns the new keys in plaintext (treat as sensitive).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "sub_id": {"type": "string"},
            "which": {"type": "string", "enum": ["primary", "secondary", "both"], "default": "primary"},
        },
        "required": ["env", "sub_id"],
    },
    handler=_regenerate_subscription_keys,
    mutates=True,
    cacheable=False,
))


# 7. update_backend_url
def _update_backend_url(env, backend_id, new_url, _session_id=None):
    from config import BACKEND_API_VER
    client = _client(env)
    # Fetch existing to preserve other props
    status, current = client.get(f"backends/{backend_id}", ver=BACKEND_API_VER)
    if not _ok(status):
        return {"error": f"backend {backend_id} not found (status {status})"}
    props = current.get("properties", {})
    props["url"] = new_url
    body = {"properties": props}
    status, data = client.put(f"backends/{backend_id}", body, ver=BACKEND_API_VER)
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_backends", "get_backend"])
    from services.resource_resolver import invalidate_backend_cache
    invalidate_backend_cache(env)
    return {"ok": True, "backend_id": backend_id, "new_url": new_url, "status": status}


register(Tool(
    name="update_backend_url",
    description="Change the URL of a backend resource. Preserves other properties (auth, CB config, etc.).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "backend_id": {"type": "string"},
            "new_url": {"type": "string", "description": "Full URL e.g. https://newhost.cognizant.com"},
        },
        "required": ["env", "backend_id", "new_url"],
    },
    handler=_update_backend_url,
    mutates=True,
    cacheable=False,
))


# 8. add_operation
# Wraps the existing _add_operations_to_existing_api SSE flow but executes
# synchronously (collects all events, returns final summary) since tool
# results must be a single value, not a stream.
def _add_operation(env, api_id, urls, backend_strategy=None, _session_id=None):
    from services.api_creator import _add_operations_to_existing_api
    client = _client(env)
    params = {
        "existing_api_id": api_id,
        "urls": urls,
        "backend_strategy": backend_strategy,
    }
    events = []
    last_status = None
    for ev in _add_operations_to_existing_api(client, params):
        events.append(ev)
        last_status = ev.get("status")
        if last_status == "error":
            return {"error": ev.get("message"), "events": events}
    if last_status not in ("done", "complete"):
        return {"error": f"add_operation did not complete cleanly (last status: {last_status})", "events": events}
    _invalidate_after_mutation(_session_id, env, ["list_operations", "get_api", "list_revisions", "list_backends"])
    from services.resource_resolver import invalidate_operation_cache
    invalidate_operation_cache(env, api_id)
    return {"ok": True, "api_id": api_id, "ops_added": len(urls), "events_count": len(events)}


register(Tool(
    name="add_operation",
    description="Add one or more new operations to an existing API. Each op needs url + verb. backend_strategy='pool' creates an LB pool with existing+new backend; 'standalone' uses per-op set-backend-service. Default keeps existing API-level routing.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
            "urls": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string"},
                        "verb": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]},
                        "client_path": {"type": "string"},
                    },
                    "required": ["url", "verb"],
                },
            },
            "backend_strategy": {"type": "string", "enum": ["pool", "standalone"]},
        },
        "required": ["env", "api_id", "urls"],
    },
    handler=_add_operation,
    mutates=True,
    cacheable=False,
))


# ── Phase 1: backend / pool / product / link ─────────────────────────────────


# 9. create_backend (single)
def _create_backend(env, backend_id, url, protocol="http", title=None, description=None, _session_id=None):
    from config import BACKEND_API_VER
    client = _client(env)
    body = {
        "properties": {
            "url": url,
            "protocol": protocol,
            "title": title or backend_id,
        }
    }
    if description:
        body["properties"]["description"] = description
    status, data = client.put(f"backends/{backend_id}", body, ver=BACKEND_API_VER)
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_backends", "find_apis_using_backend"])
    from services.resource_resolver import invalidate_backend_cache
    invalidate_backend_cache(env)
    return {"ok": True, "backend_id": backend_id, "url": url, "status": status}


# 10. create_pool — multi-member load-balanced backend
def _create_pool(env, pool_id, members, lb_algorithm="roundRobin", _session_id=None):
    """`members` is a list of {backend_id, priority?, weight?} dicts."""
    from config import BACKEND_API_VER
    client = _client(env)
    if not members or len(members) < 2:
        return {"error": "pool requires at least 2 members"}

    # Validate that none of the members are pools (pools cannot contain pools)
    for m in members:
        bid = m.get("backend_id")
        if not bid:
            return {"error": f"each member needs backend_id; got {m}"}
        # Check if this backend is a pool
        status, backend_data = client.get(f"backends/{bid}", ver=BACKEND_API_VER)
        if _ok(status):
            backend_type = backend_data.get("properties", {}).get("type", "")
            if backend_type == "Pool":
                return {"error": f"Cannot add pool '{bid}' as a member. Backend pools cannot be referenced in other backend pools. Use single backends only."}

    pool_services = []
    for m in members:
        bid = m.get("backend_id")
        entry = {"id": f"/backends/{bid}"}
        if "priority" in m: entry["priority"] = int(m["priority"])
        if "weight" in m: entry["weight"] = int(m["weight"])
        pool_services.append(entry)
    body = {
        "properties": {
            "type": "Pool",
            "title": pool_id,
            "pool": {"services": pool_services},
        }
    }
    if lb_algorithm and lb_algorithm != "roundRobin":
        body["properties"]["loadBalancing"] = {"type": lb_algorithm}
    status, data = client.put(f"backends/{pool_id}", body, ver=BACKEND_API_VER)
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_backends", "find_apis_using_backend"])
    return {"ok": True, "pool_id": pool_id, "members": len(pool_services), "lb_algorithm": lb_algorithm}


register(Tool(
    name="create_pool",
    description="Create a load-balanced backend pool with 2+ existing single backends as members. Each member can have priority and weight. Use this AFTER the member backends already exist (call create_backend first).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "pool_id": {"type": "string", "description": "Pool slug, conventionally pool-<api_id>"},
            "members": {
                "type": "array",
                "minItems": 2,
                "items": {
                    "type": "object",
                    "properties": {
                        "backend_id": {"type": "string"},
                        "priority": {"type": "integer", "default": 1},
                        "weight": {"type": "integer", "default": 50},
                    },
                    "required": ["backend_id"],
                },
            },
            "lb_algorithm": {"type": "string", "enum": ["roundRobin", "weighted", "priority"], "default": "roundRobin"},
        },
        "required": ["env", "pool_id", "members"],
    },
    handler=_create_pool,
    mutates=True,
    cacheable=False,
))


# 11. update_pool_members — modify pool composition (add/remove backends, change weights)
def _update_pool_members(env, pool_id, members, lb_algorithm=None, _session_id=None):
    from config import BACKEND_API_VER
    client = _client(env)
    # Fetch existing pool to preserve type/title and decide whether to update lb_algorithm
    status_get, current = client.get(f"backends/{pool_id}", ver=BACKEND_API_VER)
    if not _ok(status_get):
        return {"error": f"pool {pool_id} not found: {current}"}
    cur_props = current.get("properties", {}) or {}
    if cur_props.get("type") != "Pool":
        return {"error": f"backend {pool_id} is not a Pool (type={cur_props.get('type')})"}
    if not members or len(members) < 2:
        return {"error": "pool must keep at least 2 members"}

    # Validate that none of the members are pools (pools cannot contain pools)
    for m in members:
        bid = m.get("backend_id")
        if not bid:
            return {"error": f"each member needs backend_id; got {m}"}
        # Check if this backend is a pool
        status_check, backend_data = client.get(f"backends/{bid}", ver=BACKEND_API_VER)
        if _ok(status_check):
            backend_type = backend_data.get("properties", {}).get("type", "")
            if backend_type == "Pool":
                return {"error": f"Cannot add pool '{bid}' as a member. Backend pools cannot be referenced in other backend pools. Use single backends only."}

    pool_services = []
    for m in members:
        bid = m.get("backend_id")
        entry = {"id": f"/backends/{bid}"}
        if "priority" in m: entry["priority"] = int(m["priority"])
        if "weight" in m: entry["weight"] = int(m["weight"])
        pool_services.append(entry)
    body = {
        "properties": {
            "type": "Pool",
            "title": cur_props.get("title", pool_id),
            "pool": {"services": pool_services},
        }
    }
    effective_algo = lb_algorithm or (cur_props.get("loadBalancing") or {}).get("type") or "roundRobin"
    if effective_algo and effective_algo != "roundRobin":
        body["properties"]["loadBalancing"] = {"type": effective_algo}
    status, data = client.put(f"backends/{pool_id}", body, ver=BACKEND_API_VER)
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_backends", "find_apis_using_backend"])
    return {"ok": True, "pool_id": pool_id, "members": len(pool_services), "lb_algorithm": effective_algo}


register(Tool(
    name="update_pool_members",
    description="Replace the member list of an existing backend pool. Use to add a new backend to a pool, drop one, or change weights/priorities. Pass the FULL desired member list — this REPLACES the existing list (not merge). Pool must keep >=2 members.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "pool_id": {"type": "string"},
            "members": {
                "type": "array",
                "minItems": 2,
                "items": {
                    "type": "object",
                    "properties": {
                        "backend_id": {"type": "string"},
                        "priority": {"type": "integer"},
                        "weight": {"type": "integer"},
                    },
                    "required": ["backend_id"],
                },
            },
            "lb_algorithm": {"type": "string", "enum": ["roundRobin", "weighted", "priority"], "description": "Optional; defaults to current value"},
        },
        "required": ["env", "pool_id", "members"],
    },
    handler=_update_pool_members,
    mutates=True,
    cacheable=False,
))


# 12. create_product
def _create_product(env, product_id, display_name, description=None, state="published",
                    subscription_required=True, approval_required=False, _session_id=None):
    client = _client(env)
    body = {
        "properties": {
            "displayName": display_name,
            "subscriptionRequired": bool(subscription_required),
            "approvalRequired": bool(approval_required),
            "state": state,
        }
    }
    if description:
        body["properties"]["description"] = description
    status, data = client.put(f"products/{product_id}", body)
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_products"])
    from services.resource_resolver import invalidate_product_cache
    invalidate_product_cache(env)
    return {"ok": True, "product_id": product_id, "display_name": display_name, "state": state, "status": status}


register(Tool(
    name="create_product",
    description="Create a new APIM product. After creation use link_api_to_product to attach APIs and create_subscription to grant consumers access. State 'published' makes it discoverable; 'notPublished' is draft.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "product_id": {"type": "string", "description": "Product slug (lowercase, hyphens)"},
            "display_name": {"type": "string"},
            "description": {"type": "string"},
            "state": {"type": "string", "enum": ["published", "notPublished"], "default": "published"},
            "subscription_required": {"type": "boolean", "default": True},
            "approval_required": {"type": "boolean", "default": False},
        },
        "required": ["env", "product_id", "display_name"],
    },
    handler=_create_product,
    mutates=True,
    cacheable=False,
))


# 13. update_product
def _update_product(env, product_id, display_name=None, description=None, state=None,
                    subscription_required=None, approval_required=None, _session_id=None):
    client = _client(env)
    # PATCH semantics — only include fields the caller specified
    props = {}
    if display_name is not None: props["displayName"] = display_name
    if description is not None: props["description"] = description
    if state is not None: props["state"] = state
    if subscription_required is not None: props["subscriptionRequired"] = bool(subscription_required)
    if approval_required is not None: props["approvalRequired"] = bool(approval_required)
    if not props:
        return {"error": "no fields to update"}
    body = {"properties": props}
    status, data = client.patch(f"products/{product_id}", body)
    if not _ok(status):
        return {"error": f"PATCH failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_products"])
    from services.resource_resolver import invalidate_product_cache
    invalidate_product_cache(env)
    return {"ok": True, "product_id": product_id, "patched_fields": list(props.keys()), "status": status}


register(Tool(
    name="update_product",
    description="PATCH product properties — pass only the fields you want to change (display_name / description / state / subscription_required / approval_required). State 'published' or 'notPublished' is the most common use (publish a draft product).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "product_id": {"type": "string"},
            "display_name": {"type": "string"},
            "description": {"type": "string"},
            "state": {"type": "string", "enum": ["published", "notPublished"]},
            "subscription_required": {"type": "boolean"},
            "approval_required": {"type": "boolean"},
        },
        "required": ["env", "product_id"],
    },
    handler=_update_product,
    mutates=True,
    cacheable=False,
))


# 14. link_api_to_product
def _link_api_to_product(env, product_id, api_id, _session_id=None):
    client = _client(env)
    # APIM ProductApi link is PUT /products/{pid}/apis/{aid} with empty body
    status, data = client.put(f"products/{product_id}/apis/{api_id}", {})
    if not _ok(status):
        return {"error": f"link failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_products", "list_subscriptions"])
    return {"ok": True, "product_id": product_id, "api_id": api_id, "linked": True, "status": status}


register(Tool(
    name="link_api_to_product",
    description="Attach an existing API to an existing product. Both must already exist. After linking, subscriptions to the product grant access to this API too.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "product_id": {"type": "string"},
            "api_id": {"type": "string"},
        },
        "required": ["env", "product_id", "api_id"],
    },
    handler=_link_api_to_product,
    mutates=True,
    cacheable=False,
))


# 21. create_tag
def _create_tag(env, tag_id, display_name, _session_id=None):
    client = _client(env)
    body = {"properties": {"displayName": display_name}}
    status, data = client.put(f"tags/{tag_id}", body)
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_tags"])
    from services.resource_resolver import invalidate_tag_cache
    invalidate_tag_cache(env)
    return {"ok": True, "tag_id": tag_id, "display_name": display_name, "status": status}


register(Tool(
    name="create_tag",
    description="Create an APIM tag. Tags can be attached to APIs and products via attach_tag_to_api / attach_tag_to_product to organize / filter resources.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "tag_id": {"type": "string"},
            "display_name": {"type": "string"},
        },
        "required": ["env", "tag_id", "display_name"],
    },
    handler=_create_tag,
    mutates=True,
    cacheable=False,
))


# 22. update_tag
def _update_tag(env, tag_id, display_name, _session_id=None):
    client = _client(env)
    body = {"properties": {"displayName": display_name}}
    status, data = client.patch(f"tags/{tag_id}", body)
    if not _ok(status):
        return {"error": f"PATCH failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_tags"])
    from services.resource_resolver import invalidate_tag_cache
    invalidate_tag_cache(env)
    return {"ok": True, "tag_id": tag_id, "display_name": display_name, "status": status}


register(Tool(
    name="update_tag",
    description="Rename a tag (PATCH displayName).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "tag_id": {"type": "string"},
            "display_name": {"type": "string"},
        },
        "required": ["env", "tag_id", "display_name"],
    },
    handler=_update_tag,
    mutates=True,
    cacheable=False,
))


# 23. attach_tag_to_api
def _attach_tag_to_api(env, api_id, tag_id, _session_id=None):
    client = _client(env)
    status, data = client.put(f"apis/{api_id}/tags/{tag_id}", {})
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_tags", "get_api"])
    return {"ok": True, "api_id": api_id, "tag_id": tag_id, "attached": True, "status": status}


register(Tool(
    name="attach_tag_to_api",
    description="Attach an existing tag to an existing API. Both must already exist.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
            "tag_id": {"type": "string"},
        },
        "required": ["env", "api_id", "tag_id"],
    },
    handler=_attach_tag_to_api,
    mutates=True,
    cacheable=False,
))


# 24. detach_tag_from_api
def _detach_tag_from_api(env, api_id, tag_id, _session_id=None):
    client = _client(env)
    status, data = client.delete(f"apis/{api_id}/tags/{tag_id}")
    if not _ok(status):
        return {"error": f"detach failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_tags", "get_api"])
    return {"ok": True, "api_id": api_id, "tag_id": tag_id, "detached": True, "status": status}


register(Tool(
    name="detach_tag_from_api",
    description="Detach a tag from an API. Tag and API resources unchanged.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
            "tag_id": {"type": "string"},
        },
        "required": ["env", "api_id", "tag_id"],
    },
    handler=_detach_tag_from_api,
    mutates=True,
    cacheable=False,
))


# 25. attach_tag_to_product
def _attach_tag_to_product(env, product_id, tag_id, _session_id=None):
    client = _client(env)
    status, data = client.put(f"products/{product_id}/tags/{tag_id}", {})
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_tags", "list_products"])
    return {"ok": True, "product_id": product_id, "tag_id": tag_id, "attached": True, "status": status}


register(Tool(
    name="attach_tag_to_product",
    description="Attach an existing tag to an existing product.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "product_id": {"type": "string"},
            "tag_id": {"type": "string"},
        },
        "required": ["env", "product_id", "tag_id"],
    },
    handler=_attach_tag_to_product,
    mutates=True,
    cacheable=False,
))


# 26. detach_tag_from_product
def _detach_tag_from_product(env, product_id, tag_id, _session_id=None):
    client = _client(env)
    status, data = client.delete(f"products/{product_id}/tags/{tag_id}")
    if not _ok(status):
        return {"error": f"detach failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_tags", "list_products"])
    return {"ok": True, "product_id": product_id, "tag_id": tag_id, "detached": True, "status": status}


register(Tool(
    name="detach_tag_from_product",
    description="Detach a tag from a product.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "product_id": {"type": "string"},
            "tag_id": {"type": "string"},
        },
        "required": ["env", "product_id", "tag_id"],
    },
    handler=_detach_tag_from_product,
    mutates=True,
    cacheable=False,
))


# 18. update_api — PATCH api props (NOT policy — that's update_api_policy)
def _update_api(env, api_id, display_name=None, description=None, protocols=None,
                service_url=None, path=None, _session_id=None):
    from config import API_VER
    client = _client(env)
    props = {}
    if display_name is not None: props["displayName"] = display_name
    if description is not None: props["description"] = description
    if protocols is not None: props["protocols"] = protocols
    if service_url is not None: props["serviceUrl"] = service_url
    if path is not None: props["path"] = path
    if not props:
        return {"error": "no fields to update"}
    body = {"properties": props}
    status, data = client.patch(f"apis/{api_id}", body, ver=API_VER)
    if not _ok(status):
        return {"error": f"PATCH failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_apis", "get_api"])
    from services.resource_resolver import invalidate_api_cache
    invalidate_api_cache(env)
    return {"ok": True, "api_id": api_id, "patched_fields": list(props.keys()), "status": status}


register(Tool(
    name="update_api",
    description="PATCH API-level metadata (display_name, description, protocols, service_url, path). NOT for policies — use update_api_policy for that. NOT for operations — use add_operation/update_operation_policy.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
            "display_name": {"type": "string"},
            "description": {"type": "string"},
            "protocols": {"type": "array", "items": {"type": "string", "enum": ["http", "https", "ws", "wss"]}},
            "service_url": {"type": "string"},
            "path": {"type": "string"},
        },
        "required": ["env", "api_id"],
    },
    handler=_update_api,
    mutates=True,
    cacheable=False,
))


# 19. update_backend — full props (URL is also covered by update_backend_url; this lets you change protocol/title/description too)
def _update_backend(env, backend_id, url=None, protocol=None, title=None,
                    description=None, _session_id=None):
    from config import BACKEND_API_VER
    client = _client(env)
    props = {}
    if url is not None: props["url"] = url
    if protocol is not None: props["protocol"] = protocol
    if title is not None: props["title"] = title
    if description is not None: props["description"] = description
    if not props:
        return {"error": "no fields to update"}
    body = {"properties": props}
    status, data = client.patch(f"backends/{backend_id}", body, ver=BACKEND_API_VER)
    if not _ok(status):
        return {"error": f"PATCH failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_backends", "find_apis_using_backend"])
    from services.resource_resolver import invalidate_backend_cache
    invalidate_backend_cache(env)
    return {"ok": True, "backend_id": backend_id, "patched_fields": list(props.keys()), "status": status}


register(Tool(
    name="update_backend",
    description="PATCH backend props (url, protocol, title, description). Strictly broader than update_backend_url which only changes the URL. Pass only the fields you want to change.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "backend_id": {"type": "string"},
            "url": {"type": "string"},
            "protocol": {"type": "string", "enum": ["http", "soap"]},
            "title": {"type": "string"},
            "description": {"type": "string"},
        },
        "required": ["env", "backend_id"],
    },
    handler=_update_backend,
    mutates=True,
    cacheable=False,
))


# 20. update_circuit_breaker — toggle / configure CB on an existing backend
def _update_circuit_breaker(env, backend_id, enable=True, failure_count=None,
                            interval_seconds=None, trip_duration_seconds=None,
                            _session_id=None):
    from config import BACKEND_API_VER
    client = _client(env)
    if enable:
        cb = {
            "rules": [
                {
                    "name": f"cb-{backend_id}",
                    "failureCondition": {
                        "count": int(failure_count or 5),
                        "errorReasons": ["Server errors"],
                        "interval": f"PT{int(interval_seconds or 60)}S",
                        "statusCodeRanges": [{"min": 500, "max": 599}],
                    },
                    "tripDuration": f"PT{int(trip_duration_seconds or 30)}S",
                }
            ]
        }
        body = {"properties": {"circuitBreaker": cb}}
        status, data = client.patch(f"backends/{backend_id}", body, ver=BACKEND_API_VER)
    else:
        # APIM PATCH rejects empty rules. To disable, fetch current backend props
        # and PUT them back without the circuitBreaker field.
        s_get, current = client.get(f"backends/{backend_id}", ver=BACKEND_API_VER)
        if not _ok(s_get):
            return {"error": f"could not fetch backend before disable: {current}"}
        cur_props = current.get("properties", {}) or {}
        cur_props.pop("circuitBreaker", None)
        # PUT requires url + protocol — these are always present
        body = {"properties": cur_props}
        status, data = client.put(f"backends/{backend_id}", body, ver=BACKEND_API_VER)
    if not _ok(status):
        return {"error": f"{'PATCH' if enable else 'PUT'} failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_backends"])
    return {"ok": True, "backend_id": backend_id, "circuit_breaker_enabled": bool(enable), "status": status}


register(Tool(
    name="update_circuit_breaker",
    description="ONLY for updating circuit breaker on standalone existing backends. DO NOT use this when user is creating APIs or adding operations - circuit breaker is configured automatically in those flows via user prompts. Use this ONLY when user explicitly asks to update/modify circuit breaker on a specific backend that already exists. enable=true with optional failure_count/interval_seconds/trip_duration_seconds; enable=false to remove. Defaults: 5 failures in 60s, trip for 30s.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "backend_id": {"type": "string"},
            "enable": {"type": "boolean", "default": True},
            "failure_count": {"type": "integer", "default": 5},
            "interval_seconds": {"type": "integer", "default": 60},
            "trip_duration_seconds": {"type": "integer", "default": 30},
        },
        "required": ["env", "backend_id"],
    },
    handler=_update_circuit_breaker,
    mutates=True,
    cacheable=False,
))


# 16. create_revision — explicit clone of current rev as new rev N+1 (not current)
def _create_revision(env, api_id, description=None, _session_id=None):
    from config import API_VER
    client = _client(env)
    base_id = api_id.split(';rev=')[0] if ';rev=' in api_id else api_id

    revisions = client.list_all(f"apis/{base_id}/revisions", ver=API_VER)
    rev_nums = []
    for rev in revisions:
        # APIM returns the rev number under `apiRevision`, not `name`
        rev_str = str(rev.get("apiRevision") or "")
        if rev_str.isdigit():
            rev_nums.append(int(rev_str))
    next_rev = (max(rev_nums) if rev_nums else 1) + 1

    status_cur, current_api = client.get(f"apis/{base_id}", ver=API_VER)
    if not _ok(status_cur):
        return {"error": f"Failed to fetch current API: {current_api}"}
    props = current_api.get("properties", {}) or {}

    new_rev_id = f"{base_id};rev={next_rev}"
    body = {
        "properties": {
            "sourceApiId": f"/apis/{base_id}",
            "apiRevision": next_rev,
            "apiRevisionDescription": description or f"Revision {next_rev} created via tool",
            "displayName": props.get("displayName", ""),
            "path": props.get("path", ""),
            "protocols": props.get("protocols", ["https"]),
            "serviceUrl": props.get("serviceUrl"),
            "isCurrent": False,
        }
    }
    body["properties"] = {k: v for k, v in body["properties"].items() if v is not None}
    status, data = client.put(f"apis/{new_rev_id}", body, ver=API_VER)
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_revisions", "get_api"])
    from services.resource_resolver import invalidate_api_cache
    invalidate_api_cache(env)
    return {"ok": True, "api_id": base_id, "new_revision": next_rev,
            "new_rev_id": new_rev_id, "is_current": False, "status": status}


register(Tool(
    name="create_revision",
    description="Explicitly clone the current revision of an API as a new (non-current) revision. Operations + policies are copied forward via sourceApiId. To make the new revision live, call set_current_revision afterwards.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string", "description": "Base API id (no ;rev= suffix)"},
            "description": {"type": "string", "description": "Optional revision description"},
        },
        "required": ["env", "api_id"],
    },
    handler=_create_revision,
    mutates=True,
    cacheable=False,
))


# 17. set_current_revision — release a specific revision as current
def _set_current_revision(env, api_id, revision, notes=None, _session_id=None):
    from config import API_VER
    client = _client(env)
    base_id = api_id.split(';rev=')[0] if ';rev=' in api_id else api_id
    rev_num = int(revision)
    rev_id = f"{base_id};rev={rev_num}"
    release_name = f"release-rev{rev_num}"
    body = {
        "properties": {
            "apiId": f"/apis/{rev_id}",
            "notes": notes or f"Released revision {rev_num} as current",
        }
    }
    status, data = client.put(f"apis/{base_id}/releases/{release_name}", body, ver=API_VER)
    if not _ok(status):
        return {"error": f"PUT release failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_revisions", "get_api"])
    from services.resource_resolver import invalidate_api_cache
    invalidate_api_cache(env)
    return {"ok": True, "api_id": base_id, "revision": rev_num,
            "release_name": release_name, "is_current": True, "status": status}


register(Tool(
    name="set_current_revision",
    description="Release a specific (already-existing) revision of an API as the current one. The previous current revision becomes non-current but is preserved for rollback.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string", "description": "Base API id"},
            "revision": {"type": "integer", "description": "Revision number to release"},
            "notes": {"type": "string", "description": "Optional release notes"},
        },
        "required": ["env", "api_id", "revision"],
    },
    handler=_set_current_revision,
    mutates=True,
    cacheable=False,
))


# 14b. create_subscription (subscription created against a product, an api, or a product/api pair)
def _create_subscription(env, sub_id, scope_kind, product_id=None, api_id=None,
                         display_name=None, state="active", _session_id=None):
    """scope_kind: 'product' | 'api' | 'product_api'."""
    client = _client(env)
    if scope_kind == "product":
        if not product_id: return {"error": "scope_kind=product needs product_id"}
        scope = f"/products/{product_id}"
    elif scope_kind == "api":
        if not api_id: return {"error": "scope_kind=api needs api_id"}
        scope = f"/apis/{api_id}"
    elif scope_kind == "product_api":
        if not product_id or not api_id:
            return {"error": "scope_kind=product_api needs both product_id and api_id"}
        scope = f"/products/{product_id}/apis/{api_id}"
    else:
        return {"error": f"unknown scope_kind: {scope_kind!r} (use 'product', 'api', or 'product_api')"}
    body = {
        "properties": {
            "scope": scope,
            "displayName": display_name or sub_id,
            "state": state,
        }
    }
    status, data = client.put(f"subscriptions/{sub_id}", body)
    if not _ok(status):
        return {"error": f"PUT failed (status {status}): {data}"}
    # Fetch keys
    key_status, keys = client.post(f"subscriptions/{sub_id}/listSecrets")
    primary = keys.get("primaryKey", "") if _ok(key_status) else ""
    secondary = keys.get("secondaryKey", "") if _ok(key_status) else ""
    _invalidate_after_mutation(_session_id, env, ["list_subscriptions"])
    from services.resource_resolver import invalidate_subscription_cache
    invalidate_subscription_cache(env)
    return {"ok": True, "subscription_id": sub_id, "scope": scope,
            "display_name": display_name or sub_id, "state": state,
            "primary_key_masked": (primary[:4] + "..." + primary[-4:]) if primary else "",
            "secondary_key_masked": (secondary[:4] + "..." + secondary[-4:]) if secondary else "",
            "status": status}


register(Tool(
    name="create_subscription",
    description="Create a subscription scoped to a product, a single API, or a product+API pair. Returns masked keys. Use scope_kind='product' (most common), 'api' (direct API access without a product), or 'product_api' (limit subscription to one API within a product).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "sub_id": {"type": "string", "description": "Subscription slug, e.g. sub-101-mycontracts"},
            "scope_kind": {"type": "string", "enum": ["product", "api", "product_api"]},
            "product_id": {"type": "string", "description": "Required when scope_kind is 'product' or 'product_api'"},
            "api_id": {"type": "string", "description": "Required when scope_kind is 'api' or 'product_api'"},
            "display_name": {"type": "string", "description": "Optional display name; defaults to sub_id"},
            "state": {"type": "string", "enum": ["active", "submitted", "suspended", "rejected", "cancelled", "expired"], "default": "active"},
        },
        "required": ["env", "sub_id", "scope_kind"],
    },
    handler=_create_subscription,
    mutates=True,
    cacheable=False,
))


# 15. unlink_api_from_product
def _unlink_api_from_product(env, product_id, api_id, _session_id=None):
    client = _client(env)
    status, data = client.delete(f"products/{product_id}/apis/{api_id}")
    if not _ok(status):
        return {"error": f"unlink failed (status {status}): {data}"}
    _invalidate_after_mutation(_session_id, env, ["list_products"])
    return {"ok": True, "product_id": product_id, "api_id": api_id, "unlinked": True, "status": status}


register(Tool(
    name="unlink_api_from_product",
    description="Detach an API from a product. Subscriptions to that product lose access to this API. The API resource itself is unchanged.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "product_id": {"type": "string"},
            "api_id": {"type": "string"},
        },
        "required": ["env", "product_id", "api_id"],
    },
    handler=_unlink_api_from_product,
    mutates=True,
    cacheable=False,
))


register(Tool(
    name="create_backend",
    description="Create a new single (non-pool) backend resource. URL points at the upstream service. Use this when you want a backend an API or operation can target via backend-id in policy.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "backend_id": {"type": "string", "description": "Backend slug (lowercase, hyphens), e.g. b-payments"},
            "url": {"type": "string", "description": "Full backend URL the gateway will route to, e.g. https://payments.corp.com/api/v1"},
            "protocol": {"type": "string", "enum": ["http", "soap"], "default": "http"},
            "title": {"type": "string", "description": "Optional display title; defaults to backend_id"},
            "description": {"type": "string", "description": "Optional human description"},
        },
        "required": ["env", "backend_id", "url"],
    },
    handler=_create_backend,
    mutates=True,
    cacheable=False,
))


import base64 as _b64


# 27. upload_certificate
def _upload_certificate(env, base64_data, password, suggested_id, _session_id=None):
    from flask import current_app
    from services.cert_uploader import upload_or_reuse_certificate
    client = current_app.get_client(env)
    try:
        pfx = _b64.b64decode(base64_data)
    except Exception as e:
        return {"ok": False, "error": f"invalid base64 data: {e}"}
    try:
        result = upload_or_reuse_certificate(client, pfx, password, suggested_id)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    try:
        from services.resource_resolver import invalidate_certificate_cache
        invalidate_certificate_cache(env)
    except ImportError:
        pass  # Task 4 will add this helper
    return {"ok": True, **result}


register(Tool(
    name="upload_certificate",
    description="Upload a client certificate (PFX/PKCS#12, base64-encoded) to APIM cert store. Reuses by thumbprint when possible. Returns cert_id, thumbprint, reused flag.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "base64_data": {"type": "string", "description": "Base64-encoded PFX file content"},
            "password": {"type": "string"},
            "suggested_id": {"type": "string"},
        },
        "required": ["env", "base64_data", "password", "suggested_id"],
    },
    handler=_upload_certificate,
    mutates=True,
    requires_password=True,
    cacheable=False,
))


# 28. upload_ca_certificate
def _upload_ca_certificate(env, base64_data, password, suggested_id, store_name, _session_id=None):
    from flask import current_app
    from services.cert_uploader import upload_or_reuse_ca_certificate
    client = current_app.get_client(env)
    try:
        pfx = _b64.b64decode(base64_data)
    except Exception as e:
        return {"ok": False, "error": f"invalid base64 data: {e}"}
    try:
        result = upload_or_reuse_ca_certificate(client, pfx, password, suggested_id, store_name)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    try:
        from services.resource_resolver import invalidate_ca_certificate_cache
        invalidate_ca_certificate_cache(env)
    except ImportError:
        pass  # Task 4 will add this helper
    return {"ok": True, **result}


register(Tool(
    name="upload_ca_certificate",
    description="Upload a CA certificate (PFX/PKCS#12, base64-encoded). store_name must be 'Root' or 'CertificateAuthority'.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "base64_data": {"type": "string"},
            "password": {"type": "string"},
            "suggested_id": {"type": "string"},
            "store_name": {"type": "string", "enum": ["Root", "CertificateAuthority"]},
        },
        "required": ["env", "base64_data", "password", "suggested_id", "store_name"],
    },
    handler=_upload_ca_certificate,
    mutates=True,
    requires_password=True,
    cacheable=False,
))


# promote_api lives in destructive.py — moved 2026-05-04 because cross-env
# promotion (especially to prod/dr) is destructive in the same way delete_api
# is and must be gated by admin password.
