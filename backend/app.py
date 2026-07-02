import os
import re
import json
import threading as _threading
import uuid as _uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Flask, jsonify, Response, request, current_app, g
from flask_cors import CORS
from config import (
    APIM_INSTANCES, ALLOWED_EXTENSION_ID, ALLOWED_WEB_ORIGINS, FLASK_PORT,
    BUILTIN_APIS, BUILTIN_PRODUCTS, DEFAULT_ENV, API_VER,
    BACKEND_API_VER,
)
from services.auth_service import AuthService
from services.apim_client import ApimClient
from utils.logger import configure_logging, get_logger
from utils.policy_xml import inject_consumer_name, ensure_consumer_name_variable, fix_entities

log = get_logger(__name__)

# Per-session state for promote pause/resume (Task 3.3).
# Keyed by session_id; each entry: {event: threading.Event, resolution: dict|None, missing_event: dict|None}
PROMOTE_SESSIONS: dict = {}


def add_default_groups_to_product(client, product_id):
    """
    Add default visibility groups (developers, guests, administrators) to a product.

    Args:
        client: ApimClient instance
        product_id: The product ID to add groups to

    Returns:
        None (logs success/failure but doesn't raise exceptions)
    """
    default_groups = ["developers", "guests", "administrators"]
    log.info("adding default groups", extra={"product_id": product_id})
    for group_id in default_groups:
        try:
            status, resp = client.put(f"products/{product_id}/groups/{group_id}", {})
            if 200 <= status < 300:
                log.info("group added", extra={"product_id": product_id, "group_id": group_id})
            else:
                log.warning("group add failed", extra={"product_id": product_id, "group_id": group_id, "status": status})
        except Exception as e:
            log.exception("group add error", extra={"product_id": product_id, "group_id": group_id})


def create_app(testing=False):
    app = Flask(__name__)

    if not testing:
        configure_logging()

    from utils.request_context import install as install_request_context
    install_request_context(app)

    if ALLOWED_EXTENSION_ID:
        origins = [f"chrome-extension://{ALLOWED_EXTENSION_ID}", *ALLOWED_WEB_ORIGINS]
    else:
        origins = "*"
    CORS(app, origins=origins, supports_credentials=False)

    _auth_cache = {}

    def get_client(env: str) -> ApimClient:
        if env not in APIM_INSTANCES:
            raise ValueError(f"Unknown environment: {env}")
        if testing:
            raise RuntimeError("Azure credentials not configured. Check .env file.")
        if env not in _auth_cache:
            cfg = APIM_INSTANCES[env]
            tid, cid, sec = cfg["tenant_id"], cfg["client_id"], cfg["client_secret"]
            if not (tid and cid and sec):
                raise RuntimeError(f"Azure credentials not configured for {env}. Check .env file.")
            _auth_cache[env] = AuthService(tid, cid, sec)
        return ApimClient(env, _auth_cache[env])

    app.get_client = get_client

    @app.errorhandler(ValueError)
    def handle_value_error(e): return jsonify({"error": str(e)}), 400

    @app.errorhandler(RuntimeError)
    def handle_runtime_error(e): return jsonify({"error": str(e)}), 502

    # Handle DuplicateApiError specifically to return proper error message
    from services.flow_templates import DuplicateApiError
    @app.errorhandler(DuplicateApiError)
    def handle_duplicate_api_error(e):
        try:
            message = str(e) if e else "Duplicate detected"
            log.info("Duplicate error handler triggered", extra={"error_msg": message[:100]})
            return jsonify({"status": "error", "message": message}), 200
        except Exception as ex:
            log.error("Error in duplicate handler", extra={"error": str(ex)})
            return jsonify({"status": "error", "message": "Duplicate detected"}), 200

    @app.errorhandler(Exception)
    def handle_generic(e):
        error_type = type(e).__name__
        error_msg = str(e)[:200]
        log.error("Generic error handler triggered", extra={"type": error_type, "error_msg": error_msg})
        # If it's a DuplicateApiError, return proper status
        if error_type == "DuplicateApiError":
            return jsonify({"status": "error", "message": str(e)}), 200
        return jsonify({"error": f"Internal error: {error_type}: {e}"}), 500

    @app.route("/api/health")
    def health():
        return jsonify({"status": "ok", "environments": list(APIM_INSTANCES.keys())})

    @app.route("/api/apis/search")
    def search_apis():
        env = request.args.get("env", "dev")
        q = request.args.get("q", "").lower()
        if not q or len(q) < 2: return jsonify([])
        client = current_app.get_client(env)
        apis = client.list_all("apis", extra_params="&$filter=isCurrent eq true&$top=500")
        results, seen_ids = [], set()
        for api in apis:
            api_id = re.sub(r";rev=.*", "", api.get("name", ""))
            if api_id in BUILTIN_APIS or api_id in seen_ids: continue
            seen_ids.add(api_id)
            props = api.get("properties", {})
            name, path = props.get("displayName", ""), props.get("path", "")
            if q in name.lower() or q in path.lower() or q in api_id.lower():
                results.append({"id": api_id, "displayName": name, "path": path, "revision": props.get("apiRevision", "1")})
            if len(results) >= 20: break
        return jsonify(results)

    @app.route("/api/apis/<api_id>")
    def api_detail(api_id):
        env = request.args.get("env", "dev")
        client = current_app.get_client(env)
        status, api_data = client.get(f"apis/{api_id}")
        if status == 404: return jsonify({"error": "API not found"}), 404
        props = api_data.get("properties", {})
        ops = client.list_all(f"apis/{api_id}/operations")

        # FIX: Fetch all operation policies in PARALLEL instead of sequentially.
        # Before: N operations = N sequential Azure round-trips (e.g. 10 ops = ~5-10s)
        # After:  N operations = 1 parallel batch     (e.g. 10 ops = ~0.5-1s)
        def fetch_op_policy(op):
            op_id = op.get("name", "")
            try:
                policy_status, policy_xml = client.get(
                    f"apis/{api_id}/operations/{op_id}/policies/policy", rawxml=True
                )
            except Exception:
                return None
            if policy_status == 404 or not policy_xml or "<policies/>" in policy_xml:
                return None
            op_props = op.get("properties", {})
            rewrite_match = re.search(r'template="([^"]+)"', policy_xml)
            return {
                "id": op_id,
                "method": op_props.get("method", ""),
                "urlTemplate": op_props.get("urlTemplate", ""),
                "displayName": op_props.get("displayName", ""),
                "rewriteUri": rewrite_match.group(1) if rewrite_match else "",
            }

        filtered_ops = []
        if ops:
            # Fetch all operation policies in parallel — preserves order
            with ThreadPoolExecutor(max_workers=min(len(ops), 20)) as executor:
                results = list(executor.map(fetch_op_policy, ops))
            filtered_ops = [r for r in results if r is not None]

        return jsonify({"id": api_id, "displayName": props.get("displayName", ""), "path": props.get("path", ""),
                        "revision": props.get("apiRevision", "1"), "description": props.get("description", ""), "operations": filtered_ops})

    @app.route("/api/apis/<api_id>/operations")
    def get_api_operations(api_id):
        """Fetch all operations for an API."""
        from config import API_VER
        env = request.args.get("env", "dev")
        client = current_app.get_client(env)
        # Use list_all to get ALL operations (handles pagination + API version)
        operations = client.list_all(f"apis/{api_id}/operations", ver=API_VER)
        # Return in Azure response structure for backward compatibility (Onboard flow needs this)
        return jsonify({
            "value": operations or [],
            "count": len(operations or [])
        })

    @app.route("/api/apis/<api_id>/operations/<operation_id>/policies/policy")
    def get_operation_policy(api_id, operation_id):
        """Fetch the operation-level policy XML."""
        env = request.args.get("env", "dev")
        client = current_app.get_client(env)
        status, policy_data = client.get(f"apis/{api_id}/operations/{operation_id}/policies/policy")
        if status == 404:
            return jsonify({"error": "Policy not found"}), 404
        return jsonify(policy_data)

    @app.route("/api/apis/<api_id>/policies/policy")
    def get_api_policy(api_id):
        """Fetch the API-level policy XML."""
        env = request.args.get("env", "dev")
        client = current_app.get_client(env)
        status, policy_data = client.get(f"apis/{api_id}/policies/policy")
        if status == 404:
            return jsonify({"error": "Policy not found"}), 404
        return jsonify(policy_data)

    @app.route("/api/apis/<api_id>/revisions")
    def get_api_revisions(api_id):
        """Fetch all revisions for an API."""
        env = request.args.get("env", "dev")
        client = current_app.get_client(env)
        # Get all revisions for this API
        revisions = client.list_all(f"apis/{api_id}/revisions", ver=API_VER)
        if not revisions:
            return jsonify({"maxRevision": 1, "revisions": []})

        # Extract actual revision numbers to find the true maximum
        # This handles cases where revisions are deleted (e.g., Rev 1, 2, 4 exists but not 3)
        revision_numbers = []
        for rev in revisions:
            # The revision number is in the 'name' field or can be extracted from 'id'
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

        # Find the maximum revision number
        max_revision = max(revision_numbers) if revision_numbers else len(revisions)

        return jsonify({
            "maxRevision": max_revision,
            "revisions": [{"isCurrent": r.get("properties", {}).get("isCurrent", False)}
                         for r in revisions]
        })

    @app.route("/api/backends/<backend_id>")
    def get_backend(backend_id):
        """Fetch backend details including pool members if it's a load balancer."""
        env = request.args.get("env", "dev")
        client = current_app.get_client(env)
        status, backend_data = client.get(f"backends/{backend_id}")
        if status == 404:
            return jsonify({"error": "Backend not found"}), 404
        return jsonify(backend_data)

    @app.route("/api/backends/pools/list")
    def list_pool_backends():
        """List all pool backends in APIM."""
        env = request.args.get("env", "dev")
        client = current_app.get_client(env)

        # Get all backends
        all_backends = client.list_all("backends")

        # Filter only pool backends and return full backend objects
        pool_backends = []
        for backend in all_backends:
            backend_type = backend.get("properties", {}).get("type", "")
            if backend_type == "Pool":
                # Return the full backend object so frontend can access all properties
                pool_backends.append(backend)

        return jsonify({"value": pool_backends})

    @app.route("/api/backends/lookup")
    def lookup_backend():
        """Find an existing backend whose URL host matches the given host (Rule 1 pre-flight)."""
        env = request.args.get("env", "dev")
        host = (request.args.get("host") or "").strip().lower()
        if not host:
            return jsonify({"match": None})
        client = current_app.get_client(env)
        backends = client.list_all("backends")
        from urllib.parse import urlparse
        for b in backends:
            url = b.get("properties", {}).get("url", "")
            if not url:
                continue
            b_type = b.get("properties", {}).get("type", "")
            if b_type == "Pool":
                continue
            if (urlparse(url).hostname or "").lower() == host:
                return jsonify({"match": {
                    "id": b.get("name", ""),
                    "url": url,
                    "type": b.get("properties", {}).get("type", "Single"),
                }})
        return jsonify({"match": None})

    @app.route("/api/products/find-existing")
    def find_existing_products():
        """Find existing products mapped to an API or belonging to a consumer app."""
        env = request.args.get("env", "dev")
        api_id = request.args.get("api_id")
        app_id = request.args.get("app_id")
        app_name = request.args.get("app_name")
        client_id = request.args.get("client_id")

        client = current_app.get_client(env)
        matching_products = []

        # Get all products
        all_products = client.list_all("products", ver=API_VER)

        for product in all_products:
            product_id = product.get("name", "")
            if not product_id or product_id in BUILTIN_PRODUCTS:
                continue

            matched = False
            match_reason = []

            # Check if API is mapped to this product
            if api_id:
                product_apis = client.list_all(f"products/{product_id}/apis", ver=API_VER)
                for api in product_apis:
                    if api.get("name", "") == api_id or api.get("name", "").split(";rev=")[0] == api_id:
                        matched = True
                        match_reason.append("API mapped to product")
                        break

            # Check if consumer app has subscriptions to this product
            if app_id or app_name or client_id:
                product_subscriptions = client.list_all(f"products/{product_id}/subscriptions", ver=API_VER)
                for sub in product_subscriptions:
                    sub_props = sub.get("properties", {})
                    sub_name = sub_props.get("displayName", "")
                    sub_owner = sub_props.get("ownerId", "")

                    # Check if subscription matches the consumer app
                    if app_name and app_name.lower() in sub_name.lower():
                        matched = True
                        match_reason.append(f"Subscription '{sub_name}' matches app name")

                    if app_id and str(app_id) in sub_owner:
                        matched = True
                        match_reason.append(f"Subscription owner matches app ID")

            if matched:
                matching_products.append({
                    "id": product_id,
                    "displayName": product.get("properties", {}).get("displayName", product_id),
                    "description": product.get("properties", {}).get("description", ""),
                    "matchReason": match_reason
                })

        return jsonify({"value": matching_products})

    @app.route("/api/apis/bulk-detail")
    def bulk_api_detail():
        """Fetch details for multiple APIs in one request — fully parallel."""
        env = request.args.get("env", "dev")
        api_ids_param = request.args.get("ids", "")
        if not api_ids_param:
            return jsonify([])
        api_ids = [i.strip() for i in api_ids_param.split(",") if i.strip()]
        if not api_ids:
            return jsonify([])

        client = current_app.get_client(env)

        def fetch_op_policy(api_id, op):
            op_id = op.get("name", "")
            try:
                policy_status, policy_xml = client.get(
                    f"apis/{api_id}/operations/{op_id}/policies/policy", rawxml=True
                )
            except Exception:
                return None
            if policy_status == 404 or not policy_xml or "<policies/>" in policy_xml:
                return None
            op_props = op.get("properties", {})
            rewrite_match = re.search(r'template="([^"]+)"', policy_xml)
            return {
                "id": op_id,
                "method": op_props.get("method", ""),
                "urlTemplate": op_props.get("urlTemplate", ""),
                "displayName": op_props.get("displayName", ""),
                "rewriteUri": rewrite_match.group(1) if rewrite_match else "",
            }

        def fetch_single(api_id):
            try:
                # Fetch API metadata and operations list in parallel
                with ThreadPoolExecutor(max_workers=2) as meta_ex:
                    api_future = meta_ex.submit(client.get, f"apis/{api_id}")
                    ops_future = meta_ex.submit(client.list_all, f"apis/{api_id}/operations")
                    status, api_data = api_future.result()
                    ops = ops_future.result()

                if status == 404:
                    return None
                props = api_data.get("properties", {})

                # Fetch all operation policies in parallel
                filtered_ops = []
                if ops:
                    with ThreadPoolExecutor(max_workers=min(len(ops), 20)) as ex:
                        results = list(ex.map(lambda op: fetch_op_policy(api_id, op), ops))
                    filtered_ops = [r for r in results if r is not None]

                return {
                    "id": api_id,
                    "displayName": props.get("displayName", ""),
                    "path": props.get("path", ""),
                    "revision": props.get("apiRevision", "1"),
                    "description": props.get("description", ""),
                    "operations": filtered_ops,
                }
            except Exception as e:
                return {"id": api_id, "error": str(e), "operations": []}

        # All APIs fetched in parallel — use enough threads for all APIs simultaneously
        id_to_result = {}
        with ThreadPoolExecutor(max_workers=min(len(api_ids), 20)) as executor:
            future_to_id = {executor.submit(fetch_single, aid): aid for aid in api_ids}
            for future in as_completed(future_to_id):
                aid = future_to_id[future]
                result = future.result()
                if result:
                    id_to_result[aid] = result

        # Return in requested order
        return jsonify([id_to_result[aid] for aid in api_ids if aid in id_to_result])

    @app.route("/api/apis")
    def list_apis():
        env = request.args.get("env", "dev")
        client = current_app.get_client(env)
        apis = client.list_all("apis", extra_params="&$filter=isCurrent eq true&$top=500")
        seen_ids = set()
        groups = {}  # key -> {displayName, versions[]}
        for api in apis:
            api_id = re.sub(r";rev=.*", "", api.get("name", ""))
            if api_id in BUILTIN_APIS or api_id in seen_ids: continue
            seen_ids.add(api_id)
            props = api.get("properties", {})
            dn = props.get("displayName", api_id)
            version_name = props.get("apiVersion", "")
            vs_raw = props.get("apiVersionSetId", "") or ""
            vs_id = vs_raw.split("/")[-1] if vs_raw else ""
            # Get revision info - higher revision means more recent changes
            revision_str = props.get("apiRevision", "1")
            try:
                revision_num = int(revision_str)
            except (ValueError, TypeError):
                revision_num = 1

            entry = {
                "id": api_id,
                "displayName": dn,
                "path": props.get("path", ""),
                "revision": revision_str,
                "revisionNumber": revision_num,
                "isCurrent": props.get("isCurrent", False),
                "versionName": version_name,
                "versionSetId": vs_id,
            }
            key = vs_id if vs_id else api_id
            if key not in groups:
                groups[key] = {
                    "displayName": dn, "path": entry["path"],
                    "id": api_id, "revision": entry["revision"],
                    "revisionNumber": entry["revisionNumber"],
                    "isCurrent": entry["isCurrent"],
                    "versions": []
                }
            else:
                # Update with highest revision if this entry has a higher revision
                if entry["revisionNumber"] > groups[key]["revisionNumber"]:
                    groups[key]["revisionNumber"] = entry["revisionNumber"]
                    groups[key]["revision"] = entry["revision"]
                    groups[key]["isCurrent"] = entry["isCurrent"]
            groups[key]["versions"].append(entry)

        results = []
        for key, group in groups.items():
            versions = group["versions"]
            first = versions[0]
            has_version_set = any(v["versionSetId"] for v in versions)
            if has_version_set:
                results.append({
                    "id": first["id"], "displayName": first["displayName"],
                    "path": first["path"], "revision": group["revision"],
                    "revisionNumber": group["revisionNumber"],
                    "isCurrent": group["isCurrent"],
                    "versions": [{"id": v["id"], "versionName": v["versionName"] or "Original",
                                  "path": v["path"], "revision": v["revision"]} for v in versions]
                })
            else:
                results.append({
                    "id": first["id"], "displayName": first["displayName"],
                    "path": first["path"], "revision": group["revision"],
                    "revisionNumber": group["revisionNumber"],
                    "isCurrent": group["isCurrent"],
                    "versions": []
                })
        # Sort by revision number (descending) to show most recently changed APIs first
        results.sort(key=lambda x: (x["revisionNumber"], x["displayName"].lower()), reverse=True)
        return jsonify(results)

    @app.route("/api/apis/create", methods=["POST"])
    def create_api():
        try:
            data = request.get_json()
            env = data.get("env", "dev")
            log.info("create_api requested", extra={
                "env": env,
                "display_name": data.get("displayName"),
                "path": data.get("path"),
                "with_consumer": bool(data.get("consumerAppName")),
            })
            client = current_app.get_client(env)
            from services.api_creator import create_api_flow
            return sse_stream(create_api_flow(client, data))
        except Exception as e:
            log.exception("api create failed")
            return jsonify({"error": str(e)}), 500

    @app.route("/api/apis/inspect-additions", methods=["POST"])
    def inspect_additions():
        """Pre-flight inspection for add-ops-to-existing-API flow.
        Returns per-host routing classification so the chat can ask
        the user how to route each new host.
        """
        from urllib.parse import urlparse
        data = request.get_json() or {}
        env = data.get("env", "dev")
        # Canonical key is existing_api_id (matches flow_templates + api_creator).
        # Accept legacy `api_id` too so manual callers don't break.
        api_id = data.get("existing_api_id") or data.get("api_id") or ""
        urls = data.get("urls") or []
        log.info("inspect_additions requested", extra={"api_id": api_id, "env": env, "url_count": len(urls)})
        if not api_id or not urls:
            return jsonify({"error": "existing_api_id and urls are required"}), 400

        client = current_app.get_client(env)

        # 1. Get the existing API + its current backend(s) from API-level policy
        api_status, api_data = client.get(f"apis/{api_id}", ver=API_VER)
        if api_status == 404:
            return jsonify({"error": f"API {api_id} not found in {env}"}), 404
        if not (200 <= api_status < 300):
            return jsonify({"error": f"Failed to fetch API: {api_data}"}), 502

        # Read current api-level policy to find existing backend_id
        pol_status, pol_data = client.get(f"apis/{api_id}/policies/policy", ver=API_VER)
        current_backend_id = None
        if 200 <= pol_status < 300:
            import re as _re
            policy_xml = pol_data.get("raw") or pol_data.get("properties", {}).get("value", "")
            m = _re.search(r'backend-id="([^"]+)"', policy_xml or "")
            if m:
                current_backend_id = m.group(1)

        # Classify the current backend: single | pool | none
        current_kind = "none"
        current_pool_members = []
        if current_backend_id:
            bs, bd = client.get(f"backends/{current_backend_id}", ver=BACKEND_API_VER)
            if 200 <= bs < 300:
                bp = bd.get("properties", {})
                if bp.get("type") == "Pool":
                    current_kind = "pool"
                    services = bp.get("pool", {}).get("services", []) or []
                    current_pool_members = [s.get("id", "").split("/")[-1] for s in services if s.get("id")]
                else:
                    current_kind = "single"

        # Build a quick host -> backend map of all backends in this env
        all_backends = client.list_all("backends", ver=BACKEND_API_VER)
        env_host_to_backend = {}
        for b in all_backends:
            bp = b.get("properties", {})
            if bp.get("type") == "Pool":
                continue
            burl = bp.get("url", "")
            if not burl:
                continue
            try:
                host = (urlparse(burl).hostname or "").lower()
                if host and host not in env_host_to_backend:
                    env_host_to_backend[host] = b.get("name", "")
            except Exception:
                pass

        # The "in_proxy" host(s): hostname(s) of the current backend(s).
        in_proxy_hosts = set()
        if current_kind == "single" and current_backend_id:
            bs, bd = client.get(f"backends/{current_backend_id}", ver=BACKEND_API_VER)
            if 200 <= bs < 300:
                try:
                    in_proxy_hosts.add((urlparse(bd.get("properties", {}).get("url", "")).hostname or "").lower())
                except Exception:
                    pass
        elif current_kind == "pool":
            for member in current_pool_members:
                ms, md = client.get(f"backends/{member}", ver=BACKEND_API_VER)
                if 200 <= ms < 300:
                    try:
                        in_proxy_hosts.add((urlparse(md.get("properties", {}).get("url", "")).hostname or "").lower())
                    except Exception:
                        pass

        # Per-URL classification, batched by host
        host_groups = {}  # host -> {urls: [], classification, existing_backend_id}
        for entry in urls:
            u = entry.get("url", "")
            try:
                host = (urlparse(u).hostname or "").lower()
            except Exception:
                host = ""
            if not host:
                continue
            if host not in host_groups:
                if host in in_proxy_hosts:
                    cls = "in_proxy"
                    existing_id = current_backend_id if current_kind == "single" else None
                elif host in env_host_to_backend:
                    cls = "in_env"
                    existing_id = env_host_to_backend[host]
                else:
                    cls = "new"
                    existing_id = None
                host_groups[host] = {
                    "urls": [],
                    "classification": cls,
                    "existing_backend_id": existing_id,
                    "needs_decision": True,  # always ask user for routing decision
                }
            host_groups[host]["urls"].append(entry)

        return jsonify({
            "api": {
                "id": api_id,
                "displayName": api_data.get("properties", {}).get("displayName", api_id),
                "backend_kind": current_kind,
                "current_backend_id": current_backend_id,
                "current_pool_members": current_pool_members,
            },
            "host_groups": host_groups,
        })

    @app.route("/api/products")
    def list_products():
        env = request.args.get("env", "dev")
        client = current_app.get_client(env)
        products = client.list_all("products")
        results = []
        for p in products:
            pid = p.get("name", "")
            if pid in BUILTIN_PRODUCTS: continue
            props = p.get("properties", {})
            results.append({"id": pid, "displayName": props.get("displayName", pid),
                            "description": props.get("description", ""), "state": props.get("state", "")})
        return jsonify(results)

    @app.route("/api/products/<product_id>")
    def product_detail(product_id):
        env = request.args.get("env", "dev")
        client = current_app.get_client(env)
        status, product = client.get(f"products/{product_id}")
        if status == 404: return jsonify({"error": "Product not found"}), 404
        props = product.get("properties", {})
        subs = client.list_all(f"products/{product_id}/subscriptions")
        sub_list = [{"id": s.get("name", ""), "displayName": s.get("properties", {}).get("displayName", ""),
                     "state": s.get("properties", {}).get("state", ""), "createdDate": s.get("properties", {}).get("createdDate", "")} for s in subs]
        apis = client.list_all(f"products/{product_id}/apis")
        api_list = [{"id": a.get("name", ""), "displayName": a.get("properties", {}).get("displayName", "")} for a in apis]
        return jsonify({"id": product_id, "displayName": props.get("displayName", ""),
                        "description": props.get("description", ""), "state": props.get("state", ""),
                        "subscriptions": sub_list, "apis": api_list})

    @app.route("/api/subscriptions/<sub_id>/keys")
    def subscription_keys(sub_id):
        env = request.args.get("env", "dev")
        client = current_app.get_client(env)
        status, data = client.post(f"subscriptions/{sub_id}/listSecrets")
        if not (200 <= status < 300): return jsonify({"error": f"Failed to get keys: {data}"}), status
        return jsonify({"primaryKey": data.get("primaryKey", ""), "secondaryKey": data.get("secondaryKey", "")})

    @app.route("/api/products/create", methods=["POST"])
    def create_product():
        from utils.slugify import to_slug
        data = request.get_json()
        env = data.get("env", "dev")
        consumer_app_id, consumer_app_name, api_id = data["consumer_app_id"], data["consumer_app_name"], data["api_id"]
        consumer_name = data.get("consumer_name", "")
        log.info("create_product requested", extra={
            "env": env,
            "consumer_app_id": consumer_app_id,
            "consumer_app_name": consumer_app_name,
            "consumer_name": consumer_name,
            "api_id": api_id,
        })
        client = current_app.get_client(env)

        # Find unique product ID
        base_product_id = f"{consumer_app_id}-{to_slug(consumer_app_name)}"
        product_id = base_product_id
        counter = 2
        while True:
            status, _ = client.get(f"products/{product_id}")
            if status == 404:
                break  # Product doesn't exist, we can use this ID
            product_id = f"{base_product_id}-{counter}"
            counter += 1

        # Find unique subscription ID
        base_sub_id = f"sub-{consumer_app_id}-{to_slug(api_id)}"
        sub_id = base_sub_id
        counter = 2
        while True:
            status, _ = client.get(f"subscriptions/{sub_id}")
            if status == 404:
                break  # Subscription doesn't exist, we can use this ID
            sub_id = f"{base_sub_id}-{counter}"
            counter += 1

        display_name = consumer_app_name if product_id == base_product_id else f"{consumer_app_name}-{product_id.split('-')[-1]}"
        status, resp = client.put(f"products/{product_id}", {"properties": {"displayName": display_name, "subscriptionRequired": True, "state": "published"}})
        if not (200 <= status < 300): return jsonify({"error": f"Failed to create product: {resp}"}), 502

        # Add default groups to product visibility
        add_default_groups_to_product(client, product_id)

        try:
            for s in client.list_all(f"products/{product_id}/subscriptions"):
                if s.get("name"): client.delete(f"subscriptions/{s['name']}")
        except Exception: pass
        status, resp = client.put(f"products/{product_id}/apis/{api_id}", {})
        if not (200 <= status < 300): return jsonify({"error": f"Failed to link API: {resp}"}), 502

        # Inject consumer-name policies for all operations if consumer_name is provided
        if consumer_name:
            try:
                # Ensure API-level policy extracts consumer-name header into context variable
                api_policy_path = f"apis/{api_id}/policies/policy"
                api_status, api_xml = client.get(api_policy_path, rawxml=True)
                if api_status == 200 and api_xml:
                    patched_api_xml = ensure_consumer_name_variable(api_xml)
                    if patched_api_xml != api_xml:
                        client.put(api_policy_path,
                                   {"properties": {"format": "rawxml", "value": patched_api_xml}})
                        log.info("Added consumer-name header extraction at API level",
                                extra={"api_id": api_id})

                # Get all operations for the API
                operations = list(client.list_all(f"apis/{api_id}/operations"))
                log.info("Injecting consumer-name policies",
                        extra={"api_id": api_id, "operation_count": len(operations), "consumer_name": consumer_name})

                # Inject consumer-name policy for each operation
                for op in operations:
                    op_id = op.get("name")
                    if not op_id:
                        continue

                    policy_path = f"apis/{api_id}/operations/{op_id}/policies/policy"
                    status, current_xml = client.get(policy_path, rawxml=True)

                    if status != 200 or not current_xml:
                        current_xml = (
                            '<policies>\n'
                            '  <inbound><base /></inbound>\n'
                            '  <backend><base /></backend>\n'
                            '  <outbound><base /></outbound>\n'
                            '  <on-error><base /></on-error>\n'
                            '</policies>'
                        )

                    updated_xml = inject_consumer_name(current_xml, consumer_name)
                    policy_body = {"properties": {"format": "rawxml", "value": updated_xml}}
                    status, data = client.put(policy_path, policy_body)

                    if not (200 <= status < 300):
                        log.warning("Failed to update policy for operation",
                                   extra={"api_id": api_id, "op_id": op_id, "status": status})

                log.info("Consumer-name policies injected successfully",
                        extra={"api_id": api_id, "operation_count": len(operations)})
            except Exception as e:
                log.exception("Error injecting consumer-name policies",
                             extra={"api_id": api_id, "error": str(e)})
                # Don't fail the entire product creation if policy injection fails

        status, resp = client.put(f"subscriptions/{sub_id}", {"properties": {"scope": f"/products/{product_id}", "displayName": sub_id, "state": "active"}})
        if not (200 <= status < 300): return jsonify({"error": f"Failed to create subscription: {resp}"}), 502
        status, keys = client.post(f"subscriptions/{sub_id}/listSecrets")
        return jsonify({"product_id": product_id, "subscription_id": sub_id, "primaryKey": keys.get("primaryKey", ""), "secondaryKey": keys.get("secondaryKey", "")})

    @app.route("/api/products/add-api", methods=["POST"])
    def add_api_to_product():
        """Add an API to an existing product."""
        data = request.get_json()
        env = data.get("env", "dev")
        product_id = data.get("product_id")
        api_id = data.get("api_id")

        if not product_id or not api_id:
            return jsonify({"error": "product_id and api_id are required"}), 400

        log.info("add_api_to_product requested", extra={
            "env": env,
            "product_id": product_id,
            "api_id": api_id,
        })

        client = current_app.get_client(env)

        # Add API to product
        status, resp = client.put(f"products/{product_id}/apis/{api_id}", {})
        if not (200 <= status < 300):
            return jsonify({"error": f"Failed to add API to product: {resp}"}), 502

        log.info("API added to product successfully", extra={
            "env": env,
            "product_id": product_id,
            "api_id": api_id,
        })

        return jsonify({"success": True, "product_id": product_id, "api_id": api_id})

    @app.route("/api/_smoketest/cleanup", methods=["POST"])
    def smoketest_cleanup():
        """Tightly-scoped delete for the smoke harness. Only accepts paths
        matching apis/smoke-test-* or backends/b-smoke-test-* in env=sandbox|dev.
        Anything else is rejected with 400. This endpoint exists so the
        integration tests can clean up after themselves without needing a
        general-purpose delete proxy.
        """
        import re as _re
        data = request.get_json() or {}
        env = data.get("env", "")
        path = data.get("path", "")
        if env not in ("sandbox", "dev"):
            return jsonify({"error": f"env must be sandbox|dev, got {env!r}"}), 400
        # Whitelist patterns — case-sensitive, exact prefix.
        # Allows: apis/smoke-test-*, backends/(b-|pool-)?smoke-test-*,
        #         products/<digits>-<slug containing smoke-test-...>,
        #         subscriptions/sub-<slug containing smoke-test-...>.
        allowed = (
            _re.fullmatch(r"apis/smoke-test-[a-z0-9-]+", path)
            or _re.fullmatch(r"backends/(b-|pool-)?smoke-test-[a-z0-9-]+", path)
            or _re.fullmatch(r"products/[a-z0-9-]*smoke-test-[a-z0-9-]+", path)
            or _re.fullmatch(r"subscriptions/sub-[a-z0-9-]*smoke-test-[a-z0-9-]+", path)
            or _re.fullmatch(r"namedValues/smoke-test-[a-z0-9-]+", path)
            or _re.fullmatch(r"tags/smoke-test-[a-z0-9-]+", path)
        )
        if not allowed:
            return jsonify({"error": f"path not allowed: {path!r}"}), 400
        client = current_app.get_client(env)
        # Cascade flags so we never get blocked by sub-resources during cleanup
        extra = ""
        if path.startswith("apis/"):
            extra = "&deleteRevisions=true"
        elif path.startswith("products/"):
            extra = "&deleteSubscriptions=true"
        status, body = client.delete(path, extra_params=extra) if extra else client.delete(path)
        log.info("smoketest cleanup", extra={"env": env, "path": path, "status": status})
        return jsonify({"path": path, "env": env, "apim_status": status, "body": body}), 200

    @app.route("/api/spec/import", methods=["POST"])
    def import_spec_route():
        from services.spec_importer import import_spec
        data = request.get_json() or {}
        env = data.get("env", "dev")
        log.info("spec_import requested", extra={
            "env": env,
            "api_id": data.get("api_id"),
            "path": data.get("path"),
        })
        client = current_app.get_client(env)
        return sse_stream(import_spec(client, data))

    @app.route("/api/assistant/parse", methods=["POST"])
    def assistant_parse_route():
        from services.assistant_service import extract_intent, AssistantError
        from services.flow_templates import build_plan, NoTemplateMatch, MissingParams, InvalidParams, DuplicateApiError

        data = request.get_json() or {}
        query = (data.get("query") or "").strip()
        history = data.get("history") or []

        if not query:
            return jsonify({"status": "error", "message": "query is required"}), 400

        log.info("assistant query", extra={"query": query[:200], "history_len": len(history)})

        try:
            extracted = extract_intent(query, history=history[-6:])
        except AssistantError as e:
            log.warning("assistant LLM failed", extra={"error": str(e)})
            return jsonify({"status": "error", "message": str(e)}), 502

        intent = extracted.get("intent", [])
        params = extracted.get("params", {}) or {}
        hints = extracted.get("hints", {}) or {}

        # Overlay user-pinned decisions ON TOP of LLM extraction. The LLM sees
        # the conversation history and can re-extract stale text (e.g. a
        # version-set parent api id from the original query) even after the
        # user has picked a concrete value. Pinned params are the user's
        # locked-in choices and must win over whatever the LLM produced.
        pinned_params = data.get("pinned_params") or {}
        if pinned_params:
            for k, v in pinned_params.items():
                if v is not None and v != "":
                    params[k] = v
            log.info("assistant pinned_params applied", extra={"pinned": list(pinned_params.keys())})

        if "off_topic" in intent:
            log.info("assistant off_topic", extra={"intent": intent})
            return jsonify({"status": "off_topic", "intent": intent})

        # Redirect analytical questions to the agentic tool-use loop on the
        # /api/assistant/analyze endpoint (frontend re-issues the request).
        if "analyze" in intent:
            log.info("assistant analyze", extra={"intent": intent})
            return jsonify({
                "status": "analyze",
                "query": query,
                "intent": intent,
            })

        # Check for duplicate APIs BEFORE building plan (for create_api intents)
        if "create" in intent and "api" in intent:
            display_name = params.get("displayName")
            env = params.get("env")
            if display_name and env:
                from config import API_VER
                client = current_app.get_client(env)

                log.info("Checking for duplicate API", extra={"env": env, "display_name": display_name})
                all_apis = client.list_all("apis", ver=API_VER)

                if all_apis:
                    display_name_lower = display_name.lower().strip()
                    for api in all_apis:
                        api_props = api.get("properties", {})
                        existing_display_name = api_props.get("displayName", "")

                        if existing_display_name.lower().strip() == display_name_lower:
                            api_id = api.get("name", "")
                            error_msg = f"API with display name '{existing_display_name}' already exists (API ID: '{api_id}'). Please choose a different API name or use 'Add to Existing API' to add operations to it."
                            log.info("Duplicate API found", extra={"api_id": api_id, "display_name": existing_display_name})
                            return jsonify({
                                "status": "error",
                                "message": error_msg,
                                "intent": intent,
                            })

        try:
            plan = build_plan(intent, params, hints)
        except DuplicateApiError as e:
            log.info("assistant duplicate caught", extra={"error_msg": str(e)[:200]})
            return jsonify({
                "status": "error",
                "message": str(e),
                "intent": intent,
            }), 200
        except MissingParams as e:
            log.info("assistant needs_params", extra={"intent": intent, "missing": e.missing})
            return jsonify({
                "status": "needs_params",
                "missing": e.missing,
                "intent": intent,
                "params": params,
                "hints": hints,
            })
        except InvalidParams as e:
            log.info("assistant invalid_params", extra={"intent": intent, "invalid": e.invalid})
            return jsonify({
                "status": "invalid_params",
                "invalid": e.invalid,
                "intent": intent,
                "params": params,
            })
        except NoTemplateMatch:
            log.info("assistant no_match", extra={"intent": intent})
            return jsonify({
                "status": "no_match",
                "intent": intent,
                "params": params,
            })
        except Exception as e:
            # Catch any other unexpected exceptions and return as error response
            error_msg = str(e)
            error_type = type(e).__name__
            log.error("assistant unexpected error", extra={"error": error_msg, "error_type": error_type})
            return jsonify({
                "status": "error",
                "message": error_msg,
            }), 200

        # Defensive: build_plan returns None only on off_topic, which the
        # earlier check already handled. Kept in case build_plan's contract
        # changes — fail safe rather than KeyError on plan["mode"].
        if plan is None:
            return jsonify({"status": "off_topic", "intent": intent})

        log.info("assistant plan", extra={
            "template_id": plan["template_id"],
            "mode": plan["mode"],
            "gate_required": plan["gate_required"],
        })
        return jsonify({
            "status": "ok",
            "plan": plan,
            "intent": intent,
            "params": params,
        })

    @app.route("/api/assistant/analyze", methods=["POST"])
    def assistant_analyze_route():
        """Agentic tool-use loop for analytical questions. Streams SSE events."""
        from services.analyze_service import run_analyze_loop
        data = request.get_json() or {}
        query = (data.get("query") or "").strip()
        history = data.get("history") or []
        session_id = data.get("session_id") or "default"
        if not query:
            return jsonify({"status": "error", "message": "query is required"}), 400
        log.info("assistant analyze requested", extra={
            "query": query[:200],
            "session_id": session_id,
            "history_len": len(history),
        })

        # Pass the real app object so the worker thread can re-enter app context.
        app_obj = current_app._get_current_object()

        def generate():
            try:
                for event in run_analyze_loop(query, history, session_id, app_obj):
                    yield f"data: {json.dumps(event)}\n\n"
            except Exception as e:
                log.exception("analyze stream failed")
                err = {"event": "error", "data": {"message": str(e)}}
                yield f"data: {json.dumps(err)}\n\n"

        return Response(
            generate(),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.route("/api/assistant/analyze/confirm", methods=["POST"])
    def assistant_analyze_confirm():
        """Resolve a pending tool-confirmation gate from the analyze worker."""
        from services import analyze_state
        data = request.get_json() or {}
        session_id = data.get("session_id")
        batch_id = data.get("batch_id")
        decision = data.get("decision")  # 'confirm' or 'cancel'
        password = data.get("password")  # optional, for destructive batches
        if not session_id or not batch_id or decision not in ("confirm", "cancel"):
            return jsonify({"error": "session_id, batch_id, decision required (decision: confirm|cancel)"}), 400
        ok = analyze_state.resolve_confirmation(session_id, batch_id, decision, password)
        if not ok:
            return jsonify({"error": "no pending confirmation found"}), 404
        log.info("analyze confirmation resolved", extra={
            "session_id": session_id, "batch_id": batch_id, "decision": decision,
        })
        return jsonify({"resolved": True})

    @app.route("/api/assistant/analyze/select-version", methods=["POST"])
    def assistant_analyze_select_version():
        """Resolve a pending version selection from the analyze worker."""
        from services import analyze_state
        data = request.get_json() or {}
        session_id = data.get("session_id")
        selection_id = data.get("selection_id")
        version_id = data.get("version_id")
        if not session_id or not selection_id or not version_id:
            return jsonify({"error": "session_id, selection_id, version_id required"}), 400
        ok = analyze_state.resolve_version_selection(session_id, selection_id, version_id)
        if not ok:
            return jsonify({"error": "no pending version selection found"}), 404
        log.info("analyze version selection resolved", extra={
            "session_id": session_id, "selection_id": selection_id, "version_id": version_id,
        })
        return jsonify({"resolved": True})

    @app.route("/api/assistant/session/<session_id>/clear", methods=["POST"])
    def clear_analyze_session(session_id):
        from services.tools import cache as tool_cache
        tool_cache.invalidate_session(session_id)
        return jsonify({"cleared": session_id})

    @app.route("/api/subscriptions/check-duplicate")
    def check_subscription_duplicate():
        """Check if the selected product already has any subscriptions mapped to it."""
        env = request.args.get("env", "dev")
        product_id = request.args.get("product_id")

        if not product_id:
            return jsonify({"exists": False})

        client = current_app.get_client(env)
        try:
            existing_subs = client.list_all(f"products/{product_id}/subscriptions")
            all_subs = [
                {"id": s.get("name", ""), "displayName": s.get("properties", {}).get("displayName", "")}
                for s in existing_subs
            ]

            return jsonify({
                "exists": len(all_subs) > 0,
                "subscriptions": all_subs,
                "product_id": product_id
            })
        except Exception as e:
            log.exception("sub duplicate check failed")
            return jsonify({"exists": False})

    @app.route("/api/subscriptions/create", methods=["POST"])
    def create_subscription():
        from utils.slugify import to_slug
        data = request.get_json()
        env = data.get("env", "dev")
        client = current_app.get_client(env)
        product_id = data["product_id"]
        api_id = data.get("api_id", "")
        sub_display = data.get("display_name", f"sub-{to_slug(api_id)}")

        # Find unique subscription ID
        base_sub_id = to_slug(sub_display)
        sub_id = base_sub_id
        counter = 2
        while True:
            status, _ = client.get(f"subscriptions/{sub_id}")
            if status == 404:
                break  # Subscription doesn't exist, we can use this ID
            sub_id = f"{base_sub_id}-{counter}"
            counter += 1

        # Update display name if we had to add a suffix
        final_display = sub_display if sub_id == base_sub_id else f"{sub_display}-{counter-1}"

        log.info("creating subscription", extra={"sub_id": sub_id, "display_name": final_display, "product_id": product_id})

        status, resp = client.put(f"subscriptions/{sub_id}", {"properties": {"scope": f"/products/{product_id}", "displayName": final_display, "state": "active"}})
        if not (200 <= status < 300): return jsonify({"error": f"Failed to create subscription: {resp}"}), 502
        status, keys = client.post(f"subscriptions/{sub_id}/listSecrets")
        return jsonify({"subscription_id": sub_id, "display_name": final_display, "primaryKey": keys.get("primaryKey", ""), "secondaryKey": keys.get("secondaryKey", "")})

    @app.route("/api/diff/instance", methods=["GET", "POST"])
    def diff_instance():
        from services.diff_service import instance_diff
        body = request.get_json(silent=True) or {}
        src = body.get("src") or request.args.get("src", "dev")
        dest = body.get("dest") or request.args.get("dest", "prod")
        return jsonify(instance_diff(current_app.get_client(src), current_app.get_client(dest)))

    @app.route("/api/diff/api", methods=["GET", "POST"])
    def diff_api():
        body = request.get_json(silent=True) or {}
        api_id = body.get("api_id") or request.args.get("api_id")
        if not api_id: return jsonify({"error": "api_id required"}), 400
        src_env = body.get("src") or request.args.get("src", "dev")
        dest_env = body.get("dest") or request.args.get("dest", "prod")
        from services.diff_service import api_diff
        return jsonify(api_diff(current_app.get_client(src_env), current_app.get_client(dest_env), api_id, src_env, dest_env))

    @app.route("/api/promote/api", methods=["POST"])
    def promote_api_route():
        data = request.get_json()
        api_id = data.get("api_id")
        if not api_id: return jsonify({"error": "api_id required"}), 400
        src, dest = data.get("src", "dev"), data.get("dest", "prod")

        # Destructive-tier gate: any dest other than sandbox writes to a
        # protected env (dev/prod/dr) and requires admin password verification.
        # This is the same protection the analyze loop's destructive tools
        # have, applied at the route level so chat-driven flow_template paths
        # AND manual UI calls both go through the gate.
        if dest != "sandbox":
            import hmac as _hmac
            supplied = (data.get("admin_password") or "").strip()
            expected = os.environ.get("ADMIN_PASSWORD", "")
            if not expected:
                log.warning("promote_api blocked: ADMIN_PASSWORD not configured",
                            extra={"api_id": api_id, "dest": dest})
                return jsonify({"error": "admin_password_not_configured",
                                "message": "Server has no ADMIN_PASSWORD set; promotion to non-sandbox envs blocked."}), 503
            if not supplied or not _hmac.compare_digest(supplied.encode(), expected.encode()):
                log.warning("promote_api blocked: invalid/missing admin_password",
                            extra={"api_id": api_id, "dest": dest})
                return jsonify({"error": "admin_password_invalid",
                                "message": f"Promotion to {dest!r} requires admin_password. "
                                           "Provide it in the JSON body (key: admin_password) or use the manual UI which prompts for it."}), 401

        log.info("promote_api requested", extra={"api_id": api_id, "src": src, "dest": dest})

        session_id = f"promote-{_uuid.uuid4().hex[:10]}"
        gate_event = _threading.Event()
        PROMOTE_SESSIONS[session_id] = {
            "event": gate_event,
            "resolution": None,
            "missing_event": None,
        }

        def wait_for_resolution(missing_event_dict):
            sess = PROMOTE_SESSIONS.get(session_id)
            if sess is None:
                return {"action": "abort"}
            sess["missing_event"] = missing_event_dict
            sess["resolution"] = None
            sess["event"].clear()
            timed_out = not sess["event"].wait(timeout=300)
            if timed_out:
                return {"action": "abort"}
            resolution = sess.get("resolution") or {"action": "abort"}
            return resolution

        from services.promote_service import promote_api

        # CRITICAL: resolve clients HERE (still in request context). If we move
        # current_app.get_client() inside the generator, by the time SSE iterates
        # it the request context is gone and current_app raises "Working outside
        # of application context."
        src_client = current_app.get_client(src)
        dest_client = current_app.get_client(dest)

        def generator_with_session():
            try:
                # Emit session_id first so the frontend knows where to POST resolutions.
                yield {"event": "promote_session", "session_id": session_id}
                yield from promote_api(
                    src_client,
                    dest_client,
                    api_id, src, dest,
                    wait_for_resolution=wait_for_resolution,
                )
            finally:
                PROMOTE_SESSIONS.pop(session_id, None)

        return sse_stream(generator_with_session())

    @app.route("/api/promote/api/resolve", methods=["POST"])
    def promote_resolve():
        """Unblock a paused promote SSE stream with a user-supplied resolution."""
        data = request.get_json() or {}
        sid = data.get("session_id")
        if not sid or sid not in PROMOTE_SESSIONS:
            return jsonify({"error": "unknown or missing session_id"}), 404
        PROMOTE_SESSIONS[sid]["resolution"] = data.get("resolution") or {"action": "abort"}
        PROMOTE_SESSIONS[sid]["event"].set()
        return jsonify({"ok": True}), 200

    @app.route("/api/promote/bulk", methods=["POST"])
    def promote_bulk():
        data = request.get_json()
        api_ids = data.get("api_ids", [])
        if not api_ids: return jsonify({"error": "api_ids required"}), 400
        src_client = current_app.get_client(data.get("src", "dev"))
        dest_client = current_app.get_client(data.get("dest", "prod"))
        from services.promote_service import promote_api
        def bulk_generator():
            src = data.get("src", "dev")
            dest = data.get("dest", "prod")
            total = len(api_ids)
            for i, aid in enumerate(api_ids):
                idx = i + 1
                yield {"api": aid, "api_index": idx, "api_total": total, "status": "api_starting"}
                api_failed = False
                for event in promote_api(src_client, dest_client, aid, src, dest):
                    event.update({"api": aid, "api_index": idx, "api_total": total})
                    if event.get("status") == "error":
                        event["status"] = "step_error"
                        api_failed = True
                    yield event
                yield {
                    "api": aid, "api_index": idx, "api_total": total,
                    "status": "api_failed" if api_failed else "api_done",
                }
        return sse_stream(bulk_generator())

    @app.route("/api/onboard/check-duplicate")
    def check_duplicate_consumer():
        """Check if consumer has access to API (via product mapping, names, or policy)."""
        env = request.args.get("env", "dev")
        consumer_app_id = request.args.get("consumer_app_id", "")
        consumer_app_name = request.args.get("consumer_app_name", "")
        # Accept both legacy `consumer_client_id` (Azure AD GUID, older APIs) and
        # the new `consumer_name` (header-allowlist string) — search for whichever
        # the caller supplied in the API's policy XML.
        consumer_client_id = (request.args.get("consumer_name", "")
                              or request.args.get("consumer_client_id", ""))
        api_id = request.args.get("api_id", "")

        if not consumer_app_id or not api_id:
            return jsonify({"exists": False})

        try:
            client = current_app.get_client(env)
            matching_products = []

            # Get all products
            all_products = client.list_all("products", ver=API_VER)

            for product in all_products:
                product_id = product.get("name", "")
                product_name = product.get("properties", {}).get("displayName", "")
                if not product_id or product_id in BUILTIN_PRODUCTS:
                    continue

                has_api = False
                belongs_to_consumer = False

                # Check if product has the API
                try:
                    product_apis = client.list_all(f"products/{product_id}/apis", ver=API_VER)
                    for api in product_apis:
                        api_name = api.get("name", "")
                        if api_name == api_id or api_name.split(";rev=")[0] == api_id:
                            has_api = True
                            break
                except Exception:
                    pass

                if not has_api:
                    continue

                # Check if product belongs to consumer (product name or subscription name contains app name/ID)
                if (consumer_app_id and str(consumer_app_id) in product_name) or \
                   (consumer_app_name and consumer_app_name.lower() in product_name.lower()):
                    belongs_to_consumer = True

                if not belongs_to_consumer:
                    try:
                        product_subs = client.list_all(f"products/{product_id}/subscriptions", ver=API_VER)
                        for sub in product_subs:
                            sub_name = sub.get("properties", {}).get("displayName", "")
                            if (consumer_app_id and str(consumer_app_id) in sub_name) or \
                               (consumer_app_name and consumer_app_name.lower() in sub_name.lower()):
                                belongs_to_consumer = True
                                break
                    except Exception:
                        pass

                # Check if API policy contains the client ID
                if not belongs_to_consumer and consumer_client_id:
                    try:
                        status, policy_data = client.get(f"apis/{api_id}/policies/policy", rawxml=True)
                        if status == 200 and policy_data and consumer_client_id in policy_data:
                            belongs_to_consumer = True
                    except Exception:
                        pass

                if has_api and belongs_to_consumer:
                    status, product_data = client.get(f"products/{product_id}", ver=API_VER)
                    if status == 200:
                        product_props = product_data.get("properties", {})
                        matching_products.append({
                            "id": product_id,
                            "name": product_props.get("displayName", product_id)
                        })

            if matching_products:
                return jsonify({"exists": True, "products": matching_products})
            else:
                return jsonify({"exists": False})
        except Exception as e:
            return jsonify({"exists": False, "error": str(e)})

    @app.route("/api/check-consumer-products")
    def check_consumer_products():
        """Get all products for a consumer (by product/sub names).

        Unlike /api/onboard/check-duplicate, this returns ALL products belonging to
        the consumer, regardless of whether they have the specified API. This allows
        offering "add to existing product" option even for products that don't yet
        have this API.
        """
        env = request.args.get("env", "dev")
        consumer_app_id = request.args.get("consumer_app_id", "")
        consumer_app_name = request.args.get("consumer_app_name", "")
        # Accept both legacy and new identifiers (see /api/onboard/check-duplicate above)
        consumer_client_id = (request.args.get("consumer_name", "")
                              or request.args.get("consumer_client_id", ""))
        api_id = request.args.get("api_id", "")  # Optional - for informational purposes only

        if not consumer_app_id:
            return jsonify({"exists": False})

        try:
            client = current_app.get_client(env)
            product_ids = set()

            # Get all products
            all_products = client.list_all("products", ver=API_VER)

            for product in all_products:
                product_id = product.get("name", "")
                product_name = product.get("properties", {}).get("displayName", "")
                if not product_id or product_id in BUILTIN_PRODUCTS:
                    continue

                belongs_to_consumer = False

                # Check if product belongs to consumer based on product name
                # (product name or subscription name contains consumer app name/ID)
                if (consumer_app_id and str(consumer_app_id) in product_name) or \
                   (consumer_app_name and consumer_app_name.lower() in product_name.lower()):
                    belongs_to_consumer = True

                # Check subscription names if not found yet
                if not belongs_to_consumer:
                    try:
                        product_subs = client.list_all(f"products/{product_id}/subscriptions", ver=API_VER)
                        for sub in product_subs:
                            sub_props = sub.get("properties", {})
                            sub_name = sub_props.get("displayName", "")

                            if (consumer_app_id and str(consumer_app_id) in sub_name) or \
                               (consumer_app_name and consumer_app_name.lower() in sub_name.lower()):
                                belongs_to_consumer = True
                                break
                    except Exception:
                        pass

                # Add product if it belongs to the consumer
                # (regardless of whether it has the specified API)
                if belongs_to_consumer:
                    product_ids.add(product_id)

            # Fetch product details
            consumer_products = []
            for product_id in product_ids:
                status, product_data = client.get(f"products/{product_id}", ver=API_VER)
                if status == 200 and product_data:
                    product_props = product_data.get("properties", {})
                    consumer_products.append({
                        "id": product_id,
                        "name": product_props.get("displayName", product_id)
                    })

            if consumer_products:
                return jsonify({"exists": True, "products": consumer_products})
            else:
                return jsonify({"exists": False})
        except Exception as e:
            return jsonify({"exists": False, "error": str(e)})

    @app.route("/api/onboard", methods=["POST"])
    def onboard_consumer():
        data = request.get_json()
        env = data.get("env", "dev")
        log.info("onboard requested", extra={
            "env": env,
            "consumer_app_name": data.get("consumer_app_name"),
            "api_id": data.get("api_id"),
        })
        from services.onboard_service import onboard_consumer as onboard_flow
        return sse_stream(onboard_flow(current_app.get_client(env), data))

    @app.route("/api/settings")
    def get_settings():
        env_credentials = {}
        for env, cfg in APIM_INSTANCES.items():
            sec = cfg.get("client_secret", "")
            env_credentials[env] = {
                "client_id": cfg.get("client_id", ""),
                "client_secret_hint": f"****{sec[-4:]}" if len(sec) > 4 else "****",
                "configured": bool(cfg.get("client_id") and cfg.get("client_secret")),
            }
        return jsonify({
            "tenant_id": APIM_INSTANCES["dev"]["tenant_id"],
            "port": FLASK_PORT,
            "default_env": DEFAULT_ENV,
            "env_credentials": env_credentials,
        })

    @app.route("/api/settings/test", methods=["POST"])
    def test_connection():
        results = {}
        for env, cfg in APIM_INSTANCES.items():
            try:
                auth = AuthService(cfg["tenant_id"], cfg["client_id"], cfg["client_secret"])
                auth.get_token("https://management.azure.com/.default")
                results[env] = {"status": "ok"}
            except Exception as e:
                results[env] = {"status": "error", "message": str(e)}
        overall = "ok" if all(r["status"] == "ok" for r in results.values()) else "error"
        return jsonify({"status": overall, "environments": results})

    @app.route("/api/certificates/upload", methods=["POST"])
    def upload_certificate_endpoint():
        """Multipart upload: file + password + env + suggested_id (+ admin_password for non-sandbox).

        Returns {ok, cert_id, thumbprint, reused} on success.
        """
        import hmac as _hmac
        from services.cert_uploader import upload_or_reuse_certificate
        from services.resource_resolver import invalidate_certificate_cache

        env = request.form.get("env", "").strip()
        password = request.form.get("password", "")
        suggested_id = request.form.get("suggested_id", "uploaded-cert").strip()
        admin_password = request.form.get("admin_password", "")
        f = request.files.get("file")

        if not env:
            return jsonify({"ok": False, "error": "missing env"}), 400
        if not f:
            return jsonify({"ok": False, "error": "missing file"}), 400

        # Admin password gate for non-sandbox envs (mirrors /api/promote/api pattern).
        if env != "sandbox":
            expected = os.environ.get("ADMIN_PASSWORD", "")
            if not expected or not _hmac.compare_digest(admin_password.encode(), expected.encode()):
                return jsonify({"ok": False, "error": "admin_password_invalid"}), 403

        pfx_bytes = f.read()
        try:
            client = current_app.get_client(env)
        except Exception as e:
            return jsonify({"ok": False, "error": f"unknown env: {e}"}), 400

        try:
            result = upload_or_reuse_certificate(client, pfx_bytes, password, suggested_id)
        except Exception as e:
            log.exception("certificate upload failed")
            return jsonify({"ok": False, "error": str(e)}), 500

        invalidate_certificate_cache(env)
        return jsonify({"ok": True, **result})

    @app.route("/api/ca-certificates/upload", methods=["POST"])
    def upload_ca_certificate_endpoint():
        """Same as upload_certificate_endpoint but for CA certs. Adds store_name."""
        import hmac as _hmac
        from services.cert_uploader import upload_or_reuse_ca_certificate
        from services.resource_resolver import invalidate_ca_certificate_cache

        env = request.form.get("env", "").strip()
        password = request.form.get("password", "")
        suggested_id = request.form.get("suggested_id", "uploaded-ca").strip()
        store_name = request.form.get("store_name", "Root").strip()
        admin_password = request.form.get("admin_password", "")
        f = request.files.get("file")

        if not env:
            return jsonify({"ok": False, "error": "missing env"}), 400
        if not f:
            return jsonify({"ok": False, "error": "missing file"}), 400
        if store_name not in ("Root", "CertificateAuthority"):
            return jsonify({"ok": False, "error": "store_name must be 'Root' or 'CertificateAuthority'"}), 400

        if env != "sandbox":
            expected = os.environ.get("ADMIN_PASSWORD", "")
            if not expected or not _hmac.compare_digest(admin_password.encode(), expected.encode()):
                return jsonify({"ok": False, "error": "admin_password_invalid"}), 403

        pfx_bytes = f.read()
        try:
            client = current_app.get_client(env)
        except Exception as e:
            return jsonify({"ok": False, "error": f"unknown env: {e}"}), 400

        try:
            result = upload_or_reuse_ca_certificate(client, pfx_bytes, password, suggested_id, store_name)
        except Exception as e:
            log.exception("CA certificate upload failed")
            return jsonify({"ok": False, "error": str(e)}), 500

        invalidate_ca_certificate_cache(env)
        return jsonify({"ok": True, **result})

    @app.route("/api/auth/login", methods=["POST"])
    def admin_login():
        """
        Authenticate admin user for Settings page access.
        Credentials should be set in .env file as ADMIN_USERNAME and ADMIN_PASSWORD.
        """
        import os
        from dotenv import load_dotenv

        # Load environment variables
        load_dotenv()

        # Get admin credentials from environment
        admin_username = os.getenv("ADMIN_USERNAME", "admin")
        admin_password = os.getenv("ADMIN_PASSWORD", "admin123")

        # Get submitted credentials
        data = request.get_json()
        username = data.get("username", "")
        password = data.get("password", "")

        # Validate credentials
        if username == admin_username and password == admin_password:
            return jsonify({"success": True, "message": "Authentication successful"})
        else:
            return jsonify({"success": False, "message": "Invalid username or password"}), 401

    return app

def sse_stream(generator):
    # Capture request_id NOW (inside the request context). By the time
    # generate() runs, Flask's request context is gone.
    rid = getattr(g, "request_id", None)

    def generate():
        if rid:
            yield f"data: {json.dumps({'request_id': rid})}\n\n".encode()
        try:
            for event in generator:
                if rid:
                    event = {**event, "request_id": rid}
                yield f"data: {json.dumps(event)}\n\n".encode()
        except Exception as e:
            error_event = {"status": "error", "message": str(e)}
            if rid:
                error_event["request_id"] = rid
            yield f"data: {json.dumps(error_event)}\n\n".encode()
    return Response(generate(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


if __name__ == "__main__":
    app = create_app()
    app.run(port=FLASK_PORT, debug=True, use_reloader=False)
