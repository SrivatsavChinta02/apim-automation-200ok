"""Destructive (DELETE) tools. Gated by ADMIN_PASSWORD verification."""
from flask import current_app
from utils.logger import get_logger
from . import register, Tool
from . import cache as tool_cache

log = get_logger(__name__)


def _client(env):
    return current_app.get_client(env)


def _ok(status):
    return 200 <= status < 300 or status == 204


def _del(env, path, _session_id, invalidate_keys, extra_params=""):
    client = _client(env)
    status, data = client.delete(path, extra_params=extra_params)
    if not _ok(status):
        return {"error": f"DELETE failed (status {status}): {data}"}
    if _session_id:
        for key in invalidate_keys:
            tool_cache.invalidate_tool_for_env(_session_id, key, env)
    return {"ok": True, "deleted": path, "status": status}


# 1. delete_subscription
def _delete_subscription(env, sub_id, _session_id=None):
    result = _del(env, f"subscriptions/{sub_id}", _session_id, ["list_subscriptions"])
    if isinstance(result, dict) and result.get("ok"):
        from services.resource_resolver import invalidate_subscription_cache
        invalidate_subscription_cache(env)
    return result


register(Tool(
    name="delete_subscription",
    description="Delete a subscription. Subscription keys are invalidated. Cannot be undone.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "sub_id": {"type": "string"},
        },
        "required": ["env", "sub_id"],
    },
    handler=_delete_subscription,
    mutates=True,
    requires_password=True,
    cacheable=False,
))


# 2. delete_named_value
def _delete_named_value(env, nv_id, _session_id=None):
    result = _del(env, f"namedValues/{nv_id}", _session_id, ["list_named_values", "get_named_value"])
    if isinstance(result, dict) and result.get("ok"):
        from services.resource_resolver import invalidate_named_value_cache
        invalidate_named_value_cache(env)
    return result


register(Tool(
    name="delete_named_value",
    description="Delete a named value. Any policy XML referring to {{nv_id}} will fail until removed.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "nv_id": {"type": "string"},
        },
        "required": ["env", "nv_id"],
    },
    handler=_delete_named_value,
    mutates=True,
    requires_password=True,
    cacheable=False,
))


# 3. delete_operation
def _delete_operation(env, api_id, op_id, _session_id=None):
    result = _del(env, f"apis/{api_id}/operations/{op_id}", _session_id, ["list_operations", "get_operation_policy"])
    if isinstance(result, dict) and result.get("ok"):
        from services.resource_resolver import invalidate_operation_cache
        invalidate_operation_cache(env, api_id)
    return result


register(Tool(
    name="delete_operation",
    description="Delete a single operation from an API. Per-op policy is removed too.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
            "op_id": {"type": "string"},
        },
        "required": ["env", "api_id", "op_id"],
    },
    handler=_delete_operation,
    mutates=True,
    requires_password=True,
    cacheable=False,
))


# 4. delete_api
def _delete_api(env, api_id, _session_id=None):
    # APIM rejects DELETE /apis/{id} with 400 "Cannot delete the current revision of an API"
    # when the API has more than one revision. `deleteRevisions=true` tells APIM to
    # nuke ALL revisions in one call (intended behavior of this tool per its description).
    result = _del(env, f"apis/{api_id}", _session_id,
                  ["list_apis", "get_api", "list_operations", "list_revisions"],
                  extra_params="&deleteRevisions=true")
    if isinstance(result, dict) and result.get("ok"):
        from services.resource_resolver import invalidate_api_cache
        invalidate_api_cache(env)
    return result


# 4b. delete_product
def _delete_product(env, product_id, _session_id=None):
    # APIM products with API links / subscriptions reject plain DELETE; deleteSubscriptions=true
    # cascades through subscriptions and unlinks APIs in one call.
    result = _del(env, f"products/{product_id}", _session_id,
                  ["list_products", "list_subscriptions"],
                  extra_params="&deleteSubscriptions=true")
    if isinstance(result, dict) and result.get("ok"):
        from services.resource_resolver import invalidate_product_cache
        invalidate_product_cache(env)
    return result


register(Tool(
    name="delete_product",
    description="Delete a product including all its subscriptions and API links. Consumers using this product will lose access. Cannot be undone.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "product_id": {"type": "string"},
        },
        "required": ["env", "product_id"],
    },
    handler=_delete_product,
    mutates=True,
    requires_password=True,
    cacheable=False,
))


register(Tool(
    name="delete_api",
    description="Delete an API including ALL revisions, operations, and policies. Subscriptions to this API will fail until reassigned. Cannot be undone.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
        },
        "required": ["env", "api_id"],
    },
    handler=_delete_api,
    mutates=True,
    requires_password=True,
    cacheable=False,
))


# 5. delete_backend
def _find_pools_containing(client, backend_id):
    """Return list of pool_ids whose member list contains backend_id."""
    from config import BACKEND_API_VER
    backends = client.list_all("backends", ver=BACKEND_API_VER)
    target_suffix = f"/backends/{backend_id}"
    using = []
    for b in backends:
        props = b.get("properties", {}) or {}
        if props.get("type") != "Pool":
            continue
        services = (props.get("pool") or {}).get("services") or []
        for svc in services:
            sid = svc.get("id", "")
            if sid.endswith(target_suffix):
                using.append(b.get("name"))
                break
    return using


def _delete_backend(env, backend_id, _session_id=None):
    from config import BACKEND_API_VER
    client = _client(env)
    # Cascade pre-check: if this backend is in any pool, refuse and tell the LLM
    # how to detach. Otherwise APIM would either silently leave a dangling pool
    # member or surface an obscure error.
    pools_using = _find_pools_containing(client, backend_id)
    if pools_using:
        return {
            "error": f"backend {backend_id} is a member of pool(s): {pools_using}. "
                     f"Detach it first via update_pool_members (omit {backend_id} from the new member list), "
                     f"or delete the pool(s) first.",
            "blocked_by_pools": pools_using,
        }
    status, data = client.delete(f"backends/{backend_id}", ver=BACKEND_API_VER)
    if not _ok(status):
        return {"error": f"DELETE failed (status {status}): {data}"}
    if _session_id:
        for key in ["list_backends"]:
            tool_cache.invalidate_tool_for_env(_session_id, key, env)
    from services.resource_resolver import invalidate_backend_cache
    invalidate_backend_cache(env)
    return {"ok": True, "deleted": f"backends/{backend_id}", "status": status}


register(Tool(
    name="delete_backend",
    description="Delete a backend resource. Any API policy with <set-backend-service backend-id='X'/> referencing this backend will fail. Check `find_apis_using_backend` first.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "backend_id": {"type": "string"},
        },
        "required": ["env", "backend_id"],
    },
    handler=_delete_backend,
    mutates=True,
    requires_password=True,
    cacheable=False,
))


# 6. delete_revision — DELETE /apis/{id};rev={N}. APIM rejects deletion of the
# current revision; caller must set_current_revision to a different rev first.
def _delete_revision(env, api_id, revision, _session_id=None):
    from config import API_VER
    client = _client(env)
    base_id = api_id.split(';rev=')[0] if ';rev=' in api_id else api_id
    rev_id = f"{base_id};rev={int(revision)}"
    status, data = client.delete(f"apis/{rev_id}", ver=API_VER)
    if not _ok(status):
        return {"error": f"DELETE failed (status {status}): {data}"}
    if _session_id:
        for key in ["list_revisions", "get_api"]:
            tool_cache.invalidate_tool_for_env(_session_id, key, env)
    return {"ok": True, "deleted": f"apis/{rev_id}", "status": status}


# 7. delete_tag
def _delete_tag(env, tag_id, _session_id=None):
    result = _del(env, f"tags/{tag_id}", _session_id, ["list_tags"])
    if isinstance(result, dict) and result.get("ok"):
        from services.resource_resolver import invalidate_tag_cache
        invalidate_tag_cache(env)
    return result


register(Tool(
    name="delete_tag",
    description="Delete a tag. APIs and products that had this tag attached lose the association silently. Cannot be undone.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "tag_id": {"type": "string"},
        },
        "required": ["env", "tag_id"],
    },
    handler=_delete_tag,
    mutates=True,
    requires_password=True,
    cacheable=False,
))


register(Tool(
    name="delete_revision",
    description="Delete a specific (non-current) revision of an API. APIM rejects deleting the current revision — use set_current_revision to switch to a different one first if needed.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
            "revision": {"type": "integer"},
        },
        "required": ["env", "api_id", "revision"],
    },
    handler=_delete_revision,
    mutates=True,
    requires_password=True,
    cacheable=False,
))



# 8. promote_api — cross-env promotion (DESTRUCTIVE: writes to dest env, can overwrite prod resources)
def _promote_api(api_id, src_env, dest_env, _session_id=None):
    """Aggregate the promote_service SSE generator into a single tool result.

    Walks all referenced resources (backends, named values, products, tags,
    op-policies) and creates them in dest if missing. Applies codified URL
    transformation rules (Rule 1 -np->-pd, Rule 2 env-tag removal, Rule 4
    API ID prefix) plus learned host substitutions. Destructive because it
    writes to the destination environment and may overwrite existing prod
    resources (especially shared backends).
    """
    api_id = (api_id or "").strip()
    src_env = (src_env or "").strip()
    dest_env = (dest_env or "").strip()
    if not api_id or not src_env or not dest_env:
        return {"error": "api_id, src_env, dest_env are required"}
    if src_env == dest_env:
        return {"error": "src_env and dest_env are the same — nothing to promote"}

    src_client = _client(src_env)
    dest_client = _client(dest_env)
    from services.promote_service import promote_api as _promote
    events = []
    last_status = "running"
    needs_input_seen = False
    for ev in _promote(src_client, dest_client, api_id, src_env, dest_env):
        events.append(ev)
        if ev.get("event") == "promote_resource_missing":
            needs_input_seen = True
        if ev.get("status") in ("done", "error"):
            last_status = ev.get("status")
    summary_msg = events[-1].get("message", "") if events else ""

    # Invalidate dest-env caches that the promote may have populated
    if _session_id:
        for key in ("list_apis", "list_backends", "list_products", "list_subscriptions",
                    "list_named_values", "list_tags"):
            tool_cache.invalidate_tool_for_env(_session_id, key, dest_env)

    return {
        "status": last_status,
        "events_count": len(events),
        "summary": summary_msg,
        "needs_input_seen": needs_input_seen,
        "warning": (
            "Some backend URLs had no prod mapping (AI Foundry case). Used src URL fallback. "
            "User should re-run via manual UI to override interactively."
        ) if needs_input_seen else None,
    }


# 9. delete_certificate
def _delete_certificate(env, cert_id, _session_id=None):
    result = _del(env, f"certificates/{cert_id}", _session_id, ["list_certificates"])
    if isinstance(result, dict) and result.get("ok"):
        try:
            from services.resource_resolver import invalidate_certificate_cache
            invalidate_certificate_cache(env)
        except ImportError:
            pass
    return result


register(Tool(
    name="delete_certificate",
    description="Delete a client certificate by id. Cannot be undone. APIs referencing this cert by thumbprint will fail at runtime.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "cert_id": {"type": "string"},
        },
        "required": ["env", "cert_id"],
    },
    handler=_delete_certificate,
    mutates=True,
    requires_password=True,
    cacheable=False,
))


# 10. delete_ca_certificate
def _delete_ca_certificate(env, ca_id, _session_id=None):
    result = _del(env, f"caCertificates/{ca_id}", _session_id, ["list_ca_certificates"])
    if isinstance(result, dict) and result.get("ok"):
        try:
            from services.resource_resolver import invalidate_ca_certificate_cache
            invalidate_ca_certificate_cache(env)
        except ImportError:
            pass
    return result


register(Tool(
    name="delete_ca_certificate",
    description="Delete a CA certificate by id. APIs relying on this CA chain for backend TLS validation will start failing handshake.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "ca_id": {"type": "string"},
        },
        "required": ["env", "ca_id"],
    },
    handler=_delete_ca_certificate,
    mutates=True,
    requires_password=True,
    cacheable=False,
))


register(Tool(
    name="promote_api",
    description=(
        "DESTRUCTIVE: Promote an API from one environment to another. Walks all referenced "
        "resources (backends, named values, products, tags, op-level policies) and creates "
        "them in dest if missing. Applies codified URL transformation rules (Azure OpenAI "
        "-np->-pd, Cognizant internal env-tag removal, API ID prefixes) plus learned host "
        "substitutions to policy XML. May overwrite existing dest resources, including "
        "shared backends. Requires admin password. Use when the user asks to promote, push, "
        "or deploy an API across environments."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "api_id": {"type": "string", "description": "The API ID to promote."},
            "src_env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"], "description": "Source environment."},
            "dest_env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"], "description": "Destination environment. All four allowed — admin password gates the write."},
        },
        "required": ["api_id", "src_env", "dest_env"],
    },
    handler=_promote_api,
    mutates=True,
    requires_password=True,
    cacheable=False,
))
