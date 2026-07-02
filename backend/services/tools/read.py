"""Read-only inspection tools exposed to the analytical assistant LLM."""
from urllib.parse import urlparse

from flask import current_app

from config import API_VER
from utils.logger import get_logger
from . import register, Tool

log = get_logger(__name__)


def _client(env: str):
    return current_app.get_client(env)


# 1. list_apis ---------------------------------------------------------
def _list_apis(env: str):
    client = _client(env)
    apis = client.list_all("apis", extra_params="&$filter=isCurrent eq true&$top=500")
    out = []
    for api in apis:
        props = api.get("properties", {})
        api_id = api.get("name", "")
        if not api_id or ";rev=" in api_id:
            continue
        out.append({
            "id": api_id,
            "displayName": props.get("displayName", api_id),
            "path": props.get("path", ""),
            "revision": props.get("apiRevision", "1"),
            "isCurrent": props.get("isCurrent", False),
        })
    return out


register(Tool(
    name="list_apis",
    description="List all current APIs in the given environment. Returns id, displayName, path, current revision number.",
    input_schema={
        "type": "object",
        "properties": {"env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]}},
        "required": ["env"],
    },
    handler=_list_apis,
))


# 2. get_api -----------------------------------------------------------
def _get_api(env: str, api_id: str):
    client = _client(env)
    status, data = client.get(f"apis/{api_id}")
    if status == 404:
        return {"error": f"API {api_id} not found in {env}"}
    if not (200 <= status < 300):
        return {"error": f"GET apis/{api_id} returned {status}"}
    props = data.get("properties", {})
    return {
        "id": api_id,
        "displayName": props.get("displayName", ""),
        "path": props.get("path", ""),
        "protocols": props.get("protocols", []),
        "revision": props.get("apiRevision", "1"),
        "isCurrent": props.get("isCurrent", False),
        "subscriptionRequired": props.get("subscriptionRequired", True),
        "apiVersion": props.get("apiVersion"),
        "apiVersionSetId": props.get("apiVersionSetId"),
    }


register(Tool(
    name="get_api",
    description="Get details of a specific API by id or name in the given environment. Supports fuzzy matching: you can use partial names, case-insensitive search, or display names. Examples: 'mycontracts', 'MyContracts', '757-MyContracts' all work.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string", "description": "API id or partial/fuzzy name (case-insensitive)"},
        },
        "required": ["env", "api_id"],
    },
    handler=_get_api,
))


# 3. list_operations ---------------------------------------------------
def _list_operations(env: str, api_id: str):
    client = _client(env)
    ops = client.list_all(f"apis/{api_id}/operations")
    return [
        {
            "id": op.get("name", ""),
            "method": op.get("properties", {}).get("method", ""),
            "urlTemplate": op.get("properties", {}).get("urlTemplate", ""),
            "displayName": op.get("properties", {}).get("displayName", ""),
        }
        for op in ops
    ]


register(Tool(
    name="list_operations",
    description="List all operations of an API in the given environment. Returns method, urlTemplate, displayName per operation. Supports fuzzy matching on api_id (case-insensitive, partial names, display names).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string", "description": "API id or partial/fuzzy name (case-insensitive)"},
        },
        "required": ["env", "api_id"],
    },
    handler=_list_operations,
))


# 4. get_api_policy ----------------------------------------------------
def _extract_policy_xml(data):
    """The APIM policies endpoint returns either raw xml string (rawxml=True) or a JSON wrapper."""
    if isinstance(data, str):
        return data
    if isinstance(data, dict):
        return data.get("raw") or data.get("properties", {}).get("value", "") or ""
    return ""


def _get_api_policy(env: str, api_id: str):
    client = _client(env)
    status, data = client.get(f"apis/{api_id}/policies/policy", rawxml=True)
    if status == 404:
        return {"xml": None, "exists": False}
    if not (200 <= status < 300):
        return {"error": f"status={status}"}
    xml = _extract_policy_xml(data)
    return {"xml": xml, "exists": True, "length": len(xml or "")}


register(Tool(
    name="get_api_policy",
    description="Get the API-level inbound/backend/outbound/on-error policy XML for an API. Supports fuzzy matching on api_id (case-insensitive, partial names, display names).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string", "description": "API id or partial/fuzzy name (case-insensitive)"},
        },
        "required": ["env", "api_id"],
    },
    handler=_get_api_policy,
))


# 5. get_operation_policy ----------------------------------------------
def _get_operation_policy(env: str, api_id: str, op_id: str):
    client = _client(env)
    status, data = client.get(f"apis/{api_id}/operations/{op_id}/policies/policy", rawxml=True)
    if status == 404:
        return {"xml": None, "exists": False}
    if not (200 <= status < 300):
        return {"error": f"status={status}"}
    xml = _extract_policy_xml(data)
    return {"xml": xml, "exists": True, "length": len(xml or "")}


register(Tool(
    name="get_operation_policy",
    description="Get the operation-level policy XML for a specific operation. Supports fuzzy matching on api_id (case-insensitive, partial names, display names).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string", "description": "API id or partial/fuzzy name (case-insensitive)"},
            "op_id": {"type": "string"},
        },
        "required": ["env", "api_id", "op_id"],
    },
    handler=_get_operation_policy,
))


# 6. list_revisions ----------------------------------------------------
def _list_revisions(env: str, api_id: str):
    client = _client(env)
    # Strip version/revision suffix if present to get base API ID
    base_id = api_id.split(';rev=')[0].split(';ver=')[0] if ';' in api_id else api_id
    revs = client.list_all(f"apis/{base_id}/revisions", ver=API_VER)
    out = []
    for rev in revs:
        props = rev.get("properties", {})
        out.append({
            "revision": props.get("apiRevision") or rev.get("name", ""),
            "isCurrent": props.get("isCurrentRevision", props.get("isCurrent", False)),
            "createdDateTime": props.get("createdDateTime", ""),
            "updatedDateTime": props.get("updatedDateTime", ""),
            "description": props.get("description", ""),
        })
    return out


register(Tool(
    name="list_revisions",
    description="List all revisions of an API. Returns revision number, isCurrent flag, timestamps, description per revision. Useful for finding APIs with many revisions or checking revision history.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
        },
        "required": ["env", "api_id"],
    },
    handler=_list_revisions,
))


# 6b. list_versions ----------------------------------------------------
def _list_versions(env: str, api_id: str):
    """List all versions in an API's version set.

    Returns list of versions (e.g., Original, Dev, SIT) with their IDs and metadata.
    If the API is not part of a version set, returns just the single API.
    """
    client = _client(env)
    # Strip version/revision suffix if present
    base_id = api_id.split(';rev=')[0].split(';ver=')[0] if ';' in api_id else api_id

    # Get the API to check if it has a version set
    status, api_data = client.get(f"apis/{base_id}", ver=API_VER)
    if status != 200:
        return []

    props = api_data.get("properties", {})
    version_set_id = props.get("apiVersionSetId")

    if not version_set_id:
        # API is not versioned - return just this one
        return [{
            "id": api_data.get("name", base_id),
            "displayName": props.get("displayName", base_id),
            "versionName": props.get("apiVersion", "Original"),
            "revision": props.get("apiRevision", "1"),
            "isCurrent": props.get("isCurrent", True),
            "path": props.get("path", ""),
        }]

    # Fetch all APIs in this version set (current revisions only)
    all_apis = client.list_all("apis", extra_params="&$filter=isCurrent eq true", ver=API_VER)
    all_versions = []
    for api in all_apis:
        api_props = api.get("properties", {})
        if api_props.get("apiVersionSetId") == version_set_id:
            all_versions.append({
                "id": api.get("name", ""),
                "displayName": api_props.get("displayName", ""),
                "versionName": api_props.get("apiVersion", "Original"),
                "revision": api_props.get("apiRevision", "1"),
                "isCurrent": api_props.get("isCurrent", False),
                "path": api_props.get("path", ""),
            })

    # Deduplicate by versionName - keep current revision or latest
    versions_map = {}
    for v in all_versions:
        ver_name = v["versionName"]
        if ver_name not in versions_map:
            versions_map[ver_name] = v
        else:
            existing = versions_map[ver_name]
            # Prefer current revision, otherwise take higher revision number
            if v["isCurrent"] or (not existing["isCurrent"] and int(v["revision"]) > int(existing["revision"])):
                versions_map[ver_name] = v

    return list(versions_map.values())


register(Tool(
    name="list_versions",
    description="List all versions of an API (e.g., Original, Dev, SIT). Returns version names, IDs, paths, and current revision per version. Use this to answer 'how many versions does X have' or 'list all versions of X'. For revision history within a single version, use list_revisions instead.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
        },
        "required": ["env", "api_id"],
    },
    handler=_list_versions,
))


# 7. list_backends -----------------------------------------------------
def _list_backends(env: str):
    from config import BACKEND_API_VER
    client = _client(env)
    bs = client.list_all("backends", ver=BACKEND_API_VER)
    out = []
    for b in bs:
        props = b.get("properties", {})
        url = props.get("url", "") or ""
        out.append({
            "id": b.get("name", ""),
            "type": props.get("type", "Single"),
            "url": url,
            "host": (urlparse(url).hostname or "").lower() if url else "",
            "title": props.get("title", ""),
            "circuitBreaker": props.get("circuitBreaker"),
            "poolMembers": [s.get("id", "").split("/")[-1] for s in (props.get("pool", {}) or {}).get("services", [])],
        })
    return out


register(Tool(
    name="list_backends",
    description="List all backends in the env. Returns id, type (Single/Pool), url, host, circuit breaker config, pool members. Useful for finding backends by host, identifying pools, checking CB configuration.",
    input_schema={
        "type": "object",
        "properties": {"env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]}},
        "required": ["env"],
    },
    handler=_list_backends,
))


# 8. search_in_policy --------------------------------------------------
def _excerpt(xml: str, pattern):
    if not xml:
        return ""
    m = pattern.search(xml)
    if not m:
        return ""
    start = max(0, m.start() - 40)
    end = min(len(xml), m.end() + 40)
    return ("..." if start > 0 else "") + xml[start:end].replace("\n", " ").strip() + ("..." if end < len(xml) else "")


def _search_in_policy(env: str, regex: str, scope: str = "all", api_id: str = None):
    """Search regex across api-level policies (and optionally op-level if scope='deep').

    scope='all'   = api-level policies of all APIs (default; faster, ~1 call per API)
    scope='deep'  = api-level + op-level policies (slow, but thorough)
    api_id=X      = scope to that single API (api-level + op-level, regardless of scope arg)
    """
    import re as _re
    client = _client(env)
    pattern = _re.compile(regex, _re.IGNORECASE | _re.DOTALL)
    matches = []

    if api_id:
        target_apis = [api_id]
    else:
        apis = client.list_all("apis", extra_params="&$filter=isCurrent eq true&$top=500")
        target_apis = [a.get("name") for a in apis if a.get("name") and ";rev=" not in a.get("name", "")]

    for aid in target_apis:
        # API-level
        s, d = client.get(f"apis/{aid}/policies/policy", rawxml=True)
        if 200 <= s < 300:
            xml = _extract_policy_xml(d)
            if pattern.search(xml or ""):
                matches.append({"api_id": aid, "scope": "api", "snippet": _excerpt(xml, pattern)})
        # Op-level only if api_id was specified, OR scope == 'deep'
        if api_id or scope == "deep":
            ops = client.list_all(f"apis/{aid}/operations")
            for op in ops:
                op_id = op.get("name", "")
                s, d = client.get(f"apis/{aid}/operations/{op_id}/policies/policy", rawxml=True)
                if 200 <= s < 300:
                    xml = _extract_policy_xml(d)
                    if pattern.search(xml or ""):
                        matches.append({"api_id": aid, "op_id": op_id, "scope": "operation", "snippet": _excerpt(xml, pattern)})
    return matches


register(Tool(
    name="search_in_policy",
    description="Find a regex pattern across policy XML. scope='all' searches API-level policies of all APIs (fast). scope='deep' also searches operation-level policies (slow). Pass api_id to scope to a single API including all its op-level policies. Returns matching api_id, scope, and a snippet around the match.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "regex": {"type": "string", "description": "Python regex pattern (case-insensitive, multiline)"},
            "scope": {"type": "string", "enum": ["all", "deep"], "default": "all"},
            "api_id": {"type": "string", "description": "If set, scope to this api (api-level + all op-level)"},
        },
        "required": ["env", "regex"],
    },
    handler=_search_in_policy,
))


# 9. list_products -----------------------------------------------------
def _list_products(env: str):
    client = _client(env)
    products = client.list_all("products")
    out = []
    for p in products:
        props = p.get("properties", {})
        out.append({
            "id": p.get("name", ""),
            "displayName": props.get("displayName", ""),
            "state": props.get("state", ""),
            "subscriptionRequired": props.get("subscriptionRequired", True),
        })
    return out


register(Tool(
    name="list_products",
    description="List all products in the env. Each product has id, displayName, state (published/notPublished), subscriptionRequired.",
    input_schema={"type": "object", "properties": {"env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]}}, "required": ["env"]},
    handler=_list_products,
))


# 10. list_named_values ------------------------------------------------
def _list_named_values(env: str):
    client = _client(env)
    nvs = client.list_all("namedValues")
    out = []
    for n in nvs:
        props = n.get("properties", {})
        out.append({
            "id": n.get("name", ""),
            "displayName": props.get("displayName", ""),
            "secret": props.get("secret", False),
            "value": "<masked>" if props.get("secret") else props.get("value", ""),
            "tags": props.get("tags", []),
        })
    return out


register(Tool(
    name="list_named_values",
    description="List all named values (key/value pairs used in policies via {{name}} substitution) in the env. Secret values are masked. Use to find named values, check if one exists, or audit secrets.",
    input_schema={"type": "object", "properties": {"env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]}}, "required": ["env"]},
    handler=_list_named_values,
))


# 11. list_subscriptions -----------------------------------------------
def _list_subscriptions(env: str, product_id: str = None):
    client = _client(env)
    path = f"products/{product_id}/subscriptions" if product_id else "subscriptions"
    subs = client.list_all(path)
    out = []
    for s in subs:
        props = s.get("properties", {})
        scope = props.get("scope", "")
        out.append({
            "id": s.get("name", ""),
            "displayName": props.get("displayName", ""),
            "state": props.get("state", ""),
            "scope": scope,
            "scope_kind": "product" if "/products/" in scope else ("api" if "/apis/" in scope else "other"),
            "ownerId": props.get("ownerId", ""),
            "createdDate": props.get("createdDate", ""),
        })
    return out


register(Tool(
    name="list_subscriptions",
    description="List subscriptions in the env. Pass product_id to scope to one product's subscriptions, or omit for all. Returns id, displayName, state (active/suspended/cancelled), scope (the product/api this subscribes to).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "product_id": {"type": "string", "description": "Optional - restrict to one product"},
        },
        "required": ["env"],
    },
    handler=_list_subscriptions,
))


# 12. find_apis_using_backend ------------------------------------------
def _find_apis_using_backend(env: str, backend_id: str):
    """Reverse-lookup: which APIs reference this backend in their api-level policy?"""
    import re as _re
    client = _client(env)
    apis = client.list_all("apis", extra_params="&$filter=isCurrent eq true&$top=500")
    pattern = _re.compile(r'backend-id="' + _re.escape(backend_id) + r'"')
    using = []
    for api in apis:
        api_id = api.get("name", "")
        if not api_id or ";rev=" in api_id:
            continue
        s, d = client.get(f"apis/{api_id}/policies/policy", rawxml=True)
        if 200 <= s < 300:
            xml = d if isinstance(d, str) else d.get("raw") or d.get("properties", {}).get("value", "")
            if pattern.search(xml or ""):
                using.append({
                    "api_id": api_id,
                    "displayName": api.get("properties", {}).get("displayName", api_id),
                    "scope": "api",
                })
    return {"backend_id": backend_id, "apis_using": using, "count": len(using)}


# --- get_backend ---
def _get_backend(env: str, backend_id: str):
    from config import BACKEND_API_VER
    client = _client(env)
    status, data = client.get(f"backends/{backend_id}", ver=BACKEND_API_VER)
    if status == 404:
        return {"error": f"Backend {backend_id} not found in {env}"}
    if not (200 <= status < 300):
        return {"error": f"GET backends/{backend_id} returned {status}"}
    props = data.get("properties", {}) or {}
    out = {
        "id": backend_id,
        "type": props.get("type", "Single"),
        "url": props.get("url"),
        "protocol": props.get("protocol"),
        "title": props.get("title"),
        "description": props.get("description"),
    }
    cb = props.get("circuitBreaker") or {}
    if cb.get("rules"):
        out["circuit_breaker"] = cb["rules"]
    pool = props.get("pool") or {}
    if pool.get("services"):
        out["pool_members"] = [s.get("id", "").rsplit("/", 1)[-1] for s in pool["services"]]
        out["load_balancing"] = (props.get("loadBalancing") or {}).get("type", "roundRobin")
    return out


register(Tool(
    name="get_backend",
    description="Fetch one backend's full props: type (Single/Pool), url, protocol, circuit breaker rules, pool members + load-balancing algo. Use this to inspect a backend before update_backend / update_circuit_breaker.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "backend_id": {"type": "string"},
        },
        "required": ["env", "backend_id"],
    },
    handler=_get_backend,
))


# --- get_product ---
def _get_product(env: str, product_id: str):
    client = _client(env)
    status, data = client.get(f"products/{product_id}")
    if status == 404:
        return {"error": f"Product {product_id} not found in {env}"}
    if not (200 <= status < 300):
        return {"error": f"GET products/{product_id} returned {status}"}
    props = data.get("properties", {}) or {}
    return {
        "id": product_id,
        "display_name": props.get("displayName"),
        "description": props.get("description"),
        "state": props.get("state"),
        "subscription_required": props.get("subscriptionRequired"),
        "approval_required": props.get("approvalRequired"),
        "subscriptions_limit": props.get("subscriptionsLimit"),
    }


register(Tool(
    name="get_product",
    description="Fetch one product's props: state (published/notPublished), displayName, description, subscription/approval flags. Inspect before update_product.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "product_id": {"type": "string"},
        },
        "required": ["env", "product_id"],
    },
    handler=_get_product,
))


# --- list_product_apis ---
def _list_product_apis(env: str, product_id: str):
    """Return APIs linked to a given product (authoritative ARM source)."""
    client = _client(env)
    apis = client.list_all(f"products/{product_id}/apis")
    return {
        "product_id": product_id,
        "count": len(apis),
        "apis": [
            {
                "id": a.get("name", ""),
                "display_name": (a.get("properties") or {}).get("displayName"),
                "path": (a.get("properties") or {}).get("path"),
            }
            for a in apis
        ],
    }


register(Tool(
    name="list_product_apis",
    description="List APIs linked to a specific product (authoritative ARM source — use this instead of guessing product↔API linkage from naming or policies). Returns api id, displayName, and path for each linked API.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "product_id": {"type": "string"},
        },
        "required": ["env", "product_id"],
    },
    handler=_list_product_apis,
))


# --- list_api_products ---
def _list_api_products(env: str, api_id: str):
    """Return products that an API is linked to (reverse of list_product_apis). Supports fuzzy API name matching."""
    client = _client(env)

    # Try exact match first
    status, _ = client.get(f"apis/{api_id}")
    if status == 404:
        # API not found - try fuzzy matching
        all_apis = client.list_all("apis")

        # Fuzzy match: case-insensitive, partial match
        api_id_lower = api_id.lower().replace("-", "").replace("_", "")
        matches = []
        for api in all_apis:
            api_name = api.get("name", "")
            api_display = (api.get("properties") or {}).get("displayName", "")
            api_name_normalized = api_name.lower().replace("-", "").replace("_", "")
            api_display_normalized = api_display.lower().replace("-", "").replace("_", "")

            # Check if input matches API ID or display name (partial or exact)
            if (api_id_lower in api_name_normalized or
                api_name_normalized in api_id_lower or
                api_id_lower in api_display_normalized or
                api_display_normalized in api_id_lower):
                matches.append({
                    "id": api_name,
                    "display_name": api_display,
                })

        if len(matches) == 0:
            return {
                "error": f"API '{api_id}' not found in {env}. No similar APIs found.",
                "tried_fuzzy_match": True,
            }
        elif len(matches) == 1:
            # Single match - use it
            matched_api_id = matches[0]["id"]
            products = client.list_all(f"apis/{matched_api_id}/products")
            return {
                "api_id": matched_api_id,
                "fuzzy_matched": True,
                "original_query": api_id,
                "matched_display_name": matches[0]["display_name"],
                "count": len(products),
                "products": [
                    {
                        "id": p.get("name", ""),
                        "display_name": (p.get("properties") or {}).get("displayName"),
                        "state": (p.get("properties") or {}).get("state"),
                    }
                    for p in products
                ],
            }
        else:
            # Multiple matches - return them for clarification
            return {
                "error": f"Multiple APIs match '{api_id}'. Please be more specific.",
                "matches": matches,
                "tried_fuzzy_match": True,
            }

    # Exact match found
    products = client.list_all(f"apis/{api_id}/products")
    return {
        "api_id": api_id,
        "count": len(products),
        "products": [
            {
                "id": p.get("name", ""),
                "display_name": (p.get("properties") or {}).get("displayName"),
                "state": (p.get("properties") or {}).get("state"),
            }
            for p in products
        ],
    }


register(Tool(
    name="list_api_products",
    description="List products that a specific API is linked to (reverse direction of list_product_apis). Supports fuzzy API name matching (case-insensitive, partial match). Useful when answering 'which products consume API X' or 'is API X protected by any product'. Authoritative ARM source.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "api_id": {"type": "string"},
        },
        "required": ["env", "api_id"],
    },
    handler=_list_api_products,
))


# --- get_named_value ---
def _get_named_value(env: str, nv_id: str, include_secret: bool = False):
    client = _client(env)
    status, data = client.get(f"namedValues/{nv_id}")
    if status == 404:
        return {"error": f"Named value {nv_id} not found in {env}"}
    if not (200 <= status < 300):
        return {"error": f"GET namedValues/{nv_id} returned {status}"}
    props = data.get("properties", {}) or {}
    out = {
        "id": nv_id,
        "display_name": props.get("displayName"),
        "secret": props.get("secret", False),
        "tags": props.get("tags") or [],
    }
    if include_secret:
        # listValue gives the actual value (works for both secret and non-secret)
        s2, vdata = client.post(f"namedValues/{nv_id}/listValue")
        if 200 <= s2 < 300:
            out["value"] = vdata.get("value")
        else:
            out["value_error"] = f"listValue returned {s2}"
    else:
        out["value"] = props.get("value") if not props.get("secret") else "***"
    return out


register(Tool(
    name="get_named_value",
    description="Fetch one named value by id. Returns displayName, secret flag, tags, and value (masked if secret unless include_secret=true).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "nv_id": {"type": "string"},
            "include_secret": {"type": "boolean", "default": False, "description": "If true, fetch via listValue endpoint to get raw value of secret named values"},
        },
        "required": ["env", "nv_id"],
    },
    handler=_get_named_value,
))


# --- list_tags ---
def _list_tags(env: str):
    client = _client(env)
    tags = client.list_all("tags")
    return [
        {"id": t.get("name", ""), "display_name": (t.get("properties") or {}).get("displayName")}
        for t in tags
    ]


register(Tool(
    name="list_tags",
    description="List all tags in the env.",
    input_schema={
        "type": "object",
        "properties": {"env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]}},
        "required": ["env"],
    },
    handler=_list_tags,
))


# --- get_subscription ---
def _get_subscription(env: str, sub_id: str, include_keys: bool = False):
    client = _client(env)
    status, data = client.get(f"subscriptions/{sub_id}")
    if status == 404:
        return {"error": f"Subscription {sub_id} not found in {env}"}
    if not (200 <= status < 300):
        return {"error": f"GET subscriptions/{sub_id} returned {status}: {data}"}
    props = data.get("properties", {}) or {}
    out = {
        "id": sub_id,
        "scope": props.get("scope", ""),
        "display_name": props.get("displayName", ""),
        "state": props.get("state", ""),
        "created_date": props.get("createdDate", ""),
    }
    if include_keys:
        kstatus, keys = client.post(f"subscriptions/{sub_id}/listSecrets")
        if 200 <= kstatus < 300:
            out["primary_key"] = keys.get("primaryKey", "")
            out["secondary_key"] = keys.get("secondaryKey", "")
        else:
            out["keys_error"] = f"listSecrets returned {kstatus}"
    return out


register(Tool(
    name="get_subscription",
    description="Fetch a single subscription by id. Returns scope (which product/api the sub is for), state, displayName. Set include_keys=true to also return primary/secondary keys (sensitive — only when explicitly asked).",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "sub_id": {"type": "string"},
            "include_keys": {"type": "boolean", "default": False, "description": "Return raw primary/secondary keys"},
        },
        "required": ["env", "sub_id"],
    },
    handler=_get_subscription,
))


register(Tool(
    name="find_apis_using_backend",
    description="Reverse-lookup: which APIs in this env reference the given backend in their API-level policy via <set-backend-service backend-id='X'/>. Faster than listing all APIs and inspecting each policy yourself. Use BEFORE deleting a backend to confirm nothing depends on it.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "backend_id": {"type": "string"},
        },
        "required": ["env", "backend_id"],
    },
    handler=_find_apis_using_backend,
))


# Certificates (client certs - separate APIM resource from CA certs)
def _list_certificates(env: str):
    client = _client(env)
    items = client.list_all("certificates")
    return [
        {
            "id": it.get("name", ""),
            "subject": it.get("properties", {}).get("subject", ""),
            "thumbprint": it.get("properties", {}).get("thumbprint", ""),
            "expiration_date": it.get("properties", {}).get("expirationDate", ""),
        }
        for it in items
    ]


register(Tool(
    name="list_certificates",
    description="List all client certificates uploaded to APIM cert store. Returns id/subject/thumbprint/expiration.",
    input_schema={
        "type": "object",
        "properties": {"env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]}},
        "required": ["env"],
    },
    handler=_list_certificates,
    cacheable=True,
    mutates=False,
))


def _get_certificate(env: str, cert_id: str):
    client = _client(env)
    status, data = client.get(f"certificates/{cert_id}")
    if status == 404:
        return {"error": f"certificate {cert_id} not found"}
    return data


register(Tool(
    name="get_certificate",
    description="Get details (subject, thumbprint, expiration) of a specific client certificate by id.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "cert_id": {"type": "string"},
        },
        "required": ["env", "cert_id"],
    },
    handler=_get_certificate,
    cacheable=True,
    mutates=False,
))


def _list_ca_certificates(env: str):
    client = _client(env)
    status, data = client.get("certificateAuthorities")
    if status == 404:
        # certificateAuthorities not available on this APIM tier/API version
        return []
    if not (200 <= status < 300):
        return {"error": f"GET certificateAuthorities returned {status}"}
    items = data.get("value", []) if isinstance(data, dict) else []
    return [
        {
            "id": it.get("name", ""),
            "subject": it.get("properties", {}).get("subject", ""),
            "thumbprint": it.get("properties", {}).get("thumbprint", ""),
            "store_name": it.get("properties", {}).get("storeName", ""),
            "expiration_date": it.get("properties", {}).get("expirationDate", ""),
        }
        for it in items
    ]


register(Tool(
    name="list_ca_certificates",
    description="List all CA certificates (Root + CertificateAuthority stores) uploaded to APIM. Used for backend TLS chain validation.",
    input_schema={
        "type": "object",
        "properties": {"env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]}},
        "required": ["env"],
    },
    handler=_list_ca_certificates,
    cacheable=True,
    mutates=False,
))


def _get_ca_certificate(env: str, ca_id: str):
    client = _client(env)
    status, data = client.get(f"certificateAuthorities/{ca_id}")
    if status == 404:
        return {"error": f"CA certificate {ca_id} not found"}
    return data


register(Tool(
    name="get_ca_certificate",
    description="Get details of a specific CA certificate by id.",
    input_schema={
        "type": "object",
        "properties": {
            "env": {"type": "string", "enum": ["dev", "sandbox", "prod", "dr"]},
            "ca_id": {"type": "string"},
        },
        "required": ["env", "ca_id"],
    },
    handler=_get_ca_certificate,
    cacheable=True,
    mutates=False,
))
