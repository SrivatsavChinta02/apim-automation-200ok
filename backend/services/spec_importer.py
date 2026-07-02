"""Import an OpenAPI spec into an APIM instance via PUT /apis/{id}?import=true.

Yields SSE-style event dicts so callers can stream progress to the UI.
"""
import json
import re

from utils.logger import get_logger

log = get_logger(__name__)

# APIM API IDs: must start with a letter, must NOT end with a hyphen,
# lowercase alphanumeric + hyphens in between, total length 1-80.
API_ID_RE = re.compile(r"^[a-z]([a-z0-9-]{0,78}[a-z0-9])?$")


def import_spec(client, payload):
    """Generator. Yields progress events, then a final summary event.

    payload = {
      "spec": <OpenAPI dict>,
      "api_id": <slug, required>,
      "path": <base path, required>,
      "display_name": <optional, falls back to spec.info.title>,
      "overwrite": <bool, default False>,
    }
    """
    spec = payload.get("spec")
    api_id = (payload.get("api_id") or "").strip()
    path = (payload.get("path") or "").strip().strip("/")
    overwrite = bool(payload.get("overwrite", False))

    if not isinstance(spec, dict) or "openapi" not in spec:
        yield {"status": "error", "message": "Invalid OpenAPI spec (missing 'openapi' field)"}
        return
    if not api_id:
        yield {"status": "error", "message": "api_id is required"}
        return
    if not API_ID_RE.match(api_id):
        yield {
            "status": "error",
            "message": f"api_id '{api_id}' must be lowercase alphanumeric with hyphens, start with a letter, max 80 chars",
        }
        return

    # If no path provided, use api_id as default
    if not path:
        path = api_id

    display_name = (
        payload.get("display_name")
        or spec.get("info", {}).get("title")
        or api_id
    )

    yield {"step": "validating", "message": f"Validating API '{api_id}'"}

    status, existing = client.get(f"apis/{api_id}")
    if status == 200 and not overwrite:
        existing_name = existing.get("properties", {}).get("displayName", api_id)
        yield {
            "status": "error",
            "message": f"API '{api_id}' already exists (Display Name: '{existing_name}'). Please choose a different API ID or modify the API Title in the spec.",
        }
        return

    yield {"step": "importing", "message": f"Importing spec into APIM as '{display_name}'"}

    body = {
        "properties": {
            "format": "openapi+json",
            "value": json.dumps(spec),
            "path": path,
            "displayName": display_name,
            "protocols": ["https"],
        }
    }

    status, resp = client.put(f"apis/{api_id}", body, extra_params="&import=true")

    if not (200 <= status < 300):
        message = _extract_error(resp) or f"APIM returned {status}"
        log.warning("spec import failed", extra={"api_id": api_id, "status": status})
        yield {"status": "error", "message": message}
        return

    log.info("spec import succeeded", extra={"api_id": api_id, "status": status})
    yield {
        "step": "done",
        "summary": {
            "api_id": api_id,
            "display_name": display_name,
            "path": path,
            "status": "updated" if status == 200 else "created",
        },
    }


def _extract_error(resp):
    if not isinstance(resp, dict):
        return None
    if "error" in resp and isinstance(resp["error"], dict):
        return resp["error"].get("message")
    return resp.get("message") or resp.get("raw")
