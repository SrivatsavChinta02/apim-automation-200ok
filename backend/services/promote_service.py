"""Service for promoting APIs between APIM instances.

Follows promote-api.sh logic exactly:
  Step 1 — List revisions, find current
  Step 2 — Copy named values referenced in policies
  Step 3 — Copy backends (singles first, then pools with ARM remap)
  Step 4 — Export OpenAPI spec from source (inline JSON via REST export)
  Step 5 — Import spec into destination (creates API+operations in one shot)
           If spec export fails, falls back to manual operation copy
  Step 6 — Apply policies to correct revision (API-level + per-operation)
  Step 7 — (intentionally skipped) products + subscriptions are env-scoped;
           use onboard_consumer in dest for consumer entitlement
  Step 8 — Copy + attach API tags
  Step 9 — Set current revision via release
"""

import time
import copy
from config import BACKEND_API_VER, APIM_INSTANCES
from utils.policy_xml import fix_entities, extract_backend_ids, extract_named_values, extract_base_urls
from services.env_mapper import apply_to_policy_xml, learn_substitutions, apply_to_url as _apply_url
from services import promotion_rules

TOTAL_STEPS = 9
BUILTIN_PRODUCTS = {"starter", "unlimited"}


def _progress(step, status, message):
    return {"step": step, "total": TOTAL_STEPS, "status": status, "message": message}


def _retry_put(client, path, body, ver=None, retries=4):
    """PUT with exponential backoff on 429/5xx."""
    delay = 2
    for attempt in range(retries):
        status, data = client.put(path, body, ver=ver)
        if 200 <= status < 300:
            return status, data
        if status in (429, 500, 503) and attempt < retries - 1:
            time.sleep(delay)
            delay = min(delay * 2, 30)
        else:
            return status, data
    return status, data


def _retry_get(client, path, ver=None, rawxml=False, retries=4):
    """GET with exponential backoff on 429/5xx."""
    delay = 2
    for attempt in range(retries):
        status, data = client.get(path, ver=ver, rawxml=rawxml)
        if status in (429, 500, 503) and attempt < retries - 1:
            time.sleep(delay)
            delay = min(delay * 2, 30)
        else:
            return status, data
    return status, data


def _wait_for_api(client, api_path, max_wait=18):
    """Poll until API exists in destination, up to max_wait seconds."""
    for _ in range(max_wait // 3):
        status, _ = client.get(api_path)
        if status == 200:
            return True
        time.sleep(3)
    return False


def _manual_copy_operations(src_client, dest_client, src_api_id, dest_api_id):
    """Copy all operations from src_api_id to dest_api_id one by one."""
    ops = src_client.list_all(f"apis/{src_api_id}/operations")
    copied = 0
    failed = 0
    for op in ops:
        op_id = op.get("name", "")
        if not op_id:
            continue
        op_props = op.get("properties", {})
        s, _ = _retry_put(dest_client, f"apis/{dest_api_id}/operations/{op_id}", {
            "properties": {
                "displayName": op_props.get("displayName", ""),
                "method": op_props.get("method", ""),
                "urlTemplate": op_props.get("urlTemplate", ""),
                "description": op_props.get("description", ""),
            }
        })
        if 200 <= s < 300:
            copied += 1
        else:
            failed += 1
    return copied, failed


def promote_api(src_client, dest_client, api_id, src_env, dest_env, *, wait_for_resolution=None):
    """Promote a single API from source to destination APIM instance.

    Yields progress dicts: {"step", "total", "status", "message"}

    wait_for_resolution: optional callable(missing_event_dict) -> resolution_dict
        Called when a backend URL has no mapping (AI Foundry case). Blocks until
        the frontend POSTs a resolution to /api/promote/api/resolve. If None,
        the old fallback behaviour applies (use dev URL as-is, no pause).
    """
    try:
        # ── Pre-step: Build host substitution map ─────────────────────
        src_all_backends = src_client.list_all("backends")
        dest_all_backends = dest_client.list_all("backends")

        # Primary: codified rules (only fires on dev->prod; returns {} otherwise)
        src_hosts_in_use = set()
        for b in src_all_backends:
            from urllib.parse import urlparse as _urlparse
            h = _urlparse(b.get("properties", {}).get("url", "")).hostname
            if h:
                src_hosts_in_use.add(h)
        host_sub_rules = promotion_rules.build_substitution_map(src_hosts_in_use, src_env, dest_env)

        # Supplementary: inferred from same-named backend pairs (for hosts not covered by rules)
        host_sub_inferred = learn_substitutions(src_all_backends, dest_all_backends)

        # Combined: rules win on conflict
        host_sub = {**host_sub_inferred, **host_sub_rules}
        yield _progress(1, "running", f"Host substitution map: {host_sub or 'no rewrites needed'}")

        # ── Change E: API ID transformation (Rule 4) ──────────────────
        dest_api_id = promotion_rules.transform_api_id(api_id, src_env, dest_env)
        if dest_api_id != api_id:
            yield _progress(1, "running", f"API ID transform: {api_id} -> {dest_api_id} (Rule 4)")

        # ── Step 1: List revisions ────────────────────────────────────
        yield _progress(1, "running", "Listing revisions")
        revisions = src_client.list_all(f"apis/{api_id}/revisions")
        revisions.sort(
            key=lambda r: int(r.get("properties", {}).get("apiRevision", "1"))
        )

        if not revisions:
            yield _progress(1, "error", f"No revisions found for API {api_id}")
            return

        src_current_rev = None
        for rev in revisions:
            if rev.get("properties", {}).get("isCurrent", False):
                src_current_rev = rev.get("properties", {}).get("apiRevision", "1")
        if not src_current_rev:
            src_current_rev = revisions[-1].get("properties", {}).get("apiRevision", "1")

        yield _progress(1, "running", f"Found {len(revisions)} revision(s), current={src_current_rev}")

        # ── Step 2: Copy named values ─────────────────────────────────
        yield _progress(2, "running", "Copying named values")

        # Scan all policies across all revisions to find named values and backends
        named_value_names = set()
        backend_ids = set()
        hardcoded_urls = set()
        for rev in revisions:
            rev_num = rev.get("properties", {}).get("apiRevision", "1")
            rev_api_id = f"{api_id};rev={rev_num}" if rev_num != "1" else api_id
            # API-level policy
            s, xml = _retry_get(src_client, f"apis/{rev_api_id}/policies/policy", rawxml=True)
            if s == 200 and xml:
                named_value_names.update(extract_named_values(xml))
                backend_ids.update(extract_backend_ids(xml))
                hardcoded_urls.update(extract_base_urls(xml))
            # Operation policies
            for op in src_client.list_all(f"apis/{rev_api_id}/operations"):
                op_id = op.get("name", "")
                if not op_id:
                    continue
                s2, op_xml = _retry_get(
                    src_client,
                    f"apis/{rev_api_id}/operations/{op_id}/policies/policy",
                    rawxml=True,
                )
                if s2 == 200 and op_xml:
                    named_value_names.update(extract_named_values(op_xml))
                    backend_ids.update(extract_backend_ids(op_xml))
                    hardcoded_urls.update(extract_base_urls(op_xml))

        copied_nv = 0
        for nv_name in named_value_names:
            s, nv_data = _retry_get(src_client, f"namedValues/{nv_name}", ver="2022-08-01")
            if s != 200:
                continue
            props = nv_data.get("properties", {})
            put_props = {
                "displayName": props.get("displayName", nv_name),
                "secret": props.get("secret", False),
                "tags": props.get("tags", []),
            }
            if props.get("keyVault"):
                put_props["keyVault"] = props["keyVault"]
            elif props.get("secret"):
                sv_s, sv_data = src_client.post(
                    f"namedValues/{nv_name}/listValue", ver="2022-08-01"
                )
                if sv_s == 200:
                    put_props["value"] = sv_data.get("value", "")
            else:
                put_props["value"] = props.get("value", "")
            _retry_put(
                dest_client, f"namedValues/{nv_name}",
                {"properties": put_props}, ver="2022-08-01"
            )
            copied_nv += 1

        yield _progress(2, "running", f"Copied {copied_nv} named value(s)")

        # ── Step 3: Copy backends ─────────────────────────────────────
        yield _progress(3, "running", "Copying backends")

        src_cfg = APIM_INSTANCES.get(src_env, {})
        dest_cfg = APIM_INSTANCES.get(dest_env, {})
        singles, pools = [], []

        for bid in backend_ids:
            s, bdata = _retry_get(src_client, f"backends/{bid}", ver=BACKEND_API_VER)
            if s != 200:
                continue
            btype = bdata.get("properties", {}).get("type", "Single")
            if btype == "Pool":
                pools.append((bid, bdata))
            else:
                singles.append((bid, bdata))

        # Discover pool member backends referenced inside pool.services[].id ARM paths
        import re as _re
        _MEMBER_ID_RE = _re.compile(r"/backends/([^/]+)$")
        discovered = set()
        for bid, bdata in pools:
            for svc in bdata.get("properties", {}).get("pool", {}).get("services", []):
                m = _MEMBER_ID_RE.search(svc.get("id", ""))
                if m and m.group(1) not in backend_ids:
                    discovered.add(m.group(1))
        for new_bid in discovered:
            s, bd = _retry_get(src_client, f"backends/{new_bid}", ver=BACKEND_API_VER)
            if s == 200:
                singles.append((new_bid, bd))
                backend_ids.add(new_bid)
        yield _progress(3, "running", f"Discovered {len(discovered)} pool member backend(s)")

        # Singles first (pools reference them)
        for bid, bdata in singles:
            props = copy.deepcopy(bdata.get("properties", {}))
            old_url = props.get("url", "")
            new_url = promotion_rules.transform_url(old_url, src_env, dest_env)
            if new_url is None:
                # AI Foundry case — no codified mapping for this host.
                missing_event = {
                    "step": 3, "total": TOTAL_STEPS, "status": "needs_input",
                    "event": "promote_resource_missing",
                    "kind": "backend_url",
                    "backend_id": bid,
                    "src_url": old_url,
                    "suggestion": old_url,  # caller can override
                    "message": f"Backend {bid} URL host has no prod mapping. User input required."
                }
                if wait_for_resolution is not None:
                    yield missing_event  # frontend sees it and shows prompt
                    resolution = wait_for_resolution(missing_event)
                    if resolution.get("action") == "abort":
                        yield _progress(3, "error", "Promotion aborted by user")
                        return
                    elif resolution.get("action") == "skip":
                        yield _progress(3, "running", f"Skipped backend {bid} per user request")
                        continue
                    elif resolution.get("action") == "use_url":
                        new_url = resolution.get("url") or old_url
                    else:
                        # Unknown action — fall back to dev URL
                        new_url = old_url
                else:
                    # No pause mechanism — keep dev URL as fallback so flow continues.
                    yield missing_event
                    new_url = old_url
            elif new_url == old_url:
                # No rule match — try the inferred sub_map (env_mapper)
                new_url = _apply_url(old_url, host_sub)

            if new_url != old_url:
                props["url"] = new_url
            _retry_put(dest_client, f"backends/{bid}", {"properties": props}, ver=BACKEND_API_VER)

        # Pools — remap ARM IDs to destination
        for bid, bdata in pools:
            props = copy.deepcopy(bdata.get("properties", {}))
            for svc in props.get("pool", {}).get("services", []):
                old_id = svc.get("id", "")
                new_id = (old_id
                    .replace(f"subscriptions/{src_cfg.get('subscription_id', '')}",
                             f"subscriptions/{dest_cfg.get('subscription_id', '')}")
                    .replace(f"resourceGroups/{src_cfg.get('resource_group', '')}",
                             f"resourceGroups/{dest_cfg.get('resource_group', '')}")
                    .replace(f"service/{src_cfg.get('name', '')}",
                             f"service/{dest_cfg.get('name', '')}"))
                svc["id"] = new_id
            _retry_put(dest_client, f"backends/{bid}", {"properties": props}, ver=BACKEND_API_VER)

        yield _progress(3, "running",
                        f"Copied {len(singles)} single(s) and {len(pools)} pool(s)")

        # ── Step 4: Get API metadata + export spec ────────────────────
        yield _progress(4, "running", "Fetching API spec from source")

        s, api_data = _retry_get(src_client, f"apis/{api_id}")
        if s != 200:
            yield _progress(4, "error", f"Could not fetch API metadata: HTTP {s}")
            return

        props = api_data.get("properties", {})
        display_name = props.get("displayName", api_id)
        api_path = props.get("path", "")
        protocols = props.get("protocols", ["https"])
        subscription_required = props.get("subscriptionRequired", True)
        description = props.get("description", "")

        # Export spec as inline OpenAPI JSON
        # Correct URL: /apis/{id}?api-version=2022-08-01&export=true&format=openapi
        # Using list_all's extra_params pattern via _url directly
        spec_json_value = None
        spec_export_detail = ""
        try:
            exp_s, exp_data = src_client.get(
                f"apis/{api_id}",
                ver="2022-08-01",
                extra_params="&export=true&format=openapi%2Bjson",
            )
            if exp_s == 200 and isinstance(exp_data, dict):
                spec_json_value = (
                    exp_data.get("properties", {}).get("value")
                    or exp_data.get("value")
                )
                # Azure returns the spec as a flat object (not wrapped in "value")
                if not spec_json_value and "paths" in exp_data:
                    import json as _json
                    spec_json_value = _json.dumps(exp_data)
                if not spec_json_value:
                    spec_export_detail = f"HTTP {exp_s} no value, keys={list(exp_data.keys())}"
            else:
                spec_export_detail = f"HTTP {exp_s}"
                if isinstance(exp_data, dict):
                    spec_export_detail += f" keys={list(exp_data.keys())[:4]}"
        except Exception as e:
            spec_export_detail = str(e)[:80]

        # Strip the OpenAPI `servers` array from the exported spec so APIM
        # in dest doesn't inherit src's gateway URL as serviceUrl. Without
        # this, prod APIs end up displaying the dev gateway hostname in
        # General → "Web service URL" — purely cosmetic since policies do
        # the actual routing, but misleading. Letting it default lets dest
        # APIM populate it with its own gateway URL.
        if spec_json_value:
            try:
                import json as _json
                _spec = _json.loads(spec_json_value)
                if isinstance(_spec, dict) and "servers" in _spec:
                    _spec.pop("servers", None)
                    spec_json_value = _json.dumps(_spec)
            except (ValueError, TypeError):
                # If the spec isn't parseable JSON, leave it alone — APIM
                # will reject malformed input downstream anyway.
                pass

        if spec_json_value:
            spec_status_msg = f"Spec exported ({len(spec_json_value)} chars, servers stripped)"
        else:
            spec_status_msg = f"Spec export failed ({spec_export_detail}) — will copy ops manually"
        yield _progress(4, "running", spec_status_msg)

        # ── Step 5: Import into destination ───────────────────────────
        yield _progress(5, "running", "Importing API into destination")

        # Check if API already exists in destination
        chk_s, _ = dest_client.get(f"apis/{dest_api_id}")
        api_exists_in_dest = chk_s == 200

        # This tracks which revision ID to apply policies to in Step 6
        dest_rev_id = dest_api_id  # default — rev 1 or existing

        if not api_exists_in_dest:
            # ── New API — import spec or create + copy ops ────────────
            if spec_json_value:
                # Import spec (creates API + all operations in one shot)
                import_body = {
                    "properties": {
                        "format": "openapi+json",
                        "value": spec_json_value,
                        "path": api_path,
                        "displayName": display_name,
                        "protocols": protocols,
                        "subscriptionRequired": subscription_required,
                        "description": description,
                    }
                }
                imp_s, imp_resp = _retry_put(dest_client, f"apis/{dest_api_id}", import_body)
                if not (200 <= imp_s < 300):
                    yield _progress(5, "running", f"Spec import returned {imp_s} — falling back to manual op copy")
                    _retry_put(dest_client, f"apis/{dest_api_id}", {
                        "properties": {
                            "displayName": display_name,
                            "path": api_path,
                            "protocols": protocols,
                            "subscriptionRequired": subscription_required,
                            "description": description,
                        }
                    })
                    _wait_for_api(dest_client, f"apis/{dest_api_id}")
                    time.sleep(5)
                    copied, failed = _manual_copy_operations(src_client, dest_client, api_id, dest_api_id)
                    yield _progress(5, "running", f"Manual copy: {copied} ops copied, {failed} failed")
                else:
                    yield _progress(5, "running", f"Spec imported OK (HTTP {imp_s}) — operations included")
            else:
                yield _progress(5, "running", "No spec — creating API shell then copying operations manually")
                _retry_put(dest_client, f"apis/{dest_api_id}", {
                    "properties": {
                        "displayName": display_name,
                        "path": api_path,
                        "protocols": protocols,
                        "subscriptionRequired": subscription_required,
                        "description": description,
                    }
                })
                _wait_for_api(dest_client, f"apis/{dest_api_id}")
                time.sleep(5)
                copied, failed = _manual_copy_operations(src_client, dest_client, api_id, dest_api_id)
                yield _progress(5, "running", f"Manual copy: {copied} ops copied, {failed} failed")

            dest_rev_id = dest_api_id  # new API is always rev 1
            dest_current_rev = "1"

        else:
            # ── API exists — create new revision, import spec into it ─
            dest_revs = dest_client.list_all(f"apis/{dest_api_id}/revisions")
            max_rev = max(
                [int(r.get("properties", {}).get("apiRevision", "1")) for r in dest_revs],
                default=1,
            )
            next_rev = max_rev + 1
            next_rev_str = str(next_rev)

            # Create new revision — matches: az apim api revision create
            # REST: PUT /apis/{id};rev={N} with sourceApiId = /apis/{id}
            rev_create_body = {
                "properties": {
                    "displayName": display_name,
                    "path": api_path,
                    "protocols": protocols,
                    "subscriptionRequired": subscription_required,
                    "apiRevisionDescription": f"Promoted from {src_env}",
                    "sourceApiId": f"/apis/{dest_api_id}",
                    "apiRevision": next_rev_str,
                }
            }
            # Retry — Azure eventual consistency after first promote
            rev_created = False
            for attempt in range(5):
                cr_s, _ = _retry_put(
                    dest_client, f"apis/{dest_api_id};rev={next_rev_str}", rev_create_body
                )
                if 200 <= cr_s < 300:
                    rev_created = True
                    break
                time.sleep(3)

            if rev_created:
                # Import spec into the new revision
                # Matches: az apim api import --api-id api;rev=N
                _wait_for_api(dest_client, f"apis/{dest_api_id};rev={next_rev_str}")
                if spec_json_value:
                    import_body = {
                        "properties": {
                            "format": "openapi+json",
                            "value": spec_json_value,
                            "path": api_path,
                            "displayName": display_name,
                            "protocols": protocols,
                            "subscriptionRequired": subscription_required,
                            "description": description,
                        }
                    }
                    imp_s, _ = _retry_put(
                        dest_client, f"apis/{dest_api_id};rev={next_rev_str}", import_body
                    )
                    if not (200 <= imp_s < 300):
                        # Spec import failed — copy ops manually
                        _manual_copy_operations(
                            src_client, dest_client, api_id,
                            f"{dest_api_id};rev={next_rev_str}"
                        )
                else:
                    _manual_copy_operations(
                        src_client, dest_client, api_id,
                        f"{dest_api_id};rev={next_rev_str}"
                    )

            dest_rev_id = f"{dest_api_id};rev={next_rev_str}"
            dest_current_rev = next_rev_str

        _wait_for_api(dest_client, f"apis/{dest_api_id}")
        yield _progress(5, "running", f"API '{display_name}' ready in destination")

        # ── Step 6: Apply policies to the correct revision ────────────
        yield _progress(6, "running", "Applying policies")
        policies_applied = 0

        # API-level policy — apply to dest_rev_id (the revision we just created/imported)
        s, xml = _retry_get(src_client, f"apis/{api_id}/policies/policy", rawxml=True)
        if s == 200 and xml and "<policies/>" not in xml:
            rewritten = apply_to_policy_xml(fix_entities(xml), host_sub)
            _retry_put(
                dest_client,
                f"apis/{dest_rev_id}/policies/policy",
                {"properties": {"format": "rawxml", "value": rewritten}},
            )
            policies_applied += 1

        # Operation-level policies — apply to dest_rev_id
        ops = src_client.list_all(f"apis/{api_id}/operations")
        for op in ops:
            op_id = op.get("name", "")
            if not op_id:
                continue
            op_s, op_xml = _retry_get(
                src_client,
                f"apis/{api_id}/operations/{op_id}/policies/policy",
                rawxml=True,
            )
            if op_s == 200 and op_xml and "<policies/>" not in op_xml:
                rewritten_op = apply_to_policy_xml(fix_entities(op_xml), host_sub)
                _retry_put(
                    dest_client,
                    f"apis/{dest_rev_id}/operations/{op_id}/policies/policy",
                    {"properties": {"format": "rawxml", "value": rewritten_op}},
                )
                policies_applied += 1

        yield _progress(6, "running", f"Applied {policies_applied} policy document(s)")

        # ── Step 7: Skipped — products + subscriptions are env-scoped ──
        # Products without subscriptions are dead artifacts in dest. Per design
        # decision 2026-05-04: promote ships the API surface only. Consumer
        # entitlement (product + subscription + keys) is a separate per-env
        # action via the onboard_consumer flow.
        yield _progress(7, "running",
                        "Products/subscriptions skipped — onboard consumers separately in dest")

        # ── Step 8: Copy + attach API tags ───────────────────────────
        yield _progress(8, "running", "Copying API tags")
        try:
            api_tags = src_client.list_all(f"apis/{api_id}/tags", ver="2022-08-01")
        except Exception:
            api_tags = []
        tags_attached = 0
        for tag in api_tags:
            tag_id = tag.get("name", "")
            if not tag_id:
                continue
            # Create tag in dest if missing
            chk_s, _ = dest_client.get(f"tags/{tag_id}", ver="2022-08-01")
            if chk_s != 200:
                _retry_put(dest_client, f"tags/{tag_id}",
                           {"properties": {"displayName": tag.get("properties", {}).get("displayName", tag_id)}},
                           ver="2022-08-01")
            # Attach to API
            _retry_put(dest_client, f"apis/{dest_api_id}/tags/{tag_id}", None, ver="2022-08-01")
            tags_attached += 1
        yield _progress(8, "running", f"Attached {tags_attached} tag(s) to API")

        # ── Step 9: Set current revision ─────────────────────────────
        yield _progress(9, "running", "Setting current revision")

        # Always create a release to make the promoted revision current
        release_id = f"promote-release-{int(time.time())}"
        _retry_put(
            dest_client,
            f"apis/{dest_api_id}/releases/{release_id}",
            {
                "properties": {
                    "apiId": f"/apis/{dest_api_id};rev={dest_current_rev}",
                    "notes": f"Promoted from {src_env} via APIM Admin Extension",
                }
            },
        )
        summary = {
            "api_id": dest_api_id,
            "api_name": display_name,
            "api_path": api_path,
            "src": src_env,
            "dest": dest_env,
            "revision": dest_current_rev
        }
        yield {
            "step": 9,
            "total": 9,
            "status": "done",
            "message": f"Promotion complete — revision {dest_current_rev} set as current",
            "summary": summary
        }

    except Exception as exc:
        yield _progress(0, "error", str(exc))
