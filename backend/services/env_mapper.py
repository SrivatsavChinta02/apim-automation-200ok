"""Cross-environment URL host learner.

Given backend lists from src + dest APIM, finds backends with the same `name`
in both, parses their hostnames, and emits a host-substitution map that can
rewrite URLs / policy XML when promoting.
"""
import re
from urllib.parse import urlparse, urlunparse


def _host(url: str) -> str:
    return urlparse(url or "").hostname or ""


def learn_substitutions(src_backends: list[dict], dest_backends: list[dict]) -> dict[str, str]:
    """Return {src_host: dest_host} pairs inferred from same-named backends.

    Pairs are kept only when src_host != dest_host (different hosts) and both
    are non-empty. Conflicts (same src_host mapping to multiple dest_hosts)
    pick the majority; ties keep the first seen.
    """
    dest_by_id = {b.get("name", ""): b for b in dest_backends}
    candidates = {}  # src_host -> [dest_host, count]
    for src in src_backends:
        bid = src.get("name", "")
        dest = dest_by_id.get(bid)
        if not dest:
            continue
        sh = _host(src.get("properties", {}).get("url", ""))
        dh = _host(dest.get("properties", {}).get("url", ""))
        if not sh or not dh or sh == dh:
            continue
        if sh not in candidates:
            candidates[sh] = {}
        candidates[sh][dh] = candidates[sh].get(dh, 0) + 1
    return {sh: max(votes.items(), key=lambda kv: kv[1])[0] for sh, votes in candidates.items()}


def apply_to_url(url: str, sub_map: dict[str, str]) -> str:
    """Rewrite the host in `url` using sub_map. No-op if host not in map."""
    if not url:
        return url
    parsed = urlparse(url)
    if not parsed.hostname:
        return url
    new_host = sub_map.get(parsed.hostname)
    if not new_host:
        return url
    netloc = new_host
    if parsed.port:
        netloc = f"{new_host}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


_BASE_URL_RE = re.compile(r'(base-url\s*=\s*")([^"]+)(")')


def apply_to_policy_xml(xml: str, sub_map: dict[str, str]) -> str:
    """Rewrite hardcoded base-url=... attribute values in policy XML.

    Only touches base-url; other URL attributes (e.g. send-request URLs) can
    be added later if a real case demands. Keeping scope tight to avoid
    surprising edits to unrelated XML.
    """
    if not xml or not sub_map:
        return xml
    def _sub(m):
        return m.group(1) + apply_to_url(m.group(2), sub_map) + m.group(3)
    return _BASE_URL_RE.sub(_sub, xml)
