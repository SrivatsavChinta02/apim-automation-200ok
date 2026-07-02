"""
Consumer onboarding service — generator that yields progress events
as it onboards a consumer to an API in Azure APIM step by step.
"""

from config import API_VER
from utils.slugify import to_slug
from utils.policy_xml import inject_appid, inject_consumer_name, ensure_consumer_name_variable
from app import add_default_groups_to_product


def _is_ok(status):
    return 200 <= status < 300


def onboard_consumer(client, params):
    """
    Generator that onboards a consumer to an existing API in APIM.

    Creates/reuses a product, links the API, creates a subscription,
    updates operation policies with the consumer's appId, and returns
    subscription keys.

    Params:
        client: ApimClient instance
        params: dict with api_id, consumer_app_name, consumer_app_id,
                consumer_client_id, selected_operations, onboard_strategy,
                existing_product_id (optional)

    Yields:
        dict with step, total, status, message (and summary on final)
    """
    api_id = params["api_id"]

    # Initialize display names for tracking
    product_display_name = None
    sub_display_name = None

    # Naming: product = <consumer_app_name>; sub = sub-<product_id>.
    strategy = params.get("onboard_strategy", "create_new")
    if strategy == "add_to_existing" and params.get("existing_product_id"):
        product_id = params["existing_product_id"]
    else:
        product_id = to_slug(params["consumer_app_name"])

    sub_id = f"sub-{to_slug(product_id)}"
    total = 6  # Increased to include revision creation step

    # ── Step 1: Find or create product ─────────────────────────────────
    yield {"step": 1, "total": total, "status": "running",
           "message": f"Checking product {product_id}..."}

    # If adding to existing, skip creation and just verify it exists
    if strategy == "add_to_existing":
        status, existing = client.get(f"products/{product_id}")
        if status == 200:
            product_display_name = existing.get("properties", {}).get("displayName", product_id)
            yield {"step": 1, "total": total, "status": "done",
                   "message": f"Product {product_id} already exists, reusing"}
        else:
            yield {"step": 1, "total": total, "status": "error",
                   "message": f"Product {product_id} not found"}
            return
    else:
        # Create new product. The collision-prompt UX is handled at the
        # flow_templates layer (productStrategy MissingParams). If we got here
        # with a slug that already exists, defensively probe for a free suffix
        # so we never PUT-overwrite an unrelated existing product.
        original_product_id = product_id
        counter = 1
        while True:
            status_check, _ = client.get(f"products/{product_id}")
            if status_check == 404:
                break
            counter += 1
            product_id = f"{original_product_id}-{counter}"
            sub_id = f"sub-{to_slug(product_id)}"

        product_display_name = (
            params["consumer_app_name"]
            if counter == 1
            else f"{params['consumer_app_name']}-{counter}"
        )
        status, data = client.put(f"products/{product_id}", {
            "properties": {
                "displayName": product_display_name,
                "subscriptionRequired": True,
                "state": "published",
            }
        })
        if not _is_ok(status):
            yield {"step": 1, "total": total, "status": "error",
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
        yield {"step": 1, "total": total, "status": "done",
               "message": f"Product {product_id} created"}

    # ── Step 2: Link API to product ────────────────────────────────────
    yield {"step": 2, "total": total, "status": "running",
           "message": f"Linking API {api_id} to product {product_id}..."}

    status, data = client.put(f"products/{product_id}/apis/{api_id}", {})
    if not _is_ok(status):
        yield {"step": 2, "total": total, "status": "error",
               "message": f"Failed to link API to product: {data}"}
        return

    yield {"step": 2, "total": total, "status": "done",
           "message": f"API {api_id} linked to product {product_id}"}

    # ── Step 3: Create subscription ────────────────────────────────────
    # Only create subscription for NEW products, not when adding to existing products
    if strategy == "add_to_existing":
        # Skip subscription creation - existing product already has subscriptions
        yield {"step": 3, "total": total, "status": "done",
               "message": f"Using existing product subscriptions"}
    else:
        # Create new subscription for new product
        yield {"step": 3, "total": total, "status": "running",
               "message": f"Creating subscription {sub_id}..."}

        sub_display_name = f"Sub-{product_display_name}"
        status, data = client.put(f"subscriptions/{sub_id}", {
            "properties": {
                "scope": f"/products/{product_id}",
                "displayName": sub_display_name,
                "state": "active",
            }
        })
        if not _is_ok(status):
            yield {"step": 3, "total": total, "status": "error",
                   "message": f"Failed to create subscription: {data}"}
            return

        yield {"step": 3, "total": total, "status": "done",
               "message": f"Subscription {sub_id} created"}

    # ── Step 4: Update selected operation policies ─────────────────────
    import re as _re
    ops = params["selected_operations"]

    # Expand the __ALL__ sentinel to every op slug on the API.
    if ops == ["__ALL__"]:
        all_ops = client.list_all(f"apis/{api_id}/operations")
        ops = [op.get("name") for op in all_ops if op.get("name")]

    # Resolve label-style entries to actual operation ids (slugs). Defensive:
    # the picker now sends slugs but free-form queries might emit labels like
    # "GET /orders" which would 400 when used as a path segment.
    def _looks_like_slug(s):
        return bool(_re.fullmatch(r'[a-z0-9][a-z0-9-]*', s or ''))

    unresolved = [op for op in ops if not _looks_like_slug(op)]
    if unresolved:
        all_ops = client.list_all(f"apis/{api_id}/operations")
        # APIM accepts operation names in any case (e.g. operationId 'addPet'
        # imported from OpenAPI). Build both a name set and a label→name map.
        existing_names = {op.get("name", "") for op in all_ops if op.get("name")}
        label_to_name = {}
        for op in all_ops:
            op_props = op.get("properties", {})
            method = (op_props.get("method") or "").upper()
            url_template = op_props.get("urlTemplate") or ""
            label_to_name[f"{method} {url_template}"] = op.get("name", "")
            label_to_name[f"{method} {url_template}".lower()] = op.get("name", "")
        resolved_ops = []
        for op in ops:
            if _looks_like_slug(op) or op in existing_names:
                resolved_ops.append(op)
                continue
            candidate = (label_to_name.get(op)
                         or label_to_name.get(op.lower())
                         or label_to_name.get(op.split('?')[0].strip())
                         or label_to_name.get(op.split('?')[0].strip().lower()))
            if candidate:
                resolved_ops.append(candidate)
            else:
                yield {"step": 4, "total": total, "status": "error",
                       "message": f"Could not resolve operation '{op}' to an existing operation id on {api_id}"}
                return
        ops = resolved_ops

    yield {"step": 4, "total": total, "status": "running",
           "message": f"Updating policies for {len(ops)} operations..."}

    # Idempotently ensure the API-level policy extracts the consumer-name header
    # into a context variable. Op-level <choose> blocks read from this variable;
    # without it they evaluate empty-string against the allowlist and 401 every caller.
    api_policy_path = f"apis/{api_id}/policies/policy"
    api_status, api_xml = client.get(api_policy_path, rawxml=True)
    if api_status == 200 and api_xml:
        patched_api_xml = ensure_consumer_name_variable(api_xml)
        if patched_api_xml != api_xml:
            client.put(api_policy_path,
                       {"properties": {"format": "rawxml", "value": patched_api_xml}})
            yield {"step": 4, "total": total, "status": "running",
                   "message": "Added consumer-name header extraction at API level"}

    consumer_name = params.get("consumer_name") or params.get("consumer_client_id") or ""
    for op_id in ops:
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
        if not _is_ok(status):
            yield {"step": 4, "total": total, "status": "error",
                   "message": f"Failed to update policy for operation {op_id}: {data}"}
            return

    yield {"step": 4, "total": total, "status": "done",
           "message": f"Policies updated for {len(ops)} operations"}

    # ── Step 5: Create new revision with policy changes ────────────────
    yield {"step": 5, "total": total, "status": "running",
           "message": f"Creating new revision for API {api_id}..."}

    # Get current max revision number
    revisions = client.list_all(f"apis/{api_id}/revisions", ver=API_VER)

    # Extract revision numbers
    revision_numbers = []
    for rev in revisions:
        rev_num = None

        # Try 'name' field first
        name = rev.get('name', '')
        if name and name.isdigit():
            rev_num = int(name)

        # If not found, try extracting from 'id' field
        if rev_num is None:
            rev_id = rev.get('id', '')
            if ';rev=' in rev_id:
                try:
                    rev_num = int(rev_id.split(';rev=')[-1])
                except (ValueError, IndexError):
                    pass

        # If still not found, try the last segment of id
        if rev_num is None and 'id' in rev:
            try:
                id_parts = rev['id'].rstrip('/').split('/')
                if len(id_parts) > 0 and id_parts[-1].isdigit():
                    rev_num = int(id_parts[-1])
            except (ValueError, IndexError):
                pass

        if rev_num:
            revision_numbers.append(rev_num)

    max_revision = max(revision_numbers) if revision_numbers else 1
    next_revision = max_revision + 1

    # Extract base API ID (without revision)
    base_api_id = api_id.split(';rev=')[0] if ';rev=' in api_id else api_id

    # Create new revision
    revision_api_id = f"{base_api_id};rev={next_revision}"
    release_name = f"release-rev{next_revision}"

    # APIM does NOT auto-create a new revision when policies are PATCHed; we must
    # explicitly PUT the revision resource before we can release it. CRITICAL:
    # `sourceApiId` + `apiRevision` together tell APIM to CLONE all operations
    # and policies from the current revision into the new one. Without these,
    # the new revision is empty (operations disappear when we release rev N+1
    # as current). Mirror api_creator._add_operations_to_existing_api (line 419).
    status_cur, current_api = client.get(f"apis/{base_api_id}", ver=API_VER)
    if not _is_ok(status_cur):
        yield {"step": 5, "total": total, "status": "error",
               "message": f"Failed to fetch current api props before creating revision: {current_api}"}
        return
    cur_props = current_api.get("properties", {}) or {}

    # Check if API is part of a version set
    version_set_id = cur_props.get("apiVersionSetId")

    # ALERT: Display version set information for debugging
    if version_set_id:
        yield {"step": 5, "total": total, "status": "running",
               "message": f"✓ API '{base_api_id}' is versioned (apiVersionSetId: {version_set_id})"}
    else:
        yield {"step": 5, "total": total, "status": "running",
               "message": f"⚠ API '{base_api_id}' has NO apiVersionSetId (standalone API or version set missing)"}

    # Create new revision with copied properties
    # CRITICAL: sourceApiId tells Azure to COPY all operations from current revision
    # For versioned APIs: Include path explicitly, but let apiVersionSetId be inherited
    # For standalone APIs: Include path explicitly
    revision_body = {
        "properties": {
            "sourceApiId": f"/apis/{base_api_id}",
            "apiRevision": str(next_revision),
            "apiRevisionDescription": f"Consumer onboarding: {params['consumer_app_name']} (id: {params['consumer_app_id']})",
            "path": cur_props.get("path", ""),  # Always include path explicitly
            "isCurrent": False,
        }
    }

    if version_set_id:
        yield {"step": 5, "total": total, "status": "running",
               "message": f"✓ API '{base_api_id}' is versioned - including path explicitly, apiVersionSetId will be inherited"}
    else:
        yield {"step": 5, "total": total, "status": "running",
               "message": f"✓ Creating revision for standalone API with path"}

    # Remove None values
    revision_body["properties"] = {k: v for k, v in revision_body["properties"].items() if v is not None}
    status_rev, rev_data = client.put(f"apis/{revision_api_id}", revision_body, ver=API_VER)
    if not _is_ok(status_rev):
        yield {"step": 5, "total": total, "status": "error",
               "message": f"Failed to create revision {next_revision}: {rev_data}"}
        return

    release_body = {
        "properties": {
            "apiId": f"/apis/{revision_api_id}",
            "notes": f"Consumer onboarding: Added {params['consumer_app_name']} (ID: {params['consumer_app_id']})"
        }
    }

    # Create the release
    status, release_data = client.put(f"apis/{base_api_id}/releases/{release_name}", release_body, ver=API_VER)
    if not _is_ok(status):
        yield {"step": 5, "total": total, "status": "error",
               "message": f"Failed to release revision {next_revision}. Status: {status}. Error: {release_data}"}
        return

    # Explicitly set the revision as current using PATCH
    make_current_body = {
        "properties": {
            "isCurrent": True
        }
    }

    status_patch, patch_data = client.patch(f"apis/{revision_api_id}", make_current_body, ver=API_VER)
    if not _is_ok(status_patch):
        yield {"step": 5, "total": total, "status": "error",
               "message": f"Failed to set revision {next_revision} as current. Status: {status_patch}. Error: {patch_data}"}
        return

    # Verify the revision was actually set as current
    status_verify, api_verify = client.get(f"apis/{revision_api_id}", ver=API_VER)
    is_current = api_verify.get("properties", {}).get("isCurrent", False) if _is_ok(status_verify) else False

    if not is_current:
        yield {"step": 5, "total": total, "status": "error",
               "message": f"Failed to verify revision {next_revision} as current"}
        return

    yield {"step": 5, "total": total, "status": "done",
           "message": f"✓ Revision {next_revision} created and set as current"}

    # ── Step 6: Get subscription keys and return summary ───────────────
    yield {"step": 6, "total": total, "status": "running",
           "message": "Retrieving subscription keys..."}

    # For existing products, list all subscriptions and get keys for the first one
    # For new products, get keys for the newly created subscription
    if strategy == "add_to_existing":
        # List existing subscriptions for the product
        existing_subs = client.list_all(f"products/{product_id}/subscriptions")
        if not existing_subs:
            yield {"step": 6, "total": total, "status": "error",
                   "message": f"No subscriptions found for product {product_id}"}
            return

        # Get keys for the first subscription
        first_sub_id = existing_subs[0].get("name", "")
        sub_display_name = existing_subs[0].get("properties", {}).get("displayName", first_sub_id)
        status, keys = client.post(f"subscriptions/{first_sub_id}/listSecrets")
        if not _is_ok(status):
            yield {"step": 6, "total": total, "status": "error",
                   "message": f"Failed to retrieve subscription keys: {keys}"}
            return

        sub_id = first_sub_id  # Use actual subscription ID for summary
    else:
        # Get keys for newly created subscription
        status, keys = client.post(f"subscriptions/{sub_id}/listSecrets")
        if not _is_ok(status):
            yield {"step": 6, "total": total, "status": "error",
                   "message": f"Failed to retrieve subscription keys: {keys}"}
            return

    summary_data = {
        "product_id": product_id,
        "subscription_id": sub_id,
        "operations_updated": len(ops),
        "revision": next_revision,
        "api_id": revision_api_id,
        "keys": keys,
    }
    if product_display_name:
        summary_data["product_name"] = product_display_name
    if sub_display_name:
        summary_data["subscription_name"] = sub_display_name

    yield {"step": 6, "total": total, "status": "done",
           "message": "Complete",
           "summary": summary_data}
