"""Pure helpers for turning a backend URL into the inputs api_creator expects."""
from urllib.parse import urlparse
import re


def parse_backend_url(raw_url: str) -> dict:
    """Parse a full backend URL into its API-creation components.

    Input:  "https://apigatewayuatinternal.cognizant.com/1CBCApps/2762/IKPKM/GetIKPData"
    Output: {
      "scheme":          "https",
      "host":            "apigatewayuatinternal.cognizant.com",
      "backend_url":     "https://apigatewayuatinternal.cognizant.com",
      "backend_path":    "/1CBCApps/2762/IKPKM/GetIKPData",
      "frontend_suffix": "/getikpdata",
    }

    For URLs with path parameters, the trailing {param} tokens are preserved
    on the frontend suffix so that APIM's rewrite-uri can reference them:
      "/api/v1/status/{id}" -> frontend_suffix "/status/{id}"
      "/orders/{id}/items"  -> frontend_suffix "/items" (params before slug stripped)

    For URLs with no path, frontend_suffix falls back to a host-derived slug
    instead of bare "/" so operation IDs don't collapse to e.g. "get-":
      "https://test.corp.com" -> frontend_suffix "/root"

    Raises ValueError if the URL has no scheme or no host.
    """
    s = (raw_url or "").strip()
    if not s:
        raise ValueError(f"Could not parse host from URL: {raw_url!r}")
    if "://" not in s:
        s = "https://" + s
    parsed = urlparse(s)
    if not parsed.hostname:
        raise ValueError(f"Could not parse host from URL: {raw_url!r}")

    scheme = parsed.scheme or "https"
    host = parsed.hostname
    path = parsed.path or "/"
    if not path.startswith("/"):
        path = "/" + path

    backend_url = f"{scheme}://{host}"
    backend_path = path
    frontend_suffix = _slugify_last_segment(path)

    return {
        "scheme": scheme,
        "host": host,
        "backend_url": backend_url,
        "backend_path": backend_path,
        "frontend_suffix": frontend_suffix,
    }


def _slugify_last_segment(path: str) -> str:
    """Take the last meaningful path segment, then append ALL {param} tokens
    found anywhere in the original path so APIM's rewrite-uri stays balanced.

    APIM rejects rewrite-uri templates that reference {params} not present in
    the operation's urlTemplate. We satisfy this by ensuring every {param}
    in the backend path is also in the frontend slug — order doesn't affect
    rewrite-uri's substitution semantics.

    "/1CBCApps/2762/IKPKM/GetIKPData" -> "/getikpdata"
    "/orders/{id}"                    -> "/orders/{id}"
    "/api/v1/status/{id}"             -> "/status/{id}"
    "/orders/{id}/items"              -> "/items/{id}"   (param hoisted to end)
    "/"                               -> "/root"          (sentinel)
    "/{id}"                           -> "/root/{id}"     (sentinel + param)
    "" or whitespace only             -> "/root"
    """
    raw_segments = [s for s in path.split("/") if s]
    template_segments = [s for s in raw_segments if s.startswith("{") and s.endswith("}")]
    non_template = [s for s in raw_segments if not (s.startswith("{") and s.endswith("}"))]

    if non_template:
        slug_seg = non_template[-1]
        slug = re.sub(r"[^a-z0-9]+", "-", slug_seg.lower()).strip("-")
        if not slug:
            slug = "root"
    else:
        slug = "root"

    if template_segments:
        return "/" + slug + "/" + "/".join(template_segments)
    return "/" + slug
