"""Deterministic flow templates for the Smart Assistant.

Each template declares which intent tag combinations it serves, which params
it requires, and how to turn extracted params into a list of executable steps.
The matcher picks the highest-priority template whose `intent_match` tags are
all present and `intent_exclude` tags are all absent in the LLM's reply.

Unknown modifier tags (not listed in any template's `intent_exclude`) fall
through to the next matching template by priority — they are NOT treated as
errors. Add a tag to `intent_exclude` only when you want to force a different
template to win.

Step actions:
  POST_<endpoint>   - call an existing Flask POST route (executor mode; v2)
  NAVIGATE_<page>   - open an existing extension page with prefilled state
"""

from utils.logger import get_logger

log = get_logger(__name__)


class NoTemplateMatch(Exception):
    pass


class MissingParams(Exception):
    def __init__(self, missing):
        self.missing = list(missing)
        super().__init__(f"Missing required params: {', '.join(self.missing)}")


class InvalidParams(Exception):
    def __init__(self, invalid):
        self.invalid = list(invalid)
        super().__init__(f"Invalid param values: {', '.join(self.invalid)}")


class DuplicateApiError(Exception):
    """Raised when trying to create an API that already exists."""
    pass


class NeedsVersionSelection(Exception):
    def __init__(self, api_param_name, api_display_name, versions):
        self.api_param_name = api_param_name  # e.g., "apiId", "sourceApiId", "targetApiId"
        self.api_display_name = api_display_name
        self.versions = versions
        super().__init__(f"Version selection needed for {api_display_name}")


def _validate_positive_ints(params, fields, invalid):
    """Append any field whose param value is non-coercible-to-int or < 1 to `invalid`."""
    for field in fields:
        val = params.get(field)
        if val is None:
            continue
        try:
            if int(val) < 1:
                raise ValueError()
        except (ValueError, TypeError):
            invalid.append(field)


def _check_api_versions(api_id, env, client, hints):
    """Check if API has multiple versions and populate hints if so.

    Returns dict with status info or False if no version handling needed.
    - {"needs_selection": True} if multiple versions exist and user needs to select one
    - {"auto_selected": True, "version": {...}} if exactly 1 version exists (auto-select it)
    - False if no versioning or version detection fails

    Modifies hints dict in-place with version information.
    """
    try:
        # Check if this API is a version-set parent (has apiVersionSetId)
        status, api_data = client.get(f"apis/{api_id}")

        if status == 200:
            props = api_data.get("properties", {})
            version_set_id = props.get("apiVersionSetId")

            if version_set_id:
                # Fetch all APIs in this version set - filter for current revisions only
                all_apis = client.list_all("apis", extra_params="&$filter=isCurrent eq true")
                all_versions = []
                for api in all_apis:
                    api_props = api.get("properties", {})
                    if api_props.get("apiVersionSetId") == version_set_id:
                        all_versions.append({
                            "id": api.get("name", ""),
                            "displayName": api_props.get("displayName", ""),
                            "versionName": api_props.get("apiVersion", "Original"),
                            "revision": api_props.get("apiRevision", "1"),
                            "isCurrent": api_props.get("isCurrent", False)
                        })

                # Deduplicate by versionName - keep only current revision or latest
                versions_map = {}
                for v in all_versions:
                    ver_name = v["versionName"]
                    if ver_name not in versions_map:
                        versions_map[ver_name] = v
                    else:
                        # Prefer current revision, otherwise take higher revision number
                        existing = versions_map[ver_name]
                        if v["isCurrent"] or (not existing["isCurrent"] and int(v["revision"]) > int(existing["revision"])):
                            versions_map[ver_name] = v

                versions = list(versions_map.values())

                if len(versions) > 1:
                    # Multiple versions exist - populate hints for user selection
                    hints["api_versions"] = versions
                    hints["api_version_set_id"] = version_set_id
                    hints["api_display_name"] = props.get("displayName", api_id)
                    hints["version_selection_required"] = True  # Flag for frontend to show version dropdown
                    return {"needs_selection": True}
                elif len(versions) == 1:
                    # Exactly one version - auto-select it
                    return {"auto_selected": True, "version": versions[0], "display_name": props.get("displayName", api_id)}

        return False
    except Exception:
        # If version detection fails, proceed without version selection
        return False


def _check_and_gate_version_selection(api_param_name, params, env, client, hints):
    """Check if API has multiple versions and raise MissingParams if so.
    If API has exactly 1 version, auto-selects it.

    Uses the same approach as Diff flow - populates hints with version info
    and raises MissingParams to trigger the version selector UI.

    Args:
        api_param_name: The param name holding the API ID (e.g., "apiId", "existingApiId")
        params: The params dict (modified in-place for auto-selection)
        env: Environment name
        client: APIM client for the environment
        hints: The hints dict to populate with version info

    Raises:
        MissingParams: If the API has multiple versions and user hasn't selected one
    """
    api_id = params.get(api_param_name)
    if not api_id:
        return

    # Skip if user has already explicitly picked a version
    if params.get("_versionPicked") or params.get("_versionChecked"):
        return

    version_result = _check_api_versions(api_id, env, client, hints)

    if version_result:
        if isinstance(version_result, dict):
            if version_result.get("needs_selection"):
                # Multiple versions - raise MissingParams to trigger version selector
                raise MissingParams([api_param_name])
            elif version_result.get("auto_selected"):
                # Exactly one version - auto-select it
                version_info = version_result["version"]
                concrete_id = version_info["id"]

                # Update params with the concrete version ID
                params[api_param_name] = concrete_id
                params["_versionPicked"] = True
                params["_versionChecked"] = True
                params["_apiDisplayName"] = version_result.get("display_name", concrete_id)
                params["_apiVersionName"] = version_info.get("versionName", "")

                # Set resolution flags to prevent re-processing
                if api_param_name == "apiId":
                    params["_apiIdResolved"] = True
                elif api_param_name == "existingApiId":
                    params["_existingApiIdResolved"] = True

                # Add hint for debugging
                hints["auto_selected_version"] = {
                    "displayName": version_result.get("display_name", concrete_id),
                    "versionName": version_info.get("versionName", ""),
                    "concreteId": concrete_id
                }


def _build_create_api_step(p, backend_config, label_suffix=""):
    """Shared builder for create_api / create_api_with_lb steps. Returns one step dict.

    Caller supplies the backend_config and an optional label suffix. URLs, JWT,
    rate, quota, _parsed are computed identically.
    """
    from utils.url_parser import parse_backend_url

    env = p.get("env", "dev")
    urls_input = p.get("urls") or []

    built_urls = []
    for entry in urls_input:
        parsed = parse_backend_url(entry.get("url", ""))
        verb = str(entry.get("verb") or "").upper()
        # api_creator does urlparse(entry["url"]).path to derive the rewrite-uri
        # template for per-op policies. Pass the FULL URL (host + path) so that
        # path is non-empty — matching what the manual create-api page sends.
        built_urls.append({
            "url": parsed["backend_url"] + parsed["backend_path"],
            "verb": verb,
            "client_path": parsed["frontend_suffix"],
            "body_type": None,
        })

    # By the time we get here, build_plan has already enforced urls is non-empty.
    first_parsed = parse_backend_url(urls_input[0].get("url", ""))
    first_verb = str(urls_input[0].get("verb") or "").upper()

    payload = {
        "env": env,
        "mode": "new",
        "name": p["displayName"],
        "urls": built_urls,
        "jwt_audience": p["jwtAudience"],
        "rate_limit_calls": int(p["rateLimitCalls"]),
        "quota_calls": int(p["quotaCalls"]),
        "backend_config": backend_config,
        "backend_cert_thumbprint": p.get("backendCertThumbprint"),
    }
    label = f"Create API '{p['displayName']}' in {env}"
    if label_suffix:
        label = f"{label} {label_suffix}"
    return {
        "action": "POST_create_api",
        "label": label,
        "endpoint": "/api/apis/create",
        "payload": payload,
        "_parsed": {
            "host": first_parsed["host"],
            "frontend_suffix": first_parsed["frontend_suffix"],
            "verb": first_verb,
        },
    }


def _create_api_steps(p, _hints):
    # Inline cert upload: when user signalled cert auth but no thumbprint
    # is pinned yet, raise MissingParams so the frontend renders an upload card.
    if (
        p.get("backendCertAuth")
        and not p.get("backendCertThumbprint")
        and not p.get("_certUploadInFlight")
    ):
        _hints["cert_upload_target_env"] = p.get("env")
        _hints["cert_upload_suggested_id"] = (
            (p.get("name") or p.get("apiName") or "uploaded") + "-client-cert"
        )
        raise MissingParams(["backendCertThumbprint"])

    from utils.url_parser import parse_backend_url
    hosts = set()
    for u in (p.get("urls") or []):
        try:
            hosts.add(parse_backend_url(u.get("url", ""))["host"])
        except ValueError:
            continue
    if len(hosts) >= 2 and not p.get("backendStrategy"):
        raise MissingParams(["backendStrategy"])

    # Smart product collision: if create_api will create a product (i.e. a
    # consumer is being onboarded inline) AND the consumer slug already names
    # an existing product, ask the user. Falls through silently on network/auth
    # failure so the existing collision-suffix probe in api_creator still runs.
    if (
        p.get("consumerAppName")
        and p.get("env")
        and not p.get("existingProductId")
        and not p.get("productStrategy")
    ):
        from utils.slugify import to_slug
        try:
            from flask import current_app
            client = current_app.get_client(p["env"])
            slug = to_slug(p["consumerAppName"])
            status, existing = client.get(f"products/{slug}")
            if status == 200:
                _hints["product_collision"] = {
                    "existing_id": slug,
                    "existing_name": (existing or {}).get("properties", {}).get("displayName", slug),
                }
                raise MissingParams(["productStrategy"])
        except MissingParams:
            raise
        except Exception:
            pass

    # Translate productStrategy → existingProductId for api_creator's add-to-existing path.
    if p.get("productStrategy") == "use_existing" and not p.get("existingProductId"):
        from utils.slugify import to_slug
        p = {**p, "existingProductId": (
            (_hints.get("product_collision") or {}).get("existing_id")
            or to_slug(p.get("consumerAppName", ""))
        )}

    backend_config = {"enable_lb": False}
    # Honor explicit pool choice — upgrade to LB path
    if p.get("backendStrategy") == "pool":
        return _create_api_with_lb_steps({**p, "lbAlgorithm": p.get("lbAlgorithm") or "roundRobin"}, _hints)
    # standalone or single-host — pass through with new flag
    backend_config["backend_strategy"] = p.get("backendStrategy")  # may be None or "standalone"
    return [_build_create_api_step(p, backend_config)]


def _extract_backend_configs(p):
    """Convert lbWeights param into hostname -> {priority, weight} dict.

    Args:
        p: params dict with 'urls' and optional 'lbWeights'

    Returns:
        dict mapping hostname to {priority, weight} config
    """
    from utils.url_parser import parse_backend_url

    urls = p.get("urls", [])
    lb_weights = p.get("lbWeights")
    lb_algorithm = p.get("lbAlgorithm") or "roundRobin"

    if not lb_weights or not isinstance(lb_weights, list):
        return {}  # No weights provided, use defaults

    result = {}
    for i, entry in enumerate(urls):
        try:
            parsed = parse_backend_url(entry.get("url", ""))
            hostname = parsed["host"]

            # Get weight/priority for this URL (index i)
            if i < len(lb_weights):
                value = int(lb_weights[i])
            else:
                # Not enough weights provided, use default
                value = 50 if lb_algorithm == "weighted" else 1

            # For weighted algorithm: value is weight
            # For priority algorithm: value is priority
            if lb_algorithm == "priority":
                result[hostname] = {"priority": value, "weight": 50}
            else:  # weighted or roundRobin
                result[hostname] = {"priority": 1, "weight": value}
        except (ValueError, KeyError):
            continue

    return result


def _create_api_with_lb_steps(p, _hints):
    # Always force a user decision on multi-host. The LLM tends to auto-add
    # `with_lb` when it sees multiple URLs — but the user wants to pick
    # pool-vs-standalone explicitly. Treat with_lb as a hint, not a decision.
    from utils.url_parser import parse_backend_url
    hosts = set()
    for u in (p.get("urls") or []):
        try:
            hosts.add(parse_backend_url(u.get("url", ""))["host"])
        except ValueError:
            continue
    if len(hosts) >= 2 and not p.get("backendStrategy"):
        raise MissingParams(["backendStrategy"])
    # If user explicitly picked standalone via the chooser, route back to the
    # standalone flow even though intent said with_lb.
    if p.get("backendStrategy") == "standalone":
        return _create_api_steps(p, _hints)

    backend_config = {
        "enable_lb": True,
        "lb_algorithm": p.get("lbAlgorithm") or "roundRobin",
        "enable_circuit_breaker": bool(p.get("_enable_cb", False)),
        "backend_configs": _extract_backend_configs(p),  # Add weight/priority mapping
    }
    if backend_config["enable_circuit_breaker"]:
        backend_config["circuit_breaker"] = {
            "failure_count": int(p.get("cbFailureCount") or 5),
            "interval_seconds": int(p.get("cbIntervalSeconds") or 60),
            "trip_duration_seconds": int(p.get("cbTripDuration") or 30),
        }
    return [_build_create_api_step(p, backend_config, label_suffix="(load-balanced)")]


def _add_operations_steps(p, _hints):
    """Add new operations to an existing API. The actual execution is
    multi-stage on the frontend (inspect → ask routing → execute) — this
    step just carries the raw inputs."""
    # Smart existingApiId resolution. Resolves user-typed queries (substrings,
    # display names, typos) against the env's API list. Cache is per-env with
    # 5-min TTL. Single match auto-resolves; 2+ candidates raise MissingParams
    # to surface a chooser; not_found raises with suggestions.
    # Skip resolution if user explicitly picked a version (to preserve the exact version ID)
    if p.get("existingApiId") and p.get("env") and not p.get("_existingApiIdResolved") and not p.get("_versionPicked"):
        try:
            from services.resource_resolver import resolve_api_id
            from flask import current_app
            client = current_app.get_client(p["env"])
            status, value = resolve_api_id(p["env"], p["existingApiId"], client)
            if status == "ok":
                if value != p["existingApiId"]:
                    _hints["existingApiId_resolved_from"] = p["existingApiId"]
                    _hints["existingApiId_resolved_to"] = value
                p = {**p, "existingApiId": value, "_existingApiIdResolved": True}
            elif status == "ambiguous":
                _hints["existingApiId_candidates"] = value
                _hints["existingApiId_query"] = p["existingApiId"]
                raise MissingParams(["existingApiId"])
            elif status == "not_found":
                _hints["existingApiId_candidates"] = value
                _hints["existingApiId_query"] = p["existingApiId"]
                _hints["existingApiId_not_found"] = True
                raise MissingParams(["existingApiId"])
        except MissingParams:
            raise
        except Exception:
            # Network/auth error — let downstream APIM call surface its own error
            pass

    # Version selection: if API has multiple versions, prompt user to choose
    # Use the helper function designed for form-based flows (same as Onboarding/Diff tabs)
    if p.get("existingApiId") and p.get("env"):
        try:
            from flask import current_app
            client = current_app.get_client(p["env"])
            _check_and_gate_version_selection("existingApiId", p, p["env"], client, _hints)
        except MissingParams:
            raise
        except Exception:
            pass

    env = p.get("env", "dev")
    payload = {
        "env": env,
        "mode": "add",
        "existing_api_id": p["existingApiId"],
        "urls": [
            {
                "url": u.get("url", ""),
                "verb": str(u.get("verb") or "").upper(),
                "client_path": u.get("client_path") or None,
                "body_type": u.get("body_type") or None,
            }
            for u in (p.get("urls") or [])
        ],
    }

    # Include pool priority/weight if specified for adding to existing pool
    if p.get("poolPriority") is not None or p.get("poolWeight") is not None:
        payload["pool_member_config"] = {}
        if p.get("poolPriority") is not None:
            payload["pool_member_config"]["priority"] = int(p["poolPriority"])
        if p.get("poolWeight") is not None:
            payload["pool_member_config"]["weight"] = int(p["poolWeight"])

    # Pass circuit breaker flag if user explicitly requested it
    if p.get("_enable_cb"):
        payload["user_requested_cb"] = True

    steps = [{
        "action": "ADD_operations",  # special — _executeAddOps handles this
        "label": f"Add {len(p.get('urls') or [])} op(s) to {p['existingApiId']} in {env}",
        "endpoint_inspect": "/api/apis/inspect-additions",
        "endpoint_execute": "/api/apis/create",
        "payload": payload,
    }]
    return steps


def _create_api_with_consumer_steps(p, _hints):
    # Inline cert upload: when user signalled cert auth but no thumbprint
    # is pinned yet, raise MissingParams so the frontend renders an upload card.
    if (
        p.get("backendCertAuth")
        and not p.get("backendCertThumbprint")
        and not p.get("_certUploadInFlight")
    ):
        _hints["cert_upload_target_env"] = p.get("env")
        _hints["cert_upload_suggested_id"] = (
            (p.get("name") or p.get("apiName") or "uploaded") + "-client-cert"
        )
        raise MissingParams(["backendCertThumbprint"])

    return [{
        "action": "NAVIGATE_create_api",
        "label": f"Open Create API form for '{p['displayName']}' (with consumer onboarding)",
        "params": {
            "displayName": p["displayName"],
            "path": p.get("path", "/"),
            "env": p.get("env", "dev"),
            "backendUrl": p.get("backendUrl"),
            "consumerAppName": p.get("consumerAppName"),
            "consumerAppId": p.get("consumerAppId"),
            "withConsumer": True,
            "backendCertThumbprint": p.get("backendCertThumbprint"),
        },
    }]


def _promote_steps(p, _hints):
    # Cross-env probe: if user gave apiId but not src, check all envs for a match.
    if p.get("apiId") and not p.get("src") and not p.get("_envProbed"):
        try:
            from services.resource_resolver import find_api_in_envs
            from flask import current_app
            from config import APIM_INSTANCES
            env_clients = {}
            for env_name in APIM_INSTANCES.keys():
                try:
                    env_clients[env_name] = current_app.get_client(env_name)
                except Exception:
                    pass
            matches = find_api_in_envs(p["apiId"], env_clients)
            if matches:
                _hints["env_candidates"] = matches
                _hints["env_query"] = p["apiId"]
                raise MissingParams(["src"])
        except MissingParams:
            raise
        except Exception:
            pass  # fall through to existing missing-src handling

    # Smart apiId resolution. Resolves user-typed queries (substrings, display
    # names, typos) against the env's API list. Cache is per-env with 5-min
    # TTL. Single match auto-resolves; 2+ candidates raise MissingParams to
    # surface a chooser; not_found raises with suggestions.
    # Skip resolution if user explicitly picked a version (to preserve the exact version ID)
    if p.get("apiId") and p.get("src") and not p.get("_apiIdResolved") and not p.get("_versionPicked"):
        try:
            from services.resource_resolver import resolve_api_id
            from flask import current_app
            client = current_app.get_client(p["src"])
            status, value = resolve_api_id(p["src"], p["apiId"], client)
            if status == "ok":
                if value != p["apiId"]:
                    _hints["apiId_resolved_from"] = p["apiId"]
                    _hints["apiId_resolved_to"] = value
                p = {**p, "apiId": value, "_apiIdResolved": True}
            elif status == "ambiguous":
                _hints["apiId_candidates"] = value
                _hints["apiId_query"] = p["apiId"]
                raise MissingParams(["apiId"])
            elif status == "not_found":
                _hints["apiId_candidates"] = value
                _hints["apiId_query"] = p["apiId"]
                _hints["apiId_not_found"] = True
                raise MissingParams(["apiId"])
        except MissingParams:
            raise
        except Exception:
            # Network/auth error — let downstream APIM call surface its own error
            pass

    # Version selection: if API has multiple versions, prompt user to choose
    # Use the helper function designed for form-based flows (same as Onboarding/Diff tabs)
    if p.get("apiId") and p.get("src"):
        try:
            from flask import current_app
            client = current_app.get_client(p["src"])
            _check_and_gate_version_selection("apiId", p, p["src"], client, _hints)
        except MissingParams:
            raise
        except Exception:
            pass

    src = p.get("src") or "dev"
    dest = p["dest"]
    api_id = p["apiId"]
    steps = [{
        "action": "POST_promote",
        "label": f"Promote {api_id}: {src} -> {dest}",
        "endpoint": "/api/promote/api",
        "payload": {
            "api_id": api_id,
            "src": src,
            "dest": dest,
        },
    }]
    return steps


def _bulk_promote_steps(p, _hints):
    src = p.get("src") or "dev"
    dest = p["dest"]
    api_ids = p["apiIds"]
    return [{
        "action": "POST_bulk_promote",
        "label": f"Bulk promote {len(api_ids)} APIs: {src} -> {dest}",
        "endpoint": "/api/promote/bulk",
        "payload": {
            "api_ids": api_ids,
            "src": src,
            "dest": dest,
        },
        "bulk": True,
    }]


def _onboard_steps(p, _hints):
    # Smart apiId resolution. Resolves user-typed queries (substrings, display
    # names, typos) against the env's API list. Cache is per-env with 5-min
    # TTL. Single match auto-resolves; 2+ candidates raise MissingParams to
    # surface a chooser; not_found raises with suggestions.
    # Skip resolution if user explicitly picked a version (to preserve the exact version ID)
    if p.get("apiId") and p.get("env") and not p.get("_apiIdResolved") and not p.get("_versionPicked"):
        try:
            from services.resource_resolver import resolve_api_id
            from flask import current_app
            client = current_app.get_client(p["env"])
            status, value = resolve_api_id(p["env"], p["apiId"], client)
            if status == "ok":
                if value != p["apiId"]:
                    _hints["apiId_resolved_from"] = p["apiId"]
                    _hints["apiId_resolved_to"] = value
                p = {**p, "apiId": value, "_apiIdResolved": True}
            elif status == "ambiguous":
                _hints["apiId_candidates"] = value
                _hints["apiId_query"] = p["apiId"]
                raise MissingParams(["apiId"])
            elif status == "not_found":
                _hints["apiId_candidates"] = value
                _hints["apiId_query"] = p["apiId"]
                _hints["apiId_not_found"] = True
                raise MissingParams(["apiId"])
        except MissingParams:
            raise
        except Exception:
            # Network/auth error — let downstream APIM call surface its own error
            pass

    # Version selection: if API has multiple versions, prompt user to choose
    # Use the helper function designed for form-based flows
    if p.get("apiId") and p.get("env"):
        try:
            from flask import current_app
            client = current_app.get_client(p["env"])
            _check_and_gate_version_selection("apiId", p, p["env"], client, _hints)
        except MissingParams:
            raise
        except Exception:
            pass

    # Check for consumer duplicate: if consumer already has access to this API
    # (based on app_id, app_name, or consumer_name in products/subscriptions/policies),
    # surface the existing products and let user choose to add to existing or create new.
    if (
        p.get("consumerAppId")
        and p.get("apiId")
        and p.get("env")
        and not p.get("productStrategy")
    ):
        try:
            from flask import current_app
            import requests
            from config import PORT
            # Call the check-duplicate endpoint to find if consumer already has access
            resp = requests.get(
                f"http://localhost:{PORT}/api/onboard/check-duplicate",
                params={
                    "env": p["env"],
                    "consumer_app_id": p["consumerAppId"],
                    "consumer_app_name": p.get("consumerAppName", ""),
                    "consumer_name": p.get("consumerName", ""),
                    "consumer_client_id": p.get("consumerName", ""),
                    "api_id": p["apiId"],
                },
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("exists") and data.get("products"):
                    _hints["consumer_duplicate"] = {
                        "products": data["products"],
                        "api_id": p["apiId"],
                    }
                    raise MissingParams(["productStrategy"])
        except MissingParams:
            raise
        except Exception:
            # Network/timeout — fall through and let onboard proceed
            pass

    # Smart product collision: if consumer_app_name's slug already names an
    # existing product, fetch ALL consumer products (same as Products/Onboard tabs).
    if (
        p.get("consumerAppName")
        and p.get("env")
        and not p.get("onboardStrategy")
        and not p.get("productStrategy")
        and not _hints.get("consumer_duplicate")  # Skip if duplicate already detected
    ):
        from utils.slugify import to_slug
        try:
            from flask import current_app

            client = current_app.get_client(p["env"])

            # ALWAYS check for ALL consumer products using APIM client directly (no HTTP localhost calls)
            all_products = []
            consumer_name_lower = p.get("consumerAppName", "").lower()
            consumer_app_id_str = str(p.get("consumerAppId", "")) if p.get("consumerAppId") else ""

            # Get all products from APIM directly
            try:
                BUILTIN_PRODUCTS = {"starter", "unlimited"}
                all_apim_products = client.list_all("products", ver="2021-08-01")

                for product in all_apim_products:
                    product_id = product.get("name", "")
                    product_name = product.get("properties", {}).get("displayName", "")

                    if not product_id or product_id in BUILTIN_PRODUCTS:
                        continue

                    # Check if product belongs to this consumer (check both name AND ID)
                    product_id_lower = product_id.lower()
                    product_name_lower = product_name.lower()
                    consumer_name_only = p.get("consumerName", "").lower()

                    belongs_to_consumer = False
                    # Check by app ID (e.g., "8001" finds "8001-PortalApp")
                    if consumer_app_id_str and (consumer_app_id_str in product_name or consumer_app_id_str in product_id):
                        belongs_to_consumer = True
                    # Check by consumer name (e.g., "portalapp" finds "portalapp-2")
                    elif consumer_name_only and (consumer_name_only in product_name_lower or consumer_name_only in product_id_lower):
                        belongs_to_consumer = True
                    # Check by full consumer app name (e.g., "8001-portalapp")
                    elif consumer_name_lower and (consumer_name_lower in product_name_lower or consumer_name_lower in product_id_lower):
                        belongs_to_consumer = True

                    if belongs_to_consumer:
                        all_products.append({
                            "id": product_id,
                            "name": product_name or product_id
                        })
            except Exception:
                pass  # Continue even if product fetch fails

            # Show ALL products for selection (like Products tab)
            if all_products:
                _hints["consumer_duplicate"] = {
                    "products": all_products,
                    "api_id": p.get("apiId", ""),
                }
                raise MissingParams(["productStrategy"])
        except MissingParams:
            raise
        except Exception:
            # Network/auth failure — fall through. onboard_service has its own
            # defensive auto-suffix probe so we won't PUT-overwrite anything.
            pass

    # Translate productStrategy → onboardStrategy params for onboard_service.
    if p.get("productStrategy") == "use_existing":
        from utils.slugify import to_slug
        # Check if existingProductId was already set (from duplicate detection or frontend)
        existing_id = p.get("existingProductId")
        if not existing_id:
            # Fall back to product_collision hint or consumer name slug
            duplicate_products = (_hints.get("consumer_duplicate") or {}).get("products", [])
            if duplicate_products:
                existing_id = duplicate_products[0]["id"]  # Use first product from duplicate detection
            else:
                existing_id = (
                    (_hints.get("product_collision") or {}).get("existing_id")
                    or to_slug(p.get("consumerAppName", ""))
                )
        p = {**p, "onboardStrategy": "add_to_existing", "existingProductId": existing_id}
    elif p.get("productStrategy") == "new_with_suffix":
        p = {**p, "onboardStrategy": "create_new"}

    env = p.get("env", "dev")
    consumer_app_name = p["consumerAppName"]
    api_id = p["apiId"]
    selected_operations = p.get("selectedOperations", [])
    steps = [{
        "action": "POST_onboard",
        "label": f"Onboard '{consumer_app_name}' to {api_id} in {env}",
        "endpoint": "/api/onboard",
        "payload": {
            "env": env,
            "api_id": api_id,
            "consumer_app_name": consumer_app_name,
            "consumer_app_id": p.get("consumerAppId"),
            "consumer_name": p.get("consumerName"),
            "selected_operations": selected_operations,
            "onboard_strategy": p.get("onboardStrategy"),
            "existing_product_id": p.get("existingProductId"),
        },
    }]
    return steps


def _diff_steps(p, _hints):
    api_id = p.get("apiId")

    # Smart apiId resolution with fuzzy matching (like onboard_consumer)
    # Skip resolution if user explicitly picked a version (to preserve the exact version ID)
    if api_id and p.get("src") and not p.get("_apiIdResolved") and not p.get("_versionPicked"):
        try:
            from services.resource_resolver import resolve_api_id
            from flask import current_app
            # Try to resolve in source environment first
            client = current_app.get_client(p["src"])
            status, value = resolve_api_id(p["src"], api_id, client)
            if status == "ok":
                if value != api_id:
                    _hints["apiId_resolved_from"] = api_id
                    _hints["apiId_resolved_to"] = value
                api_id = value
                p = {**p, "apiId": value, "_apiIdResolved": True}
            elif status == "ambiguous":
                _hints["apiId_candidates"] = value
                _hints["apiId_query"] = api_id
                raise MissingParams(["apiId"])
            elif status == "not_found":
                _hints["apiId_candidates"] = value
                _hints["apiId_query"] = api_id
                _hints["apiId_not_found"] = True
                raise MissingParams(["apiId"])
        except MissingParams:
            raise
        except Exception:
            # Network/auth error — let downstream APIM call surface its own error
            pass

    # Version selection: if API has multiple versions (e.g., -dev, -original), prompt user
    # Use the helper function designed for form-based flows
    if api_id and p.get("src"):
        try:
            from flask import current_app
            client = current_app.get_client(p["src"])
            _check_and_gate_version_selection("apiId", p, p["src"], client, _hints)
            # Update api_id from params if it was auto-selected
            api_id = p.get("apiId", api_id)
        except MissingParams:
            raise
        except Exception:
            pass

    if api_id:
        endpoint = f"/api/diff/api?api_id={api_id}"
        params = {"src": p["src"], "dest": p["dest"]}
    else:
        endpoint = "/api/diff/instance"
        params = {"src": p["src"], "dest": p["dest"]}

    step = {
        "action": "READ_diff",
        "label": f"Diff {p['src']} vs {p['dest']}",
        "endpoint": endpoint,
        "params": params,
    }

    return [step]


def _list_apis_steps(p, _hints):
    env = p.get("env", "dev")
    return [{
        "action": "READ_list_apis",
        "label": f"List APIs ({env})",
        "endpoint": "/api/apis",
        "params": {"env": env},
    }]


def _list_products_steps(p, _hints):
    env = p.get("env", "dev")
    return [{
        "action": "READ_list_products",
        "label": f"List Products ({env})",
        "endpoint": "/api/products",
        "params": {"env": env},
    }]


def _search_api_steps(p, _hints):
    env = p.get("env", "dev")
    return [{
        "action": "READ_search_apis",
        "label": f"Search APIs for '{p['searchTerm']}' in {env}",
        "endpoint": "/api/apis/search",
        "params": {"env": env, "q": p["searchTerm"]},
    }]


def _spec_generator_steps(_p, _hints):
    return [{
        "action": "NAVIGATE_spec_generator",
        "label": "Open Spec Generator",
        "params": {},
    }]


# Templates are evaluated in priority DESCENDING order — first match wins.
TEMPLATES = [
    {
        "id": "create_api_with_consumer",
        "name": "Create API + Onboard Consumer",
        "intent_match": {"create", "api", "with_consumer"},
        "intent_exclude": {"with_lb"},
        "priority": 30,
        "required_params": ["displayName", "path", "consumerAppName", "env"],
        "gate_required": True,
        "mode": "execute",
        "build_steps": _create_api_with_consumer_steps,
        "summary_template": "Create API '{displayName}' (path {path}) and onboard consumer '{consumerAppName}'",
    },
    {
        "id": "create_api_with_lb",
        "name": "Create API with Load Balancer",
        "intent_match": {"create", "api", "with_lb"},
        "intent_exclude": {"with_consumer"},
        "priority": 25,
        "required_params": ["displayName", "urls", "jwtAudience", "rateLimitCalls", "quotaCalls", "env"],
        "gate_required": True,
        "mode": "execute",
        "build_steps": _create_api_with_lb_steps,
        "summary_template": None,
    },
    {
        "id": "add_operations",
        "name": "Add Operations to API",
        "intent_match": {"add", "api"},
        "intent_exclude": set(),
        "priority": 25,
        "required_params": ["existingApiId", "urls", "env"],
        "gate_required": True,
        "mode": "execute",
        "build_steps": _add_operations_steps,
        "summary_template": None,
    },
    {
        "id": "create_api",
        "name": "Create API",
        "intent_match": {"create", "api"},
        "intent_exclude": {"with_consumer"},
        "priority": 20,
        "required_params": ["displayName", "urls", "jwtAudience", "rateLimitCalls", "quotaCalls", "env"],
        "gate_required": True,
        "mode": "execute",
        "build_steps": _create_api_steps,
        "summary_template": None,  # computed dynamically in build_plan
    },
    {
        "id": "bulk_promote",
        "name": "Bulk Promote APIs",
        "intent_match": {"promote", "api", "bulk"},
        "intent_exclude": set(),
        "priority": 30,
        "required_params": ["apiIds", "dest"],
        "gate_required": True,
        "mode": "execute",
        "build_steps": _bulk_promote_steps,
        "summary_template": None,
    },
    {
        "id": "promote_api",
        "name": "Promote API",
        "intent_match": {"promote", "api"},
        "intent_exclude": {"bulk"},
        "priority": 25,
        "required_params": ["apiId", "dest"],
        "gate_required": True,
        "mode": "execute",
        "build_steps": _promote_steps,
        "summary_template": None,  # computed dynamically in build_plan
    },
    {
        "id": "onboard_consumer",
        "name": "Onboard Consumer",
        "intent_match": {"onboard"},
        "intent_exclude": set(),
        "priority": 25,
        "required_params": ["consumerAppName", "apiId", "consumerAppId", "consumerName", "selectedOperations", "env"],
        "gate_required": True,
        "mode": "execute",
        "build_steps": _onboard_steps,
        "summary_template": None,  # computed dynamically in build_plan
    },
    {
        "id": "diff_envs",
        "name": "Compare Environments",
        "intent_match": {"diff"},
        "intent_exclude": set(),
        "priority": 15,
        "required_params": ["src", "dest"],
        "gate_required": False,
        "mode": "read",
        "build_steps": _diff_steps,
        "summary_template": "Compare {src} vs {dest}",
    },
    {
        "id": "search_api",
        "name": "Search APIs",
        "intent_match": {"search", "api"},
        "intent_exclude": set(),
        "priority": 12,
        "required_params": ["searchTerm"],
        "gate_required": False,
        "mode": "read",
        "build_steps": _search_api_steps,
        "summary_template": "Search APIs for '{searchTerm}'",
    },
    {
        "id": "list_apis",
        "name": "List APIs",
        "intent_match": {"list", "api"},
        "intent_exclude": set(),
        "priority": 10,
        "required_params": [],
        "gate_required": False,
        "mode": "read",
        "build_steps": _list_apis_steps,
        "summary_template": "Open Explorer",
    },
    {
        "id": "list_products",
        "name": "List Products",
        "intent_match": {"list", "product"},
        "intent_exclude": set(),
        "priority": 10,
        "required_params": [],
        "gate_required": False,
        "mode": "read",
        "build_steps": _list_products_steps,
        "summary_template": "Open Products page",
    },
    {
        "id": "open_spec_generator",
        "name": "Spec Generator",
        "intent_match": {"create", "spec"},
        "intent_exclude": set(),
        "priority": 10,
        "required_params": [],
        "gate_required": False,
        "mode": "navigate",
        "build_steps": _spec_generator_steps,
        "summary_template": "Open Spec Generator",
    },
]

# Sort once at module load — match_template can then return the first hit.
TEMPLATES.sort(key=lambda t: t["priority"], reverse=True)


def match_template(intent_tags):
    """Return the first matching template by priority. None if off_topic OR analyze."""
    if "off_topic" in intent_tags:
        return None
    if "analyze" in intent_tags:
        return None  # Caller should redirect to /api/assistant/analyze
    intent_set = set(intent_tags)
    for t in TEMPLATES:
        if t["intent_match"].issubset(intent_set) and t["intent_exclude"].isdisjoint(intent_set):
            return t
    raise NoTemplateMatch(f"No template handles intent {intent_tags}")


def build_plan(intent_tags, params, hints):
    """Match a template, validate params, build steps + summary.

    Returns: a plan dict {template_id, name, mode, gate_required, steps, summary}
             None if intent_tags contains "off_topic".
    Raises:  MissingParams (with .missing list) when required params are absent.
             InvalidParams (with .invalid list) when params have wrong types/values.
             NoTemplateMatch when the tag combination matches no template
             (different from off_topic — usually means the LLM extracted an
             intent we don't handle yet).
    """
    # Safety net: LLM sometimes keeps the "bulk" modifier even when only one
    # apiId is named, despite rule 12. Drop the modifier here and copy the
    # single id to apiId so it routes to the singular promote_api flow.
    intent_tags = list(intent_tags or [])
    api_ids_param = params.get("apiIds") or []
    if "bulk" in intent_tags and isinstance(api_ids_param, list) and len(api_ids_param) == 1:
        intent_tags = [t for t in intent_tags if t != "bulk"]
        params = {**params, "apiId": api_ids_param[0]}

    template = match_template(intent_tags)
    if template is None:
        return None  # off_topic OR analyze (caller decides what to do)

    if template["id"] == "create_api_with_lb" and "with_cb" in set(intent_tags):
        params = {**params, "_enable_cb": True}

    # Also check for circuit breaker intent in add_operations flow
    if template["id"] == "add_operations" and "with_cb" in set(intent_tags):
        params = {**params, "_enable_cb": True}

    # `is None` not falsy — so rateLimitCalls=0 reaches the numeric validator
    # below (where it correctly raises InvalidParams) instead of being lumped
    # in as "missing". Empty strings and empty lists also count as missing.
    def _is_blank(v):
        return v is None or v == "" or (isinstance(v, list) and len(v) == 0)
    missing = [p for p in template["required_params"] if _is_blank(params.get(p))]

    # Per-URL verb is required for create_api / create_api_with_lb / add_operations —
    # if any url entry has a null verb, surface "verb" as a missing field so the
    # assistant asks for it.
    if template["id"] in ("create_api", "create_api_with_lb", "add_operations"):
        urls = params.get("urls") or []
        if urls and any(_is_blank(u.get("verb")) for u in urls if isinstance(u, dict)):
            if "verb" not in missing:
                missing.append("verb")

    # Cross-env probe for onboard_consumer: if apiId present but env missing,
    # check all envs and surface candidates so the UI can render a chooser.
    if template["id"] == "onboard_consumer" and params.get("apiId") and not params.get("env") and not params.get("_envProbed"):
        try:
            from services.resource_resolver import find_api_in_envs
            from flask import current_app
            from config import APIM_INSTANCES
            env_clients = {}
            for env_name in APIM_INSTANCES.keys():
                try:
                    env_clients[env_name] = current_app.get_client(env_name)
                except Exception:
                    pass
            matches = find_api_in_envs(params["apiId"], env_clients)
            if matches:
                hints["env_candidates"] = matches
                hints["env_query"] = params["apiId"]
        except MissingParams:
            raise
        except Exception:
            pass  # fall through to standard missing-env handling

    # Fuzzy matching for onboard_consumer: resolve API name before showing "Got it." message
    # This ensures the UI displays the resolved name (e.g., "APIM Demo" not "APIM Demo API")
    # Skip if already resolved or if user has picked a version (which implies API is resolved)
    if template["id"] == "onboard_consumer" and params.get("apiId") and params.get("env") and not params.get("_apiIdResolved") and not params.get("_versionPicked"):
        try:
            from services.resource_resolver import resolve_api_id
            from flask import current_app
            client = current_app.get_client(params["env"])
            original_api_id = params["apiId"]
            status, value = resolve_api_id(params["env"], params["apiId"], client)

            if status == "ok":
                # Modify params in place so the resolved name is used everywhere
                params["apiId"] = value
                params["_apiIdResolved"] = True

                # Fetch display name for use in summary message
                try:
                    _, api_data = client.get(f"apis/{value}")
                    display_name = api_data.get("properties", {}).get("displayName", value)
                    params["_apiDisplayName"] = display_name
                except Exception:
                    params["_apiDisplayName"] = value  # fallback to API ID

                # Check for version selection after API is resolved
                _check_and_gate_version_selection("apiId", params, params["env"], client, hints)
            elif status == "ambiguous":
                # Get display name from first candidate (they should all have same display name if ambiguous)
                display_name = value[0]["display_name"] if value and len(value) > 0 else original_api_id
                hints["apiId_candidates"] = value
                hints["apiId_query"] = display_name  # Use clean display name for display
                # Don't overwrite params["apiId"] - preserve any pinned value from user selection
                raise MissingParams(["apiId"])
            elif status == "not_found":
                hints["apiId_candidates"] = value
                hints["apiId_query"] = params["apiId"]
                raise MissingParams(["apiId"])
        except MissingParams:
            raise
        except Exception:
            pass  # fall through

    # Fuzzy matching for promote_api: resolve API name in source env before showing "Got it."
    if template["id"] == "promote_api" and params.get("apiId") and params.get("src") and not params.get("_apiIdResolved"):
        try:
            from services.resource_resolver import resolve_api_id
            from flask import current_app
            client = current_app.get_client(params["src"])
            status, value = resolve_api_id(params["src"], params["apiId"], client)
            if status == "ok":
                # Modify params in place
                params["apiId"] = value
                params["_apiIdResolved"] = True

                # Fetch display name for use in summary message
                try:
                    _, api_data = client.get(f"apis/{value}")
                    display_name = api_data.get("properties", {}).get("displayName", value)
                    params["_apiDisplayName"] = display_name
                except Exception:
                    params["_apiDisplayName"] = value  # fallback to API ID

                # Check for version selection after API is resolved
                _check_and_gate_version_selection("apiId", params, params["src"], client, hints)
            elif status == "ambiguous":
                hints["apiId_candidates"] = value
                hints["apiId_query"] = params["apiId"]
                raise MissingParams(["apiId"])
            elif status == "not_found":
                hints["apiId_candidates"] = value
                hints["apiId_query"] = params["apiId"]
                raise MissingParams(["apiId"])
        except MissingParams:
            raise
        except Exception:
            pass  # fall through

    # Fuzzy matching for diff_envs: resolve API name in source env before showing "Got it."
    if template["id"] == "diff_envs" and params.get("apiId") and params.get("src") and not params.get("_apiIdResolved"):
        try:
            from services.resource_resolver import resolve_api_id
            from flask import current_app
            client = current_app.get_client(params["src"])
            status, value = resolve_api_id(params["src"], params["apiId"], client)
            if status == "ok":
                # Modify params in place
                params["apiId"] = value
                params["_apiIdResolved"] = True

                # Check for version selection after API is resolved
                _check_and_gate_version_selection("apiId", params, params["src"], client, hints)
            elif status == "ambiguous":
                hints["apiId_candidates"] = value
                hints["apiId_query"] = params["apiId"]
                raise MissingParams(["apiId"])
            elif status == "not_found":
                hints["apiId_candidates"] = value
                hints["apiId_query"] = params["apiId"]
                raise MissingParams(["apiId"])
        except MissingParams:
            raise
        except Exception:
            pass  # fall through

    # Fuzzy matching for add_operations: resolve API name before showing "Got it."
    if template["id"] == "add_operations" and params.get("existingApiId") and params.get("env") and not params.get("_existingApiIdResolved"):
        try:
            from services.resource_resolver import resolve_api_id
            from flask import current_app
            client = current_app.get_client(params["env"])
            status, value = resolve_api_id(params["env"], params["existingApiId"], client)
            if status == "ok":
                # Modify params in place
                params["existingApiId"] = value
                params["_existingApiIdResolved"] = True

                # Fetch display name for use in summary message
                try:
                    _, api_data = client.get(f"apis/{value}")
                    display_name = api_data.get("properties", {}).get("displayName", value)
                    params["_existingApiDisplayName"] = display_name
                except Exception:
                    params["_existingApiDisplayName"] = value  # fallback to API ID

                # Check for version selection after API is resolved
                _check_and_gate_version_selection("existingApiId", params, params["env"], client, hints)
            elif status == "ambiguous":
                hints["existingApiId_candidates"] = value
                hints["existingApiId_query"] = params["existingApiId"]
                raise MissingParams(["existingApiId"])
            elif status == "not_found":
                hints["existingApiId_candidates"] = value
                hints["existingApiId_query"] = params["existingApiId"]
                raise MissingParams(["existingApiId"])
        except MissingParams:
            raise
        except Exception:
            pass  # fall through

    # Early duplicate operation check for add_operations - check BEFORE execution
    if template["id"] == "add_operations":
        existing_api_id = params.get("existingApiId")
        env = params.get("env")
        urls = params.get("urls") or []
        if existing_api_id and env and urls and all(isinstance(u, dict) and u.get("verb") for u in urls):
            from flask import current_app
            from urllib.parse import urlparse
            from config import API_VER

            client = current_app.get_client(env)
            existing_operations = client.list_all(f"apis/{existing_api_id}/operations", ver=API_VER)
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
                api_display = params.get("_existingApiDisplayName") or existing_api_id
                dup_list = ", ".join(duplicates)
                log.info("Duplicate operations found", extra={"api": api_display, "duplicates": duplicates})
                raise DuplicateApiError(
                    f"Cannot add operations - the following operation(s) already exist in API '{api_display}':\n  {dup_list}\n\n"
                    f"Please remove these duplicate operations and try again."
                )

    # Backend cert auth: when user signalled cert forwarding (accepts both
    # backendCertAuth and the LLM-drift name clientCertAuth) but no thumbprint
    # is pinned, bundle backendCertThumbprint into missing so the frontend
    # renders the upload card alongside any other prompts.
    if template["id"] in ("create_api", "create_api_with_lb"):
        wants_cert = bool(params.get("backendCertAuth") or params.get("clientCertAuth"))
        has_thumbprint = bool(params.get("backendCertThumbprint"))
        if wants_cert and not has_thumbprint:
            if "backendCertThumbprint" not in missing:
                missing.append("backendCertThumbprint")
            hints["cert_upload_target_env"] = params.get("env")
            hints["cert_upload_suggested_id"] = (
                (params.get("displayName") or params.get("name") or "uploaded") + "-client-cert"
            )

    # Early duplicate check for create_api flows - check BEFORE collecting
    # additional config (JWT, rate limit, quota) to avoid wasting user's time
    if template["id"] in ("create_api", "create_api_with_lb"):
        display_name = params.get("displayName")
        env = params.get("env")
        # Only check if we have both displayName and env (minimum needed)
        if display_name and env:
            from flask import current_app
            from config import API_VER

            client = current_app.get_client(env)

            # Get all APIs and check by display name (fuzzy match)
            log.info("Fetching all APIs for duplicate check", extra={"env": env, "display_name": display_name})
            all_apis = client.list_all("apis", ver=API_VER)
            log.info("APIs fetched successfully", extra={"count": len(all_apis) if all_apis else 0})

            if all_apis:  # Only check if we got a valid list
                display_name_lower = display_name.lower().strip()

                for api in all_apis:
                    api_props = api.get("properties", {})
                    existing_display_name = api_props.get("displayName", "")

                    # Case-insensitive exact display name match
                    if existing_display_name.lower().strip() == display_name_lower:
                        api_id = api.get("name", "")
                        log.info("Duplicate API found", extra={"api_id": api_id, "display_name": existing_display_name})
                        raise DuplicateApiError(
                            f"API with display name '{existing_display_name}' already exists (API ID: '{api_id}'). "
                            f"Please choose a different API name or use 'Add to Existing API' to add operations to it."
                        )

                log.info("No duplicate found", extra={"display_name": display_name})

    if missing:
        raise MissingParams(missing)

    import re as _re

    _VALID_ENVS = {"dev", "sandbox", "prod", "dr"}

    # Type validation for create_api numeric params
    if template["id"] in ("create_api",):
        invalid = []
        _validate_positive_ints(params, ("rateLimitCalls", "quotaCalls"), invalid)
        if invalid:
            raise InvalidParams(invalid)

    # Validation for create_api_with_lb
    if template["id"] == "create_api_with_lb":
        invalid = []
        _validate_positive_ints(params, ("rateLimitCalls", "quotaCalls"), invalid)
        _validate_positive_ints(params, ("cbFailureCount", "cbIntervalSeconds", "cbTripDuration"), invalid)
        lb_algo = params.get("lbAlgorithm")
        if lb_algo is not None and lb_algo not in ("roundRobin", "weighted", "priority"):
            invalid.append("lbAlgorithm")
        # At least 2 distinct backend hosts are needed to load-balance.
        from utils.url_parser import parse_backend_url as _pb
        urls = params.get("urls") or []
        hosts = set()
        for u in urls:
            if isinstance(u, dict) and u.get("url"):
                try:
                    hosts.add(_pb(u["url"])["host"].lower())
                except Exception:
                    pass
        if len(hosts) < 2:
            invalid.append("urls")
        if invalid:
            raise InvalidParams(invalid)

    # Validation for promote_api
    if template["id"] == "promote_api":
        invalid = []
        src = params.get("src") or "dev"
        dest = params.get("dest")
        if src not in _VALID_ENVS:
            invalid.append("src")
        if dest not in _VALID_ENVS:
            invalid.append("dest")
        if invalid:
            raise InvalidParams(invalid)

    # Validation for bulk_promote
    if template["id"] == "bulk_promote":
        invalid = []
        src = params.get("src") or "dev"
        dest = params.get("dest")
        if src not in _VALID_ENVS:
            invalid.append("src")
        if dest not in _VALID_ENVS:
            invalid.append("dest")
        api_ids = params.get("apiIds") or []
        if not isinstance(api_ids, list):
            invalid.append("apiIds")
        elif len(api_ids) < 2:
            invalid.append("apiIds")
        elif any(not isinstance(x, str) or not x.strip() for x in api_ids):
            invalid.append("apiIds")
        if invalid:
            raise InvalidParams(invalid)

    # Validation for onboard_consumer
    if template["id"] == "onboard_consumer":
        invalid = []
        env = params.get("env", "dev")
        if env not in _VALID_ENVS:
            invalid.append("env")
        # consumerAppId must be numeric
        app_id = params.get("consumerAppId")
        try:
            if not str(app_id).strip().isdigit():
                raise ValueError("not numeric")
        except (ValueError, TypeError, AttributeError):
            invalid.append("consumerAppId")
        # consumerName must be a short identifier (alnum + hyphen/underscore, no spaces, 2-64 chars)
        consumer_name = params.get("consumerName", "")
        _cn_re = _re.compile(r'^[A-Za-z0-9_-]{2,64}$')
        if not _cn_re.match(str(consumer_name)):
            invalid.append("consumerName")
        if invalid:
            raise InvalidParams(invalid)

    steps = template["build_steps"](params, hints)

    # Build summary
    if template["id"] == "create_api":
        # Dynamic summary from parsed step data
        step = steps[0]
        parsed = step.get("_parsed", {})
        host = parsed.get("host", "")
        frontend_suffix = parsed.get("frontend_suffix", "")
        verb = parsed.get("verb", "GET")
        env = params.get("env", "dev")
        summary = (
            f"Create API '{params['displayName']}' in {env}: "
            f"1 op ({verb} {frontend_suffix}), backend {host}, "
            f"JWT aud={params['jwtAudience']}, "
            f"rate={params['rateLimitCalls']}/min, quota={params['quotaCalls']}/day"
        )
    elif template["id"] == "create_api_with_lb":
        step = steps[0]
        env = params.get("env", "dev")
        lb_algo = step["payload"]["backend_config"]["lb_algorithm"]
        cb_enabled = step["payload"]["backend_config"].get("enable_circuit_breaker", False)
        from utils.url_parser import parse_backend_url as _pb
        hosts_count = len({_pb(u["url"])["host"].lower() for u in step["payload"]["urls"]})
        cb_phrase = ", circuit breaker on" if cb_enabled else ""
        summary = (
            f"Create API '{params['displayName']}' in {env} with LB ({lb_algo}) "
            f"across {hosts_count} backends{cb_phrase}, "
            f"JWT aud={params['jwtAudience']}, "
            f"rate={params['rateLimitCalls']}/min, quota={params['quotaCalls']}/day"
        )
    elif template["id"] == "promote_api":
        # Use display name if available, otherwise fall back to API ID
        api_display = params.get("_apiDisplayName") or params["apiId"]
        src = params.get("src") or "dev"
        dest = params["dest"]
        summary = (
            f"Promote {api_display}: {src} -> {dest} "
            f"(8 steps: revisions, named values, backends, spec, import, policies, products, release)"
        )
    elif template["id"] == "bulk_promote":
        api_ids = params["apiIds"]
        src = params.get("src") or "dev"
        dest = params["dest"]
        summary = (
            f"Promote {len(api_ids)} APIs from {src} to {dest}: {', '.join(api_ids)}. "
            f"Each API runs the standard 8-step promote pipeline."
        )
    elif template["id"] == "add_operations":
        # Use display name if available, otherwise fall back to API ID
        api_display = params.get("_existingApiDisplayName") or params["existingApiId"]
        env = params.get("env", "dev")
        urls = params.get("urls") or []
        summary = (
            f"Add {len(urls)} new op(s) to {api_display} in {env}. "
            f"I'll inspect the existing API and ask how to route any new backend hosts."
        )
    elif template["id"] == "onboard_consumer":
        consumer_app_name = params["consumerAppName"]
        # Use display name if available, otherwise fall back to API ID
        api_display = params.get("_apiDisplayName") or params["apiId"]
        env = params.get("env", "dev")
        selected_ops = params.get("selectedOperations", [])
        summary = (
            f"Onboard '{consumer_app_name}' to {api_display} ({env}): "
            f"create product, link API, create subscription, "
            f"add consumer-name '{params.get('consumerName','')}' to allowlist on {len(selected_ops)} ops, release new revision"
        )
    elif template["summary_template"] is not None:
        try:
            summary = template["summary_template"].format(**{**params, "src": params.get("src", "dev")})
        except KeyError as e:
            log.warning(
                "summary_template references missing key — falling back to template name",
                extra={"template_id": template["id"], "missing_key": str(e)},
            )
            summary = template["name"]
    else:
        summary = template["name"]

    return {
        "template_id": template["id"],
        "name": template["name"],
        "mode": template["mode"],
        "gate_required": template["gate_required"],
        "steps": steps,
        "summary": summary,
    }
